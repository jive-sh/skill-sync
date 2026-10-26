import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Result, Schema, SchemaIssue } from "effect";
import { isLock } from "./config";
import type { AccountUsage, Money, UsageWindow } from "./wire";

/**
 * How much of its limits each Claude and Codex account on this machine has used, for the dashboard.
 *
 * Read only from files each tool already writes for itself, never from its credentials, so nothing secret
 * is read and nothing is sent anywhere but the numbers. The price is that a reading is only as fresh as
 * the tool's last write, so every reading carries the time it was taken, and that neither file format is
 * a published contract: a shape this code does not recognise is reported as `unknown`, not guessed at.
 *
 * - Claude: each account is a `CLAUDE_CONFIG_DIR` (`~/.claude`, `~/.claude-<name>`). Claude Code keeps
 *   the last plan usage it fetched in the account's `.claude.json` under `cachedUsageUtilization`, and
 *   refreshes it about every five minutes while a session runs on that account. It is what `/usage`
 *   shows when the usage endpoint is rate limited.
 * - Codex: each account is a `CODEX_HOME` (`~/.codex`, `~/.codex-<name>`). Codex records the rate limits
 *   its backend reports with every turn, as a `token_count` event in that turn's session file under
 *   `sessions/`. The fields are Codex's `RateLimitSnapshot` (codex-rs/protocol/src/protocol.rs).
 */

export interface Account {
  readonly tool: AccountUsage["tool"];
  /** Absolute path of the account's folder. */
  readonly path: string;
}

/** What the readers learn about one account; `readAccountUsage` adds which account it is. */
export type Reading = DistributiveOmit<AccountUsage, "tool" | "home">;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** `~/.claude`, `~/.claude-<name>`, `~/.codex` and `~/.codex-<name>`: every account folder in `home`. */
export function detectAccounts(home: string = homedir()): Account[] {
  return readdirSync(home)
    .filter((entry) => !isLock(entry))
    .flatMap((entry): Account[] => {
      const tool = entry === ".claude" || entry.startsWith(".claude-") ? "claude"
        : entry === ".codex" || entry.startsWith(".codex-") ? "codex"
        : undefined;
      if (tool === undefined) return [];
      const path = join(home, entry);
      return isDirectory(path) ? [{ tool, path }] : [];
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Every account on this machine with its usage. One account's unreadable file never hides another's. */
export function readUsage(home: string = homedir()): AccountUsage[] {
  return detectAccounts(home).map((account) => {
    const name = account.path.slice(home.length).replace(/^[\\/]/, "");
    let reading: Reading;
    try {
      reading = account.tool === "claude" ? readClaude(account.path, home) : readCodex(account.path);
    } catch (cause) {
      reading = { state: "unknown", reason: `could not read: ${cause instanceof Error ? cause.message : String(cause)}` };
    }
    return { tool: account.tool, home: name, ...reading };
  });
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

const formatIssue = SchemaIssue.makeFormatterDefault();

/** A record that failed to decode: what failed, on one line, so the dashboard can say why it shows nothing. */
const unknown = (what: string, issue: SchemaIssue.Issue): Reading =>
  ({ state: "unknown", reason: `${what} changed shape: ${formatIssue(issue).replace(/\s+/g, " ").slice(0, 160)}` });

// ── Claude ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * The default account keeps its state in `~/.claude.json`, beside its folder rather than in it; an
 * account given its own `CLAUDE_CONFIG_DIR` keeps it inside that folder.
 */
export function claudeStatePath(accountPath: string, home: string): string {
  return accountPath === join(home, ".claude") ? join(home, ".claude.json") : join(accountPath, ".claude.json");
}

function readClaude(accountPath: string, home: string): Reading {
  const path = claudeStatePath(accountPath, home);
  return existsSync(path) ? parseClaudeState(readFileSync(path, "utf-8")) : { state: "none" };
}

const ClaudeWindow = Schema.Struct({ utilization: Schema.Finite, resets_at: Schema.NullOr(Schema.String) });
const ClaudeMoney = Schema.Struct({ amount_minor: Schema.Finite, currency: Schema.String, exponent: Schema.Int });
const ClaudeUsageCache = Schema.Struct({
  fetchedAtMs: Schema.Finite,
  utilization: Schema.Struct({
    five_hour: Schema.optionalKey(Schema.NullOr(ClaudeWindow)),
    seven_day: Schema.optionalKey(Schema.NullOr(ClaudeWindow)),
    // Usage credits, the account's spend beyond its plan limits. `limit` has only been seen as null, so a
    // limit in another shape is left out rather than failing the whole reading.
    spend: Schema.optionalKey(Schema.NullOr(Schema.Struct({ enabled: Schema.Boolean, used: ClaudeMoney, limit: Schema.Unknown }))),
  }),
});

/** Claude's documented window lengths: its status line calls them the 5-hour and 7-day limits. */
const CLAUDE_WINDOWS = [["five_hour", 300], ["seven_day", 7 * 24 * 60]] as const;

/** Reads the usage Claude Code cached in an account's `.claude.json`. */
export function parseClaudeState(text: string): Reading {
  let state: unknown;
  try {
    state = JSON.parse(text);
  } catch {
    // Claude Code rewrites the file while it runs; a half-written one reads fine a moment later.
    return { state: "unknown", reason: "the account's .claude.json is not valid JSON" };
  }
  if (typeof state !== "object" || state === null || !("cachedUsageUtilization" in state)) return { state: "none" };
  const decoded = Schema.decodeUnknownResult(ClaudeUsageCache)(state.cachedUsageUtilization);
  if (Result.isFailure(decoded)) return unknown("Claude Code's usage cache", decoded.failure.issue);
  const cache = decoded.success;

  const windows: UsageWindow[] = [];
  for (const [key, minutes] of CLAUDE_WINDOWS) {
    const window = cache.utilization[key];
    if (window === undefined || window === null) continue;
    const resetsAt = window.resets_at === null ? null : Date.parse(window.resets_at);
    if (resetsAt !== null && !Number.isFinite(resetsAt)) {
      return { state: "unknown", reason: `Claude Code's usage cache changed shape: ${key}.resets_at is not a time` };
    }
    windows.push({ minutes, usedPercent: window.utilization, resetsAt });
  }

  const spend = cache.utilization.spend;
  const limit = Schema.decodeUnknownOption(ClaudeMoney)(spend?.limit);
  return {
    state: "reading",
    asOf: cache.fetchedAtMs,
    windows,
    ...(spend?.enabled === true
      ? { spent: { used: money(spend.used), limit: limit._tag === "Some" ? money(limit.value) : null } }
      : {}),
  };
}

const money = (value: Schema.Schema.Type<typeof ClaudeMoney>): Money =>
  ({ amountMinor: value.amount_minor, currency: value.currency, exponent: value.exponent });

// ── Codex ───────────────────────────────────────────────────────────────────────────────────────────

const CodexWindow = Schema.Struct({
  used_percent: Schema.Finite,
  window_minutes: Schema.NullOr(Schema.Finite),
  resets_at: Schema.NullOr(Schema.Finite),
});
const CodexTokenCount = Schema.Struct({
  timestamp: Schema.String,
  payload: Schema.Struct({
    type: Schema.Literal("token_count"),
    rate_limits: Schema.NullOr(Schema.Struct({
      limit_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
      primary: Schema.NullOr(CodexWindow),
      secondary: Schema.NullOr(CodexWindow),
    })),
  }),
});

/** Session files newest first; only this many are searched for a reading before giving up. */
const CODEX_FILES_SEARCHED = 5;
/** How far back from its end a session file is searched. Each turn writes one event, so the last is near the end. */
const CODEX_TAIL_BYTES = 16 * 1024 * 1024;

function readCodex(accountPath: string): Reading {
  const files = sessionFiles(join(accountPath, "sessions"))
    .map((path) => ({ path, modifiedAt: statSync(path).mtimeMs }))
    .sort((a, b) => b.modifiedAt - a.modifiedAt)
    .slice(0, CODEX_FILES_SEARCHED);
  // The most recently written file holds the latest event; an older one only matters when the newer
  // ones hold none, as for a session run with an API key, which has no plan limits to report.
  for (const { path } of files) {
    const reading = latestCodexReading(path);
    if (reading.state !== "none") return reading;
  }
  return { state: "none" };
}

/** Every `rollout-*.jsonl` under `sessions/`, which Codex files by date: `YYYY/MM/DD/rollout-….jsonl`. */
function sessionFiles(dir: string): string[] {
  if (!isDirectory(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf-8" })
    .filter((path) => /(^|[\\/])rollout-[^\\/]*\.jsonl$/.test(path))
    .map((path) => join(dir, path));
}

/** The last rate-limit reading in one session file, searched from the end, since files reach hundreds of MB. */
export function latestCodexReading(path: string): Reading {
  for (const line of linesFromEnd(path, CODEX_TAIL_BYTES)) {
    const reading = parseCodexLine(line);
    if (reading !== undefined) return reading;
  }
  return { state: "none" };
}

/**
 * The reading one session-file line carries, or undefined when it carries none: most lines are other
 * events, and a `token_count` from a session without plan limits has `rate_limits: null`.
 */
export function parseCodexLine(line: string): Reading | undefined {
  // Cheap test first: only these lines are worth parsing, and the others can be megabytes.
  if (!line.includes("\"token_count\"")) return undefined;
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return undefined; // The last line of a file Codex is still writing.
  }
  if (!isTokenCount(event)) return undefined;
  const decoded = Schema.decodeUnknownResult(CodexTokenCount)(event);
  if (Result.isFailure(decoded)) return unknown("Codex's rate-limit record", decoded.failure.issue);
  const limits = decoded.success.payload.rate_limits;
  // Another metered bucket than the main one; the main one is `codex`, or unnamed in older versions.
  if (limits === null || (limits.limit_id !== undefined && limits.limit_id !== null && limits.limit_id !== "codex")) return undefined;
  const asOf = Date.parse(decoded.success.timestamp);
  if (!Number.isFinite(asOf)) return { state: "unknown", reason: "Codex's rate-limit record changed shape: timestamp is not a time" };
  return {
    state: "reading",
    asOf,
    windows: [limits.primary, limits.secondary].flatMap((window) => window === null ? [] : [{
      minutes: window.window_minutes,
      usedPercent: window.used_percent,
      resetsAt: window.resets_at === null ? null : window.resets_at * 1000,
    }]),
  };
}

const isTokenCount = (event: unknown): boolean =>
  typeof event === "object" && event !== null && "payload" in event
  && typeof event.payload === "object" && event.payload !== null
  && "type" in event.payload && event.payload.type === "token_count";

/**
 * A file's whole lines, last first, reading at most `limit` bytes back from its end. Lines longer than
 * `maxLine` bytes are skipped: holding a multi-megabyte line while reading backwards would copy it once
 * per chunk read, and the lines wanted here are a few hundred bytes.
 */
export function* linesFromEnd(path: string, limit: number, maxLine = 1024 * 1024): Generator<string> {
  const CHUNK = 64 * 1024;
  const fd = openSync(path, "r");
  try {
    const size = statSync(path).size;
    const stop = Math.max(0, size - limit);
    let position = size;
    // The start of a line whose line break has not been read yet, since reading goes backwards.
    let carry = Buffer.alloc(0);
    // The line being read is longer than `maxLine`; its bytes are dropped until its start is found.
    let oversized = false;
    while (position > stop) {
      const length = Math.min(CHUNK, position - stop);
      position -= length;
      const chunk = Buffer.alloc(length);
      readSync(fd, chunk, 0, length, position);
      const buffer = Buffer.concat([chunk, carry]);
      // Splitting on the newline byte is safe in UTF-8: it never occurs inside a multi-byte character.
      let end = buffer.length;
      for (let index = buffer.length - 1; index >= 0; index--) {
        if (buffer[index] !== 0x0a) continue;
        const line = buffer.subarray(index + 1, end).toString("utf-8").trim();
        if (!oversized && line !== "") yield line;
        oversized = false;
        end = index;
      }
      carry = buffer.subarray(0, end);
      if (carry.length > maxLine) {
        carry = Buffer.alloc(0);
        oversized = true;
      }
    }
    // The file's first line. When the search stopped short of the start, what is left is part of a line.
    const first = carry.toString("utf-8").trim();
    if (stop === 0 && !oversized && first !== "") yield first;
  } finally {
    closeSync(fd);
  }
}
