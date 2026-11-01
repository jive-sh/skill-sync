import { homedir } from "node:os";
import type { AccountUsage } from "../wire";
import type { AgentTool, Reading } from "./agent-tool";
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

/** Every account of every agent tool on this machine with its usage. One account's failure never hides another's. */
export function readUsage(home: string = homedir(), now: number = Date.now()): AccountUsage[] {
  return AGENT_TOOLS
    .flatMap((tool) => tool.accounts(home).map((account) => ({ tool, account })))
    .sort((a, b) => a.account.localeCompare(b.account))
    .map(({ tool, account }) => {
      let reading: Reading;
      try {
        reading = tool.readUsage(account, home, now);
      } catch (cause) {
        reading = { state: "unknown", reason: `could not read: ${cause instanceof Error ? cause.message : String(cause)}` };
      }
      return { tool: tool.tool, home: account.slice(home.length).replace(/^[\\/]/, ""), ...reading };
    });
}
