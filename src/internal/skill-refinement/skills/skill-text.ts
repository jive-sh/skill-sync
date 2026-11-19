/**
 * THE SYNCED SKILLS AS THIS WORKFLOW READS AND CHANGES THEM: each skill's text and its sections, its example names, and
 * the one write that installs a change. skill-sync copies whatever is installed here to every machine; this module only
 * reads skill-sync's synced list (`SyncedSkills`), before an install and after it.
 */
import { Context, Data, Effect, Layer, Result } from 'effect';
import type { ListedSkill } from '../../wire';
import fs from 'node:fs';
import path from 'node:path';

/** One `##` or `###` section of a skill, by the label a classifier chooses it by. */
export interface SkillSection {
  readonly skill: string;
  /** `skill § heading › subheading`, unique across the skills. */
  readonly label: string;
  readonly text: string;
}

/** A skill's whole text, and the hash it had when read, so an install never overwrites a change made since. */
export interface SkillText {
  readonly skill: string;
  readonly text: string;
  readonly sha: string;
}

/** One exact replacement in a skill's text: `find` must occur in it exactly once. */
export interface SkillEdit {
  readonly find: string;
  readonly replace: string;
}

/** What an install wrote, for its record. */
export interface Installed {
  readonly skill: string;
  readonly beforeSha: string;
  readonly afterSha: string;
  readonly wordsBefore: number;
  readonly wordsAfter: number;
  readonly files: ReadonlyArray<string>;
}

export class SkillFilesError extends Data.TaggedError('SkillFilesError')<{ readonly reason: string }> {}

export const shaOf = (text: string): string => new Bun.CryptoHasher('sha256').update(text).digest('hex');
const words = (text: string): number => text.split(/\s+/).filter(Boolean).length;

/** A skill's sections: each `##` heading, and each `###` under it as `heading › subheading`. Pure. */
export const sectionsOf = (skill: string, text: string): ReadonlyArray<SkillSection> => {
  const out: Array<{ label: string; lines: string[] }> = [];
  let h2: string | null = null;
  for (const line of text.split('\n')) {
    const two = /^## (.+)$/.exec(line);
    const three = /^### (.+)$/.exec(line);
    if (two !== null) { h2 = two[1]!.trim(); out.push({ label: `${skill} § ${h2}`, lines: [] }); continue; }
    if (three !== null) { out.push({ label: `${skill} § ${h2 ?? '(top)'} › ${three[1]!.trim()}`, lines: [] }); continue; }
    out[out.length - 1]?.lines.push(line);
  }
  return out.map((s) => ({ skill, label: s.label, text: s.lines.join('\n').trim() })).filter((s) => s.text.length > 0);
};

/** A skill's length against the cap it states for itself ("**Cap: 200 lines.**"); none for a skill that states none. Pure. */
export const lineBudgetOf = (text: string): { readonly lines: number; readonly cap: number } | null => {
  const cap = /\*\*Cap: (\d+) lines\.\*\*/.exec(text);
  return cap === null ? null : { lines: text.split('\n').length - (text.endsWith('\n') ? 1 : 0), cap: Number(cap[1]) };
};

/** Applies each edit to `text`, refusing one whose `find` is missing or occurs more than once, or a result over the skill's own stated cap. Pure. */
export const applyEdits = (text: string, edits: ReadonlyArray<SkillEdit>): Result.Result<string, string> => {
  let out = text;
  for (const [i, e] of edits.entries()) {
    const first = out.indexOf(e.find);
    if (e.find.length === 0 || first < 0) return Result.fail(`edit ${i + 1}'s text to replace is not in the skill: ${e.find.slice(0, 120)}`);
    if (out.indexOf(e.find, first + 1) >= 0) return Result.fail(`edit ${i + 1}'s text to replace occurs more than once: ${e.find.slice(0, 120)}`);
    out = out.slice(0, first) + e.replace + out.slice(first + e.find.length);
  }
  const budget = lineBudgetOf(out);
  if (budget !== null && budget.lines > budget.cap) return Result.fail(`the skill would have ${budget.lines} lines, over its own cap of ${budget.cap}`);
  return Result.succeed(out);
};

/**
 * One hash of every synced skill's text: what Classify and Draft read, so an item parked on its last outcome runs again
 * once a skill it may draft on has changed (an install, or another machine's edit pulled).
 */
export const skillsTextSha = (root: string): string => shaOf(fs.readdirSync(root)
  .filter((d) => !d.startsWith('.') && fs.existsSync(path.join(root, d, 'SKILL.md')))
  .sort()
  .map((d) => `${d}\n${fs.readFileSync(path.join(root, d, 'SKILL.md'), 'utf8')}`)
  .join('\n'));

export interface ISkillFiles {
  /** Every synced skill's sections. */
  readonly sections: () => Effect.fn.Return<ReadonlyArray<SkillSection>, SkillFilesError>;
  readonly skillText: (skill: string) => Effect.fn.Return<SkillText, SkillFilesError>;
  /** The names of a skill's example files (`examples/*.md`), which name their topics. */
  readonly exampleNames: (skill: string) => Effect.fn.Return<ReadonlyArray<string>, SkillFilesError>;
  /**
   * Installs a change: the skill's new text, written only if the skill still has the text it was drafted on and this
   * copy holds the skill's latest synced edit, then its history entry, its example file and its A/B case. skill-sync keeps
   * the later of two edits to a file and drops the other, so an install on a copy that has not pulled another machine's
   * edit would overwrite that edit everywhere.
   */
  readonly install: (input: {
    readonly skill: string;
    readonly draftedOn: string;
    readonly newText: string;
    readonly history: string;
    readonly example: { readonly name: string; readonly text: string };
    readonly evalCase: { readonly file: string; readonly json: string };
  }) => Effect.fn.Return<Installed, SkillFilesError>;
  /**
   * Waits until skill-sync's server lists the skill edited at or after `since` (unix ms), which means every machine pulls
   * the installed text, and checks the copy still holds `afterSha` (another machine's later edit would have replaced it);
   * gives the synced list's line for it.
   */
  readonly confirmSynced: (input: { readonly skill: string; readonly since: number; readonly afterSha: string }) => Effect.fn.Return<string, SkillFilesError>;
}

export class SkillFiles extends Context.Service<SkillFiles, ISkillFiles>()('SkillFiles') {}

const attempt = <A>(what: string, f: () => A) => Effect.try({ try: f, catch: (e) => new SkillFilesError({ reason: `${what}: ${e instanceof Error ? e.message : String(e)}` }) });

class SkillFolder implements ISkillFiles {
  constructor(private readonly root: string, private readonly syncedSkills: SyncedSkills) {}

  private *syncedEdit(skill: string): Effect.fn.Return<SyncedEdit | null, SkillFilesError> {
    const skills = yield* Effect.tryPromise({ try: this.syncedSkills, catch: (e) => new SkillFilesError({ reason: `the synced list could not be read: ${e instanceof Error ? e.message : String(e)}` }) });
    return syncedEditOf(skills, skill);
  }

  *sections(): Effect.fn.Return<ReadonlyArray<SkillSection>, SkillFilesError> {
    const skills = yield* attempt('the skills folder could not be listed', () =>
      fs.readdirSync(this.root).filter((d) => !d.startsWith('.') && fs.existsSync(path.join(this.root, d, 'SKILL.md'))).sort());
    const out: SkillSection[] = [];
    for (const skill of skills) out.push(...sectionsOf(skill, (yield* this.skillText(skill)).text));
    return out;
  }

  *skillText(skill: string): Effect.fn.Return<SkillText, SkillFilesError> {
    const text = yield* attempt(`skill ${skill} could not be read`, () => fs.readFileSync(path.join(this.root, skill, 'SKILL.md'), 'utf8'));
    return { skill, text, sha: shaOf(text) };
  }

  *exampleNames(skill: string): Effect.fn.Return<ReadonlyArray<string>, SkillFilesError> {
    const dir = path.join(this.root, skill, 'examples');
    return yield* attempt(`skill ${skill}'s examples could not be listed`, () => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort() : []));
  }

  *install(input: Parameters<ISkillFiles['install']>[0]): Effect.fn.Return<Installed, SkillFilesError> {
    const before = yield* this.skillText(input.skill);
    if (before.sha !== input.draftedOn) return yield* Effect.fail(new SkillFilesError({ reason: `skill ${input.skill} changed since the candidate was drafted on it; the next run drafts on its new text` }));
    const dir = path.join(this.root, input.skill);
    const synced = yield* this.syncedEdit(input.skill);
    const pulled = yield* attempt(`skill ${input.skill}'s files could not be listed`, () => newestEdit(dir));
    // A pulled file takes the server's edit time, so a server edit later than every file here has not been pulled yet.
    if (synced !== null && Math.floor(synced.at / 1000) > Math.floor(pulled / 1000)) return yield* Effect.fail(new SkillFilesError({ reason: `skill ${input.skill} has a synced edit from ${synced.machine} at ${new Date(synced.at).toISOString()} that this copy has not pulled yet; the next run drafts on it` }));
    const skillFile = path.join(dir, 'SKILL.md');
    const historyFile = path.join(dir, 'history.md');
    const exampleFile = path.join(dir, 'examples', input.example.name);
    const caseFile = path.join(this.root, 'agentic-collaboration', 'evals', 'cases', input.evalCase.file);
    yield* attempt('the change could not be written', () => {
      if (fs.existsSync(exampleFile)) throw new Error(`example ${input.example.name} already exists`);
      if (fs.existsSync(caseFile)) throw new Error(`A/B case ${input.evalCase.file} already exists`);
      // Written beside it, then renamed over it, so no reader ever sees half a skill.
      const next = `${skillFile}.installing`;
      fs.writeFileSync(next, input.newText);
      fs.renameSync(next, skillFile);
      fs.appendFileSync(historyFile, `\n${input.history.trim()}\n`);
      fs.mkdirSync(path.dirname(exampleFile), { recursive: true });
      fs.writeFileSync(exampleFile, input.example.text);
      fs.writeFileSync(caseFile, input.evalCase.json);
    });
    return { skill: input.skill, beforeSha: before.sha, afterSha: shaOf(input.newText), wordsBefore: words(before.text), wordsAfter: words(input.newText), files: [skillFile, historyFile, exampleFile, caseFile] };
  }

  *confirmSynced(input: { readonly skill: string; readonly since: number; readonly afterSha: string }): Effect.fn.Return<string, SkillFilesError> {
    for (let tries = 0; tries < 10; tries++) {
      const synced = yield* this.syncedEdit(input.skill);
      // The list shows seconds; an edit in the same second as the install counts.
      if (synced !== null && Math.floor(synced.at / 1000) >= Math.floor(input.since / 1000)) {
        const now = (yield* this.skillText(input.skill)).sha;
        if (now !== input.afterSha) return yield* Effect.fail(new SkillFilesError({ reason: `skill ${input.skill} no longer holds the installed text: an edit from ${synced.machine} replaced it` }));
        return synced.line;
      }
      yield* Effect.sleep('15 seconds');
    }
    return yield* Effect.fail(new SkillFilesError({ reason: `the synced list never showed ${input.skill} edited after the install at ${new Date(input.since).toISOString()}` }));
  }
}

/** The synced list as skill-sync's server holds it, read by the daemon this runs in. */
export type SyncedSkills = () => Promise<ReadonlyArray<ListedSkill>>;

/** A skill's last synced edit: when (unix ms) and on which machine, and the line naming it for an install's record. */
export interface SyncedEdit {
  readonly at: number;
  readonly machine: string;
  readonly line: string;
}

/** A skill's last synced edit in the synced list; none for a skill not on it or with no files yet. Pure. */
export const syncedEditOf = (skills: ReadonlyArray<ListedSkill>, skill: string): SyncedEdit | null => {
  const listed = skills.find((s) => s.name === skill);
  if (listed === undefined || listed.editedAt === null || listed.editedBy === null) return null;
  return { at: listed.editedAt, machine: listed.editedBy, line: `${skill}: ${listed.files} files, last edited ${new Date(listed.editedAt).toISOString()} on ${listed.editedBy}` };
};

/** The latest modification time (unix ms) of any file skill-sync copies in a folder: none under a name starting with a dot. */
const newestEdit = (dir: string): number => fs.readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile() && !path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).some((part) => part.startsWith('.')))
  .reduce((latest, e) => Math.max(latest, fs.statSync(path.join(e.parentPath, e.name)).mtimeMs), 0);

export const SkillFilesLive = (input: { readonly root: string; readonly syncedSkills: SyncedSkills }) => Layer.succeed(SkillFiles, new SkillFolder(input.root, input.syncedSkills));
