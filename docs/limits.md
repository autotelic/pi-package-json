# Limits

What the extension refuses to do, what it cannot do, and where the decisions it
does not make are made instead.

## What it will not do

The extension turns repository data into executable actions, so it is careful
about what it puts in that list and about what it claims about it.

**It does not label risk.** A tool reports facts it can prove: the command text,
the package, the directory, the environment names. It never infers danger from a
script's name. A name that means "destructive" in one repository means nothing
in the next, and a guess that is sometimes right is worse than no signal at all,
because it teaches the reader to trust a warning that is not there.

What it still gives you is the command text, which is the honest evidence. When
the command text is not enough -- a migration tool that reads its target from
the environment, where a status check and a rollback look identical -- the
repository says so with a `note`. See [configuration](configuration.md#notes).

**It runs no shell.** Every command is a program and an argv array. A script
name and every caller-supplied argument are single array elements, so neither
can become syntax. Extra arguments reach the script verbatim: measured on pnpm
12.3.4, `pnpm run show --filter other deploy` gives the script
`["--filter","other","deploy"]`, so a caller cannot smuggle the package
manager's own options through `args`.

**It refuses a script that looks like an option**, and reports it rather than
registering it.

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

**It bounds its own surface.** `maxTools` caps what one scan can add to a
prompt. A scan that reaches the cap says so; it never quietly returns fewer
tools than the repository has.

These tools run repository code with the same authority as the shell. Policy
belongs to Pi Fabric, which classifies captured tools and applies an approval
policy to them.

## Risk is declared in Fabric, not here

Fabric classifies every captured tool, and an extension tool with no override
gets the conservative `execute`. A repository that wants a read-only script and
a migration shown differently says so in Fabric's own configuration, keyed by
the tool name this extension registers -- and `/packages` prints those names:

```json
{
  "capture": {
    "risks": {
      "run_harness_report": "read",
      "run_tools_format": "write",
      "run_auth_start": "execute"
    }
  }
}
```

That is the honest split. The extension reports what it can prove -- the
command, the package, the directory, the environment names -- and Fabric owns
the policy. A `note` is the repository's own sentence about a script, and it
appears in the description before the command.

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

**A failed call loses its structured details under Fabric.** The extension
returns details with the exit code, the duration and the log path, and a
`tool_result` handler marks the call failed by reading them. Fabric turns a
failed nested call into a thrown error, which carries the message and not the
details, so a `fabric_exec` program that wants the exit code passes
`settle: true` -- or catches, and reads the log path out of the message.

**A configuration is all or nothing.** See
[configuration](configuration.md#the-configuration-file).
