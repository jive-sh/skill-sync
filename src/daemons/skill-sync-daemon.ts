import { existsSync, mkdirSync, rmSync, watch, type FSWatcher } from "node:fs";
import { createServer } from "node:http";
import { exitWhenUninstalled } from "jive-abstract-library";
import {
  LEGACY_TOKEN_PATH, detectFolders, loadSettings, loadStates, saveStates, stateFor, type Config,
} from "../internal/config";
import { serve, type ControlRequest, type Reply } from "../internal/control";
import { authHeaders, describe, register } from "../internal/folders";
import { isQuiet, syncOnce, type Report } from "../internal/sync";
import type { DaemonMessage, FolderPrefs, FolderState, HubToDaemon, ListSkillsResponse } from "../internal/wire";

/**
 * Keeps every enabled skills folder on this machine identical to every other machine's.
 *
 * Folders are detected: the `skills` folder in each `~/.claude*` home and Codex's `~/.agents/skills`
 * (see `detectFolders`). Which of them sync, and the one list of skills that syncs in all of them, are
 * held by the server and changed from the dashboard, so they survive a reinstall and apply the moment
 * they change. A skill not on the list is never pushed or pulled.
 *
 * The daemon holds a WebSocket to the service's hub. That connection is how the dashboard knows this
 * machine is running, how a preference change arrives, and how a write from another machine triggers a
 * cycle here at once. Polling stays as the fallback: every 5 minutes while connected, every 30 seconds
 * while not, so a dropped connection costs latency and never correctness.
 *
 * The sync token exists only in this process's memory. The daemon starts signed out and waits; `skill-sync
 * login` asks it, over the control socket, to sign in, and the token arrives from the browser straight to
 * this process. A restart means signing in again — the price of never writing the credential down.
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
/** How long a sign-in waits for the browser before giving up. */
const LOGIN_TIMEOUT_MS = 5 * 60_000;

exitWhenUninstalled();

// Versions before 0.3 wrote the token to a file. It is never read: a credential left on disk is one
// anything that can read the home directory can copy.
if (existsSync(LEGACY_TOKEN_PATH)) {
  rmSync(LEGACY_TOKEN_PATH, { force: true });
  console.log(`deleted ${LEGACY_TOKEN_PATH}; the token now lives only in this daemon's memory`);
}

const settings = loadSettings();
if (settings === undefined) {
  console.error("~/.jive/skill-sync.json needs an endpoint and a machine name");
  // Zero, not one: the service manager restarts a daemon that fails, and a file nobody has fixed would
  // only fill the log.
  process.exit(0);
}
const states = loadStates();

/** Set while signed in. Everything that talks to the server reads it; signing out clears it. */
let session: Config | undefined;
/** The signed-in config, for code that only runs during a session. */
function current(): Config {
  if (session === undefined) throw new Error("not signed in");
  return session;
}

/** What was last registered, so registration is repeated only when a folder or skill appears or goes. */
let registered = "";
/** The enabled folders, each with the synced list. */
let prefs = new Map<string, ReadonlySet<string>>();
const watchers = new Map<string, FSWatcher>();

// ── Folders ─────────────────────────────────────────────────────────────────────────────────────────

/** Reports this machine's folders and skills, and adopts the server's answer for what syncs. */
async function registerFolders(): Promise<void> {
  const request = describe(current());
  applyPrefs(await register(current(), request));
  registered = JSON.stringify(request);
}

/** True when a folder or a skill has appeared or gone since the last registration. */
const registrationStale = (): boolean => JSON.stringify(describe(current())) !== registered;

function applyPrefs(folders: ReadonlyArray<FolderPrefs>): void {
  // Only folders this machine still has. The hub can hold a stale list — it answers a reconnect before
  // the next registration — and creating a listed folder whose agent home is gone would bring it back.
  const present = new Set(detectFolders());
  const next = new Map(folders.filter((folder) => present.has(folder.path))
    .map((folder) => [folder.path, new Set(folder.skills)] as const));
  for (const [folder, watcher] of watchers) {
    if (!next.has(folder)) {
      watcher.close();
      watchers.delete(folder);
    }
  }
  // An unticked folder leaves no trace of syncing: its state goes, so the state file lists only folders
  // that sync, and ticking it again starts it fresh.
  // Covers folders with state from an earlier run too, not only ones this run was syncing.
  const stopped = [...new Set([...prefs.keys(), ...Object.keys(states)])].filter((folder) => !next.has(folder));
  for (const folder of stopped) {
    delete states[folder];
    console.log(`stopped syncing ${folder}`);
  }
  if (stopped.length > 0) saveStates(states);
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
  if (session === undefined) return;
  const config = session;
  const url = `${config.endpoint.replace(/^http/, "ws")}/daemon`;
  // Bun's WebSocket takes headers; the browser's does not, which is why the token can travel this way.
  const ws = new WebSocket(url, { headers: authHeaders(config, {}) } as unknown as string[]);
  ws.onopen = () => {
    socket = ws;
    lastPong = Date.now();
    reconnectDelay = RECONNECT_MIN_MS;
    console.log("connected to the hub");
    // Whatever the hub last heard from a previous connection is stale until re-sent.
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
    // Only the session that opened it reconnects: after a sign-out, or a sign-in with a new token, this
    // socket belongs to nobody.
    if (session !== config) return;
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

function summarise(result: Report): string {
  const parts = [
    result.pulled.length > 0 ? `pulled ${result.pulled.join(", ")}` : "",
    result.pushed.length > 0 ? `pushed ${result.pushed.join(", ")}` : "",
    result.deletedLocally.length > 0 ? `deleted ${result.deletedLocally.join(", ")}` : "",
  ];
  return parts.filter(Boolean).join("; ");
}

async function runCycle(): Promise<void> {
  if (session === undefined) return;
  if (running) {
    cycleQueued = true;
    return;
  }
  running = true;
  try {
    // Folders sync one after another against the same server, so a change pushed from one folder is
    // pulled into the others on the follow-up pass this triggers.
    for (const [folder, skills] of [...prefs]) {
      try {
        const result = await syncOnce(current(), folder, stateFor(states, folder), skills);
        saveStates(states);
        log(folder, result);
        if (result.rejected.length > 0) report(folder, "attention", result.rejected.join("; "), summarise(result) || undefined);
        else report(folder, "idle", undefined, isQuiet(result) ? undefined : summarise(result));
        // What this folder pushed is pulled into the machine's other folders on the follow-up pass.
        if (result.pushed.length > 0) cycleQueued = true;
      } catch (cause) {
        // One failed folder must not end the daemon or the other folders: the usual cause is the network.
        const reason = cause instanceof Error ? cause.message : String(cause);
        console.error(`${folder}: sync failed: ${reason}`);
        report(folder, "attention", `sync failed: ${reason}`);
      }
    }
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
  for (const path of result.rejected) console.error(`${folder}: refused a path the server sent: ${path}`);
}

let pollTimer: ReturnType<typeof setTimeout> | undefined;

/** Re-detects folders each poll: an agent home created since the last one should join without a restart. */
async function poll(): Promise<void> {
  if (session === undefined) return;
  try {
    if (registered === "" || registrationStale()) await registerFolders();
  } catch (cause) {
    console.error(`could not register folders: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  await runCycle();
  if (session !== undefined) pollTimer = setTimeout(poll, socket === undefined ? POLL_DISCONNECTED_MS : POLL_CONNECTED_MS);
}

// ── Signing in and out ──────────────────────────────────────────────────────────────────────────────

/**
 * Starts a session with a token from the browser. Registering this machine's folders is the first call
 * that needs the token, so it doubles as the check that the token works: a failure leaves the daemon
 * signed out, not half-running.
 */
async function signIn(token: string): Promise<void> {
  if (session !== undefined) await signOut();
  session = { ...settings!, token };
  try {
    await registerFolders();
  } catch (cause) {
    session = undefined;
    throw cause;
  }
  console.log(`signed in as ${session.machine}; syncing with ${session.endpoint}`);
  connect();
  void poll();
}

/** Revokes the token on the server, forgets it, and stops syncing. Returns whether the revoke succeeded. */
async function signOut(): Promise<boolean> {
  const config = session;
  if (config === undefined) return false;
  session = undefined;
  if (pollTimer !== undefined) clearTimeout(pollTimer);
  socket?.close();
  socket = undefined;
  for (const watcher of watchers.values()) watcher.close();
  watchers.clear();
  prefs = new Map();
  registered = "";
  // Revoked, not just forgotten: a token copied while it was live would otherwise keep working.
  const revoked = await fetch(`${config.endpoint}/cli/token`, { method: "DELETE", headers: authHeaders(config, {}) })
    .then((response) => response.ok, () => false);
  console.log(`signed out${revoked ? "" : " (the server could not be reached to revoke the token)"}`);
  return revoked;
}

let loginInProgress = false;

/**
 * One sign-in: listen on 127.0.0.1 for the browser to hand over the token, tell the CLI which URL to
 * open, and finish when the token arrives. The browser's login page posts to this listener only, never to
 * an address the request chose, so a page that tricks you into signing in cannot collect the token.
 */
function login(reply: Reply): void {
  if (loginInProgress) {
    reply.send({ type: "error", message: "a sign-in is already in progress" });
    return;
  }
  loginInProgress = true;
  const done = (): void => {
    loginInProgress = false;
    listener.close();
    clearTimeout(timer);
  };
  const listener = createServer((request, response) => {
    const token = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("token");
    response.writeHead(200, { "content-type": "text/html" });
    response.end(token ? "<p>Signed in. You can close this tab.</p>" : "<p>No token in the redirect.</p>");
    if (token === null) return;
    done();
    signIn(token).then(
      () => reply.send({ type: "signedIn", machine: settings!.machine }),
      (cause) => reply.send({ type: "error", message: `the server refused the sign-in: ${cause instanceof Error ? cause.message : String(cause)}` }),
    );
  });
  const timer = setTimeout(() => {
    done();
    reply.send({ type: "error", message: "timed out waiting for the browser" });
  }, LOGIN_TIMEOUT_MS);
  listener.listen(0, "127.0.0.1", () => {
    const port = (listener.address() as { port: number }).port;
    reply.send({ type: "open", url: `${settings!.endpoint}/cli/login?port=${port}&machine=${encodeURIComponent(settings!.machine)}` });
  });
}

/** The synced list, from the server: the CLI has no token to ask with, so it asks this daemon. */
function list(reply: Reply): void {
  const config = session;
  if (config === undefined) {
    reply.send({ type: "error", message: "this machine is signed out; run `skill-sync login` first" });
    return;
  }
  fetch(`${config.endpoint}/skills`, { headers: authHeaders(config, {}) })
    .then(async (response) => {
      if (!response.ok) throw new Error(`GET /skills: ${response.status} ${await response.text()}`);
      reply.send({ type: "list", skills: (await response.json() as ListSkillsResponse).skills });
    })
    .catch((cause: unknown) => reply.send({ type: "error", message: `could not reach the server: ${cause instanceof Error ? cause.message : String(cause)}` }));
}

function handleControl(message: ControlRequest, reply: Reply): void {
  if (message.type === "login") login(reply);
  else if (message.type === "logout") void signOut().then((revoked) => reply.send({ type: "signedOut", revoked }));
  else if (message.type === "list") list(reply);
  else reply.send({ type: "error", message: `unknown request ${JSON.stringify(message)}` });
}

if (await serve(handleControl) === false) {
  console.log("another skill-sync daemon is already running for this user; standing down");
  // Zero: a second install's daemon is not a failure, and the service manager must not keep retrying it.
  process.exit(0);
}
console.log(`skill-sync daemon for ${settings.machine}; waiting for \`skill-sync login\``);
