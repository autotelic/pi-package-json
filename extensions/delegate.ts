import { sanitize } from "./naming.ts";
import type { PlannedTool } from "./types.ts";

/** A command of the shape `pnpm --filter <package> <script>`. */
export interface Delegation {
	readonly filter: string;
	/** The script name the filter runs. Distinct from \`PlannedTool.script\`. */
	readonly scriptName: string;
}

/** The first package delegation in a command, if the command makes one. */
const DELEGATION = /\b(?:pnpm|npm|yarn|bun)\s+(?:--filter|-F)\s+(\S+)\s+(\S+)/u;

/** The package and script a command delegates to, when it delegates at all. */
export const delegationIn = (command: string): Delegation | undefined => {
	const match = DELEGATION.exec(command);
	const filter = match?.[1];
	const script = match?.[2];
	if (filter === undefined || script === undefined) return undefined;
	return { filter, scriptName: script };
};

/**
 * Whether a package answers to the name a `--filter` used.
 *
 * pnpm matches a filter against the package name, the name without its scope,
 * and the directory name, so a resolver has to try all three.
 */
const answersTo = (tool: PlannedTool, filter: string): boolean => {
	const name = tool.pkg.packageName;
	if (name === filter) return true;
	if (name !== undefined && name.slice(name.lastIndexOf("/") + 1) === filter) return true;
	const directory = tool.pkg.rel.slice(tool.pkg.rel.lastIndexOf("/") + 1);
	return sanitize(directory) === sanitize(filter);
};

/**
 * The tool a delegating script ends up running, by name.
 *
 * A repository keeps root scripts that only call a nested one, so one action
 * has two names: `run_db_migrate` and `run_db_knex_migrate` run the same
 * command. Naming the target is what lets an agent choose the tool that owns
 * the work instead of the alias that points at it.
 */
export const delegationTarget = (
	tool: PlannedTool,
	tools: ReadonlyArray<PlannedTool>,
): string | undefined => {
	const delegation = delegationIn(tool.script.command);
	if (delegation === undefined) return undefined;
	const target = tools.find(
		(candidate) =>
			answersTo(candidate, delegation.filter) &&
			candidate.script.name === delegation.scriptName,
	);
	if (target === undefined || target.name === tool.name) return undefined;
	return target.name;
};
