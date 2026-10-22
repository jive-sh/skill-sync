import { mkdirSync, watch, type FSWatcher } from "node:fs";
import { exitWhenUninstalled } from "jive-abstract-library";
import { detectFolders, loadConfig, loadStates, saveStates, stateFor } from "../internal/config";
import { authHeaders, describe, logReconciliations, register } from "../internal/folders";
import { notify } from "../internal/notify";
import { reconcile } from "../internal/reconcile";
import { isQuiet, syncOnce, type Report } from "../internal/sync";
import type { DaemonMessage, FolderPrefs, FolderState, HubToDaemon } from "../internal/wire";

/**
 * Keeps every enabled skills folder on this machine identical to every other machine's.
 *
 * Folders are detected (`~/.claude*` homes); which of them sync, and which skills in each, are
 * preferences held by the server and changed from the dashboard, so they survive a reinstall and apply
 * the moment they change. A skill not opted in stays local to its folder.
 *
 * The daemon holds a WebSocket to the service's hub. That connection is how the dashboard knows this
 * machine is running, how a preference change arrives, and how a write from another machine triggers a
 * cycle here at once. Polling stays as the fallback: every 5 minutes while connected, every 30 seconds
 * while not, so a dropped connection costs latency and never correctness.
 */

const POLL_CONNECTED_MS = 5 * 60_000;
const POLL_DISCONNECTED_MS = 30_000;
/** Long enough that an editor's write-rename-write lands as one cycle, short enough to feel immediate. */
const SETTLE_MS = 1_000;
const PING_MS = 30_000;
/** No pong for this long means the connection is dead even if the socket has not noticed. */
const PONG_TIMEOUT_MS = 75_000;
const RECONNECT_MIN_MS = 5_000;
const RECONNECT_MAX_MS = 5 * 60_000;

exitWhenUninstalled();

const loaded = loadConfig();
if (!loaded.ok) {
  console.error(`skill-sync is not configured: ${loaded.reason}`);
  // Zero, not one: the service manager restarts a daemon that fails, and retrying every few seconds
  // against a config nobody has filled in yet would just fill the log.
  process.exit(0);
}
const config = loaded.config;
const states = loadStates();

/** What was last registered, so registration is repeated only when a folder or skill appears or goes. */
let registered = "";
/** The folders to sync, each with the skills that sync there. */
let prefs = new Map<string, ReadonlySet<string>>();
const watchers = new Map<string, FSWatcher>();

// ── Folders ─────────────────────────────────────────────────────────────────────────────────────────

/** Reports this machine's folders and skills, and adopts the server's answer for what syncs. */
async function registerFolders(): Promise<void> {
  const request = describe(config, states);
  applyPrefs(await register(config, request));
  registered = JSON.stringify(request);
}

/** True when a folder or a skill has appeared or gone since the last registration. */
const registrationStale = (): boolean => JSON.stringify(describe(config, states)) !== registered;

function applyPrefs(folders: ReadonlyArray<FolderPrefs>): void {
  // Only folders this machine still has. The hub can hold a stale list — it answers a reconnect before
  // the next registration — and creating a listed folder whose Claude home is gone would bring it back.
  const present = new Set(detectFolders());
  const next = new Map(folders.filter((folder) => present.has(folder.path))
    .map((folder) => [folder.path, new Set(folder.skills)] as const));
  for (const [folder, watcher] of watchers) {
    if (!next.has(folder)) {
      watcher.close();
      watchers.delete(folder);
    }
  }
  for (const folder of next.keys()) {
    if (watchers.has(folder)) continue;
    mkdirSync(folder, { recursive: true });
    let settle: ReturnType<typeof setTimeout> | undefined;
    watchers.set(folder, watch(folder, { recursive: true }, () => {
      if (settle !== undefined) clearTimeout(settle);
      settle = setTimeout(runCycle, SETTLE_MS);
    }));
  }
  const changed = JSON.stringify([...next].map(([path, skills]) => [path, [...skills].sort()]))
    !== JSON.stringify([...prefs].map(([path, skills]) => [path, [...skills].sort()]));
  prefs = next;
  if (!changed) return;
  for (const [folder, skills] of prefs) console.log(`syncing ${folder}: ${[...skills].sort().join(", ") || "no skills"}`);
  if (prefs.size === 0) console.log("syncing no folders");
  void runCycle();
}

// ── Hub connection ──────────────────────────────────────────────────────────────────────────────────

let socket: WebSocket | undefined;
let lastPong = 0;
let reconnectDelay = RECONNECT_MIN_MS;
/** What the hub was last told about each folder (state and detail), so only changes are sent. */
const reported = new Map<string, string>();

function connect(): void {
  const url = `${config.endpoint.replace(/^http/, "ws")}/daemon`;
  // Bun's WebSocket takes headers; the browser's does not, which is why the token can travel this way.
  const ws = new WebSocket(url, { headers: authHeaders(config, {}) } as unknown as string[]);
  ws.onopen = () => {
    socket = ws;
    lastPong = Date.now();
    reconnectDelay = RECONNECT_MIN_MS;
    console.log("connected to the hub");
    // A previous run may have died mid-merge; whatever the hub last heard is stale until re-sent.
    reported.clear();
    for (const folder of prefs.keys()) report(folder, "idle");
  };
  ws.onmessage = (event) => {
    const data = String(event.data);
    if (data === "pong") {
      lastPong = Date.now();
      return;
    }
    const message = JSON.parse(data) as HubToDaemon;
    if (message.type === "prefs") applyPrefs(message.folders);
    if (message.type === "changed") void runCycle();
  };
  ws.onclose = () => {
    if (socket === ws) socket = undefined;
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  };
  ws.onerror = () => {
    // `onclose` follows and schedules the reconnect.
  };
}

setInterval(() => {
  if (socket === undefined) return;
  if (Date.now() - lastPong > PONG_TIMEOUT_MS) {
    console.error("hub connection went quiet; reconnecting");
    socket.close();
    return;
  }
  socket.send("ping");
}, PING_MS);

function report(folder: string, state: FolderState, detail?: string, activity?: string): void {
  const key = `${state}|${detail ?? ""}`;
  if (reported.get(folder) === key && activity === undefined) return;
  if (socket === undefined) return;
  const message: DaemonMessage = { type: "status", folder, state, detail, activity };
  socket.send(JSON.stringify(message));
  reported.set(folder, key);
}

// ── Sync cycles ─────────────────────────────────────────────────────────────────────────────────────

let running = false;
let cycleQueued = false;

/**
 * Conflicts already reported to the desktop.
 *
 * A conflict persists until a human resolves it, so every cycle keeps finding it — notifying each time
 * would put a popup on screen every cycle until they gave up and turned notifications off, which costs
 * them the one notification that mattered. Only newly-conflicting paths are announced, and a path drops
 * out of the set once it stops conflicting so a later recurrence is announced again.
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
      ? `${fresh[0]} changed on two machines and could not be merged. Your version is saved as ${fresh[0]}.local`
      : `${fresh.length} skills changed on two machines and could not be merged. Your versions are saved as .local`,
  );
}

function summarise(result: Report): string {
  const parts = [
    result.pulled.length > 0 ? `pulled ${result.pulled.join(", ")}` : "",
    result.pushed.length > 0 ? `pushed ${result.pushed.join(", ")}` : "",
    result.deletedLocally.length > 0 ? `deleted ${result.deletedLocally.join(", ")}` : "",
    result.merged.length > 0 ? `merged ${result.merged.join(", ")}` : "",
  ];
  return parts.filter(Boolean).join("; ");
}

async function runCycle(): Promise<void> {
  if (running) {
    cycleQueued = true;
    return;
  }
  running = true;
  const conflicts: string[] = [];
  try {
    // Folders sync one after another against the same server, so a change pushed from one folder is
    // pulled into the others on the follow-up pass this triggers.
    for (const [folder, skills] of [...prefs]) {
      try {
        const result = await syncOnce(config, folder, stateFor(states, folder), skills, {
          merge: reconcile,
          onMerging: (path) => {
            console.log(`${folder}: merging ${path} with Claude`);
            report(folder, "reconciling", path);
          },
        });
        saveStates(states);
        log(folder, result);
        if (result.reconciliations.length > 0) {
          await logReconciliations(config, result.reconciliations.map((entry) => ({ ...entry, folder })))
            .catch((cause) => console.error(`could not log a merge: ${cause instanceof Error ? cause.message : String(cause)}`));
        }
        conflicts.push(...result.conflicts.map((path) => `${folder}/${path}`));

        const problems = [...result.mergeFailures, ...result.conflicts.map((path) => `${path} kept as .local`), ...result.rejected];
        if (problems.length > 0) report(folder, "attention", problems.join("; "), summarise(result) || undefined);
        else report(folder, "idle", undefined, isQuiet(result) ? undefined : summarise(result));

        if (result.pushed.length > 0 || result.merged.length > 0 || result.retry) cycleQueued = true;
      } catch (cause) {
        // One failed folder must not end the daemon or the other folders: the usual cause is the network.
        const reason = cause instanceof Error ? cause.message : String(cause);
        console.error(`${folder}: sync failed: ${reason}`);
        report(folder, "attention", `sync failed: ${reason}`);
      }
    }
    announceConflicts(conflicts);
    // A skill created or removed locally changes what the dashboard should list.
    if (registrationStale()) await registerFolders().catch(() => undefined);
  } finally {
    running = false;
    if (cycleQueued) {
      cycleQueued = false;
      setTimeout(runCycle, SETTLE_MS);
    }
  }
}

function log(folder: string, result: Report): void {
  for (const path of result.pulled) console.log(`${folder}: pulled ${path}`);
  for (const path of result.pushed) console.log(`${folder}: pushed ${path}`);
  for (const path of result.deletedLocally) console.log(`${folder}: deleted ${path}`);
  for (const path of result.merged) console.log(`${folder}: merged ${path}`);
  for (const failure of result.mergeFailures) console.error(`${folder}: merge failed for ${failure}`);
  for (const path of result.conflicts) console.error(`${folder}: conflict on ${path}; your copy is at ${path}.local`);
  for (const path of result.rejected) console.error(`${folder}: refused a path the server sent: ${path}`);
}

/** Re-detects folders each poll: a Claude home created since the last one should join without a restart. */
async function poll(): Promise<void> {
  try {
    if (registered === "" || registrationStale()) await registerFolders();
  } catch (cause) {
    console.error(`could not register folders: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  await runCycle();
  setTimeout(poll, socket === undefined ? POLL_DISCONNECTED_MS : POLL_CONNECTED_MS);
}

console.log(`skill-sync daemon for ${config.machine}, syncing with ${config.endpoint}`);
connect();
await poll();
