/**
 * What the service needs from this package.
 *
 * The daemon and CLI are the product; this entrypoint exists so the service can share the path rules
 * and wire types rather than restate them. A rule restated is a rule that drifts, and these two are
 * exactly the pair that must not: one validates what the other writes to disk.
 */

export { invalidPathReason, isValidPath } from "./internal/path";
export { DAEMON_VERSION_HEADER, MACHINE_HEADER, MACHINE_MISMATCH_STATUS, isSkillName, skillOf } from "./internal/wire";
export type {
  AccountIdentity, AccountKey, AccountLimits, AccountUsage, AccountView, MachineAccountReading, MachineAccountView, AddSkillResponse, DaemonMessage, LocalUse, LocalUseTotal, Money, SessionUse, UsageWindow, DashboardMessage, FileHash, FolderPrefs, FolderState, FolderView, FoldersRequest, FoldersResponse,
  HubToDaemon, ListedSkill, ListFilesResponse, ListSkillsResponse, LocalSkill, MachineMismatch, MachineView, PutFileRequest, RemoteFile, SignInClaim, SignInRequestCreated,
  LimitChange, LimitName, MachineRefinement, Refinement, RefinementPageData, SkillView, Snapshot, SyncedSkill,
} from "./internal/wire";
