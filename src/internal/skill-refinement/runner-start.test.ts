/**
 * Which copy of the skill a machine's runner works from, and the hand-over from a runner already going on the same data.
 */
import { afterAll, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { engineDatabase, locateSkillCopy, platformDatabase } from './paths';
import { otherLiveRunner } from './service';

const root = path.join(import.meta.dir, '../../../.synctest', `runner-start-${Date.now().toString(36)}`);
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

/** A home with the skill in each named account folder; `withData` names the one whose `.local/` holds a database. */
const homeWith = (name: string, accounts: ReadonlyArray<string>, withData?: string) => {
  const home = path.join(root, name);
  fs.mkdirSync(home, { recursive: true });
  for (const account of accounts) {
    const skill = path.join(home, account, 'skills', 'autonomous-skill-refinement');
    fs.mkdirSync(path.join(skill, '.local'), { recursive: true });
    fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: autonomous-skill-refinement\n---\n');
    if (account === withData) fs.writeFileSync(path.join(skill, '.local', 'skill-refinement.db'), '');
  }
  return home;
};

test.each([
  { name: 'the copy that already holds the data', accounts: ['.claude', '.claude-alex', '.grok'], withData: '.claude-alex', chosen: '.claude-alex' },
  { name: 'the first Claude account when none holds data', accounts: ['.agents', '.claude-work', '.claude-alex'], withData: undefined, chosen: '.claude-alex' },
  { name: 'any copy when no Claude account has one', accounts: ['.grok'], withData: undefined, chosen: '.grok' },
])('the runner works from $name', ({ name, accounts, withData, chosen }) => {
  const home = homeWith(name, accounts, withData);
  const copy = locateSkillCopy({ home, claudeConfigDir: undefined });
  expect(copy?.accountFolder).toBe(path.join(home, chosen));
  expect(copy?.folders.local).toBe(path.join(home, chosen, 'skills', 'autonomous-skill-refinement', '.local'));
  expect(copy?.folders.skills).toBe(path.join(home, chosen, 'skills'));
});

test('a set account folder decides the copy, and one without the skill means no runner', () => {
  const home = homeWith('set', ['.claude', '.claude-alex'], '.claude');
  expect(locateSkillCopy({ home, claudeConfigDir: path.join(home, '.claude-alex') })?.accountFolder).toBe(path.join(home, '.claude-alex'));
  expect(locateSkillCopy({ home, claudeConfigDir: path.join(home, '.claude-none') })).toBeNull();
  expect(locateSkillCopy({ home: homeWith('none', []), claudeConfigDir: undefined })).toBeNull();
});

test('a live runner heartbeating on the same engine database holds the work; a stale or dead one does not', () => {
  const home = homeWith('runners', ['.claude']);
  const folders = locateSkillCopy({ home, claudeConfigDir: undefined })!.folders;
  const now = Date.parse('2026-11-17T11:00:00Z');
  const beat = (at: number) => new Date(at).toISOString().replace('T', ' ').slice(0, 19);
  expect(otherLiveRunner(folders, now)).toBeNull();
  const db = new Database(engineDatabase(folders), { create: true });
  db.run('CREATE TABLE cluster_runners (machine_id INTEGER PRIMARY KEY, address TEXT, runner TEXT, healthy INTEGER, last_heartbeat TEXT)');
  // This test process is alive; a pid this large is not.
  const insert = db.query('INSERT INTO cluster_runners (address, runner, healthy, last_heartbeat) VALUES (?, \'{}\', 1, ?)');
  insert.run('skill-refinement:4194000', beat(now - 5_000));
  insert.run(`skill-refinement:${process.ppid}`, beat(now - 120_000));
  db.close();
  expect(otherLiveRunner(folders, now)).toBeNull();
  const live = new Database(engineDatabase(folders));
  live.query('INSERT INTO cluster_runners (address, runner, healthy, last_heartbeat) VALUES (?, \'{}\', 1, ?)').run(`skill-refinement:${process.ppid}`, beat(now - 5_000));
  live.close();
  expect(otherLiveRunner(folders, now)).toContain(`process ${process.ppid} runs it`);
  expect(fs.existsSync(platformDatabase(folders))).toBe(false);
});
