import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFLICT_SUFFIX, hashBytes, listLocalFiles, type Config, type State } from "./config";
import { invalidPathReason } from "./path";

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
  readonly updatedBy: string;
}

export interface Report {
  readonly pulled: string[];
  readonly pushed: string[];
  readonly deletedLocally: string[];
  readonly conflicts: string[];
  /** Paths the server offered that this machine refused to write. */
  readonly rejected: string[];
}

export async function syncOnce(config: Config, state: State): Promise<Report> {
  const report: Report = { pulled: [], pushed: [], deletedLocally: [], conflicts: [], rejected: [] };
  const present = new Set(listLocalFiles(config.skillsDir));

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
  await pull(config, state, report, pendingDeletes, present);
  await push(config, state, report, present);
  return report;
}

async function pull(
  config: Config, state: State, report: Report, pendingDeletes: Set<string>, present: Set<string>,
): Promise<void> {
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
    const local = join(config.skillsDir, file.path);
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

    // A local edit we have not pushed yet would be destroyed by overwriting. Keep it beside the incoming
    // copy and let the push pass raise the conflict rather than deciding which one wins here.
    if (localHash !== undefined && localHash !== state.known[file.path]) {
      writeFileSync(`${local}${CONFLICT_SUFFIX}`, readFileSync(local));
      report.conflicts.push(file.path);
    }

    const content = new Uint8Array(await (await call(config, `/content/${file.hash}`)).arrayBuffer());
    mkdirSync(dirname(local), { recursive: true });
    writeFileSync(local, content);
    state.known[file.path] = file.hash!;
    present.add(file.path);
    report.pulled.push(file.path);
  }

  state.cursor = body.cursor;
}

async function push(config: Config, state: State, report: Report, present: Set<string>): Promise<void> {
  for (const path of present) {
    const bytes = readFileSync(join(config.skillsDir, path));
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
      report.conflicts.push(path);
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
