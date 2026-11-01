import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { Result, Schema, SchemaIssue } from "effect";
import type { AccountIdentity, AccountLimits, LocalUse, Money, UsageWindow } from "../wire";
import {
  CLI_TIMEOUT_MS, DAY_MS, PERIOD_DAYS, homesNamed, isDirectory, linesFromEnd, parseJson, unknownShape, windowName,
  type AccountContext, type AccountReading, type AgentTool,
} from "./agent-tool";
import { runCommand } from "./command";

/**
 * Claude Code. Each account is a `CLAUDE_CONFIG_DIR` (`~/.claude`, `~/.claude-<name>`), and reads its
 * user skills from the `skills` folder inside it.
 *
 * - Account: `claude auth status` says who is signed in (email, organization, plan), and `claude -p /usage`
 *   prints the plan limits Claude Code fetches from Anthropic for the account, which count every
 *   machine's use. Neither starts a model turn. When `claude` cannot be found or fails, the limits come
 *   from the plan usage Claude Code last fetched and keeps in the account's `.claude.json`
 *   (`cachedUsageUtilization`, refreshed about every five minutes while a session runs), and who is
 *   signed in from the same file's `oauthAccount`.
 * - This machine: Claude Code computes each session's cost locally from token counts at list price, the
 *   figure `/usage` shows as a session's total cost (https://code.claude.com/docs/en/costs), and saves it
 *   as a `cost-state` line in the session's file under `projects/`. The sum over recent sessions is the
 *   machine's use of the account, whatever the plan.
 *
 * No credential file is read: the CLI makes the authenticated calls. `/usage`'s text and both files are
 * not published formats, so a shape this code does not recognise is reported as `unknown`.
 */
export const claude: AgentTool = {
  tool: "claude",
  skillsFolders: (home) => homesNamed(home, "claude").map((account) => join(account, "skills")),
  accounts: (home) => homesNamed(home, "claude"),
  readAccount: (account, context) => readClaudeAccount(account, context),
  readLocalUse: (account, home, now) => readClaudeLocalUse(account, home, now),
};

/**
 * The default account keeps its state in `~/.claude.json`, beside its folder rather than in it; an
 * account given its own `CLAUDE_CONFIG_DIR` keeps it inside that folder.
 */
export function claudeStatePath(accountPath: string, home: string): string {
  return accountPath === join(home, ".claude") ? join(home, ".claude.json") : join(accountPath, ".claude.json");
}

const accountUsesBedrock = (accountPath: string): boolean => {
  const settingsPath = join(accountPath, "settings.json");
  return existsSync(settingsPath) && settingsUseBedrock(readFileSync(settingsPath, "utf-8"));
};

// ── The account ─────────────────────────────────────────────────────────────────────────────────────

async function readClaudeAccount(accountPath: string, { home, now, findCommand }: AccountContext): Promise<AccountReading> {
  if (accountUsesBedrock(accountPath)) {
    return { identity: null, limits: { state: "none", reason: "Amazon Bedrock has no plan limits" } };
  }
  const command = findCommand({ name: "claude", also: [join(home, ".claude", "local", "claude")] });
  if (command === undefined) return savedAccount(accountPath, home, "`claude` was not found");
  // The default account is the one Claude Code uses with no CLAUDE_CONFIG_DIR: setting it to `~/.claude`
  // would move its state from `~/.claude.json` into the folder.
  const { CLAUDE_CONFIG_DIR: _inherited, ...env } = process.env;
  const run = (args: ReadonlyArray<string>) => runCommand({
    command,
    args,
    env: { ...env, ...(accountPath === join(home, ".claude") ? {} : { CLAUDE_CONFIG_DIR: accountPath }), DISABLE_AUTOUPDATER: "1" },
    // Away from any project, so no project's settings or hooks apply.
    cwd: tmpdir(),
    timeoutMs: CLI_TIMEOUT_MS,
  });
  const [auth, usage] = await Promise.all([
    run(["auth", "status"]),
    // Not saved as a session, so it adds nothing to the account's session files or to this machine's use.
    run(["-p", "/usage", "--no-session-persistence"]),
  ]);
  // Signed out, it still prints its JSON, and exits 1.
  const status = auth.failure === undefined ? parseAuthStatus(auth.stdout) : undefined;
  if (status === undefined || (status.kind === "changed" && auth.status !== 0)) {
    return savedAccount(accountPath, home, `\`claude auth status\` failed: ${auth.failure ?? (auth.stderr.trim().slice(0, 160) || `exit ${auth.status}`)}`);
  }
  if (status.kind === "changed") return { identity: null, limits: status.limits };
  if (status.kind === "signedOut") return { identity: null, limits: { state: "none", reason: "signed out" } };
  if (status.kind === "noPlan") return { identity: status.identity, limits: { state: "none", reason: status.reason } };
  if (usage.failure !== undefined || usage.status !== 0) {
    const saved = savedAccount(accountPath, home, `\`claude -p /usage\` failed: ${usage.failure ?? (usage.stderr.trim().slice(0, 160) || `exit ${usage.status}`)}`);
    return { identity: status.identity, limits: saved.limits };
  }
  return { identity: status.identity, limits: parseUsageOutput(usage.stdout, now) };
}

const AuthStatus = Schema.Struct({
  loggedIn: Schema.Boolean,
  authMethod: Schema.optionalKey(Schema.String),
  apiProvider: Schema.optionalKey(Schema.String),
  email: Schema.optionalKey(Schema.NullOr(Schema.String)),
  orgId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  subscriptionType: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

export type AuthStatus =
  | { readonly kind: "subscription"; readonly identity: AccountIdentity }
  /** Signed in another way (an API key, a cloud provider): no plan limits to read. */
  | { readonly kind: "noPlan"; readonly identity: AccountIdentity | null; readonly reason: string }
  | { readonly kind: "signedOut" }
  | { readonly kind: "changed"; readonly limits: AccountLimits };

/** What `claude auth status` prints: JSON naming the sign-in method, and for claude.ai the account. */
export function parseAuthStatus(stdout: string): AuthStatus {
  const decoded = Schema.decodeUnknownResult(AuthStatus)(parseJson(stdout.trim()));
  if (Result.isFailure(decoded)) return { kind: "changed", limits: unknownShape("`claude auth status` output", decoded.failure.issue) };
  const status = decoded.success;
  if (!status.loggedIn) return { kind: "signedOut" };
  const identity: AccountIdentity | null = typeof status.orgId === "string" && typeof status.email === "string"
    ? { id: status.orgId, email: status.email, plan: status.subscriptionType ?? null }
    : null;
  if (status.authMethod !== "claude.ai" || identity === null) {
    return { kind: "noPlan", identity, reason: `signed in with ${status.authMethod ?? status.apiProvider ?? "an API key"}: no plan limits` };
  }
  return { kind: "subscription", identity };
}

/**
 * One limit line of `/usage`, as Claude Code 2.1.316 prints it:
 * `Current week (all models): 21% used · resets Nov 3 at 4pm (America/Los_Angeles)`. The reset part is
 * absent while no window is running.
 */
const USAGE_LINE = /^Current (session|day|week|month)(?: \(([^)]+)\))?: (\d+(?:\.\d+)?)% used(?: · resets (.+) \(([^()]+)\))?$/;

/** The plan limits `claude -p /usage` prints, each line one limit. */
export function parseUsageOutput(stdout: string, now: number): AccountLimits {
  const windows: UsageWindow[] = [];
  for (const raw of stdout.split("\n")) {
    const match = USAGE_LINE.exec(raw.trim());
    if (match === null) continue;
    const [, period, scope, used, resets, timeZone] = match;
    // A session is Claude's 5-hour limit.
    const minutes = period === "session" ? 300 : period === "day" ? 24 * 60 : period === "week" ? 7 * 24 * 60 : null;
    let resetsAt: number | null = null;
    if (resets !== undefined && timeZone !== undefined) {
      const parsed = parseResetTime({ text: resets, timeZone, now });
      if (parsed === undefined) return { state: "unknown", reason: `\`claude /usage\` changed shape: reset time "${resets} (${timeZone})"` };
      resetsAt = parsed;
    }
    const base = period === "month" ? "monthly" : windowName(minutes);
    windows.push({ name: scope === undefined || scope === "all models" ? base : `${base} ${scope}`, minutes, usedPercent: Number(used), resetsAt });
  }
  if (windows.length === 0) {
    return { state: "unknown", reason: `\`claude /usage\` changed shape: no "Current …: N% used" line in "${stdout.trim().slice(0, 120)}"` };
  }
  return { state: "reading", asOf: now, source: "account", windows };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** `Nov 3 at 4pm`, `Nov 1 at 3:40am`, `Nov 3, 2027 at 4pm`, or a time alone for later today. */
const RESET_TIME = /^(?:([A-Z][a-z]{2}) (\d{1,2})(?:, (\d{4}))? at )?(\d{1,2})(?::(\d{2}))?(am|pm)$/;

/**
 * A reset time as `/usage` prints it, a wall-clock time in a named time zone, in milliseconds since the
 * epoch. Without a year, the year that puts it nearest to now; without a date, the next such time.
 * Undefined when it is not in that form or the zone is unknown.
 */
export function parseResetTime(input: { readonly text: string; readonly timeZone: string; readonly now: number }): number | undefined {
  const match = RESET_TIME.exec(input.text.trim());
  if (match === null) return undefined;
  const [, monthName, day, year, hour12, minute, meridiem] = match;
  const hour = (Number(hour12) % 12) + (meridiem === "pm" ? 12 : 0);
  let today: { year: number; month: number; day: number };
  try {
    today = wallClock(input.now, input.timeZone);
  } catch {
    return undefined;
  }
  const at = (y: number, m: number, d: number) => zonedTime({ year: y, month: m, day: d, hour, minute: Number(minute ?? 0), timeZone: input.timeZone });
  if (monthName === undefined) {
    const sameDay = at(today.year, today.month, today.day);
    return sameDay >= input.now - 60_000 ? sameDay : at(today.year, today.month, today.day + 1);
  }
  const month = MONTHS.indexOf(monthName);
  if (month === -1) return undefined;
  if (year !== undefined) return at(Number(year), month, Number(day));
  return [today.year - 1, today.year, today.year + 1]
    .map((y) => at(y, month, Number(day)))
    .reduce((best, candidate) => Math.abs(candidate - input.now) < Math.abs(best - input.now) ? candidate : best);
}

/** The date and time in a time zone at an instant; month counted from 0, as `Date.UTC` takes it. Throws for an unknown zone. */
function wallClock(at: number, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
  }).formatToParts(new Date(at)).map((part) => [part.type, Number(part.value)]));
  return { year: parts.year!, month: parts.month! - 1, day: parts.day!, hour: parts.hour!, minute: parts.minute!, second: parts.second! };
}

/** The instant a wall-clock time in a time zone names: its UTC reading, moved by the zone's offset at that instant. */
function zonedTime(input: { year: number; month: number; day: number; hour: number; minute: number; timeZone: string }): number {
  const asUtc = Date.UTC(input.year, input.month, input.day, input.hour, input.minute);
  const offsetAt = (instant: number) => {
    const clock = wallClock(instant, input.timeZone);
    return Date.UTC(clock.year, clock.month, clock.day, clock.hour, clock.minute, clock.second) - Math.floor(instant / 1000) * 1000;
  };
  const guess = asUtc - offsetAt(asUtc);
  // Across a daylight-saving change the offset at the guess can differ from the one first assumed.
  return asUtc - offsetAt(guess);
}

/** The account as the account's `.claude.json` last recorded it, for when the CLI cannot be asked. */
function savedAccount(accountPath: string, home: string, why: string): AccountReading {
  const statePath = claudeStatePath(accountPath, home);
  if (!existsSync(statePath)) return { identity: null, limits: { state: "unknown", reason: why } };
  const saved = parseClaudeState(readFileSync(statePath, "utf-8"));
  const limits: AccountLimits = saved.limits.state === "reading" ? { ...saved.limits, cliFailure: why }
    : saved.limits.state === "none" ? { state: "unknown", reason: why }
    : saved.limits;
  return { identity: saved.identity, limits };
}

// ── This machine's use ──────────────────────────────────────────────────────────────────────────────

function readClaudeLocalUse(accountPath: string, _home: string, now: number): LocalUse {
  const projects = join(accountPath, "projects");
  const files = [...sessionFilesSince(projects, now - PERIOD_DAYS * DAY_MS)];
  forgetOtherSessionFiles(projects, new Set(files.map((file) => file.path)));
  return estimateSpend({ sessions: files.map(latestSessionCost), bedrockSetting: accountUsesBedrock(accountPath), now });
}

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
export function estimateSpend(input: { readonly sessions: ReadonlyArray<SessionCost>; readonly bedrockSetting: boolean; readonly now: number }): LocalUse {
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
    state: "spend",
    asOf: Math.max(...counted.map((session) => session.lastActiveAt)),
    periodDays: PERIOD_DAYS,
    spent: { amountMinor: Math.round(usd * 100), currency: "USD", exponent: 2 },
    sessions: counted.length,
    partial: counted.some((session) => session.partial),
    provider: input.bedrockSetting || counted.some((session) => session.models.some(isBedrockModelId)) ? "bedrock" : null,
  };
}

// ── The saved record, when the CLI cannot be asked ──────────────────────────────────────────────────

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
const OAuthAccount = Schema.Struct({ emailAddress: Schema.String, organizationUuid: Schema.String });

/** Claude's documented window lengths: its status line calls them the 5-hour and 7-day limits. */
const CLAUDE_WINDOWS = [["five_hour", 300], ["seven_day", 7 * 24 * 60]] as const;

/**
 * The account and its plan usage as Claude Code last recorded them in the account's `.claude.json`: who
 * signed in under `oauthAccount`, the usage it last fetched under `cachedUsageUtilization`.
 */
export function parseClaudeState(text: string): AccountReading {
  let state: unknown;
  try {
    state = JSON.parse(text);
  } catch {
    // Claude Code rewrites the file while it runs; a half-written one reads fine a moment later.
    return { identity: null, limits: { state: "unknown", reason: "the account's .claude.json is not valid JSON" } };
  }
  if (typeof state !== "object" || state === null) return { identity: null, limits: { state: "none", reason: "no usage recorded" } };
  const account = Schema.decodeUnknownOption(OAuthAccount)("oauthAccount" in state ? state.oauthAccount : undefined);
  const identity: AccountIdentity | null = account._tag === "Some"
    ? { id: account.value.organizationUuid, email: account.value.emailAddress, plan: null }
    : null;
  if (!("cachedUsageUtilization" in state)) return { identity, limits: { state: "none", reason: "no usage recorded" } };
  const decoded = Schema.decodeUnknownResult(ClaudeUsageCache)(state.cachedUsageUtilization);
  if (Result.isFailure(decoded)) return { identity, limits: unknownShape("Claude Code's usage cache", decoded.failure.issue) };
  const cache = decoded.success;

  const windows: UsageWindow[] = [];
  for (const [key, minutes] of CLAUDE_WINDOWS) {
    const window = cache.utilization[key];
    if (window === undefined || window === null) continue;
    const resetsAt = window.resets_at === null ? null : Date.parse(window.resets_at);
    if (resetsAt !== null && !Number.isFinite(resetsAt)) {
      return { identity, limits: { state: "unknown", reason: `Claude Code's usage cache changed shape: ${key}.resets_at is not a time` } };
    }
    windows.push({ name: windowName(minutes), minutes, usedPercent: window.utilization, resetsAt });
  }

  const spend = cache.utilization.spend;
  const limit = Schema.decodeUnknownOption(ClaudeMoney)(spend?.limit);
  return {
    identity,
    limits: {
      state: "reading",
      asOf: cache.fetchedAtMs,
      source: "saved",
      windows,
      ...(spend?.enabled === true
        ? { spent: { used: money(spend.used), limit: limit._tag === "Some" ? money(limit.value) : null } }
        : {}),
    },
  };
}

const money = (value: Schema.Schema.Type<typeof ClaudeMoney>): Money =>
  ({ amountMinor: value.amount_minor, currency: value.currency, exponent: value.exponent });
