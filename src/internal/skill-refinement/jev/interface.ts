/**
 * JEV, TypeSafe AI's classification model: text plus typed questions in, a typed answer with its probabilities out. It
 * writes no text. Every classify, rank, route and judge step of this workflow asks Jev; only steps that must write text
 * call a generative model (`writer/`).
 *
 * The HTTP contract is TypeSafe's (https://docs.typesafe.ai/api/system-one.md): `POST /v1/systemone` with `model`, `state`
 * and `questions` keyed by our own names; each answer comes back under its question's key.
 */
import { Context, Data, type Effect } from 'effect';

/** A yes-or-no question: its answer is the probability of yes. */
export interface YesNoQuestion {
  readonly type: 'noul';
  /** The question, or an object of its parts (TypeSafe reads any fields: a question and a focus). */
  readonly instructions: string | Readonly<Record<string, string>>;
}

/** A question with named options, each with what it means (null: read by its name alone). */
export interface ChoiceQuestion<Label extends string = string> {
  readonly type: 'choice';
  readonly instructions: string;
  readonly criteria: Readonly<Record<Label, string | null>>;
}

export type JevQuestion = YesNoQuestion | ChoiceQuestion;

export interface ChoiceAnswer<Label extends string = string> {
  readonly choice: Label;
  readonly confidence: number;
  readonly probabilities: Readonly<Record<Label, number>>;
}

/** What one question gets back: the probability of yes, or the chosen option. */
export type AnswerOf<Q> = Q extends ChoiceQuestion<infer L> ? ChoiceAnswer<L> : Q extends YesNoQuestion ? number : never;

export interface JevAnswers<Q extends Readonly<Record<string, JevQuestion>>> {
  readonly answers: { readonly [K in keyof Q]: AnswerOf<Q[K]> };
  /** The versioned model that answered, which may differ from the alias asked for. */
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export class JevError extends Data.TaggedError('JevError')<{ readonly reason: string }> {}

export interface IJev {
  /** Asks every question about one `state` in one request; Jev evaluates them in parallel. */
  readonly ask: <Q extends Readonly<Record<string, JevQuestion>>>(input: { readonly state: unknown; readonly questions: Q }) => Effect.fn.Return<JevAnswers<Q>, JevError>;
}

export class Jev extends Context.Service<Jev, IJev>()('Jev') {}
