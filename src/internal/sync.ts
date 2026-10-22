import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFLICT_SUFFIX, hashBytes, listLocalFiles, type Config, type State } from "./config";
import { invalidPathReason } from "./path";
import { backUp, type Conflict, type Resolution } from "./reconcile";
import { skillOf, type ReconciliationRequest } from "./wire";

/**
 * One sync cycle: take everything the server has that we do not, then offer everything we have that it
 * does not.
 *
 * Pull before push, deliberately. Pushing first would send a file the server already changed, get it
 * refused, and report a conflict that pulling would have resolved on its own.
 */

interface RemoteFile {
  readonly path: string;
  readonly hash: string | null;
  readonly deleted: boolean;
  readonly updatedAt: number;
  readonly updatedBy: string;
}

/**
 * How a cycle resolves a file changed both here and on the server. Without a `merge`, the server's copy
 * wins and this machine's is kept beside it as `.local`; with one, the two are merged and the result
 * is pushed. `onMerging` fires before a merge starts, since one can take minutes.
 */
export interface Reconciler {
  readonly merge: (conflict: Conflict) => Promise<Resolution>;
  readonly onMerging?: (path: string) => void;
}

export interface Report {
  readonly pulled: string[];
  readonly pushed: string[];
  readonly deletedLocally: string[];
  readonly conflicts: string[];
  /** Paths changed on both sides and merged; the merge is pushed in the same cycle. */
  readonly merged: string[];
  /** Merges that failed, with the reason; those paths fell back to `.local`. */
  readonly mergeFailures: string[];
  /** Every merge attempted this cycle, for the audit log. */
  readonly reconciliations: Omit<ReconciliationRequest, "folder">[];
  /** Paths the server offered that this machine refused to write. */
  readonly rejected: string[];
  /** A push lost a race to another machine; the next cycle pulls and reconciles it. */
  retry: boolean;
}

/** True when a report has nothing in it worth telling anyone. */
export function isQuiet(report: Report): boolean {
  return [report.pulled, report.pushed, report.deletedLocally, report.conflicts, report.merged,
    report.mergeFailures, report.rejected].every((list) => list.length === 0);
}

/**
 * `skills` is the synced list. Every other skill in the folder is local to it: never pushed, never
 * overwritten, never deleted by a sync.
 */
export async function syncOnce(
  config: Config, folder: string, state: State, skills: ReadonlySet<string>, reconciler?: Reconciler,
): Promise<Report> {
  const report: Report = {
    pulled: [], pushed: [], deletedLocally: [], conflicts: [], merged: [], mergeFailures: [], reconciliations: [],
    rejected: [], retry: false,
  };
  mkdirSync(folder, { recursive: true });

  // A skill added to the list since last cycle may have server files older than the cursor; re-read from the start.
  if ([...skills].some((skill) => !(state.skills ?? []).includes(skill))) state.cursor = 0;
  state.skills = [...skills].sort();
  // A skill removed from the list stops being tracked here. Left in `known`, its files would look deleted from this
  // folder and the push would tombstone them on every machine.
  for (const path of Object.keys(state.known)) {
    if (!skills.has(skillOf(path))) delete state.known[path];
  }

  const present = new Set(listLocalFiles(folder, config.exclude).filter((path) => skills.has(skillOf(path))));
  const ctx: Cycle = { config, folder, state, report, reconciler, skills };

  /**
   * Files deleted here since the last cycle, worked out before anything is fetched.
   *
   * A push does not advance this machine's cursor, so the next pull sees its own earlier write as news.
   * With the file now gone from disk that looked like "remote has it, we do not" and the pull put it
   * straight back, undoing the delete every time. Deciding what was deleted up front, and refusing to
   * recreate those paths, is what lets the push below turn them into tombstones.
   */
  const pendingDeletes = new Set(Object.keys(state.known).filter((path) => !present.has(path)));

  // `present` is passed through both passes and kept current: the pull removes tombstoned files and adds
  // new ones, and a push that read a stale snapshot would try to open a file the pull had just deleted.
  await pull(ctx, pendingDeletes, present);
  await push(ctx, present);
  return report;
}

interface Cycle {
  readonly config: Config;
  readonly folder: string;
  readonly state: State;
  readonly report: Report;
  readonly reconciler: Reconciler | undefined;
  readonly skills: ReadonlySet<string>;
}

async function pull(ctx: Cycle, pendingDeletes: Set<string>, present: Set<string>): Promise<void> {
  const { config, folder, state, report } = ctx;
  const response = await call(config, `/files?since=${state.cursor}`);
  const body = await response.json() as { cursor: number; files: RemoteFile[] };

  for (const file of body.files) {
    // The server is not trusted to supply a path either: one bad row would otherwise write outside the
    // skills directory on every machine that syncs.
    const badPath = invalidPathReason(file.path);
    if (badPath) {
      report.rejected.push(`${file.path} (${badPath})`);
      continue;
    }
    // Local to this folder: the server's version is not wanted here.
    if (!ctx.skills.has(skillOf(file.path))) continue;
    const local = join(folder, file.path);
    // Deleted here and not yet reported; the push pass owns this path for the rest of the cycle.
    if (pendingDeletes.has(file.path)) continue;

    if (file.deleted) {
      if (existsSync(local)) {
        // Never destroy content this machine never agreed with the server on. A file written here that
        // the server happens to have tombstoned — a fresh machine, or one that was offline through the
        // delete — is not the same file, and deleting it silently would lose work nobody could recover.
        const localHash = hashBytes(readFileSync(local));
        if (localHash !== state.known[file.path]) {
          writeFileSync(`${local}${CONFLICT_SUFFIX}`, readFileSync(local));
          report.conflicts.push(file.path);
        }
        rmSync(local, { force: true });
        report.deletedLocally.push(file.path);
      }
      present.delete(file.path);
      delete state.known[file.path];
      continue;
    }

    const localHash = existsSync(local) ? hashBytes(readFileSync(local)) : undefined;
    if (localHash === file.hash) {
      // Already identical — record agreement so the push pass does not treat it as a local edit.
      state.known[file.path] = file.hash!;
      continue;
    }

    const content = new Uint8Array(await (await call(config, `/content/${file.hash}`)).arrayBuffer());

    // Changed here and on the server. Merge the two when possible: the merge is written here, recorded as
    // based on the server's copy, and so goes out in this cycle's push.
    if (localHash !== undefined && localHash !== state.known[file.path]) {
      if (await mergeInto(ctx, file, local, content)) {
        present.add(file.path);
        continue;
      }
      // No merge: a local edit we have not pushed yet would be destroyed by overwriting, so it is kept
      // beside the incoming copy.
      writeFileSync(`${local}${CONFLICT_SUFFIX}`, readFileSync(local));
      report.conflicts.push(file.path);
    }

    mkdirSync(dirname(local), { recursive: true });
    writeFileSync(local, content);
    state.known[file.path] = file.hash!;
    present.add(file.path);
    report.pulled.push(file.path);
  }

  state.cursor = body.cursor;
}

/**
 * Merges this machine's copy with the server's and writes the result over the local file. False when
 * there is no merger, either side is not text, or the merge failed — the caller then keeps `.local`.
 */
async function mergeInto(ctx: Cycle, file: RemoteFile, local: string, remote: Uint8Array): Promise<boolean> {
  const { config, folder, state, report, reconciler } = ctx;
  if (reconciler === undefined) return false;

  const mine = readFileSync(local);
  const localText = asText(mine);
  const remoteText = asText(remote);
  if (localText === undefined || remoteText === undefined) return false;

  const known = state.known[file.path];
  const base = known === undefined ? null : await fetchText(config, known);
  const conflict: Conflict = {
    folder,
    path: file.path,
    local: {
      content: localText,
      label: `the copy in ${folder} on ${config.machine}, last edited ${statSync(local).mtime.toISOString()}`,
    },
    remote: {
      content: remoteText,
      label: `the synced copy, last uploaded by ${file.updatedBy} at ${new Date(file.updatedAt).toISOString()}`,
    },
    base,
  };

  backUp(conflict);
  reconciler.onMerging?.(file.path);
  let resolution: Resolution;
  try {
    resolution = await reconciler.merge(conflict);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    report.mergeFailures.push(`${file.path}: ${reason}`);
    report.reconciliations.push({
      path: file.path, outcome: "failed",
      conflict: "This machine's copy and the server's differ.",
      resolution: `Not merged: ${reason}. The server's version was kept and this machine's saved as ${file.path}${CONFLICT_SUFFIX}.`,
    });
    return false;
  }
  writeFileSync(local, resolution.merged);
  state.known[file.path] = file.hash!;
  report.merged.push(file.path);
  report.reconciliations.push({
    path: file.path, outcome: "merged", conflict: resolution.conflict, resolution: resolution.resolution,
  });
  return true;
}

/** Text only: a merge by a language model is meaningless for an image or a binary, and harmful. */
function asText(bytes: Uint8Array): string | undefined {
  if (bytes.length > 512 * 1024 || bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** The base is a nicety for the merge; if the server no longer has it, merge without one. */
async function fetchText(config: Config, hash: string): Promise<string | null> {
  try {
    return asText(new Uint8Array(await (await call(config, `/content/${hash}`)).arrayBuffer())) ?? null;
  } catch {
    return null;
  }
}

async function push(ctx: Cycle, present: Set<string>): Promise<void> {
  const { config, folder, state, report } = ctx;
  for (const path of present) {
    const bytes = readFileSync(join(folder, path));
    const hash = hashBytes(bytes);
    if (state.known[path] === hash) continue;

    const accepted = await put(config, {
      path,
      baseHash: state.known[path] ?? null,
      hash,
      content: Buffer.from(bytes).toString("base64"),
    });
    if (accepted) {
      state.known[path] = hash;
      report.pushed.push(path);
    } else {
      // Another machine wrote first. Not a conflict yet: the next cycle pulls its version and merges.
      report.retry = true;
    }
  }

  // A path we previously agreed on that is no longer on disk was deleted here, and the server needs the
  // tombstone or the next machine to sync will upload it back.
  for (const path of Object.keys(state.known)) {
    if (present.has(path)) continue;
    if (await put(config, { path, baseHash: state.known[path]!, hash: null, content: null })) {
      delete state.known[path];
      report.pushed.push(`${path} (deleted)`);
    } else {
      report.conflicts.push(path);
    }
  }
}

/** True when the server accepted the write; false means another machine got there first. */
async function put(config: Config, body: {
  path: string; baseHash: string | null; hash: string | null; content: string | null;
}): Promise<boolean> {
  const response = await fetch(`${config.endpoint}/files`, {
    method: "PUT",
    headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
    body: JSON.stringify({ ...body, machine: config.machine }),
  });
  if (response.status === 409) return false;
  if (!response.ok) throw new Error(`PUT /files ${body.path}: ${response.status} ${await response.text()}`);
  return true;
}

async function call(config: Config, path: string): Promise<Response> {
  const response = await fetch(`${config.endpoint}${path}`, {
    headers: { authorization: `Bearer ${config.token}` },
  });
  if (!response.ok) throw new Error(`GET ${path}: ${response.status} ${await response.text()}`);
  return response;
}
