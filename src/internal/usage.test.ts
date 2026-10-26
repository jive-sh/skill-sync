import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeStatePath, detectAccounts, linesFromEnd, parseClaudeState, parseCodexLine, readUsage, type Reading } from "./usage";

/**
 * Pins how account folders are found and how each tool's usage record is read. The records below are
 * trimmed copies of real ones (account ids replaced): Claude Code 2.1.310's `cachedUsageUtilization`, and
 * a Codex `token_count` event. When a tool changes its format, these show what this version expected.
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
const codexReading: Reading = {
  state: "reading",
  asOf: Date.parse("2026-09-05T19:40:38.460Z"),
  windows: [
    { minutes: 300, usedPercent: 24, resetsAt: 1788652301000 },
    { minutes: 10080, usedPercent: 16, resetsAt: 1789170646000 },
  ],
};

test("account folders are .claude, .claude-*, .codex and .codex-* directories, never locks or files", () => {
  const home = makeHome();
  for (const dir of [".claude", ".claude-work", ".claude-work.lock", ".codex", ".codex-team", ".codexish", ".agents", ".config"]) {
    mkdirSync(join(home, dir));
  }
  write(join(home, ".claude.json"), "{}");
  write(join(home, ".claude-notes"), "a file, not an account");
  expect(detectAccounts(home)).toEqual([
    { tool: "claude", path: join(home, ".claude") },
    { tool: "claude", path: join(home, ".claude-work") },
    { tool: "codex", path: join(home, ".codex") },
    { tool: "codex", path: join(home, ".codex-team") },
  ]);
});

test("the default Claude account keeps its state beside its folder; others inside theirs", () => {
  expect(claudeStatePath("/h/.claude", "/h")).toBe("/h/.claude.json");
  expect(claudeStatePath("/h/.claude-work", "/h")).toBe("/h/.claude-work/.claude.json");
});

test("Claude's usage cache reads as the 5-hour and weekly windows, as of when Claude Code fetched it", () => {
  expect(parseClaudeState(claudeState(claudeCache()))).toEqual({
    state: "reading",
    asOf: 1793019227405,
    windows: [
      { minutes: 300, usedPercent: 48, resetsAt: Date.parse("2026-10-26T20:00:00.082Z") },
      { minutes: 10080, usedPercent: 29, resetsAt: Date.parse("2026-10-28T00:00:00.376Z") },
    ],
  });
});

test("a Claude window that has not started has no reset time", () => {
  const cache = claudeCache();
  cache.utilization.five_hour = claudeWindow(0, null);
  const reading = parseClaudeState(claudeState(cache));
  expect(reading.state === "reading" && reading.windows[0]).toEqual({ minutes: 300, usedPercent: 0, resetsAt: null });
});

test("Claude usage credits show as money spent once they are on", () => {
  const used = { amount_minor: 1234, currency: "USD", exponent: 2 };
  const on = parseClaudeState(claudeState(claudeCache({ used, limit: null, enabled: true })));
  expect(on.state === "reading" && on.spent).toEqual({ used: { amountMinor: 1234, currency: "USD", exponent: 2 }, limit: null });
  const capped = parseClaudeState(claudeState(claudeCache({ used, limit: { amount_minor: 5000, currency: "USD", exponent: 2 }, enabled: true })));
  expect(capped.state === "reading" && capped.spent?.limit).toEqual({ amountMinor: 5000, currency: "USD", exponent: 2 });
  const off = parseClaudeState(claudeState(claudeCache()));
  expect(off.state === "reading" && "spent" in off).toBe(false);
});

test("a Claude account that never fetched usage has none; a changed cache is unknown, not guessed", () => {
  expect(parseClaudeState(JSON.stringify({ numStartups: 1 }))).toEqual({ state: "none" });
  const renamed = parseClaudeState(claudeState({ fetchedAtMs: 1793019227405, usage: {} }));
  expect(renamed.state).toBe("unknown");
  expect(renamed.state === "unknown" && renamed.reason).toContain("Claude Code's usage cache changed shape");
  const retyped = claudeCache();
  (retyped.utilization.seven_day as { utilization: unknown }).utilization = "29%";
  expect(parseClaudeState(claudeState(retyped)).state).toBe("unknown");
  expect(parseClaudeState("{\"cachedUsage").state).toBe("unknown");
});

test("a Codex token_count event reads as its primary and secondary windows, as of the event", () => {
  expect(parseCodexLine(codexLine(codexLimits))).toEqual(codexReading);
});

test("Codex lines without a main-bucket reading are skipped; a changed record is unknown", () => {
  expect(parseCodexLine(JSON.stringify({ timestamp: "2026-09-05T19:40:38Z", type: "event_msg", payload: { type: "agent_message" } }))).toBeUndefined();
  expect(parseCodexLine(codexLine(null))).toBeUndefined();
  expect(parseCodexLine(codexLine({ ...codexLimits, limit_id: "codex_other" }))).toBeUndefined();
  expect(parseCodexLine(codexLine({ ...codexLimits, limit_id: undefined }))).toEqual(codexReading);
  expect(parseCodexLine(codexLine({ ...codexLimits, primary: { ...codexLimits.primary, used_percent: "24%" } }))?.state).toBe("unknown");
  expect(parseCodexLine("{\"payload\":{\"type\":\"token_count\"")).toBeUndefined();
});

test("lines come back last first, across chunk boundaries, skipping lines too long to hold", () => {
  const home = makeHome();
  const lines = ["first", "x".repeat(100_000), "y".repeat(70_000), "short", "z".repeat(3_000_000), "last"];
  write(join(home, "f.jsonl"), `${lines.join("\n")}\n`);
  expect([...linesFromEnd(join(home, "f.jsonl"), Infinity)]).toEqual(["last", "short", "y".repeat(70_000), "x".repeat(100_000), "first"]);
  expect([...linesFromEnd(join(home, "f.jsonl"), 10)]).toEqual(["last"]);
});

test("every account on a machine is read; Codex's latest reading may sit in an older session file", () => {
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
  mkdirSync(join(home, ".codex-empty"));

  expect(readUsage(home)).toEqual([
    { tool: "claude", home: ".claude", state: "none" },
    expect.objectContaining({ tool: "claude", home: ".claude-broken", state: "unknown" }),
    { tool: "claude", home: ".claude-work", ...parseClaudeState(claudeState(claudeCache())) },
    { tool: "codex", home: ".codex", ...codexReading },
    { tool: "codex", home: ".codex-empty", state: "none" },
  ]);
});
