import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Option } from "effect";
import { isLock } from "./config";
import { checkSkillToAdd, readFrontmatter } from "./skill-check";

/** Skills as this machine's detected skills folders hold them, for the CLI's `show` and `add`. */

/** One folder's copy of a skill, with the description its `SKILL.md` frontmatter gives. */
export interface SkillCopy {
  readonly path: string;
  readonly description: Option.Option<string>;
}

/** Every copy of `skill` in `folders`, in the order of `folders`. */
export function skillCopies(input: { readonly skill: string; readonly folders: ReadonlyArray<string> }): ReadonlyArray<SkillCopy> {
  return input.folders
    .map((folder) => join(folder, input.skill))
    .filter((path) => existsSync(path))
    .map((path) => ({ path, description: readDescription(join(path, "SKILL.md")) }));
}

/**
 * What `skill-sync show` prints: each description above the paths of the copies that have it. Copies agree once
 * synced, so this is usually one description; copies that differ are shown apart rather than one hiding another.
 */
export function formatSkillCopies(copies: ReadonlyArray<SkillCopy>): string {
  const byDescription = Map.groupBy(copies, (copy) => Option.getOrElse(copy.description, () => "(its SKILL.md has no description)"));
  return [...byDescription]
    .map(([description, group]) => [description, ...group.map((copy) => `  ${copy.path}`)].join("\n"))
    .join("\n\n");
}

/**
 * The skills in `folders` that are not on the synced list and that `skill-sync add` would accept: the same check
 * the daemon runs before adding (`checkSkillToAdd`), so Tab offers nothing the daemon would refuse.
 */
export function addableSkills(input: {
  readonly folders: ReadonlyArray<string>;
  readonly exclude: ReadonlyArray<string>;
  readonly synced: ReadonlyArray<string>;
}): ReadonlyArray<string> {
  const { folders, exclude, synced } = input;
  const names = new Set(folders.flatMap((folder) => entries(folder).filter((entry) => !entry.startsWith(".") && !isLock(entry))));
  return [...names]
    .filter((skill) => !synced.includes(skill) && checkSkillToAdd({ skill, folders, exclude }).ok)
    .sort();
}

function readDescription(skillFile: string): Option.Option<string> {
  if (!existsSync(skillFile)) return Option.none();
  const description = readFrontmatter(readFileSync(skillFile, "utf8"))?.get("description");
  return description === undefined || description === "" ? Option.none() : Option.some(description);
}

function entries(folder: string): ReadonlyArray<string> {
  return existsSync(folder) ? readdirSync(folder) : [];
}
