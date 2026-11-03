import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Option } from "effect";
import { addableSkills, formatSkillCopies, skillCopies } from "./local-skills";

// Fixtures go in the package's own gitignored .synctest folder, which the sync smoke test also uses.
const FIXTURES = new URL("../../.synctest/", import.meta.url).pathname;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Two detected folders. */
function machine(): { claude: string; agents: string; folders: string[] } {
  mkdirSync(FIXTURES, { recursive: true });
  const root = mkdtempSync(join(FIXTURES, "local-skills-"));
  roots.push(root);
  const claude = join(root, ".claude/skills");
  const agents = join(root, ".agents/skills");
  for (const folder of [claude, agents]) mkdirSync(folder, { recursive: true });
  return { claude, agents, folders: [agents, claude] };
}

function writeSkill(folder: string, skill: string, skillMd: string | undefined): void {
  mkdirSync(join(folder, skill), { recursive: true });
  if (skillMd !== undefined) writeFileSync(join(folder, skill, "SKILL.md"), skillMd);
}

const skillMd = (name: string, description = "Use when testing.") => `---\nname: ${name}\ndescription: ${description}\n---\n\nBody\n`;

test("skillCopies finds each folder's copy, in folder order, with its description", () => {
  const { claude, agents, folders } = machine();
  writeSkill(claude, "release-notes", skillMd("release-notes"));
  writeSkill(agents, "release-notes", undefined);
  expect(skillCopies({ skill: "release-notes", folders })).toEqual([
    { path: join(agents, "release-notes"), description: Option.none() },
    { path: join(claude, "release-notes"), description: Option.some("Use when testing.") },
  ]);
  expect(skillCopies({ skill: "missing", folders })).toEqual([]);
});

test("formatSkillCopies prints one description above every copy that has it, and differing copies apart", () => {
  const same = Option.some("Use when testing.");
  expect(formatSkillCopies([{ path: "/a/x", description: same }, { path: "/b/x", description: same }]))
    .toBe("Use when testing.\n  /a/x\n  /b/x");
  expect(formatSkillCopies([{ path: "/a/x", description: same }, { path: "/b/x", description: Option.none() }]))
    .toBe("Use when testing.\n  /a/x\n\n(its SKILL.md has no description)\n  /b/x");
});

test("addableSkills offers each skill add would accept that is not synced yet, once, sorted", () => {
  const { claude, agents, folders } = machine();
  writeSkill(claude, "zeta", skillMd("zeta"));
  writeSkill(agents, "zeta", skillMd("zeta"));
  writeSkill(agents, "alpha", skillMd("alpha"));
  writeSkill(claude, "already-synced", skillMd("already-synced"));
  writeSkill(claude, "excluded", skillMd("excluded"));
  writeSkill(claude, "no-skill-md", undefined);
  writeSkill(claude, "wrong-name", skillMd("other-name"));
  writeSkill(claude, "Not_A_Name", skillMd("Not_A_Name"));
  writeSkill(claude, ".hidden", skillMd(".hidden"));
  writeFileSync(join(claude, "loose-file"), "");
  expect(addableSkills({ folders, exclude: ["excluded"], synced: ["already-synced"] })).toEqual(["alpha", "zeta"]);
});

test("addableSkills reads a folder that does not exist yet as empty", () => {
  const { folders } = machine();
  expect(addableSkills({ folders: [...folders, join(folders[0]!, "missing")], exclude: [], synced: [] })).toEqual([]);
});
