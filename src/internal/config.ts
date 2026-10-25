import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { join, relative, sep } from "node:path";

/**
 * Per-machine settings, sync state and the sync token, all under `~/.jive/`.
 *
 * A file rather than environment variables: the endpoint and which machine this is differ per computer
 * and have to survive a login, which is exactly what a config file is for and exactly what an environment
 * variable is not. Which folders to sync is not in here: they are detected, and the choice to leave one
 * out is kept on the server so the dashboard can change it and a reinstalled daemon still remembers it.
 */

const JIVE_HOME = join(homedir(), ".jive");
export const CONFIG_PATH = join(JIVE_HOME, "skill-sync.json");
const STATE_PATH = join(JIVE_HOME, "skill-sync-state.json");
/**
 * The sync token, written at sign-in so the daemon is still signed in after a restart, a reboot or an
 * upgrade. An ordinary file: anything that can read the home directory can copy the token, and the
 * dashboard can revoke it.
 */
export const TOKEN_PATH = join(JIVE_HOME, "skill-sync-token.json");
/**
 * How the CLI reaches the running daemon: a Unix socket in `~/.jive/`, or a named pipe on Windows. Only
 * this user can open either, which is what lets the CLI hand the daemon work that involves the token.
 */
export const CONTROL_SOCKET = process.platform === "win32"
  ? `\\\\.\\pipe\\jive-skill-sync-${userInfo().username}`
  : join(JIVE_HOME, "skill-sync.sock");

/** Managed by Claude's own cloud sync; see `Settings.exclude`. */
const DEFAULT_EXCLUDE = ["synced"] as const;

/** What `~/.jive/skill-sync.json` holds: nothing secret, so it can live in a file. */
export interface Settings {
  readonly endpoint: string;
  /**
   * Top-level directory names under each synced folder to leave alone.
   *
   * `synced` holds the skills Claude already pulls from the cloud itself. Syncing them here would mean
   * two systems writing the same files, each undoing the other, and none of them are yours to edit.
   * The list applies to every detected folder, so in Codex's `~/.agents/skills` it keeps a skill named
   * `synced` from syncing.
   */
  readonly exclude: ReadonlyArray<string>;
  /** Names this machine on the server: on the dashboard, and as the machine each edit came from. */
  readonly machine: string;
}

/** Settings plus the token, which the daemon has once signed in. */
export interface Config extends Settings {
  readonly token: string;
}

/** Sync progress for one folder. Each folder syncs with the server on its own, so each has its own. */
export interface State {
  /** Highest server sequence number already applied. */
  cursor: number;
  /** Last hash this machine agreed with the server on, per relative path. Absent means never synced. */
  known: Record<string, string>;
  /** The synced list as of last cycle, to notice a skill being added to it. */
  skills?: string[];
}

/** Every folder's `State`, keyed by the folder's absolute path. */
export type States = Record<string, State>;

/**
 * The settings, writing a template on first run. Undefined when the file lacks an endpoint or a machine
 * name, which only happens if someone edited it.
 */
export function loadSettings(): Settings | undefined {
  if (!existsSync(CONFIG_PATH)) {
    mkdirSync(JIVE_HOME, { recursive: true });
    writeFileSync(CONFIG_PATH, `${JSON.stringify({
      endpoint: "https://skill-sync.jive.sh",
      machine: machineName(),
      exclude: DEFAULT_EXCLUDE,
    }, null, 2)}\n`);
  }
  const settings = readJson<Partial<Settings>>(CONFIG_PATH);
  if (!settings.endpoint || !settings.machine) return undefined;
  return { endpoint: settings.endpoint, machine: settings.machine, exclude: settings.exclude ?? DEFAULT_EXCLUDE };
}

function readJson<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return {} as T;
  }
}

/**
 * Every folder's sync state.
 *
 * Before folders were detected the file held one folder's `{ cursor, known }`, for the folder then named
 * by `skillsDir` in the settings. That state is carried over to that folder: dropping it would make the
 * folder look never-synced, and every file in it that differs from the server would become a conflict.
 */
export function loadStates(): States {
  const stored = readJson<Partial<State> & { folders?: States }>(STATE_PATH);
  if (stored.folders !== undefined) return stored.folders;
  const legacyFolder = readJson<{ skillsDir?: string }>(CONFIG_PATH).skillsDir;
  if (legacyFolder !== undefined && stored.cursor !== undefined && stored.known !== undefined) {
    return { [legacyFolder]: { cursor: stored.cursor, known: stored.known } };
  }
  return {};
}

/** The saved token, or undefined when this machine is signed out. */
export function loadToken(): string | undefined {
  return readJson<{ token?: string }>(TOKEN_PATH).token;
}

export function saveToken(token: string): void {
  mkdirSync(JIVE_HOME, { recursive: true });
  writeFileSync(TOKEN_PATH, `${JSON.stringify({ token }, null, 2)}\n`);
}

export function deleteToken(): void {
  rmSync(TOKEN_PATH, { force: true });
}

export function stateFor(states: States, folder: string): State {
  states[folder] ??= { cursor: 0, known: {} };
  return states[folder];
}

export function saveStates(states: States): void {
  mkdirSync(JIVE_HOME, { recursive: true });
  writeFileSync(STATE_PATH, `${JSON.stringify({ folders: states }, null, 2)}\n`);
}

/**
 * A name ending in `.lock` is another program's lock, never an agent home, a skill or a skill's file.
 * Claude Code locks a path by creating an empty `<path>.lock` folder beside it and removing it when done;
 * counted as an agent home, `~/.claude-<name>.lock` was filled with skills and the lock could not be released.
 */
export const isLock = (name: string): boolean => name.endsWith(".lock");

/** `HOSTNAME` is not set on macOS, so the template was writing "unknown" on exactly this machine. */
function machineName(): string {
  return hostname().replace(/\.local$/, "").replace(/[^A-Za-z0-9-]+/g, "-") || "unknown";
}

/**
 * The `skills` folder of every agent home on this machine: Claude's `~/.claude` and each
 * `~/.claude-<name>`, and Codex's `~/.agents/skills`, where Codex reads a user's skills. Codex counts when
 * either `~/.agents` or Codex's own home `~/.codex` exists, because a machine with Codex installed may
 * have no `~/.agents` yet.
 *
 * Every home is a candidate, whether or not it has a `skills` folder yet, so a Claude account added
 * later joins without anyone listing it. Which of them actually sync is the user's choice on the
 * dashboard; a folder that is synced and missing is created.
 */
export function detectFolders(): string[] {
  return [...new Set(readdirSync(homedir())
    .filter((entry) => entry === ".claude" || entry.startsWith(".claude-") || entry === ".agents" || entry === ".codex")
    .filter((entry) => !isLock(entry))
    .filter((entry) => statSync(join(homedir(), entry)).isDirectory())
    .map((entry) => join(homedir(), entry === ".codex" ? ".agents" : entry, "skills")))]
    .sort();
}

export function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Every file under a synced folder, as paths relative to it with forward slashes.
 *
 * Normalised because the same skill synced from Windows and macOS must be one row, not two.
 */
export function listLocalFiles(folder: string, exclude: ReadonlyArray<string> = DEFAULT_EXCLUDE): string[] {
  if (!existsSync(folder)) return [];

  const found: string[] = [];
  const walk = (dir: string, top: boolean): void => {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(".") || isLock(entry)) continue;
      if (top && exclude.includes(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, false);
      else found.push(relative(folder, full).split(sep).join("/"));
    }
  };
  walk(folder, true);
  return found.sort();
}
