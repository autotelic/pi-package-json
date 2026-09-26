/**
 * The plumb opinions that apply to THIS repository.
 *
 * plumb asks whether one file is well formed. joggle asks whether two things are
 * the same and whether a thing fits here.
 *
 * The ruleset is plumb generic. This extension is a Node program that runs
 * inside the Pi process: it does not depend on Effect, and it renders no
 * components, so plumb-effect and plumb-react stay out.
 */
const GENERIC = [
	"no-anonymous-wide-tuples",
	"no-barrel-export-star",
	"no-boolean-field-signals",
	"no-builtin-throws",
	"no-chained-type-assertions",
	"no-conditional-empty-object-spread",
	"no-duplicated-literal-union",
	"no-exported-mutable-state",
	"no-generic-export-names",
	"no-impossible-branch-throw",
	"no-known-value-widening",
	"no-module-mocking",
	"no-multiple-function-params",
	"no-mutable-environment-capture",
	"no-nondeterministic-core",
	"no-object-parameters",
	"no-optional-function-parameters",
	"no-product-of-state-booleans",
	"no-redundant-derived-field",
	"no-reflect-apply",
	"no-reflect-get",
	"no-reinterpret-cast",
	"no-runtime-typeof",
	"no-sentinel-comparison-union",
	"no-shape-in-symbol-names",
	"no-single-use-private-functions",
	"no-sql-string-interpolation",
	"no-stacked-jsdoc-blocks",
	"no-stray-inline-comments",
	"no-swappable-primitive-params",
	"no-tag-ladder-assertions",
	"no-transposed-field-reads",
	"no-unit-return-validators",
	"no-unknown-parameters",
	"no-unknown-returns",
	"no-unknown-type-aliases",
	"no-unsafe-dictionary-type",
	"no-widen-then-assert",
	"prefer-payload-brand",
	"require-canonical-stringify-for-identity",
	"require-deprecated-tag-for-legacy-comments",
	"require-exhaustive-tag-switch",
	"require-fc-block-predicate",
	"require-jsdoc-on-exported",
	"require-published-order",
	"require-safety-comment-for-type-assertion",
	"require-sort-comparator",
] as const;

export default {
	ignorePatterns: ["node_modules"],
	plugins: ["eslint", "oxc", "typescript", "unicorn", "jsdoc", "node"],
	settings: { jsdoc: { mode: "typescript" } },
	jsPlugins: [{ name: "plumb", specifier: "@autotelic/plumb" }],
	rules: Object.fromEntries(GENERIC.map((id) => [`plumb/${id}`, "error"])),

	/**
	 * Declared exceptions, each with the reason written down.
	 *
	 * These are not suppressions. A suppression hides a finding; an exception
	 * records that the rule and this code disagree about something, and says
	 * what. Anything without a reason does not belong here.
	 */
	overrides: [
		{
			/**
			 * `no-nondeterministic-core` exists because a function whose output
			 * depends on the clock cannot have a canonical form. This module exists
			 * for the opposite reason: a duration IS wall-clock time, and reading
			 * the clock in exactly one place is what keeps every other module a
			 * pure function of its arguments. The rule is satisfied by the shape of
			 * the repository, not by this file being exempt from it.
			 */
			files: ["extensions/package-scripts/clock.ts"],
			rules: { "plumb/no-nondeterministic-core": "off" },
		},
		{
			/**
			 * `no-sql-string-interpolation` matches the SQL keywords SELECT, FROM,
			 * UPDATE, DELETE and JOIN as whole words in the raw text of a template
			 * literal. Two strings in these files are English sentences that use the
			 * word "from" -- "the script of X, from that directory" and "may come
			 * from the environment" -- and this extension contains no SQL at all.
			 * Declared rather than reworded: editing a tool's description in order
			 * to satisfy a keyword list is the tool writing the documentation.
			 */
			files: [
				"extensions/package-scripts/index.ts",
				"extensions/package-scripts/tool.ts",
			],
			rules: { "plumb/no-sql-string-interpolation": "off" },
		},
	],
};
