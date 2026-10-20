/**
 * Drives two simulated machines through the whole lifecycle against a local Worker.
 *
 * Run `bunx wrangler dev --port 8799 --local` first, and apply `worker/schema.sql` to the local D1 once.
 * Every bug this caught was in the interaction between the two passes, not in either alone — a unit test
 * of `pull` or `push` would have found none of them.
 */
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { syncOnce } from "../src/internal/sync";
import type { Config, State } from "../src/internal/config";

const root = new URL("../.synctest/", import.meta.url).pathname;
for (const m of ["a", "b"]) { rmSync(join(root, m), { recursive: true, force: true }); mkdirSync(join(root, m, "demo"), { recursive: true }); }

const cfg = (machine: string): Config => ({
  endpoint: "http://127.0.0.1:8799", token: "test-token",
  skillsDir: join(root, machine), machine,
});
const A = cfg("a"), B = cfg("b");
const sA: State = { cursor: 0, known: {} }, sB: State = { cursor: 0, known: {} };
const show = (label: string, r: Awaited<ReturnType<typeof syncOnce>>) =>
  console.log(`${label}: pulled=[${r.pulled}] pushed=[${r.pushed}] deleted=[${r.deletedLocally}] conflicts=[${r.conflicts}]`);
const read = (m: string, p: string) => existsSync(join(root, m, p)) ? readFileSync(join(root, m, p), "utf-8").trim() : "(absent)";

writeFileSync(join(root, "a/demo/SKILL.md"), "version one\n");
show("A push    ", await syncOnce(A, sA));
show("B pull    ", await syncOnce(B, sB));
console.log(`  B has: ${read("b", "demo/SKILL.md")}`);

writeFileSync(join(root, "b/demo/SKILL.md"), "version two\n");
show("B edit    ", await syncOnce(B, sB));
show("A pull    ", await syncOnce(A, sA));
console.log(`  A has: ${read("a", "demo/SKILL.md")}`);

writeFileSync(join(root, "a/demo/SKILL.md"), "A's edit\n");
writeFileSync(join(root, "b/demo/SKILL.md"), "B's edit\n");
show("A pushes  ", await syncOnce(A, sA));
show("B conflict", await syncOnce(B, sB));
console.log(`  B main:  ${read("b", "demo/SKILL.md")}`);
console.log(`  B saved: ${read("b", "demo/SKILL.md.local")}`);

rmSync(join(root, "a/demo/SKILL.md"));
show("A delete  ", await syncOnce(A, sA));
show("B pull    ", await syncOnce(B, sB));
console.log(`  B has: ${read("b", "demo/SKILL.md")}`);
