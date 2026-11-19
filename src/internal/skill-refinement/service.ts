/**
 * THE SKILL REFINEMENT RUNNER: hosts the workflow engine inside the skill-sync daemon and keeps the workflow's runs going.
 * Each turn it reads the intake (the workflow's list of work) and starts the runs the workflow's run limit keeps above those
 * going (`planRunStarts`). A turn runs when an item lands in the intake, when a run ends, and otherwise every minute as the
 * fallback. The daemon starts it (`startSkillRefinement`), reports what the platform's dashboard shows (`pageData`) and
 * passes on the dashboard's limit changes (`setLimit`).
 *
 * Configuration, read once at the start: `TYPESAFE_API_KEY` (or the skill folder's `typesafe-api-key` file) for Jev, and
 * `SKILL_REFINEMENT_CLAUDE_CONFIG_DIR`, the Claude Code config folder whose account the generative calls run on (by
 * default the account folder holding the copy the runner works from, `locateSkillCopy`). Nothing here names a machine.
 */
import { SqliteClient } from '@effect/sql-sqlite-bun';
import {
  describeFailure, KEEP_RUNNING_EVERY_SECONDS, newRunId, oneTurnAtATime, planRunStarts, runsNow, SET_WORKFLOW_BUDGET_SQL, SET_WORKFLOW_RUNS_SQL,
  START_LIMIT_SECONDS, TURN_LIMIT_MS, WORKFLOW_BUDGET_SQL,
} from '@jive-sh/workflow-platform';
import { Database } from 'bun:sqlite';
import { Crypto, Duration, Effect, Layer, ManagedRuntime, Option, pipe } from 'effect';
import { ClusterWorkflowEngine, RunnerAddress, SingleRunner } from 'effect/cluster';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { judgeVersion } from './evals/cases';
import { makeIntake } from './feedback/intake';
import { JevLive } from './jev/impl';
import { engineDatabase, installedFolder, intakeFolder, locateSkillCopy, machineIntakeFolders, platformDatabase, runFolder, type WorkflowFolders } from './paths';
import OPUS_JUDGE_ORIGINAL from './evals/opus-judge-original.json';
import OPUS_ACTION_JUDGE_ORIGINAL from './evals/opus-action-judge-original.json';
import { skillRefinementPlatform } from './platform';
import { SkillFiles, SkillFilesLive, type SyncedSkills } from './skills/skill-text';
import type { Jev } from './jev/interface';
import type { Writer } from './writer/interface';
import { defineSkillRefinement, WORKFLOW } from './workflow/skill-refinement';
import { WriterLive } from './writer/impl';
import type { LimitChange, RefinementPageData } from '../wire';

/** Bun's WebCrypto, as the cluster's message storage needs it. */
const CryptoLive = Layer.succeed(Crypto.Crypto, Crypto.make({
  randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
  digest: (algorithm, data) => Effect.promise(async () => new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, new Uint8Array(data)))),
}));

export interface ServiceConfig {
  readonly folders: WorkflowFolders;
  /** Jev's API key, read when used; empty while none is set, so its steps fail with that reason. */
  readonly typesafeApiKey: () => string;
  readonly jevModel: string;
  readonly claudeConfigDir: string;
  readonly writerModel: string;
  /** The Opus judge's grades of the original replies, the bar Jev is calibrated against. */
  readonly opusJudgeGrades: ReadonlyArray<{ readonly case: string; readonly pass: boolean }>;
  /** The evals' original action-judge prompt's grades of the action originals, the bar the action judge is held to. */
  readonly opusActionJudgeGrades: ReadonlyArray<{ readonly case: string; readonly pass: boolean }>;
  /** Every intake the items are read from (`machineIntakeFolders`). */
  readonly intakes: ReadonlyArray<string>;
}

/**
 * EACH WORKFLOW STARTS AT ONE RUN AND ONE AGENT (`spawn-subthread` section 2, step 3): set once, never changed here; the
 * owner changes them in the `workflow_budgets` table.
 */
const ensureLimits = (folders: WorkflowFolders) => {
  const db = new Database(platformDatabase(folders), { create: true });
  try {
    db.run('CREATE TABLE IF NOT EXISTS workflow_budgets (workflow TEXT PRIMARY KEY, budget INTEGER NOT NULL, runs INTEGER, changed_at REAL NOT NULL)');
    if (db.query(WORKFLOW_BUDGET_SQL).get(WORKFLOW) === null) {
      db.query(SET_WORKFLOW_BUDGET_SQL).run(WORKFLOW, 1, Date.now() / 1000);
      db.query(SET_WORKFLOW_RUNS_SQL).run(WORKFLOW, 1, Date.now() / 1000);
    }
  } finally {
    db.close();
  }
};

/** The workflow, its engine and its modules, on one machine's folders; a test gives fake modules. */
export const makeService = (config: ServiceConfig, modules: Layer.Layer<Jev | Writer | SkillFiles>) => {
  const { folders } = config;
  fs.mkdirSync(intakeFolder(folders), { recursive: true });
  ensureLimits(folders);
  const platform = skillRefinementPlatform(folders);
  const intake = makeIntake({ intake: intakeFolder(folders), intakes: config.intakes, installed: installedFolder(folders) });
  // A key put in place changes every task's inputs, so the items its absence stopped are queued again.
  const configFingerprint = () => JSON.stringify({ judge: judgeVersion(), jev: config.jevModel, jevKeySet: config.typesafeApiKey().length > 0, writer: config.writerModel, account: config.claudeConfigDir });
  const maintenance = defineSkillRefinement({ platform, intake, folders, opusJudgeGrades: config.opusJudgeGrades, opusActionJudgeGrades: config.opusActionJudgeGrades, configFingerprint });
  const layer = pipe(
    maintenance.layer as Layer.Layer<never>,
    Layer.provideMerge(ClusterWorkflowEngine.layer),
    Layer.provideMerge(SingleRunner.layer({
      runnerStorage: 'sql',
      shardingConfig: { runnerAddress: Option.some(RunnerAddress.make('skill-refinement', process.pid)), entityTerminationTimeout: Duration.minutes(10) },
    })),
    Layer.provideMerge(SqliteClient.layer({ filename: engineDatabase(folders), busyTimeout: Duration.seconds(1) })),
    Layer.provideMerge(CryptoLive),
    Layer.provideMerge(modules),
  );
  const runtime = ManagedRuntime.make(layer);

  /** One turn: the list read into the task queue, then the runs the limits keep, started and left to the engine. */
  const turn = oneTurnAtATime(async (stillCurrent) => {
    const declared = platform.steps.declaredWorkflows();
    for (const d of declared) {
      if (d.pending === undefined) continue;
      const work = await Effect.runPromise(d.pending());
      await Effect.runPromise(platform.tasks.recordListing(d.name, work));
    }
    const limits = await Effect.runPromise(platform.storage.budgets.limitsOf(WORKFLOW));
    const going = await Effect.runPromise(platform.storage.engine.runningRuns(WORKFLOW));
    const plans = planRunStarts({
      declared,
      limitsOf: () => limits ?? { agents: 0, runs: null },
      runningRuns: () => going,
    });
    for (const p of plans) {
      for (let i = 0; i < p.start; i++) {
        if (!stillCurrent()) return;
        const run = newRunId();
        try {
          await runtime.runPromise(Effect.timeout(Effect.asVoid(p.declaration.start(run)), `${START_LIMIT_SECONDS} seconds`));
          console.log(`[keep running] ${p.declaration.name}: started run ${run}`);
        } catch (e) {
          console.error(`[keep running] ${p.declaration.name}: run ${run} did not start: ${describeFailure(e)}`);
        }
      }
    }
  }, TURN_LIMIT_MS);
  const kick = () => { void turn().catch((e: unknown) => console.error(`[keep running] ${describeFailure(e)}`)); };
  platform.steps.onRunEnded(kick);

  return { platform, intake, runtime, turn, kick };
};

/** What the live modules need beyond the service's configuration: the `claude` CLI, and skill-sync's synced list. */
export interface LiveInputs {
  readonly claudeCommand: string;
  readonly syncedSkills: SyncedSkills;
}

/** The live modules the workflow's steps call: Jev, the generative model and the synced skills. */
export const liveModules = (config: ServiceConfig, live: LiveInputs): Layer.Layer<Jev | Writer | SkillFiles> => Layer.mergeAll(
  JevLive({ apiKey: config.typesafeApiKey, model: config.jevModel }),
  WriterLive({ claudeCommand: live.claudeCommand, claudeConfigDir: config.claudeConfigDir, model: config.writerModel, scratch: runFolder(config.folders, 'writer-scratch') }),
  SkillFilesLive({ root: config.folders.skills, syncedSkills: live.syncedSkills }),
);

/** The phase this machine's one workflow is shown under: the platform groups workflows by phase. */
const PHASES = ['skills'] as const;
/** The window of each workflow's figures, as the platform's dashboard states it. */
const FIGURES_HOURS = 24;
/** A runner whose heartbeat is older than this is gone, whatever its process does now. */
const RUNNER_HEARTBEAT_STALE_MS = 60_000;

/** The running workflow, as the daemon uses it. */
export interface SkillRefinementRunner {
  /** The dashboard's data, all of it read at the call. */
  readonly pageData: () => Promise<RefinementPageData>;
  /** Sets one limit of the workflow and has its runs act on it at once. A whole number of 0 or more; none, for runs only, is its default. */
  readonly setLimit: (r: LimitChange) => Promise<void>;
  /** Hands one feedback item to the workflow, in this machine's copy of the skill; gives its id. */
  readonly addFeedback: (r: { readonly slug: string; readonly text: string }) => Promise<string>;
}

/** Why this machine runs no workflow, in a line for the daemon's log and the dashboard. */
export type NotRunning = { readonly notRunning: string };

/**
 * Another live process running this workflow on the same engine database: the runner a machine had before the daemon
 * took the work over (`skill-refinement.service`), or a copy started by hand. Read from the engine's own runner
 * registrations, each named `<host>:<pid>` and heartbeating while it lives.
 */
export const otherLiveRunner = (folders: WorkflowFolders, now: number): string | null => {
  const file = engineDatabase(folders);
  if (!fs.existsSync(file)) return null;
  const db = new Database(file, { readonly: true });
  try {
    if (db.query(`SELECT 1 FROM sqlite_master WHERE name = 'cluster_runners'`).get() === null) return null;
    const rows = db.query('SELECT address, last_heartbeat FROM cluster_runners').all() as ReadonlyArray<{ address: string; last_heartbeat: string }>;
    for (const row of rows) {
      const pid = Number(row.address.split(':').pop());
      const beat = Date.parse(`${row.last_heartbeat.replace(' ', 'T')}Z`);
      if (!Number.isInteger(pid) || pid === process.pid || Number.isNaN(beat) || now - beat > RUNNER_HEARTBEAT_STALE_MS) continue;
      try {
        process.kill(pid, 0);
        return `process ${pid} runs it (heartbeat ${new Date(beat).toISOString()})`;
      } catch {
        // Gone: its row is left from before.
      }
    }
    return null;
  } finally {
    db.close();
  }
};

/**
 * Starts the workflow on this machine's copy of the skill, once no other process runs it. Waits, checking every minute,
 * while one does, so the runner a machine had before hands over by stopping. Gives the runner, or why there is none.
 */
export const startSkillRefinement = async (input: {
  readonly home: string;
  readonly claudeCommand: string | undefined;
  readonly syncedSkills: SyncedSkills;
  /** Called once the runner is up, and again with why whenever it is waiting or cannot run. */
  readonly onState: (state: SkillRefinementRunner | NotRunning) => void;
}): Promise<void> => {
  const copy = locateSkillCopy({ home: input.home, claudeConfigDir: process.env.SKILL_REFINEMENT_CLAUDE_CONFIG_DIR });
  if (copy === null) return input.onState({ notRunning: 'this machine has no copy of the autonomous-skill-refinement skill' });
  if (input.claudeCommand === undefined) return input.onState({ notRunning: 'no `claude` CLI was found on this machine for the drafting and A/B steps' });
  let waitingFor = '';
  for (;;) {
    const other = otherLiveRunner(copy.folders, Date.now());
    if (other === null) break;
    if (other !== waitingFor) input.onState({ notRunning: `waiting to take over: ${other}` });
    waitingFor = other;
    await Bun.sleep(60_000);
  }
  const config: ServiceConfig = {
    folders: copy.folders,
    typesafeApiKey: () => process.env.TYPESAFE_API_KEY ?? (fs.existsSync(copy.jevKeyFile) ? fs.readFileSync(copy.jevKeyFile, 'utf8').trim() : ''),
    jevModel: 'jev-latest',
    claudeConfigDir: process.env.SKILL_REFINEMENT_CLAUDE_CONFIG_DIR ?? copy.accountFolder,
    writerModel: 'claude-opus-5-5',
    opusJudgeGrades: OPUS_JUDGE_ORIGINAL.grades,
    opusActionJudgeGrades: OPUS_ACTION_JUDGE_ORIGINAL.grades,
    intakes: machineIntakeFolders({ home: input.home, own: copy.folders }),
  };
  const service = makeService(config, liveModules(config, { claudeCommand: input.claudeCommand, syncedSkills: input.syncedSkills }));
  console.log(`[skill refinement] working from ${copy.skillFolder}; Jev key ${config.typesafeApiKey().length > 0 ? 'set' : 'NOT set: Classify fails until it is'}; generative calls on ${config.claudeConfigDir} with ${input.claudeCommand}`);
  // The engine starts with the runtime; resumed runs continue from their records.
  await service.runtime.runPromise(Effect.void);
  for (const folder of config.intakes) fs.watch(folder, () => service.kick());
  // The key's arrival changes every task's inputs (`configFingerprint`), which no note or listing announces: the waiting Pick is woken to read them.
  fs.watch(copy.skillFolder, (_, file) => { if (file === path.basename(copy.jevKeyFile)) service.platform.wakes.wakePicksOf(WORKFLOW, 'the Jev key was set'); });
  setInterval(service.kick, KEEP_RUNNING_EVERY_SECONDS * 1000);
  service.kick();

  const { platform } = service;
  // Each queue counted when it may have changed, for the dashboard's queues over time; only the process running the workflow records them.
  platform.queueCounts.record((count) => service.runtime.runPromise(count));
  input.onState({
    pageData: async () => {
      const now = Date.now() / 1000;
      const declared = platform.steps.declaredWorkflows();
      const unfinished = await Effect.runPromise(platform.storage.engine.unfinishedRuns());
      const newest = await Effect.runPromise(platform.storage.stepRecords.newestStepRecords(unfinished.map((u) => u.run)));
      const figures: Record<string, object> = {};
      for (const d of declared) {
        const read = await Effect.runPromise(platform.figures({ workflow: d.name, now, hours: FIGURES_HOURS }));
        if (read !== null) figures[d.name] = read;
      }
      return {
        view: await Effect.runPromise(platform.view({ now, phases: PHASES })),
        runsNow: runsNow({ phases: PHASES, undefinedPhase: 'skills', declared, unfinished, newest }),
        cpu: { limit: os.cpus().length, use: null },
        figures,
      };
    },
    setLimit: async ({ workflow, limit, value }) => {
      if (!platform.steps.declaredWorkflows().some((d) => d.name === workflow)) throw new Error(`no workflow ${workflow} runs here`);
      if (value !== null && (!Number.isInteger(value) || value < 0)) throw new Error(`a limit is a whole number of 0 or more, not ${value}`);
      if (value === null && limit === 'agents') throw new Error('the agents\' limit needs a number');
      const db = new Database(platformDatabase(copy.folders));
      try {
        db.query(limit === 'runs' ? SET_WORKFLOW_RUNS_SQL : SET_WORKFLOW_BUDGET_SQL).run(workflow, value, Date.now() / 1000);
      } finally {
        db.close();
      }
      // A run past a lower limit stands down at its next agent step; a higher one starts more at once.
      platform.wakes.runPlanChanged({ workflow, source: `its ${limit === 'runs' ? 'run' : 'agents\''} limit set from the dashboard` });
      service.kick();
      console.log(`[skill refinement] ${workflow}: ${limit} limit set to ${String(value)} from the dashboard`);
    },
    addFeedback: ({ slug, text }) => Effect.runPromise(service.intake.add({ arrived: new Date(), slug, text })),
  });
};
