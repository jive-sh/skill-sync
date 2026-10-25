# Lacking durable workflows

Things an agent or a person still does by hand that a durable workflow should do. skill-sync is expected to
grow into agentic-sync, so the list lives here. Add an entry whenever something is done by hand; remove it in
the commit that builds the workflow.

Each entry: what is done by hand, what should replace it, and where that belongs.

## Agent guards run only as prose rules
- **By hand:** rules such as "quote his question before answering", "stay within the reply length cap" and
  "back every claim with a tool result" live only as text in synced skills, so they hold only when an agent
  rereads and obeys them.
- **Should be:** checks that run on every reply (hooks), synced to every machine the way skills are.
- **Belongs in:** skill-sync (agentic-sync), syncing hooks alongside skills.

## Cross-OS tests for daemons and auto-upgrade
- **By hand:** auto-upgrade (jive-abstract-library 0.1.8) was verified once by hand on macOS under launchd and
  in a Docker systemd container; Windows was never run. A package's CI runs on the one machine type its
  `jive.cicd.runsOn` names.
- **Should be:** CI that builds and tests a package on each OS it supports, only when that package changed.
- **Belongs in:** the Jive CI/CD contract and shared pipeline (jive-sh/jive), as a list of machine types to
  test on. Needs Alex's approval: it changes the pipeline every Jive package shares.

## Waiting for npm to serve a release
- **By hand:** after CI publishes, an agent polls every platform tarball URL with curl until npm serves it,
  before building a dependent on the new version.
- **Should be:** the release pipeline finishes only once npm serves every platform tarball of the version.
- **Belongs in:** jive-abstract-library's deployer.

## First upgrade to a self-updating skill-sync
- **By hand:** machines on skill-sync 0.4.4 or older must run `skill-sync upgrade` once; only 0.4.5 and later
  upgrade themselves.
- **Should be:** nothing further once every machine is on 0.4.5. No workflow can reach the older versions.
- **Belongs in:** this list until each machine has upgraded.

## Signing agent socket moves between ozy-cli versions
- **By hand:** after a reboot, git commit signing and GitHub pushes failed because git's `gpg.ssh.program` and
  `~/.ssh/config`'s `IdentityAgent` pointed at the socket path of the globally installed ozy-cli 0.4.9, while
  the running agent (the checkout's 0.5.0 build) listens at `~/.ozy/ozy-signing-agent.sock`. Worked around per
  command with `git -c gpg.ssh.program=…` and `-c core.sshCommand="ssh -o IdentityAgent=…"`.
- **Should be:** the installer that registers the signing agent also writes the git and SSH settings that
  point at it, so they cannot disagree.
- **Belongs in:** ozy-cli's install (and Jive's key handling, which is meant to move server-side).
