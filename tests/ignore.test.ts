import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	compileIgnoreLine,
	isIgnored,
	readIgnoreFile,
	type IgnoreRule,
} from "../extensions/ignore.ts";
import { workspace } from "./support.ts";

/** The rules one ignore text declares at the repository root. */
const rules = (text: string): ReadonlyArray<IgnoreRule> =>
	text
		.split("\n")
		.map((line) => compileIgnoreLine({ line, base: "", prefix: "" }))
		.filter((rule): rule is IgnoreRule => rule !== undefined);

const ignored = (text: string, path: string, directory = true): boolean =>
	isIgnored(rules(text), path, directory);

describe("compileIgnoreLine", () => {
	it("declares nothing for a blank line or a comment", () => {
		expect(compileIgnoreLine({ line: "", base: "", prefix: "" })).toBeUndefined();
		expect(compileIgnoreLine({ line: "   ", base: "", prefix: "" })).toBeUndefined();
		expect(compileIgnoreLine({ line: "# a note", base: "", prefix: "" })).toBeUndefined();
	});
});

describe("isIgnored", () => {
	it("matches a bare name at any level", () => {
		expect(ignored("dist", "dist")).toBe(true);
		expect(ignored("dist", "services/api/dist")).toBe(true);
		expect(ignored("dist", "distances")).toBe(false);
	});

	it("anchors a pattern that has a leading slash", () => {
		expect(ignored("/build", "build")).toBe(true);
		expect(ignored("/build", "packages/a/build")).toBe(false);
	});

	it("anchors a pattern that has a slash in the middle", () => {
		expect(ignored("packages/a/lib", "packages/a/lib")).toBe(true);
		expect(ignored("packages/a/lib", "nested/packages/a/lib")).toBe(false);
	});

	it("stops a single star at a slash", () => {
		expect(ignored("packages/*/lib", "packages/a/lib")).toBe(true);
		expect(ignored("packages/*/lib", "packages/a/b/lib")).toBe(false);
	});

	it("lets a double star cross a slash", () => {
		expect(ignored("**/generated", "generated")).toBe(true);
		expect(ignored("**/generated", "a/b/generated")).toBe(true);
		expect(ignored("**/node_modules", "services/api/node_modules")).toBe(true);
	});

	it("limits a trailing slash to directories", () => {
		expect(ignored("dist/", "dist", true)).toBe(true);
		expect(ignored("dist/", "dist", false)).toBe(false);
	});

	it("re-includes with a negation that comes later", () => {
		expect(ignored("*.log\n!keep.log", "x.log")).toBe(true);
		expect(ignored("*.log\n!keep.log", "keep.log")).toBe(false);
	});

	it("lets the last matching rule decide", () => {
		expect(ignored("!keep.log\n*.log", "keep.log")).toBe(true);
	});

	it("matches a question mark as one character that is not a slash", () => {
		expect(ignored("a?c", "abc")).toBe(true);
		expect(ignored("a?c", "a/c")).toBe(false);
	});

	it("matches a character range", () => {
		expect(ignored("file[0-9].ts", "file7.ts")).toBe(true);
		expect(ignored("file[0-9].ts", "filex.ts")).toBe(false);
	});

	it("applies a nested rule only under its own directory", () => {
		const nested = [...rules(""), ...nestedRules("secret", "sub")];
		expect(isIgnored(nested, "sub/secret", true)).toBe(true);
		expect(isIgnored(nested, "other/secret", true)).toBe(false);
	});
});

/** The rules a nested ignore file with this text declares, at this base. */
const nestedRules = (text: string, base: string): ReadonlyArray<IgnoreRule> =>
	text
		.split("\n")
		.map((line) => compileIgnoreLine({ line, base, prefix: "" }))
		.filter((rule): rule is IgnoreRule => rule !== undefined);

describe("escapes", () => {
	it("treats an escaped hash as a name rather than a comment", () => {
		expect(rules("\\#file")).toHaveLength(1);
		expect(ignored("\\#file", "#file")).toBe(true);
		expect(ignored("\\#file", "other")).toBe(false);
	});

	it("does not read an escaped bang as a negation", () => {
		expect(ignored("\\!name", "!name")).toBe(true);
	});

	it("treats an escaped space as a space", () => {
		expect(ignored("a\\ b", "a b")).toBe(true);
	});

	it("treats an escaped star as a star", () => {
		expect(ignored("a\\*b", "a*b")).toBe(true);
		expect(ignored("a\\*b", "axb")).toBe(false);
	});
});

describe("a rule declared above the scan root", () => {
	/** A rule from an ancestor, which sees the path with the scan root's name in front. */
	const above = (text: string, prefix: string): ReadonlyArray<IgnoreRule> =>
		text
			.split("\n")
			.map((line) => compileIgnoreLine({ line, base: "", prefix }))
			.filter((rule): rule is IgnoreRule => rule !== undefined);

	it("sees the path as the repository sees it", () => {
		expect(isIgnored(above("sub/dist", "sub"), "dist", true)).toBe(true);
		expect(isIgnored(above("sub/dist", "sub"), "other", true)).toBe(false);
	});

	it("still matches an unanchored name anywhere below", () => {
		expect(isIgnored(above("dist", "sub"), "dist", true)).toBe(true);
	});

	it("does not reach a directory the ancestor does not name", () => {
		expect(isIgnored(above("other/dist", "sub"), "dist", true)).toBe(false);
	});
});

describe("readIgnoreFile", () => {
	it("declares nothing when the file is absent", () => {
		expect(readIgnoreFile({ path: "/no/such/.gitignore", base: "", prefix: "" })).toEqual([]);
	});
});

/**
 * The strongest check available: ask git itself.
 *
 * Every case below is put to the real check-ignore, so the matcher is measured
 * against the program that defines the format rather than against my reading of
 * its documentation. Paths whose parent is itself ignored are left out, because
 * the scan prunes a directory and git will not re-include inside one -- both do
 * the same thing, so the two answers legitimately differ on the leaf.
 */
describe("agreement with git check-ignore", () => {
	const IGNORE_TEXT = [
		"# a comment",
		"node_modules",
		"dist/",
		"*.log",
		"!keep.log",
		"/build",
		"packages/*/lib",
		"**/generated",
		"coverage",
		"",
	].join("\n");

	const CASES: ReadonlyArray<readonly [string, boolean]> = [
		["node_modules", true],
		["services/api/node_modules", true],
		["dist", true],
		["services/api/dist", true],
		["x.log", true],
		["deep/down/x.log", true],
		["keep.log", false],
		["build", true],
		["packages/a/build", false],
		["packages/a/lib", true],
		["packages/a/b/lib", false],
		["generated", true],
		["a/b/generated", true],
		["coverage", true],
		["src/index.ts", false],
		["README.md", false],
	];

	it("agrees with git about escapes too", () => {
		const text = ["\\#file", "a\\ b", "\\!name"].join("\n");
		const cases = ["#file", "a b", "!name"];
		const root = workspace({ ".gitignore": text });
		for (const path of cases) mkdirSync(join(root, path), { recursive: true });
		execFileSync("git", ["init", "--quiet"], { cwd: root, stdio: "pipe" });

		const disagreements: string[] = [];
		for (const path of cases) {
			let gitSays: boolean;
			try {
				execFileSync(
					"git",
					["-c", "core.excludesFile=/dev/null", "check-ignore", "--no-index", "--quiet", "--", path],
					{ cwd: root, stdio: "pipe" },
				);
				gitSays = true;
			} catch {
				gitSays = false;
			}
			const mine = ignored(text, path, true);
			if (mine !== gitSays) disagreements.push(path + ": mine=" + String(mine) + " git=" + String(gitSays));
		}
		expect(disagreements).toEqual([]);
	});

	it("answers the same as git for every case", () => {
		const root = workspace({ ".gitignore": IGNORE_TEXT });
		for (const [path] of CASES) {
			mkdirSync(join(root, path), { recursive: true });
		}
		execFileSync("git", ["init", "--quiet"], { cwd: root, stdio: "pipe" });

		const disagreements: string[] = [];
		for (const [path, expected] of CASES) {
			let gitSays: boolean;
			try {
				execFileSync(
					"git",
					[
						"-c",
						"core.excludesFile=/dev/null",
						"check-ignore",
						"--no-index",
						"--quiet",
						"--",
						path,
					],
					{ cwd: root, stdio: "pipe" },
				);
				gitSays = true;
			} catch {
				gitSays = false;
			}
			const mine = ignored(IGNORE_TEXT, path, true);
			if (mine !== gitSays) {
				disagreements.push(path + ": mine=" + String(mine) + " git=" + String(gitSays));
			}
			expect(expected, path).toBe(gitSays);
		}
		expect(disagreements).toEqual([]);
	});
});
