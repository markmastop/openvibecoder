import { readFile } from 'node:fs/promises';
import { MODEL_PROVIDERS } from '../models/providers.mjs';

export function parseEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!match) throw new Error("Invalid line in .env.local; use NAME=value.");
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

export async function readConfig(path, env = process.env) {
  let local = {};
  try { local = parseEnv(await readFile(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const value = key => env[key] || local[key];
  const provider = value('MODEL_PROVIDER') || (value('CLOUDFLARE_API_TOKEN') ? 'cloudflare' : 'openrouter');
  if (!Object.hasOwn(MODEL_PROVIDERS, provider)) throw new Error("Choose MODEL_PROVIDER=openrouter or MODEL_PROVIDER=cloudflare.");
  const token = value(provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'CLOUDFLARE_API_TOKEN');
  if (!token) throw new Error(provider === 'openrouter'
    ? "Set OPENROUTER_API_KEY in your local .env.local. No model request was made."
    : "Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in your local .env.local. No model request was made.");
  if (/\s/.test(token)) throw new Error("The API token contains whitespace; check the saved value.");
  if (provider === 'openrouter') return { provider, token };
  const accountId = value('CLOUDFLARE_ACCOUNT_ID');
  if (!accountId) throw new Error("Set CLOUDFLARE_ACCOUNT_ID in your local .env.local. No model request was made.");
  if (!/^[a-f0-9]{32}$/i.test(accountId)) throw new Error("The Cloudflare Account ID must contain 32 hexadecimal characters.");
  return { provider, accountId, token };
}
