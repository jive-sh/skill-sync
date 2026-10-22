/**
 * The shapes the daemon and the service exchange.
 *
 * Declared in the library and imported by the service so there is one definition rather than two that
 * drift. The service depends on the library; nothing goes the other way.
 */

export interface RemoteFile {
  readonly path: string;
  /** Null when the file is deleted; the row stays as a tombstone. */
  readonly hash: string | null;
  readonly deleted: boolean;
  readonly updatedAt: number;
  readonly updatedBy: string;
}

export interface ListFilesResponse {
  /** Highest sequence number in this page; the caller sends it back as `since`. */
  readonly cursor: number;
  readonly files: ReadonlyArray<RemoteFile>;
}

export interface PutFileRequest {
  readonly path: string;
  /** What the client believes the server holds. The write is refused if that is no longer true. */
  readonly baseHash: string | null;
  /** Null to delete. */
  readonly hash: string | null;
  /** Base64, absent for a delete. */
  readonly content: string | null;
  readonly machine: string;
}

/**
 * Where a folder's sync stands, as the dashboard shows it.
 *
 * `reconciling` means Claude is merging two versions of a file on that machine; `attention` means a cycle
 * failed or a conflict could not be merged, and `detail` says which.
 */
export type FolderState = "idle" | "reconciling" | "attention";

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
  /** True when this folder has synced it before, which makes it synced by default rather than local. */
  readonly tracked: boolean;
}

/**
 * `POST /folders`: every folder this machine found, with the skills in each. Answered with the folders
 * to sync and, for each, the skills that sync there. A skill left out stays local to its folder.
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

/** `POST /reconciliations`: one merge Claude did, or failed to do, for the audit log. */
export interface ReconciliationRequest {
  readonly folder: string;
  readonly path: string;
  readonly outcome: "merged" | "failed";
  /** What differed between the two versions, in a sentence or two. */
  readonly conflict: string;
  /** What the merge kept, dropped or reworded — or why it failed. */
  readonly resolution: string;
}

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
  /** Checked on the dashboard: this folder sends and receives the skill. */
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
  readonly lastSeen: number | null;
  readonly folders: ReadonlyArray<FolderView>;
}

/** A skill as the server holds it: the synced version every opted-in folder converges on. */
export interface SyncedSkill {
  readonly name: string;
  readonly files: ReadonlyArray<FileHash & { readonly updatedBy: string; readonly updatedAt: number }>;
}

export interface ReconciliationView extends ReconciliationRequest {
  readonly at: number;
  readonly machine: string;
}

/** Hub → dashboard: the whole picture, resent on every change. It is small, and a diff protocol is not. */
export interface Snapshot {
  readonly type: "snapshot";
  /** The deployed service version. A dashboard built by another version reloads itself. */
  readonly version: string;
  /** Display name for every machine name that appears anywhere in the snapshot, including old log entries. */
  readonly names: Readonly<Record<string, string>>;
  readonly skills: ReadonlyArray<SyncedSkill>;
  readonly reconciliations: ReadonlyArray<ReconciliationView>;
  readonly machines: ReadonlyArray<MachineView>;
}

/** Dashboard → hub. */
export type DashboardMessage =
  | { readonly type: "setFolder"; readonly machine: string; readonly path: string; readonly enabled: boolean }
  | { readonly type: "setSkill"; readonly machine: string; readonly folder: string; readonly skill: string; readonly synced: boolean }
  /** An empty name restores the machine name. */
  | { readonly type: "renameMachine"; readonly machine: string; readonly name: string };
