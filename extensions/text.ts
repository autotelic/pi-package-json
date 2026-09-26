import type { Clamped } from "./types.ts";

/** The message of an unknown thrown value. */
export const errorText = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

/**
 * Hold a model-facing string to a limit.
 *
 * The head and the tail both carry meaning for a script run: the start says
 * what ran, the end says how it finished. The middle is dropped first.
 */
export const clamp = (value: string, limit: number): Clamped => {
	if (value.length <= limit) return { text: value, truncated: false };
	const head = Math.floor(limit / 4);
	const tail = limit - head;
	return {
		text:
			value.slice(0, head) +
			`\n\n... ${value.length - limit} characters omitted ...\n\n` +
			value.slice(-tail),
		truncated: true,
	};
};

/**
 * A duration for a reader, to one decimal place.
 *
 * Rounded to whole seconds, a 400ms timeout prints as "0s", which reads as a
 * bug in the tool rather than as a very short timeout.
 */
export const durationText = (milliseconds: number): string =>
	`${(milliseconds / 1_000).toFixed(1)}s`;

/**
 * Shorten a string to one line of at most `limit` characters, keeping both ends.
 *
 * The two ends of a command carry the parts a reader decides with: the program
 * and its first argument at the front, the environment and the target at the
 * back. Cutting only the tail hides exactly what a dangerous script names, so a
 * command that must be shortened loses its middle and says how much went.
 */
export const shorten = (value: string, limit: number): string => {
	if (value.length <= limit) return value;
	const omitted = value.length - limit;
	const marker = ` … [${omitted} characters] … `;
	const room = limit - marker.length;
	const head = Math.ceil(room * 0.55);
	return `${value.slice(0, head)}${marker}${value.slice(-(room - head))}`;
};
