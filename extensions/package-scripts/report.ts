/**
 * The `/packages` report.
 *
 * A monorepo can register more tools than a reader can scan, so the report is
 * how a name becomes a directory, how an alias becomes the tool that owns the
 * work, and how a missing package is explained. It is also where a session says
 * which revision it is running.
 */
import { matchesPattern } from "./config.ts";
import { delegationTarget } from "./delegate.ts";
import { identity, sourceStamp } from "./revision.ts";
import type { PlannedTool, Scan } from "./types.ts";

/** Rows the report prints before it summarises the rest. */
const REPORT_LIMIT = 60;

/** The configuration file `/packages init` writes at the scan root. */
export const CONFIG_FILE = "package-scripts.json";

/**
 * A starter configuration naming every script the scan found.
 *
 * A note is the only risk information a repository can give this extension, and
 * a review that asked for one found a repository with none at all. An empty
 * field is easy to fill in and easy to notice, so writing the file is what turns
 * "the repository says nothing" from a design gap into a task with a place to
 * happen.
 */
export const starterConfig = (tools: ReadonlyArray<PlannedTool>): string => {
	const notes: Record<string, string> = {};
	const names = [...new Set(tools.map((tool) => tool.script.name))].sort((left, right) =>
		left.localeCompare(right),
	);
	for (const name of names) {
		notes[name] = "";
	}
	return `${JSON.stringify({ notes }, null, 2)}\n`;
};

/** One count and its noun, with the noun pluralised when it should be. */
export const numberOf = (count: number, noun: string): string =>
	`${count} ${noun}${count === 1 ? "" : "s"}`;

/** One line naming the scan: where it ran, how much it found, and what it left. */
const summaryOf = (state: Scan): string => {
	const parts = [
		state.root,
		numberOf(state.discovery.packages.length, "package"),
		numberOf(state.tools.length, "script"),
		state.discovery.manager,
	];
	if (state.dropped > 0) parts.push(`${numberOf(state.dropped, "script")} past maxTools`);
	return parts.join(" - ");
};

/**
 * The report body.
 *
 * With no pattern it lists every package and how many scripts each one gave.
 * With one it lists the matching tools, and names the target of a root script
 * that only calls a nested one, so one action does not read as two.
 */
export const reportOf = (state: Scan, wanted: string, drifted: boolean): string => {
	const lines: string[] = [];
	if (drifted) {
		lines.push(
			"The extension source on disk changed after this session loaded it, so these tools run the older code. Restart pi to use the newer code.",
			"",
		);
	}
	lines.push(summaryOf(state));
	if (wanted === "") {
		lines.push("");
		for (const pkg of state.discovery.packages) {
			const count = state.tools.filter((tool) => tool.pkg === pkg).length;
			lines.push(`  ${pkg.rel} [${pkg.manager}] - ${numberOf(count, "script")}`);
		}
		return lines.join("\n");
	}
	const matched = state.tools.filter(
		(tool) =>
			matchesPattern({ pattern: wanted, name: tool.name }) ||
			matchesPattern({ pattern: wanted, name: tool.script.name }),
	);
	if (matched.length === 0) {
		lines.push("", `  no script matches "${wanted}"`);
		return lines.join("\n");
	}
	lines.push("");
	for (const tool of matched.slice(0, REPORT_LIMIT)) {
		const target = delegationTarget(tool, state.tools);
		const alias = target === undefined ? "" : `  (delegates to ${target})`;
		lines.push(`  ${tool.name} -> ${tool.pkg.rel} - ${tool.script.name}${alias}`);
	}
	if (matched.length > REPORT_LIMIT) {
		lines.push(`  ...and ${matched.length - REPORT_LIMIT} more`);
	}
	return lines.join("\n");
};

/** The report, with what went wrong and which revision is running. */
export const fullReport = (state: Scan, wanted: string, loadedAt: number): string => {
	const lines = [reportOf(state, wanted, sourceStamp() > loadedAt)];
	if (state.problems.length > 0) {
		lines.push("", `${numberOf(state.problems.length, "problem")}:`);
		for (const problem of state.problems) lines.push(`  ${problem}`);
	}
	lines.push("", identity());
	return lines.join("\n");
};
