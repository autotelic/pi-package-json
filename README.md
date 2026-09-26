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

## What a tool looks like

A tool names the package it belongs to, the manager that runs it, and the
command it runs. The command is the evidence a caller decides with, so it is
shown in full up to 400 characters:

    Run the "test" script of services/service with pnpm, from that directory.
    Command: pnpm docker:test:up && mocha 'test/**/*.test.js' && pnpm docker:test:down
    The script refers to FILE, which may come from the environment. Set `env`
    only if the script expects them there.

A note, when the repository declares one, goes above the command, because it is
the part that says what the script does rather than what it runs.

and a result carries structured facts beside its message:

```jsonc
{
  "tool": "run_service_test",
  "package": "services/service",
  "scriptName": "test",
  "packageManager": "pnpm",
  "cwd": "/repo/services/service",
  "log": "/tmp/pi-package-scripts/1a2b3c/run_service_test-4.log",
  "outcome": "exited",
  "exitCode": 0,
  "durationMs": 1234
}
```

## Install

**Globally.** The extension is not about one repository -- it reads the
directory pi was launched in. One global install serves every monorepo on the
machine, and it works in each of them without a project-trust prompt.

```sh
pi install git:github.com/autotelic/pi-package-json
```

**From npm**, which is also how it reaches the [Pi package gallery](https://pi.dev/packages):

```sh
pi install npm:pi-package-json
```

**Per repository**, when a project should pin its own version. Add the package
to `.pi/settings.json` and commit it. Pi loads project packages only after you
grant project trust.

```sh
pi install -l git:github.com/autotelic/pi-package-json@v0.1.0
```

**For one run**, while you are working on the extension itself:

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

## Where to read next

| | |
|---|---|
| [Tool contract](docs/tool-contract.md) | How a name is chosen, the five parameters, the result shape, and the `/packages` command. |
| [Configuration](docs/configuration.md) | `package-scripts.json`, the repository's ignore files, notes, and background scripts. |
| [Limits](docs/limits.md) | What it will not do, what it cannot do, and where risk is declared. |
| [AGENTS.md](AGENTS.md) | For an agent working in this repository rather than with the extension. |

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
`joggle.config.json`'s `ignore`, each with the disagreement written down. This
repository declares none of the latter: every judged rule runs here, and the
candidates it raises are declined by the judgement rather than by a path glob.

joggle is an internal tool and is not published to npm. `pnpm joggle` runs the
installed `joggle` command -- the wrapper that supplies the model key from the
environment, `.env.local`, `.env`, or doppler. Install it once:

```sh
ln -sf /path/to/joggle/scripts/joggle.sh ~/.local/bin/joggle
```

That script names a path outside this repository, so it is a local-only
convenience and `prepublishOnly` deliberately does not call it.

`.joggle/answers.json` is committed on purpose, the same way the joggle
repository keeps its own. It records the verdicts the judged rules reached, so a
run with no model key -- a CI job, another developer's machine -- replays the
reviewed answers instead of leaving those rules unasked. Nothing else under
`.joggle/` is tracked.

A run with neither a key nor a cached answer counts what it could not judge
rather than printing every candidate. That is what `"unavailable": "count"` in
`joggle.config.json` is for.

## Publishing

The gallery lists what npm lists: an npm package carrying the `pi-package`
keyword. There is nothing to apply for.

```sh
npm login
npm publish
```

`prepublishOnly` runs lint, typecheck and test first, so a broken revision
cannot reach the registry. A version, once published, cannot be taken back.
