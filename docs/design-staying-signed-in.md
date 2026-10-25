# Design: keeping a machine signed in through restarts

Decided 2026-10-25: option 1, built in 0.4.4. Alex: "let's just have the file token for now. long term Jive will
replace this whole toolset and workflow anyway." The problem below describes 0.4.3 and earlier.

## Problem

The daemon keeps its sign-in token only in memory (`src/daemons/skill-sync-daemon.ts:25`). Any restart signs the
machine out: an upgrade, a reboot, a crash, or a stray kill. Signing back in needs a person at that machine
(`skill-sync login`, then a passkey). With four machines and frequent releases, that's a chore after every release,
and automatic updates wouldn't help, because each update restarts the daemon.

Goal: a machine stays signed in through every kind of restart, on macOS, Linux and Windows, with nothing for you to
do. You've ruled out setting owner-only file permissions because that's complex and brittle.

## Options

### 1. Save the token in a plain file in `~/.jive` (recommended)

The daemon writes the token to `~/.jive/skill-sync-token.json` at sign-in, reads it at startup, and deletes it at
sign-out or when the server rejects it. Nothing OS-specific: it's an ordinary file, like `~/.jive/skill-sync.json`
today.

- Gains: survives every restart, including reboots and crashes. It's a few lines of code, the same on every OS, and
  automatic updates then need nothing from you.
- Costs: anything running as your account can read the token. So can other accounts on the same machine, because new
  files are readable by everyone by default (umask `022` on rose; `~/.jive/skill-sync.json` is `-rw-r--r--`). On a
  machine where you're the only user, that adds nobody. A leaked token gives sync access to your skills, and you can
  revoke it from the dashboard.
- Rules out: nothing. You can add a password store (option 3) later without changing the rest.
- If the assumption is wrong (a shared machine), another user there could sync as you until you revoke the token.

### 2. Keep memory only, and pass the token along during upgrades

On upgrade, the new daemon asks the old one for the token over the local socket before the old one exits.

- Gains: no secret is ever written to disk.
- Costs: only upgrades are covered. Reboots and crashes still sign the machine out. The handoff adds a step that can
  fail midway and has to be tested on every OS.
- Rules out: unattended reboots, which is most of the problem.

### 3. Store the token in the OS password store

That means Keychain on macOS, Credential Manager on Windows, and the Secret Service on Linux.

- Gains: the OS guards the token, and other programs may need your approval to read it.
- Costs: three separate implementations. Headless Linux machines often have no Secret Service running, so it would
  fail there or need a fallback, which brings back option 1. You set this aside on 2026-10-22 because every Jive
  daemon feature has to work on every OS.

### 4. Approve a restarted machine from the dashboard

A restarted daemon appears on the dashboard as waiting for approval. One click in any signed-in browser, your phone
included, gives it a new token. The token stays in memory.

- Gains: no secret on disk, and no terminal needed on the machine.
- Costs: you still act after every restart, just from somewhere else. The dashboard has to tell a real restart from
  someone else's daemon claiming to be that machine, which takes a pairing code you can't see on a headless machine.
- Rules out: unattended upgrades and reboots.

### Considered and dropped

- **Owner-only file permissions**: you ruled this out.
- **Signing in with an existing SSH key through ssh-agent**: rose's agent holds no keys (`ssh-add -l`: "The agent
  has no identities"), so it can't be the mechanism everywhere.

## Recommendation

Option 1, because it's the only one that's simple, the same on every OS, and covers reboots and crashes. Option 2
leaves reboots unsolved. Option 3 is three implementations with a gap on Linux. Option 4 keeps the chore and only
moves it. After option 1, automatic updates need nothing from you.
