import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isSkillName } from "./wire";

/**
 * Whether a skill on this machine may go on the synced list, checked before `skill-sync add` asks the
 * server to add it.
 *
 * The synced list is for skills meant for every project. A skill made for one project lives in that
 * project (its `.claude/skills`, `.agents/skills` or `.grok/skills`), which is never one of the folders
 * skill-sync detects, so a skill is accepted only from a detected folder. That is the one sign of a
 * project-specific skill that can be read from disk; a skill written into a home folder but about one
 * project is not caught here.
 */
export type SkillCheck =
  | { readonly ok: true; readonly folders: ReadonlyArray<string> }
  | { readonly ok: false; readonly reason: string };

export function checkSkillToAdd(input: {
  readonly skill: string;
  /** The skills folders skill-sync detects on this machine (`detectFolders`). */
  readonly folders: ReadonlyArray<string>;
  /** Top-level names skill-sync never syncs (`Settings.exclude`). */
  readonly exclude: ReadonlyArray<string>;
}): SkillCheck {
  const { skill, folders, exclude } = input;
  if (!isSkillName(skill)) {
    return { ok: false, reason: `"${skill}" is not a skill name: lowercase letters and digits in hyphen-joined words, at most 64 characters` };
  }
  if (exclude.includes(skill)) {
    return { ok: false, reason: `"${skill}" is excluded from syncing in ~/.jive/skill-sync.json` };
  }
  const holding = folders.filter((folder) => isDirectory(join(folder, skill)));
  if (holding.length === 0) {
    return {
      ok: false,
      reason: `no skills folder skill-sync syncs has a "${skill}" folder; it looked in ${folders.join(", ") || "no folders"}. `
        + "Only skills meant for every project sync: write the skill into one of those folders. A skill inside a "
        + "project's own skills folder is specific to that project and stays there.",
    };
  }
  for (const folder of holding) {
    const problem = frontmatterProblem(skill, join(folder, skill, "SKILL.md"));
    if (problem !== undefined) return { ok: false, reason: problem };
  }
  return { ok: true, folders: holding };
}

/** Why a skill's `SKILL.md` would not load as that skill, or undefined when it would. */
function frontmatterProblem(skill: string, path: string): string | undefined {
  if (!existsSync(path)) return `${path} does not exist; every skill needs a SKILL.md`;
  const fields = readFrontmatter(readFileSync(path, "utf8"));
  if (fields === undefined) return `${path} does not start with a frontmatter block between --- lines`;
  const name = fields.get("name");
  if (name === undefined || name === "") return `${path}'s frontmatter has no name`;
  if (name !== skill) return `${path}'s frontmatter name is "${name}", but its folder is "${skill}"; they must match`;
  if ((fields.get("description") ?? "") === "") return `${path}'s frontmatter has no description, which is how agents decide to load it`;
  return undefined;
}

/**
 * The top-level keys of a `SKILL.md`'s frontmatter, with their values as text. Covers what skills use: a
 * plain or quoted value on the key's line, or a block (`>` or `|`) on the indented lines after it.
 */
export function readFrontmatter(text: string): Map<string, string> | undefined {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return undefined;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end === -1) return undefined;
  const fields = new Map<string, string>();
  let blockKey: string | undefined;
  for (const line of lines.slice(1, end)) {
    const field = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (field !== null) {
      const key = field[1]!;
      const raw = field[2]!;
      blockKey = /^[>|][+-]?$/.test(raw.trim()) ? key : undefined;
      fields.set(key, blockKey === undefined ? unquote(raw.trim()) : "");
    } else if (blockKey !== undefined && /^\s+\S/.test(line)) {
      fields.set(blockKey, `${fields.get(blockKey)} ${line.trim()}`.trim());
    }
  }
  return fields;
}

function unquote(value: string): string {
  const quoted = /^(["'])(.*)\1$/.exec(value);
  return quoted === null ? value : quoted[2]!;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
