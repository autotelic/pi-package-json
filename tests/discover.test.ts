import { describe, expect, it } from "vitest";
import { discover, environmentNames, parseManagerField } from "../extensions/package-scripts/discover.ts";
import { config, json, manifest, workspace } from "./support.ts";

describe("parseManagerField", () => {
	it("reads a name and a version", () => {
		expect(parseManagerField("pnpm@9.10.0+sha256.355a8ab8")).toBe("pnpm");
	});

	it("reads a bare name", () => {
		expect(parseManagerField("yarn")).toBe("yarn");
	});

	it("rejects anything else", () => {
		expect(parseManagerField("cargo@1")).toBeUndefined();
		expect(parseManagerField("")).toBeUndefined();
		expect(parseManagerField(undefined)).toBeUndefined();
	});
});

describe("environmentNames", () => {
	it("finds variables in both forms", () => {
		expect(environmentNames("mocha ${FILE:+test/$FILE.test.js}")).toEqual(["FILE"]);
	});

	it("reports a name once", () => {
		expect(environmentNames("run $FILE && echo $FILE")).toEqual(["FILE"]);
	});

	it("ignores a digit-only reference", () => {
		expect(environmentNames("tsc $1")).toEqual([]);
	});
});

describe("discover", () => {
	it("finds the root package and every nested one", () => {
		const root = workspace({
			"package.json": json(manifest("root-app", { build: "tsc", test: "vitest" })),
			"services/rest/package.json": json(manifest("rest", { build: "tsc", migrate: "knex" })),
			"packages/utils/package.json": json(manifest("@scope/utils", { build: "tsc" })),
		});
		const found = discover(root, config());
		expect(found.packages.map((entry) => entry.rel)).toEqual([".", "packages/utils", "services/rest"]);
		expect(found.packages[0]?.scripts.length).toBe(2);
	});

	it("does not enter node_modules or a dot-directory", () => {
		const root = workspace({
			"package.json": json(manifest("root-app", { build: "tsc" })),
			"node_modules/dep/package.json": json(manifest("dep", { sneaky: "rm -rf /" })),
			".cache/inner/package.json": json(manifest("inner", { sneaky: "rm -rf /" })),
		});
		const found = discover(root, config());
		expect(found.packages.map((entry) => entry.rel)).toEqual(["."]);
		expect(found.skipped).toContain("node_modules");
		expect(found.skipped).toContain(".cache");
	});

	it("honours a configured skip directory", () => {
		const root = workspace({
			"package.json": json(manifest("root-app", { build: "tsc" })),
			"fixtures/thing/package.json": json(manifest("thing", { build: "tsc" })),
		});
		expect(discover(root, config()).packages.length).toBe(2);
		expect(discover(root, config({ skipDirs: ["fixtures"] })).packages.length).toBe(1);
	});

	it("stops at maxDepth", () => {
		const root = workspace({
			"package.json": json(manifest("root-app", { build: "tsc" })),
			"a/b/c/d/package.json": json(manifest("deep", { build: "tsc" })),
		});
		expect(discover(root, config({ maxDepth: 2 })).packages.map((entry) => entry.rel)).toEqual(["."]);
		expect(discover(root, config({ maxDepth: 4 })).packages.map((entry) => entry.rel)).toEqual([
			".",
			"a/b/c/d",
		]);
	});

	it("drops an excluded script and keeps the rest", () => {
		const root = workspace({
			"package.json": json(manifest("root-app", { build: "tsc", watch: "chokidar", "dev:serve": "vite" })),
		});
		const found = discover(root, config({ excludeScripts: ["watch", "dev*"] }));
		expect(found.packages[0]?.scripts.map((entry) => entry.name)).toEqual(["build"]);
	});

	it("keeps only an included script", () => {
		const root = workspace({
			"package.json": json(manifest("root-app", { build: "tsc", test: "vitest", lint: "oxlint" })),
		});
		const found = discover(root, config({ includeScripts: ["test"] }));
		expect(found.packages[0]?.scripts.map((entry) => entry.name)).toEqual(["test"]);
	});

	it("leaves out a package that has no script left", () => {
		const root = workspace({
			"package.json": json(manifest("root-app", { watch: "chokidar" })),
			"other/package.json": json(manifest("other", { build: "tsc" })),
		});
		const found = discover(root, config({ excludeScripts: ["watch"] }));
		expect(found.packages.map((entry) => entry.rel)).toEqual(["other"]);
	});

	it("reads the package manager from the root declaration", () => {
		const root = workspace({
			"package.json": json({
				name: "root-app",
				packageManager: "pnpm@9.10.0+sha256.355a8ab8",
				scripts: { build: "tsc" },
			}),
			"services/rest/package.json": json(manifest("rest", { build: "tsc" })),
		});
		const found = discover(root, config());
		expect(found.manager).toBe("pnpm");
		expect(found.packages.every((entry) => entry.manager === "pnpm")).toBe(true);
	});

	it("falls back to a lockfile", () => {
		const root = workspace({
			"package.json": json(manifest("root-app", { build: "tsc" })),
			"yarn.lock": "",
		});
		expect(discover(root, config()).manager).toBe("yarn");
	});

	it("lets one package override the root manager", () => {
		const root = workspace({
			"package.json": json({
				name: "root-app",
				packageManager: "pnpm@9.10.0",
				scripts: { build: "tsc" },
			}),
			"services/rest/package.json": json({
				name: "rest",
				packageManager: "npm@10.0.0",
				scripts: { build: "tsc" },
			}),
		});
		const found = discover(root, config());
		expect(found.packages.map((entry) => entry.manager)).toEqual(["pnpm", "npm"]);
	});

	it("ignores a package.json that is not an object", () => {
		const root = workspace({
			"package.json": json(manifest("root-app", { build: "tsc" })),
			"broken/package.json": "[1, 2, 3]",
		});
		expect(discover(root, config()).packages.map((entry) => entry.rel)).toEqual(["."]);
	});

	it("ignores a package.json that does not match the schema", () => {
		const root = workspace({
			"package.json": json(manifest("root-app", { build: "tsc" })),
			"odd/package.json": json({ name: "odd", scripts: { build: 12 } }),
		});
		expect(discover(root, config()).packages.map((entry) => entry.rel)).toEqual(["."]);
	});

	it("records the environment a script reads", () => {
		const root = workspace({
			"package.json": json(manifest("root-app", { "test:file": "mocha $FILE" })),
		});
		expect(discover(root, config()).packages[0]?.scripts[0]?.reads).toEqual(["FILE"]);
	});
});
