import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Result, Schema } from "effect";
import type { TokenSpend } from "../wire";
import {
  DAY_MS, PERIOD_DAYS, homesNamed, isDirectory, linesFromEnd, parseJson, unknownShape, type AgentTool, type Reading,
} from "./agent-tool";

/**
 * Codex. Each account is a `CODEX_HOME` (`~/.codex`, `~/.codex-<name>`). Every account reads a user's
 * skills from `~/.agents/skills`, offered when any Codex account or `~/.agents` exists, because a
 * machine with Codex installed may have no `~/.agents` yet.
 *
 * Codex records what its backend reports with every turn, as a `token_count` event in that turn's session
 * file under `sessions/`: the rate limits (Codex's `RateLimitSnapshot`, codex-rs/protocol/src/protocol.rs)
 * and the session's running token total. The limits come from the newest event; the tokens are each
 * session's total, summed over sessions active in the last `PERIOD_DAYS` days.
 */
export const codex: AgentTool = {
  tool: "codex",
  skillsFolders: (home) =>
    homesNamed(home, "codex").length > 0 || isDirectory(join(home, ".agents")) ? [join(home, ".agents", "skills")] : [],
  accounts: (home) => homesNamed(home, "codex"),
  readUsage: (account, _home, now) => readCodex(account, now),
};

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
  readonly limits: Reading | undefined;
  /** The session's token total so far, or undefined when no event carries one. */
  readonly tokens: number | undefined;
}

/** Session files keep growing while a session runs; one unchanged since it was last read is not read again. */
const sessionCache = new Map<string, { readonly modifiedAt: number; readonly record: SessionRecord }>();

function readCodex(account: string, now: number): Reading {
  const files = sessionFiles(join(account, "sessions"))
    .map((path) => ({ path, modifiedAt: statSync(path).mtimeMs }))
    .sort((a, b) => b.modifiedAt - a.modifiedAt);
  const since = now - PERIOD_DAYS * DAY_MS;
  const recent = files.filter((file) => file.modifiedAt >= since);
  for (const path of sessionCache.keys()) {
    if (path.startsWith(account) && !files.some((file) => file.path === path)) sessionCache.delete(path);
  }

  // The most recently written file holds the latest reading; an older one only matters when the newer
  // ones hold none.
  let limits: Reading = { state: "none" };
  for (const file of files.slice(0, CODEX_FILES_SEARCHED)) {
    const record = sessionRecord(file);
    if (record.limits !== undefined) {
      limits = record.limits;
      break;
    }
  }
  if (limits.state !== "reading") return limits;

  const totals = recent.map((file) => sessionRecord(file).tokens).filter((tokens) => tokens !== undefined);
  const tokens: TokenSpend = {
    count: totals.reduce((sum, count) => sum + count, 0),
    periodDays: PERIOD_DAYS,
    sessions: totals.length,
  };
  return { ...limits, tokens };
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
  let limits: Reading | undefined;
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
  return {
    limits: {
      state: "reading",
      asOf,
      windows: [limits.primary, limits.secondary].flatMap((window) => window === null ? [] : [{
        minutes: window.window_minutes,
        usedPercent: window.used_percent,
        resetsAt: window.resets_at === null ? null : window.resets_at * 1000,
      }]),
    },
    tokens,
  };
}

const isTokenCount = (event: unknown): boolean =>
  typeof event === "object" && event !== null && "payload" in event
  && typeof event.payload === "object" && event.payload !== null
  && "type" in event.payload && event.payload.type === "token_count";
