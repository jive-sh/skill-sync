import { existsSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { Result, Schema } from "effect";
import { DAY_MS, PERIOD_DAYS, homesNamed, isDirectory, parseJson, unknownShape, type AgentTool, type Reading } from "./agent-tool";

/**
 * Grok. Each account is a `GROK_HOME` (`~/.grok`, `~/.grok-<name>`), and Grok's docs name its `skills`
 * folder as where it reads a user's skills. Grok also reads `~/.agents/skills`, undocumented; a skill in
 * both loads once, from the Grok home (checked with `grok inspect`, Grok 1.0.70).
 *
 * Usage is what `grok usage <session-id>` prints, the command Grok's docs say to use instead of reading
 * session files: each session's token and cost totals (`costUsdTicks`, 10^10 per US dollar). The line sums
 * sessions active in the last `PERIOD_DAYS` days. A session's totals include history it inherited by
 * resume or fork, so a fork counts that part twice. Grok's plan allowance is only in its interactive
 * `/usage`, so no limit is shown.
 */
export const grok: AgentTool = {
  tool: "grok",
  skillsFolders: (home) => homesNamed(home, "grok").map((account) => join(account, "skills")),
  accounts: (home) => homesNamed(home, "grok"),
  readUsage: (account, _home, now) => readGrok(account, now),
};

const GrokUsage = Schema.Struct({
  sessionId: Schema.String,
  updatedAt: Schema.String,
  session: Schema.Struct({ costUsdTicks: Schema.Finite, totalTokens: Schema.Finite }),
});
const TICKS_PER_USD = 1e10;
/** `grok usage` reads one session's file and exits; this bounds a hung one. */
const COMMAND_TIMEOUT_MS = 10_000;

export type SessionTotals =
  | { readonly kind: "totals"; readonly usd: number; readonly updatedAt: number }
  /** A session with no turn yet: `grok usage` exits 1 saying "No usage recorded". */
  | { readonly kind: "empty" }
  | { readonly kind: "failed"; readonly reason: string };

/** A session's totals are fetched again only when its directory changed: each `grok usage` run takes most of a second. */
const sessionCache = new Map<string, { readonly modifiedAt: number; readonly totals: SessionTotals }>();

function readGrok(account: string, now: number): Reading {
  const command = join(account, "bin", "grok");
  const sessions = sessionDirs(join(account, "sessions"), now - PERIOD_DAYS * DAY_MS);
  if (sessions.length === 0) return { state: "none" };
  if (!existsSync(command)) return { state: "unknown", reason: `Grok's command is not at ${command}` };

  const totals: Extract<SessionTotals, { kind: "totals" }>[] = [];
  for (const session of sessions) {
    const cached = sessionCache.get(session.path);
    const result = cached !== undefined && cached.modifiedAt === session.modifiedAt
      ? cached.totals
      : runGrokUsage(command, account, session.id);
    // A failure is asked again next time rather than kept until the session changes.
    if (result.kind !== "failed") sessionCache.set(session.path, { modifiedAt: session.modifiedAt, totals: result });
    if (result.kind === "failed") return { state: "unknown", reason: result.reason };
    if (result.kind === "totals") totals.push(result);
  }
  if (totals.length === 0) return { state: "none" };
  const usd = totals.reduce((sum, session) => sum + session.usd, 0);
  return {
    state: "estimate",
    asOf: Math.max(...totals.map((session) => session.updatedAt)),
    periodDays: PERIOD_DAYS,
    spent: { amountMinor: Math.round(usd * 100), currency: "USD", exponent: 2 },
    sessions: totals.length,
    partial: false,
    provider: null,
  };
}

/**
 * Sessions active since `since`: `sessions/<encoded working directory>/<session id>/`, whose modification
 * time moves whenever Grok writes the session's files.
 */
function sessionDirs(dir: string, since: number): { readonly id: string; readonly path: string; readonly modifiedAt: number }[] {
  if (!isDirectory(dir)) return [];
  return readdirSync(dir).flatMap((project) => {
    const projectDir = join(dir, project);
    if (!isDirectory(projectDir)) return [];
    return readdirSync(projectDir).flatMap((id) => {
      const path = join(projectDir, id);
      if (!/^[0-9a-f-]{36}$/i.test(id) || !isDirectory(path)) return [];
      const modifiedAt = statSync(path).mtimeMs;
      return modifiedAt >= since ? [{ id, path, modifiedAt }] : [];
    });
  });
}

export function runGrokUsage(command: string, account: string, sessionId: string): SessionTotals {
  const run = spawnSync(command, ["usage", sessionId], {
    env: { ...process.env, GROK_HOME: account },
    encoding: "utf-8",
    timeout: COMMAND_TIMEOUT_MS,
  });
  if (run.status === 0) return parseGrokUsage(run.stdout);
  const stderr = (run.stderr ?? "").trim();
  if (stderr.includes("No usage recorded")) return { kind: "empty" };
  return { kind: "failed", reason: `\`grok usage\` failed: ${run.error?.message ?? (stderr.slice(0, 160) || `exit ${run.status}`)}` };
}

export function parseGrokUsage(stdout: string): SessionTotals {
  const decoded = Schema.decodeUnknownResult(GrokUsage)(parseJson(stdout));
  if (Result.isFailure(decoded)) {
    const reading = unknownShape("`grok usage` output", decoded.failure.issue);
    return { kind: "failed", reason: reading.state === "unknown" ? reading.reason : "" };
  }
  const updatedAt = Date.parse(decoded.success.updatedAt);
  if (!Number.isFinite(updatedAt)) return { kind: "failed", reason: "`grok usage` output changed shape: updatedAt is not a time" };
  return { kind: "totals", usd: decoded.success.session.costUsdTicks / TICKS_PER_USD, updatedAt };
}
