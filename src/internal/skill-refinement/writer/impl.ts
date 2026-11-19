import { Effect, Layer, Schema } from 'effect';
import fs from 'node:fs';
import path from 'node:path';
import { Writer, WriterError, type IWriter, type Written } from './interface';

/** Which Claude account and model the calls run on, and where each call's system prompt file is written. */
export interface WriterConfig {
  /** The `claude` CLI to run: found where its installers put it, since the daemon runs with the service manager's PATH. */
  readonly claudeCommand: string;
  /** The Claude Code config folder whose sign-in the calls use (`CLAUDE_CONFIG_DIR`): it decides which account pays. */
  readonly claudeConfigDir: string;
  readonly model: string;
  readonly scratch: string;
}

/** `claude -p --output-format json`'s result, the fields this module reads. */
const ClaudeResult = Schema.Struct({
  is_error: Schema.Boolean,
  result: Schema.String,
  total_cost_usd: Schema.Finite,
  usage: Schema.Struct({
    input_tokens: Schema.Finite,
    cache_read_input_tokens: Schema.Finite,
    cache_creation_input_tokens: Schema.Finite,
    output_tokens: Schema.Finite,
  }),
});
const decodeResult = Schema.decodeUnknownEffect(Schema.fromJsonString(ClaudeResult));

class ClaudeCliWriter implements IWriter {
  constructor(private readonly config: WriterConfig) {}

  *write(input: { readonly system: string; readonly prompt: string }): Effect.fn.Return<Written, WriterError> {
    const { config } = this;
    // The system prompt goes in a file: a skill is longer than an argument should carry.
    const systemFile = path.join(config.scratch, `system-${Bun.hash(input.system).toString(36)}.md`);
    yield* Effect.try({
      try: () => { fs.mkdirSync(config.scratch, { recursive: true }); if (!fs.existsSync(systemFile)) fs.writeFileSync(systemFile, input.system); },
      catch: (e) => new WriterError({ reason: `the system prompt file could not be written: ${String(e)}` }),
    });
    const out = yield* Effect.tryPromise({
      try: async () => {
        const proc = Bun.spawn(
          [config.claudeCommand, '-p', input.prompt, '--model', config.model, '--setting-sources', '', '--tools', '', '--no-session-persistence', '--output-format', 'json', '--system-prompt-file', systemFile],
          { cwd: config.scratch, stdout: 'pipe', stderr: 'pipe', env: childEnv(config.claudeConfigDir) },
        );
        const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        return { stdout, stderr, code };
      },
      catch: (e) => new WriterError({ reason: `claude could not start: ${String(e)}` }),
    });
    const parsed = yield* Effect.mapError(decodeResult(out.stdout), () => new WriterError({ reason: `claude exited ${out.code}: ${(out.stdout + out.stderr).slice(0, 600)}` }));
    if (parsed.is_error) return yield* Effect.fail(new WriterError({ reason: `claude failed: ${parsed.result.slice(0, 600)}` }));
    return {
      text: parsed.result,
      spend: {
        model: config.model,
        inputTokens: parsed.usage.input_tokens,
        cacheReadTokens: parsed.usage.cache_read_input_tokens,
        cacheWriteTokens: parsed.usage.cache_creation_input_tokens,
        outputTokens: parsed.usage.output_tokens,
        costUsd: parsed.total_cost_usd,
      },
    };
  }
}

export const WriterLive = (config: WriterConfig) => Layer.succeed(Writer, new ClaudeCliWriter(config));

/**
 * The service's own environment with the account set, and none of the variables a running Claude Code session gives the
 * processes it starts: a call made from inside a session would otherwise act as part of it.
 */
const childEnv = (claudeConfigDir: string): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('CLAUDE_CODE') && k !== 'CLAUDECODE') env[k] = v;
  env.CLAUDE_CONFIG_DIR = claudeConfigDir;
  return env;
};
