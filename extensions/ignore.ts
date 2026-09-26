import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RelativePath } from "./types.ts";

/*
 * The gitignore(5) rules this extension honours.
 *
 * The extension must not guess which directories are not the project's code.
 * `dist`, `build`, `vendor` and `target` are conventions of particular languages
 * and particular teams, and a list of them is wrong in the next repository. A
 * `.gitignore` is not a guess: it is the repository's own declaration of what is
 * not part of it, written by the people who know.
 *
 * What is implemented here is the part of the format that decides a path:
 * comments, blank lines, backslash escapes, `!` negation, a trailing `/` for
 * directories only, a leading or middle `/` for an anchored pattern, `*`, `?`,
 * `**` and character ranges. Later rules win, and a rule from a deeper file wins
 * over a rule from a shallower one, which is what git does.
 *
 * What is NOT implemented: the global `core.excludesFile`, which would need a
 * `git config` lookup; a trailing space escaped with a backslash, because the
 * line is trimmed; and the rule that a path inside an ignored directory cannot
 * be re-included. The third is not a gap, because the scan prunes an ignored
 * directory and never looks inside it, which is what git does for the same
 * reason.
 */

/** One compiled line from a `.gitignore` or from `.git/info/exclude`. */
export interface IgnoreRule {
	/** The declaring directory, relative to the scan root; "" at the root. */
	readonly base: string;
	/**
	 * The names to put in front of a scan-root path, for a rule declared above it.
	 *
	 * Pi is often launched inside one package of a repository, and a rule in the
	 * repository root sees the path from the repository, not from the package. A
	 * rule declared at or below the scan root leaves this empty and strips `base`
	 * instead; a rule declared above it leaves `base` empty and adds this.
	 */
	readonly prefix: string;
	/** Tested against the path as the declaring directory sees it. */
	readonly matcher: RegExp;
	readonly negated: boolean;
	readonly directoryOnly: boolean;
}

/** One ignore line, the directory whose file declared it, and how to address it. */
export interface IgnoreLine {
	readonly line: string;
	readonly base: string;
	/** Empty at or below the scan root, which is every line a scan reads itself. */
	readonly prefix: string;
}

/** One ignore file, and where it sits. */
export interface IgnoreFile {
	readonly path: string;
	readonly base: string;
	/** Empty at or below the scan root, which is every file a scan reads itself. */
	readonly prefix: string;
}

/** Characters that mean something to a regular expression. */
const SPECIAL = new Set([
	".",
	"\\",
	"+",
	"^",
	"$",
	"{",
	"}",
	"(",
	")",
	"|",
	"*",
	"?",
	"[",
	"]",
]);

/** One character, as the regular expression that matches it and nothing else. */
const literal = (character: string): string => (SPECIAL.has(character) ? `\\${character}` : character);

/**
 * Compile one pattern body into the regular-expression source it stands for.
 *
 * One star stops at a slash; two stars cross one. A leading pair followed by a
 * slash may match no directory at all, which is why the pattern it builds
 * matches "build" at the top of a repository as well as "packages/a/build".
 *
 * A backslash makes the next character literal, which is how a pattern can name
 * a file called "#notes" or "a b" without the first being read as a comment.
 */
const translate = (pattern: string): string => {
	let source = "";
	let index = 0;
	while (index < pattern.length) {
		const character = pattern[index] ?? "";
		if (character === "\\" && index + 1 < pattern.length) {
			source += literal(pattern[index + 1] ?? "");
			index += 2;
			continue;
		}
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
		source += literal(character);
		index += 1;
	}
	return source;
};

/**
 * Compile one `.gitignore` line, or nothing when the line declares nothing.
 *
 * A blank line and a line whose first character is `#` are separators and
 * comments, unless that character is escaped. A leading `!` re-includes, unless
 * it is escaped. A trailing `/` limits the rule to directories. A slash at the
 * start or in the middle anchors the pattern to the directory that declared it;
 * without one, the pattern may match at any level below, which is what makes
 * `dist` in a root `.gitignore` catch `services/api/dist` as well.
 */
export const compileIgnoreLine = (subject: IgnoreLine): IgnoreRule | undefined => {
	const trimmed = subject.line.trimEnd();
	if (trimmed === "") return undefined;

	const escapedHash = trimmed.startsWith("\\#");
	const escapedBang = trimmed.startsWith("\\!");
	if (trimmed.startsWith("#") && !escapedHash) return undefined;

	const negated = trimmed.startsWith("!") && !escapedBang;
	const body = negated ? trimmed.slice(1) : trimmed;
	if (body === "") return undefined;

	const directoryOnly = body.endsWith("/");
	const pattern = directoryOnly ? body.slice(0, -1) : body;
	if (pattern === "") return undefined;

	const anchored = pattern.startsWith("/") || pattern.slice(1).includes("/");
	const bare = pattern.startsWith("/") ? pattern.slice(1) : pattern;
	const translated = translate(bare);
	return {
		base: subject.base,
		prefix: subject.prefix,
		matcher: new RegExp(anchored ? `^${translated}$` : `(?:^|/)${translated}$`, "u"),
		negated,
		directoryOnly,
	};
};

/**
 * The rules one ignore file declares.
 *
 * A file that cannot be read declares nothing, which is what git does with a
 * file that is not there.
 */
export const readIgnoreFile = (subject: IgnoreFile): ReadonlyArray<IgnoreRule> => {
	let text: string;
	try {
		text = readFileSync(subject.path, "utf8");
	} catch {
		return [];
	}
	const rules: IgnoreRule[] = [];
	for (const line of text.split("\n")) {
		const rule = compileIgnoreLine({
			line,
			base: subject.base,
			prefix: subject.prefix,
		});
		if (rule !== undefined) rules.push(rule);
	}
	return rules;
};

/** The path a rule sees, or nothing when the rule cannot apply to it. */
const subjectOf = (rule: IgnoreRule, path: string): string | undefined => {
	if (rule.prefix !== "") return `${rule.prefix}/${path}`;
	if (rule.base === "") return path;
	if (!path.startsWith(`${rule.base}/`)) return undefined;
	return path.slice(rule.base.length + 1);
};

/**
 * Whether the rules ignore a path.
 *
 * The rules are tested in order and the last one that matches decides, so a
 * negation later in a file beats an exclusion earlier in it, and a rule from a
 * nested file beats a rule from the root.
 *
 * This answers about the path it is given and nothing more. Git also calls a
 * path ignored when an ANCESTOR directory is ignored; this does not, because the
 * scan prunes an ignored directory and never asks about anything below it. A
 * caller that reads one path at a time must do the same.
 */
export const isIgnored = (
	rules: ReadonlyArray<IgnoreRule>,
	path: string,
	directory: boolean,
): boolean => {
	let ignored = false;
	for (const rule of rules) {
		if (rule.directoryOnly && !directory) continue;
		const subject = subjectOf(rule, path);
		if (subject === undefined || subject === "") continue;
		if (rule.matcher.test(subject)) ignored = !rule.negated;
	}
	return ignored;
};

/**
 * The ignore rules that reach the scan root from above it.
 *
 * Pi is often launched inside one package of a repository, and the files that
 * say what the repository is live above that directory. Reading them costs a
 * walk and a few small reads, and it is the difference between reading the
 * repository's own declaration and reading none of it.
 *
 * The walk stops at the repository root, or at the filesystem root when there is
 * no repository. Going higher would let an unrelated `.gitignore` in a parent
 * directory -- a home directory, a shared workspace -- decide what this
 * repository contains.
 */
export const ancestorIgnores = (
	root: string,
	parents: ReadonlyArray<RelativePath>,
	gitRoot: string | undefined,
): ReadonlyArray<IgnoreRule> => {
	const rules: IgnoreRule[] = [];
	if (gitRoot !== undefined) {
		rules.push(
			...readIgnoreFile({ path: join(gitRoot, ".git", "info", "exclude"), base: "", prefix: "" }),
		);
	}
	for (const parent of parents) {
		rules.push(
			...readIgnoreFile({
				path: join(parent.base, ".gitignore"),
				base: "",
				prefix: parent.path,
			}),
		);
	}
	return rules;
};
