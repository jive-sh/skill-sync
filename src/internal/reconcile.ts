import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";

/**
 * Merges two versions of one skill file with Claude, on this machine.
 *
 * A conflict used to mean "the server's copy wins and yours is set aside as `.local`", which left the
 * merge to a person who might not notice for days, while every machine ran the losing half. Skills are
 * prose that Claude reads, so Claude is the right one to merge them: it keeps every rule either side
 * added and resolves the ones that disagree.
 *
 * Claude runs with no tools, no MCP servers and no settings: it receives the versions on stdin and
 * answers with the merged file, so it cannot touch anything else. It runs as the Claude account whose
 * folder is being merged (`CLAUDE_CONFIG_DIR` set to that folder's home), so it never creates or writes
 * `~/.claude` — a home the user may have deleted on purpose.
 */

export interface Version {
  readonly content: string;
  /** Where this version came from, for the prompt: "this machine, edited …" or "MacBookPro, uploaded …". */
  readonly label: string;
}

/** The merged file, and Claude's account of it for the audit log. */
export interface Resolution {
  readonly merged: string;
  /** What differed between the two versions. */
  readonly conflict: string;
  /** What the merge kept, dropped or reworded. */
  readonly resolution: string;
}

export interface Conflict {
  readonly folder: string;
  readonly path: string;
  readonly local: Version;
  readonly remote: Version;
  /** The last version both sides agreed on, when there is one; it lets Claude see what each side changed. */
  readonly base: string | null;
}

const BACKUP_ROOT = join(homedir(), ".jive", "skill-sync", "reconciled");
/** A long skill is tens of thousands of tokens to write back out. */
const TIMEOUT_MS = 15 * 60 * 1000;
/**
 * A merge shorter than this fraction of the longer input is refused as probably truncated: a model that
 * stops early produces a file that looks fine and silently drops half the rules.
 */
const MIN_LENGTH_RATIO = 0.6;

const SYSTEM_PROMPT = `You merge two versions of one file from a user's Claude skills folder into one.
Answer in exactly this form and nothing else:
<conflict>One or two plain sentences: what differs between the versions.</conflict>
<resolution>One or two plain sentences: what the merge kept from each, and anything dropped or reworded.</resolution>
<merged>
The complete merged file, exactly as it should be saved. No code fences.
</merged>
Rules for the merge:
- Keep every rule, example and fact that either version has, unless the other version clearly replaces it.
- Where the two disagree, prefer the newer version's wording, and keep anything only the older one has.
- If a base version is given, it is what both started from: use it to tell additions from deletions, and
  honour a deletion made on one side when the other side did not edit that part.
- Keep the file's frontmatter and structure.
In <conflict> and <resolution>, call the two versions by the names they are given (for example "the copy in
~/.claude-chaine/skills on MacBookPro" and "the synced copy"), never "Version A" or "Version B": these are
read later by a person auditing the merge, who never saw this prompt.`;

/**
 * Both versions are copied out of the synced folder before anything is written, so a bad merge costs a
 * file copy, not the user's work. Outside the folder so the copies are never synced or read as skills.
 */
export function backUp(conflict: Conflict): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(BACKUP_ROOT, stamp, basename(dirname(conflict.folder)), conflict.path);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "local"), conflict.local.content);
  writeFileSync(join(dir, "remote"), conflict.remote.content);
  if (conflict.base !== null) writeFileSync(join(dir, "base"), conflict.base);
  return dir;
}

export async function reconcile(conflict: Conflict): Promise<Resolution> {
  const sections = [
    `File: ${conflict.path}`,
    conflict.base === null ? "No base version: these two have never been in sync." : `=== the base version both started from:\n${conflict.base}`,
    `=== ${conflict.local.label}:\n${conflict.local.content}`,
    `=== ${conflict.remote.label}:\n${conflict.remote.content}`,
    "Write the merged file now.",
  ];
  const answer = await runClaude(sections.join("\n\n-----\n\n"), dirname(conflict.folder));
  const start = answer.indexOf("<merged>");
  const end = answer.lastIndexOf("</merged>");
  if (start === -1 || end <= start) throw new Error("Claude's answer had no <merged> section");
  // The file is everything between the tags, minus the newline that follows the opening one.
  const merged = answer.slice(start + "<merged>".length, end).replace(/^\r?\n/, "");
  const conflictText = /<conflict>([\s\S]*?)<\/conflict>/.exec(answer)?.[1]?.trim() ?? "";
  const resolutionText = /<resolution>([\s\S]*?)<\/resolution>/.exec(answer)?.[1]?.trim() ?? "";

  const longest = Math.max(conflict.local.content.length, conflict.remote.content.length);
  if (merged.trim().length === 0) throw new Error("Claude returned an empty merge");
  if (merged.length < longest * MIN_LENGTH_RATIO) {
    throw new Error(`the merge is ${merged.length} characters against ${longest}; refusing it as probably truncated`);
  }
  return {
    merged: merged.endsWith("\n") ? merged : `${merged}\n`,
    conflict: conflictText || "Claude did not describe the conflict.",
    resolution: resolutionText || "Claude did not describe the resolution.",
  };
}

/** `configDir` is the Claude home that owns the folder, e.g. `~/.claude-chaine` for `~/.claude-chaine/skills`. */
function runClaude(input: string, configDir: string): Promise<string> {
  const claude = findClaude();
  if (claude === undefined) return Promise.reject(new Error("the claude CLI is not installed"));

  // Always set, never inherited or left unset: unset, `claude` falls back to `~/.claude` and writes its
  // session files, backups and caches there, recreating that home every time it is deleted.
  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir };

  return new Promise((resolve, reject) => {
    const child = spawn(claude, [
      "-p", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--setting-sources", "",
      "--no-session-persistence", "--system-prompt", SYSTEM_PROMPT,
    ], { env, cwd: homedir(), stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => child.kill("SIGTERM"), TIMEOUT_MS);

    child.on("error", (cause) => { clearTimeout(timer); reject(cause); });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(stdout) as { is_error?: boolean; result?: string };
        if (code !== 0 || result.is_error || typeof result.result !== "string") {
          reject(new Error(`claude failed (exit ${code}): ${result.result ?? stderr.trim()}`));
        } else {
          resolve(result.result);
        }
      } catch {
        reject(new Error(`claude failed (exit ${code}): ${stderr.trim() || stdout.slice(0, 300)}`));
      }
    });
    child.stdin.end(input);
  });
}

/**
 * The daemon starts at login with the service manager's minimal PATH, which rarely includes where the
 * Claude installer puts `claude`, so the usual install locations are checked too.
 */
function findClaude(): string | undefined {
  const name = process.platform === "win32" ? "claude.exe" : "claude";
  const fromPath = (process.env["PATH"] ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, name));
  const known = [
    join(homedir(), ".local", "bin", name),
    join(homedir(), ".claude", "local", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  return [...fromPath, ...known].find((candidate) => existsSync(candidate));
}
