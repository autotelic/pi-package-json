/**
 * Which copy of this extension a session is running.
 *
 * A session loads an extension at session_start and keeps it, so `pi update`
 * changes the checkout on disk without changing what the running session calls.
 * That is how a review can name a revision and still describe defects that
 * revision had already fixed, so the report says which copy it is running.
 */
import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PackageIdentity, readJson } from "./schema.ts";

/** The directory this extension's own source files live in. */
const sourceDirectory = (): string => dirname(fileURLToPath(import.meta.url));

/**
 * The newest modification time among this extension's own files, at any depth.
 *
 * A hint rather than a proof: it reads modification times, so a checkout that
 * reproduces them hides nothing but reports nothing either, and it cannot say
 * which revision is on disk. It answers the one question a session has -- has
 * the code moved since I loaded it.
 */
export const sourceStamp = (): number => {
	const directory = sourceDirectory();
	let newest = 0;
	try {
		for (const entry of readdirSync(directory, { withFileTypes: true, recursive: true })) {
			if (!entry.isFile()) continue;
			const stamp = statSync(join(entry.parentPath, entry.name)).mtimeMs;
			if (stamp > newest) newest = stamp;
		}
	} catch {
		return 0;
	}
	return newest;
};

/** This extension's own name and version, as the manifest beside it declares. */
export const identity = (): string => {
	const directory = sourceDirectory();
	const manifest = readJson(join(directory, "..", "..", "package.json"), PackageIdentity);
	if (manifest === undefined) return directory;
	return `${manifest.name} ${manifest.version} - ${directory}`;
};
