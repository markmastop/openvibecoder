'use strict';
const clientFetch = window.bimClientFetch || window.fetch.bind(window);

const MODELS = {
  'liquid/lfm-2.5-2.6b:free': 'Liquid LFM2.5-2.6B',
  'xingchen-agi/xing4.0-29b-a4b:free': 'Xing4.0 29B A4B',
  'nvidia/nemotron-3-super-120b-a12b:free': "Nemotron 3 Super · free",
  'openrouter/free': "OpenRouter · free router",
  'cohere/north-mini-code:free': "North Mini Code · free",
  '@cf/qwen/qwen3-30b-a3b-fp8': 'Qwen3 · 30B',
  '@cf/zai-org/glm-4.7-flash': 'GLM · 4.7 Flash',
};
const CHECKS = [
  "Fixed accounts: correct identity, role, and starting balance.",
  "Reject incorrect credentials and invalid login fields.",
  "Reject missing, invented, and corrupted tokens.",
  "Read your own request without immediately deducting the balance.",
  "Ignore supplied owner, role, ID, and status.",
  "Reject invalid hours and data types.",
  "Handle invalid JSON safely.",
  "Employees can only see their own requests.",
  "Other employees' requests cannot be read directly.",
  "Managers can only see requests from their own team.",
  "Employees cannot approve requests.",
  "Managers from other teams cannot change requests.",
  "The correct manager approves and deducts the balance correctly.",
  "Repeated approval deducts the balance only once.",
  "Concurrent approval deducts the balance only once.",
  "Insufficient balance causes no negative or partial changes.",
  "Requests, approvals, and balances remain stored.",
  "The changed hours increment preserves existing requests.",
];
const $ = id => document.getElementById(id);
const state = {
  status: null, online: false, loaded: false, selectedId: null, detail: null,
  detailError: null, selectionIsNew: false, tab: 'overview', filePath: null,
  testPath: null, fileCache: new Map(), pendingFiles: new Set(), busy: false,
  drafts: new Map(), collapsedFolders: new Set(), wizard: { step: 1, folderId: null, path: null },
  polling: false, pollTimer: null, toastTimer: null, modelSignature: null,
  usage: null, usageError: null, usageFetchedAt: 0, usageRequest: null, usageRevision: 0,
  conversationKey: null, conversationProject: null, followOutput: true, newOutput: false,
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function provider() { return state.status?.provider || (String(state.status?.modelId).startsWith('@cf/') ? 'cloudflare' : 'openrouter'); }
function providerName() { return provider() === 'cloudflare' ? 'Cloudflare' : 'OpenRouter'; }
function availableModels() {
  if ($('task-select').value === 'app-project') return [{id:'auto',label:"Automatic · available free model"}, ...(state.catalogue?.models || [])];
  if ($('task-select').value === 'crm-frontend') return [{ id: 'nvidia/nemotron-3-super-120b-a12b:free', label: "Nemotron 3 Super · free" }];
  if (Array.isArray(state.status?.models) && state.status.models.length) {
    const normalized = state.status.models.map(model => typeof model === 'string' ? { id: model, label: MODELS[model] || model } : model).filter(model => model && typeof model.id === 'string');
    if (normalized.length) return normalized;
  }
  return Object.entries(MODELS).filter(([id]) => provider() === 'cloudflare' ? id.startsWith('@cf/') : id === 'openrouter/free' || id === 'cohere/north-mini-code:free').map(([id, label]) => ({ id, label }));
}
function modelName(id) { return availableModels().find(model => model.id === id)?.label || MODELS[id] || String(id || "Unknown model").replace('@cf/', ''); }
function isRunning() { return state.status?.runState === 'running'; }
function runSummary() {
  return state.detail?.summary || state.status?.runs?.find(run => run.id === state.selectedId) || null;
}
function runKind(status) {
  if (status === 'edited') return '';
  if (status === 'passed' || status === 'built') return 'passed';
  if (['queued', 'started', 'running', 'building', 'testing'].includes(status)) return 'running';
  if (status && status !== 'idle') return 'failed';
  return '';
}
function statusLabel(status) {
  if (status === 'built') return "App built";
  if (status === 'edited') return "Changed · rebuild required";
  if (status === 'provider-error') return "Model provider unavailable";
  if (status === 'generation-error') return "No usable model response";
  if (status === 'execution-error') return "Execution failed";
  if (status === 'build-failed') return "Build experiment failed";
  if (status === 'passed') return "Experiment passed";
  if (status === 'stopped') return "Task stopped";
  if (status === 'cancelled') return "Task cancelled";
  if (status === 'stopping') return "Stopping task";
  if (status === 'basis-failed') return "Baseline failed";
  if (status === 'wijziging-failed') return "Change failed";
  if (['failed', 'error', 'generation-error'].includes(status)) return "Experiment failed";
  if (['queued', 'started', 'running', 'building', 'testing'].includes(status)) return "Building app";
  return status ? "Task finished" : "Ready to start";
}
function dateLabel(value, full = false) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', full
    ? { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }
    : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date);
}
function numberLabel(value, digits = 0) {
  return typeof value === 'number' && Number.isFinite(value)
    ? new Intl.NumberFormat('en-GB', { maximumFractionDigits: digits }).format(value) : '—';
}
function sizeLabel(value) {
  return typeof value === 'number' ? value < 1024 ? `${value} B` : `${numberLabel(value / 1024, 1)} kB` : '';
}
function toast(message) {
  clearTimeout(state.toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  state.toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500);
}

async function api(path, options = {}) {
  const response = await clientFetch(path, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  let data;
  try { data = await response.json(); }
  catch { throw new Error("The local server returned an invalid response."); }
  if (!response.ok) throw Object.assign(new Error(typeof data.error === 'string' ? data.error.slice(0, 500) : "The request could not be completed."), data.code === 'SCHEMA_SETUP_REQUIRED' ? { code: data.code, setupSql: data.setupSql } : {});
  return data;
}

function renderNotice() {
  const notice = $('notice');
  notice.replaceChildren();
  notice.className = 'notice';
  let message = '';
  let action = null;
  if (state.loaded && !state.online) {
    message = window.bimDesktop ? "The local build service is not responding. Restart Open Vibe Coder." : "You are viewing the client. Start the local server to run a task.";
  } else if (state.status?.platformSupported === false) {
    message = "The client runs here; sandboxed execution is not yet available on this system.";
  } else if (state.online && !state.status?.configured) {
    message = state.status?.configError || `Connect your ${providerName()} account to use the external model.`;
    action = el('button', '', "Set up connection");
    action.type = 'button'; action.addEventListener('click', openSettings);
  } else if (state.detailError) {
    message = state.detailError;
    notice.classList.add('error');
  }
  notice.hidden = !message;
  if (message) notice.append(el('span', '', message));
  if (action) notice.append(action);
}

function renderConnection() {
  const configured = state.online && state.status?.configured;
  $('connection-dot').className = `connection-dot${configured ? ' ready' : state.loaded ? ' error' : ''}`;
  $('connection-label').textContent = configured ? (state.connectionVerified ? "OpenRouter · connected" : "OpenRouter · configured") : state.online ? "Model not connected" : state.loaded ? "Local server unreachable" : "Checking connection";
  $('connection-label').title = configured ? `${providerName()} connected` : '';
  $('open-settings').setAttribute('aria-label', configured ? `Settings: ${providerName()} connected` : "Set up model connection");
  $('local-provider-label').textContent = `Open Vibe Coder · ${providerName()}`;
  const badge = $('usage-summary');
  badge.hidden = !configured || provider() !== 'openrouter';
  const remaining = state.usage?.freeRequests?.remaining;
  badge.textContent = Number.isInteger(remaining) ? `${numberLabel(remaining)} free requests left` : state.usageError || state.usage ? "Free requests left: unknown" : "Loading free request usage…";
  badge.title = state.usageError || (state.usage ? `Free requests remaining today (UTC). Checked at ${dateLabel(state.usage.checkedAt, true)}.` : "Fetching OpenRouter usage.");
}

function renderSessions() {
  const runs = Array.isArray(state.status?.runs) ? state.status.runs : [];
  $('run-count').textContent = String(runs.length);
  const list = $('run-list');
  const focusId = document.activeElement?.dataset?.runId;
  list.replaceChildren();
  if (!runs.length) { list.append(el('p', 'sidebar-empty', "Your projects will appear here.")); return; }
  const fragment = document.createDocumentFragment();
  for (const run of runs) {
    const button = el('button', `session-button${run.id === state.selectedId ? ' active' : ''}`);
    button.type = 'button'; button.dataset.runId = run.id;
    button.setAttribute('aria-current', run.id === state.selectedId ? 'true' : 'false');
    button.append(el('span', `session-status ${runKind(run.status)}`));
    const meta = el('span', 'session-meta');
    meta.append(el('strong', '', run.kind === 'app-project' ? run.title || "My app" : (run.kind === 'crm-frontend' ? 'CRM · ' : '') + modelName(run.model)), el('small', '', dateLabel(run.startedAt) || run.id));
    button.append(meta, el('span', 'session-arrow', '↗'));
    button.title = `${['build','scaffold'].includes(run.lastMode) ? "Local build · no AI" : modelName(run.model)} · ${statusLabel(run.status)}`;
    button.addEventListener('click', () => selectRun(run.id));
    fragment.append(button);
  }
  list.append(fragment);
  if (focusId) [...list.children].find(button => button.dataset.runId === focusId)?.focus({ preventScroll: true });
}

function renderActions() {
  $('open-usage').hidden = provider() !== 'openrouter';
  $('open-usage').disabled = !state.online || !state.status?.configured;
  const running = isRunning();
  const supported = state.status?.platformSupported !== false;
  $('start-run').disabled = state.busy || running || !state.online || !supported;
  $('model-select').disabled = state.busy || running || $('task-select').value === 'crm-frontend';
  $('task-select').disabled = state.busy || running;
  $('change-size').disabled = state.busy || running;
  $('planning-enabled').disabled = state.busy || running;
  $('planning-option').hidden = $('task-select').value !== 'app-project';
  $('build-size-picker').hidden = $('task-select').value !== 'app-project';
  $('open-model-matrix').hidden = $('task-select').value !== 'app-project';
  $('stop-run').hidden = !running;
  $('stop-run').disabled = state.busy;
  $('start-run').firstChild.textContent = state.busy && !running ? "Please wait " : "Build my app";
  $('new-run').disabled = state.busy;
  const project = $('task-select').value === 'app-project';
  const crm = $('task-select').value === 'crm-frontend';
  $('project-prompt').hidden = !project; $('prompt-label').hidden = !project;
  $('project-prompt').disabled = state.busy || running;
  $('open-project-settings').disabled = state.busy || running || runSummary()?.kind !== 'app-project';
  $('rebuild-project').disabled = state.busy || running || runSummary()?.kind !== 'app-project';
  $('start-run').firstChild.textContent = project ? (runSummary()?.kind === 'app-project' ? "Update app " : "Build my app ") : "Build my app";
  $('workspace-title').textContent = project ? (runSummary()?.kind === 'app-project' ? runSummary().title || "My app" : "My app") : crm ? "Build CRM app" : "HR model experiment";
  const shownCrm = state.selectedId ? runSummary()?.kind === 'crm-frontend' : crm;
  const shownProject = state.selectedId ? runSummary()?.kind === 'app-project' : project;
  $('project-outline').hidden = !shownProject; $('crm-outline').hidden = !shownCrm; $('hr-outline').hidden = shownCrm || shownProject; $('hr-checks').hidden = shownCrm || shownProject; $('scope-note').hidden = shownCrm || shownProject;
  $('open-preview').hidden = !(runSummary()?.previewReady || (runSummary()?.kind === 'crm-frontend' && runSummary()?.sourceSha256));
  const models = availableModels();
  const signature = JSON.stringify(models);
  if (signature !== state.modelSignature) {
    const previous = $('model-select').value;
    $('model-select').replaceChildren();
    for (const model of models) {
      const option = el('option', '', model.label || modelName(model.id)); option.value = model.id; $('model-select').append(option);
    }
    $('model-select').value = models.some(model => model.id === previous) ? previous : models.some(model => model.id === state.status?.modelId) ? state.status.modelId : models[0]?.id;
    state.modelSignature = signature;
  }
}

// Following is explicit: manual scrolling pauses it; only the jump button resumes it.
let conversationScrollFrame = null;
let programmaticConversationScroll = false;
let conversationScrollEndFrame = null;
function renderOutputFollow() {
  $('conversation-jump').hidden = state.followOutput || !state.newOutput || !state.selectedId;
}
function pauseOutputFollow() {
  if (!state.selectedId) return;
  state.followOutput = false;
  renderOutputFollow();
}
function moveConversationScroll(action) {
  programmaticConversationScroll = true;
  action();
  cancelAnimationFrame(conversationScrollEndFrame);
  conversationScrollEndFrame = requestAnimationFrame(() => { programmaticConversationScroll = false; });
}
function scrollConversationToLatest() {
  if (!state.followOutput || conversationScrollFrame !== null) return;
  conversationScrollFrame = requestAnimationFrame(() => {
    conversationScrollFrame = null;
    if (!state.followOutput || !state.selectedId || document.hidden) return;
    const scroller = $('conversation-scroll');
    moveConversationScroll(() => {
      if (getComputedStyle(scroller).overflowY === 'visible') {
        const latest = !$('build-error').hidden ? $('build-error') : $('run-outcome').hidden ? $('timeline').lastElementChild : $('run-outcome');
        latest?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      } else scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'instant' });
    });
  });
}
function resumeOutputFollow() {
  state.followOutput = true; state.newOutput = false;
  renderOutputFollow(); scrollConversationToLatest();
}


function renderBuildError() {
  const error = state.detail?.buildError;
  const visible = Boolean(error && !isRunning());
  $('build-error').hidden = !visible;
  $('repair-build').disabled = !visible || state.busy || !state.online;
  $('open-build-log').disabled = !error?.log;
  if (!visible) return;
  const retry = error.action === 'retry';
  $('build-error-title').textContent = error.title || "The app cannot be built yet";
  $('repair-build').textContent = retry ? ($('planning-enabled').checked?"Retry · 2 AI requests":"Retry · 1 AI request") : "Fix automatically · at most 1 AI request";
  $('build-error-hint').textContent = retry ? "Send the same request once more. Open Vibe Coder does not retry automatically." : "Edit the code yourself or choose one model-assisted fix for a small change. Nothing starts automatically; there is no retry chain.";
  $('build-error-details-title').textContent = retry ? "Request error details" : "Build log and details";
  $('build-error-log-hint').hidden = retry;
  $('open-build-log').hidden = retry;
  $('edit-build-code').hidden = retry;
  $('edit-build-code').disabled = state.busy;
  $('build-error-location').hidden = retry;
  $('build-error-location').textContent = error.file ? `${error.file} · line ${error.line}${error.column ? `:${error.column}` : ''}` : "Check the build log for the location.";
  $('build-error-message').textContent = error.explanation || error.message;
  if ($('build-error-log').textContent !== error.log) $('build-error-log').textContent = error.log;
}

function durationLabel(start, end) {
  const seconds=Math.floor((end-start)/1000), hours=Math.floor(seconds/3600);
  return (hours ? hours+':'+String(Math.floor(seconds/60)%60).padStart(2,'0') : String(Math.floor(seconds/60)).padStart(2,'0'))+':'+String(seconds%60).padStart(2,'0');
}
function renderTimelineTimers() {
  for (const node of document.querySelectorAll('.timeline-timer')) {
    const start=Date.parse(node.dataset.startedAt || '');
    const running=node.dataset.running==='true';
    const end=running?Date.now():Date.parse(node.dataset.finishedAt || '');
    node.hidden=!(Number.isFinite(start)&&Number.isFinite(end)&&end>=start);
    if (!node.hidden) {
      const text=(running?"Running · ":"Duration · ")+durationLabel(start,end);
      if(node.textContent!==text) node.textContent=text;
    }
  }
}
function renderRunTimer() {
  renderTimelineTimers();
  const node=$('run-timer'), summary=runSummary();
  const running=isRunning() && state.status?.activeRunId===state.selectedId;
  const latest=summary?.rounds?.at(-1);
  const start=Date.parse((running && state.status?.activeStartedAt) || summary?.lastStartedAt || latest?.startedAt || summary?.startedAt || '');
  const end=running ? Date.now() : Date.parse(summary?.finishedAt || latest?.finishedAt || '');
  const visible=Boolean(state.selectedId && Number.isFinite(start) && Number.isFinite(end) && end>=start);
  node.hidden=!visible;
  if (!visible) return;
  const time=durationLabel(start,end);
  const text=(running?"Running · ":"Duration · ")+time;
  if(node.textContent!==text) node.textContent=text;
  node.title=running?"Time since this request started, including waiting and building.":"Total duration of the last request, including waiting and building.";
}

function renderConversation() {
  renderRunTimer();
  const summary = runSummary();
  const conversationKey = JSON.stringify([state.selectedId, summary, isRunning() && state.status?.activeRunId === state.selectedId, summary?.model || state.status?.modelId]);
  if (state.conversationProject !== state.selectedId) {
    state.conversationProject = state.selectedId;
    state.followOutput = true; state.newOutput = false;
  } else if (!state.followOutput && state.conversationKey !== conversationKey) state.newOutput = true;
  renderOutputFollow();
  scrollConversationToLatest();
  if (state.conversationKey === conversationKey) return;
  const scrollTop = $('conversation-scroll').scrollTop, pageTop = window.scrollY;
  state.conversationKey = conversationKey;
  const project = summary?.kind === 'app-project';
  const crm = summary?.kind === 'crm-frontend';
  $('project-preview').hidden = !(project && summary?.previewReady);
  $('project-preview').textContent = summary?.previewFromPrevious ? "Open previous working version" : "Open my app";
  $('open-preview').textContent = summary?.status === 'build-failed' ? "View rejected draft" : "Open built app";
  document.querySelector('.message-tag').textContent = project ? "Your project · React + Tailwind" : "Fixed experiment contract · fictional accounts";
  $('run-task').textContent = project ? (summary?.prompt || "Create a working React/Tailwind scaffold.") : crm ? "Build a responsive CRM app for the Trimedixs practice API." : "Implement leave requests and approvals with permissions and balances.";
  $('open-preview').hidden = !(summary?.previewReady || (crm && summary?.sourceSha256));
  $('welcome').hidden = Boolean(state.selectedId);
  $('run-conversation').hidden = !state.selectedId;
  const runningSelected = isRunning() && state.status?.activeRunId === state.selectedId;
  const label = runningSelected ? "Building app" : statusLabel(summary?.status);
  $('run-status').textContent = state.selectedId ? label : "Ready to start";
  $('run-status').className = `run-status ${runningSelected ? 'running' : runKind(summary?.status)}`;
  if (!state.selectedId) return;
  $('run-date').textContent = dateLabel(summary?.startedAt, true);
  $('run-date').dateTime = summary?.startedAt || '';
  $('run-model-label').textContent = ['build','scaffold'].includes(summary?.lastMode) ? "Local build · no AI" : modelName(summary?.model || state.status?.modelId);
  $('run-intro').textContent = runningSelected && summary?.rounds?.at(-1)?.planning?.status==='started' ? `Reasoning · ${modelName(summary.rounds.at(-1).planning.model)} is preparing a brief build plan. The builder has not started yet.` : runningSelected
    ? project && ['build','scaffold'].includes(summary?.lastMode || summary?.rounds?.at(-1)?.mode) ? "Open Vibe Coder is building the project scaffold locally. No model is called." : project ? `${modelName(summary?.model)} is working on ${summary?.buildPlan?.format === 'edits' ? "a targeted patch" : "your app"}. Open Vibe Coder then builds locally.` : crm ? "Nemotron is building the CRM frontend. Open Vibe Coder saves the output and checks the files; browser behavior is tested separately." : "The model is building the backend locally. The runner performs the same checks after each round."
    : summary ? "This is your project history. View code, build output, and preview on the right." : "Loading the task report.";
  const rounds = Array.isArray(summary?.rounds) ? summary.rounds : [];
  const timeline = $('timeline');
  timeline.replaceChildren();
  if (!rounds.length && runningSelected) addTimeline('running', crm ? "Generate CRM app" : "Prepare task", crm ? "The single Nemotron request is running. Open Vibe Coder waits up to five minutes for the complete response." : "Preparing the sandboxed workspace and model connection.");
  for (const round of rounds) {
    if (round.planning) {
      const preparation=round.planning;
      const result=preparation.result;
      const body=addTimeline(preparation.status==='passed'?'passed':preparation.status==='failed'?'failed':'running',"Planning · Understand request",preparation.error || result?.goal || "The planner reviews your request and project structure. The builder waits for the plan.",preparation.startedAt,{finishedAt:preparation.finishedAt,running:runningSelected && round===rounds.at(-1) && preparation.status==='started'});
      body.classList.add('planning-body');
      body.append(el('small','',modelName(preparation.model)+" · additional free request · brief build plan"));
      if(result) {
        const details=el('details','planning-details');
        details.open=round===rounds.at(-1);
        details.append(el('summary','',"View build plan"));
        details.append(el('p','',result.approach));
        details.append(el('strong','','Omvang: '+(result.scope==='small'?"targeted change":"broader change")));
        const paths=el('ul','planning-files');for(const path of result.files)paths.append(el('li','',path));details.append(paths);
        details.append(el('strong','',"Checks after building"));
        const checks=el('ul','planning-checks');for(const check of result.checks)checks.append(el('li','',check));details.append(checks);
        body.append(details);
      }
      if(preparation.status!=='passed')continue;
    }
    const phase = round.phase === 'project' ? (round.mode === 'build' ? "Rebuild" : round.mode === 'scaffold' ? "Create scaffold" : "Build or update app") : round.phase === 'crm' ? "Build CRM frontend" : round.phase === 'wijziging' ? "Change: half days" : "Baseline: leave and approval";
    const repair = Number(round.attempt) > 0 ? ` · repair round ${round.attempt}` : '';
    const kind = runKind(round.status);
    let detail = round.status === 'passed' ? (project ? "The React/Tailwind build passed. Open the app and test your workflow." : crm ? "All four file checks passed; browser behavior is tested separately." : "The fixed acceptance checks passed in this round.")
      : round.status === 'failed' ? "Some checks failed."
      : round.status === 'generation-error' ? "This round produced no usable model output."
      : runningSelected ? "The model is working on your request; results follow after validation."
      : "No completed test result was recorded for this round.";
    if (round.prompt && project) detail = round.prompt + ' — ' + detail;
    if (round.error) detail = String(round.error);
    if (round.timedOut) detail += " Local execution reached its time limit.";
    addTimeline(kind === 'running' && !runningSelected ? 'failed' : kind, phase + repair, detail, round.buildStartedAt || round.startedAt, {finishedAt:round.finishedAt, running:runningSelected && round===rounds.at(-1) && kind==='running'});
  }
  renderTimelineTimers();
  const finished = summary && !runningSelected && !['queued', 'started', 'running'].includes(summary.status);
  $('run-outcome').hidden = !finished;
  $('run-outcome').className = `run-outcome${!['passed', 'built', 'edited'].includes(summary?.status) ? ' failed' : ''}`;
  $('run-outcome').textContent = project && summary?.status === 'edited' ? "Your source code was saved. Rebuild the app to see the changes in the preview." : summary?.status === 'built' ? project ? "Your app was built. Open the preview and check the requested features. You can edit files or submit another request below." : "The app was built and all four file checks passed. Open it for browser testing; this does not yet prove that all features work." : summary?.status === 'passed'
    ? "Both phases passed within this experiment. This result applies to the backend task; it does not evaluate a complete HR app."
    : summary?.error ? String(summary.error) : crm ? "Some file checks failed. Review Test output and the rejected draft; no automatic repair was attempted." : "The experiment ended without both phases passing. Check the code and test output for the cause.";

  if (!state.followOutput) moveConversationScroll(() => {
    if (getComputedStyle($('conversation-scroll')).overflowY === 'visible') window.scrollTo({ top: pageTop, behavior: 'instant' });
    else $('conversation-scroll').scrollTo({ top: scrollTop, behavior: 'instant' });
  });
}

function addTimeline(kind, title, detail, startedAt, timing = {}) {
  const item = el('div', `timeline-item ${kind}`);
  const dot = el('span', 'timeline-dot', kind === 'passed' ? '✓' : kind === 'failed' ? '·' : '');
  dot.setAttribute('aria-hidden', 'true');
  const body = el('div', 'timeline-body');
  const heading=el('div','timeline-heading');
  heading.append(el('strong','',title));
  if (startedAt) {
    const timer=el('span','timeline-timer');
    timer.dataset.startedAt=startedAt; timer.dataset.finishedAt=timing.finishedAt || ''; timer.dataset.running=String(Boolean(timing.running));
    timer.hidden=true; heading.append(timer);
  }
  body.append(heading, el('p', '', detail));
  if (startedAt) body.append(el('small', '', dateLabel(startedAt)));
  item.append(dot, body); $('timeline').append(item);
  return body;
}

function renderMetrics() {
  const summary = runSummary();
  $('metrics-section').hidden = !summary;
  if (!summary) return;
  $('metrics').replaceChildren();
  const rounds = Array.isArray(summary.rounds) ? summary.rounds : [];
  const passedPhases = new Set(rounds.filter(round => round.status === 'passed').map(round => round.phase)).size;
  const isCloudflare = summary.provider === 'cloudflare' || String(summary.model).startsWith('@cf/');
  for (const [value, label] of [
    [['crm-frontend', 'app-project'].includes(summary.kind) ? `${summary.fileChecks?.filter(item => item.pass).length || 0} / ${summary.kind === 'app-project' ? 1 : 4}` : `${passedPhases} / 2`, summary.kind === 'app-project' ? "Latest production build" : summary.kind === 'crm-frontend' ? "File checks" : "Phases passed"],
    [numberLabel(summary.modelCalls), "Model requests"],
    ...(isCloudflare ? [[numberLabel(summary.estimatedNeurons, 1), "Neurons · estimated"]] : [[summary.modelCalls > (summary.tokenUsage?.length || 0) ? '—' : numberLabel(summary.tokenUsage?.reduce((total, usage) => total + (Number(usage?.total_tokens) || 0), 0)), "Tokens · reported by API"]]),
    [numberLabel(rounds.filter(round => Number(round.attempt) > 0).length), "Repair rounds"],
  ]) {
    const metric = el('div', 'metric'); metric.append(el('div', 'metric-value', value), el('div', 'metric-label', label)); $('metrics').append(metric);
  }
  const usageNote = !isCloudflare ? (summary.model === 'openrouter/free' ? "The free router selects an available model." : "A specific free OpenRouter model was requested.") + " One build task uses multiple model requests." : summary.actualNeurons !== null && summary.actualNeurons !== undefined
    ? `Actual usage: ${numberLabel(summary.actualNeurons, 1)} neurons.`
    : "Neurons are estimated from token usage. The Cloudflare dashboard remains the source for actual usage.";
  const reportedModels = summary.returnedModels || summary.actualModels;
  const actualModels = Array.isArray(reportedModels) ? reportedModels.filter(model => typeof model === 'string') : [];
  $('metric-note').textContent = (summary.kind === 'app-project' ? "React/Tailwind project. With planning: at most two free requests per task; without planning: one. Rebuilding uses no AI. A successful build does not prove correct behavior." + (summary.modelCalls > (summary.tokenUsage?.length || 0) ? " Usage for the last request has not been reported or is unknown." : '') : summary.kind === 'crm-frontend' ? `One model request, no automatic retry. Reported cost: ${summary.tokenUsage?.[0]?.cost === 0 ? '$0' : "not yet known"}. Browser testing is separate.` : usageNote) + (actualModels.length ? ` Actual usage: ${actualModels.join(', ')}.` : '');
  if (summary.kind === 'app-project' && summary.buildPlan) $('metric-note').textContent += ` Build choice: ${summary.buildPlan.size === 'small' ? "small patch" : "large change"}. ${summary.buildPlan.reason} Source context: ${numberLabel(summary.buildPlan.sourceCharacters)} of ${numberLabel(summary.buildPlan.totalSourceCharacters)} characters; output limit ${numberLabel(summary.buildPlan.maxTokens)} tokens. Omitted files: ${summary.buildPlan.omitted.length}.`;
  if (summary.heuristics?.length) $('metric-note').textContent += " Local heuristics, without additional AI: "+summary.heuristics.map(h=>h.details || h.description || h.id).join(' ');
}

function files() { return Array.isArray(state.detail?.files) ? state.detail.files.filter(file => typeof file.path === 'string') : []; }
function treeSvg(className, paths) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', className); svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
  for (const d of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d); svg.append(path);
  }
  return svg;
}

function treeFileIcon(name) {
  const code = /\.(jsx?|json|css|html)$/.test(name);
  return treeSvg(`tree-file-icon${code ? ' code-file' : ''}`, [
    'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z',
    'M14 3v6h6',
    ...(code ? ['m9 12-2 3 2 3m6-6 2 3-2 3'] : ['M8 13h8m-8 4h6']),
  ]);
}

function renderFileTree(available) {
  const list = $('file-list');
  const focused = document.activeElement?.closest('[data-node-path]')?.dataset.nodePath;
  const root = { children: new Map() };
  for (const file of available) {
    const parts = file.path.startsWith('project/') ? file.path.split('/') : ["Reports", ...file.path.split('/')];
    let parent = root;
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index];
      if (!parent.children.has(part)) parent.children.set(part, { name: part, nodePath: parts.slice(0, index + 1).join('/'), children: new Map() });
      parent = parent.children.get(part);
      if (index === parts.length - 1) parent.file = file;
    }
  }
  function append(parent, container, level) {
    const nodes = [...parent.children.values()].sort((a, b) => Number(Boolean(a.file)) - Number(Boolean(b.file)) || a.name.localeCompare(b.name));
    for (const node of nodes) {
      const folder = !node.file;
      const key = `${state.selectedId}:${node.nodePath}`;
      const expanded = !state.collapsedFolders.has(key);
      const item = el('div', 'tree-item');
      item.dataset.nodePath = node.nodePath; item.dataset.folder = String(folder);
      item.setAttribute('role', 'treeitem'); item.setAttribute('aria-level', String(level)); item.setAttribute('aria-label', node.name === 'project' ? 'Project' : node.name);
      item.tabIndex = focused === node.nodePath ? 0 : -1;
      if (folder) item.setAttribute('aria-expanded', String(expanded));
      else item.setAttribute('aria-selected', String(state.filePath === node.file.path));
      const row = el('button', `tree-row${!folder && state.filePath === node.file.path ? ' selected' : ''}`);
      row.type = 'button'; row.tabIndex = -1; row.title = folder ? node.nodePath : node.file.path;
      row.style.paddingLeft = `${8 + (level - 1) * 18}px`;
      const toggle = folder ? treeSvg(`tree-chevron${expanded ? ' expanded' : ''}`, ['m9 5 7 7-7 7']) : el('span', 'tree-chevron-space');
      toggle.setAttribute('aria-hidden', 'true');
      const icon = folder ? treeSvg('tree-folder-icon', expanded
        ? ['M3 9V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v2', 'M3 9h18l-3 11H2Z']
        : ['M3 7V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z']) : treeFileIcon(node.name);
      row.append(toggle, icon, el('span', 'tree-name', node.name === 'project' ? 'Project' : node.name));
      if (!folder) row.append(el('span', 'file-size', sizeLabel(node.file.size)));
      row.addEventListener('click', () => {
        if (folder) { if (expanded) state.collapsedFolders.add(key); else state.collapsedFolders.delete(key); renderFiles(); const target = [...list.querySelectorAll('[role=treeitem]')].find(value => value.dataset.nodePath === node.nodePath); target?.focus(); }
        else { state.filePath = node.file.path; renderFiles(); loadFile(node.file.path); }
      });
      item.append(row);
      if (folder) { const group = el('div', 'tree-group'); group.setAttribute('role', 'group'); group.hidden = !expanded; append(node, group, level + 1); item.append(group); }
      container.append(item);
    }
  }
  list.replaceChildren(); append(root, list, 1);
  const items = [...list.querySelectorAll('[role=treeitem]')].filter(item => !item.closest('[hidden]'));
  const target = items.find(item => item.dataset.nodePath === focused);
  if (target) target.focus(); else if (items.length) items[0].tabIndex = 0;
}
$('file-list').addEventListener('keydown', event => {
  const current = event.target.closest('[role=treeitem]'); if (!current) return;
  const visible = [...$('file-list').querySelectorAll('[role=treeitem]')].filter(item => !item.closest('[hidden]'));
  const index = visible.indexOf(current); let next;
  if (event.key === 'ArrowDown') next = visible[Math.min(index + 1, visible.length - 1)];
  if (event.key === 'ArrowUp') next = visible[Math.max(index - 1, 0)];
  if (event.key === 'Home') next = visible[0];
  if (event.key === 'End') next = visible.at(-1);
  if (event.key === 'ArrowRight') { if (current.getAttribute('aria-expanded') === 'false') current.querySelector('button').click(); else if (current.dataset.folder === 'true') next = visible[index + 1]; }
  if (event.key === 'ArrowLeft') { if (current.getAttribute('aria-expanded') === 'true') current.querySelector('button').click(); else next = current.parentElement.closest('[role=treeitem]'); }
  if (event.key === 'Enter' || event.key === ' ') current.querySelector('button').click();
  if (next) { current.tabIndex = -1; next.tabIndex = 0; next.focus(); }
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' '].includes(event.key)) event.preventDefault();
});

function renderFiles() {
  const available = files();
  const project = runSummary()?.kind === 'app-project';
  $('new-file-row').hidden = !project;
  $('file-count').textContent = String(available.length);
  $('file-count').hidden = !available.length;
  $('files-empty').hidden = available.length > 0;
  $('file-browser').hidden = !available.length;
  if (!available.length) return;
  renderFileTree(available);
  $('file-name').textContent = state.filePath || "Choose a file";
  const portalEntry = state.filePath === 'project/src/App.jsx' && state.fileCache.get(`${state.selectedId}:${state.filePath}`)?.includes('// BIM-APP-SHELL v1');
  const editable = project && !portalEntry && !state.filePath?.startsWith('project/src/studio/') && !['project/src/main.jsx', 'project/src/tailwind.css'].includes(state.filePath) && /^project\/(src\/.+\.(jsx|js|css|json)|README\.md)$/.test(state.filePath || '');
  const hasEditor = Boolean(window.bimCodeEditor);
  $('file-editor').hidden = hasEditor || !editable; $('file-content').hidden = hasEditor || editable; $('code-editor').hidden = !hasEditor; $('save-file').hidden = !editable;
  $('format-file').hidden = !editable || !/\.(jsx|js|json|css|html|md)$/.test(state.filePath || '') || !hasEditor;
  $('format-file').disabled = isRunning();
  $('file-mode').textContent = editable ? "Editable · save and rebuild" : "Read only";
  $('file-editor').disabled = isRunning(); $('save-file').disabled = state.busy || isRunning();
  if (state.filePath) {
    const cached = state.fileCache.get(`${state.selectedId}:${state.filePath}`);
    $('file-content').textContent = cached ?? "Loading file…";
    const source = state.drafts.get(`${state.selectedId}:${state.filePath}`) ?? cached ?? '';
    if ($('file-editor').value !== source) $('file-editor').value = source;
    window.bimCodeEditor?.update({ text: source, filePath: state.filePath, readOnly: !editable || isRunning() });
    if (state.tab === 'files' && cached === undefined) loadFile(state.filePath);
  } else { $('file-content').textContent = "Select a file above to view its contents."; window.bimCodeEditor?.update({ text: "Select a file above to view its contents.", filePath: '', readOnly: true }); }
}

function renderTests() {
  const testFiles = (state.detail?.buildError?.action === 'retry' ? [] : files()).filter(file => /(^|\/)tests\.tap$/.test(file.path));
  $('tests-empty').hidden = testFiles.length > 0;
  $('test-results').hidden = !testFiles.length;
  if (testFiles.length) {
    if (!testFiles.some(file => file.path === state.testPath)) state.testPath = testFiles.at(-1).path;
    $('test-select').replaceChildren();
    for (const file of testFiles) {
      const option = el('option', '', file.path.replace('/tests.tap', '').replace('basis-', "Baseline · round ").replace('wijziging-', "Change · round "));
      option.value = file.path; option.selected = file.path === state.testPath; $('test-select').append(option);
    }
    const cached = state.fileCache.get(`${state.selectedId}:${state.testPath}`);
    $('test-output').textContent = cached ?? "Loading test output…";
    if (state.tab === 'tests' && cached === undefined) loadFile(state.testPath, true);
  }
  const log = typeof state.detail?.log === 'string' ? state.detail.log : '';
  $('runner-output').hidden = !log;
  $('runner-log').textContent = log;
}

function renderProjectContext() {
  const build = state.status?.builtAt;
  const version = state.status?.appVersion;
  const versionLabel = version ? `Version ${version}` : "Version";
  if (build && !Number.isNaN(Date.parse(build))) {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(build));
    const part = type => parts.find(value => value.type === type)?.value;
    $('build-version').textContent = `${versionLabel} · ${part('day')}/${part('month')}/${part('year')} ${part('hour')}:${part('minute')}`;
  } else $('build-version').textContent = version ? `${versionLabel} · development` : "Development version";
  const summary = runSummary();
  const name = summary?.kind === 'app-project' ? summary.projectName || summary.title || "My app" : summary ? "Model experiment" : "No project open";
  $('active-project-name').textContent = name;
  $('active-project-path').textContent = summary?.projectPath || (summary ? "Local Open Vibe Coder directory" : "Start a new project");
  $('active-project-path').title = summary?.projectPath || '';
  $('project-breadcrumb').textContent = summary ? name : "My workspace";
}
function render() {
  renderProjectContext();
  renderConnection(); renderNotice(); renderSessions(); renderActions(); renderBuildError(); renderConversation(); renderMetrics(); renderFiles(); renderTests(); renderUiPreview();
}

async function loadFile(path, test = false) {
  if (!state.selectedId) return;
  const id = state.selectedId;
  const key = `${id}:${path}`;
  if (state.pendingFiles.has(key)) return;
  state.pendingFiles.add(key);
  try {
    const response = await clientFetch(`/api/runs/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`);
    if (!response.ok) throw new Error("The file could not be loaded.");
    const content = await response.text();
    state.fileCache.set(key, content);
    if (id === state.selectedId) {
      if (test && path === state.testPath) $('test-output').textContent = content;
      if (path === state.filePath) { $('file-content').textContent = content; renderFiles(); }
    }
  } catch (error) {
    if (id === state.selectedId) {
      if (test && path === state.testPath) $('test-output').textContent = error.message;
      if (path === state.filePath) $('file-content').textContent = error.message;
    }
  } finally { state.pendingFiles.delete(key); }
}

async function loadDetail() {
  if (!state.selectedId || !state.online) return;
  const id = state.selectedId;
  try {
    const detail = await api(`/api/runs/${encodeURIComponent(id)}`);
    if (id !== state.selectedId) return;
    const version = value => JSON.stringify([value?.summary?.status, value?.summary?.finishedAt, value?.summary?.modelCalls, value?.files?.map(file => [file.path,file.size])]);
    if (version(detail) !== version(state.detail)) {
      for (const key of state.fileCache.keys()) if (key.startsWith(id + ':')) state.fileCache.delete(key);
    }
    state.detail = detail; state.detailError = null;
    renderProjectContext(); renderBuildError(); renderConversation(); renderMetrics(); renderFiles(); renderTests(); renderUiPreview(); renderNotice();
  } catch (error) {
    if (id !== state.selectedId) return;
    state.detailError = error.message; renderNotice();
  }
}

async function selectRun(id) {
  try { localStorage.setItem('bim-studio-project', id); } catch {}
  state.selectedId = id; state.selectionIsNew = false; state.detail = null;
  state.detailError = null; state.filePath = null; state.testPath = null;
  $('file-content').textContent = "Select a file above to view its contents.";
  render(); await loadDetail();
}

async function refresh() {
  if (state.polling) return;
  state.polling = true;
  try {
    const previousProvider = provider(), previouslyConfigured = state.status?.configured, wasRunning = isRunning();
    const status = await api('/api/status');
    state.status = status; state.online = true; state.loaded = true;
    if (!state.catalogueAt || Date.now() - state.catalogueAt > 300000) loadModels().catch(() => {});
    if (previousProvider !== provider() || previouslyConfigured !== status.configured) resetUsage();
    if (!state.selectedId && !state.selectionIsNew) {
      try { const saved = localStorage.getItem('bim-studio-project'); if (status.runs.some(run => run.id === saved)) state.selectedId = saved; } catch {}
    }
    if (!state.selectedId && !state.selectionIsNew && status.activeRunId) state.selectedId = status.activeRunId;
    render();
    if (provider() === 'openrouter' && status.configured) readUsage(wasRunning && !isRunning()).catch(() => {});
    if (state.selectedId) await loadDetail();
  } catch {
    state.online = false; state.loaded = true; render();
  } finally {
    state.polling = false;
    clearTimeout(state.pollTimer);
    state.pollTimer = setTimeout(refresh, isRunning() && state.online ? 1500 : 5000);
  }
}

async function startRun(promptOverride, skipPlanning = false) {
  if (state.busy || isRunning() || !state.online || state.status?.platformSupported === false) return;
  if ($('task-select').value === 'app-project' && runSummary()?.kind !== 'app-project') { openProjectWizard(); return; }
  if (!state.status?.configured) { openSettings(); return; }
  state.busy = true; renderActions();
  try {
    const modelId = $('model-select').value;
    if (!availableModels().some(model => model.id === modelId)) throw new Error("Choose a model from the free profile.");
    if ($('task-select').value === 'app-project' && [...state.drafts.keys()].some(key => key.startsWith(state.selectedId + ':'))) throw new Error("Save your changed files first.");
    const target = $('task-select').value === 'app-project' && runSummary()?.kind === 'app-project' ? `/api/runs/${encodeURIComponent(state.selectedId)}/improve` : '/api/runs';
    const prompt = typeof promptOverride === 'string' ? promptOverride : $('project-prompt').value;
    const result = await api(target, { method: 'POST', body: JSON.stringify({ modelId, kind: $('task-select').value, prompt, changeSize: $('change-size').value, planningEnabled: !skipPlanning && $('planning-enabled').checked }) });
    if ($('project-prompt').value === prompt) $('project-prompt').value = '';
    state.status.runState = 'running'; state.status.activeRunId = result.id; state.status.activeStartedAt = result.startedAt;
    await selectRun(result.id);
    toast("The task started. Follow its progress here.");
    await refresh();
  } catch (error) { toast(error.message); }
  finally { state.busy = false; renderActions(); }
}

async function stopRun() {
  const id = state.status?.activeRunId;
  if (!id || state.busy) return;
  state.busy = true; renderActions();
  try {
    await api(`/api/runs/${encodeURIComponent(id)}/stop`, { method: 'POST' });
    toast("Stop requested. The running task will be terminated.");
    await refresh();
  } catch (error) { toast(error.message); }
  finally { state.busy = false; renderActions(); }
}

function openSettings() {
  $('settings-message').hidden = true;
  $('settings-message').textContent = '';
  $('configured-note').hidden = !state.status?.configured;
  $('provider-select').value = 'openrouter';
  renderProviderForm();
  if (!$('settings-dialog').open) $('settings-dialog').showModal();
  $('provider-select').focus();
}
function closeSettings() {
  $('settings-dialog').close();
  $('settings-form').reset();
  $('settings-message').textContent = '';
}
async function saveSettings(event) {
  event.preventDefault();
  const accountId = $('account-id').value.trim();
  const token = $('api-token').value.trim();
  const selectedProvider = $('provider-select').value;
  if (!token || (selectedProvider === 'cloudflare' && !accountId)) return;
  $('save-settings').disabled = true;
  $('settings-message').hidden = true;
  try {
    await api('/api/config', { method: 'POST', body: JSON.stringify({ provider: selectedProvider, ...(selectedProvider === 'cloudflare' ? { accountId } : {}), token }) });
    $('api-token').value = ''; state.connectionVerified = false;
    await testConnection();
    resetUsage(); closeSettings(); toast("OpenRouter connected. Choose a free model and start building."); await refresh();
  } catch (error) {
    let safeMessage = String(error.message).split(token).join('[verborgen]');
    if (accountId) safeMessage = safeMessage.split(accountId).join('[account]');
    $('settings-message').textContent = safeMessage;
    $('settings-message').hidden = false;
  } finally { $('save-settings').disabled = false; }
}

function renderProviderForm() {
  const cloudflare = $('provider-select').value === 'cloudflare';
  $('settings-title').textContent = `Connect to ${cloudflare ? 'Cloudflare' : 'OpenRouter'}`;
  $('account-field').hidden = !cloudflare;
  $('account-id').required = cloudflare;
  $('account-id').disabled = !cloudflare;
  $('token-label').textContent = cloudflare ? "Workers AI API token" : "OpenRouter API key";
  $('api-token').placeholder = cloudflare ? "Paste your API token" : "Paste your API key";
  $('token-hint').textContent = cloudflare ? "Use the Workers AI template with Read and Edit permissions for this account." : "Use your own OpenRouter API key. Free models only; no paid fallback.";
  $('provider-quota').textContent = cloudflare ? "Workers Free: 10,000 neurons per day. Usage depends on the model and tokens; the free limit blocks further requests." : "Only current free OpenRouter models. Account limits and availability vary. Testing the connection does not use a model request.";
  $('configured-note').textContent = cloudflare ? "A local connection is already configured. Enter the account ID and token to replace it." : "A local connection is already configured. Enter an API key to replace it.";
  $('api-token').value = '';
  $('settings-message').hidden = true;
}

function selectTab(tab, focus = false) {
  state.tab = tab;
  for (const name of ['overview', 'files', 'tests', 'preview']) {
    const active = name === tab;
    $(`tab-${name}`).setAttribute('aria-selected', String(active));
    $(`tab-${name}`).tabIndex = active ? 0 : -1;
    $(`tab-${name}`).classList.toggle('active', active);
    $(`panel-${name}`).hidden = !active;
  }
  if (focus) $(`tab-${tab}`).focus();
  if (tab === 'files') renderFiles();
  if (tab === 'tests') renderTests();
  if (tab === 'preview') renderUiPreview();
}

let uiPreviewKey = null;
let uiPreviewRequest = 0;
async function renderUiPreview(force = false) {
  if (state.tab !== 'preview') return;
  const summary = runSummary();
  const building = isRunning() && state.status?.activeRunId === state.selectedId;
  $('preview-builder').hidden = !building;
  const localBuild = ['build', 'scaffold'].includes(summary?.lastMode);
  $('builder-title').textContent = localBuild ? "Open Vibe Coder is assembling your app" : "The model is building your app";
  const ready = summary?.kind === 'app-project' && summary.previewReady && !isRunning();
  $('refresh-ui-preview').disabled = !ready;
  $('external-ui-preview').disabled = !ready;
  if (!ready) {
    uiPreviewRequest++; uiPreviewKey = null;
    $('ui-preview-stage').hidden = true; $('ui-preview-frame').removeAttribute('src');
    $('ui-preview-message').textContent = building ? (localBuild ? "Open Vibe Coder is building your app locally…" : "The model is working on your request…") : "Build your app to see the latest UI here.";
    return;
  }
  const key = `${state.selectedId}:${summary.finishedAt}:${summary.status}`;
  if (!force && key === uiPreviewKey) return;
  uiPreviewKey = key; const request = ++uiPreviewRequest;
  $('ui-preview-message').textContent = "Loading preview…";
  try {
    const { url } = await api(`/api/runs/${encodeURIComponent(state.selectedId)}/preview`);
    if (request !== uiPreviewRequest) return;
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') throw new Error("Invalid preview location.");
    $('ui-preview-frame').src = url;
    $('ui-preview-stage').hidden = false;
    $('ui-preview-message').textContent = summary.previewFromPrevious ? "Previous working version. The latest build task failed." : "Built app · changes appear after rebuilding.";
  } catch (error) { if (request === uiPreviewRequest) { uiPreviewKey = null; $('ui-preview-stage').hidden = true; $('ui-preview-message').textContent = error.message; } }
}
$('refresh-ui-preview').addEventListener('click', () => renderUiPreview(true));
$('external-ui-preview').addEventListener('click', async () => {
  // Open a blank tab synchronously in the webpilot so popup blockers do not interfere.
  const external = window.bimDesktop ? null : window.open('about:blank', '_blank');
  if (external) external.opener = null;
  try {
    if (window.bimDesktop) await window.__TAURI__.core.invoke('open_run_browser', { id: state.selectedId });
    else { const { url } = await api(`/api/runs/${encodeURIComponent(state.selectedId)}/preview`); if (!external) throw new Error("Allow pop-ups to open the preview separately."); external.location.replace(url); }
  } catch (error) { external?.close(); toast(String(error.message || error)); }
});
for (const button of document.querySelectorAll('[data-viewport]')) {
  if (button.tagName !== 'BUTTON') continue;
  button.addEventListener('click', () => {
    $('ui-preview-stage').dataset.viewport = button.dataset.viewport;
    for (const other of document.querySelectorAll('.viewport-buttons button')) other.setAttribute('aria-pressed', String(other === button));
  });
}
const splitter = $('workspace-splitter');
const workspace = document.querySelector('.workspace');
let reportPercent = 35;
try { const saved = Number(localStorage.getItem('bim-studio-report-width')); if (saved >= 25 && saved <= 75) reportPercent = saved; } catch {}
function setReportWidth(value, persist = false) {
  const width = workspace.getBoundingClientRect().width;
  const maximum = Math.max(25, Math.min(75, (1 - 300 / Math.max(width, 1)) * 100));
  reportPercent = Math.max(25, Math.min(maximum, value));
  workspace.style.setProperty('--report-width', `${reportPercent}%`);
  splitter.setAttribute('aria-valuenow', String(Math.round(reportPercent)));
  if (persist) { try { localStorage.setItem('bim-studio-report-width', String(reportPercent)); } catch {} }
}
setReportWidth(reportPercent);
splitter.addEventListener('pointerdown', event => { if (event.button !== 0) return; splitter.setPointerCapture(event.pointerId); document.body.classList.add('resizing-workspace'); event.preventDefault(); });
splitter.addEventListener('pointermove', event => { if (!splitter.hasPointerCapture(event.pointerId)) return; const rect = workspace.getBoundingClientRect(); setReportWidth((rect.right - event.clientX) / rect.width * 100); });
function stopResize(event) { if (splitter.hasPointerCapture(event.pointerId)) { splitter.releasePointerCapture(event.pointerId); setReportWidth(reportPercent, true); } document.body.classList.remove('resizing-workspace'); }
splitter.addEventListener('pointerup', stopResize); splitter.addEventListener('pointercancel', stopResize);
splitter.addEventListener('keydown', event => { const delta = event.shiftKey ? 10 : 2; if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setReportWidth(reportPercent + (event.key === 'ArrowLeft' ? delta : -delta), true); } if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); setReportWidth(event.key === 'Home' ? 25 : 75, true); } });
splitter.addEventListener('dblclick', () => setReportWidth(35, true));
window.addEventListener('resize', () => { if (window.innerWidth > 960) setReportWidth(reportPercent); });

function projectSlug(name) {
  return name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}
function openProjectWizard() {
  if (state.busy || isRunning()) { toast("Wait for the current build task to finish."); return; }
  state.wizard = { step: 1, folderId: null, path: state.status?.defaultProjectRoot || null };
  $('project-form').reset(); $('project-folder').value = state.wizard.path || "Default Open Vibe Coder project directory";
  $('choose-folder').disabled = !window.bimDesktop;
  $('folder-hint').textContent = window.bimDesktop ? "Choose the full project location, including the directory name. Open Vibe Coder does not append a directory name." : "The web app uses the default Open Vibe Coder project directory. Choose another location in the desktop app.";
  renderWizard(); $('project-dialog').showModal(); $('project-name').focus();
}
function renderWizard() {
  const review = state.wizard.step === 2;
  $('wizard-step-label').textContent = review ? '2 / 2' : '1 / 2';
  $('wizard-details').hidden = review; $('wizard-review').hidden = !review;
  $('project-back').textContent = review ? "← Back" : "Cancel";
  $('project-submit').textContent = review ? "Create project" : "Next →";
  $('project-message').hidden = true;
  $('review-name').textContent = $('project-name').value.trim();
  $('review-path').textContent = state.wizard.target || "Checking location…";
}
let projectSettingsId = null;
let savedSupabase = null;
function renderProjectSchema(schema) {
  const container = $('project-schema-tables'); container.replaceChildren(); $('schema-setup').hidden = true;
  $('project-schema-message').textContent = schema ? `${schema.tables.length} tables/views found · fetched ${dateLabel(schema.fetchedAt, true)}. No tables? Check Data API and table permissions.` : "No schema fetched for this connection yet. Save changed connections, then reopen this screen.";
  for (const table of schema?.tables || []) {
    const details = el('details', 'schema-table'); details.append(el('summary', '', `${table.name} · ${table.columns.length} columns`));
    const list = el('ul'); for (const column of table.columns) list.append(el('li', '', `${column.name}: ${column.format || column.type}${column.required ? " · required" : ''}`));
    details.append(list); container.append(details);
  }
}
function updateSchemaButton() { $('fetch-project-schema').disabled = !savedSupabase?.url || !savedSupabase?.key || $('supabase-url').value !== savedSupabase.url || $('supabase-key').value !== savedSupabase.key; }
$('copy-schema-sql').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('schema-setup-sql').value); toast("SQL copied. Run it once in your Supabase project's SQL editor."); } catch { $('schema-setup-sql').focus(); $('schema-setup-sql').select(); toast("Select and copy the displayed SQL."); } });
for (const id of ['supabase-url', 'supabase-key']) $(id).addEventListener('input', updateSchemaButton);
$('fetch-project-schema').addEventListener('click', async () => {
  $('fetch-project-schema').disabled = true; $('project-schema-message').textContent = "Fetching available tables and columns…";
  try { renderProjectSchema(await api(`/api/runs/${encodeURIComponent(projectSettingsId)}/schema`, { method: 'POST', body: '{}' })); }
  catch (error) { $('project-schema-message').textContent = error.message; if (error.code === 'SCHEMA_SETUP_REQUIRED') { $('schema-setup').hidden = false; $('schema-setup-sql').value = error.setupSql; } }
  finally { updateSchemaButton(); }
});
$('open-project-settings').addEventListener('click', async () => {
  projectSettingsId = state.selectedId;
  try {
    const settings = await api(`/api/runs/${encodeURIComponent(projectSettingsId)}/settings`);
    $('project-settings-path').textContent = settings.projectPath + '/.env';
    $('supabase-url').value = settings.values.VITE_SUPABASE_URL;
    $('supabase-key').value = settings.values.VITE_SUPABASE_PUBLISHABLE_KEY;
    $('external-api-url').value = settings.values.VITE_API_BASE_URL;
    savedSupabase = { url: settings.values.VITE_SUPABASE_URL, key: settings.values.VITE_SUPABASE_PUBLISHABLE_KEY };
    renderProjectSchema(settings.schema); updateSchemaButton();
    $('project-settings-message').hidden = true;
    $('project-settings-dialog').showModal();
  } catch (error) { toast(error.message); }
});
for (const id of ['close-project-settings', 'cancel-project-settings']) $(id).addEventListener('click', () => $('project-settings-dialog').close());
$('project-settings-form').addEventListener('submit', async event => {
  event.preventDefault(); $('save-project-settings').disabled = true;
  try {
    await api(`/api/runs/${encodeURIComponent(projectSettingsId)}/settings`, { method: 'POST', body: JSON.stringify({ VITE_SUPABASE_URL: $('supabase-url').value, VITE_SUPABASE_PUBLISHABLE_KEY: $('supabase-key').value, VITE_API_BASE_URL: $('external-api-url').value }) });
    $('project-settings-dialog').close(); await selectRun(projectSettingsId); await refresh();
    toast("Connections saved in .env. Select Rebuild to use them.");
  } catch (error) { $('project-settings-message').textContent = error.message; $('project-settings-message').hidden = false; }
  finally { $('save-project-settings').disabled = false; }
});

$('close-project').addEventListener('click', () => $('project-dialog').close());
$('project-back').addEventListener('click', () => { if (state.wizard.step === 2) { state.wizard.step = 1; renderWizard(); } else $('project-dialog').close(); });
$('choose-folder').addEventListener('click', async () => {
  $('choose-folder').disabled = true;
  try { const suggestedName = projectSlug($('project-name').value.trim()); if (!suggestedName) throw new Error("Enter a project name first."); const result = await window.__TAURI__.core.invoke('choose_project_folder', { suggestedName }); if (result) { state.wizard.folderId = result.folderId; state.wizard.path = result.path; $('project-folder').value = result.path; } }
  catch (error) { $('project-message').textContent = String(error.message || error); $('project-message').hidden = false; }
  finally { $('choose-folder').disabled = false; }
});
$('project-form').addEventListener('submit', async event => {
  event.preventDefault();
  const name = $('project-name').value.trim();
  if (!name || !projectSlug(name) || /[/\\\x00-\x1f]/.test(name)) { $('project-message').textContent = "Enter a valid project name without slashes."; $('project-message').hidden = false; return; }
  if (state.wizard.step === 1) {
    $('project-submit').disabled = true;
    try {
      const plan = await api('/api/workspace-plan', { method: 'POST', body: JSON.stringify({ projectName: name, ...(state.wizard.folderId ? { folderId: state.wizard.folderId } : {}) }) });
      state.wizard.target = plan.directory; state.wizard.step = 2; renderWizard();
    } catch (error) { $('project-message').textContent = error.message; $('project-message').hidden = false; }
    finally { $('project-submit').disabled = false; }
    return;
  }
  $('project-submit').disabled = true; state.busy = true;
  try {
    const result = await api('/api/runs', { method: 'POST', body: JSON.stringify({ kind: 'app-project', starter: true, projectName: name, expectedPath: state.wizard.target, ...(state.wizard.folderId ? { folderId: state.wizard.folderId } : {}) }) });
    $('task-select').value = 'app-project'; $('project-dialog').close();
    state.status.runState = 'running'; state.status.activeRunId = result.id; state.status.activeStartedAt = result.startedAt;
    await selectRun(result.id); await refresh();
    toast("Project created. Open Vibe Coder is building the scaffold without an AI request.");
  } catch (error) { $('project-message').textContent = error.message; $('project-message').hidden = false; }
  finally { state.busy = false; $('project-submit').disabled = false; render(); }
});

async function projectAction(starter = false) {
  if (state.busy || isRunning()) return;
  state.busy = true; renderActions();
  try {
    if (!starter && [...state.drafts.keys()].some(key => key.startsWith(state.selectedId + ':'))) throw new Error("Save your changed files first.");
    const path = starter ? '/api/runs' : `/api/runs/${encodeURIComponent(state.selectedId)}/build`;
    const result = await api(path, { method: 'POST', body: JSON.stringify(starter ? { kind: 'app-project', starter: true } : {}) });
    await selectRun(result.id); await refresh();
  } catch (error) { toast(error.message); }
  finally { state.busy = false; render(); }
}
async function saveProjectFile(path, content) {
  await api(`/api/runs/${encodeURIComponent(state.selectedId)}/file`, { method: 'POST', body: JSON.stringify({ path, content }) });
  state.drafts.delete(`${state.selectedId}:${path}`); state.fileCache.set(`${state.selectedId}:${path}`, content);
  await loadDetail(); toast("File saved. Rebuild the app to see your change.");
}
$('file-editor').addEventListener('input', () => state.drafts.set(`${state.selectedId}:${state.filePath}`, $('file-editor').value));
window.bimCodeEditor?.mount($('code-editor'), text => { $('file-editor').value = text; $('file-editor').dispatchEvent(new Event('input')); });
$('format-file').addEventListener('click', async () => { $('format-file').disabled = true; try { await window.bimCodeEditor?.formatSource(); } catch (error) { toast("Formatting failed. Check the syntax. " + error.message.slice(0, 150)); } finally { $('format-file').disabled = isRunning(); } });
$('save-file').addEventListener('click', async () => { try { await saveProjectFile(state.filePath, $('file-editor').value); } catch (error) { toast(error.message); } });
$('new-file').addEventListener('click', async () => { try { const path = 'project/' + $('new-file-path').value.trim(); await saveProjectFile(path, ''); state.filePath = path; $('new-file-path').value = ''; renderFiles(); } catch (error) { toast(error.message); } });
$('project-preview').addEventListener('click', () => $('open-preview').click());
$('rebuild-project').addEventListener('click', () => projectAction(false));
$('acceptance-list').append(...CHECKS.map(check => el('li', '', check)));
function usd(value) { return value === null ? "Unknown" : new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(value); }
function resetUsage() {
  state.usageRevision++;
  state.usage = null; state.usageError = null; state.usageFetchedAt = 0; state.usageRequest = null;
}
async function readUsage(force = false) {
  if (state.usageRequest) return state.usageRequest;
  if (!force && Date.now() - state.usageFetchedAt < 60_000) {
    if (state.usageError) throw new Error(state.usageError);
    return state.usage;
  }
  const revision = state.usageRevision;
  state.usageRequest = (async () => {
    try {
      const usage = await api('/api/usage');
      if (revision === state.usageRevision) { state.usage = usage; state.usageError = null; }
      return usage;
    } catch (error) {
      if (revision === state.usageRevision) { state.usage = null; state.usageError = error.message; }
      throw error;
    } finally {
      if (revision === state.usageRevision) { state.usageFetchedAt = Date.now(); state.usageRequest = null; renderConnection(); }
    }
  })();
  return state.usageRequest;
}
async function loadUsage() {
  $('refresh-usage').disabled = true; $('usage-message').textContent = "Fetching OpenRouter usage…"; $('usage-details').hidden = true;
  try {
    const usage = await readUsage(true);
    $('usage-remaining').textContent = usage.freeRequests.remaining === null ? "Unknown" : numberLabel(usage.freeRequests.remaining);
    $('usage-daily').textContent = `${numberLabel(usage.freeRequests.used)} of ${numberLabel(usage.freeRequests.limit)} free requests used today (UTC).`;
    const progress = $('usage-progress'); progress.hidden = usage.freeRequests.used === null || !(usage.freeRequests.limit > 0);
    progress.max = usage.freeRequests.limit || 1; progress.value = usage.freeRequests.used || 0;
    const grid = $('usage-grid'); grid.replaceChildren();
    for (const [label, value] of [["Usage today", usd(usage.usageUsd.today)], ["Usage this month", usd(usage.usageUsd.month)], ["Total key usage", usd(usage.usageUsd.total)], ["Remaining key budget", usage.keyBudget.unlimited ? "No key budget set" : usd(usage.keyBudget.remaining)]]) { const metric = el('div', 'usage-metric'); metric.append(el('span', '', label), el('strong', '', value)); grid.append(metric); }
    $('usage-reset').textContent = `Next UTC day begins: ${dateLabel(usage.dailyResetAt, true)} (local time).`;
    $('usage-message').textContent = `Checked at ${dateLabel(usage.checkedAt, true)}. Refresh fetches updated data at most once every 30 seconds.`;
    $('usage-details').hidden = false;
  } catch (error) { $('usage-message').textContent = error.message; }
  finally { $('refresh-usage').disabled = false; }
}
$('open-usage').addEventListener('click', () => { $('usage-dialog').showModal(); loadUsage(); });
$('close-usage').addEventListener('click', () => $('usage-dialog').close());
$('refresh-usage').addEventListener('click', loadUsage);
$('open-settings').addEventListener('click', openSettings);
$('close-settings').addEventListener('click', closeSettings);
$('cancel-settings').addEventListener('click', closeSettings);
$('settings-dialog').addEventListener('close', () => $('settings-form').reset());
$('settings-form').addEventListener('submit', saveSettings);
$('provider-select').addEventListener('change', renderProviderForm);
$('start-run').addEventListener('click', startRun);
$('open-build-log').addEventListener('click', () => { state.filePath = 'project/build.log'; selectTab('files'); loadFile(state.filePath); });
$('repair-build').addEventListener('click', () => {
  const error=state.detail?.buildError; if(!error) return;
  if(error.action !== 'retry') { $('change-size').value='small'; $('model-select').value='auto'; }
  startRun(error.retryPrompt ?? error.repairPrompt, error.action !== 'retry');
});
$('edit-build-code').addEventListener('click', () => { state.filePath=state.detail?.buildError?.file ? 'project/'+state.detail.buildError.file : 'project/src/App.jsx'; selectTab('files'); loadFile(state.filePath); });
let cataloguePending = null;
async function loadModels() {
  if (cataloguePending) return cataloguePending;
  state.catalogueAt = Date.now();
  cataloguePending = (async () => {
    try {
      state.catalogue = await api('/api/models'); state.catalogueError = null;
      $('catalogue-status').textContent = `${state.catalogue.models.length} free models · checked ${dateLabel(state.catalogue.checkedAt, true)}`;
      render();
      if (!state.modelRestored) {
        state.modelRestored = true;
        try { const saved = localStorage.getItem('open-vibe-coder:model'); if (availableModels().some(model => model.id === saved)) $('model-select').value = saved; } catch {}
      }
      renderModelCatalogue();
    } catch (error) {
      state.catalogueError = error.message;
      $('catalogue-status').textContent = error.message + " Models are checked again before every build request.";
      throw error;
    } finally { cataloguePending = null; }
  })();
  return cataloguePending;
}
function renderModelCatalogue() {
  const body = $('model-matrix-body'); body.replaceChildren();
  const query = $('model-search').value.trim().toLowerCase();
  for (const model of state.catalogue?.models || []) {
    if (!`${model.label} ${model.id}`.toLowerCase().includes(query)) continue;
    const row = el('tr'); row.append(el('td', '', model.label), el('td', '', model.use));
    const cell = el('td'), choose = el('button', 'secondary-button', "Use model"); choose.type = 'button';
    choose.addEventListener('click', () => { $('model-select').value = model.id; try { localStorage.setItem('open-vibe-coder:model', model.id); } catch {} $('model-matrix-dialog').close(); toast(model.label + " selected"); });
    cell.append(choose); row.append(cell); body.append(row);
  }
}
async function testConnection() {
  const result = await api('/api/connection', {method:'POST',body:'{}'});
  state.connectionVerified = true; state.usage = result.usage;
  $('settings-message').textContent = `OpenRouter connected · ${result.modelCount} free models available. No model request used.`;
  $('settings-message').hidden = false; renderConnection();
  return result;
}
$('test-connection').addEventListener('click', async () => {
  $('test-connection').disabled = true;
  try { await testConnection(); }
  catch (error) { $('settings-message').textContent = error.message; $('settings-message').hidden = false; }
  finally { $('test-connection').disabled = false; }
});
$('open-model-matrix').addEventListener('click', () => { renderModelCatalogue(); $('model-matrix-dialog').showModal(); loadModels().catch(() => {}); });
$('model-select').addEventListener('change', () => { try { localStorage.setItem('open-vibe-coder:model', $('model-select').value); } catch {} });
$('model-search').addEventListener('input', renderModelCatalogue);
$('refresh-models').addEventListener('click', () => loadModels().catch(() => {}));
$('planning-enabled').addEventListener('change', renderBuildError);
$('close-model-matrix').addEventListener('click', () => $('model-matrix-dialog').close());
$('task-select').addEventListener('change', () => { state.modelSignature = null; render(); });
$('open-preview').addEventListener('click', async () => {
  try {
    if (window.bimDesktop) await window.__TAURI__.core.invoke('open_run_preview', { id: state.selectedId });
    else { const result = await api(`/api/runs/${encodeURIComponent(state.selectedId)}/preview`); window.open(result.url, '_blank', 'noopener,noreferrer'); }
    $('preview-message').textContent = "The built app opened in a separate window.";
  } catch (error) { $('preview-message').textContent = String(error.message || error); }
});
$('stop-run').addEventListener('click', stopRun);
$('new-run').addEventListener('click', openProjectWizard);
$('test-select').addEventListener('change', event => { state.testPath = event.target.value; renderTests(); });
for (const name of ['overview', 'files', 'tests', 'preview']) {
  $(`tab-${name}`).addEventListener('click', () => selectTab(name));
  $(`tab-${name}`).addEventListener('keydown', event => {
    const names = ['overview', 'files', 'tests', 'preview'];
    const current = names.indexOf(name);
    let next;
    if (event.key === 'ArrowRight') next = names[(current + 1) % names.length];
    if (event.key === 'ArrowLeft') next = names[(current + names.length - 1) % names.length];
    if (event.key === 'Home') next = names[0];
    if (event.key === 'End') next = names.at(-1);
    if (next) { event.preventDefault(); selectTab(next, true); }
  });
}
const conversationScroller = $('conversation-scroll');
$('conversation-jump').addEventListener('click', resumeOutputFollow);
for (const type of ['wheel', 'touchmove']) conversationScroller.addEventListener(type, pauseOutputFollow, { passive: true });
conversationScroller.addEventListener('pointerdown', event => {
  const bounds = conversationScroller.getBoundingClientRect();
  if (event.target === conversationScroller && event.clientX >= bounds.right - 18) pauseOutputFollow();
});
conversationScroller.addEventListener('scroll', () => {
  if (!programmaticConversationScroll) pauseOutputFollow();
}, { passive: true });
function scrollKey(event) {
  return ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)
    && !event.target.closest('input, textarea, select, button, a, summary, [contenteditable="true"]');
}
conversationScroller.addEventListener('keydown', event => { if (scrollKey(event)) pauseOutputFollow(); });
const pageConversationScroll = () => getComputedStyle(conversationScroller).overflowY === 'visible';
window.addEventListener('scroll', () => { if (pageConversationScroll() && !programmaticConversationScroll) pauseOutputFollow(); }, { passive: true });
for (const type of ['wheel', 'touchmove']) window.addEventListener(type, event => {
  if (pageConversationScroll() && event.target.closest?.('.conversation')) pauseOutputFollow();
}, { passive: true });
window.addEventListener('keydown', event => { if (pageConversationScroll() && scrollKey(event)) pauseOutputFollow(); });
const conversationResizeObserver = new ResizeObserver(scrollConversationToLatest);
for (const id of ['conversation-scroll', 'run-conversation', 'build-error']) conversationResizeObserver.observe($(id));
window.addEventListener('focus', scrollConversationToLatest);
window.addEventListener('resize', scrollConversationToLatest);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { clearTimeout(state.pollTimer); refresh(); }
});
setInterval(renderRunTimer, 1000);
render();
refresh();
