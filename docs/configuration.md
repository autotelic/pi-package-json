# Configuration

What a repository can tell the extension, and the repository's own ignore files.

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
| A backslash escapes the next character | `\#notes`, `a\ b` |
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

## The configuration file

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
| `skipDirs` | `[]` | Directory names the scan must not enter, on top of `node_modules` and version-control metadata. Dot-directories are not skipped wholesale. |
| `excludeScripts` | `[]` | Script names to leave out. `*` matches any run of characters. |
| `includeScripts` | `[]` | When not empty, only scripts that match are kept. |
| `backgroundScripts` | `[]` | Scripts that start detached unless the caller passes `background: false`. |
| `respectGitignore` | `true` | Leave alone what the repository's ignore files exclude. |
| `notes` | `{}` | Text added to a tool's description, keyed by script-name pattern. The first non-empty match wins. |
| `manager` | detected | Force a package manager instead of detecting one. |
| `maxDepth` | `8` | Directory levels below the launch directory to scan. |
| `timeoutSeconds` | `300` | Default seconds before a script is stopped. |
| `maxTools` | `500` | The largest number of tools one scan will register. |

The package manager is read from the nearest `packageManager` field, then from
a lockfile, then from the workspace root. A package that declares its own
`packageManager` keeps it.

A configuration file is used whole or not at all: a setting with the wrong type
says the file was ignored, because a configuration that half applies is worse
than one that plainly does nothing. A setting the extension does not know is
named and the rest of the file is still used, because a misspelled key beside
four correct ones is a typo rather than a decision.

## Notes

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

`/packages init` writes a starter `package-scripts.json` naming every script it
found, with an empty note beside each. A repository with no configuration has no
place to record what its scripts do; that command gives it one.

### The environment hint is an upper bound

A shell reads a positional argument, a loop variable and a secret the same way
it reads the environment, and the `reads` line is a scanner's reading of a shell
string. It excludes names the command assigns for itself -- the left of an
assignment, the variable of a `for ... in` -- because a caller who sets one of
those sets something the script overwrites. Everything else it reports as
something the script *refers to*, and the wording says may rather than does.

When the hint and the script disagree, the command text is the authority.

## Background scripts

A watcher or a development server never exits. Without `backgroundScripts`, a
call to such a tool waits for the whole timeout and then reports a stop. With
it, the tool returns a pid and a log path at once.
