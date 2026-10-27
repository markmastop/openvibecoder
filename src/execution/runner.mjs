import { packageRoot, specsDirectory, acceptanceFile, runPath } from '../paths.mjs';
import { mkdir, mkdtemp, readFile, writeFile, copyFile, realpath, rm, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { MODEL_PROVIDERS, selectModel, modelRequest, measureUsage } from '../models/providers.mjs';
import { readConfig } from '../config/config.mjs';
import { redact } from '../config/redact.mjs';
import { cleanEnvironment, sandboxProfile } from './sandbox.mjs';
import { assistantMessageForHistory, parseToolArguments } from '../parsing/tool-arguments.mjs';
import { acceptancePassed } from './acceptance.mjs';

const root = packageRoot;
const dataRoot = process.env.BIM_CLIENT_DATA_DIR ? resolve(process.env.BIM_CLIENT_DATA_DIR) : root;
const stopController = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => stopController.abort(new Error("Execution stopped by the user.")));
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const modelFlag = args.indexOf('--model');
const requestedModel = modelFlag < 0 ? undefined : args[modelFlag + 1];
const allowedArgs = checkOnly ? ['--check'] : modelFlag < 0 ? [] : ['--model', requestedModel];
if (args.join('\0') !== allowedArgs.join('\0')) {
  console.error("Use npm run check or npm run experiment [-- --model <model from the free profile>].");
  process.exit(1);
}

const tools = [
  { type: 'function', function: { name: 'read_app', description: "Read the current app.mjs for this experiment.", parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } } },
  { type: 'function', function: { name: 'write_app', description: "Write the complete app.mjs. This is the only editable application source.", parameters: { type: 'object', properties: { source: { type: 'string', description: "Complete JavaScript ES module." } }, required: ['source'], additionalProperties: false } } },
];

async function restrictedFile(appDir, action, source) {
  if (await realpath(appDir) !== appDir) throw new Error("The application directory was unexpectedly replaced.");
  const flags = action === 'write'
    ? constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW
    : constants.O_RDONLY | constants.O_NOFOLLOW;
  let file;
  try {
    file = await open(join(appDir, 'app.mjs'), flags, 0o600);
    if (action === 'write') { await file.writeFile(source); return "app.mjs saved"; }
    return await file.readFile('utf8');
  } catch (error) {
    if (action === 'read' && error.code === 'ENOENT') return "(app.mjs does not exist yet)";
    throw error;
  } finally { await file?.close(); }
}

function execute(command, parameters, options) {
  return new Promise((done, reject) => {
    const child = spawn(command, parameters, { ...options, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let timedOut = false;
    const killGroup = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const abort = () => { timedOut = true; killGroup(); };
    stopController.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, 30_000);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      if (output.length < 40_000) output += chunk.toString().slice(0, 40_000 - output.length);
    });
    child.on('error', error => { clearTimeout(timer); stopController.signal.removeEventListener('abort', abort); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      stopController.signal.removeEventListener('abort', abort);
      killGroup();
      done({ passed: code === 0 && !timedOut, exitCode: code, timedOut, output });
    });
  });
}

async function main() {
  const config = await readConfig(join(dataRoot, '.env.local'));
  const model = selectModel(config.provider, requestedModel);
  const providerLabel = MODEL_PROVIDERS[config.provider].label;
  if (checkOnly) {
    console.log(`${providerLabel}: required configuration is saved locally; values are not displayed. No API request was made.`);
    return;
  }
  if (process.platform !== 'darwin') throw new Error("This runner executes model code only through macOS sandboxing. Windows execution is not yet supported.");
  const secrets = [config.token, config.accountId];
  const clean = value => redact(value, secrets);
  const id = process.env.PILOT_RUN_ID || new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid;
  if (!/^[a-zA-Z0-9_.-]+$/.test(id)) throw new Error("Invalid experiment ID.");
  const archive = runPath(dataRoot, id);
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'qwen-hr-')));
  const appDir = join(workspace, 'app');
  const stateDir = join(workspace, 'state');
  await mkdir(appDir); await mkdir(stateDir); await mkdir(archive, { recursive: true });
  const acceptanceSource = await readFile(acceptanceFile, 'utf8');
  const expectedNames = [...acceptanceSource.matchAll(/^test\((['"])(.*?)\1/gm)].map(match => match[2]);
  if (expectedNames.length !== 18) throw new Error("The trusted acceptance suite must contain exactly 18 tests.");
  await copyFile(acceptanceFile, join(workspace, 'acceptance.mjs'));
  const nodePath = await realpath(process.execPath);
  const profilePath = join(workspace, 'sandbox.sb');
  await writeFile(profilePath, sandboxProfile({ runDir: workspace, nodeDir: dirname(dirname(nodePath)), nodePath, appDir, stateDir }));
  const report = {
    id, provider: config.provider, model, requestedModel: model,
    startedAt: new Date().toISOString(), scope: "local backend experiment; does not verify Supabase, UI, or deployment",
    temperature: 0.6, maxOutputTokens: model === 'cohere/north-mini-code:free' ? 16384 : 8192,
    reasoning: model === 'cohere/north-mini-code:free' ? { enabled: false } : null,
    maxModelCalls: 18, modelTimeoutMs: 180_000,
    stopAfterEstimatedNeurons: config.provider === 'cloudflare' ? 8000 : null,
    modelCalls: 0, estimatedNeurons: config.provider === 'cloudflare' ? 0 : null,
    reportedCostUsd: null,
    returnedModels: [], modelResponses: [], tokenUsage: [], rounds: [], status: 'started',
    actualNeurons: null, actualNeuronsNote: config.provider === 'cloudflare'
      ? "Dashboard measurements are unavailable; token calculations are estimates."
      : "Neurons do not apply to OpenRouter; see reported token usage and cost.",
    modelSelectionNote: config.provider === 'openrouter'
      ? model === 'openrouter/free' ? "The free router may select a different model per request. This experiment is not a benchmark of one model." : "A specific free OpenRouter model was requested; returned model names and costs are recorded per request."
      : "A specific Cloudflare model was requested; returned model names are recorded per request.",
    quotaNote: "Maximum 18 local model requests; this does not measure the remaining account quota. The provider may block requests earlier.",
  };
  const append = async (name, value) => {
    const file = await open(join(archive, name), 'a', 0o600);
    try { await file.writeFile(clean(value) + '\n'); } finally { await file.close(); }
  };
  const saveReport = () => writeFile(join(archive, 'summary.json'), clean(JSON.stringify(report, null, 2)) + '\n');
  try {
    await saveReport();
    // De modelverbinding en de uitvoer van modelcode zijn aparte processen.
    const preflight = await execute('/usr/bin/sandbox-exec', ['-f', profilePath, nodePath, '-e', 'process.stdout.write("sandbox-ok")'], { cwd: workspace, env: cleanEnvironment() });
    if (!preflight.passed) throw new Error("The execution sandbox could not start. No model request was made.");

    async function modelCall(messages) {
      stopController.signal.throwIfAborted();
      if (report.modelCalls >= report.maxModelCalls || (config.provider === 'cloudflare' && report.estimatedNeurons >= report.stopAfterEstimatedNeurons)) throw new Error("The configured experiment limit was reached; no further model request will be made.");
      // Lokale omvangslimiet, geen exacte tokenmeting; het gekozen providermodel blijft leidend.
      if (JSON.stringify(messages).length > 70_000) throw new Error("The conversation is too large for this compact experiment profile.");
      const request = modelRequest(config, { model, messages, tools, maxTokens: report.maxOutputTokens, temperature: report.temperature });
      const number = ++report.modelCalls;
      await append('calls.jsonl', { event: 'request', number, provider: config.provider, requestedModel: model, payload: request.body });
      await saveReport();
      const started = Date.now();
      let response, raw;
      try {
        response = await fetch(request.url, {
          method: 'POST', headers: request.headers,
          body: JSON.stringify(request.body), signal: AbortSignal.any([stopController.signal, AbortSignal.timeout(report.modelTimeoutMs)]),
        });
        raw = await response.text();
      } catch (error) {
        await append('calls.jsonl', { event: 'transport-error', number, elapsedMs: Date.now() - started, error: clean(error.message) });
        if (stopController.signal.aborted) stopController.signal.throwIfAborted();
        if (error.name === 'TimeoutError') throw new Error("The model did not return a complete response within 180 seconds. Execution stops without an automatic retry.");
        throw error;
      }
      let data;
      try { data = JSON.parse(raw); } catch { data = { error: "The provider response was not JSON." }; }
      const returnedModel = typeof data?.model === 'string' && data.model.trim() ? data.model : null;
      await append('calls.jsonl', { event: 'response', number, provider: config.provider, requestedModel: model, returnedModel, httpStatus: response.status, elapsedMs: Date.now() - started, data });
      report.modelResponses.push({ number, requestedModel: model, returnedModel, httpStatus: response.status, reportedCostUsd: data?.usage?.cost ?? null });
      if (returnedModel && !report.returnedModels.includes(returnedModel)) report.returnedModels.push(returnedModel);
      if (config.provider === 'openrouter' && Number.isFinite(data?.usage?.cost) && data.usage.cost >= 0) report.reportedCostUsd = (report.reportedCostUsd ?? 0) + data.usage.cost;
      await saveReport();
      if (!response.ok) throw new Error(`${providerLabel} returned HTTP ${response.status}; no automatic retry. Check your account, token, and free quota.`);
      if (config.provider === 'openrouter' && !returnedModel) throw new Error("OpenRouter did not report the selected model. Execution stops because the model selection cannot be verified.");
      report.tokenUsage.push(data?.usage ?? null);
      const measured = measureUsage(config.provider, model, data?.usage);
      if (config.provider === 'cloudflare') report.estimatedNeurons += measured.estimatedNeurons;
      await saveReport();
      const choice = data.choices?.[0];
      if (!choice?.message) throw new Error("No usable assistant message received.");
      if (choice.finish_reason === 'length') throw new Error("The model response was cut off at the output limit and cannot be used.");
      return choice.message;
    }

    async function generate(instruction, existing) {
      const messages = [
        { role: 'system', content: "Build a small HR backend for a reproducible experiment. Follow the contract exactly. Write all application code yourself using write_app; use read_app when needed. Use only Node.js 22 built-in modules. No internet, subprocesses, packages, or access outside the supplied storage file and app directory. Do not modify the tests or runner. Ordinary code blocks are not executed. Finish after writing app.mjs." },
        { role: 'user', content: instruction + (existing ? "\n\nCurrent app.mjs:\n" + existing : '') },
      ];
      let writes = 0;
      for (let step = 0; step < 4; step++) {
        const message = await modelCall(messages);
        messages.push(assistantMessageForHistory(message));
        if (!message.tool_calls?.length) {
          if (!writes) throw new Error("The model did not save application code using write_app.");
          return;
        }
        for (const call of message.tool_calls) {
          let result;
          try {
            const parameters = parseToolArguments(call);
            result = await restrictedFile(appDir, call.function.name === 'write_app' ? 'write' : 'read', parameters.source);
            if (call.function.name === 'write_app') writes++;
          } catch (error) { result = "Readyschapsfout: " + clean(error.message); }
          messages.push({ role: 'tool', tool_call_id: call.id, content: result });
        }
      }
      if (!writes) throw new Error("The bounded build round produced no application code.");
    }

    for (const phase of ['basis', 'wijziging']) {
      const specification = await readFile(join(specsDirectory, `${phase}.md`), 'utf8');
      await writeFile(join(archive, `${phase}-request.md`), specification);
      let feedback = '';
      let success = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        const round = { phase, attempt, status: 'started', startedAt: new Date().toISOString() };
        report.rounds.push(round);
        await saveReport();
        console.log(`${phase === 'basis' ? 'baseline' : 'change'}: ${attempt === 0 ? "build request" : "repair round " + attempt} — ${model}`);
        let generationError = null;
        try {
          const existing = phase === 'wijziging' || attempt > 0 ? await restrictedFile(appDir, 'read') : null;
          await generate(specification + feedback, existing);
        } catch (error) { generationError = clean(error.message); }
        const roundDir = join(archive, `${phase}-${attempt}`);
        await mkdir(roundDir);
        try { await writeFile(join(roundDir, 'app.mjs'), await restrictedFile(appDir, 'read')); } catch {}
        if (generationError) {
          round.status = 'generation-error'; round.error = generationError;
          feedback = "\n\nThe previous build round was unusable:\n" + generationError;
        } else {
          const tested = await execute('/usr/bin/sandbox-exec', ['-f', profilePath, nodePath, '--test', '--experimental-test-isolation=none', '--test-concurrency=1', 'acceptance.mjs'], {
            cwd: workspace, env: { ...cleanEnvironment(), CANDIDATE_PATH: join(appDir, 'app.mjs'), STATE_DIR: stateDir, PHASE: phase === 'basis' ? 'baseline' : 'change' },
          });
          await writeFile(join(roundDir, 'tests.tap'), clean(tested.output));
          const complete = acceptancePassed(tested, expectedNames);
          round.status = complete ? 'passed' : 'failed'; round.exitCode = tested.exitCode; round.timedOut = tested.timedOut;
          round.passedTests = [...tested.output.matchAll(/^ok \d+ - /gm)].length;
          if (tested.passed && !complete) tested.output += "\nThe acceptance suite did not fully pass: all 18 tests must run without skips or cancellations.\n";
          feedback = "\n\nFix only the app according to the original requirements. Test output:\n" + clean(tested.output).slice(-14_000);
          if (complete) { success = true; await saveReport(); break; }
        }
        await saveReport();
        // Auth-, quota-, context- en meetfouten opnieuw proberen verandert de modelproef niet.
        if (generationError && !/geen applicatiecode|bouwronde|afgebroken|did not save application code|build round|cut off/.test(generationError)) throw new Error(generationError);
      }
      if (!success) { report.status = `${phase}-failed`; process.exitCode = 1; return; }
    }
    report.status = 'passed';
  } catch (error) {
    report.status = stopController.signal.aborted ? 'cancelled' : 'stopped'; report.error = clean(error.message); process.exitCode = 1;
  } finally {
    report.finishedAt = new Date().toISOString();
    await saveReport();
    await rm(workspace, { recursive: true, force: true });
    console.log(`Proefstatus: ${report.status}. Rapport: ${join(archive, 'summary.json')}`);
    if (report.error) console.log(report.error);
  }
}

main().catch(error => { console.error(redact(error.message, [process.env.CLOUDFLARE_API_TOKEN, process.env.OPENROUTER_API_KEY])); process.exitCode = 1; });
