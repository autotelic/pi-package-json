# pi-package-json

Every `package.json` script in your repository, as a pi tool.

Start pi in a monorepo and this extension scans the directory you launched it
from, and registers one pi tool for each script it finds. A tool runs its script
through the package manager that owns the package, with that package directory
as the working directory.

## Why

An agent already has `pi.bash`. What it does not have is the answer to "which
directory holds this service, which package manager does this workspace use, and
which script reads a file name out of the environment?". Those are facts about
the repository, and they should not have to be rediscovered -- or guessed -- on
every run.

    run_service_test    the "test" script of services/service, with pnpm, in that directory
    run_lint            the "lint" script at the top of the repository

## What it will not do

The extension turns repository data into executable actions, so it is careful
about what it puts in that list and about what it claims about it.

**It does not label risk.** A tool reports facts it can prove: the command text,
the package, the directory, the environment the script reads. It never infers
danger from a script's name. A name that means "destructive" in one repository
means nothing in the next, and a guess that is sometimes right is worse than no
signal at all, because it teaches the reader to trust a warning that is not
there.

What it still gives you is the command text, which is the honest evidence. When
the command text is not enough -- a migration tool that reads its target from
the environment, where a status check and a rollback look identical -- the
repository says so with a `note`. See [Notes](#notes).

**It runs no shell.** Every command is a program and an argv array. A script
name and every caller-supplied argument are single array elements, so neither
can become syntax. Extra arguments reach the script verbatim: measured on pnpm
12.3.4, `pnpm run show --filter other deploy` gives the script
`["--filter","other","deploy"]`, so a caller cannot smuggle the package
manager's own options through `args`.

**It refuses a script that looks like an option.** A manager parses its own
options before the script name, so a script named `--help` would print the
manager's help instead of running. Such a name is refused and reported rather
than registered.

**It does not guess which directories are the project's.** The built-in list
holds another tool's own state -- version-control metadata and package stores,
where every dependency ships a `package.json` and none of it is this
repository's code. Everything else comes from the repository itself: its
`.gitignore` files, and `skipDirs` for a directory that is not in version
control at all. `dist`, `build`, `vendor` and `target` are conventions of
particular languages and particular teams, so they are not assumed. A name that
is right in one repository is wrong in the next.

**It stays under the launch directory.** The scan does not follow symbolic
links, so a link cannot pull in a package from outside the tree, and it cannot
loop. Every tool's working directory is a directory the scan visited.

**It reads the repository's ignore files**, above the launch directory as well as
below it. See [Ignore files](#ignore-files).

**It bounds its own surface.** `maxTools` caps what one scan can add to a
prompt. A scan that reaches the cap says so; it never quietly returns fewer
tools than the repository has.

These tools run repository code with the same authority as the shell. Policy
belongs to Pi Fabric, which classifies captured tools and applies an approval
policy to them.

## How the tools are named

The root package may take the short name: `run_lint` is the root's `lint`
script, or there is no `run_lint`. Every nested package is named after itself
from the start: `run_service_build`.

Two rules protect that.

**Only the root may take a short name.** First come, first served would make a
name depend on which package sorts first, so adding or removing a package would
rename another package's tool. A name an agent learned in one session, and a
name a Fabric roster lists, must not move for a reason that has nothing to do
with them.

**A root short name gives way to a nested label.** When `db` is the label of a
nested package, a root script named `db:migrate` cannot be `run_db_migrate`.
That would sit beside `run_db_build` from the nested package, and "`run_db_*` is
the database package" would be wrong for every root `db:*` script. The root tool
is `run_root_db_migrate` instead. A name means one thing, and a prefix is part
of a name.

Script names are lowercased and every character that is not a letter or a digit
becomes a single underscore, so `test:math:coverage` becomes `run_test_math_coverage`.

## Ignore files

A monorepo already says which directories are not part of it, and it says so in
`.gitignore`. That answer is better than any list this extension could ship, so
the scan reads it.

    .gitignore: dist/
    services/api/dist/package.json   not scanned
    vendor/loose/package.json        scanned, because nothing excludes it

What is honoured:

| Rule | Example |
|---|---|
| A bare name matches at any depth | `dist` catches `services/api/dist` |
| A leading or middle slash anchors to the declaring directory | `/build` catches `build`, not `packages/a/build` |
| A trailing slash means directories only | `dist/` |
| One star stops at a slash, two stars cross one | `packages/*/lib`, `**/generated` |
| `?` is one character, `[0-9]` is a range | `file?.ts`, `file[0-9].ts` |
| A later `!` re-includes | `*.log` then `!keep.log` |
| A nested file is relative to its own directory, and wins over the root | `services/web/.gitignore` |

`.git/info/exclude` is read from the repository root, as well as every
`.gitignore` between that root and the launch directory. Pi is often started
inside one package of a repository, and the file that says what the repository
is lives above that package. The walk stops at the repository root: without a
repository above the launch directory nothing is read, because a stray ignore
file in a home directory must not decide what a repository contains.

A manifest that an ignore file excludes is left out and **reported**, because a
package missing from the tool list has to be explainable. The directory itself
is still entered, since git ignores the file and not its neighbours.

Not honoured: the global `core.excludesFile`, which needs a `git config`
lookup, and a trailing space escaped with a backslash, because the line is
trimmed.

An ignored directory is pruned and never entered. That is what git does, and for
the same reason: git will not re-include a path whose parent is excluded. So a
negation can never resurrect anything inside an ignored directory, in this
extension or in git.

The matcher is measured against git itself. A test builds a fixture, writes an
ignore file, and compares every case against `git check-ignore`, so the answer
comes from the program that defines the format rather than from a reading of its
documentation.

Set `respectGitignore` to `false` to keep what the repository excludes.

## Parameters

Every tool takes the same five parameters.

| Parameter | Meaning |
|---|---|
| `args` | Extra arguments for the script. pnpm, yarn and bun receive them directly. npm receives them after a `--` separator, which the extension adds for npm alone -- pnpm passes a separator through to the script, so the script would receive a literal `--`. |
| `env` | Extra environment variables. The description names the ones the script reads. |
| `timeout` | Seconds before the script is stopped. The default is the configured `timeoutSeconds`; the largest allowed value is 3600. |
| `background` | Start the script detached and return at once with a pid and a log path. Use it for servers and watchers, which do not exit. |
| `settle` | Report a non-zero exit as a result rather than as a failed call. **A program that branches on an exit code must pass this.** Without it a failing script aborts the caller. |

A script that outlives its timeout is asked to stop with `SIGTERM`, and killed
with `SIGKILL` only after a five second grace period -- the same as a cancelled
call. A test script that brings up a database container brings it down on the
way out, and a kill that skips that leaves the container running.

## Results

A tool result carries structured `details` beside its message:

```jsonc
{
  "tool": "run_service_build",
  "package": "services/service",
  "scriptName": "build",
  "packageManager": "pnpm",
  "cwd": "/repo/services/service",
  "log": "/tmp/pi-package-scripts/1a2b3c/run_service_build.log",
  "outcome": "exited",
  "exitCode": 0,
  "durationMs": 1234
}
```

`outcome` is `exited`, `started` or `unavailable`. A script that exits non-zero
is reported as a failed tool call, and it keeps its exit code, its duration and
its log path. Several useful scripts -- a coverage gate, a lint gate, a format
check -- answer with a non-zero exit, and a caller that has to parse the exit
code out of prose is a caller that will get it wrong.

The complete output of every run is written to its log file as it arrives, so
the log holds everything even when the result does not: the fact the model reads
is capped, and the file is not. Each call gets its own log path, because two
detached runs of one script would otherwise truncate each other. A cut or failed
message names the path.

## Configuration

Put `package-scripts.json` at the repository root, or
`.pi/package-scripts.json` to keep it out of the way. The second wins field by
field over the first, which wins over the defaults.

```json
{
  "skipDirs": ["fixtures", "examples"],
  "excludeScripts": ["prepare"],
  "includeScripts": [],
  "backgroundScripts": ["dev", "dev:*", "*:watch"],
  "respectGitignore": true,
  "notes": {
    "migrate:*": "changes the schema of the database named by the environment",
    "deploy*": "changes shared infrastructure"
  },
  "manager": "pnpm",
  "maxDepth": 8,
  "timeoutSeconds": 300,
  "maxTools": 500
}
```

| Field | Default | Meaning |
|---|---|---|
| `skipDirs` | `[]` | Directory names the scan must not enter, on top of `node_modules` and every dot-directory. |
| `excludeScripts` | `[]` | Script names to leave out. `*` matches any run of characters. |
| `includeScripts` | `[]` | When not empty, only scripts that match are kept. |
| `backgroundScripts` | `[]` | Scripts that start detached unless the caller passes `background: false`. |
| `respectGitignore` | `true` | Leave alone what the repository's ignore files exclude. |
| `notes` | `{}` | Text added to a tool's description, keyed by script-name pattern. The first matching pattern wins. |
| `manager` | detected | Force a package manager instead of detecting one. |
| `maxDepth` | `8` | Directory levels below the launch directory to scan. |
| `timeoutSeconds` | `300` | Default seconds before a script is killed. |
| `maxTools` | `500` | The largest number of tools one scan will register. |

The package manager is read from the nearest `packageManager` field, then from
a lockfile, then from the workspace root. A package that declares its own
`packageManager` keeps it.

### Notes

A note is the repository's own statement about a script, and it is the only
kind of risk information this extension carries, because it is the only kind the
repository can prove.

Take a migration tool that reads its target from the environment. A status
check and a rollback have the same shape, and nothing in the command text
separates them:

    Run the "knex:status" script of services/db with pnpm, from that directory.
    Command: pnpm knex:run -- migrate:status

    Run the "knex:down" script of services/db with pnpm, from that directory.
    Command: pnpm knex:run -- migrate:rollback -all && pnpm knex:run -- migrate:down

With a note, they separate:

    Run the "knex:down" script of services/db with pnpm, from that directory.
    Note: changes the schema of the database named by the environment
    Command: pnpm knex:run -- migrate:rollback -all && pnpm knex:run -- migrate:down

The note goes above the command, because it is the part that says what the
script does.

### Background scripts

A watcher or a development server never exits. Without `backgroundScripts`, a
call to such a tool waits for the whole timeout and then reports a kill. With
it, the tool returns a pid and a log path at once.

## The `/packages` command

`/packages` lists the packages that were found and how many scripts each one
contributed. `/packages build` lists the tools whose name or script matches, and
`/packages reload` scans again after you add a script or a package.

The report ends with the extension's own name, version and path, so a reader can
name the revision they are looking at. When the source on disk has changed since
the session loaded it, the report says so at the top: a session keeps the code it
loaded at `session_start`, and `pi update` alone does not change what a running
session calls.

A root script that only calls a nested one is an alias for it, so the report
names the target rather than leaving two names for one action:

    run_db_migrate -> . - db:migrate  (delegates to run_db_knex_migrate)
    run_db_knex_migrate -> services/db - knex:migrate

## Known limits

**Two tools can share a resource with no coordination.** Two scripts that use
one Docker project, or one database, corrupt each other when an agent calls them
at the same time. The extension adds no lock, and it should not: a lock it
invented would be wrong for the scripts that are safe to overlap. Name the
shared resource in a note, and run those scripts one at a time.

**A parent script's timeout is not its children's.** A script that starts a
container, builds and then tests runs all three inside one timeout. Give it a
`timeout` large enough for the whole chain, or raise `timeoutSeconds` for the
repository.

**A large roster costs prompt space under Fabric.** Fabric lists captured tools
as a names-only roster, so the cost grows with the number of scripts.
`excludeScripts`, an ignore file and `maxTools` are the answers when that
matters.

**`/packages reload` cannot withdraw a tool.** Pi has no way to unregister one,
so a script removed from a `package.json` keeps its tool until pi restarts. A
rescan adds and renames; it does not subtract.

**A process tree is not killed on Windows.** There are no process groups to
signal there, so only the child is stopped and a script that started another
program can leave it behind. On macOS and Linux the whole group is signalled.

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

**From npm**, which is also how it reaches the [Pi package gallery](https://pi.dev/packages):

```sh
pi install npm:pi-package-json
```

**For one run**, while you are working on the extension itself.

```sh
pi -e /absolute/path/to/pi-package-json
```

Load the extension twice -- once installed and once with `-e` -- and both copies
register tools for the same directory. The second copy renames rather than
collides, so the roster reads `run_hello` and `run_root_hello`. Add
`--no-extensions` when you mean to load one copy.

## Pi Fabric

Fabric captures these tools and can take them out of the model's active set. An
agent then reaches one as `extensions.run_service_test(...)` inside a
`fabric_exec` program, and the names-only roster in the prompt is the index:

```ts
const result = await extensions.run_service_test({ env: { FILE: "payroll" } });
return result.text;
```

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

That script names a path outside this repository, so it is a local-only
convenience and `prepublishOnly` deliberately does not call it.

## Publishing

The gallery lists what npm lists: an npm package carrying the `pi-package`
keyword. There is nothing to apply for.

```sh
npm login
npm publish
```

`prepublishOnly` runs lint, typecheck and test first, so a broken revision
cannot reach the registry. A version, once published, cannot be taken back.
