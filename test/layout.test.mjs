import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareBackend } from '../scripts/prepare-desktop.mjs';
import { packageRoot, runPath } from '../src/paths.mjs';

test('desktop backend retains resource paths and builds a project outside the checkout', { timeout: 30000 }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'bim-bundle-layout-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const backend = join(directory, 'backend');
  await prepareBackend({ root: packageRoot, backend });
  const load = path => import(pathToFileURL(join(backend, path)));
  const paths = await load('src/paths.mjs');
  assert.equal(paths.packageRoot, backend);
  assert.equal(paths.runPath(directory, 'fixture'), join(directory, 'runs/fixture'));
  assert.equal(runPath(packageRoot, 'fixture'), join(packageRoot, '.local/runs/fixture'));
  assert.equal((await readFile(paths.acceptanceFile, 'utf8')).match(/^test\(['"]/gm).length, 18);
  assert.ok((await readFile(join(paths.specsDirectory, 'project/system.txt'), 'utf8')).length > 0);
  const { parseJsx } = await load('src/parsing/source-parser.mjs');
  assert.ok(await parseJsx('export default function App(){return <h1>Build Labs</h1>}'));
  const { scaffold } = await load('src/projects/project-files.mjs');
  const { buildProject, runtimeDirectory } = await load('src/build/project-build.mjs');
  const project = join(directory, 'project');
  await scaffold(project, runtimeDirectory);
  if (process.platform === 'darwin') {
    const result = await buildProject(project);
    assert.equal(result.passed, true, result.output);
  }
  const { createClientServer } = await load('src/server/ui-server.mjs');
  const server = createClientServer({ root: directory, desktopToken: 'fixture-token' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/status`, {
    headers: { Authorization: 'Bearer fixture-token' },
  });
  assert.equal(response.status, 200);
  assert.ok((await response.json()).starterPrompt.length > 0);
});
