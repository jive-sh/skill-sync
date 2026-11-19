/**
 * One feedback item through the whole workflow, on the real engine and platform storage in a scratch folder, with Jev and
 * the generative model faked: the fakes keep the real calls' shapes and spend, and decide by the text they are given.
 */
import { afterAll, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Effect, Layer } from 'effect';
import fs from 'node:fs';
import path from 'node:path';
import { Jev, type IJev } from '../jev/interface';
import { Writer, type IWriter } from '../writer/interface';
import { SkillFilesLive } from '../skills/skill-text';
import { installedFolder, intakeFolder, platformDatabase, type WorkflowFolders } from '../paths';
import { makeService } from '../service';
import { draftPrompt, failureReasons, placeBySkill, rank, reviseDraftPrompt, WORKFLOW } from './skill-refinement';
import { judgeOf } from '../evals/cases';

const root = path.join(import.meta.dir, '../../../../.synctest', `skill-refinement-${Date.now().toString(36)}`);
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

/** The Opus judge failed the reply he objected to and passed the one he labelled good. */
const OPUS_GRADES = [{ case: 'case-01', pass: false }, { case: 'case-02', pass: false }, { case: 'good-01', pass: true }];

/** The original action-judge prompt failed the action original he objected to. */
const OPUS_ACTION_GRADES = [{ case: 'case-01', pass: false }];

const RULE = '- Reply before any tool call.';
const BETTER = '- **Reply before any tool call.** BETTER-RULE';

const setUp = (name: string): WorkflowFolders => {
  const folders = { local: path.join(root, name, 'local'), skills: path.join(root, name, 'skills') };
  const skill = path.join(folders.skills, 'agentic-collaboration');
  fs.mkdirSync(path.join(skill, 'evals', 'cases'), { recursive: true });
  fs.mkdirSync(path.join(skill, 'examples'), { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), `---\nname: agentic-collaboration\n---\n\n## 2. Replies\n${RULE}\n\n## 1. Feedback\n### Changing skills\n- Test before installing.\n`);
  fs.writeFileSync(path.join(skill, 'history.md'), '# History\n');
  fs.mkdirSync(path.join(folders.skills, 'autonomous-skill-refinement'), { recursive: true });
  fs.writeFileSync(path.join(folders.skills, 'autonomous-skill-refinement', 'SKILL.md'), '---\nname: autonomous-skill-refinement\n---\n\n## 3. What a good change is\n1. Improve the skills.\n');
  const action = { state_before: ['a thread is running'], wanted: 'a reply first', went_wrong: 'a tool call first' };
  fs.writeFileSync(path.join(skill, 'evals', 'cases', 'case-01.json'), JSON.stringify({ id: 'case-01', kind: 'action', his_question: 'status?', original_reply: 'bad: ran a tool first', his_reaction: 'reply first', action }));
  // Two reply cases, which Jev judges and is calibrated on: one he objected to, one he labelled good.
  const intended = { facts: ['the build is green'], he_must_do: 'nothing', intended_meaning: 'the build is green' };
  fs.writeFileSync(path.join(skill, 'evals', 'cases', 'case-02.json'), JSON.stringify({ id: 'case-02', his_question: 'is the build green?', original_reply: 'bad: a wall of logs', his_reaction: 'just tell me', intended }));
  fs.writeFileSync(path.join(skill, 'evals', 'cases', 'good-01.json'), JSON.stringify({ id: 'good-01', kind: 'good', his_question: 'is the build green?', original_reply: 'GOOD: yes, green', his_reaction: 'good', intended }));
  fs.mkdirSync(path.join(folders.local, 'intake'), { recursive: true });
  fs.writeFileSync(path.join(folders.local, 'intake', '2026-11-17T00-00-00-reply-first.md'), 'His words: "reply first". What drew it: I ran a tool before replying.');
  return folders;
};

/** The judge's criteria where yes passes, and where no passes (`evals/cases.ts`). */
const POSITIVE = new Set(['meaning_match', 'answer_first', 'does_what_he_wanted']);
const NEGATIVE = new Set(['needs_history', 'undefined_labels', 'misleading_ambiguity', 'too_long', 'follow_up_needed', 'adds_unasked', 'keeps_what_he_rejected', 'unstated_guess']);
const jevCalls: string[] = [];
const fakeJev: IJev = {
  *ask(input) {
    const questions = input.questions as Record<string, { type: string }>;
    const state = JSON.stringify(input.state);
    const good = state.includes('GOOD') || state.includes('REPLY: Done:');
    jevCalls.push(Object.keys(questions).join(','));
    const answers: Record<string, unknown> = {};
    for (const [key, q] of Object.entries(questions)) {
      if (key === 'section') answers[key] = { choice: 'agentic-collaboration § 2. Replies', confidence: 0.9, probabilities: { 'agentic-collaboration § 2. Replies': 0.9, 'agentic-collaboration § 1. Feedback › Changing skills': 0.1 } };
      else if (key === 'kind') answers[key] = { choice: 'repeat', confidence: 0.8, probabilities: {} };
      // A good reply, or the calibration's control (a plan exactly as he wanted), reads well; anything else scores below every cut.
      else if (POSITIVE.has(key)) answers[key] = good ? 0.9 : 0.02;
      else if (NEGATIVE.has(key)) answers[key] = good ? 0.1 : 0.9;
      else if (q.type === 'noul') answers[key] = 0.9;
    }
    return { answers: answers as never, model: 'jev-1.14.0', inputTokens: 100, outputTokens: 0 };
  },
};

const spend = { model: 'claude-opus-5-5', inputTokens: 3, cacheReadTokens: 10, cacheWriteTokens: 20, outputTokens: 5, costUsd: 0.01 };
/** The fake writer's calls, by what each was for. */
const writerCalls: string[] = [];
const fakeWriter: IWriter = {
  *write(input) {
    // The Opus judge of an action case: it passes a plan that is GOOD.
    if (input.prompt.startsWith('Grade what an agent decided')) {
      writerCalls.push('judge');
      const good = input.prompt.includes('GOOD');
      return { spend, text: JSON.stringify({ does_what_he_wanted: good, adds_unasked: false, keeps_what_he_rejected: !good, unstated_guess: false, why: 'fake' }) };
    }
    writerCalls.push(input.prompt.includes('Return only JSON: {"candidates"') ? 'draft' : 'reply');
    if (input.prompt.includes('Return only JSON: {"candidates"')) {
      return { spend, text: JSON.stringify({
        candidates: [
          { summary: 'makes the rule prominent', edits: [{ find: RULE, replace: BETTER }] },
          { summary: 'edits text that is not there', edits: [{ find: 'no such line', replace: 'x' }] },
        ],
        history: '## Reply before any tool call\n2026-11-17: "reply first".',
        example: { name: 'tool-call-before-reply.md', text: '# Tool call before the reply\n' },
        eval_case: { his_question: 'status?', original_reply: 'ran a tool', his_reaction: 'reply first', state_before: ['a thread runs'], wanted: 'a reply first', went_wrong: 'a tool call first' },
      }) };
    }
    return { spend, text: input.system.includes('BETTER-RULE') ? 'GOOD reply first' : 'bad: a tool call first' };
  },
};

test('one item is classified, drafted, A/B tested, judged and installed, every step recorded with its spend', async () => {
  const folders = setUp('installs');
  const service = makeService(
    { folders, typesafeApiKey: () => 'test', jevModel: 'jev-latest', claudeConfigDir: 'unused', writerModel: 'claude-opus-5-5', opusJudgeGrades: OPUS_GRADES, opusActionJudgeGrades: OPUS_ACTION_GRADES, intakes: [intakeFolder(folders)] },
    Layer.mergeAll(
      Layer.succeed(Jev, fakeJev),
      Layer.succeed(Writer, fakeWriter),
      // The server holds what this copy last wrote: the skill's own latest edit, as after a push.
      SkillFilesLive({ root: folders.skills, syncedSkills: async () => [{ name: 'agentic-collaboration', files: 9, editedAt: fs.statSync(path.join(folders.skills, 'agentic-collaboration', 'SKILL.md')).mtimeMs, editedBy: 'testbox' }] }),
    ),
  );
  await service.runtime.runPromise(Effect.void);
  await service.turn();
  const record = path.join(installedFolder(folders), '2026-11-17T00-00-00-reply-first.json');
  for (let waited = 0; !fs.existsSync(record) && waited < 60_000; waited += 250) await Bun.sleep(250);
  expect(fs.existsSync(record)).toBe(true);
  // A moment for the run's end to be recorded after its last step.
  await Bun.sleep(1500);

  const skill = fs.readFileSync(path.join(folders.skills, 'agentic-collaboration', 'SKILL.md'), 'utf8');
  expect(skill).toContain(BETTER);
  expect(fs.existsSync(path.join(folders.skills, 'agentic-collaboration', 'evals', 'cases', 'case-02.json'))).toBe(true);
  expect(fs.existsSync(path.join(folders.skills, 'agentic-collaboration', 'examples', 'tool-call-before-reply.md'))).toBe(true);
  expect(fs.readFileSync(path.join(folders.skills, 'agentic-collaboration', 'history.md'), 'utf8')).toContain('"reply first"');

  const db = new Database(platformDatabase(folders), { readonly: true });
  // The first run's steps: the run that starts after it waits at Pick, with nothing left to pick.
  const steps = db.query('SELECT step, outcome, requests, fresh, cache_read, model FROM step_runs WHERE run = (SELECT run FROM step_runs ORDER BY id LIMIT 1) ORDER BY id').all() as Array<{ step: string; outcome: string; requests: number; fresh: number; cache_read: number; model: string | null }>;
  db.close();
  expect(steps.map((s) => s.step)).toEqual(['Pick', 'Calibrate judge', 'Classify', 'Draft', 'Choose examples', 'A/B', 'Judge', 'Install']);
  expect(steps.every((s) => s.outcome === 'success')).toBe(true);
  expect(steps.find((s) => s.step === 'Draft')).toMatchObject({ requests: 1, fresh: 3, cache_read: 10 });
  // Three chosen cases and the item's own, under the current text and the one candidate that applies, two samples each.
  expect(steps.find((s) => s.step === 'A/B')?.requests).toBe(4 * 2 * 2);
  // The Judge step routes by case kind: case-01 and the item's own (action) to the Opus judge, case-02 and good-01 (reply) to Jev.
  expect(steps.find((s) => s.step === 'Judge')?.requests).toBe(16);
  // Two action cases, two versions, two samples; and calibration's one grade of case-01's original.
  expect(writerCalls.filter((c) => c === 'judge').length).toBe(2 * 2 * 2 + 1);
  const judged = JSON.parse(fs.readFileSync(fs.readdirSync(path.join(folders.local, 'runs')).map((r) => path.join(folders.local, 'runs', r, 'judged.json')).find((p) => fs.existsSync(p))!, 'utf8')) as { judged: Array<{ caseId: string; judge: string }> };
  expect(Object.fromEntries(judged.judged.map((j) => [j.caseId.startsWith('this item') ? 'own' : j.caseId, j.judge]))).toEqual({ 'case-01': 'opus', own: 'opus', 'case-02': 'jev', 'good-01': 'jev' });
  // Not awaited: the next run waits at Pick, and the engine gives a waiting run minutes to finish before it closes.
  void service.runtime.dispose();
}, 90_000);

test('a judge that agrees with him less often than the Opus judge ends the run before any model call', async () => {
  const folders = setUp('uncalibrated');
  let writes = 0;
  // A judge that passes every reply: it passes case-02, a reply he objected to, so it agrees on 1 of 2 reply cases against the Opus judge's 2 of 2.
  const lenientJev: IJev = {
    *ask(input) {
      const answers: Record<string, unknown> = {};
      for (const key of Object.keys(input.questions as Record<string, unknown>)) answers[key] = POSITIVE.has(key) ? 0.9 : 0.1;
      return { answers: answers as never, model: 'jev-1.14.0', inputTokens: 100, outputTokens: 0 };
    },
  };
  const service = makeService(
    { folders, typesafeApiKey: () => 'test', jevModel: 'jev-latest', claudeConfigDir: 'unused', writerModel: 'claude-opus-5-5', opusJudgeGrades: OPUS_GRADES, opusActionJudgeGrades: OPUS_ACTION_GRADES, intakes: [intakeFolder(folders)] },
    // Calibration's Opus grades of the action originals are the only writer calls expected; it fails them, as he did.
    Layer.mergeAll(Layer.succeed(Jev, lenientJev), Layer.succeed(Writer, { *write(input) { if (input.prompt.startsWith('Grade what an agent decided')) return { spend, text: JSON.stringify({ does_what_he_wanted: false, adds_unasked: false, keeps_what_he_rejected: true, unstated_guess: false, why: 'fake' }) }; writes++; return yield* Effect.die('no writer call is expected'); } }), SkillFilesLive({ root: folders.skills, syncedSkills: async () => [] })),
  );
  await service.runtime.runPromise(Effect.void);
  await service.turn();
  const db = () => new Database(platformDatabase(folders), { readonly: true });
  const notes = () => { const d = db(); try { return d.query("SELECT why FROM task_notes WHERE kind = 'outcome'").all() as Array<{ why: string }>; } catch { return []; } finally { d.close(); } };
  for (let waited = 0; notes().length === 0 && waited < 30_000; waited += 250) await Bun.sleep(250);
  expect(notes()[0]?.why).toContain('the judge is not calibrated: Jev agrees with Alex on 1 of 2 original replies');
  const d = db();
  const steps = (d.query('SELECT step FROM step_runs WHERE run = (SELECT run FROM step_runs ORDER BY id LIMIT 1) ORDER BY id').all() as Array<{ step: string }>).map((r) => r.step);
  d.close();
  expect(steps).toEqual(['Pick', 'Calibrate judge']);
  expect(writes).toBe(0);
  void service.runtime.dispose();
}, 60_000);

test('the judge goes by case kind: an action case to the Opus judge, any other to Jev', () => {
  const base = { his_question: 'q', original_reply: 'r', his_reaction: 'x' };
  expect(judgeOf({ id: 'a', kind: 'action', ...base })).toBe('opus');
  expect(judgeOf({ id: 'b', ...base })).toBe('jev');
  expect(judgeOf({ id: 'c', kind: 'good', ...base })).toBe('jev');
});

test('a candidate that fails a case the current text passes never wins', () => {
  const judged = [
    { caseId: 'case-01', version: 0, score: 0.9, pass: true }, { caseId: 'case-01', version: 0, score: 0.9, pass: true },
    { caseId: 'case-01', version: 1, score: 0.1, pass: false }, { caseId: 'case-01', version: 1, score: 0.1, pass: false },
    { caseId: 'this item (x)', version: 0, score: 0.1, pass: false }, { caseId: 'this item (x)', version: 0, score: 0.1, pass: false },
    { caseId: 'this item (x)', version: 1, score: 0.9, pass: true }, { caseId: 'this item (x)', version: 1, score: 0.9, pass: true },
  ];
  expect(rank(judged).winner).toBeNull();
  expect(rank(judged).versions[1]).toMatchObject({ losesTo: ['case-01'] });
});

test("a candidate that does not pass the item's own case never wins", () => {
  const judged = [
    { caseId: 'this item (x)', version: 0, score: 0.1, pass: false }, { caseId: 'this item (x)', version: 0, score: 0.1, pass: false },
    { caseId: 'this item (x)', version: 1, score: 0.9, pass: true }, { caseId: 'this item (x)', version: 1, score: 0.2, pass: false },
  ];
  expect(rank(judged).winner).toBeNull();
});

test('a run with no winner notes why each failing reply failed, for the next Draft of the item', () => {
  const verdict = { does_what_he_wanted: true, adds_unasked: true, keeps_what_he_rejected: false, unstated_guess: false, why: 'it also deletes the old key copy' };
  const reasons = failureReasons([
    { caseId: 'this item (x)', version: 1, sample: 0, pass: false, judge: 'opus', verdict },
    { caseId: 'this item (x)', version: 1, sample: 1, pass: true, judge: 'opus', verdict: { ...verdict, adds_unasked: false } },
    { caseId: 'case-02', version: 0, sample: 1, pass: false, judge: 'jev', answers: { meaning_match: 0.9, answer_first: 0.2, too_long: 0.8 } },
  ]);
  expect(reasons).toEqual(['this item (x) candidate 1 sample 0: it also deletes the old key copy', 'case-02 current sample 1: failed answer_first, too_long']);
});

test("an item goes to the skill its sections hold the most probability in, not to the single likeliest section", () => {
  const sections = [
    { skill: 'effect', label: 'effect § 1. Which conventions win', text: '' },
    { skill: 'senior-swe', label: 'senior-swe § 13. Proactive product sense', text: '' },
    { skill: 'senior-swe', label: 'senior-swe § 2. Decide and act', text: '' },
  ];
  const placed = placeBySkill({ sections, probabilities: { 'effect § 1. Which conventions win': 0.4, 'senior-swe § 13. Proactive product sense': 0.25, 'senior-swe § 2. Decide and act': 0.35 } });
  expect(placed).toMatchObject({ skill: 'senior-swe', section: 'senior-swe § 2. Decide and act', sectionProbability: 0.35 });
  expect(placed.skillProbability).toBeCloseTo(0.6);
});

test('an action judge that passes an original he objected to, where the original prompt failed it, ends the run before any item call', async () => {
  const folders = setUp('lenient-action-judge');
  let writes = 0;
  const lenientOpus: IWriter = {
    *write(input) {
      if (input.prompt.startsWith('Grade what an agent decided')) return { spend, text: JSON.stringify({ does_what_he_wanted: true, adds_unasked: false, keeps_what_he_rejected: false, unstated_guess: false, why: 'fake' }) };
      writes++;
      return yield* Effect.die('no writer call is expected');
    },
  };
  const service = makeService(
    { folders, typesafeApiKey: () => 'test', jevModel: 'jev-latest', claudeConfigDir: 'unused', writerModel: 'claude-opus-5-5', opusJudgeGrades: OPUS_GRADES, opusActionJudgeGrades: OPUS_ACTION_GRADES, intakes: [intakeFolder(folders)] },
    Layer.mergeAll(Layer.succeed(Jev, fakeJev), Layer.succeed(Writer, lenientOpus), SkillFilesLive({ root: folders.skills, syncedSkills: async () => [] })),
  );
  await service.runtime.runPromise(Effect.void);
  await service.turn();
  const db = () => new Database(platformDatabase(folders), { readonly: true });
  const notes = () => { const d = db(); try { return d.query("SELECT why FROM task_notes WHERE kind = 'outcome'").all() as Array<{ why: string }>; } catch { return []; } finally { d.close(); } };
  for (let waited = 0; notes().length === 0 && waited < 30_000; waited += 250) await Bun.sleep(250);
  expect(notes()[0]?.why).toContain('the action judge fails 0 of 1 action originals he objected to (original prompt: 1 of 1)');
  expect(writes).toBe(0);
  void service.runtime.dispose();
}, 60_000);

const WEAK = '- Reply before any tool call. WEAK-RULE';
/** Draft's prompts this writer saw, by round: the first draft, then the revise round's. */
const roundPrompts: string[] = [];

/**
 * A writer whose first draft does not win, and whose revise round wins when `reviseWins`: replies pass only under the
 * better rule, as the judges in `fakeWriter` and `fakeJev` decide them. With `skillPulledDuringRoundOne`, the first
 * grade of an A/B reply also edits that skill file, as a pull of another machine's edit would between the rounds.
 */
const roundsWriter = (setting: RoundsSetting): IWriter => {
  let pulled = false;
  return { *write(input) {
    if (input.prompt.startsWith('Grade what an agent decided')) {
      if (setting.skillPulledDuringRoundOne !== null && !pulled && input.prompt.includes('bad: a tool call first')) {
        pulled = true;
        fs.appendFileSync(setting.skillPulledDuringRoundOne, '- A rule pulled from another machine.\n');
      }
      const good = input.prompt.includes('GOOD');
      return { spend, text: JSON.stringify({ does_what_he_wanted: good, adds_unasked: !good, keeps_what_he_rejected: false, unstated_guess: false, why: good ? 'fake pass' : 'it quotes his message back, which he did not want' }) };
    }
    if (input.prompt.includes('Why none of them won')) {
      roundPrompts.push(input.prompt);
      return { spend, text: JSON.stringify({ candidates: [{ summary: 'removes the shared cause', edits: [{ find: RULE, replace: setting.reviseWins ? BETTER : `${RULE} STILL-WEAK` }] }] }) };
    }
    if (input.prompt.includes('Return only JSON: {"candidates"')) {
      roundPrompts.push(input.prompt);
      return { spend, text: JSON.stringify({
        candidates: [{ summary: 'rewords the rule', edits: [{ find: RULE, replace: WEAK }] }],
        history: '## Reply before any tool call\n2026-11-19: "reply first".',
        example: { name: 'tool-call-before-reply.md', text: '# Tool call before the reply\n' },
        eval_case: { his_question: 'status?', original_reply: 'ran a tool', his_reaction: 'reply first', state_before: ['a thread runs'], wanted: 'ROUND-ONE-CASE a reply first', went_wrong: 'a tool call first' },
      }) };
    }
    return { spend, text: input.system.includes('BETTER-RULE') ? 'GOOD reply first' : 'bad: a tool call first' };
  } };
};

interface RoundsSetting { readonly reviseWins: boolean; readonly skillPulledDuringRoundOne: string | null }

const outcomesOf = (folders: WorkflowFolders): ReadonlyArray<string> => {
  if (!fs.existsSync(platformDatabase(folders))) return [];
  const d = new Database(platformDatabase(folders), { readonly: true });
  try { return (d.query("SELECT why FROM task_notes WHERE kind = 'outcome' ORDER BY id").all() as Array<{ why: string }>).map((r) => r.why); } catch { return []; } finally { d.close(); }
};

const roundsService = (input: { readonly folders: WorkflowFolders } & RoundsSetting) => makeService(
  { folders: input.folders, typesafeApiKey: () => 'test', jevModel: 'jev-latest', claudeConfigDir: 'unused', writerModel: 'claude-opus-5-5', opusJudgeGrades: OPUS_GRADES, opusActionJudgeGrades: OPUS_ACTION_GRADES, intakes: [intakeFolder(input.folders)] },
  Layer.mergeAll(
    Layer.succeed(Jev, fakeJev),
    Layer.succeed(Writer, roundsWriter(input)),
    SkillFilesLive({ root: input.folders.skills, syncedSkills: async () => [{ name: 'agentic-collaboration', files: 9, editedAt: fs.statSync(path.join(input.folders.skills, 'agentic-collaboration', 'SKILL.md')).mtimeMs, editedBy: 'testbox' }] }),
  ),
);

test('with no winner, Draft writes again from why each reply failed, on the same case, and only the new candidates are written and judged', async () => {
  roundPrompts.length = 0;
  const folders = setUp('second-round');
  const service = roundsService({ folders, reviseWins: true, skillPulledDuringRoundOne: null });
  await service.runtime.runPromise(Effect.void);
  await service.turn();
  const record = path.join(installedFolder(folders), '2026-11-17T00-00-00-reply-first.json');
  for (let waited = 0; !fs.existsSync(record) && waited < 60_000; waited += 250) await Bun.sleep(250);
  expect(fs.existsSync(record)).toBe(true);
  await Bun.sleep(1500);

  expect(fs.readFileSync(path.join(folders.skills, 'agentic-collaboration', 'SKILL.md'), 'utf8')).toContain(BETTER);
  // The revise round read the first round's candidate, the judge's reason and the first round's case.
  expect(roundPrompts).toHaveLength(2);
  expect(roundPrompts[1]).toContain('rewords the rule');
  expect(roundPrompts[1]).toContain('it quotes his message back, which he did not want');
  expect(roundPrompts[1]).toContain('ROUND-ONE-CASE');
  // The installed case is the one both rounds were measured on.
  expect(fs.readFileSync(path.join(folders.skills, 'agentic-collaboration', 'evals', 'cases', 'case-03.json'), 'utf8')).toContain('ROUND-ONE-CASE');
  expect(outcomesOf(folders)[0]).toBe('installed in agentic-collaboration (23 to 24 words), from draft 2');

  const db = new Database(platformDatabase(folders), { readonly: true });
  const steps = db.query('SELECT step, outcome, requests FROM step_runs WHERE run = (SELECT run FROM step_runs ORDER BY id LIMIT 1) ORDER BY id').all() as Array<{ step: string; outcome: string; requests: number }>;
  db.close();
  expect(steps.map((s) => s.step)).toEqual(['Pick', 'Calibrate judge', 'Classify', 'Draft', 'Choose examples', 'A/B', 'Judge', 'Draft', 'A/B', 'Judge', 'Install']);
  expect(steps.every((s) => s.outcome === 'success')).toBe(true);
  // Four cases, two samples: the current text and the first candidate in round 1, the new candidate alone in round 2.
  expect(steps.filter((s) => s.step === 'A/B').map((s) => s.requests)).toEqual([4 * 2 * 2, 4 * 1 * 2]);
  expect(steps.filter((s) => s.step === 'Judge').map((s) => s.requests)).toEqual([16, 8]);
  void service.runtime.dispose();
}, 90_000);

test("when the skill's text changes between rounds, the next round writes and judges the current text's replies again", async () => {
  roundPrompts.length = 0;
  const folders = setUp('pulled-between-rounds');
  const skillFile = path.join(folders.skills, 'agentic-collaboration', 'SKILL.md');
  const service = roundsService({ folders, reviseWins: true, skillPulledDuringRoundOne: skillFile });
  await service.runtime.runPromise(Effect.void);
  await service.turn();
  const record = path.join(installedFolder(folders), '2026-11-17T00-00-00-reply-first.json');
  for (let waited = 0; !fs.existsSync(record) && waited < 60_000; waited += 250) await Bun.sleep(250);
  expect(fs.existsSync(record)).toBe(true);
  await Bun.sleep(1500);
  expect(fs.readFileSync(skillFile, 'utf8')).toContain('- A rule pulled from another machine.');
  const db = new Database(platformDatabase(folders), { readonly: true });
  const steps = db.query("SELECT step, requests FROM step_runs WHERE run = (SELECT run FROM step_runs ORDER BY id LIMIT 1) AND step IN ('A/B', 'Judge') ORDER BY id").all() as Array<{ step: string; requests: number }>;
  db.close();
  // Round 2 writes the current text and its candidate both: the first round's current-text replies were to the older text.
  expect(steps.map((s) => `${s.step} ${s.requests}`)).toEqual(['A/B 16', 'Judge 16', 'A/B 16', 'Judge 16']);
  void service.runtime.dispose();
}, 90_000);

test('an item that ends without an install waits while its inputs stand, and runs again once a skill it drafts on changes', async () => {
  roundPrompts.length = 0;
  const folders = setUp('reruns-on-skill-change');
  const service = roundsService({ folders, reviseWins: false, skillPulledDuringRoundOne: null });
  await service.runtime.runPromise(Effect.void);
  await service.turn();
  for (let waited = 0; outcomesOf(folders).length === 0 && waited < 60_000; waited += 250) await Bun.sleep(250);
  expect(outcomesOf(folders)[0]).toMatch(/^after 2 drafts, no candidate wins: no candidate passes the item's own case .*it quotes his message back/);

  // Nothing it reads has changed: the next run waits at Pick, and a wake finds nothing to take.
  service.platform.wakes.wakePicksOf(WORKFLOW, 'test');
  await Bun.sleep(3000);
  expect(outcomesOf(folders)).toHaveLength(1);

  // An edit to the skill, as an install or a pull from another machine makes it, and the wake its watcher raises.
  const skillFile = path.join(folders.skills, 'agentic-collaboration', 'SKILL.md');
  fs.appendFileSync(skillFile, '- Another rule.\n');
  service.platform.wakes.wakePicksOf(WORKFLOW, 'skill agentic-collaboration changed');
  for (let waited = 0; outcomesOf(folders).length < 2 && waited < 60_000; waited += 250) await Bun.sleep(250);
  expect(outcomesOf(folders)).toHaveLength(2);
  void service.runtime.dispose();
}, 150_000);

test("Draft is told the skill's line budget when the skill states a cap, and nothing about one otherwise", () => {
  const input = { itemText: 'item', section: 's', sectionConfidence: 0.5, kind: 'new', notes: '', examples: [], skill: 'jive' };
  const capped = `${Array.from({ length: 199 }, (_, i) => `line ${i}`).join('\n')}\n- **Cap: 200 lines.** Compact by re-checking each rule.\n`;
  expect(draftPrompt({ ...input, skillText: capped })).toContain('The skill has 200 lines and states its own cap of 200, so it has no room for a line more.');
  expect(draftPrompt({ ...input, skillText: '## A\n- rule\n' })).not.toContain('cap of');
  const revised = reviseDraftPrompt({ ...input, skillText: capped, evalCase: { his_question: 'q', original_reply: 'r', his_reaction: 'x', state_before: [], wanted: 'w', went_wrong: 'g' }, tried: [{ summary: 'one', why: 'the skill would have 203 lines, over its own cap of 200' }], whyNoneWon: 'none applied' });
  expect(revised).toContain('over its own cap of 200');
  expect(revised).toContain('cap of 200, so it has no room');
});
