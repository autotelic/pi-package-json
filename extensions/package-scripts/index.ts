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
 * What this extension does NOT do is decide which scripts are safe. It reports
 * facts it can prove -- the command text, the package, the directory, the
 * environment the script reads -- and never infers risk from a script's name,
 * because a name that means "destructive" in one repository means nothing in
 * the next. Those tools run repository code with the same authority as the
 * shell. Policy belongs to Pi Fabric, which classifies captured tools and
 * applies an approval policy to them.
 *
 * Configuration, per repository, in `package-scripts.json` or
 * `.pi/package-scripts.json`:
 *
 *   {
 *     "skipDirs": ["fixtures"],
 *     "excludeScripts": ["prepare"],
 *     "backgroundScripts": ["dev", "dev:*", "*:watch"],
 *     "notes": { "db:*": "connects to the database named by the environment" },
 *     "manager": "pnpm",
 *     "maxDepth": 8,
 *     "timeoutSeconds": 300,
 *     "maxTools": 500
 *   }
 */
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig, matchesPattern, type ScriptsConfig } from "./config.ts";
import { delegationTarget } from "./delegate.ts";
import {
	detailsOf,
	scriptFailed,
	type ScriptDetails,
	type ScriptExit,
	type ScriptFacts,
} from "./details.ts";
import { discover } from "./discover.ts";
import { runBackground, runSync, scriptArguments, type RunOutcome } from "./exec.ts";
import { planTools, uniqueLabels } from "./naming.ts";
import { PackageIdentity, readJson } from "./schema.ts";
import { clamp, durationText, errorText, shorten } from "./text.ts";
import type { Discovery, PlannedTool } from "./types.ts";

/** The largest timeout a caller may ask for, whatever the configuration says. */
const MAX_TIMEOUT_SECONDS = 3_600;
/** Model-facing characters kept from standard output. */
const STDOUT_LIMIT = 16_000;
/** Model-facing characters kept from standard error. */
const STDERR_LIMIT = 6_000;
/** Rows the `/packages` report prints before it summarises the rest. */
const REPORT_LIMIT = 60;

/**
 * The parameter schema for one session.
 *
 * Built per scan rather than once at module load, because the timeout's default
 * comes from the repository's configuration. A description that says 300 while
 * the configuration says 900 is a description that lies to the model.
 */
const parametersOf = (config: ScriptsConfig) =>
	Type.Object({
		args: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Extra arguments for the script. Only npm needs a '--' separator, and the extension adds it there.",
			}),
		),
		env: Type.Optional(
			Type.Record(Type.String(), Type.String(), {
				description: "Extra environment variables for the script.",
			}),
		),
		timeout: Type.Optional(
			Type.Number({
				description: `Seconds before the script is killed. Default ${config.timeoutSeconds}, largest allowed ${MAX_TIMEOUT_SECONDS}.`,
			}),
		),
		background: Type.Optional(
			Type.Boolean({
				description:
					"Start the script detached and return at once with a pid and a log path. Use it for servers and watchers, which do not exit.",
			}),
		),
		settle: Type.Optional(
			Type.Boolean({
				description:
					"Report a non-zero exit as a result rather than as a failed call. Use it when the exit code IS the answer you are reading, such as a coverage gate or a format check.",
			}),
		),
	});

type ScriptParameters = ReturnType<typeof parametersOf>;

/** What one scan of the launch directory produced. */
interface SessionState {
	readonly root: string;
	readonly discovery: Discovery;
	readonly tools: ReadonlyArray<PlannedTool>;
	readonly config: ScriptsConfig;
	/** Scripts the tool cap left out. Reported, never dropped quietly. */
	readonly dropped: number;
	/** Everything that went wrong in this scan, in the order it was found. */
	readonly problems: ReadonlyArray<string>;
}

/**
 * A tool result.
 *
 * A failed script is still an answered tool call: the result carries the exit
 * code, the duration and the log path, and a `tool_result` handler marks the
 * call as an error. Throwing instead would keep the message and throw the facts
 * away, and the facts are what a caller reads to decide what to do next.
 */
const answered = (text: string, details: ScriptDetails): AgentToolResult<ScriptDetails> => ({
	content: [{ type: "text", text }],
	details,
});

/** The directory this extension's own source files live in. */
const sourceDirectory = (): string => dirname(fileURLToPath(import.meta.url));

/**
 * The newest modification time among this extension's own files, at any depth.
 *
 * A session loads an extension at `session_start` and keeps it. `pi update`
 * replaces the checkout on disk, and the running session goes on calling the
 * code it loaded. That is how a review can name a revision and still describe
 * defects that revision had already fixed, so `/packages` says which copy it is
 * running and whether the copy on disk has moved on.
 *
 * A hint rather than a proof: it reads modification times, so a checkout that
 * reproduces them hides nothing but reports nothing either, and it cannot say
 * which revision is on disk. It answers the one question a session has -- has
 * the code moved since I loaded it.
 */
const sourceStamp = (): number => {
	const directory = sourceDirectory();
	let newest = 0;
	try {
		for (const entry of readdirSync(directory, { withFileTypes: true, recursive: true })) {
			if (!entry.isFile()) continue;
			const stamp = statSync(join(entry.parentPath, entry.name)).mtimeMs;
			if (stamp > newest) newest = stamp;
		}
	} catch {
		return 0;
	}
	return newest;
};

/** This extension's own name and version, as the manifest beside it declares. */
const identity = (): string => {
	const directory = sourceDirectory();
	const manifest = readJson(join(directory, "..", "..", "package.json"), PackageIdentity);
	if (manifest === undefined) return directory;
	return `${manifest.name} ${manifest.version} - ${directory}`;
};

/** One log directory per repository, so two checkouts never overwrite each other. */
const logDirectory = (root: string): string =>
	join(tmpdir(), "pi-package-scripts", createHash("sha1").update(root).digest("hex").slice(0, 12));

const placeOf = (tool: PlannedTool): string =>
	tool.pkg.rel === "." ? "the repository root" : tool.pkg.rel;

/**
 * The model-facing description of one script tool.
 *
 * The configured note comes before the command, because it is the part that
 * says what the script DOES. Nothing in `knex migrate:latest` separates a
 * status check from a rollback, and no amount of command text will say which
 * database it reaches.
 */
const describeTool = (tool: PlannedTool): string => {
	const lines = [
		`Run the "${tool.script.name}" script of ${placeOf(tool)} with ${tool.pkg.manager}, from that directory.`,
	];
	if (tool.script.note !== undefined) lines.push(`Note: ${tool.script.note}`);
	lines.push(`Command: ${shorten(tool.script.command, 240)}`);
	if (tool.script.reads.length > 0) {
		lines.push(
			`The script reads ${tool.script.reads.join(", ")} out of the environment. Give a value in \`env\`.`,
		);
	}
	if (tool.script.background) {
		lines.push("This script does not exit. It starts detached unless you pass background: false.");
	}
	return lines.join("\n");
};

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
	const lines = [
		`${tool.pkg.manager} run ${tool.script.name} in ${tool.pkg.rel} -> exit ${outcome.code} in ${durationText(outcome.durationMs)}`,
	];
	if (outcome.timedOut) {
		lines.push(`The script did not finish in ${durationText(timeoutMs)} and was killed.`);
	}
	if (stdout.text !== "") lines.push("", stdout.text);
	if (stderr.text !== "") lines.push("", "stderr:", stderr.text);
	/**
	 * The log path is the caller's only way to the rest of the output. A failed
	 * or killed run needs it as much as a cut one does: a host that turns a
	 * failed call into a thrown error keeps the message and drops the details,
	 * so the path has to be in the message.
	 */
	if (stdout.truncated || stderr.truncated) {
		lines.push("", `The output was cut. The complete output is at ${logFile}.`);
	} else if (outcome.code !== 0 || outcome.timedOut) {
		lines.push("", `The complete output is at ${logFile}.`);
	}
	return lines.join("\n");
};

/**
 * Build the tool for one script.
 *
 * Every tool takes the same parameters, so one schema serves them all within a
 * session. The script name, the package directory and the package manager are
 * closed over, because they are facts about the workspace rather than
 * arguments.
 */
const buildTool = (
	tool: PlannedTool,
	config: ScriptsConfig,
	nextLog: (toolName: string) => string,
	parameters: ScriptParameters,
): ToolDefinition<ScriptParameters, ScriptDetails> => ({
	name: tool.name,
	label: tool.label,
	description: describeTool(tool),
	promptSnippet: `Run the "${tool.script.name}" script in ${placeOf(tool)}`,
	parameters,
	async execute(_toolCallId, params, signal): Promise<AgentToolResult<ScriptDetails>> {
		const logFile = nextLog(tool.name);
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
			args: scriptArguments(tool.pkg.manager, tool.script.name, params.args),
			cwd: tool.pkg.dir,
			environment: params.env,
			timeoutMs: timeoutMilliseconds(params.timeout, config),
			signal,
			logFile,
		};

		if (params.background ?? tool.script.background) {
			try {
				const started = await runBackground(request);
				return answered(
					`Started \`${tool.pkg.manager} run ${tool.script.name}\` as pid ${started.pid}. Read the output at ${started.logFile}.`,
					{ ...facts, outcome: "started", pid: started.pid },
				);
			} catch (error) {
				const reason = errorText(error);
				return answered(
					`Could not start "${tool.script.name}" with ${tool.pkg.manager}: ${reason}`,
					{ ...facts, outcome: "unavailable", reason },
				);
			}
		}

		let outcome: RunOutcome;
		try {
			outcome = await runSync(request);
		} catch (error) {
			const reason = errorText(error);
			return answered(
				`Could not run "${tool.script.name}" with ${tool.pkg.manager}: ${reason}`,
				{ ...facts, outcome: "unavailable", reason },
			);
		}

		const exit: ScriptExit = {
			outcome: "exited",
			exitCode: outcome.code,
			durationMs: outcome.durationMs,
			settled: params.settle ?? false,
		};
		return answered(describeOutcome(tool, outcome, request.timeoutMs, logFile), {
			...facts,
			...exit,
		});
	},
});

const numberOf = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

const summaryOf = (state: SessionState): string => {
	const parts = [
		state.root,
		numberOf(state.discovery.packages.length, "package"),
		numberOf(state.tools.length, "script"),
		state.discovery.manager,
	];
	if (state.dropped > 0) parts.push(`${numberOf(state.dropped, "script")} past maxTools`);
	return parts.join(" - ");
};

const reportOf = (state: SessionState, wanted: string, drifted: boolean): string => {
	const lines: string[] = [];
	if (drifted) {
		lines.push(
			"The extension source on disk changed after this session loaded it, so these tools run the older code. Restart pi to use the newer code.",
			"",
		);
	}
	lines.push(summaryOf(state));
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
		const target = delegationTarget(tool, state.tools);
		const alias = target === undefined ? "" : `  (delegates to ${target})`;
		lines.push(`  ${tool.name} -> ${tool.pkg.rel} - ${tool.script.name}${alias}`);
	}
	if (matched.length > REPORT_LIMIT) {
		lines.push(`  ...and ${matched.length - REPORT_LIMIT} more`);
	}
	return lines.join("\n");
};

/** The report, with what went wrong and which revision is running. */
const fullReport = (state: SessionState, wanted: string, loadedAt: number): string => {
	const body = reportOf(state, wanted, sourceStamp() > loadedAt);
	const lines = [body];
	if (state.problems.length > 0) {
		lines.push("", `${numberOf(state.problems.length, "problem")}:`);
		for (const problem of state.problems) lines.push(`  ${problem}`);
	}
	lines.push("", identity());
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
	const loadedAt = sourceStamp();

	/**
	 * Scan the directory and register one tool per script.
	 *
	 * Tool names from the previous scan of this session are removed from the
	 * set of taken names first. Without that, a rescan would push every name
	 * aside for a name it had already claimed.
	 */
	const load = (cwd: string): SessionState => {
		const problems: string[] = [];
		const config = loadConfig(cwd, problems);
		const discovery = discover(cwd, config);
		problems.push(...discovery.problems);
		const taken = new Set(
			pi
				.getAllTools()
				.map((tool) => tool.name)
				.filter((name) => !registered.has(name)),
		);
		const planned = planTools(discovery.packages, uniqueLabels(discovery.packages), taken);
		const tools = planned.slice(0, config.maxTools);
		const logs = logDirectory(discovery.root);
		const parameters = parametersOf(config);
		let invocation = 0;
		/** A log path no other call of this session shares. */
		const nextLog = (toolName: string): string => {
			invocation += 1;
			return join(logs, `${toolName}-${invocation}.log`);
		};
		for (const tool of tools) pi.registerTool(buildTool(tool, config, nextLog, parameters));
		registered = new Set(tools.map((tool) => tool.name));
		state = {
			root: discovery.root,
			discovery,
			tools,
			config,
			dropped: planned.length - tools.length,
			problems,
		};
		return state;
	};

	const announce = (ctx: ExtensionContext, loaded: SessionState): void => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("package-scripts", numberOf(loaded.tools.length, "script"));
		if (loaded.problems.length > 0) {
			ctx.ui.notify(`package.json scan: ${loaded.problems[0] ?? ""}`, "warning");
		}
		if (loaded.dropped > 0) {
			ctx.ui.notify(
				`package.json scan: ${numberOf(loaded.dropped, "script")} left out by maxTools=${loaded.config.maxTools}`,
				"warning",
			);
		}
		if (loaded.tools.length === 0) {
			ctx.ui.notify(`package.json scan: no scripts found under ${loaded.root}`, "warning");
		}
	};

	/**
	 * Mark a script tool call that failed.
	 *
	 * Pi decides a tool result is an error from the result itself, and only a
	 * throw sets that flag. This handler reads the same structured details the
	 * tool published, so a non-zero exit reaches the model as a failed call
	 * WITHOUT losing the exit code, the duration and the log path.
	 */
	pi.on("tool_result", (event) => {
		const details = detailsOf(event);
		if (details === undefined || !scriptFailed(details)) return;
		return { isError: true };
	});

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
			ctx.ui.notify(fullReport(state, args.trim(), loadedAt), "info");
		},
	});
}
