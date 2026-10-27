import {test} from 'node:test';
import assert from 'node:assert/strict';
import {APP_MODELS, appPlan, checkFreeAppModel} from '../src/models/app-models.mjs';
import {projectContext} from '../src/projects/project-context.mjs';
import {parseEdits,validateScreenStructure} from '../src/projects/project-files.mjs';
test('lokale matrix kiest klein/groot, accepteert overrides en weigert betaalde modellen',()=>{
  assert.equal(appPlan({prompt:"Fix only de syntaxfout in src/App.jsx, line 588"}).format,'edits');
  assert.equal(appPlan({prompt:'Toon een euroteken'}).model,'nvidia/nemotron-3-super-120b-a12b:free');
  assert.equal(appPlan({prompt:'Voeg een scherm voor declaraties toe'}).model,'nvidia/nemotron-3-super-120b-a12b:free');
  assert.equal(appPlan({prompt:'Nieuwe app',mode:'create',changeSize:'small'}).format,'files');
  assert.equal(appPlan({prompt:'Repareer dit',changeSize:'large',modelId:APP_MODELS[1].id}).model,APP_MODELS[1].id);
  assert.equal(appPlan({prompt:'Add a new screen for invoices'}).size,'large');
  assert.equal(appPlan({prompt:'Build a new page for invoices'}).separateScreens,true);
  assert.throws(()=>appPlan({modelId:'paid/model'}));assert.throws(()=>appPlan({changeSize:'huge'}));
});
test('catalogus moet actuele nulprijzen bevestigen, ook overige prijsvelden',async()=>{
  const id=APP_MODELS[0].id;
  const mock=pricing=>({fetchImpl:async()=>Response.json({data:[{id,pricing}]})});
  await checkFreeAppModel(id,mock({prompt:'0',completion:'0'}));
  for(const pricing of [{prompt:null,completion:'0'},{prompt:'',completion:'0'},{prompt:'0',completion:'1'},{prompt:'0'},{prompt:'0',completion:'0',request:'0.01'},{prompt:'NaN',completion:'0'}])await assert.rejects(checkFreeAppModel(id,mock(pricing)));
  await assert.rejects(checkFreeAppModel(id,{fetchImpl:async()=>Response.json({data:[]})}));
});
test('alle patches worden vooraf gevalideerd; ambiguïteit en beschermde paden schrijven niets',()=>{
  const sources=[{path:'src/App.jsx',content:'const a=1;\nconst b=2;\n'},{path:'src/styles.css',content:'body{color:red}'}];
  const result=parseEdits(JSON.stringify({edits:[{path:'src/App.jsx',search:'const a=1;',replace:'const a=3;'},{path:'src/styles.css',search:'red',replace:'blue'}]}),sources);
  assert.match(result[0].content,/a=3/);assert.equal(sources[0].content,'const a=1;\nconst b=2;\n');
  for(const edits of [[],[{path:'src/App.jsx',search:'const',replace:'let'}],[{path:'src/App.jsx',search:'missing',replace:'x'}],[{path:'src/studio/api.js',search:'x',replace:'y'}],[{path:'src/App.jsx',search:'const a=1;',replace:'ok'},{path:'src/App.jsx',search:'missing',replace:'bad'}]]) assert.throws(()=>parseEdits(JSON.stringify({edits}),sources));
  assert.equal(sources[0].content,'const a=1;\nconst b=2;\n');
});
test('kleine context bevat foutlocatie en geldweergave, geen infra, geheimen of oude logs',()=>{
  const code=Array.from({length:700},(_,i)=>i===600?'const money = `$${amount_cents / 100}`;':i===588?'BROKEN_CONDITIONAL':`// comment ${i}`).join('\n');
  const sources=[{path:'src/App.jsx',content:code},{path:'src/main.jsx',content:'PROTECTED_ENTRY'},{path:'src/studio/supabase.js',content:'CLIENT_IMPL'},{path:'README.md',content:'Projectcontract\nRPC hr_me()'},{path:'package.json',content:'NOT_NEEDED'}];
  const result=projectContext(sources,{prompt:"Fix euro/dollar in src/App.jsx, line 589",plan:appPlan({prompt:'Herstel euro'}),feedback:'Expected brace',schema:null});
  const shown=JSON.stringify(result.records);assert.ok(shown.includes('BROKEN_CONDITIONAL'));assert.ok(shown.includes('amount_cents'));assert.ok(!shown.includes('PROTECTED_ENTRY'));assert.ok(!shown.includes('CLIENT_IMPL'));assert.ok(result.sourceCharacters<code.length);assert.ok(result.sourceCharacters<=18000);
});
test('schema alleen bij relevante vraag en context heeft duidelijke grenzen',()=>{
  const sources=[{path:'src/App.jsx',content:'export default function App(){return null}'}];
  assert.equal(projectContext(sources,{prompt:'Maak knop blauw',plan:appPlan(),schema:{marker:'people'}}).schema,'');
  assert.match(projectContext(sources,{prompt:"Employees opslaan in Supabase",plan:appPlan(),schema:{marker:'people'}}).schema,/people/);
});

test('nieuwe schermen zijn losse bestanden en App blijft een kleine ingang',()=>{
  const plan=appPlan({prompt:'Voeg een nieuw scherm toe'});
  const screen={path:'src/screens/Home.jsx',content:'export default function Home(){return null}'};
  const app={path:'src/App.jsx',content:'import Home from "./screens/Home.jsx"; export default function App(){return <Home/>}'};
  assert.doesNotThrow(()=>validateScreenStructure([app,screen],plan));
  assert.throws(()=>validateScreenStructure([app],plan));
  assert.throws(()=>validateScreenStructure([{...app,content:'// x\n'.repeat(221)},screen],plan));
  assert.throws(()=>validateScreenStructure([{...app,content:'export default function App(){return null}'},screen],plan));
  assert.doesNotThrow(()=>validateScreenStructure([{...app,content:'// x\n'.repeat(700)}],appPlan({prompt:'Herstel de kleur'})));
});
test("context volgt lokale imports of een expliciet gekozen scherm",()=>{
  const sources=[{path:'src/App.jsx',content:'export default function App(){return null}'},{path:'src/screens/Expenses.jsx',content:'import {rate} from "../lib/rate.js"; export default function Screen(){return rate}'},...Array.from({length:6},(_,i)=>({path:`src/a${i}.js`,content:'// irrelevant expense'})),{path:'src/lib/rate.js',content:'export const rate=0.20'}];
  const c=projectContext(sources,{prompt:'Herstel src/screens/Expenses.jsx',plan:appPlan()});
  assert.ok(c.records.some(r=>r.path==='src/lib/rate.js'));
});

test('geverifieerde ongewijzigde patches blokkeren echte wijzigingen niet',()=>{
  const sources=[{path:'src/styles.css',content:'button{color:blue}'}];
  const noop={path:'src/styles.css',search:'button',replace:'button'};
  const change={path:'src/styles.css',search:'blue',replace:'green'};
  assert.equal(parseEdits(JSON.stringify({edits:[noop,change]}),sources)[0].content,'button{color:green}');
  for(const edits of [[noop],[{...noop,search:'missing',replace:'missing'},change],[change,{...change,search:'green',replace:'blue'}]])assert.throws(()=>parseEdits(JSON.stringify({edits}),sources));
});
test('portaalcontext bevat een algemeen UI-contract zonder promptwoordherkenning',()=>{
  const sources=[{path:'src/App.jsx',content:'// BIM-APP-SHELL v1'}, {path:'src/app-config.json',content:'{"template":"bim-portal-v1"}'}];
  const contexts=['Maak alle knoppen groen','Herstel de berekening'].map(prompt=>projectContext(sources,{prompt,plan:appPlan()}));
  for(const context of contexts){assert.match(context.contract,/theme.accent as its background/);assert.match(context.contract,/secondary and danger/);}
  assert.equal(contexts[0].contract,contexts[1].contract);
});
