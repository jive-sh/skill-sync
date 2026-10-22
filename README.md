# @jive-sh/skill-sync

Keeps one skills directory identical across every machine you work on.

A daemon watches the directory and syncs it through a Cloudflare Worker: file index in D1, contents in
R2 addressed by hash. `skill-sync login` opens `skill-sync.jive.sh` in your browser, where you verify
with your passkey (from any passkey manager, such as Google Password Manager); the service then hands the
CLI a per-machine token. The CLI never handles the passkey.

```
skill-sync login     verify with your passkey in the browser and store this machine's token
skill-sync status    what this machine syncs, and whether it can reach the service
skill-sync sync      run one cycle now
skill-sync logout    revoke this machine's token
```

The daemon registers itself to start at login when the package is installed.

## Conflicts

Every write is a compare-and-swap on the file's current hash, so a change made on two machines at once
is refused rather than silently overwritten. The losing side keeps its version beside the incoming one
as `<file>.local`, logs it, and raises a desktop notification. Nothing is ever lost to a race.

## Configuration

`~/.jive/skill-sync.json` holds the endpoint, the machine name and the directory to sync — all detected
on first run. `~/.skill-sync-token.json` holds the token alone, at mode 0600, written by `skill-sync
login` rather than by hand.
