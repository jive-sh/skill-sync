/**
 * THE GENERATIVE MODEL, for the steps that must write text: drafting a skill edit and writing a reply under a skill
 * version. Each call is a fresh, small request with only the text the step gives it: no tools, no settings, no history.
 */
import { Context, Data, type Effect } from 'effect';

/** What one call spent, as the model's API reported it, and its list price. */
export interface WriterSpend {
  readonly model: string;
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}

export interface Written {
  readonly text: string;
  readonly spend: WriterSpend;
}

export class WriterError extends Data.TaggedError('WriterError')<{ readonly reason: string }> {}

export interface IWriter {
  /** `system` is the rules the text is written under (a skill version); `prompt` the one request. */
  readonly write: (input: { readonly system: string; readonly prompt: string }) => Effect.fn.Return<Written, WriterError>;
}

export class Writer extends Context.Service<Writer, IWriter>()('Writer') {}
