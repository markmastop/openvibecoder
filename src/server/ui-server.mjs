import { fetchFreeModels, publicModel } from '../models/openrouter-catalog.mjs';
import { packageRoot, specsDirectory, uiDirectory, runPath, projectsDirectory } from '../paths.mjs';
import http from 'node:http';
import { buildFeedback, providerFailure, requestFeedback } from '../build/build-feedback.mjs';
import { fetchOpenRouterUsage } from '../models/openrouter-usage.mjs';
import { readFile, writeFile, readdir, mkdir, stat, lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve, extname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createWorkspace, workspaceDirectory, workspaceName, workspacePlan, projectDestination } from '../projects/workspaces.mjs';
import { readProjectSettings, writeProjectSettings, validateConnections } from '../projects/project-settings.mjs';
import { fetchProjectSchema, readProjectSchema } from '../projects/project-schema.mjs';
import { runtimeDirectory } from '../build/project-build.mjs';
import { saveSource, projectPath, ensureProjectConnections } from '../projects/project-files.mjs';
import { createPreviewService } from './crm-preview.mjs';
import { appPlan } from '../models/app-models.mjs';
import { CRM_MODEL } from '../execution/crm-runner.mjs';
import { randomUUID } from 'node:crypto';
import { MODEL_PROVIDERS, selectModel } from '../models/providers.mjs';
import { readConfig } from '../config/config.mjs';
import { cleanEnvironment } from '../execution/sandbox.mjs';

const projectRoot = packageRoot;
const buildInfo = await readFile(join(projectRoot, 'build-info.json'), 'utf8').then(JSON.parse).catch(() => ({ builtAt: null }));
const appVersion = buildInfo.version || await readFile(join(projectRoot,'package.json'),'utf8').then(text=>JSON.parse(text).version).catch(()=>null);
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const validId = value => /^[a-zA-Z0-9_.-]+$/.test(value) && !value.startsWith('.');
const modelOptions = provider => MODEL_PROVIDERS[provider].models.map(id => ({ id, label: id === 'openrouter/free' ? 'Free Models Router' : id === 'cohere/north-mini-code:free' ? "North Mini Code · free" : id.includes('qwen3-30b') ? 'Qwen3 30B A3B' : 'GLM 4.7 Flash' }));

export function createClientServer({ root = projectRoot, launch = null, desktopToken = null, usageFetch = fetch, schemaFetch = fetch, catalogFetch = fetch } = {}) {
  let active = null;
  let starting = false;
  let usageCache = null;
  let usagePending = null;
  const jobs = new Map();
  const folderChoices = new Map();
  const previews = createPreviewService(async (id, asset = 'index.html') => {
    const summary = JSON.parse(await artifact(id, 'summary.json'));
    if (!['crm-frontend', 'app-project'].includes(summary.kind) || !(summary.previewReady || summary.sourceSha256)) throw new Error("No built CRM app available.");
    if (summary.kind === 'crm-frontend' && asset !== 'index.html') throw new Error("Unknown file.");
    return { content: await artifact(id, summary.kind === 'app-project' ? `project/dist/${asset}` : 'app/index.html'), allowHttps: summary.kind === 'app-project', allowEmbed: summary.kind === 'app-project' };
  }, { getState: async id => {
    const summary = JSON.parse(await artifact(id, 'summary.json'));
    if (summary.kind !== 'app-project') return null;
    return { building: active?.id === id, local: ['build', 'scaffold'].includes(summary.lastMode), ready: summary.status === 'built' && Boolean(summary.previewReady), failed: ['build-failed', 'provider-error', 'generation-error', 'execution-error', 'stopped', 'cancelled'].includes(summary.status), revision: `${summary.finishedAt || ''}:${summary.status}` };
  }, parentOrigins: () => { const address = server.address(); return desktopToken ? ['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost'] : [`http://127.0.0.1:${address.port}`, `http://localhost:${address.port}`]; } });
  const json = (res, code, value) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  async function body(req) {
    if (!req.headers['content-type']?.startsWith('application/json')) throw new Error("Use JSON for this action.");
    let text = '';
    for await (const chunk of req) {
      text += chunk;
      if (text.length > 120_000) throw new Error("Request too large.");
    }
    try { return JSON.parse(text); } catch { throw new Error("Invalid JSON."); }
  }
  async function configuration() {
    try {
      const config = await readConfig(join(root, '.env.local'));
      return { configured: true, configError: null, provider: config.provider, models: modelOptions(config.provider), modelId: MODEL_PROVIDERS[config.provider].defaultModel };
    } catch {
      return { configured: false, configError: "Connect your own OpenRouter API key in Settings.", provider: 'openrouter', models: modelOptions('openrouter'), modelId: MODEL_PROVIDERS.openrouter.defaultModel };
    }
  }
  async function runs() {
    let directories;
    try { directories = await readdir(runPath(root), { withFileTypes: true }); } catch { return []; }
    const reports = await Promise.all(directories.filter(entry => entry.isDirectory() && validId(entry.name)).map(async entry => {
      try { return JSON.parse(await readFile(runPath(root, entry.name, 'summary.json'), 'utf8')); } catch { return null; }
    }));
    return reports.filter(Boolean).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, 50);
  }
  async function artifact(runId, name) {
    if (!validId(runId)) throw new Error("Invalid experiment ID.");
    const report = runPath(root, runId);
    const external = name.startsWith('project/');
    const base = external ? await workspaceDirectory(root, runId) : report;
    if ((await lstat(report)).isSymbolicLink()) throw new Error("Invalid report.");
    if (external) name = name.slice(8);
    if ((await lstat(base)).isSymbolicLink()) throw new Error("References outside the report are not allowed.");
    const target = resolve(base, name);
    if (!target.startsWith(base + sep) || !['.mjs', '.md', '.tap', '.json', '.jsonl', '.html', '.jsx', '.js', '.css', '.log'].includes(extname(target))) throw new Error("Invalid report file.");
    // Geen symlinks: rapportbestanden mogen geen andere lokale bestanden ontsluiten.
    let path = base;
    for (const part of relative(base, target).split(sep)) {
      path = join(path, part);
      if ((await lstat(path)).isSymbolicLink()) throw new Error("References outside the report are not allowed.");
    }
    const info = await stat(target);
    if (!info.isFile() || info.size > 1_500_000) throw new Error("This file cannot be displayed.");
    return readFile(target, 'utf8');
  }
  async function files(runId) {
    const base = runPath(root, runId);
    const result = [];
    async function walk(folder, depth = 0, prefix = '') {
      if (depth > 6) return;
      let entries;
      try { entries = await readdir(folder, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.isSymbolicLink() || ['node_modules', 'dist', '.cache', 'snapshots'].includes(entry.name)) continue;
        const path = join(folder, entry.name);
        if (depth === 0 && !prefix && entry.name === 'project') continue;
        if (entry.isDirectory()) await walk(path, depth + 1, prefix + entry.name + '/');
        else if (entry.isFile() && ['.mjs', '.md', '.tap', '.json', '.jsonl', '.html', '.jsx', '.js', '.css', '.log'].includes(extname(path))) {
          result.push({ path: prefix + entry.name, size: (await stat(path)).size });
        }
      }
    }
    await walk(base);
    try { await walk(await workspaceDirectory(root, runId), 0, 'project/'); } catch {}
    return result.sort((a, b) => a.path.localeCompare(b.path));
  }
  let modelCache = null;
  let modelPending = null;
  async function catalogue() {
    if (modelCache && Date.now() - modelCache.at < 60000) return modelCache.value;
    if (!modelPending) modelPending = fetchFreeModels({ fetchImpl: catalogFetch }).then(models => {
      const value = { models: models.map(publicModel), checkedAt: new Date().toISOString() };
      modelCache = { at: Date.now(), value }; return value;
    }).finally(() => { modelPending = null; });
    return modelPending;
  }
  const server = http.createServer(async (req, res) => {
    const address = server.address();
    const port = address && typeof address === 'object' ? address.port : 4179;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!hosts.includes(req.headers.host)) return json(res, 403, { error: "This client is only accessible locally." });
    if (desktopToken && req.headers.authorization !== `Bearer ${desktopToken}`) return json(res, 403, { error: "Open this connection from the desktop app." });
    const url = new URL(req.url, `http://${req.headers.host}`);
    const allowedOrigins = hosts.map(host => `http://${host}`);
    if (!desktopToken && req.method !== 'GET' && !allowedOrigins.includes(req.headers.origin)) return json(res, 403, { error: "Start this action from the local client." });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const styleNonce = randomUUID();
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'nonce-${styleNonce}'; img-src 'self' data:; connect-src 'self'; frame-src http://127.0.0.1:*; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
    let reservedRunStart = false;
    try {
      if (req.method === 'GET' && url.pathname === '/api/models') {
        try { return json(res, 200, await catalogue()); }
        catch (error) { return json(res, 503, { error: error.message }); }
      }
      if (req.method === 'POST' && url.pathname === '/api/connection') {
        try {
          const config = await readConfig(join(root, '.env.local'));
          if (config.provider !== 'openrouter') return json(res, 400, { error: "Connect Open Vibe Coder to OpenRouter." });
          const usage = await fetchOpenRouterUsage(config.token, { fetchImpl: usageFetch });
          const catalog = await catalogue();
          return json(res, 200, { connected: true, modelCount: catalog.models.length, checkedAt: catalog.checkedAt, usage });
        } catch { return json(res, 400, { error: "OpenRouter connection could not be verified. Check your API key and try again." }); }
      }
      if (req.method === 'GET' && url.pathname === '/api/usage') {
        try {
          const config = await readConfig(join(root, '.env.local'));
          if (config.provider !== 'openrouter') return json(res, 400, { error: "This usage view is available for OpenRouter." });
          if (usageCache?.token === config.token && Date.now() - usageCache.at < 30_000) return json(res, 200, usageCache.value);
          if (!usagePending || usagePending.token !== config.token) {
            const promise = fetchOpenRouterUsage(config.token, { fetchImpl: usageFetch });
            usagePending = { token: config.token, promise };
          }
          const pending = usagePending;
          try { const value = await pending.promise; usageCache = { token: config.token, at: Date.now(), value }; return json(res, 200, value); }
          finally { if (usagePending === pending) usagePending = null; }
        } catch (error) { return json(res, 400, { error: error.message.startsWith('OpenRouter') ? error.message : "Set up your OpenRouter connection first." }); }
      }
      if (req.method === 'POST' && url.pathname === '/internal/folder') {
        if (!desktopToken) return json(res, 403, { error: "Directory selection is only available in the desktop app." });
        const { path } = await body(req);
        const directory = await projectDestination(path);
        const folderId = randomUUID();
        folderChoices.set(folderId, { directory, at: Date.now() });
        return json(res, 200, { folderId, path: directory });
      }
      if (req.method === 'POST' && url.pathname === '/api/workspace-plan') {
        const { projectName, folderId } = await body(req);
        if (folderId && (!folderChoices.has(folderId) || Date.now() - folderChoices.get(folderId).at > 600_000)) return json(res, 400, { error: "Select the project directory again." });
        try { return json(res, 200, await workspacePlan(projectName, folderId ? folderChoices.get(folderId).directory : projectsDirectory(root), Boolean(folderId))); }
        catch (error) { return json(res, 400, { error: error.message }); }
      }
      if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, {
        ...await configuration(), appModels: modelCache?.value.models || [], appVersion, builtAt: buildInfo.builtAt, defaultProjectRoot: projectsDirectory(root), starterPrompt: await readFile(join(specsDirectory, 'project/crm.txt'), 'utf8'), platformSupported: process.platform === 'darwin',
        runState: active || starting ? 'running' : 'idle', activeRunId: active?.id ?? null, activeStartedAt: active?.startedAt ?? null, runs: await runs(),
      });
      if (req.method === 'POST' && url.pathname === '/api/config') {
        if (active || starting) return json(res, 409, { error: "Wait for the current task to finish before changing model access." });
        const { provider = 'cloudflare', accountId, token } = await body(req);
        if (!Object.hasOwn(MODEL_PROVIDERS, provider) || typeof token !== 'string' || token.length < 12 || /\s/.test(token)
          || (provider === 'cloudflare' && (typeof accountId !== 'string' || !/^[a-f0-9]{32}$/i.test(accountId)))) return json(res, 400, { error: "Check the model provider and API key." });
        const file = await open(join(root, '.env.local'), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
        const content = provider === 'openrouter' ? `MODEL_PROVIDER=openrouter\nOPENROUTER_API_KEY=${token}\n` : `MODEL_PROVIDER=cloudflare\nCLOUDFLARE_ACCOUNT_ID=${accountId}\nCLOUDFLARE_API_TOKEN=${token}\n`;
        try { await file.chmod(0o600); await file.writeFile(content); } finally { await file.close(); }
        return json(res, 200, { configured: true });
      }
      const projectAction = url.pathname.match(/^\/api\/runs\/([a-zA-Z0-9_-]+)\/(improve|build)$/);
      if (req.method === 'POST' && (url.pathname === '/api/runs' || projectAction)) {
        if (active || starting) return json(res, 409, { error: "A task is already running." });
        starting = true;
        reservedRunStart = true;
        const configured = await configuration();

        if (process.platform !== 'darwin' && !launch) return json(res, 400, { error: "This execution uses macOS sandboxing. Windows execution is not yet supported." });
        const { modelId: requested, kind: requestedKind = 'hr-backend', prompt = '', starter = false, projectName, folderId, expectedPath, changeSize = 'auto', planningEnabled = false } = await body(req);
        const kind = projectAction ? 'app-project' : requestedKind;
        const mode = projectAction?.[2] === 'build' ? 'build' : projectAction ? 'improve' : starter ? 'scaffold' : 'create';
        if (!configured.configured && !(kind === 'app-project' && ['build', 'scaffold'].includes(mode))) return json(res, 400, { error: "Set up your free model access in Settings first." });
        if (typeof planningEnabled !== 'boolean') return json(res, 400, { error: "Invalid planning option." });
        if (typeof prompt !== 'string') return json(res, 400, { error: "Invalid request." });
        if (kind === 'app-project' && !['build', 'scaffold'].includes(mode) && (typeof prompt !== 'string' || prompt.trim().length < 5 || prompt.length > 8000)) return json(res, 400, { error: "Describe your app or change in 5–8,000 characters." });
        if (!['hr-backend', 'crm-frontend', 'app-project'].includes(kind)) return json(res, 400, { error: "Unknown build experiment." });
        if (['crm-frontend', 'app-project'].includes(kind) && !['build', 'scaffold'].includes(mode) && configured.provider !== 'openrouter') return json(res, 400, { error: "The CRM build experiment uses OpenRouter." });
        let modelId;
        try { modelId = kind === 'app-project' ? appPlan({prompt,mode,changeSize,modelId:requested || 'auto'}).model : kind === 'crm-frontend' ? CRM_MODEL : selectModel(configured.provider, requested); } catch { return json(res, 400, { error: "Choose a model from the configured provider's free profile." }); }
        const id = projectAction?.[1] || new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
        let workspace = null;
        if (kind === 'app-project' && !projectAction && projectName !== undefined) {
          try { workspaceName(projectName); } catch (error) { return json(res, 400, { error: error.message }); }
          if (folderId && (!folderChoices.has(folderId) || Date.now() - folderChoices.get(folderId).at > 600_000)) return json(res, 400, { error: "Select the project directory again; the selection expired." });
        }
        const directory = runPath(root, id);
        await mkdir(directory, { recursive: true });
        if (kind === 'app-project' && !projectAction && projectName !== undefined) {
          try { workspace = await createWorkspace(root, id, projectName, folderId ? folderChoices.get(folderId).directory : projectsDirectory(root), Boolean(folderId), expectedPath); }
          catch (error) { if (error.code === 'LOCATION_CHANGED') return json(res, 409, { error: error.message }); if (error.code === 'EEXIST') return json(res, 409, { error: "This project directory already exists or is not empty. Choose an empty directory or another name; nothing was overwritten." }); throw error; }
          if (folderId) folderChoices.delete(folderId);
        }
        const previous = projectAction ? JSON.parse(await artifact(id, 'summary.json')) : null;
        if (previous && previous.kind !== 'app-project') return json(res, 400, { error: "This is not an editable app project." });
        const startedAt = new Date().toISOString();
        const summary = { ...(previous || { id, kind, provider: configured.provider, model: modelId, startedAt: new Date().toISOString(), rounds: [] }), status: 'queued', lastStartedAt: startedAt, ...(kind === 'app-project' ? { prompt: prompt.trim(), lastMode: mode, model: ['build','scaffold'].includes(mode) && previous ? previous.model : modelId, modelChoice: ['build','scaffold'].includes(mode) && previous ? previous.modelChoice || 'auto' : requested || 'auto', planningEnabled: ['build','scaffold'].includes(mode) ? false : planningEnabled, changeSize: ['build','scaffold'].includes(mode) && previous ? previous.changeSize || 'auto' : changeSize, ...(workspace ? { projectPath: workspace.directory, projectName: workspace.name } : {}), title: workspace?.name || previous?.title || (starter ? "My app" : prompt.trim().slice(0, 60)) } : {}) };
        await writeFile(join(directory, 'summary.json'), JSON.stringify(summary));
        const child = launch ? await launch({ id, modelId, root, ...(kind !== 'hr-backend' ? { kind, mode } : {}) }) : spawn(process.execPath, [join(projectRoot, kind === 'app-project' ? 'src/execution/project-runner.mjs' : kind === 'crm-frontend' ? 'src/execution/crm-runner.mjs' : 'src/execution/runner.mjs'), '--model', modelId], {
          cwd: projectRoot, env: { ...cleanEnvironment(), ...Object.fromEntries(['MODEL_PROVIDER', 'OPENROUTER_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'].filter(key => process.env[key]).map(key => [key, process.env[key]])), BIM_CLIENT_DATA_DIR: root, PILOT_RUN_ID: id, BIM_PROJECT_MODE: mode }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        const job = { id, child, startedAt, log: '', stopping: false };
        active = job; jobs.set(id, job);
        for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => { job.log = (job.log + chunk.toString()).slice(-40_000); });
        const finish = async () => {
          if (active?.id === id) active = null;
          try {
            const summary = JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8'));
            if (['queued', 'started', 'building'].includes(summary.status)) {
              summary.status = job.stopping ? 'cancelled' : 'stopped'; summary.finishedAt = new Date().toISOString();
              await writeFile(join(directory, 'summary.json'), JSON.stringify(summary, null, 2));
            }
            await writeFile(join(directory, 'client.log'), job.log);
          } catch {}
        };
        child.once('close', finish);
        child.once('error', finish);
        return json(res, 202, { id, startedAt });
      }
      const match = url.pathname.match(/^\/api\/runs\/([a-zA-Z0-9_.-]+)(?:\/(file|stop|preview|settings|schema))?$/);
      if (match && validId(match[1])) {
        const [, id, action] = match;
        if (['GET', 'POST'].includes(req.method) && action === 'settings') {
          const summary = JSON.parse(await artifact(id, 'summary.json'));
          if (summary.kind !== 'app-project') return json(res, 400, { error: "Open an app project first." });
          const project = await workspaceDirectory(root, id);
          try {
            if (req.method === 'GET') { const values = await readProjectSettings(project); return json(res, 200, { values, projectPath: project, schema: await readProjectSchema(project, values) }); }
            if (active || starting) return json(res, 409, { error: "Wait for the build to finish." });
            const values = validateConnections(await body(req));
            await ensureProjectConnections(project, runtimeDirectory);
            await writeProjectSettings(project, values);
            summary.previewReady = false; summary.status = 'edited';
            await writeFile(runPath(root, id, 'summary.json'), JSON.stringify(summary, null, 2));
            return json(res, 200, { saved: true, rebuildRequired: true });
          } catch (error) { return json(res, 400, { error: error.message }); }
        }
        if (req.method === 'POST' && action === 'schema') {
          if (active || starting) return json(res, 409, { error: "Wait for the build to finish." });
          const summary = JSON.parse(await artifact(id, 'summary.json'));
          if (summary.kind !== 'app-project') return json(res, 400, { error: "Open an app project first." });
          try { return json(res, 200, await fetchProjectSchema(await workspaceDirectory(root, id), { fetchImpl: schemaFetch })); }
          catch (error) { return json(res, 400, { error: error.message, ...(error.code === 'SCHEMA_SETUP_REQUIRED' ? { code: error.code, setupSql: error.setupSql } : {}) }); }
        }
        if (req.method === 'POST' && action === 'stop') {
          if (active?.id !== id) return json(res, 409, { error: "This task is no longer running." });
          active.stopping = true; active.child.kill('SIGTERM');
          return json(res, 200, { stopping: true });
        }
        if (req.method === 'POST' && action === 'file') {
          if (active || starting) return json(res, 409, { error: "Wait for the build to finish." });
          const summary = JSON.parse(await artifact(id, 'summary.json'));
          if (summary.kind !== 'app-project') return json(res, 400, { error: "Only app projects are editable." });
          const { path, content } = await body(req);
          if (typeof path !== 'string' || !path.startsWith('project/')) throw new Error("Invalid source path.");
          projectPath(path.slice(8));
          await artifact(id, 'summary.json');
          await saveSource(await workspaceDirectory(root, id), path.slice(8), content);
          summary.previewReady = false; summary.status = 'edited';
          await writeFile(runPath(root, id, 'summary.json'), JSON.stringify(summary, null, 2));
          return json(res, 200, { saved: true });
        }
        if (req.method === 'GET' && action === 'preview') return json(res, 200, { url: await previews.open(id) });
        if (req.method === 'GET' && action === 'file') {
          const content = await artifact(id, url.searchParams.get('path') || '');
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(content);
        }
        if (req.method === 'GET' && !action) {
          const summary = JSON.parse(await artifact(id, 'summary.json'));
          let log = jobs.get(id)?.log || '';
          if (!log) { try { log = await readFile(runPath(root, id, 'client.log'), 'utf8'); } catch {} }
          let buildError = null;
          let failure = summary.failure;
          // Older runners classified an empty provider response as a compiler failure.
          if (!failure && summary.kind === 'app-project' && summary.status === 'build-failed' && /Projectantwoord ontbreekt|Modelaanvraag mislukt|Modelantwoord afgebroken|project response is missing|Model request failed|model response was cut off/i.test(summary.error || '')) {
            try { failure = providerFailure(JSON.parse(await artifact(id, `response-${summary.modelCalls}.json`))); } catch {}
            failure ||= { kind: 'generation', message: summary.error };
          }
          if (summary.kind === 'app-project' && failure && summary.status !== 'cancelled') {
            buildError = requestFeedback(failure, summary.prompt);
          } else if (summary.kind === 'app-project' && summary.status === 'build-failed') {
            let buildLog = ''; try { buildLog = await artifact(id, 'project/build.log'); } catch {}
            buildError = buildFeedback(buildLog, summary.error);
          }
          return json(res, 200, { summary, log, files: await files(id), buildError });
        }
      }
      if (!desktopToken && req.method === 'GET' && ['/', '/index.html', '/app.js', '/code-editor.js', '/desktop-transport.js', '/styles.css'].includes(url.pathname)) {
        const path = join(uiDirectory, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
        res.writeHead(200, { 'Content-Type': mime[extname(path)], 'Cache-Control': 'no-store' }); return res.end(extname(path) === '.html' ? (await readFile(path, 'utf8')).replace('<style id="studio-editor-nonce">', `<style id="studio-editor-nonce" nonce="${styleNonce}">`) : await readFile(path));
      }
      json(res, 404, { error: "Not found." });
    } catch (error) {
      const status = error.code === 'ENOENT' ? 404 : 400;
      json(res, status, { error: status === 404 ? "Report file not found." : "The action failed. Check your input and try again." });
    } finally {
      if (reservedRunStart) starting = false;
    }
  });
  server.on('close', () => { active?.child.kill('SIGTERM'); previews.close(); });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const desktop = process.argv.includes('--desktop');
  const desktopToken = desktop ? process.env.BIM_DESKTOP_TOKEN : null;
  if (desktop && (!desktopToken || desktopToken.length < 32 || !process.env.BIM_CLIENT_DATA_DIR)) throw new Error("Desktop connection is not fully configured.");
  const port = desktop ? 0 : Number(process.env.BIM_CLIENT_PORT || 4179);
  if (!Number.isInteger(port) || (!desktop && port < 1024) || port > 65535) throw new Error("Invalid local client port.");
  const root = process.env.BIM_CLIENT_DATA_DIR ? resolve(process.env.BIM_CLIENT_DATA_DIR) : projectRoot;
  await mkdir(root, { recursive: true, mode: 0o700 });
  const server = createClientServer({ root, desktopToken });
  const stop = () => { server.close(); server.closeAllConnections(); };
  server.listen(port, '127.0.0.1', () => console.log(desktop
    ? `BIM_STUDIO_READY ${JSON.stringify({ port: server.address().port })}`
    : `Open Vibe Coder: http://127.0.0.1:${port}`));
  if (desktop) { process.stdin.resume(); process.stdin.once('end', stop); }
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
}
