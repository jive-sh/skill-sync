import { readFileSync } from "node:fs";
import { join } from "node:path";
import { detectFolders, hashBytes, listLocalFiles, type Config } from "./config";
import {
  skillOf, type FileHash, type FolderPrefs, type FoldersRequest, type FoldersResponse, type LocalSkill,
} from "./wire";

/**
 * What this machine tells the service about its folders, and what it hears back.
 *
 * The daemon and the CLI both register, so this lives in one place: they must describe a folder the same
 * way, or the dashboard would show whichever of them spoke last.
 */

/**
 * The skills on disk in one folder, with each file's hash. Hashing every file on each check is cheap at
 * skills' size, and it is what lets the dashboard show whether this folder's copy is the synced one.
 */
export function localSkills(folder: string, config: Config): LocalSkill[] {
  const byName = new Map<string, FileHash[]>();
  for (const path of listLocalFiles(folder, config.exclude)) {
    const name = skillOf(path);
    let hash: string;
    try {
      hash = hashBytes(readFileSync(join(folder, path)));
    } catch {
      continue; // Deleted between listing and reading; the next check reports the folder as it is.
    }
    byName.set(name, [...(byName.get(name) ?? []), { path, hash }]);
  }
  return [...byName].map(([name, files]) => ({ name, files }));
}

/** Everything registration sends, so a caller can tell when it has changed and is worth re-sending. */
export function describe(config: Config): FoldersRequest {
  return { folders: detectFolders().map((path) => ({ path, skills: localSkills(path, config) })) };
}

/** Registers this machine's folders and skills; returns the folders to sync and the skills in each. */
export async function register(config: Config, request: FoldersRequest): Promise<ReadonlyArray<FolderPrefs>> {
  const response = await fetch(`${config.endpoint}/folders`, {
    method: "POST",
    headers: authHeaders(config, { "content-type": "application/json" }),
    body: JSON.stringify(request),
  });
  if (!response.ok) throw new Error(`POST /folders: ${response.status} ${await response.text()}`);
  return (await response.json() as FoldersResponse).folders;
}

export function authHeaders(config: Config, extra: Record<string, string>): Record<string, string> {
  return { authorization: `Bearer ${config.token}`, "x-skill-sync-machine": config.machine, ...extra };
}
