import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

/**
 * The facts every script tool result carries, whatever the outcome.
 *
 * Declared once, as a schema, so the three outcomes below cannot drift apart
 * on the fields they share and so a reader of a result has one named contract
 * for them rather than three copies of the same shape.
 */
export const ScriptFacts = Type.Object({
	tool: Type.String(),
	package: Type.String(),
	scriptName: Type.String(),
	packageManager: Type.String(),
	cwd: Type.String(),
	log: Type.String(),
});

/** The facts every script tool result carries, whatever the outcome. */
export type ScriptFacts = Static<typeof ScriptFacts>;

/**
 * The structured half of a script tool result.
 *
 * This is a schema rather than an interface because the value crosses a
 * boundary twice: the tool publishes it, and a `tool_result` handler reads it
 * back to decide whether the call failed, at which point it arrives as
 * `unknown`. One declaration answers both.
 *
 * `outcome` is a discriminant rather than a set of sibling flags, so a reader
 * cannot reach for an exit code that a detached run never had.
 */
export const ScriptDetails = Type.Union([
	Type.Intersect([
		ScriptFacts,
		Type.Object({ outcome: Type.Literal("started"), pid: Type.Number() }),
	]),
	Type.Intersect([
		ScriptFacts,
		Type.Object({
			outcome: Type.Literal("exited"),
			exitCode: Type.Number(),
			durationMs: Type.Number(),
		}),
	]),
	Type.Intersect([
		ScriptFacts,
		Type.Object({ outcome: Type.Literal("unavailable"), reason: Type.String() }),
	]),
]);

/** The structured half of a script tool result. */
export type ScriptDetails = Static<typeof ScriptDetails>;

/**
 * The details of a tool result, or nothing when another tool produced it.
 *
 * The handler runs for every tool in the session, so the decode is also the
 * filter: a result that does not fit this shape is not ours to judge.
 */
export const detailsOf = (event: ToolResultEvent): ScriptDetails | undefined => {
	const candidate = event.details;
	return Value.Check(ScriptDetails, candidate) ? candidate : undefined;
};

/**
 * Whether a script tool result reports a failure.
 *
 * A script that exits non-zero is a failed tool call, and a script that could
 * not start is too. A detached run has not failed yet -- it has only started.
 */
export const scriptFailed = (details: ScriptDetails): boolean => {
	switch (details.outcome) {
		case "started":
			return false;
		case "unavailable":
			return true;
		case "exited":
			return details.exitCode !== 0;
	}
};
