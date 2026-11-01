import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { SchemaIssue } from "effect";
import { isLock } from "../config";
import type { AccountUsage } from "../wire";

/**
 * One coding agent skill-sync works with (Claude Code, Codex, Grok): where it reads a user's skills, which
 * of its accounts are on this machine, and how much each has used.
 *
 * Everything skill-sync knows about one tool lives in that tool's implementation, so adding a tool is one
 * new file and one line in `AGENT_TOOLS`, and no other code tests a folder name to tell tools apart.
 */
export interface AgentTool {
  readonly tool: AccountUsage["tool"];
  /**
   * The skills folders this tool reads a user's skills from on this machine, whether or not they exist
   * yet: a folder that is ticked on the dashboard and missing is created.
   */
  skillsFolders(home: string): string[];
  /** This tool's account folders in `home`, as absolute paths. */
  accounts(home: string): string[];
  /** How much one of those accounts has used, from files and commands the tool itself provides. */
  readUsage(account: string, home: string, now: number): Reading;
}

/** What a tool learns about one account; `readUsage` adds which account it is. */
export type Reading = DistributiveOmit<AccountUsage, "tool" | "home">;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Sessions are counted over this many days: Claude Code deletes session files older than 30 days by default. */
export const PERIOD_DAYS = 30;
export const DAY_MS = 24 * 60 * 60 * 1000;

const formatIssue = SchemaIssue.makeFormatterDefault();

/** A record that failed to decode: what failed, on one line, so the dashboard can say why it shows nothing. */
export const unknownShape = (what: string, issue: SchemaIssue.Issue): Reading =>
  ({ state: "unknown", reason: `${what} changed shape: ${formatIssue(issue).replace(/\s+/g, " ").slice(0, 160)}` });

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export const parseJson = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
};

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

/** The directories in `home` named `.<name>` or `.<name>-<suffix>`, never a lock: one tool's account folders. */
export function homesNamed(home: string, name: string): string[] {
  return readdirSync(home)
    .filter((entry) => (entry === `.${name}` || entry.startsWith(`.${name}-`)) && !isLock(entry))
    .map((entry) => join(home, entry))
    .filter(isDirectory)
    .sort();
}
