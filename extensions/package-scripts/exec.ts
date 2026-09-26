import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { now } from "./clock.ts";
import type { PackageManager } from "./types.ts";

/** Bytes held in memory per stream. The log file keeps the complete output. */
const MAX_CAPTURE = 8 * 1024 * 1024;

/**
 * The command line for one script.
 *
 * Only npm needs the `--` separator, and only npm may have it. pnpm passes a
 * separator through to the script, so `pnpm run show -- payroll` gives the
 * script `["--", "payroll"]` rather than `["payroll"]`; npm strips it, and
 * yarn and bun never needed it. Verified against pnpm 12.3.4, npm 11.19.1 and
 * bun 1.3.14.
 */
export const scriptArguments = (
	manager: PackageManager,
	script: string,
	extra: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> => {
	if (extra === undefined || extra.length === 0) return ["run", script];
	return manager === "npm" ? ["run", script, "--", ...extra] : ["run", script, ...extra];
};

/** One script run: what to start, where, and for how long. */
export interface RunRequest {
	readonly command: string;
	readonly args: ReadonlyArray<string>;
	readonly cwd: string;
	readonly environment: Readonly<Record<string, string>> | undefined;
	readonly timeoutMs: number;
	readonly signal: AbortSignal | undefined;
	/** The complete output goes here, so a cut result can still be read. */
	readonly logFile: string;
}

/** One run's complete output, as it is written to the log file. */
export interface RunOutput {
	readonly stdout: string;
	readonly stderr: string;
}

/** How a script finished. */
export interface RunOutcome extends RunOutput {
	readonly code: number;
	readonly timedOut: boolean;
	readonly durationMs: number;
}

/** A script that was started detached and is still running. */
export interface BackgroundOutcome {
	readonly pid: number;
	readonly logFile: string;
}

/**
 * Kill a child and everything the child started.
 *
 * The process is spawned into its own group, so one signal reaches the whole
 * tree that a package script builds. A process that has already gone, or an
 * empty group, is not an error.
 */
const killTree = (pid: number, signal: NodeJS.Signals): void => {
	try {
		process.kill(process.platform === "win32" ? pid : -pid, signal);
	} catch {
		return;
	}
};

/**
 * How a script is started.
 *
 * A separate process group is what lets one signal reach the whole tree. The
 * caller's environment is inherited and then overridden, so a script keeps
 * `PATH` and gains only the variables the tool call named.
 */
const spawnOptions = (request: RunRequest) => ({
	cwd: request.cwd,
	env: request.environment === undefined ? process.env : { ...process.env, ...request.environment },
	detached: process.platform !== "win32",
});

/**
 * Write a run's complete output to its log file.
 *
 * A log is a convenience for the model, so a log that cannot be written must
 * not fail the run that produced it.
 */
const writeLog = (path: string, output: RunOutput): void => {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(
			path,
			output.stderr === "" ? output.stdout : `${output.stdout}\n--- stderr ---\n${output.stderr}`,
		);
	} catch {
		return;
	}
};

/**
 * Run a script to completion and collect its output.
 *
 * The command is killed when the timeout elapses or the caller aborts. Both
 * paths signal the whole process group. The exit code is 124 for a timeout,
 * which is what `timeout(1)` uses, and 1 when the child died from a signal.
 */
export const runSync = (request: RunRequest): Promise<RunOutcome> =>
	new Promise((resolve, reject) => {
		const started = now();
		const child = spawn(request.command, [...request.args], {
			...spawnOptions(request),
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;

		const stop = (signal: NodeJS.Signals): void => {
			if (child.pid !== undefined) killTree(child.pid, signal);
		};

		const timer = setTimeout(() => {
			timedOut = true;
			stop("SIGKILL");
		}, request.timeoutMs);

		const onAbort = (): void => {
			stop("SIGTERM");
			setTimeout(() => stop("SIGKILL"), 5_000).unref();
		};
		request.signal?.addEventListener("abort", onAbort, { once: true });

		const cleanup = (): void => {
			clearTimeout(timer);
			request.signal?.removeEventListener("abort", onAbort);
		};

		child.stdout?.on("data", (chunk: Buffer) => {
			if (stdout.length < MAX_CAPTURE) stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			if (stderr.length < MAX_CAPTURE) stderr += chunk.toString("utf8");
		});

		child.once("error", (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		});

		child.once("close", (code: number | null) => {
			if (settled) return;
			settled = true;
			cleanup();
			writeLog(request.logFile, { stdout, stderr });
			resolve({
				stdout,
				stderr,
				code: code ?? (timedOut ? 124 : 1),
				timedOut,
				durationMs: now() - started,
			});
		});
	});

/**
 * Start a script that is expected never to exit, such as a server or a watcher.
 *
 * The child becomes its own session and its output goes straight to the log
 * file, so it outlives the tool call. The promise settles as soon as the
 * process exists, rather than when it exits.
 */
export const runBackground = (request: RunRequest): Promise<BackgroundOutcome> =>
	new Promise((resolve, reject) => {
		mkdirSync(dirname(request.logFile), { recursive: true });
		const handle = openSync(request.logFile, "w");
		const child = spawn(request.command, [...request.args], {
			...spawnOptions(request),
			detached: true,
			stdio: ["ignore", handle, handle],
		});
		child.once("error", (error: Error) => {
			closeSync(handle);
			reject(error);
		});
		child.once("spawn", () => {
			closeSync(handle);
			child.unref();
			resolve({ pid: child.pid ?? -1, logFile: request.logFile });
		});
	});
