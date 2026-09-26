import { existsSync, readdirSync, type Dirent } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { BUILT_IN_SKIP_DIRS, matchesPattern, type ScriptsConfig } from "./config.ts";
import {
	ancestorIgnores,
	isIgnored,
	readIgnoreFile,
	type IgnoreRule,
} from "./ignore.ts";
import { Manifest, readJson, type Manifest as ManifestValue } from "./schema.ts";
import { errorText } from "./text.ts";
import type {
	DiscoveredPackage,
	Discovery,
	PackageManager,
	RelativePath,
	ScriptEntry,
} from "./types.ts";

/** Lockfiles, in the order that decides the manager when nothing declares one. */
const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
	["pnpm-lock.yaml", "pnpm"],
	["yarn.lock", "yarn"],
	["bun.lockb", "bun"],
	["bun.lock", "bun"],
	["package-lock.json", "npm"],
	["npm-shrinkwrap.json", "npm"],
];

/** A dollar sign, an optional brace, and the name a script reads. */
const ENVIRONMENT_REFERENCE = /\$\{?([A-Za-z_][A-Za-z0-9_]*)/g;

/** A domain name out of a package-manager declaration, with its version dropped. */
export const parseManagerField = (declared: string | undefined): PackageManager | undefined => {
	if (declared === undefined) return undefined;
	const name = declared.split("@")[0]?.trim().toLowerCase();
	return name === "pnpm" || name === "npm" || name === "yarn" || name === "bun" ? name : undefined;
};

/** The names one command reads from the environment, in first-seen order. */
export const environmentNames = (command: string): ReadonlyArray<string> => {
	const names = new Set<string>();
	for (const match of command.matchAll(ENVIRONMENT_REFERENCE)) {
		const name = match[1];
		if (name !== undefined) names.add(name);
	}
	return [...names];
};

/**
 * The manager for one directory.
 *
 * A package that declares its own `packageManager` keeps it. Otherwise a
 * lockfile beside the package decides, and a package with neither inherits the
 * manager the workspace root declared.
 */
const managerFor = (
	directory: string,
	declared: PackageManager | undefined,
	inherited: PackageManager,
): PackageManager => {
	if (declared !== undefined) return declared;
	for (const [file, manager] of LOCKFILES) {
		if (existsSync(join(directory, file))) return manager;
	}
	return inherited;
};

/** The manager for the workspace root. */
export const detectManager = (root: string, override: PackageManager | undefined): PackageManager => {
	if (override !== undefined) return override;
	const declared = parseManagerField(readJson(join(root, "package.json"), Manifest)?.packageManager);
	return managerFor(root, declared, "npm");
};

/** The note the configuration gives one script, if any pattern matches it. */
const noteFor = (name: string, notes: Readonly<Record<string, string>>): string | undefined => {
	for (const [pattern, note] of Object.entries(notes)) {
		if (matchesPattern({ pattern, name })) return note;
	}
	return undefined;
};

/**
 * A script name that would be read as an option rather than as a name.
 *
 * The command is built as a manager, then its run subcommand, then the script
 * name, and a manager parses its own options before that name. A script called
 * `--help` would print the manager's help instead of running, so the name is
 * refused rather than registered.
 */
const looksLikeAnOption = (name: string): boolean => name.startsWith("-");

/**
 * The scripts of one manifest that survive the include and exclude patterns.
 *
 * The pattern lists are matched in the order the configuration declares them,
 * and an empty include list means everything. A note and a background default
 * are resolved here as well, because they are properties of the repository's
 * intent for the script rather than of the tool that runs it.
 *
 * A refused script is reported rather than dropped: a repository that has one
 * should be able to see that this extension cannot offer it.
 */
const scriptsFrom = (
	declared: ManifestValue["scripts"],
	config: ScriptsConfig,
	problems: string[],
	source: string,
): ReadonlyArray<ScriptEntry> => {
	if (declared === undefined) return [];
	const kept: ScriptEntry[] = [];
	for (const [name, command] of Object.entries(declared)) {
		if (looksLikeAnOption(name)) {
			problems.push(
				`${source} has a script named "${name}", which a package manager reads as an option`,
			);
			continue;
		}
		if (config.includeScripts.length > 0) {
			const included = config.includeScripts.some((pattern) =>
				matchesPattern({ pattern, name }),
			);
			if (!included) continue;
		}
		if (config.excludeScripts.some((pattern) => matchesPattern({ pattern, name }))) continue;
		kept.push({
			name,
			command,
			reads: environmentNames(command),
			note: noteFor(name, config.notes),
			background: config.backgroundScripts.some((pattern) =>
				matchesPattern({ pattern, name }),
			),
		});
	}
	return kept;
};

/** A path relative to the scan root, with forward slashes on every platform. */
const portable = (subject: RelativePath): string => {
	const relativePath = relative(subject.base, subject.path);
	return relativePath === "" ? "." : relativePath.split(sep).join("/");
};

/** The nearest directory at or above the scan root that holds a repository. */
const repositoryRoot = (root: string): string | undefined => {
	let directory = root;
	for (;;) {
		if (existsSync(join(directory, ".git"))) return directory;
		const parent = dirname(directory);
		if (parent === directory) return undefined;
		directory = parent;
	}
};

/** The scan root, and the repository root the walk must not pass. */
interface ParentWalk {
	readonly root: string;
	readonly stop: string;
}

/**
 * The directories between the scan root and the repository root, outermost
 * first, each with the name the scan root has from there.
 */
const parentsOf = (subject: ParentWalk): ReadonlyArray<RelativePath> => {
	const found: Array<RelativePath> = [];
	let directory = dirname(subject.root);
	let prefix = basename(subject.root);
	while (directory !== dirname(directory)) {
		found.push({ base: directory, path: prefix });
		if (directory === subject.stop) break;
		prefix = `${basename(directory)}/${prefix}`;
		directory = dirname(directory);
	}
	return found.reverse();
};

/**
 * Scan a launch directory for package.json files and their scripts.
 *
 * The scan is depth-first and sorted, so the same tree always produces the same
 * order, and the root package comes first. It does not follow symbolic links --
 * a symbolic link reports false from isDirectory, and that is also what stops
 * the walk from descending into a package-manager store.
 *
 * Two things decide which directories are left alone. The built-in list holds
 * another tool's own state: version-control metadata and package stores, where
 * every dependency ships a package.json and none of it is this repository's
 * code. Everything else comes from the repository itself -- its .gitignore
 * files, which say what is not part of it, and its skipDirs.
 *
 * An ignored directory is pruned, never entered. That is what git does, and for
 * the same reason: git will not re-include a path whose parent is excluded.
 *
 * A manifest that an ignore file excludes is not read either, and it is
 * reported rather than passed over in silence, because a package that is
 * missing from the tool list has to be explainable.
 */
export const discover = (root: string, config: ScriptsConfig): Discovery => {
	const absoluteRoot = resolve(root);
	const problems: string[] = [];
	const skipped: string[] = [];
	const packages: DiscoveredPackage[] = [];
	const rootManager = detectManager(absoluteRoot, config.managerOverride);
	const excluded = new Set([...BUILT_IN_SKIP_DIRS, ...config.skipDirs]);
	/**
	 * The rules that reach the scan root from above it.
	 *
	 * Without a repository above the scan root there is nothing to read, and
	 * nothing is guessed: a stray ignore file in a home directory or a shared
	 * workspace must not decide what a repository contains.
	 */
	const gitRoot = repositoryRoot(absoluteRoot);
	const inherited = ancestorIgnores(
		absoluteRoot,
		gitRoot === undefined ? [] : parentsOf({ root: absoluteRoot, stop: gitRoot }),
		gitRoot,
	);

	const visit = (directory: string, depth: number, rules: ReadonlyArray<IgnoreRule>): void => {
		const here = portable({ base: absoluteRoot, path: directory });
		const declared = readIgnoreFile({
			path: join(directory, ".gitignore"),
			base: here === "." ? "" : here,
			prefix: "",
		});
		const active = declared.length === 0 ? rules : [...rules, ...declared];

		const manifestPath = join(directory, "package.json");
		const manifestAt = here === "." ? "package.json" : `${here}/package.json`;
		const manifestKept =
			!config.respectGitignore || !isIgnored(active, manifestAt, false);
		if (existsSync(manifestPath) && !manifestKept) {
			skipped.push(manifestAt);
			problems.push(`${manifestAt} is excluded by an ignore file, so its scripts are not offered`);
		}
		const manifest = existsSync(manifestPath) && manifestKept
			? readJson(manifestPath, Manifest)
			: undefined;
		if (existsSync(manifestPath) && manifestKept && manifest === undefined) {
			problems.push(`${manifestAt} is not a package.json this extension can read`);
		}
		if (manifest !== undefined) {
			const scripts = scriptsFrom(manifest.scripts, config, problems, manifestAt);
			if (scripts.length > 0) {
				packages.push({
					dir: directory,
					rel: here,
					packageName: manifest.name,
					manager: managerFor(directory, parseManagerField(manifest.packageManager), rootManager),
					scripts,
				});
			}
		}
		if (depth === 0) return;

		let entries: ReadonlyArray<Dirent>;
		try {
			entries = readdirSync(directory, { withFileTypes: true });
		} catch (error) {
			problems.push(`cannot read ${here}: ${errorText(error)}`);
			return;
		}
		const ordered = [...entries].sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of ordered) {
			if (!entry.isDirectory()) continue;
			const path = here === "." ? entry.name : `${here}/${entry.name}`;
			if (excluded.has(entry.name)) {
				skipped.push(path);
				continue;
			}
			if (config.respectGitignore && isIgnored(active, path, true)) {
				skipped.push(path);
				continue;
			}
			visit(join(directory, entry.name), depth - 1, active);
		}
	};

	visit(absoluteRoot, config.maxDepth, inherited);
	packages.sort((left, right) =>
		left.rel === "." ? -1 : right.rel === "." ? 1 : left.rel.localeCompare(right.rel),
	);
	return { root: absoluteRoot, manager: rootManager, packages, skipped, problems };
};
