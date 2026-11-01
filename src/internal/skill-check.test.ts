import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSkillToAdd, readFrontmatter } from "./skill-check";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Two detected folders and a project's own skills folder, which skill-sync never detects. */
function machine(): { claude: string; agents: string; project: string; folders: string[] } {
  const root = mkdtempSync(join(tmpdir(), "skill-sync-test-"));
  roots.push(root);
  const claude = join(root, ".claude/skills");
  const agents = join(root, ".agents/skills");
  const project = join(root, "repo/.claude/skills");
  for (const folder of [claude, agents, project]) mkdirSync(folder, { recursive: true });
  return { claude, agents, project, folders: [agents, claude] };
}

function writeSkill(folder: string, skill: string, skillMd: string | undefined): void {
  mkdirSync(join(folder, skill), { recursive: true });
  if (skillMd !== undefined) writeFileSync(join(folder, skill, "SKILL.md"), skillMd);
}

const valid = (name: string) => `---\nname: ${name}\ndescription: Use when testing.\n---\n\nBody\n`;

test("a skill with a matching name and a description in a detected folder is accepted, with every folder holding it", () => {
  const { claude, agents, folders } = machine();
  writeSkill(claude, "release-notes", valid("release-notes"));
  writeSkill(agents, "release-notes", valid("release-notes"));
  expect(checkSkillToAdd({ skill: "release-notes", folders, exclude: [] })).toEqual({ ok: true, folders: [agents, claude] });
});

test("a skill only in a project's own skills folder is refused as project-specific", () => {
  const { project, folders } = machine();
  writeSkill(project, "deploy-this-repo", valid("deploy-this-repo"));
  const check = checkSkillToAdd({ skill: "deploy-this-repo", folders, exclude: [] });
  expect(check.ok).toBe(false);
  expect(!check.ok && check.reason).toContain("specific to that project");
});

test("bad names, excluded names and broken SKILL.md files are refused with the reason", () => {
  const { claude, folders } = machine();
  const reason = (skill: string, exclude: string[] = []) => {
    const check = checkSkillToAdd({ skill, folders, exclude });
    return check.ok ? "accepted" : check.reason;
  };
  expect(reason("Release_Notes")).toContain("is not a skill name");
  expect(reason("../escape")).toContain("is not a skill name");
  writeSkill(claude, "synced", valid("synced"));
  expect(reason("synced", ["synced"])).toContain("excluded");
  writeSkill(claude, "no-file", undefined);
  expect(reason("no-file")).toContain("does not exist");
  writeSkill(claude, "no-frontmatter", "# Title\n");
  expect(reason("no-frontmatter")).toContain("frontmatter block");
  writeSkill(claude, "wrong-name", valid("other-name"));
  expect(reason("wrong-name")).toContain(`name is "other-name"`);
  writeSkill(claude, "no-description", "---\nname: no-description\n---\n");
  expect(reason("no-description")).toContain("no description");
});

test("frontmatter values may be quoted or folded onto indented lines", () => {
  const fields = readFrontmatter("---\nname: \"quoted\"\ndescription: >\n  Folded over\n  two lines.\nmetadata:\n  type: x\n---\nbody");
  expect(fields?.get("name")).toBe("quoted");
  expect(fields?.get("description")).toBe("Folded over two lines.");
  expect(readFrontmatter("no frontmatter")).toBeUndefined();
});
