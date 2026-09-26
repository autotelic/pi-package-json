import { existsSync, readdirSync, type Dirent } from "node:fs";
import { join, relative, resolve } from "node:path";
import { BUILT_IN_SKIP_DIRS, matchesPattern, type ScriptsConfig } from "./config.ts";
import { Manifest, readJson, type Manifest as ManifestValue } from "./schema.ts";
import { errorText } from "./text.ts";
import type { DiscoveredPackage, Discovery, PackageManager, ScriptEntry } from "./types.ts";

/** Lockfiles, in the order that decides the manager when nothing declares one. */
const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
	["pnpm-lock.yaml", "pnpm"],
	["yarn.lock", "yarn"],
	["bun.lockb", "bun"],
	["bun.lock", "bun"],
	["package-lock.json", "npm"],
	["npm-shrinkwrap.json", "npm"],
];

/** `$NAME` and `${NAME}` inside a script body. */
const ENVIRONMENT_REFERENCE = /\$\{?([A-Za-z_][A-Za-z0-9_]*)/g;

/** `"pnpm@9.10.0+sha256.…"` becomes `"pnpm"`. */
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

/**
 * The scripts of one manifest that survive the include and exclude patterns.
 *
 * The pattern lists are matched in the order the configuration declares them,
 * and an empty include list means "everything".
 */
const scriptsFrom = (
	declared: ManifestValue["scripts"],
	config: ScriptsConfig,
): ReadonlyArray<ScriptEntry> => {
	if (declared === undefined) return [];
	const kept: ScriptEntry[] = [];
	for (const [name, command] of Object.entries(declared)) {
		if (config.includeScripts.length > 0) {
			const included = config.includeScripts.some((pattern) =>
				matchesPattern({ pattern, name }),
			);
			if (!included) continue;
		}
		const excluded = config.excludeScripts.some((pattern) => matchesPattern({ pattern, name }));
		if (excluded) continue;
		kept.push({ name, command, reads: environmentNames(command) });
	}
	return kept;
};

/**
 * Scan a launch directory for `package.json` files and their scripts.
 *
 * The scan is depth-first and sorted, so the same tree always produces the same
 * order, and the root package comes first. It does not follow symbolic links --
 * a symbolic link reports false from `isDirectory`, and that is also what stops
 * the walk from descending into a package-manager store.
 */
export const discover = (root: string, config: ScriptsConfig): Discovery => {
	const absoluteRoot = resolve(root);
	const problems: string[] = [];
	const skipped: string[] = [];
	const packages: DiscoveredPackage[] = [];
	const rootManager = detectManager(absoluteRoot, config.managerOverride);
	const excluded = new Set([...BUILT_IN_SKIP_DIRS, ...config.skipDirs]);

	const visit = (directory: string, depth: number): void => {
		const here = relative(absoluteRoot, directory) || ".";
		const manifest = readJson(join(directory, "package.json"), Manifest);
		if (manifest !== undefined) {
			const scripts = scriptsFrom(manifest.scripts, config);
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
			if (entry.name.startsWith(".") || excluded.has(entry.name)) {
				skipped.push(join(here, entry.name));
				continue;
			}
			visit(join(directory, entry.name), depth - 1);
		}
	};

	visit(absoluteRoot, config.maxDepth);
	packages.sort((left, right) =>
		left.rel === "." ? -1 : right.rel === "." ? 1 : left.rel.localeCompare(right.rel),
	);
	return { root: absoluteRoot, manager: rootManager, packages, skipped, problems };
};
