import { watch } from "node:fs";
import { existsSync } from "node:fs";
import { exitWhenUninstalled } from "jive-template-library";
import { loadConfig, loadState, saveState } from "../internal/config";
import { notify } from "../internal/notify";
import { syncOnce } from "../internal/sync";

/**
 * Keeps this machine's skills directory identical to every other machine's.
 *
 * Polls rather than subscribes: 30 seconds of latency on a file you edit a few times a day is not worth
 * a durable connection, and a poll recovers from a dropped network by itself. A local change does not
 * wait for the next poll — the watcher below brings the next cycle forward.
 */

const POLL_INTERVAL_MS = 30_000;
/** Long enough that an editor's write-rename-write lands as one cycle, short enough to feel immediate. */
const SETTLE_MS = 1_000;

exitWhenUninstalled();

const loaded = loadConfig();
if (!loaded.ok) {
  console.error(`skill-sync is not configured: ${loaded.reason}`);
  // Zero, not one: the service manager restarts a daemon that fails, and retrying every few seconds
  // against a config nobody has filled in yet would just fill the log.
  process.exit(0);
}
const config = loaded.config;

const state = loadState();
let cycleQueued = false;
let running = false;

/**
 * Conflicts already reported to the desktop.
 *
 * A conflict persists until a human resolves it, so every cycle keeps finding it — notifying each time
 * would put a popup on screen twice a minute until they gave up and turned notifications off, which
 * costs them the one notification that mattered. Only newly-conflicting paths are announced, and a path
 * drops out of the set once it stops conflicting so a later recurrence is announced again.
 *
 * Held in memory, not in the state file: a restart re-announcing an unresolved conflict is correct.
 */
const announced = new Set<string>();

function announceConflicts(conflicts: ReadonlyArray<string>): void {
  for (const path of [...announced]) {
    if (!conflicts.includes(path)) announced.delete(path);
  }

  const fresh = conflicts.filter((path) => !announced.has(path));
  if (fresh.length === 0) return;
  for (const path of fresh) announced.add(path);

  notify(
    "Skill sync conflict",
    fresh.length === 1
      ? `${fresh[0]} changed on two machines. Your version is saved as ${fresh[0]}.local`
      : `${fresh.length} skills changed on two machines. Your versions are saved alongside them as .local`,
  );
}

async function runCycle(): Promise<void> {
  if (running) {
    cycleQueued = true;
    return;
  }
  running = true;
  try {
    const report = await syncOnce(config, state);
    saveState(state);

    for (const path of report.pulled) console.log(`pulled ${path}`);
    for (const path of report.pushed) console.log(`pushed ${path}`);
    for (const path of report.deletedLocally) console.log(`deleted ${path}`);
    for (const path of report.conflicts) {
      console.error(`conflict on ${path} — another machine changed it too; your copy is at ${path}.local`);
    }
    for (const path of report.rejected) console.error(`refused a path the server sent: ${path}`);
    announceConflicts(report.conflicts);
  } catch (cause) {
    // One failed cycle must not end the daemon: the usual cause is the network, and the next poll retries.
    console.error(`sync failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  } finally {
    running = false;
    if (cycleQueued) {
      cycleQueued = false;
      setTimeout(runCycle, SETTLE_MS);
    }
  }
}

if (existsSync(config.skillsDir)) {
  let settle: ReturnType<typeof setTimeout> | undefined;
  watch(config.skillsDir, { recursive: true }, () => {
    if (settle !== undefined) clearTimeout(settle);
    settle = setTimeout(runCycle, SETTLE_MS);
  });
}

console.log(`watching ${config.skillsDir}, syncing with ${config.endpoint} as ${config.machine}`);
await runCycle();
setInterval(runCycle, POLL_INTERVAL_MS);
