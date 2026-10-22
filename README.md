# @jive-sh/skill-sync

Keeps the skills you choose identical across every Claude folder on every machine you work on.

A daemon finds each Claude home on the machine (`~/.claude` and every `~/.claude-<name>`) and syncs the
`skills` folder in each through a Cloudflare Worker: file index in D1, contents in R2 addressed by hash.
`skill-sync login` opens `skill-sync.jive.sh` in your browser, where you verify with your jive.sh passkey
(from any passkey manager, such as Google Password Manager); the service then hands the CLI a per-machine
token and opens the dashboard. The CLI never handles the passkey.

```
skill-sync login     verify with your passkey in the browser and store this machine's token
skill-sync status    which folders and skills this machine syncs, and which stay local
skill-sync sync      run one cycle now
skill-sync logout    revoke this machine's token
```

The daemon registers itself to start at login when the package is installed.

## The dashboard

`https://skill-sync.jive.sh/` shows, live:

- **Synced skills**: the shared version of every skill that syncs, and who changed it last.
- **Reconciliation log**: every merge Claude made — which computer, which folder and file, what
  conflicted and how it was resolved — so you can audit them.
- **Computers**: each machine, whether its daemon is running, its Claude folders, and the skills in each
  with their files.

Each folder and each skill has a checkbox. An unchecked folder does not sync at all; an unchecked skill
stays local to its folder — never sent, never overwritten. Choices are stored on the server, so they apply
at once and survive a reinstall. Defaults: a new folder syncs; a skill already synced there stays synced;
a skill that exists only in one folder stays local until you check it; a shared skill a folder does not
have yet is delivered to it.

## Conflicts

Every write is a compare-and-swap on the file's current hash, so a change made in two places at once is
never silently overwritten. When a file changed both locally and on the server — or a folder opts into a
skill it already has a different copy of — the daemon asks Claude, with no tools, to merge the two (using
the last agreed version when there is one), writes the merge, pushes it, and logs the explanation to the
dashboard. Both versions are copied first to `~/.jive/skill-sync/reconciled/`.

If Claude is unavailable or the merge looks truncated, the server's version is kept and yours is saved
beside it as `<file>.local`, with a desktop notification and a "needs attention" state on the dashboard.

## Configuration

`~/.jive/skill-sync.json` holds the endpoint and the machine name, written on first run.
`~/.skill-sync-token.json` holds the token alone, at mode 0600, written by `skill-sync login` rather than
by hand. Merges run under the machine's default `claude` login.
