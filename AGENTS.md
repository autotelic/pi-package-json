# Working in this repository

A pi extension that turns every `package.json` script under the launch
directory into a pi tool. The entry is
`extensions/package-scripts/index.ts`; everything it needs is in the modules
beside it. The README is written for a user of the extension; this file is
written for an agent changing it.

## Run the checks

```sh
pnpm install
pnpm check      # oxlint, tsc --noEmit, vitest, joggle
```

All four must be clean. A disagreement with a rule is declared where the rule is
configured -- `oxlint.config.ts`'s `overrides`, `joggle.config.json`'s `ignore`
-- with the reason written down. It is never silenced in a code comment.

## The modules

The layers named in `joggle.config.json` are the import direction: kernel is
depended on by domain, domain by engine, engine by the entry. joggle reports a
file that is in no layer, so a new file needs a home in that list.

| Module | What it owns |
|---|---|
| `index.ts` | The wiring: scan on session start, register, mark a failed call, serve `/packages`. |
| `discover.ts` | What is in the repository, and what the repository declares about itself. |
| `naming.ts` | How a script becomes a tool name. |
| `ignore.ts` | The repository's own ignore files. |
| `tool.ts` | The tool surface: schema, descriptions, execution. |
| `report.ts` | The `/packages` report and the starter configuration. |
| `revision.ts` | Which copy of the extension a session is running. |
| `config.ts` | What a repository declares, and how it is read. |
| `exec.ts` | Starting a script, stopping it, and keeping its output. |
| `details.ts` | The structured half of a tool result. |
| `delegate.ts` | A root script that only calls a nested one. |
| `schema.ts` | Decoding the JSON that crosses the boundary. |
| `types.ts` | The vocabulary the other modules share. |

## Load it while you work

```sh
pi -e /absolute/path/to/pi-package-json --no-extensions
```

`--no-extensions` matters. A global install and the `-e` copy both register
tools for the same directory, and the second renames rather than collides, so
the roster fills with `run_hello` and `run_root_hello`.

A running session keeps the code it loaded at `session_start`, so `pi update`
changes the checkout without changing what the session calls. `/packages` says
which revision it is running and warns when the source has moved on. To test an
edit, start a new pi.

## Invariants that are easy to break

**No shell.** A command is a program and an argv array. Only npm receives a `--`
separator before extra arguments; pnpm passes a separator through to the script,
which is a bug that already shipped once.

**Do not guess at conventions.** The extension holds no list of directories a
project might use. `node_modules` and version-control metadata are another
tool's own state; everything else comes from the repository's ignore files and
`skipDirs`. A rule that is right in one repository is wrong in the next, and a
warning that is sometimes wrong teaches the reader to ignore warnings.

**Never shorten something silently.** A tool cap, a cut command, a cut result, a
skipped script and a refused script name are all reported. A caller that cannot
see what was left out cannot tell a complete answer from a partial one.

**State the bound on what a scan can prove.** `reads` lists names a command
refers to and does not assign, which is not the same as names it takes from the
environment, and the description says may rather than does.

**A block comment cannot contain a star-slash.** A pattern such as a glob ending
in a slash closes the comment, and the rest of the file becomes code. This has
already broken a build here.

**Comments say why.** The code says what. A comment that restates the line below
it is noise, and there is a rule that reports it.

## Tests

`tests/` mirrors the modules. The ignore matcher is measured against
`git check-ignore` rather than against a reading of its documentation, and the
naming rules have a case for every collision the design exists to prevent. Add
the case that would have caught the bug, not only the case that shows the fix.
