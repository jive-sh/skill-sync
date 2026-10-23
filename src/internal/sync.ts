import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hashBytes, listLocalFiles, type Config, type State } from "./config";
import { invalidPathReason } from "./path";
import { skillOf, type ListFilesResponse, type PutFileRequest } from "./wire";

/**
 * One sync cycle: take every newer edit the server has, then send every newer edit this folder has.
 *
 * The latest edit wins, always. Every file carries the time it was last edited: here, the file's
 * modification time; on the server, the edit time of the version it holds. When this folder and the
 * server disagree about a file, whichever was edited later is kept, on both sides. Nothing is merged and
 * nothing is set aside, so every folder converges on the same bytes.
 *
 * A pulled file is given the server's edit time as its modification time, so the next cycle does not
 * mistake the pull for a local edit.
 */

export interface Report {
  readonly pulled: string[];
  readonly pushed: string[];
  readonly deletedLocally: string[];
  /** Paths the server offered that this machine refused to write. */
  readonly rejected: string[];
}

/** True when a report has nothing in it worth telling anyone. */
export function isQuiet(report: Report): boolean {
  return [report.pulled, report.pushed, report.deletedLocally, report.rejected].every((list) => list.length === 0);
}

/**
 * `skills` is the synced list. Every other skill in the folder is local to it: never pushed, never
 * overwritten, never deleted by a sync.
 */
export async function syncOnce(config: Config, folder: string, state: State, skills: ReadonlySet<string>): Promise<Report> {
  const report: Report = { pulled: [], pushed: [], deletedLocally: [], rejected: [] };
  mkdirSync(folder, { recursive: true });

  // A skill added to the list since last cycle may have server files older than the cursor; re-read from the start.
  if ([...skills].some((skill) => !(state.skills ?? []).includes(skill))) state.cursor = 0;
  state.skills = [...skills].sort();
  // A skill removed from the list stops being tracked here. Left in `known`, its files would look deleted
  // from this folder and the push would delete them on every machine.
  for (const path of Object.keys(state.known)) {
    if (!skills.has(skillOf(path))) delete state.known[path];
  }

  const present = new Set(listLocalFiles(folder, config.exclude).filter((path) => skills.has(skillOf(path))));
  // Files deleted here since the last cycle. When they were deleted is not recorded anywhere, so the
  // deletion counts as an edit made now: the pull leaves these paths alone and the push deletes them.
  const deletedHere = new Set(Object.keys(state.known).filter((path) => !present.has(path)));

  const ctx: Cycle = { config, folder, state, report, skills };
  await pull(ctx, deletedHere, present);
  await push(ctx, present);
  return report;
}

interface Cycle {
  readonly config: Config;
  readonly folder: string;
  readonly state: State;
  readonly report: Report;
  readonly skills: ReadonlySet<string>;
}

/** When this file was last edited here, to the millisecond the server stores. */
const editedAt = (file: string): number => Math.floor(statSync(file).mtimeMs);

async function pull(ctx: Cycle, deletedHere: ReadonlySet<string>, present: Set<string>): Promise<void> {
  const { config, folder, state, report } = ctx;
  const body = await (await call(config, `/files?since=${state.cursor}`)).json() as ListFilesResponse;

  for (const file of body.files) {
    // The server is not trusted to supply a path either: one bad row would otherwise write outside the
    // skills directory on every machine that syncs.
    const badPath = invalidPathReason(file.path);
    if (badPath) {
      report.rejected.push(`${file.path} (${badPath})`);
      continue;
    }
    if (!ctx.skills.has(skillOf(file.path))) continue;
    // Deleted here, which is newer than anything the server has; the push sends the deletion.
    if (deletedHere.has(file.path)) continue;

    const local = join(folder, file.path);
    const exists = existsSync(local);
    const localHash = exists ? hashBytes(readFileSync(local)) : undefined;
    if (localHash === (file.hash ?? undefined)) {
      if (file.hash === null) delete state.known[file.path];
      else state.known[file.path] = file.hash;
      continue;
    }
    // Edited here since this folder last agreed with the server, and later than the server's version:
    // this folder's edit wins, and the push sends it.
    if (exists && localHash !== state.known[file.path] && editedAt(local) > file.editedAt) continue;

    await apply(ctx, file, present);
  }

  state.cursor = body.cursor;
}

async function push(ctx: Cycle, present: Set<string>): Promise<void> {
  const { config, folder, state, report } = ctx;
  for (const path of [...present]) {
    const file = join(folder, path);
    const bytes = readFileSync(file);
    const hash = hashBytes(bytes);
    if (state.known[path] === hash) continue;
    const later = await put(config, { path, hash, content: Buffer.from(bytes).toString("base64"), editedAt: editedAt(file) });
    if (later === undefined) {
      state.known[path] = hash;
      report.pushed.push(path);
    } else {
      await apply(ctx, { path, ...later }, present);
    }
  }

  // A path this folder agreed on that is no longer on disk was deleted here. The server keeps the
  // deletion, or the next machine to sync would upload the file again.
  for (const path of Object.keys(state.known)) {
    if (present.has(path)) continue;
    const later = await put(config, { path, hash: null, content: null, editedAt: Date.now() });
    if (later === undefined) {
      delete state.known[path];
      report.pushed.push(`${path} (deleted)`);
    } else {
      await apply(ctx, { path, ...later }, present);
    }
  }
}

/** The server's version of a file, as it answers a refused write. */
interface ServerVersion {
  readonly hash: string | null;
  readonly editedAt: number;
}

/**
 * Writes the server's version of a file here: its bytes with its edit time, or a deletion. Used by the
 * pull, and by the push when the server refuses a write because it holds a later edit, so a refused write
 * settles at once rather than waiting for a pull that may never list the file again.
 */
async function apply(ctx: Cycle, file: ServerVersion & { readonly path: string }, present: Set<string>): Promise<void> {
  const { config, folder, state, report } = ctx;
  const local = join(folder, file.path);
  if (file.hash === null) {
    rmSync(local, { force: true });
    removeEmptyParents(folder, local);
    present.delete(file.path);
    delete state.known[file.path];
    report.deletedLocally.push(file.path);
    return;
  }
  const content = new Uint8Array(await (await call(config, `/content/${file.hash}`)).arrayBuffer());
  mkdirSync(dirname(local), { recursive: true });
  writeFileSync(local, content);
  utimesSync(local, new Date(), new Date(file.editedAt));
  state.known[file.path] = file.hash;
  present.add(file.path);
  report.pulled.push(file.path);
}

/** A deleted skill leaves no empty directory behind, which would still show up as a skill. */
function removeEmptyParents(folder: string, file: string): void {
  for (let dir = dirname(file); dir !== folder && dir.startsWith(folder); dir = dirname(dir)) {
    if (readdirSync(dir).length > 0) return;
    rmdirSync(dir);
  }
}

/** Undefined when the server took the write; otherwise the later version it holds instead. */
async function put(config: Config, body: Omit<PutFileRequest, "machine">): Promise<ServerVersion | undefined> {
  const request: PutFileRequest = { ...body, machine: config.machine };
  const response = await fetch(`${config.endpoint}/files`, {
    method: "PUT",
    headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (response.status === 409) {
    const current = await response.json() as { currentHash: string | null; currentEditedAt: number };
    return { hash: current.currentHash, editedAt: current.currentEditedAt };
  }
  if (!response.ok) throw new Error(`PUT /files ${body.path}: ${response.status} ${await response.text()}`);
  return undefined;
}

async function call(config: Config, path: string): Promise<Response> {
  const response = await fetch(`${config.endpoint}${path}`, {
    headers: { authorization: `Bearer ${config.token}` },
  });
  if (!response.ok) throw new Error(`GET ${path}: ${response.status} ${await response.text()}`);
  return response;
}
