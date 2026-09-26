import { describe, expect, it } from "vitest";
import { starterConfig } from "../extensions/package-scripts/index.ts";
import type { PlannedTool, ScriptEntry } from "../extensions/package-scripts/types.ts";

/** One tool for a named script, so the starter config can be built from them. */
const tool = (name: string): PlannedTool => {
	const script: ScriptEntry = {
		name,
		command: "true",
		reads: [],
		note: undefined,
		background: false,
	};
	return {
		name: "run_" + name.replace(/[^a-z0-9]+/gu, "_"),
		label: "root:" + name,
		pkg: {
			dir: "/repo",
			rel: ".",
			packageName: "repo",
			manager: "pnpm",
			scripts: [script],
		},
		script,
	};
};

describe("starterConfig", () => {
	it("names every script once, in order", () => {
		const text = starterConfig([tool("build"), tool("test"), tool("build")]);
		expect(JSON.parse(text)).toEqual({ notes: { build: "", test: "" } });
	});

	it("writes an empty note for each, so the file is a task rather than a form", () => {
		const text = starterConfig([tool("deploy")]);
		expect(text.endsWith("\n")).toBe(true);
		expect(JSON.parse(text).notes.deploy).toBe("");
	});
});
