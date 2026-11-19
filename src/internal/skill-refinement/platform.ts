/**
 * THIS WORKFLOW ON THE WORKFLOW PLATFORM (`@jive-sh/workflow-platform`): the facts the platform cannot know about skill
 * maintenance, and where its records live. Every step of the workflow is defined, measured and queued by the platform
 * through this one instance.
 */
import { createWorkflowPlatform, sqliteStorage, type ProcessIdentity, type RunLightNow } from '@jive-sh/workflow-platform';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CODE_ROOT, engineDatabase, platformDatabase, textsFolder, type WorkflowFolders } from './paths';

const runLightNow: RunLightNow = (command, options) => {
  const r = Bun.spawnSync([...command], { stdout: 'pipe', stderr: 'pipe', ...(options?.env === undefined ? {} : { env: { ...process.env, ...options.env } }) });
  return { code: r.exitCode, stdout: r.stdout.toString(), stdoutBytes: new Uint8Array(r.stdout), stderr: r.stderr.toString() };
};

/** When a process started, in unix seconds, as `ps` reports it; none for a process that is gone. */
const startedAtOf = (pid: number): number | null => {
  const r = runLightNow(['ps', '-o', 'lstart=', '-p', String(pid)]);
  const at = Date.parse(r.stdout.trim());
  return r.code === 0 && !Number.isNaN(at) ? Math.floor(at / 1000) : null;
};

let self: ProcessIdentity | null = null;
const thisProcess = (): ProcessIdentity => {
  self ??= { pid: process.pid, startedAt: startedAtOf(process.pid) ?? Math.floor(Date.now() / 1000) };
  return self;
};
const isAlive = (p: ProcessIdentity): boolean => startedAtOf(p.pid) === p.startedAt;

/** Texts by content hash, one file each: what a task note's change names. */
const textStore = (folder: string) => ({
  write: (text: string) => {
    const sha = new Bun.CryptoHasher('sha256').update(text).digest('hex');
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, sha);
    if (!fs.existsSync(file)) fs.writeFileSync(file, text);
    return sha;
  },
  read: (sha: string) => {
    const text = fs.readFileSync(path.join(folder, sha), 'utf8');
    if (new Bun.CryptoHasher('sha256').update(text).digest('hex') !== sha) throw new Error(`text ${sha} does not match its hash`);
    return text;
  },
});

export const skillRefinementPlatform = (folders: WorkflowFolders) => {
  fs.mkdirSync(folders.local, { recursive: true });
  return createWorkflowPlatform<'skills', never>({
    project: {
      sourceRoot: CODE_ROOT,
      // No agent step here has tools, so none edits a file: the skills folder is only where a step's changed files would be read from.
      tree: { root: folders.skills, snapshots: path.join(folders.local, 'step-files'), notTree: [] },
      texts: textStore(textsFolder(folders)),
      runLightNow,
      processes: { thisProcess, isAlive },
      stepRecordVariable: 'SKILL_REFINEMENT_STEP_RECORD',
      isTransientFailure: (e) => String(e).includes('database is locked'),
      // No CPU pool: every step here waits on a model, not on this machine.
      cpu: { limit: () => os.cpus().length, newestUse: () => null },
    },
    storage: sqliteStorage({
      stepRecordsFile: () => platformDatabase(folders),
      engineFile: () => engineDatabase(folders),
      budgetsFile: () => platformDatabase(folders),
      processes: { thisProcess, isAlive },
    }),
    rules: { urgent: () => false },
  });
};

export type SkillRefinementPlatform = ReturnType<typeof skillRefinementPlatform>;
