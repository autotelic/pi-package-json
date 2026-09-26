# pi-package-json

Every `package.json` script in your repository, as a pi tool.

Start pi in a monorepo and this extension scans the directory you launched it
from, skips `node_modules` and every dot-directory, and registers one pi tool
for each script it finds. A tool runs its script through the package manager
that owns the package, with that package directory as the working directory.

## Why

An agent already has `pi.bash`. What it does not have is the answer to "which
directory holds the REST service, which package manager does this workspace
use, and does the test script need a database container first?". Those are
facts about the repository, and they should not have to be rediscovered -- or
guessed -- on every run.

    run_rest_test        the "test" script of services/rest, with pnpm, in that directory
    run_lint             the "lint" script at the top of the repository
    run_ui_test_coverage the "test:coverage" script of services/ui

## How the tools are named

The root package may take the short name: `run_lint` is the root's `lint`
script, or there is no `run_lint`. Every nested package is named after itself
from the start: `run_rest_build`, `run_ui_test`.

Only the root may use a short name because a name has to mean one thing.
The alternative -- first come, first served -- makes a name depend on which
package happens to sort first, so adding or removing a package renames another
package's tool. A name an agent learned in one session, and a name a Fabric
roster lists, must not move for a reason that has nothing to do with them.

Script names are lowercased and every character that is not a letter or a digit
becomes a single underscore, so `test:math:coverage` becomes
`run_rest_test_math_coverage`.

## Parameters

Every tool takes the same four parameters.

| Parameter | Meaning |
|---|---|
| `args` | Extra arguments for the script, appended after `--` so the package manager forwards them. |
| `env` | Extra environment variables. The description names the ones the script reads. |
| `timeout` | Seconds before the script is killed. Default 300, largest 3600. |
| `background` | Start the script detached and return at once with a pid and a log path. Use it for servers and watchers. |

A script that exits non-zero fails the tool call, with its output in the error.
The complete output of every run is also written to a log file under the system
temporary directory, and a cut result names that path.

## Configuration

Put `package-scripts.json` at the repository root, or
`.pi/package-scripts.json` to keep it out of the way. The second wins field by
field over the first, which wins over the defaults.

```json
{
  "skipDirs": ["fixtures", "examples"],
  "excludeScripts": ["watch", "dev*", "prepare"],
  "includeScripts": [],
  "manager": "pnpm",
  "maxDepth": 8,
  "timeoutSeconds": 300
}
```

| Field | Default | Meaning |
|---|---|---|
| `skipDirs` | `[]` | Directory names the scan must not enter, on top of the built-in list and every dot-directory. |
| `excludeScripts` | `[]` | Script names to leave out. `*` matches any run of characters. |
| `includeScripts` | `[]` | When not empty, only scripts that match are kept. |
| `manager` | detected | Force a package manager instead of detecting one. |
| `maxDepth` | `8` | Directory levels below the launch directory to scan. |
| `timeoutSeconds` | `300` | Default seconds before a script is killed. |

The package manager is read from the nearest `packageManager` field, then from
a lockfile, then from the workspace root. A package that declares its own
`packageManager` keeps it.

## The `/packages` command

`/packages` lists the packages that were found and how many scripts each one
contributed. `/packages build` lists the tools whose name or script matches,
and `/packages reload` scans again after you add a script or a package.

## Install

**Globally.** The extension is not about one repository -- it reads the
directory pi was launched in. One global install serves every monorepo on the
machine, and it works in each of them without a project-trust prompt.

```sh
pi install git:github.com/autotelic/pi-package-json
```

**Per repository**, when a project should pin its own version. Add the package
to `.pi/settings.json` and commit it. Pi loads project packages only after you
grant project trust.

```sh
pi install -l git:github.com/autotelic/pi-package-json@v0.1.0
```

**For one run**, while you are working on the extension itself.

```sh
pi -e /absolute/path/to/pi-package-json
```

## Pi Fabric

Fabric captures these tools and takes them out of the model's active set. An
agent reaches one as `extensions.run_rest_test(...)` inside a `fabric_exec`
program, and the names-only roster in the prompt is the index:

```ts
const result = await extensions.run_rest_test({ env: { FILE: "payroll" } });
return result.text;
```

Because the roster is names only, a large monorepo costs prompt space in
proportion to the number of scripts. `excludeScripts` is the answer when that
matters.

## Development

```sh
pnpm install
pnpm check      # lint, typecheck, test, joggle
pnpm lint:fix
pnpm test
pnpm joggle
```

The lint ruleset is the Autotelic plumb generic set, registered in
`oxlint.config.ts`. Declared exceptions live in that file's `overrides` and in
`joggle.config.json`'s `ignore`, each with the disagreement written down.

joggle is an internal tool and is not published to npm. `pnpm joggle` runs it
from source next door; set `JOGGLE_ENTRY` if your checkout is not at
`../mess/src/main.ts`.

```sh
JOGGLE_ENTRY=/path/to/joggle/src/main.ts pnpm joggle
```
