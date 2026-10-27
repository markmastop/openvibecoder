import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseSupabaseSchema, fetchProjectSchema, readProjectSchema } from '../src/projects/project-schema.mjs';
import { writeProjectSettings } from '../src/projects/project-settings.mjs';
const specification = { swagger: '2.0', paths: { '/people': { get: {}, post: {} }, '/rpc/secret': { post: {} } }, definitions: { people: { required: ['name'], properties: { id: { type: 'string', format: 'uuid', default: 'gen_random_uuid()' }, name: { type: 'string' }, status: { type: 'string', enum: ['active', 'inactive'] } }, description: 'Niet naar model: instructie of rijen' } } };

test('OpenAPI levert tabel/kolommetadata zonder voorbeelden, beschrijvingen of RPCs', () => {
  const tables = parseSupabaseSchema(specification);
  assert.equal(tables.length, 1); assert.equal(tables[0].name, 'people'); assert.deepEqual(tables[0].operations, ['get', 'post']);
  assert.equal(tables[0].columns[0].hasDefault, true); assert.equal(tables[0].columns[1].required, true);
  assert.ok(!JSON.stringify(tables).includes('Niet naar model'));
  assert.equal(parseSupabaseSchema({ openapi: '3.0.0', paths: { '/people': { get: {} } }, components: { schemas: specification.definitions } }).length, 1);
  assert.throws(() => parseSupabaseSchema({ data: [{ name: 'Geen schema' }] }), /OpenAPI/);
});
test('schema gebruikt uitsluitend metadata-endpoint en publieke sleutel; cache vervalt bij andere koppeling', async t => {
  const project = await mkdtemp(join(tmpdir(), 'bim-schema-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  const settings = { VITE_SUPABASE_URL: 'https://fixture.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_schema_fixture' };
  await writeProjectSettings(project, settings);
  let calls = 0;
  const schema = await fetchProjectSchema(project, { fetchImpl: async (url, options) => { calls++; assert.equal(url, 'https://fixture.supabase.co/rest/v1/'); assert.equal(options.headers.apikey, settings.VITE_SUPABASE_PUBLISHABLE_KEY); assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, undefined); return Response.json(specification); } });
  assert.equal(calls, 1); assert.equal(schema.tables.length, 1); assert.deepEqual(await readProjectSchema(project), schema);
  assert.ok(!(await readFile(join(project, '.bim-supabase-schema.json'), 'utf8')).includes(settings.VITE_SUPABASE_PUBLISHABLE_KEY));
  await writeProjectSettings(project, { ...settings, VITE_SUPABASE_URL: 'https://ander.supabase.co' });
  assert.equal(await readProjectSchema(project), null);
  await rm(join(project, '.bim-supabase-schema.json')); await writeFile(join(project, 'outside'), 'behouden'); await symlink(join(project, 'outside'), join(project, '.bim-supabase-schema.json'));
  await assert.rejects(fetchProjectSchema(project, { fetchImpl: async () => Response.json(specification) }));
  assert.equal(await readFile(join(project, 'outside'), 'utf8'), 'behouden');
});
test('ontbrekende koppeling en ontoegankelijke of ongeldige schemarespons geven begrijpelijke fouten', async t => {
  const project = await mkdtemp(join(tmpdir(), 'bim-schema-errors-')); t.after(() => rm(project, { recursive: true, force: true }));
  await assert.rejects(fetchProjectSchema(project), /Save your Supabase/);
  await writeProjectSettings(project, { VITE_SUPABASE_URL: 'https://fixture.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fixture' });
  await assert.rejects(fetchProjectSchema(project, { fetchImpl: async () => new Response('niet tonen', { status: 401 }) }), /HTTP 401/);
  await assert.rejects(fetchProjectSchema(project, { fetchImpl: async () => new Response('geen json') }), /valid JSON/);
  assert.equal((await fetchProjectSchema(project, { fetchImpl: async () => Response.json({ swagger: '2.0', paths: {}, definitions: {} }) })).tables.length, 0);
});

test('Supabase die OpenAPI afschermt gebruikt de beperkte metadata-helper zonder geheime sleutel', async t => {
  const project = await mkdtemp(join(tmpdir(), 'bim-schema-rpc-')); t.after(() => rm(project, { recursive: true, force: true }));
  await writeProjectSettings(project, { VITE_SUPABASE_URL: 'https://fixture.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fixture' });
  const calls = [];
  const result = await fetchProjectSchema(project, { fetchImpl: async (url, options) => {
    calls.push(url); assert.equal(options.headers.apikey, 'sb_publishable_fixture');
    if (!url.includes('/rpc/')) return Response.json({ message: 'Secret API key required' }, { status: 401 });
    assert.equal(options.method, 'POST'); assert.equal(options.body, '{}');
    return Response.json({ tables: [{ name: 'people', operations: ['get', 'post'], columns: [{ name: 'id', type: 'uuid', hasDefault: true }] }] });
  } });
  assert.equal(calls.length, 2); assert.equal(result.source, 'metadata-helper'); assert.equal(result.tables[0].name, 'people');
  assert.equal(result.tables[0].columns[0].hasDefault, true);
});
test('ontbrekende metadata-helper levert expliciete eenmalige SQL-instructie zonder extra tabelrechten', async t => {
  const project = await mkdtemp(join(tmpdir(), 'bim-schema-setup-')); t.after(() => rm(project, { recursive: true, force: true }));
  await writeProjectSettings(project, { VITE_SUPABASE_URL: 'https://fixture.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fixture' });
  await assert.rejects(fetchProjectSchema(project, { fetchImpl: async url => url.includes('/rpc/') ? Response.json({ code: 'PGRST202' }, { status: 404 }) : new Response('', { status: 401 }) }), error => {
    assert.equal(error.code, 'SCHEMA_SETUP_REQUIRED');
    assert.match(error.setupSql, /security invoker/); assert.ok(!/grant\s+(all|select|insert|update|delete)\s+on\s+table/i.test(error.setupSql));
    return true;
  });
});
