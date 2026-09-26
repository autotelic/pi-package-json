import { describe, expect, it } from "vitest";
import { loadConfig, matchesPattern, BUILT_IN_SKIP_DIRS } from "../extensions/package-scripts/config.ts";
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
		const loaded = loadConfig(root);
		expect(loaded.maxDepth).toBe(8);
		expect(loaded.timeoutSeconds).toBe(300);
		expect(loaded.skipDirs).toEqual([]);
		expect(loaded.managerOverride).toBeUndefined();
	});

	it("reads the root file", () => {
		const root = workspace({
			"package-scripts.json": json({ excludeScripts: ["watch"], manager: "pnpm" }),
		});
		const loaded = loadConfig(root);
		expect(loaded.excludeScripts).toEqual(["watch"]);
		expect(loaded.managerOverride).toBe("pnpm");
	});

	it("lets .pi/package-scripts.json win field by field", () => {
		const root = workspace({
			"package-scripts.json": json({ excludeScripts: ["watch"], maxDepth: 3 }),
			".pi/package-scripts.json": json({ maxDepth: 5 }),
		});
		const loaded = loadConfig(root);
		expect(loaded.excludeScripts).toEqual(["watch"]);
		expect(loaded.maxDepth).toBe(5);
	});

	it("ignores a value of the wrong shape", () => {
		const root = workspace({
			"package-scripts.json": json({ excludeScripts: "watch", maxDepth: 0, manager: "cargo" }),
		});
		const loaded = loadConfig(root);
		expect(loaded.excludeScripts).toEqual([]);
		expect(loaded.maxDepth).toBe(8);
		expect(loaded.managerOverride).toBeUndefined();
	});

	it("ignores a malformed file", () => {
		const root = workspace({ "package-scripts.json": "{ not json" });
		expect(loadConfig(root).maxDepth).toBe(8);
	});
});

describe("BUILT_IN_SKIP_DIRS", () => {
	it("never exposes node_modules", () => {
		expect(BUILT_IN_SKIP_DIRS).toContain("node_modules");
	});
});
