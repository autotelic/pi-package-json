/**
 * package.json scripts, as pi tools.
 *
 * Pi is launched in a directory that holds one or more `package.json` files --
 * a monorepo, usually. This extension scans that directory, skips
 * `node_modules` and every dot-directory, and registers one pi tool for each
 * script it finds. A tool runs its script through the package manager that owns
 * the package, with that package directory as the working directory.
 *
 * The point is discovery. An agent that holds `run_rest_test` does not have to
 * work out which directory holds the REST service, that the workspace uses
 * pnpm, or that the test script starts a database container first.
 *
 * Pi Fabric captures these tools and hides them from the model's active set. An
 * agent then reaches them as `extensions.run_rest_test(...)` inside a
 * `fabric_exec` program, and the names-only roster in the prompt is the index.
 *
 * Configuration, per repository, in `package-scripts.json` or
 * `.pi/package-scripts.json`:
 *
 *   {
 *     "skipDirs": ["fixtures"],
 *     "excludeScripts": ["watch", "dev*"],
 *     "manager": "pnpm",
 *     "maxDepth": 8,
 *     "timeoutSeconds": 300
 *   }
 */
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig, matchesPattern, type ScriptsConfig } from "./config.ts";
import { discover } from "./discover.ts";
import { runBackground, runSync, type RunOutcome } from "./exec.ts";
import { planTools, uniqueLabels } from "./naming.ts";
import { clamp, errorText, shorten } from "./text.ts";
import type { Discovery, PackageManager, PlannedTool } from "./types.ts";

/** The largest timeout a caller may ask for, whatever the configuration says. */
const MAX_TIMEOUT_SECONDS = 3_600;
/** Model-facing characters kept from standard output. */
const STDOUT_LIMIT = 16_000;
/** Model-facing characters kept from standard error. */
const STDERR_LIMIT = 6_000;
/** Rows the `/packages` report prints before it summarises the rest. */
const REPORT_LIMIT = 60;

const PARAMETERS = Type.Object({
	args: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Extra arguments for the script. They are appended after `--`, so the package manager forwards them to it.",
		}),
	),
	env: Type.Optional(
		Type.Record(Type.String(), Type.String(), {
			description: "Extra environment variables for the script.",
		}),
	),
	timeout: Type.Optional(
		Type.Number({
			description: `Seconds before the script is killed. Default 300, largest allowed ${MAX_TIMEOUT_SECONDS}.`,
		}),
	),
	background: Type.Optional(
		Type.Boolean({
			description:
				"Start the script detached and return at once with a pid and a log path. Use it for servers and watchers, which do not exit.",
		}),
	),
});

/** The facts every script tool reports about the run it performed. */
interface ScriptFacts {
	readonly tool: string;
	readonly package: string;
	readonly scriptName: string;
	readonly packageManager: PackageManager;
	readonly cwd: string;
	readonly log: string;
}

/** The details of a script that ran to completion. */
interface ScriptRunDetails extends ScriptFacts {
	readonly exitCode: number;
	readonly durationMs: number;
}

/** The details of a script that was started detached. */
interface ScriptStartDetails extends ScriptFacts {
	readonly pid: number;
}

/** The structured half of a script tool result. */
type ScriptDetails = ScriptRunDetails | ScriptStartDetails;

/**
 * A script that failed, or that could not be started.
 *
 * Pi turns a throw from `execute` into a failed tool result whose content is
 * the message, so the rendered report travels in the message. The class exists
 * so that the failure has a name a host can match on, rather than only prose.
 */
class ScriptFailure extends Error {
	override readonly name = "ScriptFailure";
}

const ok = (text: string, details: ScriptDetails): AgentToolResult<ScriptDetails> => ({
	content: [{ type: "text", text }],
	details,
});

/** Report a failure. Pi marks a tool result as an error only when `execute` throws. */
const fail = (text: string): never => {
	throw new ScriptFailure(text);
};

/** One log directory per repository, so two checkouts never overwrite each other. */
const logDirectory = (root: string): string =>
	join(tmpdir(), "pi-package-scripts", createHash("sha1").update(root).digest("hex").slice(0, 12));

const placeOf = (tool: PlannedTool): string =>
	tool.pkg.rel === "." ? "the repository root" : tool.pkg.rel;

/** The model-facing description of one script tool. */
const describeTool = (tool: PlannedTool): string => {
	const lines = [
		`Run the "${tool.script.name}" script of ${placeOf(tool)} with ${tool.pkg.manager}, from that directory.`,
		`Command: ${shorten(tool.script.command, 240)}`,
	];
	if (tool.script.reads.length > 0) {
		lines.push(
			`The script reads ${tool.script.reads.join(", ")} out of the environment. Give a value in \`env\`.`,
		);
	}
	return lines.join("\n");
};

/** The command line for one script, with any extra arguments forwarded to it. */
const scriptArguments = (
	script: string,
	extra: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> =>
	extra === undefined || extra.length === 0 ? ["run", script] : ["run", script, "--", ...extra];

/** The timeout for one call, in milliseconds, bounded by the configuration. */
const timeoutMilliseconds = (requested: number | undefined, config: ScriptsConfig): number => {
	const seconds =
		requested === undefined || !Number.isFinite(requested) || requested <= 0
			? config.timeoutSeconds
			: Math.min(requested, MAX_TIMEOUT_SECONDS);
	return Math.round(seconds * 1_000);
};

/**
 * The message for a finished run.
 *
 * The header carries the facts the model needs in order to decide what to do
 * next -- what ran, where, and how it ended -- and the output follows. A cut
 * result names the log file that holds the rest.
 */
const describeOutcome = (
	tool: PlannedTool,
	outcome: RunOutcome,
	timeoutMs: number,
	logFile: string,
): string => {
	const stdout = clamp(outcome.stdout.trimEnd(), STDOUT_LIMIT);
	const stderr = clamp(outcome.stderr.trimEnd(), STDERR_LIMIT);
	const seconds = (outcome.durationMs / 1_000).toFixed(1);
	const lines = [
		`${tool.pkg.manager} run ${tool.script.name} in ${tool.pkg.rel} -> exit ${outcome.code} in ${seconds}s`,
	];
	if (outcome.timedOut) {
		lines.push(`The script did not finish in ${Math.round(timeoutMs / 1_000)}s and was killed.`);
	}
	if (stdout.text !== "") lines.push("", stdout.text);
	if (stderr.text !== "") lines.push("", "stderr:", stderr.text);
	if (stdout.truncated || stderr.truncated) {
		lines.push("", `The output was cut. The complete output is at ${logFile}.`);
	}
	return lines.join("\n");
};

/**
 * Build the tool for one script.
 *
 * Every tool takes the same parameters, so one schema serves them all. The
 * script name, the package directory and the package manager are closed over,
 * because they are facts about the workspace rather than arguments.
 */
const buildTool = (
	tool: PlannedTool,
	config: ScriptsConfig,
	logs: string,
): ToolDefinition<typeof PARAMETERS, ScriptDetails> => ({
	name: tool.name,
	label: tool.label,
	description: describeTool(tool),
	promptSnippet: `Run the "${tool.script.name}" script in ${placeOf(tool)}`,
	parameters: PARAMETERS,
	async execute(_toolCallId, params, signal): Promise<AgentToolResult<ScriptDetails>> {
		const logFile = join(logs, `${tool.name}.log`);
		const facts: ScriptFacts = {
			tool: tool.name,
			package: tool.pkg.rel,
			scriptName: tool.script.name,
			packageManager: tool.pkg.manager,
			cwd: tool.pkg.dir,
			log: logFile,
		};
		const request = {
			command: tool.pkg.manager,
			args: scriptArguments(tool.script.name, params.args),
			cwd: tool.pkg.dir,
			environment: params.env,
			timeoutMs: timeoutMilliseconds(params.timeout, config),
			signal,
			logFile,
		};

		if (params.background === true) {
			try {
				const started = await runBackground(request);
				return ok(
					`Started \`${tool.pkg.manager} run ${tool.script.name}\` as pid ${started.pid}. Read the output at ${started.logFile}.`,
					{ ...facts, pid: started.pid },
				);
			} catch (error) {
				return fail(
					`Could not start "${tool.script.name}" with ${tool.pkg.manager}: ${errorText(error)}`,
				);
			}
		}

		let outcome: RunOutcome;
		try {
			outcome = await runSync(request);
		} catch (error) {
			return fail(
				`Could not run "${tool.script.name}" with ${tool.pkg.manager}: ${errorText(error)}`,
			);
		}

		const text = describeOutcome(tool, outcome, request.timeoutMs, logFile);
		if (outcome.code !== 0) return fail(text);
		return ok(text, { ...facts, exitCode: outcome.code, durationMs: outcome.durationMs });
	},
});

/** What one scan of the launch directory produced. */
interface SessionState {
	readonly root: string;
	readonly discovery: Discovery;
	readonly tools: ReadonlyArray<PlannedTool>;
	readonly config: ScriptsConfig;
}

const numberOf = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

const summaryOf = (state: SessionState): string =>
	[
		state.root,
		numberOf(state.discovery.packages.length, "package"),
		numberOf(state.tools.length, "script"),
		state.discovery.manager,
	].join(" - ");

const reportOf = (state: SessionState, wanted: string): string => {
	const lines = [summaryOf(state)];
	if (wanted === "") {
		lines.push("");
		for (const pkg of state.discovery.packages) {
			const count = state.tools.filter((tool) => tool.pkg === pkg).length;
			lines.push(`  ${pkg.rel} [${pkg.manager}] - ${numberOf(count, "script")}`);
		}
		return lines.join("\n");
	}
	const matched = state.tools.filter(
		(tool) =>
			matchesPattern({ pattern: wanted, name: tool.name }) ||
			matchesPattern({ pattern: wanted, name: tool.script.name }),
	);
	if (matched.length === 0) {
		lines.push("", `  no script matches "${wanted}"`);
		return lines.join("\n");
	}
	lines.push("");
	for (const tool of matched.slice(0, REPORT_LIMIT)) {
		lines.push(`  ${tool.name} -> ${tool.pkg.rel} - ${tool.script.name}`);
	}
	if (matched.length > REPORT_LIMIT) {
		lines.push(`  ...and ${matched.length - REPORT_LIMIT} more`);
	}
	return lines.join("\n");
};

/**
 * Register this repository's package.json scripts as pi tools.
 *
 * The scan runs on `session_start`, so the tools follow the directory pi was
 * launched in rather than a directory chosen at install time.
 */
export default function packageScripts(pi: ExtensionAPI): void {
	let state: SessionState | undefined;
	let registered = new Set<string>();

	/**
	 * Scan the directory and register one tool per script.
	 *
	 * Tool names from the previous scan of this session are removed from the
	 * set of taken names first. Without that, a rescan would push every name
	 * aside for a name it had already claimed.
	 */
	const load = (cwd: string): SessionState => {
		const config = loadConfig(cwd);
		const discovery = discover(cwd, config);
		const taken = new Set(
			pi
				.getAllTools()
				.map((tool) => tool.name)
				.filter((name) => !registered.has(name)),
		);
		const tools = planTools(discovery.packages, uniqueLabels(discovery.packages), taken);
		const logs = logDirectory(discovery.root);
		for (const tool of tools) pi.registerTool(buildTool(tool, config, logs));
		registered = new Set(tools.map((tool) => tool.name));
		state = { root: discovery.root, discovery, tools, config };
		return state;
	};

	const announce = (ctx: ExtensionContext, loaded: SessionState): void => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("package-scripts", numberOf(loaded.tools.length, "script"));
		if (loaded.discovery.problems.length > 0) {
			ctx.ui.notify(`package.json scan: ${loaded.discovery.problems[0] ?? ""}`, "warning");
		}
		if (loaded.tools.length === 0) {
			ctx.ui.notify(`package.json scan: no scripts found under ${loaded.root}`, "warning");
		}
	};

	pi.on("session_start", (_event, ctx) => {
		announce(ctx, load(ctx.cwd));
	});

	pi.registerCommand("packages", {
		description:
			"Show the package.json scripts this extension turned into tools. Give a name pattern to filter, or 'reload' to scan again.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (args.trim() === "reload") {
				const loaded = load(ctx.cwd);
				announce(ctx, loaded);
				ctx.ui.notify(
					`Rescanned ${loaded.root}: ${numberOf(loaded.tools.length, "script")} in ${numberOf(loaded.discovery.packages.length, "package")}.`,
					"info",
				);
				return;
			}
			if (state === undefined) {
				ctx.ui.notify("package.json scripts: the scan has not run in this session.", "warning");
				return;
			}
			ctx.ui.notify(reportOf(state, args.trim()), "info");
		},
	});
}
