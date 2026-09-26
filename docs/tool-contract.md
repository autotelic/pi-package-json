# Tool contract

How a script becomes a tool name, what a caller may pass, what comes back, and
what `/packages` prints.

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
becomes a single underscore, so `test:math:coverage` becomes
`run_test_math_coverage`.

A script whose name begins with `-` is refused and reported. A package manager
parses its own options before the script name, so a script called `--help` would
print the manager's help instead of running.

## Parameters

Every tool takes the same five parameters.

| Parameter | Meaning |
|---|---|
| `args` | Extra arguments for the script. pnpm, yarn and bun receive them directly. npm receives them after a `--` separator, which the extension adds for npm alone -- pnpm passes a separator through to the script, so the script would receive a literal `--`. |
| `env` | Extra environment variables. The description names the ones the script refers to and does not assign. |
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
  "log": "/tmp/pi-package-scripts/1a2b3c/run_service_build-2.log",
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
is capped at 8 MiB, and the file is not. Each call gets its own log path, because
two detached runs of one script would otherwise truncate each other. A cut or
failed message names the path.

The command text is shown in the description up to 400 characters. A longer one
keeps both ends and says how many characters went, because the front names the
program and the back names the environment and the target.

## The `/packages` command

`/packages` lists the packages that were found and how many scripts each one
contributed. `/packages build` lists the tools whose name or script matches,
`/packages reload` scans again after you add a script or a package, and
`/packages init` writes a starter configuration.

The report ends with the extension's own name, version and path, so a reader can
name the revision they are looking at. When the source on disk has changed since
the session loaded it, the report says so at the top: a session keeps the code it
loaded at `session_start`, and `pi update` alone does not change what a running
session calls.

A root script that only calls a nested one is an alias for it, so the report
names the target rather than leaving two names for one action:

    run_db_migrate -> . - db:migrate  (delegates to run_db_knex_migrate)
    run_db_knex_migrate -> services/db - knex:migrate
