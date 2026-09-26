/**
 * package.json scripts, as pi tools.
 *
 * Pi is launched in a directory that holds one or more `package.json` files --
 * a monorepo, usually. This extension scans that directory and registers one pi
 * tool for each script it finds. A tool runs its script through the package
 * manager that owns the package, with that package directory as the working
 * directory.
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
 * applies an approval policy to them. A repository that wants a class of its own
 * declares it under `capture.risks`, keyed by the tool names `/packages` prints.
 *
 * This file is the wiring: it scans on session start, registers what the scan
 * found, marks a failed call, and serves the `/packages` command. The pieces it
 * wires are in the modules beside it:
 *
 *   discover.ts   what is in the repository, and what it declares about itself
 *   naming.ts     how a script becomes a tool name
 *   ignore.ts     the repository's own ignore files
 *   tool.ts       the tool surface: schema, descriptions, execution
 *   report.ts     the /packages report and the starter configuration
 *   revision.ts   which copy of this extension a session is running
 *   config.ts     what a repository declares, and how it is read
 *   exec.ts       starting a script, stopping it, and keeping its output
 *   details.ts    the structured half of a tool result
 *   delegate.ts   a root script that only calls a nested one
 *   schema.ts     decoding the JSON that crosses the boundary
 *   types.ts      the vocabulary those modules share
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
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, type ScriptsConfig } from "./config.ts";
import { detailsOf, scriptFailed } from "./details.ts";
import { discover } from "./discover.ts";
import { planTools, uniqueLabels } from "./naming.ts";
import { CONFIG_FILE, fullReport, numberOf, starterConfig } from "./report.ts";
import { sourceStamp } from "./revision.ts";
import { buildTool, parametersOf } from "./tool.ts";
import type { Scan } from "./types.ts";

/** What one scan of the launch directory produced, and the configuration behind it. */
interface SessionState extends Scan {
	readonly config: ScriptsConfig;
}

/** One log directory per repository, so two checkouts never overwrite each other. */
const logDirectory = (root: string): string =>
	join(tmpdir(), "pi-package-scripts", createHash("sha1").update(root).digest("hex").slice(0, 12));

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
			"Show the package.json scripts this extension turned into tools. Give a name pattern to filter, 'reload' to scan again, or 'init' to write a starter package-scripts.json.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const asked = args.trim();
			if (asked === "init") {
				if (state === undefined) {
					ctx.ui.notify("package.json scripts: the scan has not run in this session.", "warning");
					return;
				}
				const target = join(state.root, CONFIG_FILE);
				if (existsSync(target)) {
					ctx.ui.notify(`${target} already exists. Edit it rather than replacing it.`, "warning");
					return;
				}
				writeFileSync(target, starterConfig(state.tools));
				const names = new Set(state.tools.map((tool) => tool.script.name)).size;
				ctx.ui.notify(
					`Wrote ${target} with ${numberOf(names, "script name")}. Fill in the notes for the scripts a caller should be warned about.`,
					"info",
				);
				return;
			}
			if (asked === "reload") {
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
			ctx.ui.notify(fullReport(state, asked, loadedAt), "info");
		},
	});
}
