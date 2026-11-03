import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountLimits, AccountUsage, LocalUse } from "../wire";
import { PERIOD_DAYS, linesFromEnd, type AccountContext } from "./agent-tool";
import {
  claude, claudeStatePath, estimateSpend, isBedrockModelId, latestSessionCost, parseAuthStatus, parseClaudeState, parseResetTime,
  parseUsageOutput, settingsUseBedrock, type SessionCost,
} from "./claude";
import { codex, extensionBinaries, parseAppServerAnswers, parseCodexLine } from "./codex";
import { grok, parseBillingAnswer, parseGrokUsage } from "./grok";
import { ACCOUNT_READ_MS, readUsage } from ".";

/**
 * Pins how account folders are found and how each tool's usage record is read. The records below are
 * trimmed copies of real ones (account ids replaced): Claude Code 2.1.310's `cachedUsageUtilization` and
 * session-file `cost-state` line, Claude Code 2.1.316's `claude -p /usage` and `claude auth status`, a Codex
 * `token_count` event, `codex app-server` answers from Codex 0.151 and 0.166, and `grok usage` output from
 * Grok 1.0.70. When a tool changes its format, these show what this version expected.
 */

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "skill-sync-usage-test-"));
  homes.push(home);
  return home;
}
function write(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

const claudeWindow = (utilization: number, resetsAt: string | null) =>
  ({ utilization, resets_at: resetsAt, limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null });
const claudeCache = (spend: unknown = {
  used: { amount_minor: 0, currency: "USD", exponent: 2 }, limit: null, percent: 0, severity: "normal", enabled: false,
}) => ({
  fetchedAtMs: 1793019227405,
  accountUuid: "00000000-0000-4000-8000-000000000000",
  utilization: {
    five_hour: claudeWindow(48, "2026-10-26T20:00:00.082603+00:00"),
    seven_day: claudeWindow(29, "2026-10-28T00:00:00.376082+00:00"),
    seven_day_opus: null,
    iguana_necktie: { utilization: 0, resets_at: "2026-11-05T07:59:00+00:00", limit_dollars: 250, used_dollars: 0, remaining_dollars: 250, locked_reason: null },
    limits: [{ kind: "weekly_all", group: "weekly", percent: 29, severity: "normal", resets_at: "2026-10-28T00:00:00.376082+00:00", scope: null, is_active: true }],
    extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null },
    spend,
  },
});
const claudeState = (cache: unknown) => JSON.stringify({ numStartups: 3, cachedUsageUtilization: cache });
/** The account as `claudeCache()` records it, read because the CLI could not be asked, for `cliFailure`. */
const savedClaude = (cliFailure: string) => {
  const saved = parseClaudeState(claudeState(claudeCache()));
  return { identity: saved.identity, limits: { ...saved.limits, cliFailure } };
};

const codexLine = (rateLimits: unknown, timestamp = "2026-09-05T19:40:38.460Z") => JSON.stringify({
  timestamp,
  type: "event_msg",
  payload: {
    type: "token_count",
    info: { total_token_usage: { input_tokens: 287110255, output_tokens: 1055172, total_tokens: 288165427 }, model_context_window: 258400 },
    rate_limits: rateLimits,
  },
});
const codexLimits = {
  limit_id: "codex",
  limit_name: null,
  primary: { used_percent: 24.0, window_minutes: 300, resets_at: 1788652301 },
  secondary: { used_percent: 16.0, window_minutes: 10080, resets_at: 1789170646 },
  credits: { has_credits: false, unlimited: false, balance: "0" },
  individual_limit: null,
  spend_control_reached: null,
  plan_type: "plus",
  rate_limit_reached_type: null,
};
const codexReading: AccountLimits = {
  state: "reading",
  asOf: Date.parse("2026-09-05T19:40:38.460Z"),
  source: "saved",
  windows: [
    { name: "5-hour", minutes: 300, usedPercent: 24, resetsAt: 1788652301000 },
    { name: "weekly", minutes: 10080, usedPercent: 16, resetsAt: 1789170646000 },
  ],
};

test("each tool's account folders are its .<tool> and .<tool>-* directories, never locks, files or look-alikes", () => {
  const home = makeHome();
  for (const dir of [".claude", ".claude-work", ".claude-work.lock", ".codex", ".codex-team", ".codexish", ".grok", ".grok-x", ".grokish", ".agents", ".config"]) {
    mkdirSync(join(home, dir));
  }
  write(join(home, ".claude.json"), "{}");
  write(join(home, ".claude-notes"), "a file, not an account");
  expect(claude.accounts(home)).toEqual([join(home, ".claude"), join(home, ".claude-work")]);
  expect(codex.accounts(home)).toEqual([join(home, ".codex"), join(home, ".codex-team")]);
  expect(grok.accounts(home)).toEqual([join(home, ".grok"), join(home, ".grok-x")]);
});

test("the default Claude account keeps its state beside its folder; others inside theirs", () => {
  expect(claudeStatePath("/h/.claude", "/h")).toBe("/h/.claude.json");
  expect(claudeStatePath("/h/.claude-work", "/h")).toBe("/h/.claude-work/.claude.json");
});

test("Claude's usage cache reads as the 5-hour and weekly windows, as of when Claude Code fetched it, and names the account", () => {
  expect(parseClaudeState(claudeState(claudeCache())).limits).toEqual({
    state: "reading",
    asOf: 1793019227405,
    source: "saved",
    windows: [
      { name: "5-hour", minutes: 300, usedPercent: 48, resetsAt: Date.parse("2026-10-26T20:00:00.082Z") },
      { name: "weekly", minutes: 10080, usedPercent: 29, resetsAt: Date.parse("2026-10-28T00:00:00.376Z") },
    ],
  });
  const signedIn = JSON.stringify({ oauthAccount: { emailAddress: "a@example.com", organizationUuid: "org-1", billingType: "stripe_subscription" } });
  expect(parseClaudeState(signedIn)).toEqual({
    identity: { id: "org-1", email: "a@example.com", plan: null },
    limits: { state: "none", reason: "no usage recorded" },
  });
});

test("a Claude window that has not started has no reset time", () => {
  const cache = claudeCache();
  cache.utilization.five_hour = claudeWindow(0, null);
  const reading = parseClaudeState(claudeState(cache)).limits;
  expect(reading.state === "reading" && reading.windows[0]).toEqual({ name: "5-hour", minutes: 300, usedPercent: 0, resetsAt: null });
});

test("Claude usage credits show as money spent once they are on", () => {
  const used = { amount_minor: 1234, currency: "USD", exponent: 2 };
  const on = parseClaudeState(claudeState(claudeCache({ used, limit: null, enabled: true }))).limits;
  expect(on.state === "reading" && on.spent).toEqual({ used: { amountMinor: 1234, currency: "USD", exponent: 2 }, limit: null });
  const capped = parseClaudeState(claudeState(claudeCache({ used, limit: { amount_minor: 5000, currency: "USD", exponent: 2 }, enabled: true }))).limits;
  expect(capped.state === "reading" && capped.spent?.limit).toEqual({ amountMinor: 5000, currency: "USD", exponent: 2 });
  const off = parseClaudeState(claudeState(claudeCache())).limits;
  expect(off.state === "reading" && "spent" in off).toBe(false);
});

test("a Claude account that never fetched usage has none; a changed cache is unknown, not guessed", () => {
  expect(parseClaudeState(JSON.stringify({ numStartups: 1 })).limits).toEqual({ state: "none", reason: "no usage recorded" });
  const renamed = parseClaudeState(claudeState({ fetchedAtMs: 1793019227405, usage: {} })).limits;
  expect(renamed.state).toBe("unknown");
  expect(renamed.state === "unknown" && renamed.reason).toContain("Claude Code's usage cache changed shape");
  const retyped = claudeCache();
  (retyped.utilization.seven_day as { utilization: unknown }).utilization = "29%";
  expect(parseClaudeState(claudeState(retyped)).limits.state).toBe("unknown");
  expect(parseClaudeState("{\"cachedUsage").limits.state).toBe("unknown");
});

test("a Codex token_count event reads as its primary and secondary windows, as of the event, and the session's token total", () => {
  expect(parseCodexLine(codexLine(codexLimits))).toEqual({ limits: codexReading, tokens: 288165427 });
});

test("Codex lines without a main-bucket reading carry no limits; a changed record is unknown", () => {
  expect(parseCodexLine(JSON.stringify({ timestamp: "2026-09-05T19:40:38Z", type: "event_msg", payload: { type: "agent_message" } }))).toBeUndefined();
  expect(parseCodexLine(codexLine(null))).toEqual({ limits: undefined, tokens: 288165427 });
  expect(parseCodexLine(codexLine({ ...codexLimits, limit_id: "codex_other" }))?.limits).toBeUndefined();
  expect(parseCodexLine(codexLine({ ...codexLimits, limit_id: undefined }))?.limits).toEqual(codexReading);
  expect(parseCodexLine(codexLine({ ...codexLimits, primary: { ...codexLimits.primary, used_percent: "24%" } }))?.limits?.state).toBe("unknown");
  expect(parseCodexLine("{\"payload\":{\"type\":\"token_count\"")).toBeUndefined();
});

test("skills folders: each Claude and Grok account's own, and ~/.agents/skills for Codex", () => {
  const home = makeHome();
  for (const dir of [".claude-work", ".grok", ".codex"]) mkdirSync(join(home, dir));
  expect(claude.skillsFolders(home)).toEqual([join(home, ".claude-work/skills")]);
  expect(grok.skillsFolders(home)).toEqual([join(home, ".grok/skills")]);
  expect(codex.skillsFolders(home)).toEqual([join(home, ".agents/skills")]);
  rmSync(join(home, ".codex"), { recursive: true });
  expect(codex.skillsFolders(home)).toEqual([]);
  mkdirSync(join(home, ".agents"));
  expect(codex.skillsFolders(home)).toEqual([join(home, ".agents/skills")]);
});

test("`grok usage` output reads as the session's cost in dollars; a changed shape is a failure, not a guess", () => {
  const output = JSON.stringify({
    sessionId: "01a19510-a3f3-7a92-9cc9-2d101601fc53",
    updatedAt: "2026-11-01T05:26:28.177797+00:00",
    session: { inputTokens: 1845685, outputTokens: 23693, totalTokens: 1869378, modelCalls: 26, costUsdTicks: 13671040000, turnCount: 10 },
    turns: [],
  });
  expect(parseGrokUsage(output)).toEqual({ kind: "totals", usd: 1.367104, updatedAt: Date.parse("2026-11-01T05:26:28.177Z") });
  expect(parseGrokUsage(JSON.stringify({ sessionId: "x", updatedAt: "2026-11-01T05:26:28Z", session: { costUsd: 1 } })).kind).toBe("failed");
});

test("lines come back last first, across chunk boundaries, skipping lines too long to hold", () => {
  const home = makeHome();
  const lines = ["first", "x".repeat(100_000), "y".repeat(70_000), "short", "z".repeat(3_000_000), "last"];
  write(join(home, "f.jsonl"), `${lines.join("\n")}\n`);
  expect([...linesFromEnd(join(home, "f.jsonl"), Infinity)]).toEqual(["last", "short", "y".repeat(70_000), "x".repeat(100_000), "first"]);
  expect([...linesFromEnd(join(home, "f.jsonl"), 10)]).toEqual(["last"]);
});

test("without a CLI, limits come from the tools' saved records; Codex's latest may sit in an older session file", async () => {
  const home = makeHome();
  write(join(home, ".claude-work/.claude.json"), claudeState(claudeCache()));
  mkdirSync(join(home, ".claude"));
  write(join(home, ".claude-broken/.claude.json"), claudeState({ fetchedAtMs: "yesterday" }));
  const sessions = join(home, ".codex/sessions/2026");
  const older = join(sessions, "09/05/rollout-2026-09-05T10-00-00-a.jsonl");
  const newer = join(sessions, "09/06/rollout-2026-09-06T10-00-00-b.jsonl");
  write(older, [codexLine(codexLimits), "z".repeat(2_000_000), JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } })].join("\n"));
  // A later session run with an API key: its events report no plan limits.
  write(newer, `${codexLine(null, "2026-09-06T10:00:00Z")}\n`);
  utimesSync(older, new Date(1_000_000), new Date(1_000_000));
  utimesSync(newer, new Date(NOW - DAY), new Date(NOW - DAY));
  mkdirSync(join(home, ".codex-empty"));

  const noTokens: LocalUse = { state: "tokens", periodDays: PERIOD_DAYS, count: 0, sessions: 0 };
  expect(await readUsage({ home, now: NOW, findCommand: () => undefined })).toEqual([
    { tool: "claude", home: ".claude", identity: null, limits: { state: "unknown", reason: "`claude` was not found" }, local: { state: "none" } },
    expect.objectContaining({ tool: "claude", home: ".claude-broken", limits: expect.objectContaining({ state: "unknown" }) }),
    { tool: "claude", home: ".claude-work", ...savedClaude("`claude` was not found"), local: { state: "none" } },
    // The older file is outside the period, so only the newer one's tokens count; its limits are still the latest Codex recorded.
    { tool: "codex", home: ".codex", identity: null, limits: { ...codexReading, cliFailure: "`codex` was not found" }, local: { ...noTokens, count: 288165427, sessions: 1 } },
    { tool: "codex", home: ".codex-empty", identity: null, limits: { state: "unknown", reason: "`codex` was not found" }, local: noTokens },
  ]);
});

// ── Claude without plan limits ──────────────────────────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-26T18:00:00Z");

const costState = (sessionId: string, totalCostUSD: number, models: ReadonlyArray<string> = ["claude-opus-5-5"], hasUnknownModelCost = false) => JSON.stringify({
  type: "cost-state",
  sessionId,
  totalCostUSD,
  totalAPIDuration: 116014,
  totalAPIDurationWithoutRetries: 115938,
  totalToolDuration: 25905,
  totalLinesAdded: 0,
  totalLinesRemoved: 0,
  totalDuration: 5546949,
  startTime: 1792959472233,
  modelUsage: Object.fromEntries(models.map((model) => [model, {
    inputTokens: 32, outputTokens: 5771, thinkingTokens: 1991, cacheReadInputTokens: 732663, cacheCreationInputTokens: 77977,
    webSearchRequests: 0, costUSD: totalCostUSD / models.length,
  }])),
  hasUnknownModelCost,
});
const assistantAt = (timestamp: string) => JSON.stringify({
  type: "assistant", timestamp, sessionId: "s", message: { role: "assistant", content: [{ type: "text", text: "a reply that mentions \"cost-state\"" }] },
});
/** The tail Claude Code leaves when a session ends: the last reply, the last prompt, the cost, then a queue entry. */
const sessionFile = (sessionId: string, cost: number, lastReplyAt: string, models?: ReadonlyArray<string>) => [
  assistantAt("2026-10-20T10:00:00.000Z"),
  costState(sessionId, cost / 2, models),
  assistantAt(lastReplyAt),
  JSON.stringify({ type: "last-prompt", lastPrompt: "thanks" }),
  costState(sessionId, cost, models),
  JSON.stringify({ type: "queue-operation", operation: "dequeue", timestamp: "2026-10-26T17:59:00.000Z" }),
].join("\n") + "\n";
/** Writes a session file and dates it, as Claude Code's writes would have. */
function writeSession(path: string, text: string, modifiedAt: number): void {
  write(path, text);
  utimesSync(path, new Date(modifiedAt), new Date(modifiedAt));
}

test("Bedrock is on when the account's settings env turns on Bedrock or Mantle", () => {
  expect(settingsUseBedrock(JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "us-east-1" } }))).toBe(true);
  expect(settingsUseBedrock(JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: "true" } }))).toBe(true);
  expect(settingsUseBedrock(JSON.stringify({ env: { CLAUDE_CODE_USE_MANTLE: "1" } }))).toBe(true);
  expect(settingsUseBedrock(JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: "0" } }))).toBe(false);
  expect(settingsUseBedrock(JSON.stringify({ theme: "dark" }))).toBe(false);
  expect(settingsUseBedrock("{ not json")).toBe(false);
});

test("Bedrock model IDs are inference profiles, Mantle and foundation IDs, and ARNs; Anthropic API IDs are not", () => {
  for (const id of [
    "us.anthropic.claude-opus-4-8", "global.anthropic.claude-opus-5-5", "us-gov.anthropic.claude-sonnet-4-6",
    "eu.anthropic.claude-sonnet-4-5-20250929-v1:0", "apac.anthropic.claude-haiku-4-5-20251001-v1:0", "anthropic.claude-haiku-4-5",
    "arn:aws:bedrock:us-east-2:123456789012:application-inference-profile/opus-47-prod",
    "arn:aws-us-gov:bedrock:us-gov-west-1:123456789012:inference-profile/x",
  ]) expect([id, isBedrockModelId(id)]).toEqual([id, true]);
  for (const id of ["claude-opus-5-5", "claude-opus-5[1m]", "claude-haiku-5-5", "openai.gpt-x"]) {
    expect([id, isBedrockModelId(id)]).toEqual([id, false]);
  }
});

test("a session's cost is its last saved one, as of the last line with a time before it", () => {
  const home = makeHome();
  const path = join(home, "s.jsonl");
  writeSession(path, sessionFile("s1", 0.8943611, "2026-10-26T00:13:00.991Z"), NOW);
  expect(latestSessionCost({ path, modifiedAt: NOW })).toEqual({
    kind: "cost", sessionId: "s1", costUsd: 0.8943611, lastActiveAt: Date.parse("2026-10-26T00:13:00.991Z"), partial: false, models: ["claude-opus-5-5"],
  });
  // A session that never ended has no cost line yet; a reply quoting one is not one.
  const running = join(home, "running.jsonl");
  writeSession(running, `${assistantAt("2026-10-26T00:13:00.991Z")}\n`, NOW);
  expect(latestSessionCost({ path: running, modifiedAt: NOW })).toEqual({ kind: "none" });
  const changed = join(home, "changed.jsonl");
  writeSession(changed, `${JSON.stringify({ type: "cost-state", sessionId: "s2", totalCostUSD: "$1" })}\n`, NOW);
  expect(latestSessionCost({ path: changed, modifiedAt: NOW }).kind).toBe("changed");
});

const cost = (sessionId: string, costUsd: number, lastActiveAt: number, models: ReadonlyArray<string> = ["claude-opus-5-5"], partial = false): SessionCost =>
  ({ kind: "cost", sessionId, costUsd, lastActiveAt, partial, models });

test("spend sums each session once over the period, as of the newest, in cents", () => {
  expect(estimateSpend({
    sessions: [
      cost("a", 1.005, NOW - 2 * DAY),
      cost("b", 2.5, NOW - DAY),
      cost("b", 2.0, NOW - 3 * DAY), // a copy of b saved earlier: the larger, later total wins
      cost("old", 100, NOW - (PERIOD_DAYS + 1) * DAY),
      { kind: "none" },
    ],
    bedrockSetting: false,
    now: NOW,
  })).toEqual({
    state: "spend", asOf: NOW - DAY, periodDays: PERIOD_DAYS, spent: { amountMinor: 351, currency: "USD", exponent: 2 },
    sessions: 2, partial: false, provider: null,
  });
  expect(estimateSpend({ sessions: [cost("old", 100, NOW - 40 * DAY), { kind: "none" }], bedrockSetting: false, now: NOW })).toEqual({ state: "none" });
});

test("spend is Bedrock by its settings or its model IDs, and partial when a model had no price", () => {
  const read = (sessions: ReadonlyArray<SessionCost>, bedrockSetting: boolean) => {
    const reading = estimateSpend({ sessions, bedrockSetting, now: NOW });
    return reading.state === "spend" ? { provider: reading.provider, partial: reading.partial } : reading.state;
  };
  expect(read([cost("a", 1, NOW)], true)).toEqual({ provider: "bedrock", partial: false });
  expect(read([cost("a", 1, NOW, ["claude-opus-5-5"]), cost("b", 1, NOW, ["us.anthropic.claude-opus-5-5"])], false)).toEqual({ provider: "bedrock", partial: false });
  expect(read([cost("a", 1, NOW, ["claude-opus-5-5"], true)], false)).toEqual({ provider: null, partial: true });
  const changed = estimateSpend({ sessions: [cost("a", 1, NOW), latestChanged()], bedrockSetting: false, now: NOW });
  expect(changed.state === "unknown" && changed.reason).toContain("Claude Code's session cost record changed shape");
});
function latestChanged(): SessionCost {
  const home = makeHome();
  const path = join(home, "changed.jsonl");
  writeSession(path, `${JSON.stringify({ type: "cost-state", sessionId: "c", totalCostUSD: null })}\n`, NOW);
  return latestSessionCost({ path, modifiedAt: NOW });
}

test("every Claude account shows this machine's spend; an account with Bedrock on has no plan limits, whatever its cache says", async () => {
  const home = makeHome();
  const session = (account: string, id: string, usd: number, models?: ReadonlyArray<string>, modifiedAt = NOW - DAY) =>
    writeSession(join(home, account, "projects/-Users-x-repo", `${id}.jsonl`), sessionFile(id, usd, "2026-10-25T12:00:00.000Z", models), modifiedAt);

  // fox's case: the default account, Bedrock set in its settings, no plan cache.
  write(join(home, ".claude/settings.json"), JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: "1" } }));
  write(join(home, ".claude.json"), JSON.stringify({ numStartups: 4 }));
  session(".claude", "f1", 3.25);
  session(".claude", "f2", 1.5);
  session(".claude", "stale", 99, undefined, NOW - 45 * DAY);
  // Bedrock set only in a shell: the model IDs say so.
  session(".claude-shell", "s1", 0.75, ["us.anthropic.claude-opus-5-5"]);
  // A subscription: its limits, and its sessions' list-price cost too.
  write(join(home, ".claude-sub/.claude.json"), claudeState(claudeCache()));
  session(".claude-sub", "p1", 40);
  // Switched to Bedrock with an old plan cache left behind.
  write(join(home, ".claude-switched/.claude.json"), claudeState(claudeCache()));
  write(join(home, ".claude-switched/settings.json"), JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: "1" } }));

  const asOf = Date.parse("2026-10-25T12:00:00.000Z");
  const spend = (usd: number, sessions: number, provider: "bedrock" | null): LocalUse =>
    ({ state: "spend", asOf, periodDays: PERIOD_DAYS, spent: { amountMinor: Math.round(usd * 100), currency: "USD", exponent: 2 }, sessions, partial: false, provider });
  const bedrock: AccountLimits = { state: "none", reason: "Amazon Bedrock has no plan limits" };
  expect(await readUsage({ home, now: NOW, findCommand: () => undefined })).toEqual([
    { tool: "claude", home: ".claude", identity: null, limits: bedrock, local: spend(4.75, 2, "bedrock") },
    { tool: "claude", home: ".claude-shell", identity: null, limits: { state: "unknown", reason: "`claude` was not found" }, local: spend(0.75, 1, "bedrock") },
    { tool: "claude", home: ".claude-sub", ...savedClaude("`claude` was not found"), local: spend(40, 1, null) },
    { tool: "claude", home: ".claude-switched", identity: null, limits: bedrock, local: { state: "none" } },
  ]);
});

test("a Grok account sums `grok usage` over its recent sessions; a session with no turn yet is skipped, other failures are unknown", () => {
  const home = makeHome();
  const account = join(home, ".grok");
  const sessions = join(account, "sessions/%2Fwork");
  const used = "01a19510-a3f3-7a92-9cc9-2d101601fc53";
  const empty = "01a19563-51bc-7170-8468-4694576a317b";
  mkdirSync(join(sessions, used), { recursive: true });
  mkdirSync(join(sessions, empty), { recursive: true });
  // Stands in for Grok's command: what Grok 1.0.70 prints for a used session, and its error for an empty one.
  write(join(account, "bin/grok"), `#!/bin/sh
case "$2" in
  ${used}) echo '{"sessionId":"${used}","updatedAt":"2026-11-01T05:26:28Z","session":{"totalTokens":5,"costUsdTicks":13671040000}}' ;;
  ${empty}) echo "Error: No usage recorded for session '${empty}'." >&2; exit 1 ;;
  *) echo "Error: boom" >&2; exit 1 ;;
esac
`);
  chmodSync(join(account, "bin/grok"), 0o755);
  expect(grok.readLocalUse(account, home, Date.now())).toEqual({
    state: "spend",
    asOf: Date.parse("2026-11-01T05:26:28Z"),
    periodDays: PERIOD_DAYS,
    spent: { amountMinor: 137, currency: "USD", exponent: 2 },
    sessions: 1,
    partial: false,
    provider: null,
  });
  mkdirSync(join(sessions, "01a19999-0000-7000-8000-000000000000"));
  const failing = grok.readLocalUse(account, home, Date.now());
  expect(failing.state === "unknown" && failing.reason).toContain("boom");
});

// ── Account readings from the tools' CLIs ───────────────────────────────────────────────────────────

/** What `claude -p /usage` printed for an account with a session running, Claude Code 2.1.316, at USAGE_NOW. */
const claudeUsageOutput = `You are currently using your subscription to power your Claude Code usage

Current session: 27% used · resets Nov 1 at 3:40am (America/Los_Angeles)
Current week (all models): 21% used · resets Nov 3 at 4pm (America/Los_Angeles)
Current week (Fable): 0% used · resets Nov 3 at 4pm (America/Los_Angeles)

What's contributing to your usage?
Approximate · sessions on this machine only · shares overlap

Last 24h · 1122 requests · 30 sessions
  79%  Start fresh when you switch tasks · run /clear
  Top skills: /effect 22%, /overview-dashboard 4%
`;
/** 00:41 in Los Angeles on the night daylight saving time ends, so the 3:40am reset is in PST. */
const USAGE_NOW = Date.parse("2026-11-01T07:41:00Z");
const claudeAuthStatus = (email: string, orgId: string) => JSON.stringify({
  loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", analyticsDisabled: false,
  projectsDirectory: "/Users/x/.claude-chaine/projects", configDirectory: "/Users/x/.claude-chaine",
  email, orgId, orgName: `${email}'s Organization`, subscriptionType: "max",
}, null, 2);

test("`claude /usage` reads as each limit by name, reset times in the zone it names, across a daylight-saving change", () => {
  expect(parseUsageOutput(claudeUsageOutput, USAGE_NOW)).toEqual({
    state: "reading",
    asOf: USAGE_NOW,
    source: "account",
    windows: [
      { name: "5-hour", minutes: 300, usedPercent: 27, resetsAt: 1793533200000 },
      { name: "weekly", minutes: 10080, usedPercent: 21, resetsAt: 1793750400000 },
      { name: "weekly Fable", minutes: 10080, usedPercent: 0, resetsAt: 1793750400000 },
    ],
  });
  // An account with no session running prints no session line.
  const idle = parseUsageOutput("Current week (all models): 65% used · resets Nov 3 at 10pm (America/Los_Angeles)\n", USAGE_NOW);
  expect(idle.state === "reading" && idle.windows).toEqual([{ name: "weekly", minutes: 10080, usedPercent: 65, resetsAt: 1793772000000 }]);
  expect(parseUsageOutput("Current week (all models): 3% used\n", USAGE_NOW).state === "reading").toBe(true);
  const changed = parseUsageOutput("Usage: 21% of your weekly limit\n", USAGE_NOW);
  expect(changed.state === "unknown" && changed.reason).toContain("`claude /usage` changed shape");
  expect(parseUsageOutput("Current week (all models): 21% used · resets soon (America/Los_Angeles)\n", USAGE_NOW).state).toBe("unknown");
});

test("a reset time without a year is the nearest one; a time alone is the next one; an unknown zone is not guessed", () => {
  const newYearsEve = Date.parse("2026-12-30T12:00:00Z");
  expect(parseResetTime({ text: "Jan 2 at 4pm", timeZone: "UTC", now: newYearsEve })).toBe(Date.parse("2027-01-02T16:00:00Z"));
  expect(parseResetTime({ text: "Dec 29 at 11:30pm", timeZone: "UTC", now: newYearsEve })).toBe(Date.parse("2026-12-29T23:30:00Z"));
  expect(parseResetTime({ text: "Mar 4, 2028 at 12am", timeZone: "UTC", now: newYearsEve })).toBe(Date.parse("2028-03-04T00:00:00Z"));
  expect(parseResetTime({ text: "3:40am", timeZone: "UTC", now: USAGE_NOW })).toBe(Date.parse("2026-11-02T03:40:00Z"));
  expect(parseResetTime({ text: "12pm", timeZone: "UTC", now: USAGE_NOW })).toBe(Date.parse("2026-11-01T12:00:00Z"));
  expect(parseResetTime({ text: "Nov 3 at 4pm", timeZone: "Mars/Olympus", now: USAGE_NOW })).toBeUndefined();
  expect(parseResetTime({ text: "Smarch 3 at 4pm", timeZone: "UTC", now: USAGE_NOW })).toBeUndefined();
});

test("`claude auth status` names a subscription's account; another sign-in has no plan limits", () => {
  expect(parseAuthStatus(claudeAuthStatus("a@example.com", "org-1"))).toEqual({
    kind: "subscription", identity: { id: "org-1", email: "a@example.com", plan: "max" },
  });
  expect(parseAuthStatus(JSON.stringify({ loggedIn: false }))).toEqual({ kind: "signedOut" });
  expect(parseAuthStatus(JSON.stringify({ loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" }))).toEqual({
    kind: "noPlan", identity: null, reason: "signed in with api_key: no plan limits",
  });
  expect(parseAuthStatus("Not JSON").kind).toBe("changed");
});

/** `codex app-server`'s answers, as Codex 0.166 gave them for a signed-in account. */
const codexAccountAnswer = {
  id: 2,
  result: {
    account: { type: "chatgpt", email: "a@example.com", planType: "promax", workspaceName: null },
    requiresOpenaiAuth: true,
    workspaceRouting: { chatgptAccountId: "00000000-0000-4000-8000-000000000000", backendOrigin: "https://chatgpt.com", accountRoutingOverride: "NO_CONSTRAINT" },
  },
};
const codexSnapshot = {
  limitId: "codex", limitName: null, normalModelSlug: null,
  primary: { usedPercent: 92, windowDurationMins: 10080, resetsAt: 1793774310 },
  secondary: null,
  credits: { hasCredits: false, unlimited: false, balance: "0" },
  individualLimit: null, spendControlReached: false, planType: "promax", rateLimitReachedType: null,
};
const codexRateLimitsAnswer = {
  id: 3,
  result: {
    ordinaryUsageAllowed: true, rateLimits: codexSnapshot, rateLimitsByLimitId: { codex: codexSnapshot },
    rateLimitResetCredits: { availableCount: 1, credits: [] }, accountId: "00000000-0000-4000-8000-000000000000", rateLimitUpsell: null,
  },
};
const codexAccountLimits: AccountLimits = {
  state: "reading", asOf: USAGE_NOW, source: "account",
  windows: [{ name: "weekly", minutes: 10080, usedPercent: 92, resetsAt: 1793774310000 }],
};

test("`codex app-server` answers read as the account and its main bucket's limits", () => {
  expect(parseAppServerAnswers({ account: codexAccountAnswer, rateLimits: codexRateLimitsAnswer, now: USAGE_NOW })).toEqual({
    identity: { id: "a@example.com", email: "a@example.com", plan: "promax" },
    limits: codexAccountLimits,
  });
  // Codex 0.151, in the ChatGPT desktop app: no plan name, no `rateLimitsByLimitId` beyond the main one.
  const older = parseAppServerAnswers({
    account: { id: 2, result: { account: { type: "chatgpt", email: "a@example.com", planType: "unknown" }, requiresOpenaiAuth: true } },
    rateLimits: { id: 3, result: { rateLimits: { limitId: "codex", primary: codexSnapshot.primary, secondary: null } } },
    now: USAGE_NOW,
  });
  expect(older).toEqual({ identity: { id: "a@example.com", email: "a@example.com", plan: null }, limits: codexAccountLimits });
});

test("a signed-out or API-key Codex has no plan limits; a refused or changed answer is unknown", () => {
  const read = (account: object, rateLimits: object = codexRateLimitsAnswer) =>
    parseAppServerAnswers({ account: { id: 2, ...account }, rateLimits: { id: 3, ...rateLimits }, now: USAGE_NOW });
  expect(read({ result: { account: null, requiresOpenaiAuth: true } })).toEqual({ identity: null, limits: { state: "none", reason: "signed out" } });
  expect(read({ result: { account: { type: "apiKey" }, requiresOpenaiAuth: true } }).limits).toEqual({ state: "none", reason: "signed in with apiKey: no plan limits" });
  expect(read(codexAccountAnswer, { error: { message: "usage endpoint unavailable" } }).limits)
    .toEqual({ state: "unknown", reason: "`account/rateLimits/read` failed: usage endpoint unavailable" });
  expect(read(codexAccountAnswer, { result: { rateLimits: { primary: { usedPercent: "92%" } } } }).limits.state).toBe("unknown");
  expect(read({ result: { profile: {} } }).limits.state).toBe("unknown");
});

/** A stand-in for a tool's CLI: a shell script that logs each run to `log` and prints what the real one did. */
function fakeCommand(path: string, script: string): string {
  write(path, `#!/bin/sh\n${script}`);
  chmodSync(path, 0o755);
  return path;
}

test("readUsage asks each tool's CLI for its accounts, once per ACCOUNT_READ_MS, and falls back to saved records when it fails", async () => {
  const home = makeHome();
  const bin = join(home, "bin");
  const log = join(home, "runs.log");
  mkdirSync(join(home, ".claude"));
  mkdirSync(join(home, ".claude-work"));
  write(join(home, ".claude-work/.claude.json"), claudeState(claudeCache()));
  mkdirSync(join(home, ".codex"));
  mkdirSync(join(home, ".grok"));
  write(join(home, "auth-home.json"), claudeAuthStatus("home@example.com", "org-home"));
  write(join(home, "auth-work.json"), claudeAuthStatus("work@example.com", "org-work"));
  write(join(home, "usage.txt"), claudeUsageOutput);
  // The default account fails /usage, so its limits fall back to its cache, which it has none of.
  const claudeCommand = fakeCommand(join(bin, "claude"), `echo "claude $CLAUDE_CONFIG_DIR $*" >> '${log}'
case "$1" in
  auth) if [ -z "$CLAUDE_CONFIG_DIR" ]; then cat '${join(home, "auth-home.json")}'; else cat '${join(home, "auth-work.json")}'; fi ;;
  -p) if [ -z "$CLAUDE_CONFIG_DIR" ]; then echo "rate limited" >&2; exit 1; else cat '${join(home, "usage.txt")}'; fi ;;
esac
`);
  // Answers each request by its id, as \`codex app-server\` does, and runs until it is stopped.
  const codexCommand = fakeCommand(join(bin, "codex"), `echo "codex $CODEX_HOME $*" >> '${log}'
while IFS= read -r line; do
  case "$line" in
    *'"id":1,'*) echo '{"id":1,"result":{"userAgent":"x","codexHome":"x","platformFamily":"unix","platformOs":"macos"}}' ;;
    *'"id":2,'*) echo '{"method":"account/updated","params":{"authMode":"chatgpt"}}'; echo '${JSON.stringify(codexAccountAnswer)}' ;;
    *'"id":3,'*) echo '${JSON.stringify(codexRateLimitsAnswer)}' ;;
  esac
done
`);
  // Answers as \`grok agent stdio\` does: Grok's own command lives in each GROK_HOME.
  fakeCommand(join(home, ".grok/bin/grok"), `echo "grok $GROK_HOME $*" >> '${log}'
while IFS= read -r line; do
  case "$line" in
    *'"id":1,'*) echo '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{}}}' ;;
    *'"id":2,'*) echo '${JSON.stringify(grokBillingAnswer)}' ;;
  esac
done
`);
  const context: Partial<AccountContext> = {
    home,
    now: USAGE_NOW,
    findCommand: ({ name }) => name === "claude" ? claudeCommand : name === "codex" ? codexCommand : undefined,
  };
  const expected: AccountUsage[] = [
    {
      tool: "claude", home: ".claude", identity: { id: "org-home", email: "home@example.com", plan: "max" },
      limits: { state: "unknown", reason: "`claude -p /usage` failed: rate limited" }, local: { state: "none" },
    },
    {
      tool: "claude", home: ".claude-work", identity: { id: "org-work", email: "work@example.com", plan: "max" },
      limits: parseUsageOutput(claudeUsageOutput, USAGE_NOW), local: { state: "none" },
    },
    {
      tool: "codex", home: ".codex", identity: { id: "a@example.com", email: "a@example.com", plan: "promax" },
      limits: codexAccountLimits, local: { state: "tokens", periodDays: PERIOD_DAYS, count: 0, sessions: 0 },
    },
    { tool: "grok", home: ".grok", identity: null, limits: grokWeekly, local: { state: "none" } },
  ];
  expect(await readUsage(context)).toEqual(expected);
  const runs = () => Bun.file(log).text().then((text) => text.trim().split("\n").sort());
  // The default account runs with no CLAUDE_CONFIG_DIR; /usage is never saved as a session.
  expect(await runs()).toEqual([
    "claude  -p /usage --no-session-persistence",
    "claude  auth status",
    `claude ${join(home, ".claude-work")} -p /usage --no-session-persistence`,
    `claude ${join(home, ".claude-work")} auth status`,
    `codex ${join(home, ".codex")} app-server`,
    `grok ${join(home, ".grok")} agent --no-leader stdio`,
  ]);
  // Within ACCOUNT_READ_MS the CLIs are not asked again.
  expect(await readUsage({ ...context, now: USAGE_NOW + ACCOUNT_READ_MS - 1 })).toEqual(expected);
  expect((await runs()).length).toBe(6);
  await readUsage({ ...context, now: USAGE_NOW + ACCOUNT_READ_MS });
  expect((await runs()).length).toBe(12);
});

test("a signed-out Claude account is said to be signed out, though `claude auth status` exits 1 for it", async () => {
  const home = makeHome();
  mkdirSync(join(home, ".claude-out"));
  write(join(home, "auth.json"), JSON.stringify({ loggedIn: false, authMethod: "none", apiProvider: "firstParty" }));
  const command = fakeCommand(join(home, "bin/claude"), `case "$1" in auth) cat '${join(home, "auth.json")}'; exit 1 ;; *) echo "Total cost: $0.0000" ;; esac\n`);
  expect(await readUsage({ home, now: USAGE_NOW, findCommand: ({ name }) => name === "claude" ? command : undefined })).toEqual([
    { tool: "claude", home: ".claude-out", identity: null, limits: { state: "none", reason: "signed out" }, local: { state: "none" } },
  ]);
});

/** `_x.ai/billing`'s answer from Grok 1.0.70 on a SuperGrok Heavy account, 2026-11-01. */
const grokBillingAnswer = {
  id: 2,
  result: {
    config: {
      creditUsagePercent: 1,
      currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-11-01T02:59:01.704+00:00", end: "2026-11-08T02:59:01.704+00:00" },
      prepaidBalance: { val: 0 },
      isUnifiedBillingUser: true,
      billingPeriodStart: "2026-11-01T02:59:01.704+00:00",
      billingPeriodEnd: "2026-11-08T02:59:01.704+00:00",
    },
    subscription_tier: "SuperGrok Heavy",
  },
};
const grokWeekly: AccountLimits = {
  state: "reading",
  asOf: USAGE_NOW,
  source: "account",
  windows: [{ name: "weekly", minutes: 7 * 24 * 60, usedPercent: 1, resetsAt: Date.parse("2026-11-08T02:59:01.704Z") }],
};

test("Grok's `_x.ai/billing` answer reads as a limit named by its period's length; an error or a changed shape is unknown", () => {
  expect(parseBillingAnswer(grokBillingAnswer, USAGE_NOW)).toEqual(grokWeekly);
  expect(parseBillingAnswer({ id: 2, error: { message: "Authentication required to fetch billing data" } }, USAGE_NOW))
    .toEqual({ state: "unknown", reason: "`_x.ai/billing` failed: Authentication required to fetch billing data" });
  const changed = parseBillingAnswer({ id: 2, result: { config: { creditUsagePercent: "1%" } } }, USAGE_NOW);
  expect(changed.state).toBe("unknown");
  expect(changed.state === "unknown" ? changed.reason : "").toStartWith("Grok's `_x.ai/billing` answer changed shape:");
});

test("Codex's binary is found inside its editor extension, locally and in an editor's remote server folder, newest first", () => {
  const home = makeHome();
  const file = process.platform === "win32" ? "codex.exe" : "codex";
  const older = join(home, ".vscode-server", "extensions", "openai.chatgpt-26.900.1-linux-x64", "bin", "linux-x86_64", file);
  const newer = join(home, ".vscode", "extensions", "openai.chatgpt-26.1021.22027-darwin-x64", "bin", "macos-x86_64", file);
  write(older, "");
  write(newer, "");
  write(join(home, ".cursor", "extensions", "someone.else-1.0.0", "bin", "x", file), "");
  utimesSync(older, new Date(1_000_000), new Date(1_000_000));
  expect(extensionBinaries(home)).toEqual([newer, older]);
  expect(extensionBinaries(makeHome())).toEqual([]);
});

test("a command only the login shell's PATH reaches is still found, as under a service manager's bare PATH", () => {
  const root = mkdtempSync(join(tmpdir(), "skill-sync-shell-"));
  const bin = join(root, "only-in-shell");
  mkdirSync(bin);
  writeFileSync(join(bin, "tool-only-in-shell"), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(join(root, "shell"), `#!/bin/sh\necho "PATH=/usr/bin:${bin}"\n`, { mode: 0o755 });
  const run = spawnSync(process.execPath, ["-e", `import { findCommand } from ${JSON.stringify(join(import.meta.dir, "command.ts"))}; console.log(findCommand({ name: "tool-only-in-shell", home: ${JSON.stringify(root)} }) ?? "not found")`],
    { env: { PATH: "/usr/bin:/bin", SHELL: join(root, "shell"), HOME: root }, encoding: "utf-8" });
  rmSync(root, { recursive: true, force: true });
  expect(run.stdout.trim()).toBe(join(bin, "tool-only-in-shell"));
});
