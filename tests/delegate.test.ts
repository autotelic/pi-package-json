import { describe, expect, it } from "vitest";
import { delegationIn, delegationTarget } from "../extensions/package-scripts/delegate.ts";
import type { PlannedTool, ScriptEntry } from "../extensions/package-scripts/types.ts";

const tool = (
	name: string,
	rel: string,
	packageName: string | undefined,
	scriptName: string,
	command: string,
): PlannedTool => {
	const script: ScriptEntry = {
		name: scriptName,
		command,
		reads: [],
		note: undefined,
		background: false,
	};
	return {
		name,
		label: rel + ":" + scriptName,
		pkg: { dir: "/repo/" + rel, rel, packageName, manager: "pnpm", scripts: [script] },
		script,
	};
};

describe("delegationIn", () => {
	it("reads a filter and a script", () => {
		expect(delegationIn("pnpm --filter db knex:migrate")).toEqual({
			filter: "db",
			scriptName: "knex:migrate",
		});
	});

	it("reads a scoped package name", () => {
		expect(delegationIn("pnpm --filter @autotelic/domain test:payroll")).toEqual({
			filter: "@autotelic/domain",
			scriptName: "test:payroll",
		});
	});

	it("reads the short filter flag", () => {
		expect(delegationIn("pnpm -F rest test")).toEqual({ filter: "rest", scriptName: "test" });
	});

	it("reads the first delegation of a chain", () => {
		expect(delegationIn("pnpm --filter db bootstrap && pnpm --filter rest test")).toEqual({
			filter: "db",
			scriptName: "bootstrap",
		});
	});

	it("ignores a command that delegates to nothing", () => {
		expect(delegationIn("tsc -p tsconfig.json")).toBeUndefined();
		expect(delegationIn("pnpm run build")).toBeUndefined();
	});
});

describe("delegationTarget", () => {
	const tools = [
		tool("run_db_migrate", ".", "app", "db:migrate", "pnpm --filter db knex:migrate"),
		tool("run_db_knex_migrate", "services/db", "db", "knex:migrate", "knex --knexfile src/knexfile.js"),
		tool("run_test_payroll", ".", "app", "test:payroll", "pnpm --filter @autotelic/domain test:payroll"),
		tool("run_domain_test_payroll", "packages/domain", "@autotelic/domain", "test:payroll", "vitest run"),
		tool("run_lint", ".", "app", "lint", "oxlint ."),
	];

	it("names the tool that owns the work", () => {
		expect(delegationTarget(tools[0]!, tools)).toBe("run_db_knex_migrate");
	});

	it("matches a filter against a scoped package name", () => {
		expect(delegationTarget(tools[2]!, tools)).toBe("run_domain_test_payroll");
	});

	it("returns nothing for a script that does not delegate", () => {
		expect(delegationTarget(tools[4]!, tools)).toBeUndefined();
	});

	it("returns nothing when no tool owns the target", () => {
		const orphan = tool("run_orphan", ".", "app", "orphan", "pnpm --filter nowhere build");
		expect(delegationTarget(orphan, tools)).toBeUndefined();
	});

	it("returns nothing when the target is the tool itself", () => {
		const self = tool("run_self", "pkg", "pkg", "self", "pnpm --filter pkg self");
		expect(delegationTarget(self, [self])).toBeUndefined();
	});
});
