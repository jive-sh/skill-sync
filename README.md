# @jive-sh/skill-sync

Keeps the skills you choose identical across every Claude folder on every machine you work on.

A daemon finds each Claude home on the machine (`~/.claude` and every `~/.claude-<name>`) and syncs the
`skills` folder in each through a Cloudflare Worker: file index in D1, contents in R2 addressed by hash.
`skill-sync login` asks the daemon to sign in and opens `skill-sync.jive.sh` in your browser, where you
verify with your jive.sh passkey (from any passkey manager, such as Google Password Manager). The service
hands a per-machine token straight to the daemon, which keeps it only in memory — never in a file, never
in the CLI — and starts syncing. After a reboot, a crash or an upgrade, run `skill-sync login` again.

```
skill-sync login     sign this machine in with your passkey; the daemon starts syncing
skill-sync logout    revoke this machine's token and stop syncing
skill-sync upgrade   upgrade with the package manager that installed it
```

Everything else — which folders and skills sync, renaming computers, the merge log — is on the
dashboard.

The daemon registers itself to start at login when the package is installed.

## The dashboard

`https://skill-sync.jive.sh/` shows, live:

- **Synced skills**: the list, with the shared version of each skill and who changed it last.
- **Reconciliation log**: every merge Claude made — which computer, which folder and file, what
  conflicted and how it was resolved — so you can audit them.
- **Computers**: each machine (renameable), whether its daemon is running, its Claude folders, and the
  skills in each with their files.

Every file shows the first 8 characters of its SHA-256, amber when a folder's copy differs from the synced
one. The page reloads itself when a new version of the service is deployed.

The server holds one list of skills to sync. Every enabled folder on every machine pushes and pulls
exactly the skills on that list, and never touches any other skill. A skill's checkbox adds it to the
list or removes it, for every machine at once. A folder's checkbox turns syncing on or off for that
folder. Both are stored on the server, so they apply at once and survive a reinstall.

A folder that lacks a listed skill gets a copy. A folder that has its own copy of a listed skill under
the same name has the two merged by Claude.

## Conflicts

Every write is a compare-and-swap on the file's current hash, so a change made in two places at once is
never silently overwritten. When a file changed both locally and on the server — or a skill added to the list
already exists in a folder as a different copy — the daemon asks Claude, with no tools, to merge the two (using
the last agreed version when there is one), writes the merge, pushes it, and logs the explanation to the
dashboard. Both versions are copied first to `~/.jive/skill-sync/reconciled/`.

If Claude is unavailable or the merge looks truncated, the server's version is kept and yours is saved
beside it as `<file>.local`, with a desktop notification and a "needs attention" state on the dashboard.

## Configuration

`~/.jive/skill-sync.json` holds the endpoint and the machine name, written on first run. Nothing secret is
stored on disk: the CLI reaches the daemon over `~/.jive/skill-sync.sock` (a named pipe on Windows), which
only your user can open, and the daemon deletes the `~/.skill-sync-token.json` older versions wrote. Merges
run under the Claude account of the folder being merged.
