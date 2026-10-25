/**
 * What the service needs from this package.
 *
 * The daemon and CLI are the product; this entrypoint exists so the service can share the path rules
 * and wire types rather than restate them. A rule restated is a rule that drifts, and these two are
 * exactly the pair that must not: one validates what the other writes to disk.
 */

export { invalidPathReason, isValidPath } from "./internal/path";
export { DAEMON_VERSION_HEADER, skillOf } from "./internal/wire";
export type {
  DaemonMessage, DashboardMessage, FileHash, FolderPrefs, FolderState, FolderView, FoldersRequest, FoldersResponse,
  HubToDaemon, ListedSkill, ListFilesResponse, ListSkillsResponse, LocalSkill, MachineView, PutFileRequest, RemoteFile,
  SkillView, Snapshot, SyncedSkill,
} from "./internal/wire";
