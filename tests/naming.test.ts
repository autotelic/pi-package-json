import { describe, expect, it } from "vitest";
import { packageLabel, planTools, sanitize, uniqueLabels } from "../extensions/package-scripts/naming.ts";
import type { DiscoveredPackage, ScriptEntry } from "../extensions/package-scripts/types.ts";

interface ScriptOverrides {
	readonly note?: string;
	readonly background?: boolean;
}

const script = (name: string, overrides: ScriptOverrides = {}): ScriptEntry => ({
	name,
	command: "true",
	reads: [],
	note: overrides.note,
	background: overrides.background ?? false,
});

const pkg = (
	rel: string,
	packageName: string | undefined,
	scripts: ReadonlyArray<string>,
): DiscoveredPackage => ({
	dir: "/repo/" + rel,
	rel,
	packageName,
	manager: "pnpm",
	scripts: scripts.map((name) => script(name)),
});

describe("sanitize", () => {
	it("lowercases and replaces punctuation with one underscore", () => {
		expect(sanitize("test:math:coverage")).toBe("test_math_coverage");
		expect(sanitize("db.rollback")).toBe("db_rollback");
		expect(sanitize("a---b")).toBe("a_b");
	});

	it("removes leading and trailing underscores", () => {
		expect(sanitize("-build-")).toBe("build");
		expect(sanitize("!!!")).toBe("");
	});
});

describe("packageLabel", () => {
	it("drops the scope", () => {
		expect(packageLabel(pkg("packages/utils", "@autotelic/utils", ["build"]))).toBe("utils");
	});

	it("falls back to the path", () => {
		expect(packageLabel(pkg("services/rest", undefined, ["build"]))).toBe("services_rest");
	});

	it("names the root", () => {
		expect(packageLabel(pkg(".", undefined, ["build"]))).toBe("root");
	});
});

describe("uniqueLabels", () => {
	it("keeps a distinct name", () => {
		const labels = uniqueLabels([
			pkg(".", "app", ["build"]),
			pkg("services/rest", "rest", ["build"]),
		]);
		expect(labels).toEqual(["app", "rest"]);
	});

	it("falls back to the path when two packages share a name", () => {
		const labels = uniqueLabels([
			pkg("packages/rest", "rest", ["build"]),
			pkg("services/rest", "rest", ["build"]),
		]);
		expect(labels).toEqual(["packages_rest", "services_rest"]);
	});

	it("adds a counter when the paths agree too", () => {
		const labels = uniqueLabels([
			pkg("a/shared", "shared", ["build"]),
			pkg("b/shared", "shared", ["build"]),
		]);
		expect(labels).toHaveLength(2);
		expect(new Set(labels).size).toBe(2);
	});

	it("keeps root for the root package", () => {
		const labels = uniqueLabels([
			pkg(".", "app", ["build"]),
			pkg("vendor/root", "root", ["build"]),
		]);
		expect(labels[0]).toBe("app");
		expect(labels[1]).not.toBe("root");
	});
});

describe("planTools", () => {
	it("gives the root the short name and qualifies every other package", () => {
		const packages = [
			pkg(".", "app", ["build", "test"]),
			pkg("services/rest", "rest", ["build"]),
		];
		const tools = planTools(packages, uniqueLabels(packages), new Set());
		expect(tools.map((tool) => tool.name)).toEqual(["run_build", "run_test", "run_rest_build"]);
	});

	it("never gives a nested package a short name, even when nothing holds it", () => {
		const packages = [pkg("services/rest", "rest", ["test"])];
		const tools = planTools(packages, uniqueLabels(packages), new Set());
		expect(tools.map((tool) => tool.name)).toEqual(["run_rest_test"]);
	});

	it("keeps a name attached to its package when another package sorts first", () => {
		const packages = [
			pkg("a/one", "one", ["build"]),
			pkg("b/two", "two", ["build"]),
			pkg("c/three", "three", ["build"]),
		];
		const tools = planTools(packages, uniqueLabels(packages), new Set());
		expect(tools.map((tool) => tool.name)).toEqual([
			"run_one_build",
			"run_two_build",
			"run_three_build",
		]);
	});

	it("still names the root tool the same way when a package is removed", () => {
		const before = [pkg(".", "app", ["test"]), pkg("a/one", "one", ["test"])];
		const after = [pkg(".", "app", ["test"])];
		const first = planTools(before, uniqueLabels(before), new Set()).map((tool) => tool.name);
		const second = planTools(after, uniqueLabels(after), new Set()).map((tool) => tool.name);
		expect(first[0]).toBe("run_test");
		expect(second).toEqual(["run_test"]);
	});

	/**
	 * A root script whose name starts with a sibling package's label would make
	 * the prefix mean two things: run_db_migrate is the root's db:migrate and
	 * run_db_build is services/db's build, so "run_db_* is the database package"
	 * is wrong for every root db:* script.
	 */
	it("qualifies the root when a nested label covers its short name", () => {
		const packages = [
			pkg(".", "app", ["db:migrate", "build"]),
			pkg("services/db", "db", ["knex:migrate", "build"]),
		];
		const tools = planTools(packages, uniqueLabels(packages), new Set());
		expect(tools.map((tool) => tool.name)).toEqual([
			"run_root_db_migrate",
			"run_build",
			"run_db_knex_migrate",
			"run_db_build",
		]);
	});

	it("qualifies only the root scripts the label actually covers", () => {
		const packages = [
			pkg(".", "app", ["db:migrate", "lint"]),
			pkg("services/db", "db", ["build"]),
		];
		const tools = planTools(packages, uniqueLabels(packages), new Set());
		expect(tools.map((tool) => tool.name)).toEqual([
			"run_root_db_migrate",
			"run_lint",
			"run_db_build",
		]);
	});

	it("leaves the root short name alone when no label covers it", () => {
		const packages = [pkg(".", "app", ["test:ui"]), pkg("services/ui", "ui", ["test"])];
		const tools = planTools(packages, uniqueLabels(packages), new Set());
		expect(tools.map((tool) => tool.name)).toEqual(["run_test_ui", "run_ui_test"]);
	});

	it("avoids a name an unrelated extension holds", () => {
		const packages = [pkg(".", "app", ["build"])];
		const tools = planTools(packages, uniqueLabels(packages), new Set(["run_build"]));
		expect(tools.map((tool) => tool.name)).toEqual(["run_root_build"]);
	});

	it("adds a counter as a last resort", () => {
		const packages = [pkg(".", "app", ["build"])];
		const taken = new Set(["run_build", "run_root_build"]);
		const tools = planTools(packages, uniqueLabels(packages), taken);
		expect(tools.map((tool) => tool.name)).toEqual(["run_root_build_2"]);
	});

	it("never repeats a name and stays stable across runs", () => {
		const packages = [
			pkg(".", "app", ["build", "test", "lint", "db:migrate"]),
			pkg("a", "a", ["build", "test"]),
			pkg("db", "db", ["build", "test", "migrate"]),
			pkg("c", "c", ["format:check", "format:fix"]),
		];
		const labels = uniqueLabels(packages);
		const first = planTools(packages, labels, new Set()).map((tool) => tool.name);
		const second = planTools(packages, labels, new Set()).map((tool) => tool.name);
		expect(first).toEqual(second);
		expect(new Set(first).size).toBe(first.length);
	});

	it("keeps a name usable as a property in a fabric program", () => {
		const packages = [pkg(".", "app", ["test:math:coverage"])];
		const tools = planTools(packages, uniqueLabels(packages), new Set());
		expect(tools[0]?.name).toMatch(/^[a-z][a-z0-9_]*$/);
	});
});
