/**
 * THE INTAKE: every feedback item handed to the workflow, one file each, named `<arrived>-<slug>.md` so the folder's order
 * is the order they arrived in. An item is on the workflow's list until an install record names it (`installed/`).
 *
 * An item's file holds Alex's exact words and what drew them, as the agent that received the feedback wrote them
 * (`agentic-collaboration` section 1). The workflow never edits it. Items are read from every copy of the skill on the
 * machine (`machineIntakeFolders`) and added to the copy the adding agent loaded.
 */
import { Data, Effect } from 'effect';
import fs from 'node:fs';
import path from 'node:path';

export class IntakeError extends Data.TaggedError('IntakeError')<{ readonly reason: string }> {}

const attempt = <A>(what: string, f: () => A) => Effect.try({ try: f, catch: (e) => new IntakeError({ reason: `${what}: ${e instanceof Error ? e.message : String(e)}` }) });

/** An item's id from when it arrived and a few words naming it: sortable, and safe as a file name. Pure. */
export const itemId = (input: { readonly arrived: Date; readonly slug: string }): string => {
  const at = input.arrived.toISOString().slice(0, 19).replace(/:/g, '-');
  const slug = input.slug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  if (slug.length === 0) throw new Error('an item needs a few words naming it');
  return `${at}-${slug}`;
};

export const makeIntake = (folders: {
  /** Where `add` writes: the intake of the copy the adding agent loaded. */
  readonly intake: string;
  /** Every intake the items are read from; includes `intake`. */
  readonly intakes: ReadonlyArray<string>;
  readonly installed: string;
}) => {
  /** Adds an item; adding the same id again is refused, so an item is never handed over twice under one name. */
  const add = (input: { readonly arrived: Date; readonly slug: string; readonly text: string }) => attempt('the item could not be added', () => {
    const id = itemId(input);
    fs.mkdirSync(folders.intake, { recursive: true });
    fs.writeFileSync(path.join(folders.intake, `${id}.md`), input.text, { flag: 'wx' });
    return id;
  });

  const ids = (folder: string) => (fs.existsSync(folder) ? fs.readdirSync(folder).filter((f) => !f.startsWith('.')).map((f) => f.replace(/\.(md|json)$/, '')) : []);

  /** The file holding an item, in whichever intake it was added to. */
  const fileOf = (id: string) => folders.intakes.map((d) => path.join(d, `${id}.md`)).find((f) => fs.existsSync(f));

  /** The items still to do, oldest first: in an intake, with no install record. */
  const open = () => attempt('the intake could not be read', () => {
    const installed = new Set(ids(folders.installed));
    return [...new Set(folders.intakes.flatMap(ids))].filter((id) => !installed.has(id)).sort();
  });

  const text = (id: string) => attempt(`item ${id} could not be read`, () => {
    const file = fileOf(id);
    if (file === undefined) throw new Error(`no intake holds ${id}`);
    return fs.readFileSync(file, 'utf8');
  });

  /** Records what was installed for an item, which takes it off the list. */
  const recordInstalled = (id: string, record: unknown) => attempt(`the install of ${id} could not be recorded`, () => {
    fs.mkdirSync(folders.installed, { recursive: true });
    fs.writeFileSync(path.join(folders.installed, `${id}.json`), JSON.stringify(record, null, 1));
  });

  return { add, open, text, recordInstalled };
};

export type Intake = ReturnType<typeof makeIntake>;
