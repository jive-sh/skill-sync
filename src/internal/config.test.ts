import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectFolders, isLock, listLocalFiles } from "./config";

test("lock names are recognised by their .lock suffix only", () => {
  expect(isLock(".claude-alex.lock")).toBe(true);
  expect(isLock("x.lock")).toBe(true);
  expect(isLock(".claude-alex")).toBe(false);
  expect(isLock("lockfile.md")).toBe(false);
});

test("a skills folder's listing skips lock files and lock folders at any depth", () => {
  const folder = mkdtempSync(join(tmpdir(), "skill-sync-test-"));
  try {
    for (const path of ["jive/SKILL.md", "jive/notes.lock", "jive/held.lock/inner.md", "stale.lock/SKILL.md", "effect/SKILL.md"]) {
      mkdirSync(join(folder, path, ".."), { recursive: true });
      writeFileSync(join(folder, path), "x");
    }
    expect(listLocalFiles(folder, [])).toEqual(["effect/SKILL.md", "jive/SKILL.md"]);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("agent homes are Claude's and Grok's homes and Codex's ~/.agents, never locks, files or look-alikes", () => {
  const home = mkdtempSync(join(tmpdir(), "skill-sync-test-"));
  try {
    for (const dir of [".claude", ".claude-work", ".claude-work.lock", ".grok", ".grok-team", ".grokish", ".codex", ".codexish", ".config"]) {
      mkdirSync(join(home, dir));
    }
    writeFileSync(join(home, ".grok-file"), "x");
    expect(detectFolders(home)).toEqual([
      join(home, ".agents/skills"),
      join(home, ".claude-work/skills"),
      join(home, ".claude/skills"),
      join(home, ".grok-team/skills"),
      join(home, ".grok/skills"),
    ].sort());
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
