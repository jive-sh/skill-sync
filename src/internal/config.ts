import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, relative, sep } from "node:path";

/**
 * Per-machine settings and sync state, both under `~/.jive/`.
 *
 * A file rather than environment variables: which directory holds this machine's skills, and which
 * machine this is, differ per computer and have to survive a login, which is exactly what a config file
 * is for and exactly what an environment variable is not.
 */

const JIVE_HOME = join(homedir(), ".jive");
export const CONFIG_PATH = join(JIVE_HOME, "skill-sync.json");
/**
 * The token lives on its own, outside `~/.jive/`, because it is the one part that must not travel with
 * the rest. Endpoint, machine name and skills directory are settings you could paste into a gist; this
 * is a credential, and keeping it in a separate file makes "do not copy this one" a property of the
 * filesystem rather than a thing you have to remember.
 */
export const TOKEN_PATH = join(homedir(), ".skill-sync-token.json");
const STATE_PATH = join(JIVE_HOME, "skill-sync-state.json");

/** Managed by Claude's own cloud sync; see `Config.exclude`. */
const DEFAULT_EXCLUDE = ["synced"] as const;

export interface Config {
  readonly endpoint: string;
  /**
   * Top-level directory names under `skillsDir` to leave alone.
   *
   * `synced` holds the skills Claude already pulls from the cloud itself. Syncing them here would mean
   * two systems writing the same files, each undoing the other, and none of them are yours to edit.
   */
  readonly exclude: ReadonlyArray<string>;
  readonly token: string;
  readonly skillsDir: string;
  /** Names this machine in conflict messages, so "who overwrote this" has an answer. */
  readonly machine: string;
}

/** Either the settings, or the one sentence telling the user what to go and fill in. */
export type ConfigResult =
  | { readonly ok: true; readonly config: Config }
  | { readonly ok: false; readonly reason: string };

export interface State {
  /** Highest server sequence number already applied. */
  cursor: number;
  /** Last hash this machine agreed with the server on, per relative path. Absent means never synced. */
  known: Record<string, string>;
}

/**
 * The settings alone, with no token required.
 *
 * `login` needs these precisely when the token is missing, so it cannot go through `loadConfig` — that
 * reports "not configured" for a missing token and would refuse to run the command that supplies one.
 */
export function loadSettings(): { endpoint: string; machine: string; skillsDir: string } | undefined {
  loadConfig();
  const settings = readJson<Partial<Config>>(CONFIG_PATH);
  if (!settings.endpoint || !settings.machine || !settings.skillsDir) return undefined;
  return { endpoint: settings.endpoint, machine: settings.machine, skillsDir: settings.skillsDir };
}

/** Reads both files, writing a template for whichever is missing, and says what is still needed. */
export function loadConfig(): ConfigResult {
  if (!existsSync(CONFIG_PATH)) {
    mkdirSync(JIVE_HOME, { recursive: true });
    writeFileSync(CONFIG_PATH, `${JSON.stringify({
      endpoint: "https://skill-sync.jive.sh",
      skillsDir: detectSkillsDir(),
      machine: machineName(),
      exclude: DEFAULT_EXCLUDE,
    }, null, 2)}\n`);
  }

  if (!existsSync(TOKEN_PATH)) {
    // 0600 from the moment it exists, rather than written open and tightened afterwards — there is no
    // window in between for anything else on the machine to read it.
    writeFileSync(TOKEN_PATH, `${JSON.stringify({ token: "" }, null, 2)}\n`, { mode: 0o600 });
  }

  const settings = readJson<Partial<Config>>(CONFIG_PATH);
  const token = readJson<{ token?: string }>(TOKEN_PATH).token;

  if (!settings.endpoint || !settings.skillsDir || !settings.machine) {
    return { ok: false, reason: `${CONFIG_PATH} needs an endpoint, a skillsDir and a machine name` };
  }
  if (!token) {
    return { ok: false, reason: `${TOKEN_PATH} needs the sync token` };
  }
  return { ok: true, config: { exclude: DEFAULT_EXCLUDE, ...settings, token } as Config };
}

function readJson<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return {} as T;
  }
}

export function loadState(): State {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf-8")) as State;
  } catch {
    return { cursor: 0, known: {} };
  }
}

export function saveState(state: State): void {
  mkdirSync(JIVE_HOME, { recursive: true });
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

/** `HOSTNAME` is not set on macOS, so the template was writing "unknown" on exactly this machine. */
function machineName(): string {
  return hostname().replace(/\.local$/, "").replace(/[^A-Za-z0-9-]+/g, "-") || "unknown";
}

/**
 * The skills directory this machine actually has, rather than the one it ought to have.
 *
 * Claude's home is not always `~/.claude` — an account with a suffixed home (`~/.claude-alex`) keeps its
 * skills there, and writing the conventional path into the template just hands the user a wrong value to
 * notice and correct. Pick the one that exists; fall back to the conventional path only if none does.
 */
function detectSkillsDir(): string {
  const candidates = readdirSync(homedir())
    .filter((entry) => entry === ".claude" || entry.startsWith(".claude-"))
    .map((entry) => join(homedir(), entry, "skills"))
    .filter((dir) => existsSync(dir))
    .sort();
  return candidates[0] ?? join(homedir(), ".claude", "skills");
}

export function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Suffix for the copy kept when an incoming change would have overwritten a local edit. */
export const CONFLICT_SUFFIX = ".local";

/**
 * Every file under the skills directory, as paths relative to it with forward slashes.
 *
 * Normalised because the same skill synced from Windows and macOS must be one row, not two.
 *
 * Conflict copies are skipped. They are this machine's evidence of a collision, not content anyone else
 * asked for, and syncing them spreads one machine's mess to every other machine.
 */
export function listLocalFiles(skillsDir: string, exclude: ReadonlyArray<string> = DEFAULT_EXCLUDE): string[] {
  if (!existsSync(skillsDir)) return [];

  const found: string[] = [];
  const walk = (dir: string, top: boolean): void => {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(".")) continue;
      if (top && exclude.includes(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, false);
      else if (!entry.endsWith(CONFLICT_SUFFIX)) found.push(relative(skillsDir, full).split(sep).join("/"));
    }
  };
  walk(skillsDir, true);
  return found.sort();
}
