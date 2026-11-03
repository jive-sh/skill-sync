# @jive-sh/skill-sync

Keeps the skills you choose identical across every Claude, Codex and Grok skills folder on every machine
you work on.

A daemon finds each agent home on the machine (Claude's `~/.claude` and every `~/.claude-<name>`, Grok's
`~/.grok` and every `~/.grok-<name>` (each a `GROK_HOME`), and Codex's `~/.agents`, counted as soon as
either `~/.agents` or `~/.codex` exists; anything named `*.lock` is
another program's lock and is ignored, as a home and as a file or folder inside a skills folder) and syncs the `skills`
folder in each through a Cloudflare Worker: file index in D1, contents in R2 addressed by hash. `skill-sync login` asks the daemon to sign in and opens
`skill-sync.jive.sh` in your browser, where you verify with your jive.sh passkey (from any passkey
manager, such as Google Password Manager). The service hands a per-machine token straight to the daemon,
never through the CLI. The daemon keeps it in `~/.jive/skill-sync-token.json` and starts syncing, and it
stays signed in through restarts, reboots and upgrades until you run `skill-sync logout` or revoke the
token.

```
skill-sync login     sign this machine in with your passkey; the daemon starts syncing
skill-sync logout    revoke this machine's token and stop syncing
skill-sync list      list the skills that sync, as the server holds them (needs a sign-in)
skill-sync add <skill>  put a skill on the synced list, as ticking it on the dashboard does
skill-sync show <skill> print a synced skill's description and where its copies are on this machine
skill-sync upgrade   upgrade with the package manager that installed it
skill-sync version   print the installed version
```

Tab completes every command. After `show` it lists the synced skills and after `add` the skills in the
detected folders that `add` would accept and that are not synced yet, both asked of the daemon when Tab is
pressed. Tab never starts the daemon: when none is running, or it does not answer within 3 seconds, Tab shows why
instead. Installing or upgrading turns Tab completion on in your shell; `skill-sync --remove-completion` turns
it off.

Everything else — which folders sync, unticking skills, renaming computers — is on the
dashboard.

## Adding a skill from an agent

An agent that writes a new skill meant for every project runs `skill-sync add <skill>` in the same step,
so nobody has to tick it. `<skill>` is the skill's folder name. Running it again changes nothing. It is
refused, with the reason, unless:

- the skill is in a folder skill-sync detects (above). A skill in a project's own `.claude/skills`,
  `.agents/skills` or `.grok/skills` is specific to that project and never syncs. That is the only sign of
  a project-specific skill skill-sync can read; one written into a home folder but about one project is
  not caught.
- its `SKILL.md` starts with frontmatter whose `name` is the folder name and whose `description` is not
  empty.
- the name is lowercase letters and digits in hyphen-joined words, at most 64 characters.

The skill's files upload from the folders holding it that are ticked on the dashboard; if none is, the
command says so.

The daemon registers itself to start at login when the package is installed. It also keeps skill-sync up
to date: every 5 minutes it asks the package manager that installed it (bun, pnpm, yarn or npm, with that
manager's own registry settings) whether a newer version is published, installs it the same way, and
restarts on it, still signed in. `skill-sync upgrade` does the same at once.

## The dashboard

`https://skill-sync.jive.sh/` shows, live, the latest version published on npm, and:

- **Accounts**: a table with one row per Claude, Codex and Grok account on the running computers.
  An account its tool can name (Claude's organization, Codex's email) is one row however many computers use
  it. Each limit gets a column with the share used and the time to its reset; then each computer's own use of
  the account over the last 30 days, and when the limits were read. See [Account usage](#account-usage).
- **Synced skills**: the list, with the shared version of each skill and where it was last edited.
- **Computers**: each machine (renameable), whether its daemon is running and which version it runs, its
  skills folders, and the skills in each with their files. A daemon older than the published version is
  marked "update pending"; it upgrades itself within 5 minutes.

Every file shows the first 8 characters of its SHA-256, amber when a folder's copy differs from the synced
one. The page reloads itself when a new version of the service is deployed.

The server holds one list of skills to sync. Every enabled folder on every machine pushes and pulls
exactly the skills on that list, and never touches any other skill. A skill's checkbox adds it to the
list or removes it, for every machine at once. A folder's checkbox turns syncing on or off for that
folder; a folder seen for the first time starts off, so nothing is written into a folder until you tick it. Both are stored on the server, so they apply at once
and survive a reinstall.

A folder that lacks a listed skill gets a copy. Deleting a listed skill in any folder deletes it in every
folder and takes it off the list; unticking it instead stops syncing and leaves every copy where it is.

## The latest edit wins

Every file carries the time it was last edited: on a machine, its modification time; on the server, the
edit time of the version it holds. Whenever two copies of a file differ, the one edited later replaces
the other, on the server and in every folder. Nothing is merged and nothing is set aside. A deletion
counts as an edit made when the daemon noticed it.

Edit times come from each machine's clock, so a machine whose clock is far off can win or lose against
edits it should not.

## Account usage

An account is a folder in your home directory: `~/.claude` and each `~/.claude-<name>` for Claude (each a
`CLAUDE_CONFIG_DIR`), `~/.codex` and each `~/.codex-<name>` for Codex (each a `CODEX_HOME`), `~/.grok` and each
`~/.grok-<name>` for Grok (each a `GROK_HOME`). The daemon reads two things about each, and sends them to the
dashboard when they change.

**The account's limits**, which its provider counts across every computer. The daemon asks the tool's own CLI,
at most every five minutes per account. The CLI is signed in to the account and makes the call; skill-sync
reads no credential file, and only the numbers and the account's email leave the machine.

- **Claude**: `claude auth status` (who is signed in) and `claude -p /usage --no-session-persistence` (the
  session, weekly and per-model weekly limits). Neither starts a model turn, and the second saves no session.
  Usage credits spent beyond the plan are not in `/usage`'s output, so they show only when the CLI could not be
  asked (below).
- **Codex**: `codex app-server`, the JSON-RPC interface Codex's editors and desktop app use: `account/read` and
  `account/rateLimits/read`.
- **Grok**: `grok agent stdio`, asked `_x.ai/billing`, the request Grok's own `/usage` screen makes. Grok has no
  command that says who is signed in, so its accounts show as unidentified.

The daemon runs with the service manager's PATH, not your shell's, so it looks for `claude` and `codex` on PATH,
then in the folders installers put them in (`~/.local/bin`, `~/.bun/bin`, npm's and nvm's global folders,
Homebrew's), then, for Codex, inside the ChatGPT and Codex desktop apps and Codex's editor extension (VS Code,
Cursor or Windsurf, locally or on a machine they reach over SSH), which each ship one. When a CLI is not found
or fails, the limits are what the tool last recorded on this machine, and the dashboard's hover on their age
says so and why: for Claude, the plan usage it keeps in the account's `.claude.json`; for Codex, the limits it
recorded with its latest turn in its session files. Those are as old as the tool's last use of the account. An
account using Amazon Bedrock or an API key has no plan limits.

**This machine's use** of the account over the last 30 days, from the files the tool writes:

- **Claude**: Claude Code's own estimate of each session's cost at list price, which it saves in the session's
  file under `projects/` when the session ends, is cleared, resumed or forked, summed over sessions active in
  the period (Claude Code deletes older session files by default). A running session counts as of its last
  save, and your provider's bill can differ from list price. The row says Bedrock when the account's
  `settings.json` sets `CLAUDE_CODE_USE_BEDROCK` or `CLAUDE_CODE_USE_MANTLE` in its `env`, or its sessions used
  Bedrock model IDs.
- **Codex**: the tokens its sessions active in the period used, cached input included, from the running total
  Codex records in its session files.
- **Grok**: what `grok usage <session-id>` reports, summed over sessions active in the period. A session's
  totals include history it inherited by resume or fork, so a fork counts that part twice.

A limit whose reset time has passed since the reading shows no number, since the new window's use is not known
yet. None of these outputs is a published format: when a tool changes one, the row says "unknown" and why,
rather than showing a wrong number. Daemons before 0.5.0 send usage in a shape the dashboard no longer takes,
so their accounts are not shown until they upgrade themselves.

## Configuration

`~/.jive/skill-sync.json` holds the endpoint and the machine name, written on first run.
`~/.jive/skill-sync-token.json` holds this machine's token while it is signed in. It is an ordinary file,
so anything that can read your home directory can copy the token; signing out, or the server rejecting the
token, deletes it. The CLI reaches the daemon over `~/.jive/skill-sync.sock` (a named pipe on Windows),
which only your user can open.
