import { describe, expect, it } from "vitest";
import {
	loadConfig,
	matchesPattern,
	BUILT_IN_SKIP_DIRS,
} from "../extensions/package-scripts/config.ts";
import { json, workspace } from "./support.ts";

/** Ask the pattern question the way a caller does. */
const matches = (pattern: string, name: string): boolean => matchesPattern({ pattern, name });

describe("matchesPattern", () => {
	it("matches an identical name", () => {
		expect(matches("build", "build")).toBe(true);
	});

	it("rejects a different name without a wildcard", () => {
		expect(matches("build", "rebuild")).toBe(false);
	});

	it("treats a star as any run of characters", () => {
		expect(matches("dev*", "dev")).toBe(true);
		expect(matches("dev*", "dev:proxy")).toBe(true);
		expect(matches("test:*:coverage", "test:math:coverage")).toBe(true);
		expect(matches("test:*:coverage", "test:math")).toBe(false);
	});

	/**
	 * A star stands for characters and nothing else. It does not stand for a
	 * separator, and it does not make a colon optional, so a pattern written for
	 * `test:watch` does not reach a script simply called `watch`.
	 */
	it("does not make a separator optional", () => {
		expect(matches("*:watch", "watch")).toBe(false);
		expect(matches("*:watch", "test:watch")).toBe(true);
	});

	it("does not let a star cross the end of the name", () => {
		expect(matches("*build", "build:watch")).toBe(false);
	});

	it("treats regular expression characters in the pattern as text", () => {
		expect(matches("a.b", "axb")).toBe(false);
		expect(matches("a.b", "a.b")).toBe(true);
	});
});

describe("loadConfig", () => {
	it("uses the built-in defaults when no file exists", () => {
		const root = workspace({ "package.json": "{}" });
		const loaded = loadConfig(root, []);
		expect(loaded.maxDepth).toBe(8);
		expect(loaded.timeoutSeconds).toBe(300);
		expect(loaded.skipDirs).toEqual([]);
		expect(loaded.managerOverride).toBeUndefined();
	});

	it("reads the root file", () => {
		const root = workspace({
			"package-scripts.json": json({ excludeScripts: ["watch"], manager: "pnpm" }),
		});
		const loaded = loadConfig(root, []);
		expect(loaded.excludeScripts).toEqual(["watch"]);
		expect(loaded.managerOverride).toBe("pnpm");
	});

	it("lets .pi/package-scripts.json win field by field", () => {
		const root = workspace({
			"package-scripts.json": json({ excludeScripts: ["watch"], maxDepth: 3 }),
			".pi/package-scripts.json": json({ maxDepth: 5 }),
		});
		const loaded = loadConfig(root, []);
		expect(loaded.excludeScripts).toEqual(["watch"]);
		expect(loaded.maxDepth).toBe(5);
	});

	it("reads notes and background scripts", () => {
		const root = workspace({
			"package-scripts.json": json({
				notes: { "db:*": "connects to the database" },
				backgroundScripts: ["dev"],
			}),
		});
		const loaded = loadConfig(root, []);
		expect(loaded.notes).toEqual({ "db:*": "connects to the database" });
		expect(loaded.backgroundScripts).toEqual(["dev"]);
	});

	it("ignores a value of the wrong shape, and says so", () => {
		const root = workspace({
			"package-scripts.json": json({ excludeScripts: "watch", maxDepth: 0, manager: "cargo" }),
		});
		const problems: string[] = [];
		const loaded = loadConfig(root, problems);
		expect(loaded.excludeScripts).toEqual([]);
		expect(loaded.maxDepth).toBe(8);
		expect(loaded.managerOverride).toBeUndefined();
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("package-scripts.json");
	});

	it("names an unknown setting and keeps the rest of the file", () => {
		const root = workspace({
			"package-scripts.json": json({ excludeScript: ["watch"], maxDepth: 4 }),
		});
		const problems: string[] = [];
		const loaded = loadConfig(root, problems);
		expect(loaded.maxDepth).toBe(4);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("does not know");
	});

	it("reports a malformed file", () => {
		const root = workspace({ "package-scripts.json": "{ not json" });
		const problems: string[] = [];
		expect(loadConfig(root, problems).maxDepth).toBe(8);
		expect(problems).toHaveLength(1);
	});

	it("says nothing about a file that is not there", () => {
		const root = workspace({ "package.json": "{}" });
		const problems: string[] = [];
		loadConfig(root, problems);
		expect(problems).toEqual([]);
	});
});

describe("BUILT_IN_SKIP_DIRS", () => {
	it("lists only another tool's own store, and no project convention", () => {
		expect(BUILT_IN_SKIP_DIRS).toContain("node_modules");
		expect(BUILT_IN_SKIP_DIRS).toContain(".git");
		for (const convention of ["dist", "build", "out", "coverage", "vendor", "target", "tmp"]) {
			expect(BUILT_IN_SKIP_DIRS).not.toContain(convention);
		}
	});
});

describe("respectGitignore", () => {
	it("is on by default", () => {
		const root = workspace({ "package.json": "{}" });
		expect(loadConfig(root, []).respectGitignore).toBe(true);
	});

	it("can be turned off", () => {
		const root = workspace({ "package-scripts.json": json({ respectGitignore: false }) });
		expect(loadConfig(root, []).respectGitignore).toBe(false);
	});
});

describe("maxTools", () => {
	it("defaults to a bounded surface", () => {
		const root = workspace({ "package.json": "{}" });
		expect(loadConfig(root, []).maxTools).toBe(500);
	});

	it("is read from the file", () => {
		const root = workspace({ "package-scripts.json": json({ maxTools: 12 }) });
		expect(loadConfig(root, []).maxTools).toBe(12);
	});

	it("ignores a value out of range, and says so", () => {
		const root = workspace({ "package-scripts.json": json({ maxTools: 0 }) });
		const problems: string[] = [];
		expect(loadConfig(root, problems).maxTools).toBe(500);
		expect(problems).toHaveLength(1);
	});
});
