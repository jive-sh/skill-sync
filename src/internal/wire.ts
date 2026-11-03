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

/**
 * Whether a name can be a skill's: lowercase letters and digits in hyphen-joined words, at most 64
 * characters, which is what Claude, Codex and Grok accept as a skill name. The daemon checks it before
 * asking, and the service again before writing, so both judge a name by this one rule.
 */
export const isSkillName = (name: string): boolean => name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);

/** `PUT /skills/<name>`: puts a skill on the synced list. `added` is false when it was already on it. */
export interface AddSkillResponse {
  readonly added: boolean;
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

/** One usage limit of an account: how much of it is used and when it starts over. */
export interface UsageWindow {
  /**
   * The limit's name, the same for every tool and machine so the dashboard gives each one a column:
   * `5-hour`, `weekly`, or a limit on one model, such as `weekly Fable`.
   */
  readonly name: string;
  /** How long the window is, in minutes (300 for five hours, 10080 for a week); null when the tool does not say. */
  readonly minutes: number | null;
  /** Percent of the limit used, from 0 to 100. */
  readonly usedPercent: number;
  /** When the window starts over, in milliseconds since the epoch; null when no window is running. */
  readonly resetsAt: number | null;
}

/** Money as the tool records it: an amount in the currency's smallest unit, so 1234 with exponent 2 is 12.34. */
export interface Money {
  readonly amountMinor: number;
  readonly currency: string;
  readonly exponent: number;
}

/**
 * Which account a tool is signed in to, as its own CLI reports it (`claude auth status`, Codex's
 * `account/read`). The same account signed in on several machines has the same `id`, so the dashboard
 * shows it once.
 */
export interface AccountIdentity {
  /** Claude's organization id; Codex's email. */
  readonly id: string;
  /** The email the account is signed in with. */
  readonly email: string;
  /** The plan as the tool names it (`max`, `pro`); null when it does not say. */
  readonly plan: string | null;
}

/**
 * The account's plan limits, which its provider counts across every machine it is used on.
 *
 * `reading`: `asOf` is when they were read. `source` says from where: `account` when the tool's CLI fetched
 * them from its service for this reading (`claude /usage`, Codex's `account/rateLimits/read`), `saved`
 * when the CLI could not be run and they come from the tool's own record of its last fetch, which is as
 * old as the tool's last use of the account. `none`: the account has no plan limits, or the tool offers
 * no way to read them; `reason` says which. `unknown`: reading them failed; `reason` says why.
 */
export type AccountLimits =
  | {
    readonly state: "reading";
    readonly asOf: number;
    readonly source: "account" | "saved";
    /** With `saved`: why the CLI was not asked, or failed. */
    readonly cliFailure?: string;
    readonly windows: ReadonlyArray<UsageWindow>;
    /** Spent beyond the plan, when the account pays for usage past its limits; absent when it does not. */
    readonly spent?: { readonly used: Money; readonly limit: Money | null };
  }
  | { readonly state: "none"; readonly reason: string }
  | { readonly state: "unknown"; readonly reason: string };

/**
 * What this machine's sessions of the account used over the last `periodDays` days, read from the files
 * the tool writes on this machine. Other machines' use of the same account is not in it.
 *
 * `spend`: the sum of the tool's own cost figure for each session: Claude Code's estimate at list price,
 * which it saves when a session ends, is cleared, resumed or forked, so a running session counts as of
 * its last save; Grok's, from `grok usage`. `tokens`: the tokens Codex counted, cached input included.
 */
export type LocalUse =
  | {
    readonly state: "spend";
    /** When the newest session counted was last active. */
    readonly asOf: number;
    readonly periodDays: number;
    readonly spent: Money;
    readonly sessions: number;
    /** Claude Code could not price a model in at least one session, so the true cost is higher. */
    readonly partial: boolean;
    /** `bedrock` when the account's settings or the model IDs its sessions used say so; null when nothing says. */
    readonly provider: "bedrock" | null;
  }
  | {
    readonly state: "tokens";
    readonly periodDays: number;
    readonly count: number;
    readonly sessions: number;
    /** In a total over machines: one machine's could not be read, so the true count is higher. */
    readonly partial?: true;
  }
  | { readonly state: "none" }
  | { readonly state: "unknown"; readonly reason: string };

/**
 * One Claude, Codex or Grok account on a machine. Never a credential: the CLIs make the authenticated
 * calls, and only these numbers and the account's email leave the machine.
 */
export interface AccountUsage {
  readonly tool: "claude" | "codex" | "grok";
  /** The account's folder in the home directory, such as `.claude-work` or `.codex`. */
  readonly home: string;
  /** Null when the tool is signed out, or cannot say who is signed in (Grok). */
  readonly identity: AccountIdentity | null;
  readonly limits: AccountLimits;
  readonly local: LocalUse;
}

/** Daemon → hub, over the daemon's WebSocket. */
export type DaemonMessage =
  | {
    readonly type: "status";
    readonly folder: string;
    readonly state: FolderState;
    readonly detail?: string;
    /** A one-line summary of what the last cycle changed, when it changed anything. */
    readonly activity?: string;
  }
  /** Every account on the machine, sent on connecting and whenever a number changes. The hub drops entries in the shape daemons before 0.5.0 sent. */
  | { readonly type: "usage"; readonly accounts: ReadonlyArray<AccountUsage> };

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
  readonly accounts: ReadonlyArray<AccountView>;
}

/** One machine's latest reading of one account folder, as the service keeps it, offline machines included. */
export interface MachineAccountReading {
  readonly machine: string;
  /** When the machine's daemon last sent this account. */
  readonly reportedAt: number;
  readonly usage: AccountUsage;
}

/**
 * Which account a dashboard row is: its email, else the id its tool gives, else one folder on one machine,
 * for an account its tool cannot name (Grok, Amazon Bedrock, signed out).
 */
export type AccountKey =
  | { readonly kind: "email"; readonly email: string }
  | { readonly kind: "id"; readonly id: string }
  | { readonly kind: "unidentified"; readonly machine: string; readonly home: string };

/** One account across every machine that has reported it. */
export interface AccountView {
  readonly tool: AccountUsage["tool"];
  readonly key: AccountKey;
  readonly identity: AccountIdentity | null;
  /** From the freshest reading any machine sent: the provider counts every machine's use against one limit. */
  readonly limits: AccountLimits;
  /** Every machine's local use added up; `partial` when a machine's could not be read. */
  readonly localTotal: LocalUse;
  /** Each machine's latest reading, by machine name. */
  readonly machines: ReadonlyArray<MachineAccountReading>;
}

/** Dashboard → hub. */
export type DashboardMessage =
  | { readonly type: "setFolder"; readonly machine: string; readonly path: string; readonly enabled: boolean }
  /** Adds a skill to the synced list, or removes it: one list for every machine and folder. */
  | { readonly type: "setSkill"; readonly skill: string; readonly synced: boolean }
  /** An empty name restores the machine name. */
  | { readonly type: "renameMachine"; readonly machine: string; readonly name: string };
