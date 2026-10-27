import { packageRoot, specsDirectory, runPath } from '../paths.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Script } from 'node:vm';
import { readConfig } from '../config/config.mjs';
import { redact } from '../config/redact.mjs';

export const CRM_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free';
export function extractHtml(content) {
  if (typeof content !== 'string') throw new Error("No text response received.");
  const fenced = content.match(/^\s*```(?:html)?\s*\n([\s\S]*?)\n```\s*$/);
  const html = (fenced ? fenced[1] : content).trim();
  if (!/^<!doctype html>/i.test(html) || !/<\/html>\s*$/i.test(html) || html.includes('```')) throw new Error("No complete standalone HTML document received.");
  if (Buffer.byteLength(html) > 500_000) throw new Error("HTML is too large.");
  return html + '\n';
}
export function checkHtml(html) {
  const checks = [];
  const check = (name, fn) => { try { fn(); checks.push({ name, pass: true }); } catch (error) { checks.push({ name, pass: false, error: error.message }); } };
  check("Standalone HTML document", () => { extractHtml(html); });
  check("Inline JavaScript has valid syntax (not executed)", () => {
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
    if (!scripts.length) throw new Error("No script found.");
    for (const [, attributes, source] of scripts) {
      if (/\bsrc\s*=|\btype\s*=\s*["']module/i.test(attributes)) throw new Error("Use plain inline scripts without external modules.");
      new Script(source);
    }
  });
  check("Required controls are present in the source", () => {
    for (const id of ['check-connection', 'connection-status', 'search-form', 'customer-search', 'search-button', 'customer-results', 'search-status', 'selected-customer', 'clear-selection', 'simulate-error', 'api-error', 'request-info']) {
      if (!new RegExp(`id\\s*=\\s*["']${id}["']`).test(html)) throw new Error(`Ontbrekend: ${id}`);
    }
  });
  check("Public CRM URL and mobile viewport are present", () => {
    if (!html.includes('https://crm-api.trimedixs.nl') || !/name\s*=\s*["']viewport["']/i.test(html)) throw new Error("API URL or viewport is missing.");
  });
  return checks;
}

async function run() {
  const here = packageRoot;
  const root = process.env.BIM_CLIENT_DATA_DIR || here;
  const id = process.env.PILOT_RUN_ID;
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Start this experiment from Open Vibe Coder.");
  const directory = runPath(root, id);
  const config = await readConfig(join(root, '.env.local'));
  if (config.provider !== 'openrouter') throw new Error("This CRM experiment requires OpenRouter.");
  const safe = text => redact(text, [config.token]);
  const summary = { id, kind: 'crm-frontend', provider: 'openrouter', model: CRM_MODEL, status: 'started', startedAt: new Date().toISOString(), modelCalls: 0, tokenUsage: [], rounds: [], browserValidation: 'not-run' };
  const save = () => writeFile(join(directory, 'summary.json'), safe(JSON.stringify(summary, null, 2)));
  const controller = new AbortController();
  process.once('SIGTERM', () => controller.abort());
  process.once('SIGINT', () => controller.abort());
  summary.rounds.push({ phase: 'crm', attempt: 0, status: 'started', startedAt: summary.startedAt });
  await save();
  const started = performance.now();
  try {
    const messages = JSON.parse(await readFile(join(specsDirectory, 'crm/prompts.json'), 'utf8'));
    const payload = { model: CRM_MODEL, messages, temperature: 1, top_p: 0.95, max_tokens: 32768, reasoning: { enabled: true }, stream: false, provider: { only: ['nvidia'], allow_fallbacks: false, require_parameters: true, max_price: { prompt: 0, completion: 0, request: 0 } } };
    await writeFile(join(directory, 'request.json'), JSON.stringify(payload, null, 2), { flag: 'wx', mode: 0o600 });
    summary.promptSha256 = createHash('sha256').update(JSON.stringify(messages)).digest('hex');
    summary.modelCalls = 1;
    await save();
    console.log("Building CRM app: one free Nemotron request, no automatic retry.");
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json', 'X-OpenRouter-Title': "Open Vibe Coder CRM build experiment" }, body: JSON.stringify(payload), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(300_000)]) });
    const raw = await response.text();
    await writeFile(join(directory, 'response.json'), safe(raw), { mode: 0o600 });
    const data = JSON.parse(raw);
    summary.httpStatus = response.status;
    summary.returnedModels = [data.model]; summary.returnedProvider = data.provider;
    if (!response.ok || data.error) throw new Error(`Model request failed (HTTP ${response.status}); no retry.`);
    summary.tokenUsage = [data.usage];
    if (data.model?.replace(/:free$/, '') !== CRM_MODEL.replace(/:free$/, '') || data.usage?.cost !== 0) throw new Error("Model identity or zero cost could not be confirmed.");
    const content = data.choices?.[0]?.message?.content;
    if (typeof content === 'string') await writeFile(join(directory, 'response.md'), safe(content));
    if (data.choices?.[0]?.finish_reason === 'length') throw new Error("The model response was cut off at the output limit.");
    const html = extractHtml(content);
    const output = join(directory, 'app');
    await mkdir(output);
    await writeFile(join(output, 'index.html'), safe(html));
    summary.sourceSha256 = createHash('sha256').update(safe(html)).digest('hex');
    const checks = checkHtml(html);
    await writeFile(join(directory, 'tests.tap'), 'TAP version 13\n' + checks.map((item, i) => `${item.pass ? 'ok' : 'not ok'} ${i + 1} - ${item.name}${item.error ? '\n# ' + item.error.replace(/\n/g, ' ') : ''}`).join('\n') + `\n1..${checks.length}\n`);
    summary.fileChecks = checks;
    summary.status = checks.every(item => item.pass) ? 'built' : 'build-failed';
    summary.previewReady = true;
    console.log(`${checks.filter(item => item.pass).length}/${checks.length} file checks. Browser behavior must be tested separately.`);
  } catch (error) {
    summary.status = controller.signal.aborted ? 'cancelled' : 'build-failed';
    summary.error = safe(error.message);
    console.log(summary.error);
  } finally {
    summary.rounds[0].status = summary.status === 'built' ? 'passed' : 'failed';
    summary.rounds[0].error = summary.error;
    summary.elapsedMs = Math.round(performance.now() - started); summary.finishedAt = new Date().toISOString();
    await save();
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) run().catch(() => { console.error("The CRM experiment could not start. Check the local model connection."); process.exitCode = 1; });
