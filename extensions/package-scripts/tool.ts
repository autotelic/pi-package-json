/**
 * The tool surface: one pi tool per script.
 *
 * Every tool takes the same parameters, so one schema serves them all within a
 * session. What differs between tools is closed over: the script name, the
 * package directory and the package manager are facts about the workspace
 * rather than arguments.
 */
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ScriptsConfig } from "./config.ts";
import {
	type ScriptDetails,
	type ScriptExit,
	type ScriptFacts,
} from "./details.ts";
import { runBackground, runSync, scriptArguments, type RunOutcome } from "./exec.ts";
import { clamp, durationText, errorText, shorten } from "./text.ts";
import type { PlannedTool } from "./types.ts";

/** The largest timeout a caller may ask for, whatever the configuration says. */
const MAX_TIMEOUT_SECONDS = 3_600;
/** Model-facing characters kept from standard output. */
const STDOUT_LIMIT = 16_000;
/** Model-facing characters kept from standard error. */
const STDERR_LIMIT = 6_000;
/**
 * Characters kept from a script's command text.
 *
 * Generous, because the command is the evidence a caller decides with, and a
 * command that is cut in the wrong place hides the environment or the target a
 * dangerous script names. A command longer than this keeps both ends.
 */
const COMMAND_LIMIT = 400;

/**
 * The parameter schema for one session.
 *
 * Built per scan rather than once at module load, because the timeout's default
 * comes from the repository's configuration. A description that says 300 while
 * the configuration says 900 is a description that lies to the model.
 */
export const parametersOf = (config: ScriptsConfig) =>
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
				description: `Seconds before the script is stopped. Default ${config.timeoutSeconds}, largest allowed ${MAX_TIMEOUT_SECONDS}.`,
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
					"Report a non-zero exit as a result rather than as a failed call. A program that branches on an exit code must pass this; without it a failed script aborts the caller.",
			}),
		),
	});

/** The parameters every script tool takes. */
export type ScriptParameters = ReturnType<typeof parametersOf>;

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

/** How a tool names the place it runs in, for a description. */
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
	lines.push(`Command: ${shorten(tool.script.command, COMMAND_LIMIT)}`);
	if (tool.script.reads.length > 0) {
		lines.push(
			`The script refers to ${tool.script.reads.join(", ")}, which may come from the environment. Set \`env\` only if the script expects them there.`,
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
 * next -- what ran, where, and how it ended -- and the output follows. A failed
 * or killed run names its log file, because a host that turns a failed call
 * into a thrown error keeps the message and drops the details.
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
		lines.push(`The script did not finish in ${durationText(timeoutMs)} and was stopped.`);
	}
	if (stdout.text !== "") lines.push("", stdout.text);
	if (stderr.text !== "") lines.push("", "stderr:", stderr.text);
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
 * `nextLog` hands out a path no other call of the session shares, so two
 * detached runs of one script cannot truncate each other's log.
 */
export const buildTool = (
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
