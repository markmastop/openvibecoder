import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { projectPath, parseProject, validateScreenStructure, scaffold, saveSource } from '../src/projects/project-files.mjs';
import { buildProject, runtimeDirectory } from '../src/build/project-build.mjs';

test('model kan alleen begrensde bronbestanden in het skelet aanleveren', () => {
  const valid = { files: [{ path: 'src/App.jsx', content: 'export default function App(){return null}' }] };
  assert.equal(parseProject(JSON.stringify(valid))[0].path, 'src/App.jsx');
  for (const path of ['../x.js', '/tmp/x.js', 'src/../x.js', 'src//x.js', 'package.json', '.env', 'vite.config.js', 'src/a.mjs', 'src/main.jsx', 'src/tailwind.css', 'src/studio/api.js', 'src/studio/supabase.js']) assert.throws(() => projectPath(path));
  assert.throws(() => parseProject(JSON.stringify({ files: [...valid.files, ...valid.files] })));
  assert.throws(() => parseProject(JSON.stringify({ files: [{ path: 'src/a.js', content: '' }] })));
});
test('een los bronbestand krijgt exact dezelfde pad-, inhoud- en startbestandcontroles', () => {
  const file = {path:'src/App.jsx',content:'export default function App(){return null}'};
  assert.deepEqual(parseProject(JSON.stringify(file)), [file]);
  assert.deepEqual(parseProject('```json\n' + JSON.stringify(file) + '\n```'), [file]);
  for (const bad of [null, [], {}, {files:null,...file}, {...file,extra:true}, {...file,path:'../outside.js'}, {...file,path:'src/studio/api.js'}, {...file,path:'src/main.jsx'}, {...file,path:'src/other.jsx'}, {...file,content:12}, {...file,content:'x'.repeat(80001)}, {files:[null]}, {files:Array(31).fill(file)}]) assert.throws(() => parseProject(JSON.stringify(bad)));
});
test('één expliciet benoemd Markdown-codeblok wordt zonder codewijziging genormaliseerd', () => {
  const code = 'export default function App(){return <main>Voorbeeld</main>}\n';
  for (const path of ['App.jsx', 'src/App.jsx']) {
    const answer = 'Ik heb voldoende context.\n\nHier is de volledige bijgewerkte `'+path+'`:\n\n```jsx\n'+code+'```\nToelichting achteraf.';
    assert.deepEqual(parseProject(answer), [{path:'src/App.jsx',content:code}]);
    assert.deepEqual(parseProject(answer.replaceAll('\n','\r\n')), [{path:'src/App.jsx',content:code.replaceAll('\n','\r\n')}]);
  }
});
test('Markdown-herkenning weigert ambiguïteit, verboden paden en ontbrekende bestandsnamen', () => {
  const block = '```jsx\nexport default function App(){return null}\n```';
  for (const answer of [block, '`../App.jsx`:\n'+block, '`src/studio/App.jsx`:\n'+block, '`src/Other.jsx`:\n'+block, '`App.jsx`:\n'+block+'\n'+block, '`App.jsx`:\n'+block+'\n```jsx\n', '`App.jsx`:\n'+block.replace('```jsx','```sh'), '`App.jsx`:\n'+block.slice(0,-3), '`App.jsx`:\n```jsx\n'+'x'.repeat(80001)+'\n```']) assert.throws(()=>parseProject(answer));
});
test('een genormaliseerd codeblok passeert de schermindeling niet automatisch', () => {
  const files = parseProject('Hier is `App.jsx`:\n```jsx\nexport default function App(){return null}\n```');
  assert.throws(()=>validateScreenStructure(files,{separateScreens:true}), /separate file under src\/screens/);
});
test('broncode opslaan weigert symlinks naar buiten het project', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bim-project-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'project')); await mkdir(join(root, 'outside'));
  await symlink(join(root, 'outside'), join(root, 'project/src'));
  await assert.rejects(saveSource(join(root, 'project'), 'src/App.jsx', 'test'), /Symbolic links/);
});
test('React/Tailwind-skelet bouwt echt; syntaxfout en import buiten project worden afgekeurd', { skip: process.platform !== 'darwin', timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'bim-project-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await scaffold(project, runtimeDirectory,{template:'legacy'});
  await saveSource(project, 'src/App.jsx', 'import {isSupabaseConfigured, getSupabase} from "./studio/supabase.js"; import {isApiConfigured} from "./studio/api.js"; export default function App(){return <h1 className="text-3xl font-bold">BIM werkt {isSupabaseConfigured() ? getSupabase().supabaseUrl : "geen database"} {String(isApiConfigured())}</h1>}');
  const built = await buildProject(project);
  assert.equal(built.passed, true, built.output);
  assert.match(await readFile(join(project, 'dist/index.html'), 'utf8'), /assets\//);
  assert.match(await readFile(join(project, '.gitignore'), 'utf8'), /!\.env\.example/);
  assert.ok((await readFile(join(project, '.env.example'), 'utf8')).includes('VITE_API_BASE_URL='));
  const { writeProjectSettings } = await import('../src/projects/project-settings.mjs');
  await writeFile(join(project, '.env'), 'UNRELATED_SECRET=NEVER_SHIP_THIS_FIXTURE\n');
  await writeProjectSettings(project, { VITE_SUPABASE_URL: 'https://fixture.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fixture', VITE_API_BASE_URL: 'https://api.example.com/api/v1/' });
  const configured = await buildProject(project);
  assert.equal(configured.passed, true, configured.output);
  const js = await Promise.all((await readdir(join(project, 'dist/assets'))).filter(name => name.endsWith('.js')).map(name => readFile(join(project, 'dist/assets', name), 'utf8')));
  assert.ok(js.join('').includes('https://fixture.supabase.co'));
  assert.ok(!js.join('').includes('NEVER_SHIP_THIS_FIXTURE'));
  await saveSource(project, 'src/App.jsx', 'export default function App(){return <h1>');
  assert.equal((await buildProject(project)).passed, false);
  const secret = join(root, 'outside-secret.txt');
  await writeFile(secret, 'FICTIONELE-TESTSLEUTEL');
  await saveSource(project, 'src/App.jsx', `import secret from ${JSON.stringify(secret + '?raw')}; export default function App(){return <p>{secret}</p>}`);
  const blocked = await buildProject(project);
  assert.equal(blocked.passed, false);
  assert.ok(!blocked.output.includes('FICTIONELE-TESTSLEUTEL'));
});

test('modelbewerking en vervolgopdracht gebruiken actuele code, feedback en een nieuw gratis catalogusmodel (providerfixture)', { skip: process.platform !== 'darwin', timeout: 30000 }, async t => {
  const { spawn } = await import('node:child_process');
  const root = await mkdtemp(join(tmpdir(), 'bim-project-model-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = 'fixture-project';
  const directory = join(root, 'runs', id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(root, '.env.local'), 'MODEL_PROVIDER=openrouter\nOPENROUTER_API_KEY=FICTIONELE-MODELSLEUTEL\n');
  await writeFile(join(directory, 'summary.json'), JSON.stringify({ id, kind: 'app-project', prompt: 'Bouw een takenlijst', startedAt: new Date().toISOString(), rounds: [] }));
  const mock = join(root, 'provider.mjs');
  await writeFile(mock, `import assert from 'node:assert/strict';globalThis.fetch=async(url,options)=>{
    if(url==='https://openrouter.ai/api/v1/models')return Response.json({data:['fixture/new-code-model:free'].map(id=>({id,pricing:{prompt:'0',completion:'0'},reasoning:{mandatory:false}}))});
    assert.equal(url,'https://openrouter.ai/api/v1/chat/completions');
    if(process.env.BIM_FIXTURE_FAIL)return Response.json({provider:'Nvidia',choices:[{finish_reason:'error',error:{code:502,message:'Upstream error from Nvidia: Internal server error',metadata:{error_type:'provider_unavailable'}},message:{content:null,reasoning:'PRIVATE_REASONING'}}]});
    const request=JSON.parse(options.body);assert.equal(request.provider.only,undefined);assert.equal(request.provider.allow_fallbacks,true);assert.equal(request.provider.max_price.completion,0);
    assert.ok(!request.messages[1].content.includes('sb_publishable_schema_fixture'));
    const improve=process.env.BIM_PROJECT_MODE==='improve';
    assert.equal(request.model,'fixture/new-code-model:free');
    if(improve){assert.ok(request.messages[1].content.includes('Fixture app'));assert.equal(request.max_tokens,4000);assert.equal(request.reasoning.enabled,false);assert.ok(!request.messages[1].content.includes('built in'));}
    const output=improve?{edits:[{path:'src/screens/Home.jsx',search:'Fixture app',replace:'Fixture app verbeterd'}]}:{files:[{path:'src/screens/Home.jsx',content:'export default function Screen(){return <h1>Fixture app</h1>}'}]};
    return Response.json({model:request.model,usage:{prompt_tokens:10,completion_tokens:20,total_tokens:30,cost:0},choices:[{finish_reason:'stop',message:{content:JSON.stringify(output)}}]});};`);
  async function run(mode, fail = false) {
    const runner = new URL('../src/execution/project-runner.mjs', import.meta.url);
    const child = spawn(process.execPath, ['--import', mock, runner.pathname], { env: { PATH: process.env.PATH, BIM_CLIENT_DATA_DIR: root, PILOT_RUN_ID: id, BIM_PROJECT_MODE: mode, ...(fail ? {BIM_FIXTURE_FAIL:'1'} : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', x => { log += x; }); child.stderr.on('data', x => { log += x; });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(code, 0, log);
    const summary = JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8'));
    assert.equal(summary.status, fail ? 'provider-error' : 'built', summary.error || log);
    assert.ok(!JSON.stringify(summary).includes('FICTIONELE-MODELSLEUTEL'));
    return summary;
  }
  assert.equal((await run('create')).modelCalls, 1);
  const { writeProjectSettings } = await import('../src/projects/project-settings.mjs');
  const { fetchProjectSchema } = await import('../src/projects/project-schema.mjs');
  await writeProjectSettings(join(directory, 'project'), { VITE_SUPABASE_URL: 'https://fixture.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_schema_fixture' });
  await fetchProjectSchema(join(directory, 'project'), { fetchImpl: async () => Response.json({ swagger: '2.0', paths: { '/fixture_people': { get: {} } }, definitions: { fixture_people: { properties: { id: { type: 'integer' } } } } }) });
  assert.equal((await run('improve')).modelCalls, 2);
  assert.match(await readFile(join(directory, 'snapshots/2/before.json'), 'utf8'), /Fixture app/);
  const failed = await run('improve', true);
  assert.equal(failed.previewReady, true);
  assert.equal(failed.previewFromPrevious, true);
  assert.equal(failed.modelCalls, 3);
  assert.equal(failed.buildAttempted, false);
  assert.deepEqual(failed.fileChecks, []);
  assert.equal(failed.failure.kind, 'provider');
  assert.equal(failed.failure.code, '502');
  assert.ok(!JSON.stringify(failed).includes('PRIVATE_REASONING'));
  assert.match(await readFile(join(directory, 'project/src/screens/Home.jsx'), 'utf8'), /Fixture app/);
});

test('reasoning plant voor bouwer; ongeldige planning stopt zonder nieuwe bronwijziging of bouwoproep', {skip:process.platform!=='darwin',timeout:30000},async t=>{
 const {spawn}=await import('node:child_process');
 const root=await mkdtemp(join(tmpdir(),'bim-planning-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const id='planning-fixture',directory=join(root,'runs',id);await mkdir(directory,{recursive:true});
 await writeFile(join(root,'.env.local'),'MODEL_PROVIDER=openrouter\nOPENROUTER_API_KEY=FICTIONELE-MODELSLEUTEL\n');
 await writeFile(join(directory,'summary.json'),JSON.stringify({id,kind:'app-project',prompt:'Bouw een takenlijst',planningEnabled:true,rounds:[]}));
 const mock=join(root,'provider.mjs');
 await writeFile(mock,`import assert from 'node:assert/strict';globalThis.fetch=async(url,options)=>{
  const planner='fixture/new-code-model:free';
  if(url.endsWith('/models'))return Response.json({data:[planner].map(id=>({id,pricing:{prompt:'0',completion:'0'},supported_parameters:[],reasoning:{mandatory:true}}))});
  const request=JSON.parse(options.body);let content;
  if(request.max_tokens===4096){assert.equal(request.model,planner);if(request.reasoning?.enabled===false)return Response.json({error:{code:400,message:'Reasoning is mandatory for this endpoint and cannot be disabled.'}},{status:400});assert.equal(request.reasoning.enabled,true);assert.equal(request.reasoning.exclude,true);assert.equal(request.response_format,undefined);const info=JSON.parse(request.messages[1].content);assert.ok(info.files.length);assert.equal(request.messages.at(-1).content,process.env.BIM_FAIL_PLAN?'maak teksten oranje':'Bouw een takenlijst');content=process.env.BIM_FAIL_PLAN?'not json':JSON.stringify({goal:'Een takenlijst tonen',scope:'large',files:['src/app-config.json'],approach:'Voeg een scherm toe binnen het portaal.',checks:['Open het scherm.'],missingContext:''});}
  else {assert.ok(!process.env.BIM_FAIL_PLAN,'bouwer mag niet starten na planfout');assert.match(request.messages[1].content,/Een takenlijst tonen/);content=JSON.stringify({files:[{path:'src/screens/TasksScreen.jsx',content:'export default function Tasks(){return <h1>Taken</h1>}'}]});}
  return Response.json({model:request.model,usage:{total_tokens:30,cost:0},choices:[{finish_reason:'stop',message:{content,reasoning:'PRIVATE_REASONING'}}]});};`);
 async function run(mode,fail=false){
  const child=spawn(process.execPath,['--import',mock,new URL('../src/execution/project-runner.mjs',import.meta.url).pathname],{env:{PATH:process.env.PATH,BIM_CLIENT_DATA_DIR:root,PILOT_RUN_ID:id,BIM_PROJECT_MODE:mode,...(fail?{BIM_FAIL_PLAN:'1'}:{})},stdio:['ignore','pipe','pipe']});
  let log='';child.stdout.on('data',x=>log+=x);child.stderr.on('data',x=>log+=x);const code=await new Promise((r,j)=>{child.once('error',j);child.once('close',r);});assert.equal(code,0,log);
  return JSON.parse(await readFile(join(directory,'summary.json'),'utf8'));
 }
 const first=await run('create');assert.equal(first.status,'built',first.error);assert.equal(first.modelCalls,2);assert.equal(first.rounds.at(-1).planning.status,'passed');assert.equal(first.history[0].step,'planning');assert.ok(!JSON.stringify(first).includes('PRIVATE_REASONING'));
 const before=await readFile(join(directory,'project/src/app-config.json'),'utf8');
 first.prompt='maak teksten oranje';await writeFile(join(directory,'summary.json'),JSON.stringify(first));
 const failed=await run('improve',true);assert.equal(failed.status,'generation-error');assert.equal(failed.modelCalls,3);assert.equal(failed.buildAttempted,false);assert.equal(failed.rounds.at(-1).planning.status,'failed');assert.equal(failed.previewReady,true);assert.equal(failed.previewFromPrevious,true);
 assert.equal(await readFile(join(directory,'project/src/app-config.json'),'utf8'),before);
 assert.ok(!(await readFile(join(directory,'project/PROMPTS.md'),'utf8')).includes('PRIVATE_REASONING'));
});
