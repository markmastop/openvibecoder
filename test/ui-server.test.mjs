import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { after, before, test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClientServer } from '../src/server/ui-server.mjs';
import { DEFAULT_MODEL } from './../src/models/providers.mjs';

const accountId = '0123456789abcdef0123456789abcdef';
const token = 'fixture-token-geen-echte-sleutel';
const options = { timeout: 5000, concurrency: false };
const inheritedConfiguration = {};

before(() => {
  for (const name of ['MODEL_PROVIDER', 'OPENROUTER_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN']) {
    inheritedConfiguration[name] = process.env[name];
    delete process.env[name];
  }
});

after(() => {
  for (const [name, value] of Object.entries(inheritedConfiguration)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function stubChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killSignals = [];
  child.kill = signal => {
    child.killSignals.push(signal);
    queueMicrotask(() => child.emit('close', null, signal));
    return true;
  };
  return child;
}

async function fixture(t, { beforeLaunch = async () => {}, desktopToken, usageFetch, schemaFetch } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bim-client-server-test-'));
  await mkdir(join(root, 'runs'));
  const launches = [];
  const children = [];
  const server = createClientServer({ root, desktopToken, usageFetch, schemaFetch, launch: async details => {
    launches.push(details);
    const child = stubChild();
    children.push(child);
    await beforeLaunch();
    return child;
  } });
  t.after(async () => {
    try {
      if (server.listening) {
        await new Promise((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve());
          server.closeAllConnections();
        });
      }
    } finally {
      for (const child of children) {
        child.stdout.destroy();
        child.stderr.destroy();
      }
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function request(path, { method = 'GET', body, originHeader = origin, rawBody, contentType = 'application/json' } = {}) {
    const headers = desktopToken ? { Authorization: `Bearer ${desktopToken}` } : {};
    if (originHeader !== null) headers.Origin = originHeader;
    if (body !== undefined || rawBody !== undefined) headers['Content-Type'] = contentType;
    const response = await fetch(origin + path, {
      method,
      headers,
      ...(body === undefined && rawBody === undefined ? {} : { body: rawBody ?? JSON.stringify(body) }),
    });
    const text = await response.text();
    let data;
    if (response.headers.get('Content-Type')?.startsWith('application/json')) data = JSON.parse(text);
    return { status: response.status, headers: response.headers, text, data };
  }
  async function configure() {
    const result = await request('/api/config', { method: 'POST', body: { accountId, token } });
    assert.equal(result.status, 200);
    assert.equal(result.data.configured, true);
    return result;
  }
  return { root, origin, request, configure, launches, children };
}

async function eventually(action, matches) {
  const end = Date.now() + 2000;
  let last;
  while (Date.now() < end) {
    last = await action();
    if (matches(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('De verwachte lokale statusovergang bleef uit.');
}

test('status zonder configuratie vraagt eigen modeltoegang en start geen proef', options, async t => {
  const { request, launches } = await fixture(t);
  const result = await request('/api/status');
  assert.equal(result.status, 200);
  assert.equal(result.data.configured, false);
  assert.equal(typeof result.data.configError, 'string');
  assert.equal(result.data.runState, 'idle');
  assert.equal(result.data.activeRunId, null);
  assert.deepEqual(result.data.runs, []);
  assert.equal(result.data.modelId, 'openrouter/free');
  assert.equal(result.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(launches, []);
});

test('configuratieacties vereisen een lokale Origin en weigeren vreemde oorsprong', options, async t => {
  const { request, root } = await fixture(t);
  for (const originHeader of [null, "https://unknowne-site.example", 'null', 'http://127.0.0.1:1']) {
    const result = await request('/api/config', {
      method: 'POST', originHeader, body: { accountId, token },
    });
    assert.equal(result.status, 403);
    assert.equal(typeof result.data.error, 'string');
    assert.ok(!result.text.includes(token));
  }
  await assert.rejects(stat(join(root, '.env.local')), { code: 'ENOENT' });
  assert.equal((await request('/api/status')).data.configured, false);
});

test('onjuiste configuratie en invalid JSON worden niet opgeslagen', options, async t => {
  const { request, root } = await fixture(t);
  for (const body of [
    {}, { accountId: 'te-kort', token }, { accountId: 'g'.repeat(32), token },
    { accountId, token: 'kort' }, { accountId, token: 'ongeldig token met spatie' },
    { accountId: 42, token }, { accountId, token: null },
  ]) {
    const result = await request('/api/config', { method: 'POST', body });
    assert.equal(result.status, 400);
    assert.equal(typeof result.data.error, 'string');
  }
  assert.equal((await request('/api/config', { method: 'POST', rawBody: '{' })).status, 400);
  assert.equal((await request('/api/config', {
    method: 'POST', body: { accountId, token }, contentType: 'text/plain',
  })).status, 400);
  await assert.rejects(stat(join(root, '.env.local')), { code: 'ENOENT' });
});

test('geldige configuratie wordt privé opgeslagen en verschijnt niet in antwoorden', options, async t => {
  const { request, configure, root } = await fixture(t);
  const configured = await configure();
  assert.ok(!configured.text.includes(token));
  assert.ok(!configured.text.includes(accountId));
  const file = join(root, '.env.local');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(await readFile(file, 'utf8'), `MODEL_PROVIDER=cloudflare\nCLOUDFLARE_ACCOUNT_ID=${accountId}\nCLOUDFLARE_API_TOKEN=${token}\n`);
  const status = await request('/api/status');
  assert.equal(status.data.configured, true);
  assert.equal(status.data.configError, null);
  assert.ok(!status.text.includes(token));
  assert.ok(!status.text.includes(accountId));
  for (const path of ['/.env.local', '/%2eenv.local']) {
    const hidden = await request(path);
    assert.equal(hidden.status, 404);
    assert.ok(!hidden.text.includes(token));
    assert.ok(!hidden.text.includes(accountId));
  }
});

test('OpenRouter werkt met alleen een sleutel en houdt betaalde modellen buiten de proef', options, async t => {
  const { request, root, launches } = await fixture(t);
  const configured = await request('/api/config', { method: 'POST', body: { provider: 'openrouter', token } });
  assert.equal(configured.status, 200);
  assert.ok(!configured.text.includes(token));
  assert.equal(await readFile(join(root, '.env.local'), 'utf8'), `MODEL_PROVIDER=openrouter\nOPENROUTER_API_KEY=${token}\n`);
  const status = await request('/api/status');
  assert.equal(status.data.configured, true);
  assert.equal(status.data.provider, 'openrouter');
  assert.equal(status.data.modelId, 'openrouter/free');
  assert.deepEqual(status.data.models, [{ id: 'openrouter/free', label: 'Free Models Router' }, { id: 'cohere/north-mini-code:free', label: "North Mini Code · free" }]);
  assert.equal((await request('/api/runs', { method: 'POST', body: { modelId: 'paid/model' } })).status, 400);
  assert.equal(launches.length, 0);
});

test('een configuratiesymlink mag geen ander lokaal bestand overschrijven', options, async t => {
  const { root, request } = await fixture(t);
  const privateFile = join(root, 'ander-bestand.json');
  await writeFile(privateFile, '{"behouden":true}');
  await symlink(privateFile, join(root, '.env.local'));
  const result = await request('/api/config', { method: 'POST', body: { accountId, token } });
  assert.equal(result.status, 400);
  assert.equal(await readFile(privateFile, 'utf8'), '{"behouden":true}');
  assert.ok(!result.text.includes(token));
});

test("ontbrekende modeltoegang en unknown model starten geen uitvoerproces", options, async t => {
  const { request, configure, launches } = await fixture(t);
  const missing = await request('/api/runs', { method: 'POST', body: { modelId: DEFAULT_MODEL } });
  assert.equal(missing.status, 400);
  await configure();
  const unknown = await request('/api/runs', { method: 'POST', body: { modelId: "niet-gratis-of-unknown" } });
  assert.equal(unknown.status, 400);
  assert.deepEqual(launches, []);
  const status = await request('/api/status');
  assert.equal(status.data.runState, 'idle');
  assert.deepEqual(status.data.runs, []);
});

test('een stubproef toont detail en logs, blokkeert overlap en kan worden gestopt', options, async t => {
  const { root, request, configure, launches, children } = await fixture(t);
  await configure();
  const started = await request('/api/runs', { method: 'POST', body: { modelId: DEFAULT_MODEL } });
  assert.equal(started.status, 202);
  const { id } = started.data;
  assert.equal(typeof id, 'string');
  assert.ok(id.length > 0);
  assert.deepEqual(launches, [{ id, modelId: DEFAULT_MODEL, root }]);
  const running = await request('/api/status');
  assert.equal(running.data.runState, 'running');
  assert.equal(running.data.activeRunId, id);
  assert.equal(running.data.activeStartedAt, started.data.startedAt);
  assert.ok(Number.isFinite(Date.parse(started.data.startedAt)));
  assert.equal((await request('/api/runs', { method: 'POST', body: {} })).status, 409);
  assert.equal((await request('/api/config', { method: 'POST', body: { accountId, token } })).status, 409);
  children[0].stdout.write('Fictieve modelvoortgang\n');
  children[0].stderr.write('Fictieve procesmelding\n');
  const detail = await request(`/api/runs/${id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.summary.id, id);
  assert.equal(detail.data.summary.model, DEFAULT_MODEL);
  assert.equal(detail.data.summary.status, 'queued');
  assert.equal(detail.data.summary.lastStartedAt, started.data.startedAt);
  assert.deepEqual(detail.data.summary.rounds, []);
  assert.match(detail.data.log, /Fictieve modelvoortgang/);
  assert.match(detail.data.log, /Fictieve procesmelding/);
  assert.ok(detail.data.files.some(file => file.path === 'summary.json'));
  assert.ok(!detail.text.includes(token));
  const stop = await request(`/api/runs/${id}/stop`, { method: 'POST' });
  assert.equal(stop.status, 200);
  assert.equal(stop.data.stopping, true);
  assert.deepEqual(children[0].killSignals, ['SIGTERM']);
  const finished = await eventually(() => request(`/api/runs/${id}`), result => result.data?.summary?.status === 'cancelled');
  assert.equal(finished.data.summary.status, 'cancelled');
  assert.equal(typeof finished.data.summary.finishedAt, 'string');
  assert.deepEqual(finished.data.summary.rounds, []);
  assert.equal((await request('/api/status')).data.runState, 'idle');
  assert.equal((await request('/api/status')).data.activeStartedAt, null);
  assert.equal((await request('/api/runs/' + id + '/stop', { method: 'POST' })).status, 409);
  assert.equal(launches.length, 1);
});

test('een procesfout beëindigt de actieve proef zonder een geslaagd resultaat te verzinnen', options, async t => {
  const { request, configure, children } = await fixture(t);
  await configure();
  const started = await request('/api/runs', { method: 'POST', body: {} });
  assert.equal(started.status, 202);
  children[0].emit('error', new Error('Fictieve procesfout zonder modelaanroep'));
  const finished = await eventually(() => request(`/api/runs/${started.data.id}`), result => result.data?.summary?.status === 'stopped');
  assert.deepEqual(finished.data.summary.rounds, []);
  assert.equal((await request('/api/status')).data.activeRunId, null);
});

test('gelijktijdig starten opent één proef, ook zolang het eerste proces nog wordt voorbereid', options, async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { request, configure, launches } = await fixture(t, { beforeLaunch: () => gate });
  await configure();
  const first = request('/api/runs', { method: 'POST', body: {} });
  await eventually(async () => launches.length, count => count === 1);
  const second = request('/api/runs', { method: 'POST', body: {} });
  let rejectedWhileStarting;
  try {
    rejectedWhileStarting = await Promise.race([
      second,
      new Promise(resolve => setTimeout(() => resolve(null), 250)),
    ]);
  } finally {
    release();
  }
  const completed = await Promise.all([first, second]);
  assert.equal(rejectedWhileStarting?.status, 409);
  assert.deepEqual(completed.map(result => result.status), [202, 409]);
  assert.equal(launches.length, 1);
});

test('rapportbestanden zijn leesbaar maar padtraversal en ongewenste extensies niet', options, async t => {
  const { root, request } = await fixture(t);
  const directory = join(root, 'runs', 'eigen-proef');
  await mkdir(directory);
  await writeFile(join(directory, 'verslag.md'), 'Eigen proefverslag');
  await writeFile(join(directory, 'niet-tonen.txt'), 'Niet toegestaan');
  await writeFile(join(root, 'privaat.json'), '{"inhoud":"buiten de proef"}');
  const valid = await request('/api/runs/eigen-proef/file?path=verslag.md');
  assert.equal(valid.status, 200);
  assert.equal(valid.text, 'Eigen proefverslag');
  assert.match(valid.headers.get('Content-Type'), /^text\/plain/);
  for (const path of ['../../privaat.json', '../ander/verslag.md', '/privaat.json', 'niet-tonen.txt']) {
    const result = await request('/api/runs/eigen-proef/file?' + new URLSearchParams({ path }));
    assert.equal(result.status, 400);
    assert.ok(!result.text.includes('buiten de proef'));
  }
});

test('symlinks in rapportbestanden en rapportmappen kunnen geen lokale bestanden ontsluiten', options, async t => {
  const { root, request } = await fixture(t);
  const directory = join(root, 'runs', 'eigen-proef');
  const other = join(root, 'andere-map');
  await mkdir(directory);
  await mkdir(other);
  await writeFile(join(other, 'privaat.json'), '{"inhoud":"afgeschermde oefeninhoud"}');
  await symlink(join(other, 'privaat.json'), join(directory, 'link.json'));
  await symlink(other, join(directory, 'link-map'), 'dir');
  await symlink(other, join(root, 'runs', 'link-proef'), 'dir');
  for (const [id, path] of [
    ['eigen-proef', 'link.json'],
    ['eigen-proef', 'link-map/privaat.json'],
    ['link-proef', 'privaat.json'],
  ]) {
    const result = await request(`/api/runs/${id}/file?` + new URLSearchParams({ path }));
    assert.equal(result.status, 400, 'Iedere symlink in de padketen moet worden geweigerd.');
    assert.ok(!result.text.includes('afgeschermde oefeninhoud'));
  }
});

test('CRM-preset kiest vast Nemotron en serveert HTML uitsluitend als tekst op Studio-origin', options, async t => {
  const f = await fixture(t);
  await f.request('/api/config', { method: 'POST', body: { provider: 'openrouter', token } });
  const result = await f.request('/api/runs', { method: 'POST', body: { kind: 'crm-frontend', modelId: 'paid-model-ignored' } });
  assert.equal(result.status, 202);
  assert.equal(f.launches[0].modelId, 'nvidia/nemotron-3-super-120b-a12b:free');
  assert.equal(f.launches[0].kind, 'crm-frontend');
  const dir = join(f.root, 'runs', result.data.id);
  await mkdir(join(dir, 'app'));
  await writeFile(join(dir, 'app/index.html'), '<!doctype html><html>CRM</html>');
  await writeFile(join(dir, 'summary.json'), JSON.stringify({ id: result.data.id, kind: 'crm-frontend', previewReady: true }));
  const source = await f.request(`/api/runs/${result.data.id}/file?path=app%2Findex.html`);
  assert.match(source.headers.get('content-type'), /^text\/plain/);
  const preview = await f.request(`/api/runs/${result.data.id}/preview`);
  assert.equal(preview.status, 200);
  assert.equal((await fetch(preview.data.url)).status, 200);
});

test('app-project heeft vrije opdracht, bewerkbare bronbestanden en afgeschermde vervolgacties', options, async t => {
  const f = await fixture(t);
  // A skeleton does not need model credentials or consume a model request.
  const start = await f.request('/api/runs', { method: 'POST', body: { kind: 'app-project', starter: true } });
  assert.equal(start.status, 202);
  assert.equal(f.launches[0].mode, 'scaffold');
  const id = start.data.id;
  const directory = join(f.root, 'runs', id);
  f.children[0].emit('close', 0);
  await eventually(() => f.request('/api/status'), r => r.data.activeRunId === null);
  await mkdir(join(directory, 'project/src'), { recursive: true });
  const save = await f.request(`/api/runs/${id}/file`, { method: 'POST', body: { path: 'project/src/App.jsx', content: 'export default function App(){return null}' } });
  assert.equal(save.status, 200);
  const detail = await f.request(`/api/runs/${id}`);
  assert.ok(detail.data.files.some(file => file.path === 'project/src/App.jsx'));
  assert.equal(detail.data.summary.status, 'edited');
  assert.equal((await f.request(`/api/runs/${id}/file`, { method: 'POST', body: { path: 'project/package.json', content: '{}' } })).status, 400);
  assert.equal((await f.request(`/api/runs/${id}/improve`, { method: 'POST', body: { prompt: 'Maak er een planner van.' } })).status, 400);
  const build = await f.request(`/api/runs/${id}/build`, { method: 'POST', body: {} });
  assert.equal(build.status, 202);
  assert.equal(f.launches[1].mode, 'build');
  assert.equal((await f.request(`/api/runs/${id}/file`, { method: 'POST', body: { path: 'project/src/App.jsx', content: '' } })).status, 409);
});

test('wizard bewaart naam en projectlocatie, bronbrowser gebruikt de echte map en overwrite niets', options, async t => {
  const f = await fixture(t);
  const plan = await f.request('/api/workspace-plan', { method: 'POST', body: { projectName: 'HR voor Bimmers' } });
  assert.equal(plan.status, 200);
  assert.equal((await f.request('/api/runs', { method: 'POST', body: { kind: 'app-project', starter: true, projectName: 'HR voor Bimmers', expectedPath: '/verkeerd' } })).status, 409);
  const start = await f.request('/api/runs', { method: 'POST', body: { kind: 'app-project', starter: true, projectName: 'HR voor Bimmers', expectedPath: plan.data.directory } });
  assert.equal(start.status, 202);
  const id = start.data.id;
  f.children[0].emit('close', 0);
  await eventually(() => f.request('/api/status'), r => r.data.activeRunId === null);
  const detail = await f.request(`/api/runs/${id}`);
  assert.equal(detail.data.summary.projectName, 'HR voor Bimmers');
  const directory = detail.data.summary.projectPath;
  assert.ok(directory.endsWith('/projects/hr-voor-bimmers'));
  assert.equal(directory, plan.data.directory);
  assert.equal((await f.request(`/api/runs/${id}/file`, { method: 'POST', body: { path: 'project/src/App.jsx', content: 'export default function App(){return null}' } })).status, 200);
  assert.equal(await readFile(join(directory, 'src/App.jsx'), 'utf8'), 'export default function App(){return null}');
  assert.equal((await f.request(`/api/runs/${id}/file?path=project%2Fsrc%2FApp.jsx`)).status, 200);
  assert.ok((await f.request(`/api/runs/${id}`)).data.files.some(x => x.path === 'project/src/App.jsx'));
  assert.ok(!(await f.request(`/api/runs/${id}`)).data.files.some(x => x.path.includes('.workspace')));
  assert.equal((await f.request('/api/runs', { method: 'POST', body: { kind: 'app-project', starter: true, projectName: 'HR voor Bimmers' } })).status, 409);
  assert.equal((await f.request('/api/runs', { method: 'POST', body: { kind: 'app-project', starter: true, projectName: '../buiten' } })).status, 400);
  assert.equal((await f.request('/api/runs', { method: 'POST', body: { kind: 'app-project', starter: true, projectName: 'Ander project', folderId: 'niet-geselecteerd' } })).status, 400);
  assert.equal((await f.request('/internal/folder', { method: 'POST', body: { path: f.root } })).status, 403);
});

test('native locatietoken, bevestiging en projectregistratie wijzen exact naar bim-tests/hr5', options, async t => {
  const f = await fixture(t, { desktopToken: 'test-native-locatie' });
  const parent = join(f.root, 'bim-tests'); await mkdir(parent);
  const target = join(parent, 'hr5');
  const picked = await f.request('/internal/folder', { method: 'POST', body: { path: target } });
  assert.equal(picked.status, 200);
  const { folderId } = picked.data;
  const plan = await f.request('/api/workspace-plan', { method: 'POST', body: { projectName: 'HR5', folderId } });
  assert.equal(plan.data.directory, picked.data.path);
  const started = await f.request('/api/runs', { method: 'POST', body: { kind: 'app-project', starter: true, projectName: 'HR5', folderId, expectedPath: plan.data.directory } });
  assert.equal(started.status, 202);
  f.children[0].emit('close', 0);
  const detail = await f.request(`/api/runs/${started.data.id}`);
  assert.equal(detail.data.summary.projectPath, plan.data.directory);
  assert.ok(plan.data.directory.endsWith('/bim-tests/hr5'));
  assert.equal((await f.request(`/api/runs/${started.data.id}/file`, { method: 'POST', body: { path: 'project/src/App.jsx', content: 'export default function App(){return null}' } })).status, 200);
  assert.equal(await readFile(join(plan.data.directory, 'src/App.jsx'), 'utf8'), 'export default function App(){return null}');
  await assert.rejects(stat(join(parent, 'hr5/hr5')), { code: 'ENOENT' });
  await assert.rejects(stat(join(f.root, 'hr5')), { code: 'ENOENT' });
});

test('projectkoppelingen schrijven alleen de eigen .env en worden niet via bestanden of rapporten gedeeld', options, async t => {
  const f = await fixture(t);
  const result = await f.request('/api/runs', { method: 'POST', body: { kind: 'app-project', starter: true, projectName: 'Koppeling' } });
  const id = result.data.id;
  assert.equal((await f.request(`/api/runs/${id}/settings`, { method: 'POST', body: {} })).status, 409);
  f.children[0].emit('close', 0);
  await eventually(() => f.request('/api/status'), r => r.data.activeRunId === null);
  const project = (await f.request(`/api/runs/${id}`)).data.summary.projectPath;
  const { scaffold } = await import('../src/projects/project-files.mjs');
  const { runtimeDirectory } = await import('../src/build/project-build.mjs');
  await scaffold(project, runtimeDirectory);
  const values = { VITE_SUPABASE_URL: 'https://fixture.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fixture', VITE_API_BASE_URL: 'https://api.example.com/v1/' };
  const saved = await f.request(`/api/runs/${id}/settings`, { method: 'POST', body: values });
  assert.equal(saved.status, 200); assert.equal(saved.data.rebuildRequired, true);
  assert.deepEqual((await f.request(`/api/runs/${id}/settings`)).data.values, values);
  assert.match(await readFile(join(project, '.env'), 'utf8'), /sb_publishable_fixture/);
  assert.ok(!JSON.stringify((await f.request(`/api/runs/${id}`)).data).includes('sb_publishable_fixture'));
  assert.notEqual((await f.request(`/api/runs/${id}/file?path=project%2F.env`)).status, 200);
  const invalid = await f.request(`/api/runs/${id}/settings`, { method: 'POST', body: { ...values, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_private' } });
  assert.equal(invalid.status, 400);
  assert.deepEqual((await f.request(`/api/runs/${id}/settings`)).data.values, values);
});

test('OpenRouter-gebruik wordt lokaal opgehaald, gedeeld gecachet en start geen modelaanvraag', options, async t => {
  let calls = 0;
  const f = await fixture(t, { usageFetch: async () => { calls++; return Response.json({ data: { usage_daily: 0, free_model_daily_requests: { used: 2, limit: 50, remaining: 48 } } }); } });
  assert.equal((await f.request('/api/usage')).status, 400);
  await f.request('/api/config', { method: 'POST', body: { provider: 'openrouter', token } });
  const results = await Promise.all([f.request('/api/usage'), f.request('/api/usage')]);
  assert.equal(results[0].status, 200); assert.equal(results[0].data.freeRequests.remaining, 48);
  assert.equal((await f.request('/api/usage')).data.usageUsd.today, 0);
  assert.equal(calls, 1); assert.equal(f.launches.length, 0);
  assert.ok(!JSON.stringify(results).includes(token));
});

test('schema-uitlezen gebruikt de opgeslagen projectkoppeling en geeft alleen metadata terug', options, async t => {
  const f = await fixture(t, { schemaFetch: async () => Response.json({ swagger: '2.0', paths: { '/people': { get: {} } }, definitions: { people: { properties: { id: { type: 'integer' } } } } }) });
  const started = await f.request('/api/runs', { method: 'POST', body: { kind: 'app-project', starter: true, projectName: 'Schema project' } });
  const id = started.data.id; f.children[0].emit('close', 0);
  await eventually(() => f.request('/api/status'), r => r.data.activeRunId === null);
  const project = (await f.request(`/api/runs/${id}`)).data.summary.projectPath;
  const { writeProjectSettings } = await import('../src/projects/project-settings.mjs');
  await writeProjectSettings(project, { VITE_SUPABASE_URL: 'https://fixture.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fixture' });
  const fetched = await f.request(`/api/runs/${id}/schema`, { method: 'POST', body: {} });
  assert.equal(fetched.status, 200); assert.equal(fetched.data.tables.length, 1);
  const settings = await f.request(`/api/runs/${id}/settings`); assert.equal(settings.data.schema.tables[0].name, 'people');
  assert.ok(!JSON.stringify(fetched.data).includes('sb_publishable_fixture'));
  assert.equal((await f.request(`/api/runs/${id}`)).data.summary.modelCalls, undefined);
});

test('buildfoutkaart bevat compilerdiagnose en verdwijnt na een geslaagde build', options, async t => {
  const f = await fixture(t), id = 'feedback-case', dir = join(f.root, 'runs', id);
  await mkdir(join(dir, 'project'), { recursive: true });
  await writeFile(join(dir, 'summary.json'), JSON.stringify({ id, kind: 'app-project', status: 'build-failed', error: 'Build faalde' }));
  await writeFile(join(dir, 'project/build.log'), '/private/project/src/App.jsx:215:8: ERROR: The symbol "translateRole" has already been declared');
  const detail = await f.request(`/api/runs/${id}`);
  assert.equal(detail.data.buildError.file, 'src/App.jsx'); assert.equal(detail.data.buildError.line, 215);
  assert.match(detail.data.buildError.repairPrompt, /Fix only/);
  await writeFile(join(dir, 'summary.json'), JSON.stringify({ id, kind: 'app-project', status: 'built' }));
  assert.equal((await f.request(`/api/runs/${id}`)).data.buildError, null);
});

test('losse preview heeft uitsluitend leesbare bouwstatus op eigen origin en blijft bereikbaar bij buildfout', options, async t => {
  const f = await fixture(t), id = 'live-preview', dir = join(f.root, 'runs', id);
  await mkdir(join(dir, 'project/dist'), { recursive: true });
  await writeFile(join(dir, 'project/dist/index.html'), '<!doctype html><html><body><h1>Werkende fixture</h1></body></html>');
  const summary = { id, kind: 'app-project', status: 'built', previewReady: true, finishedAt: 'v1' };
  await writeFile(join(dir, 'summary.json'), JSON.stringify(summary));
  const opened = await f.request(`/api/runs/${id}/preview`), url = opened.data.url;
  const page = await fetch(url), html = await page.text();
  assert.match(html, /__studio_status.json/); assert.match(page.headers.get('content-security-policy'), /connect-src 'self' https: wss:/);
  const statusUrl = new URL('__studio_status.json', url);
  let value = await (await fetch(statusUrl)).json();
  assert.deepEqual(Object.keys(value).sort(), ['building','failed','local','ready','revision']);
  assert.equal(value.ready, true); assert.equal(value.building, false);
  assert.equal((await fetch(new URL('/api/status', url))).status, 404);
  assert.equal((await fetch(statusUrl, { method: 'POST' })).status, 404);
  const started = await f.request(`/api/runs/${id}/build`, { method: 'POST', body: {} });
  assert.equal(started.status, 202);
  value = await (await fetch(statusUrl)).json(); assert.equal(value.building, true); assert.equal(value.local, true);
  await writeFile(join(dir, 'summary.json'), JSON.stringify({ ...summary, status: 'build-failed', previewReady: false, finishedAt: 'v2' }));
  f.children[0].emit('close', 0);
  await eventually(() => f.request('/api/status'), r => r.data.activeRunId === null);
  value = await (await fetch(statusUrl)).json(); assert.equal(value.building, false); assert.equal(value.failed, true);
  assert.equal((await fetch(url)).status, 200); // status shell rather than a blank 404
  await writeFile(join(dir, 'summary.json'), JSON.stringify({ ...summary, finishedAt: 'v3' }));
  value = await (await fetch(statusUrl)).json(); assert.equal(value.ready, true); assert.equal(value.revision, 'v3:built');
});

test('legacy provider failure uses request details and same prompt, never a stale successful build log', options, async t => {
  const f = await fixture(t), id = 'provider-feedback', dir = join(f.root, 'runs', id);
  await mkdir(join(dir, 'project'), {recursive:true});
  await writeFile(join(dir, 'summary.json'), JSON.stringify({id,kind:'app-project',status:'build-failed',error:"The project response is missing or too large.",modelCalls:12,prompt:'Voeg declaraties toe',previewReady:true}));
  await writeFile(join(dir, 'project/build.log'), 'STALE successful build');
  await writeFile(join(dir, 'response-12.json'), JSON.stringify({provider:'Nvidia',choices:[{finish_reason:'error',error:{code:502,message:'Internal server error'},message:{content:null,reasoning:'PRIVATE'}}]}));
  const card = (await f.request(`/api/runs/${id}`)).data.buildError;
  assert.equal(card.kind, 'provider'); assert.equal(card.action, 'retry');
  assert.equal(card.retryPrompt, 'Voeg declaraties toe');
  assert.ok(!JSON.stringify(card).includes('STALE')); assert.ok(!JSON.stringify(card).includes('PRIVATE'));
});

test('vrije bouwmatrix geeft keuze, weigert betaald en bewaart de gekozen omvang', options, async t => {
  const f=await fixture(t); await f.request('/api/config',{method:'POST',body:{provider:'openrouter',token}});
  const status=await f.request('/api/status'); assert.deepEqual(status.data.appModels,[]);
  const bad=await f.request('/api/runs',{method:'POST',body:{kind:'app-project',prompt:'Maak een testapp',modelId:'paid/model'}});
  assert.equal(bad.status,400); assert.equal(f.launches.length,0);
  const created=await f.request('/api/runs',{method:'POST',body:{kind:'app-project',prompt:'Maak een testapp',modelId:'poolside/laguna-xs-2.1:free',changeSize:'large'}});
  assert.equal(created.status,202); assert.equal(f.launches[0].modelId,'poolside/laguna-xs-2.1:free');
  const detail=(await f.request('/api/runs/'+created.data.id)).data;
  assert.equal(detail.summary.modelChoice,'poolside/laguna-xs-2.1:free'); assert.equal(detail.summary.changeSize,'large');
});
