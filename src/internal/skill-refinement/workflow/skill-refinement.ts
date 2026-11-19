/**
 * SKILL REFINEMENT: ONE RUN PER FEEDBACK ITEM, EACH STEP A FRESH, SMALL CALL.
 *
 *   Pick              takes the head of the intake's queue.
 *   Calibrate judge   Jev, the judge of reply cases, grades the original replies Alex objected to (and the one he called
 *                     good) once per judge version; agreeing with him less often than the Opus judge did ends the run here.
 *   Classify          Jev names the skill section the item is about, and whether it is new, a repeat or a correction.
 *   Draft             the generative model reads only that skill, its example names, its rules for changing skills and
 *                     the item, and writes candidate edits, the item's example and its A/B case.
 *   Choose examples   Jev names the section that owns each A/B case's failure; the changed section's cases, and the
 *                     item's own, are tested.
 *   A/B               for each chosen case, the generative model writes the reply under the current text and under
 *                     each candidate, two samples each.
 *   Judge             each reply goes to its case kind's judge: an action case to the Opus judge, a reply case to Jev;
 *                     candidates are ranked by their passes.
 *   Install           the best candidate that fails no case the current text passes is written to the synced skill,
 *                     then skill-sync's synced list must show the skill edited after the install.
 *
 * The content rules (what a good change is) live in the `autonomous-skill-refinement` skill around this code; Draft
 * reads them from it each run. Jev classifies and judges; only Draft and A/B, which must write text, call a generative model.
 */
import { AgentStep, RUN_ENDS, RUN_STARTS, A_STEP_FAILS, type WorkflowPlatform } from '@jive-sh/workflow-platform';
import { Effect, Option, pipe, Result, Schema } from 'effect';
import fs from 'node:fs';
import path from 'node:path';
import { Jev } from '../jev/interface';
import { Writer, type WriterSpend } from '../writer/interface';
import { applyEdits, shaOf, SkillFiles, type SkillSection } from '../skills/skill-text';
import { actionJudgePrompt, actionPasses, ActionVerdict, caseSummary, EvalCase, judgeOf, judgeQuestions, judgeState, judgeVersion, nextCaseFile, readCases, REPLY_CRITERIA, verdictOf, writerPrompt, writerSystem } from '../evals/cases';
import type { Intake } from '../feedback/intake';
import { evalCasesFolder, runFolder, type WorkflowFolders } from '../paths';

export const WORKFLOW = 'Skill refinement';
/** The skill that owns this process: Draft reads its rules for a good change on each run. */
export const OWNING_SKILL = 'autonomous-skill-refinement';
/** Replies written per case and version: one varies too much to decide on (`evals/README.md`). */
export const SAMPLES = 2;
/** Candidate edits drafted per item. */
export const CANDIDATES = 2;
/** Writer calls at once. */
const WRITERS_AT_ONCE = 4;

export interface SkillRefinementDeps {
  readonly platform: WorkflowPlatform<'skills', never>;
  readonly intake: Intake;
  readonly folders: WorkflowFolders;
  /** The Opus judge's grades of the original replies (`evals/opus-judge-original.json`), the bar a new judge must meet. */
  readonly opusJudgeGrades: ReadonlyArray<{ readonly case: string; readonly pass: boolean }>;
  /** The evals' original action-judge prompt's grades of the action originals (`evals/opus-action-judge-original.json`). */
  readonly opusActionJudgeGrades: ReadonlyArray<{ readonly case: string; readonly pass: boolean }>;
  /** What decides a task's inputs beyond its own text: the judge's and writer's versions, and whether Jev is reachable. */
  readonly configFingerprint: () => string;
}

const Classified = Schema.Struct({ skill: Schema.String, section: Schema.String, sectionConfidence: Schema.Finite, kind: Schema.String, kindConfidence: Schema.Finite, jevModel: Schema.String });
const Drafted = Schema.Struct({
  skill: Schema.String, draftedOn: Schema.String, file: Schema.String,
  candidates: Schema.Array(Schema.Struct({ summary: Schema.String, applies: Schema.Boolean, why: Schema.String })),
  costUsd: Schema.Finite,
});
const Chosen = Schema.Struct({ cases: Schema.Array(Schema.String), considered: Schema.Finite });
const Calibration = Schema.Struct({
  fingerprint: Schema.String, agreed: Schema.Finite, graded: Schema.Finite, opusAgreed: Schema.Finite, opusGraded: Schema.Finite,
  actionAgreed: Schema.Finite, actionGraded: Schema.Finite, actionBaselineAgreed: Schema.Finite, actionBaselineGraded: Schema.Finite,
  usable: Schema.Boolean, file: Schema.String,
});
const Replies = Schema.Struct({ file: Schema.String, replies: Schema.Finite, costUsd: Schema.Finite });
const Ranked = Schema.Struct({
  file: Schema.String,
  versions: Schema.Array(Schema.Struct({ version: Schema.String, passes: Schema.Finite, of: Schema.Finite, score: Schema.Finite, losesTo: Schema.Array(Schema.String) })),
  winner: Schema.NullOr(Schema.Finite),
  why: Schema.String,
});
const InstalledStep = Schema.Struct({ skill: Schema.String, wordsBefore: Schema.Finite, wordsAfter: Schema.Finite, files: Schema.Array(Schema.String), syncListLine: Schema.String });
export const Outcome = Schema.Struct({ item: Schema.NullOr(Schema.String), outcome: Schema.String, finished: Schema.Boolean });
export type Outcome = typeof Outcome.Type;

/** What Draft writes for one item, as the model returns it. */
const DraftReply = Schema.Struct({
  candidates: Schema.Array(Schema.Struct({ summary: Schema.String, edits: Schema.Array(Schema.Struct({ find: Schema.String, replace: Schema.String })) })),
  history: Schema.String,
  example: Schema.Struct({ name: Schema.String, text: Schema.String }),
  eval_case: Schema.Struct({ his_question: Schema.String, original_reply: Schema.String, his_reaction: Schema.String, state_before: Schema.Array(Schema.String), wanted: Schema.String, went_wrong: Schema.String }),
});
type DraftReply = typeof DraftReply.Type;

const jsonIn = (text: string): string => text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
const writeJson = (file: string, value: unknown) => Effect.sync(() => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 1)); });
const readJson = <A>(file: string) => Effect.sync(() => JSON.parse(fs.readFileSync(file, 'utf8')) as A);

/** Puts one model call's spend on the step's record as it lands. */
const recordWriterSpend = (id: string, spend: WriterSpend) => Effect.flatMap(AgentStep, (step) => Effect.sync(() => {
  step.usage(id, spend.model, { input_tokens: spend.inputTokens, cache_read_input_tokens: spend.cacheReadTokens, cache_creation_input_tokens: spend.cacheWriteTokens, output_tokens: spend.outputTokens });
}));
const recordJevSpend = (id: string, model: string, inputTokens: number, outputTokens: number) => Effect.flatMap(AgentStep, (step) => Effect.sync(() => {
  step.usage(id, model, { input_tokens: inputTokens, output_tokens: outputTokens });
}));

/** Every section of the skills as Jev chooses among them: its label, and its opening as what it means. Pure. */
const sectionCriteria = (sections: ReadonlyArray<{ readonly label: string; readonly text: string }>) => Object.fromEntries(sections.map((x) => [x.label, x.text.slice(0, 600)]));

/**
 * WHERE AN ITEM GOES: the skill whose sections Jev gives the most probability in all, then that skill's likeliest section.
 * Taking the single likeliest section put the convention-over-configuration item (how jive lays out packages) in effect's
 * "Which conventions win" at 0.17, by the word the two share, while senior-swe's sections held 0.53 in all. Measured on 10
 * items whose skill was known (2026-11-16): the same skill as the single likeliest section on the other 9; asking for the
 * skill first, from each skill's description and opening, got 8 of 10. Pure.
 */
export const placeBySkill = (input: { readonly probabilities: Readonly<Record<string, number>>; readonly sections: ReadonlyArray<SkillSection> }) => {
  const skillOf = new Map(input.sections.map((x) => [x.label, x.skill]));
  const perSkill = new Map<string, number>();
  for (const [label, p] of Object.entries(input.probabilities)) { const skill = skillOf.get(label); if (skill !== undefined) perSkill.set(skill, (perSkill.get(skill) ?? 0) + p); }
  const [skill, skillProbability] = [...perSkill].sort((a, b) => b[1] - a[1])[0]!;
  const [section, sectionProbability] = Object.entries(input.probabilities).filter(([label]) => skillOf.get(label) === skill).sort((a, b) => b[1] - a[1])[0]!;
  return { skill, skillProbability, section, sectionProbability };
};

/** What calibration measured, in a line: each judge against its baseline. Pure. */
const calibrationLine = (c: typeof Calibration.Type) => `Jev agrees with Alex on ${c.agreed} of ${c.graded} original replies (Opus judge: ${c.opusAgreed} of ${c.opusGraded}); the action judge fails ${c.actionAgreed} of ${c.actionGraded} action originals he objected to (original prompt: ${c.actionBaselineAgreed} of ${c.actionBaselineGraded})`;

export const defineSkillRefinement = (deps: SkillRefinementDeps) => {
  const { defineStep, defineWorkflow, queueNow } = deps.platform.steps;
  const at = import.meta.path;

  const PICK = defineStep({ name: 'Pick', agent: false, at, description: 'Takes the head of the intake queue.', success: Schema.Option(Schema.String), subject: (o) => Option.getOrNull(o), picked: Option.isSome });
  const CLASSIFY = defineStep({ name: 'Classify', agent: true, at, description: 'Jev names the skill section the item is about, and whether it is new, a repeat or a correction.', success: Classified, reason: (c) => `${c.section} (${c.kind})` });
  const DRAFT = defineStep({ name: 'Draft', agent: true, at, description: 'The generative model drafts candidate edits from the target skill, its example names and the item.', success: Drafted, reason: (d) => `${d.candidates.filter((c) => c.applies).length} of ${d.candidates.length} candidates apply` });
  const CHOOSE = defineStep({ name: 'Choose examples', agent: true, at, description: 'Jev names the section that owns each A/B case; the cases the changed section owns are tested.', success: Chosen, reason: (c) => `${c.cases.length} of ${c.considered} cases` });
  const CALIBRATE = defineStep({ name: 'Calibrate judge', agent: true, shared: true, at, description: 'Once per judge version: Jev grades the original reply cases and the Opus judge the action originals; a judge below its baseline is not used.', success: Calibration, reason: (c) => calibrationLine(c) });
  const AB = defineStep({ name: 'A/B', agent: true, at, description: 'The generative model writes each chosen case under the current text and each candidate.', success: Replies, reason: (r) => `${r.replies} replies, $${r.costUsd.toFixed(2)}` });
  const JUDGE = defineStep({ name: 'Judge', agent: true, at, description: 'Each reply is judged by its case kind\'s judge (an action case by the Opus judge, a reply case by Jev), and the candidates are ranked.', success: Ranked, reason: (r) => r.why });
  const INSTALL = defineStep({ name: 'Install', agent: false, at, description: 'Writes the winner to the synced skill and checks that the synced list shows it.', success: InstalledStep, writes: [], reason: (i) => i.syncListLine });

  /** Pick: the queue's head, the platform's order. */
  const pick = (run: string) => Effect.map(queueNow({ workflow: WORKFLOW, run }), (queue) => Option.fromNullishOr(queue[0]?.ref.item));

  const classify = (item: string) => Effect.gen(function* () {
    const jev = yield* Jev;
    const text = yield* deps.intake.text(item);
    const sections = yield* (yield* SkillFiles).sections();
    const where = yield* jev.ask({
      state: { feedback_item: text },
      questions: { section: { type: 'choice', instructions: 'Which section of the skills is the rule this feedback is about, the one a change for it would edit?', criteria: sectionCriteria(sections) } },
    });
    yield* recordJevSpend('classify section', where.model, where.inputTokens, where.outputTokens);
    const placed = placeBySkill({ probabilities: where.answers.section.probabilities, sections });
    const section = sections.find((s) => s.label === placed.section)!;
    const kind = yield* jev.ask({
      state: { feedback_item: text, the_section_now: section.text },
      questions: { kind: { type: 'choice', instructions: 'What is this feedback, against the section as it reads now?', criteria: {
        new: 'The section has no rule covering what he objects to.',
        repeat: 'The section already has a rule covering it, and the agent broke it again.',
        correction: 'It corrects an earlier feedback item, or a rule saved for one (a wording, a mechanism added to his words).',
      } } },
    });
    yield* recordJevSpend('classify kind', kind.model, kind.inputTokens, kind.outputTokens);
    return { skill: section.skill, section: section.label, sectionConfidence: placed.sectionProbability, kind: kind.answers.kind.choice, kindConfidence: kind.answers.kind.confidence, jevModel: kind.model };
  });

  const draft = (input: { readonly item: string; readonly run: string; readonly classified: typeof Classified.Type }) => Effect.gen(function* () {
    const files = yield* SkillFiles;
    const writer = yield* Writer;
    const target = yield* files.skillText(input.classified.skill);
    const howToChange = (yield* files.skillText(OWNING_SKILL)).text;
    const examples = yield* files.exampleNames(input.classified.skill);
    const notes = yield* Effect.orElseSucceed(deps.platform.tasks.notesForAgent({ workflow: WORKFLOW, item: input.item }), () => '');
    const written = yield* writer.write({
      system: `You maintain Alex's skills: the rules every agent working for him loads. You change one skill's text for one piece of his feedback. These are the rules for changing skills, from the skill that owns them (${OWNING_SKILL}):\n\n${howToChange}`,
      prompt: [
        `The feedback item, as the agent that received it handed it over:\n${yield* deps.intake.text(input.item)}`,
        `Jev classified it as about "${input.classified.section}" (confidence ${input.classified.sectionConfidence.toFixed(2)}), kind: ${input.classified.kind}.`,
        notes.length > 0 ? `Earlier tries on this item, and why they ended:\n${notes}` : '',
        `The skill's example files, by name: ${examples.join(', ')}`,
        `The skill ${input.classified.skill}'s whole text now:\n<<<SKILL\n${target.text}\nSKILL>>>`,
        `Write ${CANDIDATES} different candidate changes, each a list of exact replacements in that text: "find" must be copied exactly from the text and occur once.`
          + ' Also write the history entry for history.md (a "## " heading naming the rule, then his words, the date and what drew them), the example file (name and text: what happened, his words, why), and the A/B case for this instance as an action case.',
        'Return only JSON: {"candidates": [{"summary": "the rule change in one sentence", "edits": [{"find": "...", "replace": "..."}]}], "history": "...", "example": {"name": "topic-words.md", "text": "..."}, "eval_case": {"his_question": "his message that the agent acted on", "original_reply": "what the agent did and said", "his_reaction": "his exact words", "state_before": ["fact"], "wanted": "...", "went_wrong": "..."}}',
      ].filter(Boolean).join('\n\n'),
    });
    yield* recordWriterSpend('draft', written.spend);
    const reply = yield* Effect.mapError(Schema.decodeUnknownEffect(Schema.fromJsonString(DraftReply))(jsonIn(written.text)), (e) => `the draft was not the JSON asked for: ${e.message}`);
    const file = path.join(runFolder(deps.folders, input.run), 'draft.json');
    yield* writeJson(file, { ...reply, skill: input.classified.skill, draftedOn: target.sha, raw: written.text });
    return {
      skill: input.classified.skill, draftedOn: target.sha, file, costUsd: written.spend.costUsd,
      candidates: reply.candidates.map((c) => {
        const applied = applyEdits(target.text, c.edits);
        return { summary: c.summary, applies: Result.isSuccess(applied), why: Result.isSuccess(applied) ? 'applies' : applied.failure };
      }),
    };
  });

  /** The item's own case, as Draft wrote it, under the id it gets when installed. */
  const itemCase = (reply: DraftReply, id: string): typeof EvalCase.Type => ({
    id, kind: 'action', his_question: reply.eval_case.his_question, original_reply: reply.eval_case.original_reply, his_reaction: reply.eval_case.his_reaction,
    action: { state_before: reply.eval_case.state_before, wanted: reply.eval_case.wanted, went_wrong: reply.eval_case.went_wrong },
  });

  /**
   * THE EXAMPLES OF THE CHANGED RULE: the cases whose failure Jev places in the section the item changes, asked as Classify
   * asks (one section of all the skills' sections owns each failure), plus the item's own. Asked as "does this rule
   * govern it?", Jev said yes to 51 of 102 cases for one rule (2026-11-16), which would have cost about $21 of A/B for
   * one item. Each case's section is kept per case text and skills version, so it is asked once.
   */
  const choose = (classified: typeof Classified.Type) => Effect.gen(function* () {
    const jev = yield* Jev;
    const sections = yield* (yield* SkillFiles).sections();
    const criteria = sectionCriteria(sections);
    const version = shaOf(JSON.stringify(criteria));
    const cases = yield* readCases(evalCasesFolder(deps.folders));
    const owners = yield* Effect.forEach(cases, (c) => Effect.gen(function* () {
      const file = path.join(deps.folders.local, 'case-sections', `${shaOf(JSON.stringify(c))}-${version}.json`);
      if (fs.existsSync(file)) return { id: c.id, section: (yield* readJson<{ readonly section: string }>(file)).section };
      const asked = yield* jev.ask({ state: { example: caseSummary(c) }, questions: { section: { type: 'choice', instructions: 'Which section of the skills holds the rule whose breaking this example shows?', criteria } } });
      yield* recordJevSpend(`choose ${c.id}`, asked.model, asked.inputTokens, asked.outputTokens);
      yield* writeJson(file, { case: c.id, section: asked.answers.section.choice, confidence: asked.answers.section.confidence });
      return { id: c.id, section: asked.answers.section.choice };
    }), { concurrency: 8 });
    return { cases: owners.filter((o) => o.section === classified.section).map((o) => o.id), considered: cases.length };
  });

  /** The judge's version: its questions, the rule that scores them, and the cases it is calibrated on. */
  const judgeFingerprint = (cases: ReadonlyArray<typeof EvalCase.Type>, model: string) => shaOf(JSON.stringify({ judge: judgeVersion(), model, cases: cases.map((c) => [c.id, c.original_reply]) }));

  /** The Opus judge's grade of one plan and reply for an action case, its spend on the step's record. */
  const opusGrade = (input: { readonly id: string; readonly c: typeof EvalCase.Type; readonly reply: string }) => Effect.gen(function* () {
    const graded = yield* (yield* Writer).write({ system: 'You grade one agent\'s plan and reply. Return only the JSON asked for.', prompt: actionJudgePrompt(input.c, input.reply) });
    yield* recordWriterSpend(input.id, graded.spend);
    return yield* Effect.mapError(Schema.decodeUnknownEffect(Schema.fromJsonString(ActionVerdict))(jsonIn(graded.text)), (e) => `the Opus judge's verdict on ${input.c.id} was not the JSON asked for: ${e.message}`);
  });

  /**
   * BOTH JUDGES ARE HELD TO A BAR BEFORE ANY ITEM'S MODEL CALL, once per judge version. Jev, the judge of reply cases, must
   * agree with Alex on the original replies at least as often as the Opus judge did; the Opus judge of action cases must
   * fail at least as many of the action originals he objected to (all of them) as the evals' original action-judge prompt
   * did, so a change to its prompt never makes it more lenient on what he rejected.
   */
  const calibrate = () => Effect.gen(function* () {
    const jev = yield* Jev;
    const all = yield* readCases(evalCasesFolder(deps.folders));
    const replyCases = new Set(all.filter((c) => judgeOf(c) === 'jev').map((c) => c.id));
    const opus = deps.opusJudgeGrades.filter((o) => replyCases.has(o.case));
    const actionBaseline = deps.opusActionJudgeGrades;
    // With no grade to compare against, the bar would be zero and any judge would pass it.
    if (opus.length === 0 || actionBaseline.length === 0) return yield* Effect.fail('the Opus judge has no baseline grades, so no judge can be held to them');
    const graded = new Set(opus.map((o) => o.case));
    const cases = all.filter((c) => graded.has(c.id));
    const actionIds = new Set(actionBaseline.map((o) => o.case));
    const actionCases = all.filter((c) => actionIds.has(c.id));
    const fingerprint = judgeFingerprint([...cases, ...actionCases], 'jev-latest');
    const file = path.join(deps.folders.local, 'judge-calibration', `${fingerprint}.json`);
    if (fs.existsSync(file)) return yield* readJson<typeof Calibration.Type>(file);
    // He objected to every original reply but the ones he labelled good: a judge agrees with him when it fails those and passes these.
    const wanted = (id: string) => id.startsWith('good-');
    const verdicts = yield* Effect.forEach(cases, (c) => Effect.gen(function* () { const a = yield* jev.ask({ state: judgeState(c, c.original_reply), questions: judgeQuestions() }); return { id: c.id, a, verdict: verdictOf(a.answers as Record<string, number>) }; }), { concurrency: 8 });
    for (const v of verdicts) yield* recordJevSpend(`calibrate ${v.id}`, v.a.model, v.a.inputTokens, v.a.outputTokens);
    const agreed = verdicts.filter((v) => v.verdict.pass === wanted(v.id)).length;
    const opusAgreed = opus.filter((o) => o.pass === wanted(o.case)).length;
    const actions = yield* Effect.forEach(actionCases, (c) => Effect.map(opusGrade({ id: `calibrate ${c.id}`, c, reply: c.original_reply }), (v) => ({ id: c.id, pass: actionPasses(v), why: v.why })), { concurrency: WRITERS_AT_ONCE });
    const actionAgreed = actions.filter((a) => !a.pass).length;
    const actionBaselineAgreed = actionBaseline.filter((o) => !o.pass).length;
    const result = {
      fingerprint, agreed, graded: verdicts.length, opusAgreed, opusGraded: opus.length,
      actionAgreed, actionGraded: actions.length, actionBaselineAgreed, actionBaselineGraded: actionBaseline.length,
      usable: verdicts.length > 0 && agreed / verdicts.length >= opusAgreed / opus.length && actionAgreed / actions.length >= actionBaselineAgreed / actionBaseline.length,
      file,
    };
    yield* writeJson(file, { ...result, verdicts: verdicts.map((v) => ({ id: v.id, ...v.a.answers, ...v.verdict })), actions });
    return result;
  });

  /** Every (case, version, sample) to write: version 0 is the current text, 1.. the candidates that apply. */
  const abJobs = (input: { readonly reply: DraftReply; readonly current: string; readonly cases: ReadonlyArray<typeof EvalCase.Type> }) => {
    const versions = [input.current, ...input.reply.candidates.flatMap((c) => { const r = applyEdits(input.current, c.edits); return Result.isSuccess(r) ? [r.success] : []; })];
    return input.cases.flatMap((c) => versions.flatMap((text, version) => Array.from({ length: SAMPLES }, (_, sample) => ({ c, version, text, sample }))));
  };

  const ab = (input: { readonly run: string; readonly drafted: typeof Drafted.Type; readonly chosen: typeof Chosen.Type; readonly item: string }) => Effect.gen(function* () {
    const writer = yield* Writer;
    const reply = yield* readJson<DraftReply>(input.drafted.file);
    const current = (yield* (yield* SkillFiles).skillText(input.drafted.skill)).text;
    const all = yield* readCases(evalCasesFolder(deps.folders));
    const cases = [...all.filter((c) => input.chosen.cases.includes(c.id)), itemCase(reply, `this item (${input.item})`)];
    const jobs = abJobs({ reply, current, cases });
    const written = yield* Effect.forEach(jobs, (j) => Effect.gen(function* () {
      const w = yield* writer.write({ system: writerSystem(input.drafted.skill, j.text), prompt: writerPrompt(j.c) });
      yield* recordWriterSpend(`${j.c.id} v${j.version} s${j.sample}`, w.spend);
      return { case: j.c, version: j.version, sample: j.sample, reply: w.text, costUsd: w.spend.costUsd };
    }), { concurrency: WRITERS_AT_ONCE });
    const file = path.join(runFolder(deps.folders, input.run), 'replies.json');
    yield* writeJson(file, written);
    return { file, replies: written.length, costUsd: written.reduce((s, w) => s + w.costUsd, 0) };
  });

  /**
   * Ranks the versions by passes. A candidate wins only if it fails no case the current text passes (a case passes for a
   * version when most of its samples pass) and passes the item's own case; of those, the most passes wins.
   */
  const judge = (input: { readonly run: string; readonly replies: typeof Replies.Type }) => Effect.gen(function* () {
    const jev = yield* Jev;
    const written = yield* readJson<ReadonlyArray<{ readonly case: typeof EvalCase.Type; readonly version: number; readonly sample: number; readonly reply: string }>>(input.replies.file);
    const judged = yield* Effect.forEach(written, (w) => Effect.gen(function* () {
      const id = `judge ${w.case.id} v${w.version} s${w.sample}`;
      // Each case goes to its kind's judge (`judgeOf`): an action case to the Opus judge, a reply case to Jev.
      if (judgeOf(w.case) === 'opus') {
        const verdict = yield* opusGrade({ id, c: w.case, reply: w.reply });
        return { caseId: w.case.id, version: w.version, sample: w.sample, judge: 'opus' as const, verdict, pass: actionPasses(verdict), score: actionPasses(verdict) ? 1 : 0 };
      }
      const a = yield* jev.ask({ state: judgeState(w.case, w.reply), questions: judgeQuestions() });
      yield* recordJevSpend(id, a.model, a.inputTokens, a.outputTokens);
      return { caseId: w.case.id, version: w.version, sample: w.sample, judge: 'jev' as const, answers: a.answers, ...verdictOf(a.answers as Record<string, number>) };
    }), { concurrency: WRITERS_AT_ONCE });
    const ranked = rank(judged);
    const file = path.join(runFolder(deps.folders, input.run), 'judged.json');
    yield* writeJson(file, { judged, ranked });
    // The outcome note the next Draft of this item reads: with no winner, why each failing reply failed, so it can aim there.
    const failures = failureReasons(judged);
    const why = ranked.winner === null && failures.length > 0 ? `${ranked.why}. Why replies failed: ${failures.join(' | ')}` : ranked.why;
    return { file, ...ranked, why };
  });

  const install = (input: { readonly item: string; readonly run: string; readonly drafted: typeof Drafted.Type; readonly winner: number }) => Effect.gen(function* () {
    const files = yield* SkillFiles;
    const reply = yield* readJson<DraftReply>(input.drafted.file);
    const current = yield* files.skillText(input.drafted.skill);
    const applying = reply.candidates.filter((c) => Result.isSuccess(applyEdits(current.text, c.edits)));
    const chosen = applying[input.winner - 1]!;
    const newText = yield* Effect.mapError(Effect.fromResult(applyEdits(current.text, chosen.edits)), (why) => `the winner no longer applies: ${why}`);
    const caseFile = nextCaseFile(fs.readdirSync(evalCasesFolder(deps.folders)));
    const evalCase = itemCase(reply, caseFile.replace(/\.json$/, ''));
    const before = Date.now();
    const installed = yield* files.install({ skill: input.drafted.skill, draftedOn: input.drafted.draftedOn, newText, history: reply.history, example: reply.example, evalCase: { file: caseFile, json: JSON.stringify(evalCase, null, 1) } });
    const syncListLine = yield* files.confirmSynced({ skill: input.drafted.skill, since: before, afterSha: installed.afterSha });
    yield* deps.intake.recordInstalled(input.item, { item: input.item, run: input.run, rule: chosen.summary, ...installed, syncListLine, at: new Date().toISOString() });
    return { skill: installed.skill, wordsBefore: installed.wordsBefore, wordsAfter: installed.wordsAfter, files: installed.files, syncListLine };
  });

  const workflow = defineWorkflow<Outcome>({
    phase: 'skills', at, item: 'feedback item', finishedWord: 'installed',
    description: 'Turns each feedback item into a tested change to the synced skills.',
    steps: () => [PICK, CALIBRATE, CLASSIFY, DRAFT, CHOOSE, AB, JUDGE, INSTALL],
    picksQueueHead: true,
    pending: () => Effect.orElseSucceed(Effect.map(deps.intake.open(), (open) => ({ lines: [{ label: 'feedback items to install', items: open }], waits: [] })), () => ({ lines: [], waits: [] })),
    taskInputs: () => Effect.orElseSucceed(Effect.gen(function* () {
      const open = yield* deps.intake.open();
      const out = new Map<string, { readonly fingerprint: string }>();
      for (const id of open) out.set(id, { fingerprint: shaOf(`${yield* deps.intake.text(id)}\n${deps.configFingerprint()}`) });
      return out as ReadonlyMap<string, { readonly fingerprint: string }>;
    }), () => new Map()),
    outcomes: (o) => (o.item === null ? [] : [{ subject: o.item, outcome: o.outcome, finished: o.finished }]),
    graph: () => [
      { from: RUN_STARTS, to: PICK.name, when: 'each run' },
      { from: PICK.name, to: CALIBRATE.name, when: 'an item picked' },
      { from: CALIBRATE.name, to: CLASSIFY.name, when: 'the judge agrees with him at least as often as the Opus judge did' },
      { from: CALIBRATE.name, to: RUN_ENDS, when: 'the judge agrees with him less often: no model call is spent on the item' },
      { from: PICK.name, to: RUN_ENDS, when: 'the run is past its run limit' },
      { from: CLASSIFY.name, to: DRAFT.name, when: 'always' },
      { from: DRAFT.name, to: CHOOSE.name, when: 'a candidate applies' },
      { from: DRAFT.name, to: RUN_ENDS, when: 'no candidate applies' },
      { from: CHOOSE.name, to: AB.name, when: 'always' },
      { from: AB.name, to: JUDGE.name, when: 'always' },
      { from: JUDGE.name, to: INSTALL.name, when: 'a candidate wins' },
      { from: JUDGE.name, to: RUN_ENDS, when: 'no candidate wins' },
      { from: INSTALL.name, to: RUN_ENDS, when: 'always' },
      { from: A_STEP_FAILS, to: RUN_ENDS, when: 'a step fails' },
    ],
  })(WORKFLOW, {
    payload: { run: Schema.String },
    idempotencyKey: ({ run }) => run,
    success: Outcome,
    error: Schema.String,
  });

  const layer = workflow.toLayer((payload) => Effect.gen(function* () {
    const { run } = payload as { readonly run: string };
    const picked = yield* PICK.run(pick(run));
    if (Option.isNone(picked)) return { item: null, outcome: 'nothing picked', finished: false };
    const item = picked.value;
    // The judge is checked first: a judge that cannot be trusted would waste every model call after it.
    const calibration = yield* CALIBRATE.run(calibrate());
    if (!calibration.usable) return { item, outcome: `the judge is not calibrated: ${calibrationLine(calibration)}`, finished: false };
    const classified = yield* CLASSIFY.run(classify(item));
    const drafted = yield* DRAFT.run(draft({ item, run, classified }));
    if (!drafted.candidates.some((c) => c.applies)) return { item, outcome: `no candidate applies: ${drafted.candidates.map((c) => c.why).join('; ')}`, finished: false };
    const chosen = yield* CHOOSE.run(choose(classified));
    const replies = yield* AB.run(ab({ run, drafted, chosen, item }));
    const ranked = yield* JUDGE.run(judge({ run, replies }));
    if (ranked.winner === null) return { item, outcome: `no candidate wins: ${ranked.why}`, finished: false };
    const installed = yield* INSTALL.run(install({ item, run, drafted, winner: ranked.winner }));
    return { item, outcome: `installed in ${installed.skill} (${installed.wordsBefore} to ${installed.wordsAfter} words)`, finished: true };
  }));

  return { workflow, layer, steps: { PICK, CLASSIFY, DRAFT, CHOOSE, CALIBRATE, AB, JUDGE, INSTALL } };
};


/** Why each failing reply failed: the Opus judge's sentence, or the reply criteria Jev failed it on. Pure. */
export const failureReasons = (judged: ReadonlyArray<
  { readonly caseId: string; readonly version: number; readonly sample: number; readonly pass: boolean }
  & ({ readonly judge: 'opus'; readonly verdict: ActionVerdict } | { readonly judge: 'jev'; readonly answers: unknown })
>): ReadonlyArray<string> => judged.filter((j) => !j.pass).map((j) => {
  const failed = j.judge === 'opus'
    ? j.verdict.why
    : `failed ${Object.entries(REPLY_CRITERIA).filter(([k, c]) => { const yes = (j.answers as Record<string, number>)[k] ?? 0; return (c.passesWhen === 'yes' ? yes : 1 - yes) < 0.5; }).map(([k]) => k).join(', ')}`;
  return `${j.caseId} ${j.version === 0 ? 'current' : `candidate ${j.version}`} sample ${j.sample}: ${failed}`;
});

/** Each version's passes, the cases it loses that the current text wins, and the winner. Pure. */
export const rank = (judged: ReadonlyArray<{ readonly caseId: string; readonly version: number; readonly pass: boolean; readonly score: number }>) => {
  const versions = [...new Set(judged.map((j) => j.version))].sort((a, b) => a - b);
  const caseIds = [...new Set(judged.map((j) => j.caseId))];
  const passesCase = (version: number, caseId: string) => {
    const samples = judged.filter((j) => j.version === version && j.caseId === caseId);
    return samples.filter((s) => s.pass).length * 2 > samples.length;
  };
  const rows = versions.map((v) => ({
    version: v === 0 ? 'current' : `candidate ${v}`,
    passes: caseIds.filter((c) => passesCase(v, c)).length,
    of: caseIds.length,
    score: judged.filter((j) => j.version === v).reduce((s, j) => s + j.score, 0),
    losesTo: v === 0 ? [] : caseIds.filter((c) => passesCase(0, c) && !passesCase(v, c)),
  }));
  const ownCase = caseIds.find((c) => c.startsWith('this item'));
  const eligible = versions.filter((v) => v !== 0 && rows[versions.indexOf(v)]!.losesTo.length === 0 && (ownCase === undefined || passesCase(v, ownCase)));
  const best = eligible.sort((a, b) => rows[versions.indexOf(b)]!.passes - rows[versions.indexOf(a)]!.passes || rows[versions.indexOf(b)]!.score - rows[versions.indexOf(a)]!.score)[0];
  const why = best === undefined
    ? `no candidate passes the item's own case without failing a case the current text passes (${rows.map((r) => `${r.version}: ${r.passes}/${r.of}`).join(', ')})`
    : `candidate ${best} passes ${rows[versions.indexOf(best)]!.passes} of ${caseIds.length} cases, the current text ${rows[0]!.passes}`;
  return { versions: rows, winner: best ?? null, why };
};
