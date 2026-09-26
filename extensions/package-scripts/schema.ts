import { readFileSync } from "node:fs";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

/**
 * The part of a `package.json` this extension reads.
 *
 * A `package.json` is external input. Decoding it here, once, is what lets the
 * rest of the extension work with a type instead of narrowing a value by hand
 * at every use.
 */
export const Manifest = Type.Object({
	name: Type.Optional(Type.String()),
	packageManager: Type.Optional(Type.String()),
	scripts: Type.Optional(Type.Record(Type.String(), Type.String())),
});

/** A decoded `package.json`. */
export type Manifest = Static<typeof Manifest>;

/** The part of `package-scripts.json` this extension reads. */
export const Config = Type.Object({
	skipDirs: Type.Optional(Type.Array(Type.String())),
	excludeScripts: Type.Optional(Type.Array(Type.String())),
	includeScripts: Type.Optional(Type.Array(Type.String())),
	manager: Type.Optional(
		Type.Union([
			Type.Literal("pnpm"),
			Type.Literal("npm"),
			Type.Literal("yarn"),
			Type.Literal("bun"),
		]),
	),
	maxDepth: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })),
	timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 3_600 })),
	maxTools: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
	notes: Type.Optional(Type.Record(Type.String(), Type.String())),
	backgroundScripts: Type.Optional(Type.Array(Type.String())),
});

/** A decoded `package-scripts.json`. Every field is optional. */
export type Config = Static<typeof Config>;

/**
 * Decode JSON text against a schema.
 *
 * A value that is malformed or does not fit the schema decodes to nothing. The
 * caller treats that the same as an absent file: the configuration falls back
 * to its defaults, and a package contributes no tool. A typo in one file must
 * not stop the other `package.json` files from being found.
 */
export const decode = <T extends TSchema>(schema: T, text: string): Static<T> | undefined => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	return Value.Check(schema, parsed) ? parsed : undefined;
};

/** Read a file and decode it against a schema. */
export const readJson = <T extends TSchema>(path: string, schema: T): Static<T> | undefined => {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
	return decode(schema, text);
};
