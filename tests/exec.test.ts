import { describe, expect, it } from "vitest";
import { runBackground, runSync, scriptArguments, type RunRequest } from "../extensions/package-scripts/exec.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";

const logFile = join(tmpdir(), "pi-package-json-tests", "exec.log");

/** A run request with the named fields replaced. */
const request = (overrides: Partial<RunRequest> = {}): RunRequest => ({
	command: process.execPath,
	args: ["-e", "console.log('out'); console.error('err')"],
	cwd: tmpdir(),
	environment: undefined,
	timeoutMs: 20_000,
	signal: undefined,
	logFile,
	...overrides,
});

describe("scriptArguments", () => {
	it("adds no separator for pnpm", () => {
		expect(scriptArguments("pnpm", "show", ["payroll"])).toEqual(["run", "show", "payroll"]);
	});

	it("adds the separator for npm", () => {
		expect(scriptArguments("npm", "show", ["payroll"])).toEqual(["run", "show", "--", "payroll"]);
	});

	it("adds no separator for yarn or bun", () => {
		expect(scriptArguments("yarn", "show", ["payroll"])).toEqual(["run", "show", "payroll"]);
		expect(scriptArguments("bun", "show", ["payroll"])).toEqual(["run", "show", "payroll"]);
	});

	it("omits the separator when there are no extra arguments", () => {
		expect(scriptArguments("npm", "show", [])).toEqual(["run", "show"]);
		expect(scriptArguments("npm", "show", undefined)).toEqual(["run", "show"]);
	});
});

describe("runSync", () => {
	it("collects both streams and the exit code", async () => {
		const outcome = await runSync(request({ args: ["-e", "console.log('out'); console.error('err')"] }));
		expect(outcome.stdout.trim()).toBe("out");
		expect(outcome.stderr.trim()).toBe("err");
		expect(outcome.code).toBe(0);
		expect(outcome.timedOut).toBe(false);
	});

	it("reports a non-zero exit without throwing", async () => {
		const outcome = await runSync(request({ args: ["-e", "process.exit(3)"] }));
		expect(outcome.code).toBe(3);
	});

	it("passes the environment it is given", async () => {
		const outcome = await runSync(
			request({
				args: ["-e", "console.log(process.env.PI_PKG_PROBE ?? 'missing')"],
				environment: { PI_PKG_PROBE: "present" },
			}),
		);
		expect(outcome.stdout.trim()).toBe("present");
	});

	it("kills a script that outlives its timeout", async () => {
		const outcome = await runSync(
			request({ args: ["-e", "setTimeout(() => console.log('late'), 60_000)"], timeoutMs: 400 }),
		);
		expect(outcome.timedOut).toBe(true);
		expect(outcome.code).not.toBe(0);
	});

	it("rejects when the command does not exist", async () => {
		await expect(runSync(request({ command: "pi-package-json-no-such-command" }))).rejects.toThrow();
	});
});

describe("runBackground", () => {
	it("returns a pid at once for a script that does not exit", async () => {
		const started = await runBackground(
			request({
				args: ["-e", "setTimeout(() => {}, 60_000)"],
				logFile: join(tmpdir(), "pi-package-json-tests", "background.log"),
			}),
		);
		expect(started.pid).toBeGreaterThan(0);
		process.kill(started.pid, "SIGKILL");
	});

	it("rejects when the command does not exist", async () => {
		await expect(
			runBackground(request({ command: "pi-package-json-no-such-command" })),
		).rejects.toThrow();
	});
});
