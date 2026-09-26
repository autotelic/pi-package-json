import { describe, expect, it } from "vitest";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { detailsOf, scriptFailed, type ScriptDetails } from "../extensions/package-scripts/details.ts";

const facts = {
	tool: "run_lint",
	package: ".",
	scriptName: "lint",
	packageManager: "pnpm",
	cwd: "/repo",
	log: "/tmp/pi-package-scripts/abc/run_lint.log",
};

/** A tool result carrying whatever `details` the case wants to probe. */
const resultEvent = <T>(details: T): ToolResultEvent => ({
	type: "tool_result",
	toolCallId: "call-1",
	input: {},
	content: [{ type: "text", text: "..." }],
	isError: false,
	toolName: "run_lint",
	details,
});

describe("scriptFailed", () => {
	it("passes a zero exit", () => {
		expect(scriptFailed({ ...facts, outcome: "exited", exitCode: 0, durationMs: 12 })).toBe(false);
	});

	it("fails a non-zero exit, which is an answer and not a defect", () => {
		expect(scriptFailed({ ...facts, outcome: "exited", exitCode: 3, durationMs: 12 })).toBe(true);
	});

	it("fails a script that could not start", () => {
		expect(
			scriptFailed({ ...facts, outcome: "unavailable", reason: "spawn pnpm ENOENT" }),
		).toBe(true);
	});

	it("passes a detached run that has only started", () => {
		expect(scriptFailed({ ...facts, outcome: "started", pid: 42 })).toBe(false);
	});
});

describe("detailsOf", () => {
	it("reads back the details this extension published", () => {
		const details = { ...facts, outcome: "exited", exitCode: 0, durationMs: 12 } satisfies ScriptDetails;
		expect(detailsOf(resultEvent(details))).toEqual(details);
	});

	it("ignores the details of another tool", () => {
		expect(detailsOf(resultEvent({ output: "hi", exitCode: 0 }))).toBeUndefined();
	});

	it("ignores a result with no details", () => {
		expect(detailsOf(resultEvent(undefined))).toBeUndefined();
	});

	it("ignores a result whose outcome is not one this extension publishes", () => {
		expect(detailsOf(resultEvent({ ...facts, outcome: "exploded" }))).toBeUndefined();
	});
});
