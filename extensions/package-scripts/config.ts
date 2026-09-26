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
	/**
	 * The largest number of tools this extension will register.
	 *
	 * A `package.json` is input from a repository, and a repository can hold
	 * more scripts than an agent has context. The cap bounds what one scan can
	 * add to a prompt; a scan that reaches it says so rather than quietly
	 * returning fewer tools than the repository has.
	 */
	readonly maxTools: number;
	/**
	 * Whether a path the repository's ignore files exclude is left alone.
	 *
	 * On by default. A repository that keeps ignore files has already said which
	 * directories are not its code, and that answer is better than any list this
	 * extension could ship.
	 */
	readonly respectGitignore: boolean;
	/**
	 * Text to add to a script's tool description, by script-name pattern.
	 *
	 * This is how a repository says what a script DOES rather than what it runs.
	 * A tool whose command is `knex migrate:latest` does not say which database,
	 * and nothing in the command text separates a status check from a rollback.
	 * The first matching pattern wins, in declaration order.
	 */
	readonly notes: Readonly<Record<string, string>>;
	/**
	 * Scripts that start detached unless the caller says otherwise.
	 *
	 * A watcher or a development server does not exit, so a synchronous call
	 * waits for the whole timeout and then reports a kill. Name those scripts
	 * here and the tool returns a pid and a log path at once.
	 */
	readonly backgroundScripts: ReadonlyArray<string>;
}

/**
 * Directories whose contents belong to another tool rather than to the project.
 *
 * These are not project conventions. Version-control metadata and a package
 * manager's store are a tool's own state: every dependency ships a
 * `package.json`, none of it is this repository's code, and a tool that ran one
 * of their scripts would run someone else's code under this repository's name.
 *
 * Nothing about the project itself is built in. `dist`, `build`, `vendor` and
 * `target` are conventions of particular languages and particular teams, and a
 * name that is right in one repository is wrong in the next. A project declares
 * what is not its own code in its ignore files, which this extension reads, and
 * in `skipDirs` for a directory that is not in version control at all.
 */
export const BUILT_IN_SKIP_DIRS: ReadonlyArray<string> = [
	".git",
	".hg",
	".svn",
	"node_modules",
	".pnpm-store",
	".yarn",
];

/** The configuration a repository gets when it declares nothing. */
export const DEFAULT_CONFIG: ScriptsConfig = {
	skipDirs: [],
	excludeScripts: [],
	includeScripts: [],
	managerOverride: undefined,
	maxDepth: 8,
	timeoutSeconds: 300,
	maxTools: 500,
	respectGitignore: true,
	notes: {},
	backgroundScripts: [],
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
		maxTools: declared.maxTools ?? fallback.maxTools,
		respectGitignore: declared.respectGitignore ?? fallback.respectGitignore,
		notes: declared.notes ?? fallback.notes,
		backgroundScripts: declared.backgroundScripts ?? fallback.backgroundScripts,
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
