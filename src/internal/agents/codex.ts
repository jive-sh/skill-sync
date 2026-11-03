import { readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result, Schema } from "effect";
import type { AccountLimits, LocalUse, UsageWindow } from "../wire";
import {
  CLI_TIMEOUT_MS, DAY_MS, PERIOD_DAYS, homesNamed, isDirectory, linesFromEnd, parseJson, unknownShape, windowName,
  type AccountContext, type AccountReading, type AgentTool,
} from "./agent-tool";
import { askJsonRpc, isFile, type RpcResponse } from "./command";

/**
 * Codex. Each account is a `CODEX_HOME` (`~/.codex`, `~/.codex-<name>`). Every account reads a user's
 * skills from `~/.agents/skills`, offered when any Codex account or `~/.agents` exists, because a
 * machine with Codex installed may have no `~/.agents` yet.
 *
 * - Account: `codex app-server` speaks JSON-RPC over stdio, the protocol Codex's own editors and desktop
 *   app use (openai/codex, codex-rs/app-server-protocol). `account/read` says who is signed in and
 *   `account/rateLimits/read` fetches the account's limits from OpenAI. The `codex` binary is looked for
 *   on PATH, in the folders npm, bun and Homebrew install to, in Codex's editor extension, and inside the ChatGPT and Codex desktop
 *   apps, which ship one. Without one, the limits are the ones Codex recorded with its latest turn, as a
 *   `token_count` event in that turn's session file under `sessions/` (Codex's `RateLimitSnapshot`,
 *   codex-rs/protocol/src/protocol.rs).
 * - This machine: each session's running token total, from the same events, summed over sessions active
 *   in the last `PERIOD_DAYS` days.
 */
export const codex: AgentTool = {
  tool: "codex",
  skillsFolders: (home) =>
    homesNamed(home, "codex").length > 0 || isDirectory(join(home, ".agents")) ? [join(home, ".agents", "skills")] : [],
  accounts: (home) => homesNamed(home, "codex"),
  readAccount: (account, context) => readCodexAccount(account, context),
  readLocalUse: (account, _home, now) => localTokens(account, now),
};

// ── The account ─────────────────────────────────────────────────────────────────────────────────────

/** The desktop apps that ship a `codex` binary, on macOS. */
const appBundles = (home: string): string[] => ["/Applications", join(home, "Applications")]
  .flatMap((folder) => ["ChatGPT.app", "Codex.app"].map((app) => join(folder, app, "Contents", "Resources", "codex")));

/**
 * The editors whose extension folders can hold Codex's extension (`openai.chatgpt`), which ships a `codex` binary at
 * `bin/<platform>/codex`: VS Code and its Insiders build, Cursor and Windsurf, each with the `-server` folder
 * their remote (SSH) mode installs extensions into on the remote machine.
 */
const EDITOR_FOLDERS = [".vscode", ".vscode-insiders", ".cursor", ".windsurf"].flatMap((editor) => [editor, `${editor}-server`]);

/** Every `codex` binary in an installed Codex extension, the most recently installed first. */
export function extensionBinaries(home: string): string[] {
  const file = process.platform === "win32" ? "codex.exe" : "codex";
  return EDITOR_FOLDERS.flatMap((editor) => {
    const extensions = join(home, editor, "extensions");
    if (!isDirectory(extensions)) return [];
    return readdirSync(extensions)
      .filter((entry) => entry.startsWith("openai.chatgpt-"))
      .flatMap((entry) => {
        const bin = join(extensions, entry, "bin");
        if (!isDirectory(bin)) return [];
        return readdirSync(bin).map((platform) => join(bin, platform, file)).filter(isFile);
      });
  }).map((path) => ({ path, modifiedAt: statSync(path).mtimeMs }))
    .sort((a, b) => b.modifiedAt - a.modifiedAt)
    .map((binary) => binary.path);
}

async function readCodexAccount(account: string, { home, now, findCommand }: AccountContext): Promise<AccountReading> {
  const command = findCommand({ name: "codex", also: [...appBundles(home), ...extensionBinaries(home)] });
  if (command === undefined) return { identity: null, limits: savedLimits(account, "`codex` was not found") };
  // `account/rateLimits/read` is sent without params: older versions refuse any (`invalid type: map, expected unit`).
  const asked = await askJsonRpc({
    name: "codex app-server",
    command,
    args: ["app-server"],
    env: { ...process.env, CODEX_HOME: account },
    cwd: tmpdir(),
    timeoutMs: CLI_TIMEOUT_MS,
    messages: [
      { id: 1, method: "initialize", params: { clientInfo: { name: "skill-sync", title: null, version: "1" }, capabilities: null } },
      { method: "initialized" },
      { id: REQUEST_ACCOUNT, method: "account/read", params: {} },
      { id: REQUEST_RATE_LIMITS, method: "account/rateLimits/read" },
    ],
  });
  if (asked.kind === "failed") return { identity: null, limits: savedLimits(account, asked.reason) };
  return parseAppServerAnswers({ account: asked.answers.get(REQUEST_ACCOUNT)!, rateLimits: asked.answers.get(REQUEST_RATE_LIMITS)!, now });
}

const REQUEST_ACCOUNT = 2;
const REQUEST_RATE_LIMITS = 3;

/** `account/read`'s answer (codex-rs/app-server-protocol/schema/typescript/v2/GetAccountResponse.ts). */
const AccountResponse = Schema.Struct({
  account: Schema.NullOr(Schema.Struct({
    type: Schema.String,
    email: Schema.optionalKey(Schema.NullOr(Schema.String)),
    planType: Schema.optionalKey(Schema.NullOr(Schema.String)),
  })),
});
const AppServerWindow = Schema.Struct({
  usedPercent: Schema.Finite,
  windowDurationMins: Schema.NullOr(Schema.Finite),
  resetsAt: Schema.NullOr(Schema.Finite),
});
const AppServerSnapshot = Schema.Struct({ primary: Schema.NullOr(AppServerWindow), secondary: Schema.NullOr(AppServerWindow) });
/** `account/rateLimits/read`'s answer (GetAccountRateLimitsResponse.ts): the main bucket is `codex`. */
const RateLimitsResponse = Schema.Struct({
  rateLimits: AppServerSnapshot,
  rateLimitsByLimitId: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, AppServerSnapshot))),
});

/** The account and its limits from the two answers `codex app-server` gave. */
export function parseAppServerAnswers(input: { readonly account: RpcResponse; readonly rateLimits: RpcResponse; readonly now: number }): AccountReading {
  if (input.account.error !== undefined) {
    return { identity: null, limits: { state: "unknown", reason: `\`account/read\` failed: ${input.account.error.message.slice(0, 160)}` } };
  }
  const decodedAccount = Schema.decodeUnknownResult(AccountResponse)(input.account.result);
  if (Result.isFailure(decodedAccount)) return { identity: null, limits: unknownShape("Codex's `account/read` answer", decodedAccount.failure.issue) };
  const signedIn = decodedAccount.success.account;
  if (signedIn === null) return { identity: null, limits: { state: "none", reason: "signed out" } };
  if (signedIn.type !== "chatgpt" || typeof signedIn.email !== "string") {
    return { identity: null, limits: { state: "none", reason: `signed in with ${signedIn.type}: no plan limits` } };
  }
  const plan = signedIn.planType;
  const identity = { id: signedIn.email, email: signedIn.email, plan: typeof plan === "string" && plan !== "unknown" ? plan : null };

  if (input.rateLimits.error !== undefined) {
    return { identity, limits: { state: "unknown", reason: `\`account/rateLimits/read\` failed: ${input.rateLimits.error.message.slice(0, 160)}` } };
  }
  const decodedLimits = Schema.decodeUnknownResult(RateLimitsResponse)(input.rateLimits.result);
  if (Result.isFailure(decodedLimits)) return { identity, limits: unknownShape("Codex's `account/rateLimits/read` answer", decodedLimits.failure.issue) };
  const snapshot = decodedLimits.success.rateLimitsByLimitId?.codex ?? decodedLimits.success.rateLimits;
  return {
    identity,
    limits: {
      state: "reading",
      asOf: input.now,
      source: "account",
      windows: [snapshot.primary, snapshot.secondary].flatMap((window) => window === null ? [] : [{
        name: windowName(window.windowDurationMins),
        minutes: window.windowDurationMins,
        usedPercent: window.usedPercent,
        resetsAt: window.resetsAt === null ? null : window.resetsAt * 1000,
      }]),
    },
  };
}

// ── Session files ───────────────────────────────────────────────────────────────────────────────────

const CodexWindow = Schema.Struct({
  used_percent: Schema.Finite,
  window_minutes: Schema.NullOr(Schema.Finite),
  resets_at: Schema.NullOr(Schema.Finite),
});
const CodexTokenCount = Schema.Struct({
  timestamp: Schema.String,
  payload: Schema.Struct({
    type: Schema.Literal("token_count"),
    info: Schema.optionalKey(Schema.NullOr(Schema.Struct({
      total_token_usage: Schema.Struct({ total_tokens: Schema.Finite }),
    }))),
    rate_limits: Schema.NullOr(Schema.Struct({
      limit_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
      primary: Schema.NullOr(CodexWindow),
      secondary: Schema.NullOr(CodexWindow),
    })),
  }),
});

/** Session files newest first; only this many are searched for a rate-limit reading before giving up. */
const CODEX_FILES_SEARCHED = 5;
/** How far back from its end a session file is searched. Each turn writes one event, so the last is near the end. */
const CODEX_TAIL_BYTES = 16 * 1024 * 1024;

/** What one session file's latest `token_count` events say. */
export interface SessionRecord {
  /** The newest rate-limit reading, or undefined when the file has none (a session run with an API key). */
  readonly limits: AccountLimits | undefined;
  /** The session's token total so far, or undefined when no event carries one. */
  readonly tokens: number | undefined;
}

/** Session files keep growing while a session runs; one unchanged since it was last read is not read again. */
const sessionCache = new Map<string, { readonly modifiedAt: number; readonly record: SessionRecord }>();

/** The account's session files, newest first; files Codex deleted leave the cache. */
function sessionFilesNewestFirst(account: string): { readonly path: string; readonly modifiedAt: number }[] {
  const files = sessionFiles(join(account, "sessions"))
    .map((path) => ({ path, modifiedAt: statSync(path).mtimeMs }))
    .sort((a, b) => b.modifiedAt - a.modifiedAt);
  const current = new Set(files.map((file) => file.path));
  for (const path of sessionCache.keys()) {
    if (path.startsWith(account) && !current.has(path)) sessionCache.delete(path);
  }
  return files;
}

/** The limits Codex recorded with its latest turn, for when `codex app-server` cannot be asked; `why` says why it could not. */
function savedLimits(account: string, why: string): AccountLimits {
  // The most recently written file holds the latest reading; an older one only matters when the newer
  // ones hold none.
  for (const file of sessionFilesNewestFirst(account).slice(0, CODEX_FILES_SEARCHED)) {
    const record = sessionRecord(file);
    if (record.limits !== undefined) return record.limits.state === "reading" ? { ...record.limits, cliFailure: why } : record.limits;
  }
  return { state: "unknown", reason: why };
}

function localTokens(account: string, now: number): LocalUse {
  const since = now - PERIOD_DAYS * DAY_MS;
  const totals = sessionFilesNewestFirst(account)
    .filter((file) => file.modifiedAt >= since)
    .map((file) => sessionRecord(file).tokens)
    .filter((tokens) => tokens !== undefined);
  return { state: "tokens", periodDays: PERIOD_DAYS, count: totals.reduce((sum, count) => sum + count, 0), sessions: totals.length };
}

function sessionRecord(file: { readonly path: string; readonly modifiedAt: number }): SessionRecord {
  const cached = sessionCache.get(file.path);
  if (cached !== undefined && cached.modifiedAt === file.modifiedAt) return cached.record;
  const record = latestSessionRecord(file.path);
  sessionCache.set(file.path, { modifiedAt: file.modifiedAt, record });
  return record;
}

/** Every `rollout-*.jsonl` under `sessions/`, which Codex files by date: `YYYY/MM/DD/rollout-….jsonl`. */
function sessionFiles(dir: string): string[] {
  if (!isDirectory(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf-8" })
    .filter((path) => /(^|[\\/])rollout-[^\\/]*\.jsonl$/.test(path))
    .map((path) => join(dir, path));
}

/** The newest rate-limit reading and token total in one session file, searched from the end, since files reach hundreds of MB. */
export function latestSessionRecord(path: string): SessionRecord {
  let limits: AccountLimits | undefined;
  let tokens: number | undefined;
  for (const line of linesFromEnd(path, CODEX_TAIL_BYTES)) {
    const event = parseCodexLine(line);
    if (event === undefined) continue;
    if (limits === undefined) limits = event.limits;
    if (tokens === undefined) tokens = event.tokens;
    if (limits !== undefined && tokens !== undefined) break;
  }
  return { limits, tokens };
}

/**
 * What one session-file line carries, or undefined when it is not a `token_count` event: most lines are
 * other events. A `token_count` from a session without plan limits has `rate_limits: null`.
 */
export function parseCodexLine(line: string): SessionRecord | undefined {
  // Cheap test first: only these lines are worth parsing, and the others can be megabytes.
  if (!line.includes("\"token_count\"")) return undefined;
  const event = parseJson(line); // Undefined for the last line of a file Codex is still writing.
  if (!isTokenCount(event)) return undefined;
  const decoded = Schema.decodeUnknownResult(CodexTokenCount)(event);
  if (Result.isFailure(decoded)) return { limits: unknownShape("Codex's rate-limit record", decoded.failure.issue), tokens: undefined };
  const { payload, timestamp } = decoded.success;
  const tokens = payload.info?.total_token_usage.total_tokens;
  const limits = payload.rate_limits;
  // Another metered bucket than the main one; the main one is `codex`, or unnamed in older versions.
  if (limits === null || (limits.limit_id !== undefined && limits.limit_id !== null && limits.limit_id !== "codex")) {
    return { limits: undefined, tokens };
  }
  const asOf = Date.parse(timestamp);
  if (!Number.isFinite(asOf)) {
    return { limits: { state: "unknown", reason: "Codex's rate-limit record changed shape: timestamp is not a time" }, tokens };
  }
  const windows: UsageWindow[] = [limits.primary, limits.secondary].flatMap((window) => window === null ? [] : [{
    name: windowName(window.window_minutes),
    minutes: window.window_minutes,
    usedPercent: window.used_percent,
    resetsAt: window.resets_at === null ? null : window.resets_at * 1000,
  }]);
  return { limits: { state: "reading", asOf, source: "saved", windows }, tokens };
}

const isTokenCount = (event: unknown): boolean =>
  typeof event === "object" && event !== null && "payload" in event
  && typeof event.payload === "object" && event.payload !== null
  && "type" in event.payload && event.payload.type === "token_count";
