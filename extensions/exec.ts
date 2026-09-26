import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { now } from "./clock.ts";
import type { PackageManager } from "./types.ts";

/** Bytes held in memory per stream. The log file keeps everything. */
const MAX_CAPTURE = 8 * 1024 * 1024;

/** How long a script has to stop cleanly after a TERM, before it is killed. */
const GRACE_MS = 5_000;

/**
 * The command line for one script.
 *
 * Only npm needs the `--` separator, and only npm may have it. pnpm passes a
 * separator through to the script, so `pnpm run show -- payroll` gives the
 * script `["--", "payroll"]` rather than `["payroll"]`; npm strips it, and
 * yarn and bun never needed it. Measured on pnpm 12.3.4, npm 11.19.1 and bun
 * 1.3.14.
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
	/**
	 * Where this run's output goes, in arrival order.
	 *
	 * One path per invocation, not per tool: two detached runs of one script
	 * would otherwise write to the same file, and the second would truncate what
	 * the first was still writing.
	 */
	readonly logFile: string;
}

/** How a script finished. */
export interface RunOutcome {
	readonly stdout: string;
	readonly stderr: string;
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
 *
 * On Windows there are no process groups to signal, and only the child is
 * killed; a script that started another program can leave it behind. Pi runs on
 * Windows, so this is a real limit rather than a theoretical one, and it is
 * written here instead of being discovered later.
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

/** Open a run's log, or nothing when it cannot be opened. */
const openLog = (path: string): number | undefined => {
	try {
		mkdirSync(dirname(path), { recursive: true });
		return openSync(path, "w");
	} catch {
		return undefined;
	}
};

/**
 * Run a script to completion and collect its output.
 *
 * The output goes to the log as it arrives, so a run that is killed still has
 * everything it produced, and a run of any size has a complete log even though
 * only a bounded prefix is held in memory for the tool result.
 *
 * The command is stopped when the timeout elapses or the caller aborts. Both
 * paths send SIGTERM first and SIGKILL only after a grace period, because a
 * script that starts something has to be given the chance to stop it: a test
 * script that brings up a database container brings it down on the way out, and
 * a kill that skips that leaves the container running.
 *
 * The exit code is 124 for a timeout, which is what `timeout(1)` uses, and 1
 * when the child died from a signal.
 */
export const runSync = (request: RunRequest): Promise<RunOutcome> =>
	new Promise((resolve, reject) => {
		if (request.signal?.aborted === true) {
			reject(new Error("the call was aborted before the script started"));
			return;
		}

		const started = now();
		const child = spawn(request.command, [...request.args], {
			...spawnOptions(request),
			stdio: ["ignore", "pipe", "pipe"],
		});

		let logHandle = openLog(request.logFile);
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;

		/** Write to the log, and give up on it when a write fails. */
		const record = (chunk: string): void => {
			if (logHandle === undefined) return;
			try {
				writeSync(logHandle, chunk);
			} catch {
				logHandle = undefined;
			}
		};

		/** Ask the tree to stop, then insist. */
		const stop = (): void => {
			if (child.pid === undefined) return;
			killTree(child.pid, "SIGTERM");
			setTimeout(() => killTree(child.pid ?? 0, "SIGKILL"), GRACE_MS).unref();
		};

		const timer = setTimeout(() => {
			timedOut = true;
			stop();
		}, request.timeoutMs);

		request.signal?.addEventListener("abort", stop, { once: true });

		const cleanup = (): void => {
			clearTimeout(timer);
			request.signal?.removeEventListener("abort", stop);
			if (logHandle !== undefined) closeSync(logHandle);
		};

		child.stdout?.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			record(text);
			if (stdout.length < MAX_CAPTURE) stdout += text;
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			record(text);
			if (stderr.length < MAX_CAPTURE) stderr += text;
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
		if (request.signal?.aborted === true) {
			reject(new Error("the call was aborted before the script started"));
			return;
		}
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
