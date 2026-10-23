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
skill-sync list      list the skills that sync, as the server holds them (needs a sign-in)
skill-sync upgrade   upgrade with the package manager that installed it
```

Everything else — which folders and skills sync, renaming computers — is on the
dashboard.

The daemon registers itself to start at login when the package is installed.

## The dashboard

`https://skill-sync.jive.sh/` shows, live:

- **Synced skills**: the list, with the shared version of each skill and where it was last edited.
- **Computers**: each machine (renameable), whether its daemon is running, its Claude folders, and the
  skills in each with their files.

Every file shows the first 8 characters of its SHA-256, amber when a folder's copy differs from the synced
one. The page reloads itself when a new version of the service is deployed.

The server holds one list of skills to sync. Every enabled folder on every machine pushes and pulls
exactly the skills on that list, and never touches any other skill. A skill's checkbox adds it to the
list or removes it, for every machine at once. A folder's checkbox turns syncing on or off for that
folder. Both are stored on the server, so they apply at once and survive a reinstall.

A folder that lacks a listed skill gets a copy. Deleting a listed skill in any folder deletes it in every
folder and takes it off the list; unticking it instead stops syncing and leaves every copy where it is.

## The latest edit wins

Every file carries the time it was last edited: on a machine, its modification time; on the server, the
edit time of the version it holds. Whenever two copies of a file differ, the one edited later replaces
the other, on the server and in every folder. Nothing is merged and nothing is set aside. A deletion
counts as an edit made when the daemon noticed it.

Edit times come from each machine's clock, so a machine whose clock is far off can win or lose against
edits it should not.

## Configuration

`~/.jive/skill-sync.json` holds the endpoint and the machine name, written on first run. Nothing secret is
stored on disk: the CLI reaches the daemon over `~/.jive/skill-sync.sock` (a named pipe on Windows), which
only your user can open, and the daemon deletes the `~/.skill-sync-token.json` older versions wrote.
