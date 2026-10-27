import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProjectSettings, writeProjectSettings, validateConnections } from '../src/projects/project-settings.mjs';
const values = { VITE_SUPABASE_URL: 'https://voorbeeld.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fixture', VITE_API_BASE_URL: 'https://api.example.com/api/v1/' };

test('projectinstellingen blijven in de eigen .env, behouden andere regels en weigeren geheime sleutels', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bim-settings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal((await readProjectSettings(root)).VITE_API_BASE_URL, '');
  await writeFile(join(root, '.env'), '# Eigen instelling\nCUSTOM_VALUE=behouden\nVITE_API_BASE_URL="https://oud.example/"\n');
  await writeProjectSettings(root, values);
  assert.deepEqual(await readProjectSettings(root), values);
  assert.match(await readFile(join(root, '.env'), 'utf8'), /CUSTOM_VALUE=behouden/);
  if (process.platform !== 'win32') assert.equal((await stat(join(root, '.env'))).mode & 0o777, 0o600);
  for (const key of ['sb_secret_fixture', 'service_role', 'sk-openrouter-fixture']) assert.throws(() => validateConnections({ ...values, VITE_SUPABASE_PUBLISHABLE_KEY: key }), /publishable/);
  for (const url of ['http://example.com/', 'https://user:pass@example.com/', 'https://example.com/?token=x', 'https://example.com/#x', 'https://example.com/\nVITE_X=x']) assert.throws(() => validateConnections({ VITE_API_BASE_URL: url }));
  await assert.rejects(writeProjectSettings(root, { ...values, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_no' }));
  assert.deepEqual(await readProjectSettings(root), values);
  await rm(join(root, '.env')); await writeFile(join(root, 'outside'), 'behouden'); await symlink(join(root, 'outside'), join(root, '.env'));
  await assert.rejects(writeProjectSettings(root, values));
  assert.equal(await readFile(join(root, 'outside'), 'utf8'), 'behouden');
});

test('API-helper behoudt padprefix en verwerkt JSON, lege antwoorden, fouten, time-out en annuleren', async t => {
  const source = await readFile(new URL('../templates/api.js', import.meta.url), 'utf8');
  const load = base => import('data:text/javascript;base64,' + Buffer.from(source.replaceAll('import.meta.env.VITE_API_BASE_URL', JSON.stringify(base))).toString('base64'));
  const { api } = await load('https://api.example.com/api/v1/');
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'https://api.example.com/api/v1/customers');
    assert.equal(options.method, 'POST'); assert.equal(options.headers.Authorization, 'Bearer session'); assert.equal(options.body, '{"name":"Test"}');
    return Response.json({ id: 1 });
  };
  assert.deepEqual(await api.post('/customers', { name: 'Test' }, { token: 'session' }), { id: 1 });
  for (const path of ['https://elsewhere.test/', '//elsewhere.test/', '../escape', '\\elsewhere.test']) await assert.rejects(api.get(path));
  globalThis.fetch = async () => new Response(null, { status: 204 });
  assert.equal(await api.delete('customers'), null);
  globalThis.fetch = async () => new Response('fout', { status: 403 });
  await assert.rejects(api.get('customers'), error => error.status === 403);
  globalThis.fetch = async () => new Response('kapot', { headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(api.get('customers'), /invalid JSON/);
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(api.get('customers'), /CORS/);
  globalThis.fetch = (_, { signal }) => new Promise((resolve, reject) => { if (signal.aborted) reject(new Error('aborted')); else signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
  await assert.rejects(api.get('customers', { timeoutMs: 5 }), /respond in time/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(api.get('customers', { signal: controller.signal }), /cancelled/);
  assert.equal((await load('')).isApiConfigured(), false);
  await assert.rejects((await load('')).api.get('customers'), /Set the API base URL/);
});
