/**
 * THE A/B EXAMPLES: replies and actions Alex objected to (or labelled good), kept in `agentic-collaboration/evals/cases`.
 * Each is replayed under every skill version a run tests: a writer writes the reply or action under that version, and Jev
 * judges it against what the case had to convey and what went wrong (`agentic-collaboration` section 1, Test before
 * installing).
 */
import { Data, Effect, Schema } from 'effect';
import fs from 'node:fs';
import path from 'node:path';

export const EvalCase = Schema.Struct({
  id: Schema.String,
  kind: Schema.optionalKey(Schema.Literals(['good', 'action'])),
  his_question: Schema.String,
  original_reply: Schema.String,
  his_reaction: Schema.String,
  intended: Schema.optionalKey(Schema.Struct({ facts: Schema.Array(Schema.String), he_must_do: Schema.String, intended_meaning: Schema.String })),
  action: Schema.optionalKey(Schema.Struct({ state_before: Schema.Array(Schema.String), wanted: Schema.String, went_wrong: Schema.String })),
});
export type EvalCase = typeof EvalCase.Type;

export class CasesError extends Data.TaggedError('CasesError')<{ readonly reason: string }> {}

const decodeCase = Schema.decodeUnknownEffect(Schema.fromJsonString(EvalCase));

/** Every case that can be replayed: a reply case with its intended meaning, or an action case with its state. */
export const readCases = (folder: string): Effect.Effect<ReadonlyArray<EvalCase>, CasesError> => Effect.gen(function* () {
  const files = yield* Effect.try({ try: () => fs.readdirSync(folder).filter((f) => f.endsWith('.json')).sort(), catch: (e) => new CasesError({ reason: `the cases could not be listed: ${String(e)}` }) });
  const out: EvalCase[] = [];
  for (const f of files) {
    const text = yield* Effect.try({ try: () => fs.readFileSync(path.join(folder, f), 'utf8'), catch: (e) => new CasesError({ reason: `${f} could not be read: ${String(e)}` }) });
    const c = yield* Effect.mapError(decodeCase(text), (e) => new CasesError({ reason: `${f} is not a case: ${e.message}` }));
    if (replayable(c)) out.push(c);
  }
  return out;
});

export const replayable = (c: EvalCase): boolean => (c.kind === 'action' ? c.action !== undefined : c.intended !== undefined);

/** The next free case file name, `case-NN.json`. Pure. */
export const nextCaseFile = (existing: ReadonlyArray<string>): string => {
  const numbers = existing.flatMap((f) => { const m = /^case-(\d+)\.json$/.exec(f); return m === null ? [] : [Number(m[1])]; });
  return `case-${String(Math.max(0, ...numbers) + 1).padStart(2, '0')}.json`;
};

/** A case in a few lines, as Jev reads it when choosing which examples a rule governs. Pure. */
export const caseSummary = (c: EvalCase): string => [
  `His message: ${c.his_question.slice(0, 500)}`,
  `His reaction: ${c.his_reaction.slice(0, 400)}`,
  c.action !== undefined ? `What went wrong: ${c.action.went_wrong.slice(0, 400)}` : `What the reply had to convey: ${c.intended?.intended_meaning.slice(0, 400) ?? ''}`,
].join('\n');

/**
 * What a writer is asked, under one skill version, for one case: the reply, or for an action case the changes it makes
 * next and the reply. The same words as the evals' first runner (`evals/run.ts`), so results compare. Pure.
 */
export const writerPrompt = (c: EvalCase): string => (c.kind === 'action' && c.action !== undefined
  ? `Alex's latest message:\n${c.his_question}\n\nThe state of the work now (facts):\n- ${c.action.state_before.join('\n- ')}\n\n`
    + 'You have no tools in this exercise. Write PLAN: the concrete changes you make next, exactly as you would make them '
    + '(what is added, removed or moved, and what he will see afterwards), then REPLY: the exact text you send Alex.'
  : `Alex's latest message:\n${c.his_question}\n\nWhat you know now from this turn's tool results (facts, not wording):\n- ${c.intended?.facts.join('\n- ') ?? ''}\n`
    + `What he has to do or decide: ${c.intended?.he_must_do ?? ''}\n\nWrite the exact reply you send Alex now. Output only the reply text.`);

/** The rules a writer writes under: one skill version's text. Pure. */
export const writerSystem = (skill: string, text: string): string =>
  `You are an agent working for Alex. These are your rules, loaded at the start of this session:\n\n# Skill: ${skill}\n\n${text}`;

/**
 * WHO JUDGES A CASE, BY ITS KIND. A reply case (how a reply reads) goes to Jev, held to the Opus judge's agreement with
 * Alex by calibration. An action case (what got built or done) goes to the Opus judge: on 68 action cases (2026-11-16)
 * Jev failed every plan, the ones exactly as he wanted included, and no cut on its probabilities held up live. Alex,
 * choosing this: "Sure. I mean that can be encoded in the workflow logic right?". Pure.
 */
export const judgeOf = (c: EvalCase): 'opus' | 'jev' => (c.kind === 'action' ? 'opus' : 'jev');

/** Who Jev reads a reply as. */
export const JUDGE_ALEX = 'Alex is an engineer who reads replies on his phone, cannot scroll back, and objects to any reply that makes him work to understand it, guesses at what he meant, or adds what he did not ask for.';

/** What Jev is told about one written reply: what it had to convey and the reply, as the Opus judge was told. Pure. */
export const judgeState = (c: EvalCase, reply: string) => ({
  alex: JUDGE_ALEX,
  his_message: c.his_question,
  what_the_reply_had_to_convey: c.intended?.intended_meaning ?? '',
  facts: c.intended?.facts ?? [],
  what_he_had_to_do: c.intended?.he_must_do ?? '',
  reply,
});

/** His own terms, which a reply may use unexplained (the evals' first judge kept the same list). */
const ALEX_TERMS = '"Skill maintenance thread", "command thread", "control thread", "Blocked on you", "skill", "phase", "workflow"';

/** One yes-or-no criterion of the judge, and whether yes is what a passing reply has. */
interface Criterion { readonly instructions: string; readonly passesWhen: 'yes' | 'no' }

/**
 * JEV'S CRITERIA FOR A REPLY: the Opus judge's rubric, one Jev question each, so a reply passes on the same checks it was
 * calibrated on (every reply he objected to fails, the one he labelled good passes), read as a busy reader with no other
 * context would read it.
 */
export const REPLY_CRITERIA: Readonly<Record<string, Criterion>> = {
  meaning_match: { passesWhen: 'yes', instructions: 'Reading only his message and this reply, once, as a busy person: would he understand exactly what the reply had to convey (in the state), with the facts it lists?' },
  answer_first: { passesWhen: 'yes', instructions: 'Does the first sentence answer what he asked, or lead with what he must know?' },
  needs_history: { passesWhen: 'no', instructions: 'Does the answer or an action depend on earlier messages he would have to look up ("the plan", "that thread", "as I said")?' },
  undefined_labels: { passesWhen: 'no', instructions: `Does it use internal or coined labels (thread names, step names, project jargon) he did not use and it does not explain? Standard engineering terms do not count, and neither do his own terms: ${ALEX_TERMS}.` },
  misleading_ambiguity: { passesWhen: 'no', instructions: 'Does a sentence about the answer, or about what he must do, have another plausible reading?' },
  too_long: { passesWhen: 'no', instructions: 'Is it clearly longer than what he asked needs? A report he asked for may be long.' },
  follow_up_needed: { passesWhen: 'no', instructions: 'Would he need to ask a follow-up question to understand it or act on it?' },
};

/**
 * How strictly each criterion is judged. Measured on the 40 original replies the Opus judge graded (2026-11-16): the bare
 * questions agreed with Alex on 34 and 35 of 40, these with this focus on 37, 37 and 36; the Opus judge on 35.
 */
export const JUDGE_FOCUS = 'Judge strictly, as Alex would: when in doubt, the reply has the problem.';

/** Jev's questions for a reply case. Pure. */
export const judgeQuestions = () => Object.fromEntries(Object.entries(REPLY_CRITERIA).map(([k, v]) => [k, { type: 'noul' as const, instructions: { question: v.instructions, focus: JUDGE_FOCUS } }]));

/** A reply Jev judged: it passes when every criterion is on its passing side; its score is how far, for ranking. Pure. */
export const verdictOf = (answers: Readonly<Record<string, number>>): { readonly pass: boolean; readonly score: number } => {
  let pass = true;
  let score = 1;
  for (const [k, v] of Object.entries(REPLY_CRITERIA)) {
    const yes = answers[k] ?? 0;
    const good = v.passesWhen === 'yes' ? yes : 1 - yes;
    if (good < 0.5) pass = false;
    score *= good;
  }
  return { pass, score };
};

/** The Opus judge's verdict on an action case, as its prompt asks for it. */
export const ActionVerdict = Schema.Struct({
  does_what_he_wanted: Schema.Boolean,
  adds_unasked: Schema.Boolean,
  keeps_what_he_rejected: Schema.Boolean,
  unstated_guess: Schema.Boolean,
  why: Schema.String,
});
export type ActionVerdict = typeof ActionVerdict.Type;

/** Whether the Opus judge's verdict passes the plan; the evals' first runner passed it on the same four. Pure. */
export const actionPasses = (v: ActionVerdict): boolean => v.does_what_he_wanted && !v.adds_unasked && !v.keeps_what_he_rejected && !v.unstated_guess;

/**
 * What the Opus judge is asked about one plan and reply: the evals' first runner's action judge (`evals/run.ts`), with one
 * exclusion added to "adds_unasked": keeping the work's docs accurate and recording his decision. The skills require both
 * ("update what describes it", "a direction he gives is written to the design doc or owning skill that turn"), and on
 * 2026-11-16 11 of the 12 failing replies to three runs' own cases failed on "adds_unasked" alone, most for a README,
 * design-doc or decision-record edit (others for deleting an old copy, which still counts). Calibration holds it to
 * failing every action original the original prompt failed. Pure.
 */
export const actionJudgePrompt = (c: EvalCase, output: string): string =>
  'Grade what an agent decided to do for Alex. You don\'t know who wrote it or under which rules. '
  + 'The agent did not see his later reaction; you do, so you know what he wanted.\n\n'
  + `The state before acting:\n- ${c.action?.state_before.join('\n- ') ?? ''}\n\nHis message:\n${c.his_question}\n\n`
  + `What he wanted (from his later reaction): ${c.action?.wanted ?? ''}\nWhat a past agent got wrong here: ${c.action?.went_wrong ?? ''}\n\n`
  + `The agent's plan and reply:\n${output}\n\n`
  + 'Return only JSON: {"does_what_he_wanted": the result he would see is what he wanted, '
  + '"adds_unasked": it builds, adds or rearranges something he would see that he didn\'t ask for; moving existing content to where the structure he asked for puts it, '
  + 'tests or checks that guard what he asked for, and keeping the docs that describe the work accurate (its README or design doc, his decision recorded where the project keeps its decisions) don\'t count, '
  + '"keeps_what_he_rejected": what he would see still contains something he said he doesn\'t want, '
  + '"unstated_guess": where his message leaves the result open, it builds its own guess without stating the concrete result in the reply, '
  + '"why": "one sentence"}';

/** The judge's version: everything a verdict depends on but the models. A change recalibrates Jev and requeues every item. */
export const judgeVersion = (): string => JSON.stringify({ REPLY_CRITERIA, JUDGE_FOCUS, JUDGE_ALEX, action: actionJudgePrompt({ id: '', his_question: '', original_reply: '', his_reaction: '', kind: 'action', action: { state_before: [], wanted: '', went_wrong: '' } }, '') });
