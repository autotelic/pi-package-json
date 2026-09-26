import type { DiscoveredPackage, PlannedTool } from "./types.ts";

/** Keep letters, digits and single underscores, and lowercase the result. */
export const sanitize = (value: string): string =>
	value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");

/** A short, tool-name-safe name for one package. */
export const packageLabel = (pkg: DiscoveredPackage): string => {
	const tail =
		pkg.packageName === undefined
			? ""
			: pkg.packageName.slice(pkg.packageName.lastIndexOf("/") + 1);
	const fromName = sanitize(tail);
	if (fromName !== "") return fromName;
	const fromPath = sanitize(pkg.rel === "." ? "root" : pkg.rel);
	return fromPath === "" ? "root" : fromPath;
};

/**
 * A label for every package, with no repeats.
 *
 * Two packages can want the same label: `services/rest` and `packages/rest`,
 * or two directories that never set a `name`. A repeated label falls back to
 * the sanitized directory path, and a label that is still repeated gains a
 * counter. The caller gets one label per package, in the same order.
 */
export const uniqueLabels = (packages: ReadonlyArray<DiscoveredPackage>): ReadonlyArray<string> => {
	const preferred = packages.map(packageLabel);
	const counts = new Map<string, number>();
	for (const label of preferred) counts.set(label, (counts.get(label) ?? 0) + 1);

	const used = new Set<string>();
	return packages.map((pkg, index) => {
		const first = preferred[index] ?? "root";
		const fallback = sanitize(pkg.rel === "." ? "root" : pkg.rel);
		let label = counts.get(first) === 1 ? first : fallback;
		if (label === "") label = "root";
		if (!used.has(label)) {
			used.add(label);
			return label;
		}
		let counter = 2;
		while (used.has(`${label}_${counter}`)) counter += 1;
		const unique = `${label}_${counter}`;
		used.add(unique);
		return unique;
	});
};

/**
 * Bind every script to a tool name.
 *
 * Only the root package may take the short `run_<script>` name, because that
 * is the name an agent guesses first and it must mean one thing: `run_build` is
 * the build at the top of the repository, or it is nothing. Every nested package
 * is named after itself from the start.
 *
 * The alternative -- first come, first served -- makes a name depend on which
 * package happens to sort first, so adding or removing a package silently
 * renames another one's tool. A name an agent learned in one session and a name
 * a Fabric roster lists must not move for a reason that has nothing to do with
 * them.
 *
 * A label that is already in use, by another extension or by a package whose
 * label collided, gains a counter as the last resort.
 */
export const planTools = (
	packages: ReadonlyArray<DiscoveredPackage>,
	labels: ReadonlyArray<string>,
	taken: ReadonlySet<string>,
): ReadonlyArray<PlannedTool> => {
	const used = new Set(taken);
	const planned: PlannedTool[] = [];
	packages.forEach((pkg, index) => {
		const label = labels[index] ?? "root";
		for (const script of pkg.scripts) {
			const base = sanitize(script.name) || "script";
			const qualified = `run_${label}_${base}`;
			let name = qualified;
			if (pkg.rel === "." && !used.has(`run_${base}`)) name = `run_${base}`;
			if (used.has(name)) {
				let counter = 2;
				while (used.has(`${qualified}_${counter}`)) counter += 1;
				name = `${qualified}_${counter}`;
			}
			used.add(name);
			planned.push({ name, label: `${label}:${script.name}`, pkg, script });
		}
	});
	return planned;
};
