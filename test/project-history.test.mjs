import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportProjectHistory } from '../src/projects/project-history.mjs';

test('projecthistorie bevat prompts, antwoorden en fouten, filtert sleutel en weigert symlinks', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bim-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'); await mkdir(project);
  await writeFile(join(root, 'antwoord-1.md'), 'Antwoord met geheime-sleutel');
  const summary = { model: 'testmodel', history: [{ modelCall: 1, at: 'vandaag', prompt: 'Bouw HR', model:'eerste-model',format:'edits',sourceCharacters:1234 }, { modelCall: 2, at: 'morgen', prompt: 'Wijzig HR' }], rounds: [{ startedAt: 'vandaag', status: 'passed' }, { startedAt: 'morgen', status: 'failed', error: 'Timeout' }] };
  await exportProjectHistory(project, root, summary, ['geheime-sleutel']);
  const text = await readFile(join(project, 'PROMPTS.md'), 'utf8');
  for (const expected of ['Bouw HR', 'Wijzig HR', 'Antwoord met', 'Timeout', 'No model response saved yet.','eerste-model',"targeted patches",'1234']) assert.ok(text.includes(expected));
  assert.ok(!text.includes('geheime-sleutel'));
  await rm(join(project, 'PROMPTS.md'));
  await symlink(join(root, 'antwoord-1.md'), join(project, 'PROMPTS.md'));
  await assert.rejects(exportProjectHistory(project, root, summary));
});
