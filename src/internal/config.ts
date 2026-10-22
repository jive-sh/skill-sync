import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, relative, sep } from "node:path";

/**
 * Per-machine settings and sync state, both under `~/.jive/`.
 *
 * A file rather than environment variables: the endpoint and which machine this is differ per computer
 * and have to survive a login, which is exactly what a config file is for and exactly what an environment
 * variable is not. Which folders to sync is not in here: they are detected, and the choice to leave one
 * out is kept on the server so the dashboard can change it and a reinstalled daemon still remembers it.
 */

const JIVE_HOME = join(homedir(), ".jive");
export const CONFIG_PATH = join(JIVE_HOME, "skill-sync.json");
/**
 * The token lives on its own, outside `~/.jive/`, because it is the one part that must not travel with
 * the rest. Endpoint and machine name are settings you could paste into a gist; this
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
   * Top-level directory names under each synced folder to leave alone.
   *
   * `synced` holds the skills Claude already pulls from the cloud itself. Syncing them here would mean
   * two systems writing the same files, each undoing the other, and none of them are yours to edit.
   */
  readonly exclude: ReadonlyArray<string>;
  readonly token: string;
  /** Names this machine in conflict messages, so "who overwrote this" has an answer. */
  readonly machine: string;
}

/** Either the settings, or the one sentence telling the user what to go and fill in. */
export type ConfigResult =
  | { readonly ok: true; readonly config: Config }
  | { readonly ok: false; readonly reason: string };

/** Sync progress for one folder. Each folder syncs with the server on its own, so each has its own. */
export interface State {
  /** Highest server sequence number already applied. */
  cursor: number;
  /** Last hash this machine agreed with the server on, per relative path. Absent means never synced. */
  known: Record<string, string>;
  /** The skills this folder synced last cycle, to notice one being opted in. */
  skills?: string[];
}

/** Every folder's `State`, keyed by the folder's absolute path. */
export type States = Record<string, State>;

/**
 * The settings alone, with no token required.
 *
 * `login` needs these precisely when the token is missing, so it cannot go through `loadConfig` — that
 * reports "not configured" for a missing token and would refuse to run the command that supplies one.
 */
export function loadSettings(): { endpoint: string; machine: string } | undefined {
  loadConfig();
  const settings = readJson<Partial<Config>>(CONFIG_PATH);
  if (!settings.endpoint || !settings.machine) return undefined;
  return { endpoint: settings.endpoint, machine: settings.machine };
}

/** Reads both files, writing a template for whichever is missing, and says what is still needed. */
export function loadConfig(): ConfigResult {
  if (!existsSync(CONFIG_PATH)) {
    mkdirSync(JIVE_HOME, { recursive: true });
    writeFileSync(CONFIG_PATH, `${JSON.stringify({
      endpoint: "https://skill-sync.jive.sh",
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

  if (!settings.endpoint || !settings.machine) {
    return { ok: false, reason: `${CONFIG_PATH} needs an endpoint and a machine name` };
  }
  if (!token) {
    return { ok: false, reason: `${TOKEN_PATH} needs the sync token` };
  }
  return {
    ok: true,
    config: { endpoint: settings.endpoint, machine: settings.machine, exclude: settings.exclude ?? DEFAULT_EXCLUDE, token },
  };
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

export function stateFor(states: States, folder: string): State {
  states[folder] ??= { cursor: 0, known: {} };
  return states[folder];
}

export function saveStates(states: States): void {
  mkdirSync(JIVE_HOME, { recursive: true });
  writeFileSync(STATE_PATH, `${JSON.stringify({ folders: states }, null, 2)}\n`);
}

/** `HOSTNAME` is not set on macOS, so the template was writing "unknown" on exactly this machine. */
function machineName(): string {
  return hostname().replace(/\.local$/, "").replace(/[^A-Za-z0-9-]+/g, "-") || "unknown";
}

/**
 * The `skills` folder of every Claude home on this machine: `~/.claude` and each `~/.claude-<name>`.
 *
 * Every home is a candidate, whether or not it has a `skills` folder yet, so a Claude account added
 * later joins without anyone listing it. Which of them actually sync is the user's choice on the
 * dashboard; a folder that is synced and missing is created.
 */
export function detectFolders(): string[] {
  return readdirSync(homedir())
    .filter((entry) => entry === ".claude" || entry.startsWith(".claude-"))
    .filter((entry) => statSync(join(homedir(), entry)).isDirectory())
    .map((entry) => join(homedir(), entry, "skills"))
    .sort();
}

export function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Suffix for the copy kept when an incoming change would have overwritten a local edit. */
export const CONFLICT_SUFFIX = ".local";

/**
 * Every file under a synced folder, as paths relative to it with forward slashes.
 *
 * Normalised because the same skill synced from Windows and macOS must be one row, not two.
 *
 * Conflict copies are skipped. They are this machine's evidence of a collision, not content anyone else
 * asked for, and syncing them spreads one machine's mess to every other machine.
 */
export function listLocalFiles(folder: string, exclude: ReadonlyArray<string> = DEFAULT_EXCLUDE): string[] {
  if (!existsSync(folder)) return [];

  const found: string[] = [];
  const walk = (dir: string, top: boolean): void => {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(".")) continue;
      if (top && exclude.includes(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, false);
      else if (!entry.endsWith(CONFLICT_SUFFIX)) found.push(relative(folder, full).split(sep).join("/"));
    }
  };
  walk(folder, true);
  return found.sort();
}
