import { readFileSync } from "node:fs";

/*
 * The gitignore(5) rules this extension honours.
 *
 * The extension must not guess which directories are not the project's code.
 * `dist`, `build`, `vendor` and `target` are conventions of particular languages
 * and particular teams, and a list of them is wrong in the next repository. A
 * `.gitignore` is not a guess: it is the repository's own declaration of what is
 * not part of it, written by the people who know.
 *
 * What is implemented here is the part of the format that decides a directory:
 * comments, blank lines, `!` negation, a trailing `/` for directories only, a
 * leading or middle `/` for an anchored pattern, `*`, `?`, `**` and character
 * ranges. Later rules win, and a rule from a deeper file wins over a rule from a
 * shallower one, which is what git does.
 *
 * What is NOT implemented: the global `core.excludesFile`, which would need a
 * `git config` lookup, and the rule that a path inside an ignored directory
 * cannot be re-included. The second is not a gap, because the scan prunes an
 * ignored directory and never looks inside it -- which is what git does, for the
 * same reason.
 */

import type { RelativePath } from "./types.ts";

/** One compiled line from a `.gitignore` or from `.git/info/exclude`. */
export interface IgnoreRule {
	/** The declaring directory, relative to the scan root; "" at the root. */
	readonly base: string;
	/** Tested against a path relative to `base`, with no leading slash. */
	readonly matcher: RegExp;
	readonly negated: boolean;
	readonly directoryOnly: boolean;
}

/** One ignore line, and the directory whose file declared it. */
export interface IgnoreLine {
	readonly line: string;
	readonly base: string;
}

/** One ignore file, and the directory it sits in. */
export interface IgnoreFile {
	readonly path: string;
	readonly base: string;
}

/** Characters that mean something to a regular expression. */
const SPECIAL = new Set([".", "\\", "+", "^", "$", "{", "}", "(", ")", "|"]);

/**
 * Compile one pattern body into the regular-expression source it stands for.
 *
 * One star stops at a slash; two stars cross one. A leading pair followed by a
 * slash may match no directory at all, which is why the pattern it builds
 * matches "build" at the top of a repository as well as "packages/a/build".
 */
const translate = (pattern: string): string => {
	let source = "";
	let index = 0;
	while (index < pattern.length) {
		const character = pattern[index] ?? "";
		if (character === "*") {
			if (pattern[index + 1] === "*") {
				if (pattern[index + 2] === "/") {
					source += "(?:.*/)?";
					index += 3;
					continue;
				}
				source += ".*";
				index += 2;
				continue;
			}
			source += "[^/]*";
			index += 1;
			continue;
		}
		if (character === "?") {
			source += "[^/]";
			index += 1;
			continue;
		}
		if (character === "[") {
			const end = pattern.indexOf("]", index + 1);
			if (end === -1) {
				source += "\\[";
				index += 1;
				continue;
			}
			const body = pattern.slice(index + 1, end).replace(/^!/u, "^");
			source += `[${body}]`;
			index = end + 1;
			continue;
		}
		source += SPECIAL.has(character) ? `\\${character}` : character;
		index += 1;
	}
	return source;
};

/**
 * Compile one `.gitignore` line, or nothing when the line declares nothing.
 *
 * A blank line and a line whose first character is `#` are separators and
 * comments. A leading `!` re-includes. A trailing `/` limits the rule to
 * directories. A slash at the start or in the middle anchors the pattern to the
 * directory that declared it; without one, the pattern may match at any level
 * below, which is what makes `dist` in a root `.gitignore` catch
 * `services/api/dist` as well.
 */
export const compileIgnoreLine = (subject: IgnoreLine): IgnoreRule | undefined => {
	const { line, base } = subject;
	const trimmed = line.trimEnd();
	if (trimmed === "" || trimmed.startsWith("#")) return undefined;

	const negated = trimmed.startsWith("!");
	const body = negated ? trimmed.slice(1) : trimmed;
	if (body === "") return undefined;

	const directoryOnly = body.endsWith("/");
	const pattern = directoryOnly ? body.slice(0, -1) : body;
	if (pattern === "") return undefined;

	const anchored = pattern.startsWith("/") || pattern.slice(1).includes("/");
	const bare = pattern.startsWith("/") ? pattern.slice(1) : pattern;
	const translated = translate(bare);
	return {
		base,
		matcher: new RegExp(anchored ? `^${translated}$` : `(?:^|/)${translated}$`, "u"),
		negated,
		directoryOnly,
	};
};

/**
 * The rules one ignore file declares.
 *
 * `base` is the directory the file sits in, relative to the scan root, and is
 * "" for the root itself. A file that cannot be read declares nothing.
 */
export const readIgnoreFile = (subject: IgnoreFile): ReadonlyArray<IgnoreRule> => {
	const { path, base } = subject;
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return [];
	}
	const rules: IgnoreRule[] = [];
	for (const line of text.split("\n")) {
		const rule = compileIgnoreLine({ line, base });
		if (rule !== undefined) rules.push(rule);
	}
	return rules;
};

/** The path a rule sees, or nothing when the rule cannot apply to it. */
const relativeTo = (subject: RelativePath): string | undefined => {
	const { base, path } = subject;
	if (base === "") return path;
	if (!path.startsWith(`${base}/`)) return undefined;
	return path.slice(base.length + 1);
};

/**
 * Whether the rules ignore a path.
 *
 * The rules are tested in order and the last one that matches decides, so a
 * negation later in a file beats an exclusion earlier in it, and a rule from a
 * nested file beats a rule from the root.
 */
export const isIgnored = (
	rules: ReadonlyArray<IgnoreRule>,
	path: string,
	directory: boolean,
): boolean => {
	let ignored = false;
	for (const rule of rules) {
		if (rule.directoryOnly && !directory) continue;
		const subject = relativeTo({ base: rule.base, path });
		if (subject === undefined || subject === "") continue;
		if (rule.matcher.test(subject)) ignored = !rule.negated;
	}
	return ignored;
};
