/**
 * The install's two guards against another machine's edit of the same skill (skill-sync keeps the later edit of a file
 * and drops the other), and the intake read across every copy of the skill on a machine.
 */
import { afterAll, expect, test } from 'bun:test';
import { Effect, Result } from 'effect';
import fs from 'node:fs';
import path from 'node:path';
import { makeIntake } from '../feedback/intake';

import { applyEdits, shaOf, SkillFiles, SkillFilesLive, syncedEditOf, type SyncedSkills } from './skill-text';

const root = path.join(import.meta.dir, '../../../../.synctest', `skill-text-${Date.now().toString(36)}`);
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

const TEXT = '---\nname: jive\n---\n\n## Designing\n- a rule\n';

/** A skills folder holding one skill whose files were all last edited (or pulled) at `editedAt`. */
const skillsFolder = (name: string, editedAt: Date) => {
  const skills = path.join(root, name);
  const skill = path.join(skills, 'jive');
  fs.mkdirSync(path.join(skills, 'agentic-collaboration', 'evals', 'cases'), { recursive: true });
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), TEXT);
  fs.writeFileSync(path.join(skill, 'history.md'), '# History\n');
  for (const f of ['SKILL.md', 'history.md']) fs.utimesSync(path.join(skill, f), editedAt, editedAt);
  return skills;
};

/** The synced list holding the skill, last edited at `at` on `machine`. */
const listed = (at: Date, machine: string): SyncedSkills => async () => [{ name: 'jive', files: 15, editedAt: at.getTime(), editedBy: machine }];

const install = (skills: string, list: SyncedSkills) => Effect.runPromise(Effect.result(Effect.flatMap(SkillFiles, (files) => Effect.gen(function* () {
  return yield* files.install({ skill: 'jive', draftedOn: shaOf(TEXT), newText: `${TEXT}- a new rule\n`, history: '## A new rule', example: { name: 'x.md', text: 'x' }, evalCase: { file: 'case-01.json', json: '{}' } });
})).pipe(Effect.provide(SkillFilesLive({ root: skills, syncedSkills: list })))));

test('an install on a copy that has not pulled the latest synced edit of the skill is refused', async () => {
  const pulledAt = new Date(Date.now() - 120_000);
  const skills = skillsFolder('stale', pulledAt);
  const result = await install(skills, listed(new Date(pulledAt.getTime() + 60_000), 'fox'));
  expect(Result.isFailure(result) && result.failure.reason).toContain('has a synced edit from fox');
  expect(fs.readFileSync(path.join(skills, 'jive', 'SKILL.md'), 'utf8')).toBe(TEXT);
});

test('an install on a copy that holds the latest synced edit is written', async () => {
  const pulledAt = new Date(Date.now() - 120_000);
  const skills = skillsFolder('current', pulledAt);
  // A file under a dot-named folder is never synced, so its fresh time does not count as a pulled edit.
  fs.mkdirSync(path.join(skills, 'jive', '.local'), { recursive: true });
  fs.writeFileSync(path.join(skills, 'jive', '.local', 'x'), 'x');
  const result = await install(skills, listed(pulledAt, 'rose'));
  expect(Result.isSuccess(result)).toBe(true);
  expect(fs.readFileSync(path.join(skills, 'jive', 'SKILL.md'), 'utf8')).toContain('a new rule');
});

test('a synced edit from another machine that replaced the installed text fails the install check', async () => {
  const skills = skillsFolder('overwritten', new Date());
  const since = Date.now() - 1000;
  const check = (sha: string) => Effect.runPromise(Effect.result(Effect.flatMap(SkillFiles, (files) => Effect.gen(() => files.confirmSynced({ skill: 'jive', since, afterSha: sha }))).pipe(
    Effect.provide(SkillFilesLive({ root: skills, syncedSkills: listed(new Date(), 'fox') })),
  )));
  const replaced = await check(shaOf('the text the install wrote'));
  expect(Result.isFailure(replaced) && replaced.failure.reason).toContain('an edit from fox replaced it');
  expect(Result.isSuccess(await check(shaOf(TEXT)))).toBe(true);
});

test("the synced list gives a skill's last edit and its machine, and none for a skill with no files", () => {
  const at = new Date('2026-11-16T19:51:05-08:00');
  const skills = [{ name: 'effect', files: 10, editedAt: 1, editedBy: 'y' }, { name: 'jive', files: 15, editedAt: at.getTime(), editedBy: 'rose' }, { name: 'new', files: 0, editedAt: null, editedBy: null }];
  expect(syncedEditOf(skills, 'jive')).toMatchObject({ at: at.getTime(), machine: 'rose' });
  expect(syncedEditOf(skills, 'new')).toBeNull();
  expect(syncedEditOf([], 'jive')).toBeNull();
});

test('the intake lists the items of every copy of the skill and adds to its own', async () => {
  const own = path.join(root, 'intake-own');
  const other = path.join(root, 'intake-other');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, '2026-11-17T03-01-09-from-another-account.md'), 'his words');
  const intake = makeIntake({ intake: own, intakes: [own, other], installed: path.join(root, 'installed') });
  const added = await Effect.runPromise(intake.add({ arrived: new Date('2026-11-17T04:00:00Z'), slug: 'here', text: 'mine' }));
  expect(await Effect.runPromise(intake.open())).toEqual(['2026-11-17T03-01-09-from-another-account', added]);
  expect(await Effect.runPromise(intake.text('2026-11-17T03-01-09-from-another-account'))).toBe('his words');
  expect(fs.existsSync(path.join(own, `${added}.md`))).toBe(true);
});

test("a change that leaves a skill over its own stated line cap does not apply", () => {
  const capped = `---\nname: x\n---\n- **Cap: 5 lines.** Compact it.\n- a rule\n`;
  expect(Result.isSuccess(applyEdits(capped, [{ find: '- a rule', replace: '- a shorter rule' }]))).toBe(true);
  const over = applyEdits(capped, [{ find: '- a rule', replace: '- a rule\n- another rule' }]);
  expect(Result.isFailure(over) && over.failure).toBe('the skill would have 6 lines, over its own cap of 5');
});
