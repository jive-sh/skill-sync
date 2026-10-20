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
