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

**It skips `node_modules` and dot-directories, and nothing else by name.**
`node_modules` is not a project convention, it is the package manager's own
store: every dependency ships a `package.json`, and none of them is this
repository's code. `dist`, `build`, `vendor` and `target` are conventions of
particular languages and particular teams, so they are not assumed. Everything
else the repository declares in `skipDirs`.

**It stays under the launch directory.** The scan does not follow symbolic
links, so a link cannot pull in a package from outside the tree, and it cannot
loop. Every tool's working directory is a directory the scan visited.

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

## Parameters

Every tool takes the same four parameters.

| Parameter | Meaning |
|---|---|
| `args` | Extra arguments for the script. pnpm, yarn and bun receive them directly. npm receives them after a `--` separator, which the extension adds for npm alone -- pnpm passes a separator through to the script, so the script would receive a literal `--`. |
| `env` | Extra environment variables. The description names the ones the script reads. |
| `timeout` | Seconds before the script is killed. The default is the configured `timeoutSeconds`; the largest allowed value is 3600. |
| `background` | Start the script detached and return at once with a pid and a log path. Use it for servers and watchers, which do not exit. |

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

The complete output of every run is written to the log file, and a cut message
names that path.

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
`excludeScripts` and `maxTools` are the answers when that matters.

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
