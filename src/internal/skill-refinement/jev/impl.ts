import { Effect, Layer, pipe, Schema } from 'effect';
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http';
import { Jev, JevError, type IJev, type JevAnswers, type JevQuestion } from './interface';

const SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone';

/** The answer shapes this workflow asks for, as TypeSafe's API returns them. */
const Answer = Schema.Union([
  Schema.Struct({ type: Schema.Literal('noul'), noul: Schema.Finite }),
  Schema.Struct({ type: Schema.Literal('choice'), choice: Schema.String, confidence: Schema.Finite, probabilities: Schema.Record(Schema.String, Schema.Finite) }),
]);
const SystemOneResponse = Schema.Struct({
  model: Schema.String,
  answers: Schema.Record(Schema.String, Answer),
  usage: Schema.Struct({ input_tokens: Schema.Finite, output_tokens: Schema.Finite }),
});

/** Where Jev is reached and as whom: the API key the TypeSafe console issued, and the model alias to ask. */
export interface JevConfig {
  /** Read at each request, so a key put in place reaches a running service. */
  readonly apiKey: () => string;
  readonly model: string;
}

class JevImpl implements IJev {
  constructor(private readonly client: HttpClient.HttpClient, private readonly config: JevConfig) {}

  *ask<Q extends Readonly<Record<string, JevQuestion>>>(input: { readonly state: unknown; readonly questions: Q }): Effect.fn.Return<JevAnswers<Q>, JevError> {
    const body = { model: this.config.model, state: input.state, questions: input.questions };
    const request = pipe(
      HttpClientRequest.post(SYSTEM_ONE_URL),
      HttpClientRequest.bearerToken(this.config.apiKey()),
      // Long context costs the same and lifts the 32k-per-question limit to 262k: a skill's sections fill a question.
      HttpClientRequest.setHeader('TypeSafe-Danger-Zone-Long-Context', 'true'),
      HttpClientRequest.bodyJsonUnsafe(body),
    );
    const failed = (reason: string) => new JevError({ reason });
    const response = yield* Effect.mapError(this.client.execute(request), (e) => failed(e.message));
    if (response.status < 200 || response.status >= 300) {
      const text = yield* Effect.orElseSucceed(response.text, () => '');
      return yield* Effect.fail(failed(`HTTP ${response.status}: ${text.slice(0, 600)}`));
    }
    const decoded = yield* Effect.mapError(HttpClientResponse.schemaJson(Schema.Struct({ body: SystemOneResponse }))(response), (e) => failed(`unexpected response: ${e.message}`));
    const reply = decoded.body;
    const answers: Record<string, unknown> = {};
    for (const key of Object.keys(input.questions)) {
      const a = reply.answers[key];
      if (a === undefined) return yield* Effect.fail(new JevError({ reason: `no answer for question ${key}` }));
      answers[key] = a.type === 'noul' ? a.noul : { choice: a.choice, confidence: a.confidence, probabilities: a.probabilities };
    }
    return {
      answers: answers as JevAnswers<Q>['answers'],
      model: reply.model,
      inputTokens: reply.usage.input_tokens,
      outputTokens: reply.usage.output_tokens,
    };
  }
}

export const JevLive = (config: JevConfig) => pipe(
  Layer.effect(Jev, Effect.gen(function* () { return new JevImpl(yield* HttpClient.HttpClient, config); })),
  Layer.provide(FetchHttpClient.layer),
);
