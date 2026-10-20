/**
 * What the service needs from this package.
 *
 * The daemon and CLI are the product; this entrypoint exists so the service can share the path rules
 * and wire types rather than restate them. A rule restated is a rule that drifts, and these two are
 * exactly the pair that must not: one validates what the other writes to disk.
 */

export { invalidPathReason, isValidPath } from "./internal/path";
export type { ListFilesResponse, PutFileRequest, RemoteFile } from "./internal/wire";
