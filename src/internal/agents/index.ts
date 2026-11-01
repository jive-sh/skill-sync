import { homedir } from "node:os";
import type { AccountUsage, LocalUse } from "../wire";
import type { AccountContext, AccountReading, AgentTool } from "./agent-tool";
import { findCommand } from "./command";
import { claude } from "./claude";
import { codex } from "./codex";
import { grok } from "./grok";

/** Every coding agent skill-sync syncs skills for and reads usage of. */
export const AGENT_TOOLS: ReadonlyArray<AgentTool> = [claude, codex, grok];

/**
 * Every skills folder any agent tool reads on this machine. Every one is a candidate, whether or not it
 * exists yet, so an account added later joins without anyone listing it. Which of them actually sync is
 * the user's choice on the dashboard; a folder that is synced and missing is created.
 */
export function detectFolders(home: string = homedir()): string[] {
  return [...new Set(AGENT_TOOLS.flatMap((tool) => tool.skillsFolders(home)))].sort();
}

/**
 * How long an account reading is kept before its CLI is asked again. Each ask starts the tool's CLI
 * (about two seconds of CPU for `claude`) and calls its service, so it happens at most this often per
 * account, while this machine's use, read from local files, is read on every call.
 */
export const ACCOUNT_READ_MS = 5 * 60_000;

const accountCache = new Map<string, { readonly readAt: number; readonly reading: AccountReading }>();

/**
 * Every account of every agent tool on this machine: who it is and its plan limits (from the tool's CLI,
 * at most every `ACCOUNT_READ_MS`), and this machine's use of it. One account's failure never hides another's.
 */
export async function readUsage(input: Partial<AccountContext> = {}): Promise<AccountUsage[]> {
  const home = input.home ?? homedir();
  const context: AccountContext = {
    home,
    now: input.now ?? Date.now(),
    findCommand: input.findCommand ?? ((command) => findCommand({ ...command, home })),
  };
  const now = context.now;
  const accounts = AGENT_TOOLS
    .flatMap((tool) => tool.accounts(home).map((account) => ({ tool, account })))
    .sort((a, b) => a.account.localeCompare(b.account));
  for (const account of accountCache.keys()) {
    if (!accounts.some((entry) => entry.account === account)) accountCache.delete(account);
  }
  return Promise.all(accounts.map(async ({ tool, account }): Promise<AccountUsage> => {
    const reading = await cachedAccount(tool, account, context);
    let local: LocalUse;
    try {
      local = tool.readLocalUse(account, home, now);
    } catch (cause) {
      local = { state: "unknown", reason: `could not read: ${describe(cause)}` };
    }
    return { tool: tool.tool, home: account.slice(home.length).replace(/^[\\/]/, ""), ...reading, local };
  }));
}

async function cachedAccount(tool: AgentTool, account: string, context: AccountContext): Promise<AccountReading> {
  const now = context.now;
  const cached = accountCache.get(account);
  if (cached !== undefined && now - cached.readAt < ACCOUNT_READ_MS) return cached.reading;
  let reading: AccountReading;
  try {
    reading = await tool.readAccount(account, context);
  } catch (cause) {
    reading = { identity: null, limits: { state: "unknown", reason: `could not read: ${describe(cause)}` } };
  }
  accountCache.set(account, { readAt: now, reading });
  return reading;
}

const describe = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);
