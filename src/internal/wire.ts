/**
 * The shapes the daemon and the service exchange.
 *
 * Declared in the library and imported by the service so there is one definition rather than two that
 * drift. The service depends on the library; nothing goes the other way.
 */

export interface RemoteFile {
  readonly path: string;
  /** Null when the file is deleted; the row stays, so the deletion reaches every machine. */
  readonly hash: string | null;
  /** When this version was edited, in milliseconds since the epoch. The latest edit wins. */
  readonly editedAt: number;
  readonly updatedBy: string;
}

export interface ListFilesResponse {
  /** Highest sequence number in this page; the caller sends it back as `since`. */
  readonly cursor: number;
  readonly files: ReadonlyArray<RemoteFile>;
}

/** Taken only when `editedAt` is later than the edit the server holds; refused with 409 otherwise. */
export interface PutFileRequest {
  readonly path: string;
  /** When the file was edited: its modification time, or for a deletion, when it was noticed. */
  readonly editedAt: number;
  /** Null to delete. */
  readonly hash: string | null;
  /** Base64, absent for a delete. */
  readonly content: string | null;
  readonly machine: string;
}

/** Where a folder's sync stands, as the dashboard shows it. `attention` means a cycle failed; `detail` says why. */
export type FolderState = "idle" | "attention";

/**
 * A skill is a top-level entry of a skills folder — usually a directory like `jive/` holding `SKILL.md`
 * and its files — and it is the unit of opting in: all of its files sync, or none do, so a skill never
 * arrives half-present on another machine.
 */
export const skillOf = (path: string): string => path.split("/")[0]!;

/** A file and the SHA-256 of its content — the same hash the server stores, so copies can be compared. */
export interface FileHash {
  readonly path: string;
  readonly hash: string;
}

/** One skill as a folder holds it. */
export interface LocalSkill {
  readonly name: string;
  readonly files: ReadonlyArray<FileHash>;
}

/**
 * `POST /folders`: every folder this machine found, with the skills in each, for the dashboard. Answered
 * with the enabled folders, each with the synced list: the daemon pushes and pulls exactly those skills,
 * and never touches any other.
 */
export interface FoldersRequest {
  readonly folders: ReadonlyArray<{ readonly path: string; readonly skills: ReadonlyArray<LocalSkill> }>;
}
export interface FolderPrefs {
  readonly path: string;
  readonly skills: ReadonlyArray<string>;
}
export interface FoldersResponse {
  readonly folders: ReadonlyArray<FolderPrefs>;
}

/** `GET /skills`: the synced list, as `skill-sync list` shows it. Deleted skills are not on it. */
export interface ListSkillsResponse {
  readonly skills: ReadonlyArray<ListedSkill>;
}
export interface ListedSkill {
  readonly name: string;
  /** Live files on the server; zero for a skill ticked before any machine has pushed it. */
  readonly files: number;
  /** The latest edit of any of its files, and the display name of the machine it came from; null with no files. */
  readonly editedAt: number | null;
  readonly editedBy: string | null;
}

/**
 * The header a daemon names its own version in when it opens its WebSocket to the hub, so the dashboard
 * can show which version each machine runs. Daemons before 0.4.6 do not send it.
 */
export const DAEMON_VERSION_HEADER = "x-skill-sync-version";

/** Daemon → hub, over the daemon's WebSocket. */
export type DaemonMessage = {
  readonly type: "status";
  readonly folder: string;
  readonly state: FolderState;
  readonly detail?: string;
  /** A one-line summary of what the last cycle changed, when it changed anything. */
  readonly activity?: string;
};

/** Hub → daemon. `prefs` replaces what syncs; `changed` means another write landed on the server. */
export type HubToDaemon =
  | { readonly type: "prefs"; readonly folders: ReadonlyArray<FolderPrefs> }
  | { readonly type: "changed" };

export interface SkillView {
  readonly name: string;
  /** On the list of synced skills, which every enabled folder sends and receives. */
  readonly synced: boolean;
  /** The folder has a copy on disk. */
  readonly local: boolean;
  readonly files: ReadonlyArray<FileHash>;
}

export interface FolderView {
  readonly path: string;
  readonly enabled: boolean;
  readonly state: FolderState;
  readonly detail: string | null;
  readonly lastActivityAt: number | null;
  readonly lastActivity: string | null;
  readonly skills: ReadonlyArray<SkillView>;
}

export interface MachineView {
  /** The name the machine's daemon uses; it identifies the machine and never changes. */
  readonly machine: string;
  /** What the dashboard calls it: renamed there, or the machine name until then. */
  readonly name: string;
  /** True while this machine's daemon holds a connection to the hub. */
  readonly online: boolean;
  /** The version its connected daemon runs; null while offline, or when the daemon is too old to say. */
  readonly daemonVersion: string | null;
  readonly lastSeen: number | null;
  readonly folders: ReadonlyArray<FolderView>;
}

/** A skill on the synced list, as the server holds it: the version every enabled folder converges on. */
export interface SyncedSkill {
  readonly name: string;
  readonly files: ReadonlyArray<FileHash & { readonly updatedBy: string; readonly editedAt: number }>;
}

/** Hub → dashboard: the whole picture, resent on every change. It is small, and a diff protocol is not. */
export interface Snapshot {
  readonly type: "snapshot";
  /** The deployed service version. A dashboard built by another version reloads itself. */
  readonly version: string;
  /** The `latest` version of this package on npm, which every daemon upgrades to; null if npm could not be reached. */
  readonly publishedVersion: string | null;
  /** Display name for every machine name that appears anywhere in the snapshot, including old log entries. */
  readonly names: Readonly<Record<string, string>>;
  readonly skills: ReadonlyArray<SyncedSkill>;
  readonly machines: ReadonlyArray<MachineView>;
}

/** Dashboard → hub. */
export type DashboardMessage =
  | { readonly type: "setFolder"; readonly machine: string; readonly path: string; readonly enabled: boolean }
  /** Adds a skill to the synced list, or removes it: one list for every machine and folder. */
  | { readonly type: "setSkill"; readonly skill: string; readonly synced: boolean }
  /** An empty name restores the machine name. */
  | { readonly type: "renameMachine"; readonly machine: string; readonly name: string };
