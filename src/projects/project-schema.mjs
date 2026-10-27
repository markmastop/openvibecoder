import { readFile, lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readProjectSettings } from './project-settings.mjs';
const filename = '.bim-supabase-schema.json';
const fingerprint = settings => createHash('sha256').update(settings.VITE_SUPABASE_URL + '\0' + settings.VITE_SUPABASE_PUBLISHABLE_KEY).digest('hex');
export function parseSupabaseSchema(spec) {
  if (!spec || typeof spec !== 'object' || (!spec.swagger && !spec.openapi)) throw new Error("Supabase did not return an OpenAPI schema.");
  const definitions = spec.definitions || spec.components?.schemas || {};
  const tables = [];
  for (const [path, operations] of Object.entries(spec.paths || {})) {
    if (!/^\/[^/]+$/.test(path) || path === '/') continue;
    const name = decodeURIComponent(path.slice(1));
    const response = operations?.get?.responses?.['200'];
    const reference = response?.schema?.items?.$ref || response?.schema?.$ref || response?.content?.['application/json']?.schema?.items?.$ref;
    const definition = definitions[name] || definitions[reference?.split('/').at(-1)];
    if (!definition?.properties) continue;
    const columns = Object.entries(definition.properties).slice(0, 100).map(([name, column]) => ({
      name: name.slice(0, 128), type: String(column.type || "unknown").slice(0, 80),
      ...(column.format ? { format: String(column.format).slice(0, 80) } : {}),
      required: Array.isArray(definition.required) && definition.required.includes(name),
      hasDefault: Object.hasOwn(column, 'default'),
      ...(typeof column.readOnly === 'boolean' ? { readOnly: column.readOnly } : {}),
      ...(typeof column.nullable === 'boolean' ? { nullable: column.nullable } : {}),
      ...(Array.isArray(column.enum) ? { enum: column.enum.slice(0, 30).filter(value => ['string', 'number', 'boolean'].includes(typeof value)).map(value => typeof value === 'string' ? value.slice(0, 200) : value) } : {}),
    }));
    tables.push({ name: name.slice(0, 128), operations: ['get', 'post', 'patch', 'delete'].filter(method => operations[method]), columns });
    if (tables.length >= 100) break;
  }
  return tables.sort((a, b) => a.name.localeCompare(b.name));
}
export async function readProjectSchema(project, settings) {
  settings ||= await readProjectSettings(project);
  try {
    const path = join(project, filename);
    if (!(await lstat(path)).isFile()) return null;
    const saved = JSON.parse(await readFile(path, 'utf8'));
    if (saved.fingerprint !== fingerprint(settings) || !Array.isArray(saved.tables)) return null;
    return { tables: saved.tables, fetchedAt: saved.fetchedAt, source: saved.source };
  } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}
export async function fetchProjectSchema(project, { fetchImpl = fetch } = {}) {
  const settings = await readProjectSettings(project);
  if (!settings.VITE_SUPABASE_URL || !settings.VITE_SUPABASE_PUBLISHABLE_KEY) throw new Error("Save your Supabase project URL and public key first.");
  const url = settings.VITE_SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1/';
  let response;
  try { response = await fetchImpl(url, { headers: { apikey: settings.VITE_SUPABASE_PUBLISHABLE_KEY, Accept: 'application/openapi+json' }, redirect: 'error', signal: AbortSignal.timeout(15_000) }); }
  catch { throw new Error("The Supabase schema is unreachable. Check the project URL and connection."); }
  let result;
  if (response.ok) {
    const text = await response.text();
    if (text.length > 2_000_000) throw new Error("The Supabase schema is too large for this version.");
    let spec; try { spec = JSON.parse(text); } catch { throw new Error("Supabase returned an invalid JSON schema."); }
    result = { tables: parseSupabaseSchema(spec), fetchedAt: new Date().toISOString(), source: 'openapi' };
  } else if ([401, 403, 404].includes(response.status)) {
    const rpc = await fetchImpl(settings.VITE_SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1/rpc/bim_studio_schema', { method: 'POST', headers: { apikey: settings.VITE_SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' }, body: '{}', redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (!rpc.ok) {
      let failure = {}; try { failure = await rpc.json(); } catch {}
      if (rpc.status === 404 || failure.code === 'PGRST202' || failure.code === '42883') {
        const setupSql = await readFile(new URL('../../runtime/specs/project/supabase-schema.sql', import.meta.url), 'utf8');
        throw Object.assign(new Error("Your Supabase project needs a one-time metadata helper. Run the displayed SQL in the Supabase SQL editor, then select Fetch schema again."), { code: 'SCHEMA_SETUP_REQUIRED', setupSql });
      }
      throw new Error(`Supabase schema unavailable (HTTP ${rpc.status}). Check the public key and Data API permissions.`);
    }
    const text = await rpc.text();
    if (text.length > 2_000_000) throw new Error("The Supabase schema is too large for this version.");
    let data; try { data = JSON.parse(text); } catch { throw new Error("Supabase returned an invalid JSON schema."); }
    if (!Array.isArray(data.tables)) throw new Error("The metadata helper did not return a table list.");
    const tables = data.tables.slice(0, 100).map(table => ({
      name: String(table.name).slice(0, 128), operations: (table.operations || []).filter(method => ['get', 'post', 'patch', 'delete'].includes(method)),
      columns: (table.columns || []).slice(0, 100).map(column => ({ name: String(column.name).slice(0, 128), type: String(column.type || "unknown").slice(0, 80), format: String(column.format || column.type || "unknown").slice(0, 80), required: column.required === true, nullable: column.nullable === true, hasDefault: column.hasDefault === true, readOnly: column.readOnly === true })),
    }));
    result = { tables, fetchedAt: new Date().toISOString(), source: 'metadata-helper' };
  } else throw new Error(`Supabase schema unavailable (HTTP ${response.status}).`);
  const path = join(project, filename);
  try { if (!(await lstat(path)).isFile()) throw new Error("Invalid schema file."); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(JSON.stringify({ ...result, fingerprint: fingerprint(settings) }, null, 2)); } finally { await file.close(); }
  return result;
}
