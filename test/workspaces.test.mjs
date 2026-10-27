import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkspace, workspaceDirectory, workspaceName, workspacePlan } from '../src/projects/workspaces.mjs';

test('projectnaam levert een veilige mapnaam op voor Mac en Windows', () => {
  assert.deepEqual(workspaceName('  Mijn HR-app  '), { name: 'Mijn HR-app', slug: 'mijn-hr-app' });
  assert.equal(workspaceName('Café administratie').slug, 'cafe-administratie');
  for (const name of ['', '../test', 'a/b', 'a\\b', 'nul', 'COM1', '💚', 'a'.repeat(81)]) assert.throws(() => workspaceName(name));
});
test('projectidentiteit wijst naar de gekozen map, weigert overschrijven en onjuiste markers', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bim-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'runs/a'), { recursive: true });
  await mkdir(join(root, 'runs/b'), { recursive: true });
  const workspace = await createWorkspace(root, 'a', 'Mijn HR-app', join(root, 'gekozen'));
  assert.equal(await workspaceDirectory(root, 'a'), workspace.directory);
  await assert.rejects(createWorkspace(root, 'b', 'Mijn HR-app', join(root, 'gekozen')), { code: 'EEXIST' });
  assert.equal(JSON.parse(await readFile(join(workspace.directory, '.bim-studio.json'))).name, 'Mijn HR-app');
  await writeFile(join(workspace.directory, '.bim-studio.json'), '{"id":"ander-project"}');
  await assert.rejects(workspaceDirectory(root, 'a'), /does not belong/);
  await rm(join(workspace.directory, '.bim-studio.json'));
  await assert.rejects(workspaceDirectory(root, 'a'));
  assert.equal(await workspaceDirectory(root, 'b'), join(root, 'runs/b/project'));
});

test('de gekozen volledige projectlocatie krijgt geen extra submap', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bim-selected-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'runs/a'), { recursive: true });
  await mkdir(join(root, 'runs/b'), { recursive: true });
  const selected = join(root, 'hr1');
  await mkdir(selected);
  const workspace = await createWorkspace(root, 'a', 'hr1', selected, true);
  assert.equal(workspace.directory, await (await import('node:fs/promises')).realpath(selected));
  assert.equal(await workspaceDirectory(root, 'a'), workspace.directory);
  await assert.rejects(createWorkspace(root, 'b', 'hr1', selected, true), { code: 'EEXIST' });
});

test('de getoonde volledige bestemming is bindend', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bim-destination-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'runs/a'), { recursive: true });
  const selected = join(root, 'andere-mapnaam'); await mkdir(selected);
  const plan = await workspacePlan('HR3', selected, true);
  assert.ok(plan.directory.endsWith('/andere-mapnaam'));
  await assert.rejects(createWorkspace(root, 'a', 'HR3', selected, true, join(selected, 'hr3')), { code: 'LOCATION_CHANGED' });
  const workspace = await createWorkspace(root, 'a', 'HR3', selected, true, plan.directory);
  assert.equal(workspace.directory, plan.directory);
});

test('een nieuwe volledige bestemming onder bim-tests wordt exact aangemaakt', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bim-new-destination-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'runs/a'), { recursive: true });
  await mkdir(join(root, 'bim-tests'));
  const target = join(root, 'bim-tests/hr5');
  const plan = await workspacePlan('HR5', target, true);
  const result = await createWorkspace(root, 'a', 'HR5', target, true, plan.directory);
  assert.equal(result.directory, plan.directory);
  assert.ok(result.directory.endsWith('/bim-tests/hr5'));
  await assert.rejects(readFile(join(target, 'hr5/.bim-studio.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(root, 'hr5/.bim-studio.json')), { code: 'ENOENT' });
});
