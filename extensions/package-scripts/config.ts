import { join } from "node:path";
import { Config, readJson } from "./schema.ts";
import type { PackageManager } from "./types.ts";

/** Everything the scan and the tools read from configuration. */
export interface ScriptsConfig {
	/** Extra directory names the scan must not enter. */
	readonly skipDirs: ReadonlyArray<string>;
	/** Script names to leave out. `*` matches any run of characters. */
	readonly excludeScripts: ReadonlyArray<string>;
	/** When not empty, only scripts that match one of these are kept. */
	readonly includeScripts: ReadonlyArray<string>;
	/**
	 * The package manager to use instead of detecting one.
	 *
	 * Named `managerOverride` rather than `manager` because a discovered
	 * package also has a `manager`, and that one is never undefined: this one
	 * is asked for, that one is answered. The JSON key stays `manager`.
	 */
	readonly managerOverride: PackageManager | undefined;
	/** How many directory levels below the launch directory to scan. */
	readonly maxDepth: number;
	/** Default seconds before a script is killed. */
	readonly timeoutSeconds: number;
}

/**
 * Directory names that never hold a package this extension should expose.
 *
 * The scan also refuses every dot-directory, so `.git`, `.next`, `.turbo`
 * and editor state cost nothing.
 */
export const BUILT_IN_SKIP_DIRS: ReadonlyArray<string> = [
	"node_modules",
	"dist",
	"build",
	"out",
	"coverage",
	"vendor",
	"target",
	"tmp",
];

/** The configuration a repository gets when it declares nothing. */
export const DEFAULT_CONFIG: ScriptsConfig = {
	skipDirs: [],
	excludeScripts: [],
	includeScripts: [],
	managerOverride: undefined,
	maxDepth: 8,
	timeoutSeconds: 300,
};

/**
 * Read one configuration file, filling every field it omits from the fallback.
 *
 * Filling here rather than at the point of use means there is one declaration
 * of the configuration shape instead of two. A file is either absent -- and
 * then it IS the fallback -- or it is a complete configuration. The alternative,
 * a second all-optional type beside this one, gives every field two spellings
 * that drift apart the first time one of them changes.
 */
const readConfigFile = (path: string, fallback: ScriptsConfig): ScriptsConfig => {
	const declared = readJson(path, Config);
	if (declared === undefined) return fallback;
	return {
		skipDirs: declared.skipDirs ?? fallback.skipDirs,
		excludeScripts: declared.excludeScripts ?? fallback.excludeScripts,
		includeScripts: declared.includeScripts ?? fallback.includeScripts,
		managerOverride: declared.manager ?? fallback.managerOverride,
		maxDepth: declared.maxDepth ?? fallback.maxDepth,
		timeoutSeconds: declared.timeoutSeconds ?? fallback.timeoutSeconds,
	};
};

/**
 * Read the configuration for one repository.
 *
 * `.pi/package-scripts.json` wins over `package-scripts.json` at the root,
 * which wins over the built-in defaults. Each field is chosen on its own, so a
 * file can override one setting and inherit the rest.
 */
export const loadConfig = (root: string): ScriptsConfig =>
	readConfigFile(
		join(root, ".pi", "package-scripts.json"),
		readConfigFile(join(root, "package-scripts.json"), DEFAULT_CONFIG),
	);

/** A script name, and the pattern that is tested against it. */
export interface NameMatch {
	readonly pattern: string;
	readonly name: string;
}

const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Match a name against a pattern in which `*` stands for any run of
 * characters.
 *
 * Both halves travel in one argument because the two are both plain strings: a
 * call with the arguments the wrong way round would compile and then quietly
 * answer the wrong question.
 */
export const matchesPattern = (subject: NameMatch): boolean => {
	const { pattern, name } = subject;
	if (pattern === name) return true;
	if (!pattern.includes("*")) return false;
	return new RegExp(`^${pattern.split("*").map(escape).join(".*")}$`).test(name);
};
