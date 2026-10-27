import { readFile, lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';

export const CONNECTION_FIELDS = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY', 'VITE_API_BASE_URL'];
export function validateConnections(input) {
  const values = {};
  for (const key of CONNECTION_FIELDS) {
    const value = input[key] ?? '';
    if (typeof value !== 'string' || value.length > 3000 || /[\r\n\x00]/.test(value)) throw new Error("Invalid connection setting.");
    values[key] = value.trim();
  }
  for (const key of ['VITE_SUPABASE_URL', 'VITE_API_BASE_URL']) {
    if (!values[key]) continue;
    let url; try { url = new URL(values[key]); } catch { throw new Error("Use a full HTTPS URL."); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error("Use an HTTPS URL without credentials, query parameters, or a fragment.");
  }
  const key = values.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (key && !/^sb_publishable_[a-zA-Z0-9_-]+$/.test(key)) {
    let role;
    try { role = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role; } catch {}
    if (role !== 'anon' || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(key)) throw new Error("Use only a Supabase publishable key or legacy anon key. Secret keys do not belong in a frontend.");
  }
  return values;
}
async function envText(project) {
  const path = join(project, '.env');
  try {
    if (!(await lstat(path)).isFile()) throw new Error(".env must be a regular file.");
    return await readFile(path, 'utf8');
  } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}
export async function readProjectSettings(project) {
  const values = {};
  for (const line of (await envText(project)).split(/\r?\n/)) {
    const match = line.match(/^\s*(VITE_[A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (!match || !CONNECTION_FIELDS.includes(match[1])) continue;
    let value = match[2];
    if (value.startsWith('"')) { try { value = JSON.parse(value); } catch { throw new Error('Ongeldige .env-instelling.'); } }
    else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    values[match[1]] = value;
  }
  return validateConnections(values);
}
export async function writeProjectSettings(project, input) {
  const values = validateConnections(input);
  const retained = (await envText(project)).split(/\r?\n/).filter(line => !CONNECTION_FIELDS.some(key => new RegExp(`^\\s*${key}\\s*=`).test(line)));
  const content = retained.join('\n').trimEnd() + '\n' + CONNECTION_FIELDS.map(key => `${key}=${JSON.stringify(values[key])}`).join('\n') + '\n';
  const file = await open(join(project, '.env'), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { await file.chmod(0o600); await file.writeFile(content); } finally { await file.close(); }
  return values;
}
