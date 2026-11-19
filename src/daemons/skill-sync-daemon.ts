import { mkdirSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { autoUpgrade, exitWhenUninstalled } from "jive-abstract-library";
import { name, version } from "../../package.json";
import {
  CONFIG_PATH, TOKEN_PATH, deleteToken, loadSettings, loadStates, loadToken, saveStates, saveToken, stateFor,
  type Config,
} from "../internal/config";
import { serve, type ControlRequest, type Reply } from "../internal/control";
import { describe, register } from "../internal/folders";
import { authHeaders, claimSignInRequest, fetchServer, openSignInRequest, TokenOfAnotherMachine, TokenRejected } from "../internal/server";
import { describeActivity, isQuiet, syncOnce, type Report } from "../internal/sync";
import { checkSkillToAdd } from "../internal/skill-check";
import { detectFolders, readUsage } from "../internal/agents";
import { findCommand } from "../internal/agents/command";
import { startSkillRefinement, type NotRunning, type SkillRefinementRunner } from "../internal/skill-refinement/service";
import {
  DAEMON_VERSION_HEADER, type AddSkillResponse, type DaemonMessage, type FolderPrefs, type FolderState, type HubToDaemon, type ListedSkill,
  type ListSkillsResponse, type Refinement,
} from "../internal/wire";

/**
 * Keeps every enabled skills folder on this machine identical to every other machine's.
 *
 * Folders are detected: the skills folders each agent tool reads (`AGENT_TOOLS`, `detectFolders`). Which of them sync, and the one list of skills that syncs in all of them, are
 * held by the server and changed from the dashboard, so they survive a reinstall and apply the moment
 * they change. A skill not on the list is never pushed or pulled.
 *
 * The daemon holds a WebSocket to the service's hub. That connection is how the dashboard knows this
 * machine is running, how a preference change arrives, and how a write from another machine triggers a
 * cycle here at once. Polling stays as the fallback: every 5 minutes while connected, every 30 seconds
 * while not, so a dropped connection costs latency and never correctness.
 *
 * `skill-sync login` asks the daemon, over the control socket, to sign in (`login`); once a passkey approves it, this
 * process claims the token from the server and keeps it in `~/.jive/skill-sync-token.json` (`TOKEN_PATH`). A
 * daemon that starts and finds that file is signed in, so a restart, a reboot or an upgrade needs no
 * sign-in. Signing out, or the server rejecting the token, deletes the file.
 *
 * Every minute it also reads each Claude, Codex and Grok account on the machine (`readUsage`): who it is
 * and its plan limits, asked of the tool's own CLI at most every five minutes, and this machine's use of
 * it, from the files the tool writes. It sends them over the same connection when they change, for the
 * dashboard. No credential is read or sent: the CLIs make the authenticated calls.
 *
 * It runs this machine's skill refinement workflow (`startSkillRefinement`): Alex's feedback, handed over with
 * `skill-sync feedback`, becomes tested changes to the synced skills. It reports the workflow's queue and runs to the hub for
 * the dashboard's Skill refinement tab, and takes that tab's limit changes.
 *
 * It keeps itself on the latest published version (`autoUpgrade`): every 5 minutes it asks the package
 * manager that installed it whether a newer one is out, installs it the same way, and is restarted on it.
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
/** How often this machine's use is read from local files; account limits are asked of the CLIs less often (`ACCOUNT_READ_MS`). */
const USAGE_READ_MS = 60_000;
/** How often a sign-in asks the server whether a passkey has approved it; the server says when it expired. */
const SIGN_IN_CLAIM_MS = 2_000;
/** How often the skill refinement workflow's runs and limits are read for the dashboard; sent only when they changed. */
const REFINEMENT_REPORT_MS = 60_000;
/** A hub message over this is refused by the platform (1 MiB); the dashboard is told the figures are too big instead. */
const MAX_REFINEMENT_MESSAGE_BYTES = 900_000;

exitWhenUninstalled();

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

/**
 * Reports this machine's folders and skills, and adopts the server's answer for what syncs. The server takes it
 * only from a token issued to the machine this one is configured as, so the session's first registration is
 * where that is known.
 */
async function registerFolders(): Promise<void> {
  const config = current();
  const request = describe(config);
  const first = registered === "";
  const folders = await register(config, request);
  if (first) console.log(`signed in as ${config.machine}: the server confirmed the token is this machine's; syncing with ${config.endpoint}`);
  applyPrefs(folders);
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
  // The version goes with it: an upgrade restarts the daemon, so each connection runs exactly one version.
  const ws = new WebSocket(url, { headers: authHeaders(config, { [DAEMON_VERSION_HEADER]: version }) } as unknown as string[]);
  ws.onopen = () => {
    socket = ws;
    lastPong = Date.now();
    reconnectDelay = RECONNECT_MIN_MS;
    console.log("connected to the hub");
    // Whatever the hub last heard from a previous connection is stale until re-sent.
    reported.clear();
    for (const folder of prefs.keys()) report(folder, "idle");
    reportedUsage = "";
    reportUsage();
    reportedRefinement = "";
    void reportRefinement();
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
    if (message.type === "setLimit") setRefinementLimit(message);
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

/** The usage the hub last heard, so it is sent again only when a number changes. */
let reportedUsage = "";

/** True while a reading runs: a CLI can take seconds to answer, and two readings at once would ask it twice. */
let readingUsage = false;

/** Sends every account's usage to the hub when it differs from what was last sent. */
async function reportUsage(): Promise<void> {
  if (socket === undefined || readingUsage) return;
  readingUsage = true;
  let message: DaemonMessage;
  try {
    message = { type: "usage", accounts: await readUsage() };
  } catch (cause) {
    // Only an unreadable home directory gets here; each account's own failure is reported as `unknown`.
    console.error(`could not read account usage: ${cause instanceof Error ? cause.message : String(cause)}`);
    return;
  } finally {
    readingUsage = false;
  }
  const text = JSON.stringify(message);
  // The socket can have closed, or been replaced, while the CLIs ran.
  if (text === reportedUsage || socket === undefined) return;
  socket.send(text);
  reportedUsage = text;
}

setInterval(reportUsage, USAGE_READ_MS);

// ── Skill refinement ────────────────────────────────────────────────────────────────────────────────

/** The workflow running here, or why it is not; it runs whether or not the machine is signed in. */
let refinement: SkillRefinementRunner | NotRunning = { notRunning: "starting" };
/** What the hub last heard about it, so it is sent again only when something the dashboard draws changed. */
let reportedRefinement = "";

/** Sends the workflow's state and figures to the hub when they differ from what was last sent. */
async function reportRefinement(): Promise<void> {
  if (socket === undefined) return;
  const runner = refinement;
  let state: Refinement;
  try {
    state = "notRunning" in runner ? { state: "notRunning", reason: runner.notRunning } : { state: "running", data: await runner.pageData() };
  } catch (cause) {
    console.error(`skill refinement: could not read its runs and limits: ${describeError(cause)}`);
    return;
  }
  let text = JSON.stringify({ type: "refinement", refinement: state } satisfies DaemonMessage);
  if (text.length > MAX_REFINEMENT_MESSAGE_BYTES) {
    console.error(`skill refinement: its figures are ${text.length} bytes, over the hub's limit; sending its state without them`);
    text = JSON.stringify({ type: "refinement", refinement: { state: "notRunning", reason: `its figures (${text.length} bytes) are too big to send` } } satisfies DaemonMessage);
  }
  if (text === reportedRefinement || socket === undefined) return;
  socket.send(text);
  reportedRefinement = text;
}

setInterval(reportRefinement, REFINEMENT_REPORT_MS);

/** A limit set on the dashboard's Skill refinement tab for this machine. */
function setRefinementLimit(change: Extract<HubToDaemon, { type: "setLimit" }>): void {
  const runner = refinement;
  if ("notRunning" in runner) {
    console.error(`skill refinement: a ${change.limit} limit came from the dashboard, but the workflow is not running here: ${runner.notRunning}`);
    return;
  }
  runner.setLimit({ workflow: change.workflow, limit: change.limit, value: change.value }).then(
    () => reportRefinement(),
    (cause) => console.error(`skill refinement: the dashboard's ${change.limit} limit for ${change.workflow} was not set: ${describeError(cause)}`),
  );
}

/** The synced list, for the workflow's install guard: the same request `skill-sync list` makes, from this process. */
async function syncedSkills(): Promise<ReadonlyArray<ListedSkill>> {
  const config = session;
  if (config === undefined) throw new Error(signedOutMessage());
  return await fetchSyncedSkills(config);
}

async function fetchSyncedSkills(config: Config): Promise<ReadonlyArray<ListedSkill>> {
  const response = await fetchServer(config, "/skills");
  if (!response.ok) throw new Error(`GET /skills: ${response.status} ${await response.text()}`);
  return (await response.json() as ListSkillsResponse).skills;
}

/** Hands a feedback item to the workflow, for `skill-sync feedback`. */
function addFeedback(item: { readonly slug: string; readonly text: string }, reply: Reply): void {
  const runner = refinement;
  if ("notRunning" in runner) {
    reply.send({ type: "error", message: `skill refinement is not running on this machine: ${runner.notRunning}` });
    return;
  }
  runner.addFeedback(item).then(
    (id) => {
      console.log(`skill refinement: feedback ${id} added`);
      reply.send({ type: "feedbackAdded", id });
    },
    (cause) => reply.send({ type: "error", message: describeError(cause) }),
  );
}

// ── Sync cycles ─────────────────────────────────────────────────────────────────────────────────────

let running = false;
let cycleQueued = false;

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
        if (result.rejected.length > 0) report(folder, "attention", result.rejected.join("; "), describeActivity(result) || undefined);
        else report(folder, "idle", undefined, isQuiet(result) ? undefined : describeActivity(result));
        // What this folder pushed is pulled into the machine's other folders on the follow-up pass.
        if (result.pushed.length > 0) cycleQueued = true;
      } catch (cause) {
        if (endRefusedSession(cause)) return;
        // One failed folder must not end the daemon or the other folders: the usual cause is the network.
        const reason = cause instanceof Error ? cause.message : String(cause);
        console.error(`${folder}: sync failed: ${reason}`);
        report(folder, "attention", `sync failed: ${reason}`);
      }
    }
    // A skill created or removed locally changes what the dashboard should list.
    if (registrationStale()) {
      await registerFolders().catch((cause: unknown) => {
        endRefusedSession(cause);
      });
    }
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
    if (endRefusedSession(cause)) return;
    console.error(`could not register folders: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  await runCycle();
  if (session !== undefined) pollTimer = setTimeout(poll, socket === undefined ? POLL_DISCONNECTED_MS : POLL_CONNECTED_MS);
}

// ── Signing in and out ──────────────────────────────────────────────────────────────────────────────

/**
 * Starts a session with a token just claimed from a sign-in. Registering this machine's folders is the first call
 * that needs the token, so it doubles as the check that the token works: a failure leaves the daemon
 * signed out, not half-running, and the token unsaved.
 */
async function signIn(token: string): Promise<void> {
  if (session !== undefined) await signOut();
  tokenOfAnotherMachine = undefined;
  session = { ...settings!, token };
  try {
    await registerFolders();
  } catch (cause) {
    session = undefined;
    throw cause;
  }
  saveToken(token);
  connect();
  void poll();
}

/**
 * Starts a session with the token saved by an earlier sign-in. Not checked first, unlike `signIn`: at boot
 * the network may not be up yet, and a failure for that reason must not sign the machine out. The first
 * poll registers, which is when the server says whose token it is: a rejected token signs out there, and
 * one issued to another machine stops the session (`endRefusedSession`).
 */
function resume(token: string): void {
  session = { ...settings!, token };
  console.log(`resuming as ${session.machine} with the token in ${TOKEN_PATH}; checking it with ${session.endpoint}`);
  connect();
  void poll();
}

/**
 * Stops syncing and reporting. The token file stays: `endSession` deletes it, and a token found to be another
 * machine's is left for that machine's sake. Returns the session that stopped.
 */
function stopSession(): Config | undefined {
  const config = session;
  if (config === undefined) return undefined;
  session = undefined;
  if (pollTimer !== undefined) clearTimeout(pollTimer);
  socket?.close();
  socket = undefined;
  for (const watcher of watchers.values()) watcher.close();
  watchers.clear();
  prefs = new Map();
  registered = "";
  return config;
}

/** Stops syncing and forgets the token, here and in `TOKEN_PATH`. Returns the session that ended. */
function endSession(): Config | undefined {
  const config = stopSession();
  if (config !== undefined) deleteToken();
  return config;
}

/**
 * Set when the server said the saved token was issued to another machine. The session is stopped and the
 * token file kept; the CLI's requests are answered with `describeTokenOfAnotherMachine` until a sign-in.
 */
let tokenOfAnotherMachine: TokenOfAnotherMachine | undefined;

/** What to tell a person about a token issued to another machine, and the one command that fixes it. */
const describeTokenOfAnotherMachine = (cause: TokenOfAnotherMachine): string =>
  `${CONFIG_PATH} names this machine "${cause.configuredMachine}", but the token in ${TOKEN_PATH} was issued to "${cause.tokenMachine}", `
  + `most likely copied from it. skill-sync stopped syncing and reporting here so this machine does not write as "${cause.tokenMachine}". `
  + `Run \`skill-sync login\` to sign this machine in as "${cause.configuredMachine}". `
  + `Do not run \`skill-sync logout\` here: it would revoke "${cause.tokenMachine}"'s token and sign that machine out.`;

/**
 * Ends the session when the server refused its token: revoked or unknown (`TokenRejected`), it is deleted; issued
 * to another machine (`TokenOfAnotherMachine`), syncing and reporting stop and the file is kept. Returns whether
 * `cause` was such a refusal. Only for this session's token: a request still in flight from before a new
 * sign-in may be refused too.
 */
function endRefusedSession(cause: unknown): boolean {
  if (cause instanceof TokenRejected) {
    if (session?.token !== cause.token) return true;
    endSession();
    console.error(`${cause.message}; signed out and deleted ${TOKEN_PATH}. Run \`skill-sync login\` to sign in again.`);
    return true;
  }
  if (cause instanceof TokenOfAnotherMachine) {
    if (session?.token !== cause.token) return true;
    stopSession();
    tokenOfAnotherMachine = cause;
    console.error(describeTokenOfAnotherMachine(cause));
    return true;
  }
  return false;
}

/** Why a request that needs the server cannot be made: no session, or a token that is another machine's. */
const signedOutMessage = (): string => tokenOfAnotherMachine !== undefined
  ? describeTokenOfAnotherMachine(tokenOfAnotherMachine)
  : "this machine is signed out; run `skill-sync login` first";

/** Revokes the token on the server, forgets it, and stops syncing. Returns whether the revoke succeeded. */
async function signOut(): Promise<boolean> {
  const config = endSession();
  if (config === undefined) return false;
  // Revoked, not just forgotten: a token copied while it was live would otherwise keep working.
  // A token the server already rejects is as revoked as it can be.
  const revoked = await fetchServer(config, "/cli/token", { method: "DELETE" })
    .then((response) => response.ok, (cause: unknown) => cause instanceof TokenRejected);
  console.log(`signed out${revoked ? "" : " (the server could not be reached to revoke the token)"}`);
  return revoked;
}

let loginInProgress = false;

/**
 * One sign-in: open a sign-in request on the server, tell the CLI the page that approves it, and claim the
 * request every few seconds until a passkey has approved it, on this computer or any other, or it expires.
 * The claim secret stays in this process, so only this daemon can collect the token.
 */
function login(reply: Reply): void {
  if (loginInProgress) {
    reply.send({ type: "error", message: "a sign-in is already in progress" });
    return;
  }
  loginInProgress = true;
  const fail = (message: string): void => {
    loginInProgress = false;
    reply.send({ type: "error", message });
  };
  openSignInRequest({ endpoint: settings!.endpoint, machine: settings!.machine }).then(
    ({ url, claimSecret, expiresAt }) => {
      reply.send({ type: "open", url });
      const claim = (): void => {
        claimSignInRequest({ endpoint: settings!.endpoint, claimSecret }).then(
          (answer) => {
            if (answer.state === "pending") return void setTimeout(claim, SIGN_IN_CLAIM_MS);
            if (answer.state === "expired") return fail("the sign-in expired before it was approved; run `skill-sync login` again");
            loginInProgress = false;
            signIn(answer.token).then(
              () => reply.send({ type: "signedIn", machine: settings!.machine }),
              (cause) => reply.send({ type: "error", message: `the server refused the sign-in: ${describeError(cause)}` }),
            );
          },
          // The network can drop for a moment while someone fetches their phone; the request outlives it, until it expires.
          (cause) => Date.now() > expiresAt
            ? fail(`could not reach the server before the sign-in expired: ${describeError(cause)}`)
            : void setTimeout(claim, SIGN_IN_CLAIM_MS),
        );
      };
      claim();
    },
    (cause) => fail(`could not start a sign-in: ${describeError(cause)}`),
  );
}

const describeError = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);

/** The synced list, from the server: the CLI has no token to ask with, so it asks this daemon. */
function list(reply: Reply): void {
  const config = session;
  if (config === undefined) {
    reply.send({ type: "error", message: signedOutMessage() });
    return;
  }
  fetchSyncedSkills(config)
    .then((skills) => reply.send({ type: "list", skills }))
    .catch((cause: unknown) => {
      if (endRefusedSession(cause)) {
        reply.send({ type: "error", message: signedOutMessage() });
        return;
      }
      reply.send({ type: "error", message: `could not reach the server: ${cause instanceof Error ? cause.message : String(cause)}` });
    });
}

/**
 * Puts a skill from this machine on the synced list, for an agent that has just written it. The files are
 * checked here, where they are; the server only adds the name, and every daemon then syncs the skill.
 */
function add(skill: string, reply: Reply): void {
  const config = session;
  if (config === undefined) {
    reply.send({ type: "error", message: signedOutMessage() });
    return;
  }
  const check = checkSkillToAdd({ skill, folders: detectFolders(), exclude: config.exclude });
  if (!check.ok) {
    reply.send({ type: "error", message: check.reason });
    return;
  }
  fetchServer(config, `/skills/${encodeURIComponent(skill)}`, { method: "PUT" })
    .then(async (response) => {
      if (!response.ok) throw new Error(`PUT /skills/${skill}: ${response.status} ${await response.text()}`);
      const { added } = await response.json() as AddSkillResponse;
      reply.send({
        type: "added", skill, added, folders: check.folders,
        syncingFolders: check.folders.filter((folder) => prefs.has(folder)),
      });
    })
    .catch((cause: unknown) => {
      if (endRefusedSession(cause)) {
        reply.send({ type: "error", message: signedOutMessage() });
        return;
      }
      reply.send({ type: "error", message: `could not reach the server: ${cause instanceof Error ? cause.message : String(cause)}` });
    });
}

function handleControl(message: ControlRequest, reply: Reply): void {
  if (message.type === "login") login(reply);
  // A token issued to another machine is that machine's sign-in: revoking it would sign that machine out.
  else if (message.type === "logout" && tokenOfAnotherMachine !== undefined) reply.send({ type: "error", message: signedOutMessage() });
  else if (message.type === "logout") void signOut().then((revoked) => reply.send({ type: "signedOut", revoked }));
  else if (message.type === "list") list(reply);
  else if (message.type === "add") add(message.skill, reply);
  else if (message.type === "feedback") addFeedback(message, reply);
  else reply.send({ type: "error", message: `unknown request ${JSON.stringify(message)}` });
}

if (await serve(handleControl) === false) {
  console.log("another skill-sync daemon is already running for this user; standing down");
  // Zero: a second install's daemon is not a failure, and the service manager must not keep retrying it.
  process.exit(0);
}
// Only after taking the control socket: a daemon that stands down must not sync, or upgrade, too.
autoUpgrade({ packageName: name });
startSkillRefinement({
  home: homedir(),
  claudeCommand: findCommand({ name: "claude", home: homedir(), also: [join(homedir(), ".claude", "local", "claude")] }),
  syncedSkills,
  onState: (state) => {
    refinement = state;
    if ("notRunning" in state) console.log(`skill refinement: ${state.notRunning}`);
    void reportRefinement();
  },
}).catch((cause: unknown) => {
  refinement = { notRunning: `it could not start: ${describeError(cause)}` };
  console.error(`skill refinement: ${refinement.notRunning}`);
  void reportRefinement();
});
const savedToken = loadToken();
if (savedToken !== undefined) resume(savedToken);
else console.log(`skill-sync daemon for ${settings.machine}; waiting for \`skill-sync login\``);
