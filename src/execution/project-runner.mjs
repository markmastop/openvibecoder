import { packageRoot, specsDirectory, runPath } from '../paths.mjs';
import {PLANNER_MODEL,plannerRequest,parsePlannerAnswer} from '../projects/project-planner.mjs';
import {PORTAL_CONTRACT} from '../projects/portal-project.mjs';
import {prepareProjectAnswer} from '../parsing/project-answer.mjs';
import { providerFailure } from '../build/build-feedback.mjs';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportProjectHistory } from '../projects/project-history.mjs';
import { readProjectSchema } from '../projects/project-schema.mjs';
import { workspaceDirectory } from '../projects/workspaces.mjs';
import { readConfig } from '../config/config.mjs';
import { redact } from '../config/redact.mjs';
import { appPlan, checkFreeAppModel } from '../models/app-models.mjs';
import { projectContext } from '../projects/project-context.mjs';
import { scaffold, saveSource, ensureProjectConnections } from '../projects/project-files.mjs';
import { buildProject, runtimeDirectory } from '../build/project-build.mjs';
const here = packageRoot;
const root = process.env.BIM_CLIENT_DATA_DIR || here;
const id = process.env.PILOT_RUN_ID;
if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Start from Open Vibe Coder.");
const directory = runPath(root, id);
const project = await workspaceDirectory(root, id);
const summary = JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8'));
const controller = new AbortController();
for (const event of ['SIGTERM', 'SIGINT']) process.once(event, () => controller.abort());
let secrets = [];
const save = () => writeFile(join(directory, 'summary.json'), redact(JSON.stringify(summary, null, 2), secrets));
const previousError = summary.error || '';
const previousFailure = summary.failure;
const previousPreview = Boolean(summary.previewReady);
let sourceChanged = false;
let stage = 'execution';
summary.status = 'started'; summary.previewReady = false; summary.previewFromPrevious = false; delete summary.error; delete summary.failure; summary.buildAttempted = false; summary.fileChecks = [];
summary.kind = 'app-project'; summary.rounds ||= []; summary.tokenUsage ||= []; summary.modelCalls ||= 0;
const round = { phase: 'project', attempt: 0, startedAt: new Date().toISOString(), status: 'started', prompt: summary.prompt, mode: process.env.BIM_PROJECT_MODE || 'create' };
if (!['build','scaffold'].includes(round.mode)) summary.heuristics = [];
summary.rounds.push(round);
await save();
try {
  if (round.mode === 'scaffold') {
    await scaffold(project, runtimeDirectory,{name:summary.projectName||"My app"});
  }
  if (round.mode !== 'create') await ensureProjectConnections(project, runtimeDirectory);
  if (!['build', 'scaffold'].includes(round.mode)) {
    const config = await readConfig(join(root, '.env.local'));
    if (config.provider !== 'openrouter') throw new Error("Use OpenRouter for app generation.");
    secrets = [config.token];
    if (round.mode === 'create') {
      await scaffold(project, runtimeDirectory,{name:summary.projectName||"My app"});
    }
    const sources = [];
    async function walk(folder, prefix = '') {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.isSymbolicLink() || ['node_modules', 'dist', '.cache', 'PROMPTS.md'].includes(entry.name)) continue;
        const path = prefix + entry.name;
        if (entry.isDirectory()) await walk(join(folder, entry.name), path + '/');
        else if (/\.(jsx|js|css|json|md|html)$/.test(path)) sources.push({ path, content: await readFile(join(folder, entry.name), 'utf8') });
      }
    }
    await walk(project);
    const sourceText = JSON.stringify(sources);
    if (sourceText.length > 300_000) throw new Error("The project is too large for this version.");
    let feedback = previousFailure?.kind === 'provider' ? '' : previousError;
    if (previousError && !previousFailure && /build|bouw/i.test(previousError)) { try { feedback += '\n' + (await readFile(join(project, 'build.log'), 'utf8')).slice(0,1800); } catch {} }
    let preparation;
    if(summary.planningEnabled===true) {
      round.planning={status:'started',model:PLANNER_MODEL,startedAt:new Date().toISOString()};
      await save();
      try {
        stage='provider';
        const plannerModel=await checkFreeAppModel('auto');
        round.planning.model=plannerModel.id;
        const payload=plannerRequest(summary.prompt,sources,{model:plannerModel.id,reasoningMandatory:plannerModel.reasoning?.mandatory===true,structuredOutputs:plannerModel.supported_parameters?.includes('structured_outputs')===true});
        const number=++summary.modelCalls;
        round.planning.modelCall=number;
        await writeFile(join(directory,`request-${number}.json`),redact(JSON.stringify(payload,null,2),secrets),{flag:'wx'});
        summary.history ||= []; summary.history.push({prompt:summary.prompt,at:round.startedAt,modelCall:number,model:plannerModel.id,step:'planning'});
        await save();
        await exportProjectHistory(project,directory,summary,secrets);
        console.log("Planning · interpreting your request with "+plannerModel.id+". One additional free request.");
        const response=await fetch('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${config.token}`,'Content-Type':'application/json','X-OpenRouter-Title':'Open Vibe Coder'},body:JSON.stringify(payload),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(45000)])});
        const raw=await response.text();
        await writeFile(join(directory,`response-${number}.json`),redact(raw,secrets));
        let data;try{data=JSON.parse(raw);}catch{throw new Error("The planning model returned an unreadable response.");}
        if(data.usage)summary.tokenUsage.push(data.usage);
        const failure=providerFailure(data,response.status);
        if(failure)throw Object.assign(new Error(failure.message),{failure});
        stage='generation';
        if(data.usage?.cost!==0||data.model?.replace(/:free$/,'')!==plannerModel.id.replace(/:free$/,''))throw new Error("Planning model identity or zero cost could not be confirmed.");
        const content=data.choices?.[0]?.message?.content;
        await writeFile(join(directory,`response-${number}.md`),redact(content||'',secrets));
        if(data.choices?.[0]?.finish_reason==='length')throw new Error("The build plan was cut off at the output limit.");
        preparation=parsePlannerAnswer(content,sources);
        round.planning.result=preparation;
        if(preparation.missingContext.trim())throw new Error("Planning needs clarification: "+preparation.missingContext);
        round.planning.status='passed';
      } catch(error) {
        round.planning.status='failed'; round.planning.error=redact(error.message,secrets);
        throw error;
      } finally {round.planning.finishedAt=new Date().toISOString();await save();}
    }
    const plan = appPlan({prompt:summary.prompt,mode:round.mode,changeSize:summary.changeSize && summary.changeSize!=='auto'?summary.changeSize:preparation?.scope || 'auto',modelId:summary.modelChoice || 'auto'});
    stage = 'provider';
    const catalogueModel = await checkFreeAppModel(plan.automaticModel ? 'auto' : plan.model);
    plan.model = catalogueModel.id;
    if(preparation)plan.reason="Planning recommends "+(preparation.scope==='small'?"a targeted patch.":"a broader change.")+(summary.changeSize&&summary.changeSize!=='auto'?" Your selected scope takes priority.":'');
    const context = projectContext(sources, {prompt:summary.prompt,plan,feedback,schema:await readProjectSchema(project),preferredPaths:preparation?.files || []});
    round.buildStartedAt=new Date().toISOString();
    summary.model = plan.model; summary.buildPlan = {...plan,sourceCharacters:context.sourceCharacters,totalSourceCharacters:context.totalSourceCharacters,contextFiles:[...new Set(context.records.map(f=>f.path))],omitted:context.omitted};
    round.model = plan.model; round.buildPlan = summary.buildPlan;
    await save();
    stage = 'provider';
    const examplePath=context.portal?'src/screens/HomeScreen.jsx':'src/App.jsx';
    const format = plan.format === 'edits'
      ? `Return only JSON {"edits":[{"path":"${examplePath}","search":"exact existing code","replace":"replacement code"}]}. Maximum 12 changes. Include only actual changes: search and replace must differ. search must match exactly once in the current source. No complete files or new files. Preserve all other code. If context is missing, return {"needs_context":"name the file or function"}; do not invent code.`
      : `Return only JSON {"files":[{"path":"${examplePath}","content":"complete working content"}]}. Maximum 30 files. ${context.portal ? "App.jsx is managed and must not be included;" : "src/App.jsx is required;"} existing files you do not return are preserved. Only use editable source paths from the contract; new components under src/ are allowed.`;
    const architecture = context.portal ? '\n'+PORTAL_CONTRACT : plan.separateScreens ? "\nPut each screen in its own file under src/screens/. App.jsx imports these screens and contains only app state and navigation: maximum 220 lines and 12,000 characters. Put shared UI under src/components/, hooks under src/hooks/, and domain logic under src/services/ or src/lib/. Split a large existing App.jsx for this broader change without removing features. Include all required new files." : '';
    const baseSystem = await readFile(join(specsDirectory, 'project/system.txt'), 'utf8');
    const messages = [{role:'system',content:baseSystem+architecture+"\n\nResponse contract for THIS request (defines the response format):\n"+format}, {role:'user',content:`Project: ${summary.projectName || summary.title || "My app"} (React/JavaScript/Tailwind).\nRequest:\n${summary.prompt}\n\nBrief build plan (advice; preserve the original request):\n${preparation?JSON.stringify(preparation):"No separate preparation."}\n\nEditable files (names; not all contents are included):\n${JSON.stringify(context.manifest)}\n\nCurrent code excerpts (from/to are line numbers; content is literal source code):\n${JSON.stringify(context.records)}\n\nProject contract (data):\n${context.contract}\n\nRelevant data model (metadata only):\n${context.schema || "No relevant schema supplied. Do not invent tables."}\n\nLast error:\n${context.feedback || "No current build error."}` }];
    let reasoning = {enabled:false,exclude:true};
    if (plan.size === 'large' && catalogueModel.reasoning?.supports_max_tokens) reasoning={max_tokens:2048,exclude:true};
    else if (plan.size === 'large' && catalogueModel.reasoning?.mandatory) reasoning={enabled:true,exclude:true};
    const payload = { model:plan.model,messages,temperature:0.2,max_tokens:Math.min(plan.maxTokens, catalogueModel.top_provider?.max_completion_tokens || plan.maxTokens),...(catalogueModel.supported_parameters?.includes('reasoning') || catalogueModel.reasoning ? {reasoning} : {}),stream:false,provider:{allow_fallbacks:true,require_parameters:true,max_price:{prompt:0,completion:0,request:0}} };
    const number = ++summary.modelCalls;
    await writeFile(join(directory, `request-${number}.json`), redact(JSON.stringify(payload, null, 2), secrets), { flag: 'wx' });
    summary.history ||= []; summary.history.push({ prompt: summary.prompt, at: round.startedAt, modelCall: number, model:plan.model, format:plan.format, sourceCharacters:context.sourceCharacters });
    await save();
    await exportProjectHistory(project, directory, summary, secrets);
    console.log(`${plan.size === 'small' ? "Targeted patch" : "Broader build request"} via ${plan.model}; ${context.sourceCharacters} source characters out of ${context.totalSourceCharacters}. One request, no automatic retry.`);
    stage = 'provider';
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json', 'X-OpenRouter-Title': 'Open Vibe Coder' }, body: JSON.stringify(payload), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(plan.timeoutMs)]) });
    const raw = await response.text();
    await writeFile(join(directory, `response-${number}.json`), redact(raw, secrets));
    let data;
    try { data = JSON.parse(raw); } catch { throw Object.assign(new Error("The model provider returned an unreadable response."), { failure: { kind: 'provider', provider: 'OpenRouter', code: response.status, message: "Unreadable provider response." } }); }
    if (data.usage) summary.tokenUsage.push(data.usage);
    const failure = providerFailure(data, response.status);
    if (failure) throw Object.assign(new Error(failure.message), { failure });
    stage = 'generation';
    summary.returnedModels = [data.model];
    if (data.usage?.cost !== 0 || data.model?.replace(/:free$/, '') !== plan.model.replace(/:free$/, '')) throw new Error("Model identity or zero cost could not be confirmed.");
    const content = data.choices?.[0]?.message?.content;
    await writeFile(join(directory, `response-${number}.md`), redact(content || '', secrets));
    if (data.choices?.[0]?.finish_reason === 'length') throw new Error("The model response was cut off at the output limit.");
    if (content?.includes('needs_context')) { try { const value=JSON.parse(content); if(value.needs_context) throw Object.assign(new Error("More context needed: "+String(value.needs_context).slice(0,300)),{needsContext:true}); } catch(error) {if(error.needsContext) throw error;} }
    const prepared = await prepareProjectAnswer(content,{plan,sources});
    const files = prepared.files;
    summary.heuristics = prepared.heuristics; round.heuristics = prepared.heuristics;
    if (prepared.heuristics.length) console.log("Local heuristics: "+prepared.heuristics.map(h=>h.id).join(', ')+". No additional AI request.");
    await save();
    // Refuse stale edits, including when code was changed outside Studio during inference.
    for (const file of files) {
      const original=sources.find(f=>f.path===file.path);
      let current; try { current=await readFile(join(project,file.path),'utf8'); } catch(error) {if(error.code!=='ENOENT') throw error;}
      if(current!==original?.content) throw new Error("The source changed during the request. Nothing was saved.");
    }
    await mkdir(join(directory, 'snapshots', String(number)), { recursive: true });
    await writeFile(join(directory, 'snapshots', String(number), 'before.json'), JSON.stringify(sources, null, 2));
    sourceChanged = true;
    for (const file of files) await saveSource(project, file.path, redact(file.content, secrets));
  }
  if (controller.signal.aborted) throw new Error("Build cancelled.");
  stage = 'execution'; summary.buildAttempted = true;
  summary.status = 'building'; await save();
  console.log("Building React and Tailwind locally, without network access or model credentials.");
  const result = await buildProject(project, { signal: controller.signal });
  summary.status = result.passed ? 'built' : 'build-failed';
  summary.previewReady = result.passed;
  summary.fileChecks = [{ name: "React/Tailwind production build", pass: result.passed }];
  await writeFile(join(directory, 'tests.tap'), `TAP version 13\n${result.passed ? 'ok' : 'not ok'} 1 - React/Tailwind production build\n1..1\n`);
  if (!result.passed) summary.error = "The build failed. Check project/build.log, edit the source, or ask the model to fix the build error.";
} catch (error) { summary.status = controller.signal.aborted ? 'cancelled' : `${stage}-error`; summary.error = error.name === 'TimeoutError' ? (round.planning?.status==='failed'?"Planning did not return a complete build plan within 45 seconds. The builder did not start.":"The model did not return a complete response in time. Small requests: two minutes; large requests: four minutes. No automatic retry; your project files were preserved.") : redact(error.message, secrets);
  summary.failure = {...(error.failure || { kind: stage, message: summary.error }), ...(round.planning?.status==='failed'?{step:'planning'}:{})};
  if (!sourceChanged && previousPreview) { summary.previewReady = true; summary.previewFromPrevious = true; }
  console.log(summary.error); }
finally { round.status = summary.status === 'built' ? 'passed' : 'failed'; round.error = summary.error; round.finishedAt = new Date().toISOString(); summary.finishedAt = round.finishedAt; await save(); try { await exportProjectHistory(project, directory, summary, secrets); } catch (error) { console.log(`Could not save prompt history: ${redact(error.message, secrets)}`); } }
