/**
 * WHERE THE WORKFLOW'S FILES ARE: the `autonomous-skill-refinement` skill's copies on this machine (each agent account's
 * skills folder holds one), the one whose `.local/` holds this machine's data, the synced skills folder around it, and the
 * code itself. The daemon locates them once at start (`locateSkillCopy`); a test passes its own folders.
 */
import fs from 'node:fs';
import path from 'node:path';

/** The skill this workflow serves, whose folder holds its rules, its Jev key and this machine's data. */
export const OWNING_SKILL_FOLDER = 'autonomous-skill-refinement';
/** The workflow's code, which step records link their definitions to. */
export const CODE_ROOT = import.meta.dir;

/** Where one machine keeps the workflow's data, and the skills folder it edits. */
export interface WorkflowFolders {
  /**
   * The workflow's databases, intake and run files. Named with a leading dot: skill-sync's file listing skips such names,
   * so this machine's live databases are never copied between machines (as the evals' `.results` already is).
   */
  readonly local: string;
  /** The synced skills folder the workflow reads and installs into. */
  readonly skills: string;
}

/** The copy of the skill this machine's runner works from, and what is read from it. */
export interface SkillCopy {
  readonly skillFolder: string;
  readonly folders: WorkflowFolders;
  /** Jev's API key, where Alex puts it: the skill folder, synced with everything else in it. */
  readonly jevKeyFile: string;
  /** The Claude Code config folder holding the copy: the account the generative calls run on unless one is set. */
  readonly accountFolder: string;
}

const copyAt = (skillFolder: string): SkillCopy => ({
  skillFolder,
  folders: { local: path.join(skillFolder, '.local'), skills: path.dirname(skillFolder) },
  jevKeyFile: path.join(skillFolder, 'typesafe-api-key'),
  accountFolder: path.dirname(path.dirname(skillFolder)),
});

/** Every copy of the skill in a dot-folder of `home` (`~/.claude-alex/skills/…`, `~/.grok/skills/…`), by folder name. */
export const skillCopies = (home: string): ReadonlyArray<string> => fs.readdirSync(home)
  .filter((d) => d.startsWith('.'))
  .sort()
  .map((d) => path.join(home, d, 'skills', OWNING_SKILL_FOLDER))
  .filter((d) => fs.existsSync(path.join(d, 'SKILL.md')));

/**
 * The copy this machine's runner works from: the one in `claudeConfigDir` when one is set; else the one whose `.local/`
 * already holds the workflow's database, so a machine keeps its queue and records; else the first Claude account's copy.
 * None when the machine has no copy of the skill.
 */
export const locateSkillCopy = (input: { readonly home: string; readonly claudeConfigDir: string | undefined }): SkillCopy | null => {
  if (input.claudeConfigDir !== undefined) {
    const set = path.join(input.claudeConfigDir, 'skills', OWNING_SKILL_FOLDER);
    return fs.existsSync(path.join(set, 'SKILL.md')) ? copyAt(set) : null;
  }
  const copies = skillCopies(input.home);
  const withData = copies.find((d) => fs.existsSync(platformDatabase(copyAt(d).folders)));
  const claude = copies.find((d) => /^\.claude(-|$)/.test(path.basename(path.dirname(path.dirname(d)))));
  const chosen = withData ?? claude ?? copies[0];
  return chosen === undefined ? null : copyAt(chosen);
};

/** One file per feedback item handed to the workflow, named by the item's id. */
export const intakeFolder = (f: WorkflowFolders) => path.join(f.local, 'intake');
/**
 * Every intake on this machine: one per copy of this skill, since each agent account's skills folder holds its own copy
 * and an agent hands feedback to the copy it loaded. The one runner a machine has reads them all.
 */
export const machineIntakeFolders = (input: { readonly home: string; readonly own: WorkflowFolders }): ReadonlyArray<string> => {
  const copies = skillCopies(input.home).map((d) => path.join(d, '.local', 'intake')).filter((d) => fs.existsSync(d));
  return [...new Set([intakeFolder(input.own), ...copies])];
};
/** One file per item the workflow installed a change for; its presence takes the item off the list. */
export const installedFolder = (f: WorkflowFolders) => path.join(f.local, 'installed');
/** Each run's texts too big for a record (drafts, replies, verdicts), one folder per run. */
export const runFolder = (f: WorkflowFolders, run: string) => path.join(f.local, 'runs', run);
/** The platform's database: step records, tasks, input runs, the two limits per workflow. */
export const platformDatabase = (f: WorkflowFolders) => path.join(f.local, 'skill-refinement.db');
/** The workflow engine's own database (effect/cluster's `cluster_*` tables). */
export const engineDatabase = (f: WorkflowFolders) => path.join(f.local, 'skill-refinement-engine.db');
/** Texts stored by their content hash, for task notes (the platform's `TextStore`). */
export const textsFolder = (f: WorkflowFolders) => path.join(f.local, 'texts');
/** The A/B examples every skill change is tested on. */
export const evalCasesFolder = (f: WorkflowFolders) => path.join(f.skills, 'agentic-collaboration', 'evals', 'cases');
