import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { Result, Schema, SchemaIssue } from "effect";
import type { Money, UsageWindow } from "../wire";
import {
  DAY_MS, PERIOD_DAYS, homesNamed, isDirectory, linesFromEnd, parseJson, unknownShape, type AgentTool, type Reading,
} from "./agent-tool";

/**
 * Claude Code. Each account is a `CLAUDE_CONFIG_DIR` (`~/.claude`, `~/.claude-<name>`), and reads its
 * user skills from the `skills` folder inside it.
 *
 * Usage is read only from files Claude Code writes for itself, never from its credentials. Neither file
 * format is a published contract, so a shape this code does not recognise is reported as `unknown`.
 *
 * - Plan limits: Claude Code keeps the last plan usage it fetched in the account's `.claude.json` under
 *   `cachedUsageUtilization`, and refreshes it about every five minutes while a session runs on that
 *   account. It is what `/usage` shows when the usage endpoint is rate limited.
 * - No plan limits (Amazon Bedrock, an API key): Claude Code computes each session's cost locally from
 *   token counts at list price, the figure `/usage` shows as the Session block's total cost
 *   (https://code.claude.com/docs/en/costs), and saves it as a `cost-state` line in the session's file
 *   under `projects/`. An account with a plan cache keeps showing its limits, unless its settings turn
 *   Bedrock on.
 */
export const claude: AgentTool = {
  tool: "claude",
  skillsFolders: (home) => homesNamed(home, "claude").map((account) => join(account, "skills")),
  accounts: (home) => homesNamed(home, "claude"),
  readUsage: (account, home, now) => readClaude(account, home, now),
};

// ── Claude ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * The default account keeps its state in `~/.claude.json`, beside its folder rather than in it; an
 * account given its own `CLAUDE_CONFIG_DIR` keeps it inside that folder.
 */
export function claudeStatePath(accountPath: string, home: string): string {
  return accountPath === join(home, ".claude") ? join(home, ".claude.json") : join(accountPath, ".claude.json");
}

/**
 * A subscription account's plan limits, else what its recent sessions cost. A Bedrock account can still
 * hold a plan cache from before it switched, so its settings saying Bedrock outrank the cache.
 */
function readClaude(accountPath: string, home: string, now: number): Reading {
  const statePath = claudeStatePath(accountPath, home);
  const plan: Reading = existsSync(statePath) ? parseClaudeState(readFileSync(statePath, "utf-8")) : { state: "none" };
  const settingsPath = join(accountPath, "settings.json");
  const bedrockSetting = existsSync(settingsPath) && settingsUseBedrock(readFileSync(settingsPath, "utf-8"));
  if (plan.state !== "none" && !bedrockSetting) return plan;
  const projects = join(accountPath, "projects");
  const files = [...sessionFilesSince(projects, now - PERIOD_DAYS * DAY_MS)];
  forgetOtherSessionFiles(projects, new Set(files.map((file) => file.path)));
  return estimateSpend({ sessions: files.map(latestSessionCost), bedrockSetting, now });
}

// ── Claude without plan limits ──────────────────────────────────────────────────────────────────────

/** How far back from its end a session file is searched for its cost. Claude Code writes it last, on leaving the session. */
const CLAUDE_TAIL_BYTES = 16 * 1024 * 1024;

/**
 * True when the account's `settings.json` turns on Bedrock: the `/setup-bedrock` wizard writes
 * `CLAUDE_CODE_USE_BEDROCK` to its `env` block (https://code.claude.com/docs/en/amazon-bedrock), and
 * `CLAUDE_CODE_USE_MANTLE` selects Bedrock's Mantle endpoint. Set only in a shell, it is invisible here;
 * the model IDs in the account's sessions then say Bedrock instead.
 */
export function settingsUseBedrock(text: string): boolean {
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch {
    return false;
  }
  const env = Schema.decodeUnknownOption(Schema.Struct({ env: Schema.Record(Schema.String, Schema.Unknown) }))(settings);
  if (env._tag === "None") return false;
  return [env.value.env.CLAUDE_CODE_USE_BEDROCK, env.value.env.CLAUDE_CODE_USE_MANTLE]
    .some((value) => value === true || (typeof value === "string" && /^(1|true)$/i.test(value.trim())));
}

/**
 * Bedrock's model IDs: a cross-region inference profile (`us.anthropic.claude-opus-4-8`, with `us-gov.`, `eu.`,
 * `apac.`, `jp.`, `au.` or `global.`), a Mantle or foundation model ID (`anthropic.claude-haiku-4-5`), or an
 * application inference profile ARN (`arn:aws:bedrock:…`), per https://code.claude.com/docs/en/amazon-bedrock.
 * An Anthropic API model ID (`claude-opus-5-5`) has no `anthropic.` prefix.
 */
export const isBedrockModelId = (model: string): boolean =>
  /^(?:(?:us|us-gov|eu|apac|jp|au|global)\.)?anthropic\./.test(model) || /^arn:aws[a-z-]*:bedrock:/.test(model);

/** What one session file says the session cost, as of its last save. */
export type SessionCost =
  | { readonly kind: "cost"; readonly sessionId: string; readonly costUsd: number; readonly lastActiveAt: number; readonly partial: boolean; readonly models: ReadonlyArray<string> }
  | { readonly kind: "none" }
  | { readonly kind: "changed"; readonly issue: SchemaIssue.Issue };

/** Session files written to since `since`: `projects/<project>/<session id>.jsonl`. Subagents' files are a level deeper and hold no cost. */
function* sessionFilesSince(projects: string, since: number): Generator<{ readonly path: string; readonly modifiedAt: number }> {
  if (!isDirectory(projects)) return;
  for (const project of readdirSync(projects)) {
    const dir = join(projects, project);
    if (!isDirectory(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".jsonl")) continue;
      const path = join(dir, entry);
      const modifiedAt = statSync(path).mtimeMs;
      if (modifiedAt >= since) yield { path, modifiedAt };
    }
  }
}

const CostState = Schema.Struct({
  type: Schema.Literal("cost-state"),
  sessionId: Schema.String,
  totalCostUSD: Schema.Finite,
  modelUsage: Schema.Record(Schema.String, Schema.Unknown),
  hasUnknownModelCost: Schema.optionalKey(Schema.Boolean),
});

/** Session files keep growing while a session runs; one unchanged since it was last read is not read again. */
const sessionCostCache = new Map<string, { readonly modifiedAt: number; readonly cost: SessionCost }>();

/** The daemon runs for weeks; files Claude Code deleted, or that left the period, leave the cache too. */
function forgetOtherSessionFiles(projects: string, current: ReadonlySet<string>): void {
  for (const path of sessionCostCache.keys()) {
    if (path.startsWith(projects + sep) && !current.has(path)) sessionCostCache.delete(path);
  }
}

/**
 * The cost a session file last saved, and when the session was last active before that save: the time of the
 * nearest earlier line that has one, since the cost line itself carries no time.
 */
export function latestSessionCost(file: { readonly path: string; readonly modifiedAt: number }): SessionCost {
  const cached = sessionCostCache.get(file.path);
  if (cached !== undefined && cached.modifiedAt === file.modifiedAt) return cached.cost;
  let found: Extract<SessionCost, { kind: "cost" }> | undefined;
  let cost: SessionCost = { kind: "none" };
  for (const line of linesFromEnd(file.path, CLAUDE_TAIL_BYTES)) {
    if (found === undefined) {
      // Cheap test first: only the cost line is worth parsing until it is found.
      if (!line.includes("\"cost-state\"")) continue;
      const entry = parseJson(line);
      if (typeof entry !== "object" || entry === null || !("type" in entry) || entry.type !== "cost-state") continue;
      const decoded = Schema.decodeUnknownResult(CostState)(entry);
      if (Result.isFailure(decoded)) {
        cost = { kind: "changed", issue: decoded.failure.issue };
        break;
      }
      const state = decoded.success;
      found = {
        kind: "cost",
        sessionId: state.sessionId,
        costUsd: state.totalCostUSD,
        lastActiveAt: file.modifiedAt,
        partial: state.hasUnknownModelCost === true,
        models: Object.keys(state.modelUsage),
      };
      cost = found;
      continue;
    }
    if (!line.includes("\"timestamp\"")) continue;
    const entry = parseJson(line);
    const at = typeof entry === "object" && entry !== null && "timestamp" in entry && typeof entry.timestamp === "string"
      ? Date.parse(entry.timestamp)
      : NaN;
    if (Number.isFinite(at)) {
      cost = { ...found, lastActiveAt: at };
      break;
    }
  }
  sessionCostCache.set(file.path, { modifiedAt: file.modifiedAt, cost });
  return cost;
}

/**
 * The sum over sessions last active within the period. A session's saved cost covers the whole session, so
 * a resumed one counts once, at its latest save, and a session forked from another carries the cost it
 * started with, so the sum can count that part twice.
 */
export function estimateSpend(input: { readonly sessions: ReadonlyArray<SessionCost>; readonly bedrockSetting: boolean; readonly now: number }): Reading {
  const changed = input.sessions.find((session) => session.kind === "changed");
  if (changed !== undefined) return unknownShape("Claude Code's session cost record", changed.issue);
  const since = input.now - PERIOD_DAYS * DAY_MS;
  const bySession = new Map<string, Extract<SessionCost, { kind: "cost" }>>();
  for (const session of input.sessions) {
    if (session.kind !== "cost" || session.lastActiveAt < since) continue;
    const seen = bySession.get(session.sessionId);
    if (seen === undefined || session.costUsd > seen.costUsd) bySession.set(session.sessionId, session);
  }
  const counted = [...bySession.values()];
  if (counted.length === 0) return { state: "none" };
  const usd = counted.reduce((sum, session) => sum + session.costUsd, 0);
  return {
    state: "estimate",
    asOf: Math.max(...counted.map((session) => session.lastActiveAt)),
    periodDays: PERIOD_DAYS,
    spent: { amountMinor: Math.round(usd * 100), currency: "USD", exponent: 2 },
    sessions: counted.length,
    partial: counted.some((session) => session.partial),
    provider: input.bedrockSetting || counted.some((session) => session.models.some(isBedrockModelId)) ? "bedrock" : null,
  };
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
  if (Result.isFailure(decoded)) return unknownShape("Claude Code's usage cache", decoded.failure.issue);
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
