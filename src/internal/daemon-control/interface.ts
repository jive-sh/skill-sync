import { Context, type Effect } from "effect";
import type { DaemonFailed, DaemonNotRunning } from "../control";
import type { ListedSkill } from "../wire";

export type DaemonError = DaemonNotRunning | DaemonFailed;

/** What `addSkill` did; see the `added` event in `control.ts`. */
export interface AddedSkill {
  /** False when the skill was already on the synced list. */
  readonly added: boolean;
  /** This machine's folders that hold the skill. */
  readonly folders: ReadonlyArray<string>;
  /** Those of them ticked on the dashboard, which upload it. */
  readonly syncingFolders: ReadonlyArray<string>;
}

/**
 * What the CLI asks of the running daemon, which owns the sync token, so every request that needs the token goes
 * through it. Every method fails with `DaemonNotRunning` when no daemon listens; none starts one by itself, so Tab
 * completion can ask without waiting for a daemon to start.
 */
export interface IDaemonControl {
  /**
   * Signs this machine in. `openSignInPage` is given the page where the passkey is verified, and the method
   * returns the machine's name once the browser has handed the daemon its token.
   */
  login(openSignInPage: (url: string) => Effect.Effect<void>): Effect.fn.Return<string, DaemonError>;
  /** Signs this machine out; returns whether the server revoked the token. */
  logout(): Effect.fn.Return<boolean, DaemonError>;
  /** The synced list, as the server holds it. */
  listSyncedSkills(): Effect.fn.Return<ReadonlyArray<ListedSkill>, DaemonError>;
  /** Puts a skill on this machine on the synced list, once the daemon has checked its files. */
  addSkill(skill: string): Effect.fn.Return<AddedSkill, DaemonError>;
  /** Starts this package's registered daemon through its service manager (launchd, systemd or Task Scheduler). */
  startDaemon(): Effect.fn.Return<void>;
}

export class DaemonControl extends Context.Service<DaemonControl, IDaemonControl>()("DaemonControl") {}
