import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG } from "../extensions/config.ts";
import type { ScriptsConfig } from "../extensions/config.ts";

/** A `package.json` body for a fixture, as the manifest schema describes it. */
export interface ManifestInput {
	readonly name?: string;
	readonly packageManager?: string;
	readonly scripts: Record<string, string>;
}

/** A configuration with the named fields replaced. */
export const config = (overrides: Partial<ScriptsConfig> = {}): ScriptsConfig => ({
	...DEFAULT_CONFIG,
	...overrides,
});

/** Serialise a value for a fixture file. */
export const json = <T>(value: T): string => JSON.stringify(value, null, 2);

/** A `package.json` body with the given scripts, and a name when one is given. */
export const manifest = (
	name: string | undefined,
	scripts: Record<string, string>,
): ManifestInput => {
	const base: ManifestInput = { scripts };
	return name === undefined ? base : { ...base, name };
};

/**
 * Write a directory tree into a fresh temporary directory.
 *
 * Keys are paths relative to the new root. A key that ends in a forward slash
 * makes a directory; every other key is written as a file with the given text.
 */
export const workspace = (tree: Record<string, string>): string => {
	const root = mkdtempSync(join(tmpdir(), "pi-package-json-"));
	for (const [path, text] of Object.entries(tree)) {
		const target = join(root, path);
		if (path.endsWith("/")) {
			mkdirSync(target, { recursive: true });
			continue;
		}
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, text);
	}
	return root;
};
