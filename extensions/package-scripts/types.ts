/**
 * The package managers this extension knows how to invoke.
 *
 * All four take the same `run <script>` form, so the manager name alone is
 * enough to build a command line. It is NOT enough on its own to pass extra
 * arguments: npm needs a `--` separator before them and pnpm must not have one.
 */
export type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

/** One entry from a `package.json` `scripts` object. */
export interface ScriptEntry {
	readonly name: string;
	readonly command: string;
	/**
	 * Environment variable names the command reads, in first-seen order.
	 *
	 * Named `reads` rather than `env`: the values the caller supplies travel
	 * under `environment`, and one name for two things is how a reader comes to
	 * believe a list of names is a list of values.
	 */
	readonly reads: ReadonlyArray<string>;
	/** Text from the configuration, when a note pattern matched this script. */
	readonly note: string | undefined;
	/** Whether the configuration says this script starts detached by default. */
	readonly background: boolean;
}

/** A `package.json` found under the launch directory. */
export interface DiscoveredPackage {
	/** Absolute path of the directory that holds the `package.json`. */
	readonly dir: string;
	/** That directory relative to the launch directory; `.` for the root. */
	readonly rel: string;
	/** The `name` field, when the file has one. */
	readonly packageName: string | undefined;
	/** The package manager that runs this package's scripts. */
	readonly manager: PackageManager;
	/** The scripts that survived the include and exclude patterns. */
	readonly scripts: ReadonlyArray<ScriptEntry>;
}

/**
 * A path, and the directory it is measured from.
 *
 * Both halves travel in one argument because the two are plain strings: a call
 * with the arguments the wrong way round compiles and then answers about a
 * different directory.
 */
export interface RelativePath {
	readonly base: string;
	readonly path: string;
}

/** A model-facing string, and whether it was cut to fit its limit. */
export interface Clamped {
	readonly text: string;
	readonly truncated: boolean;
}

/** The result of one scan of the launch directory. */
export interface Discovery {
	readonly root: string;
	/** The manager the root declares, which nested packages inherit. */
	readonly manager: PackageManager;
	readonly packages: ReadonlyArray<DiscoveredPackage>;
	/** Directories the scan did not enter, relative to the root. */
	readonly skipped: ReadonlyArray<string>;
	/** Files the scan could not read or parse. */
	readonly problems: ReadonlyArray<string>;
}

/** One script bound to one tool name. */
export interface PlannedTool {
	readonly name: string;
	readonly label: string;
	readonly pkg: DiscoveredPackage;
	readonly script: ScriptEntry;
}
