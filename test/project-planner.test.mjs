import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PLANNER_MODEL,plannerRequest,parsePlannerAnswer} from '../src/projects/project-planner.mjs';
import {projectContext} from '../src/projects/project-context.mjs';
import {appPlan,checkFreeAppModel} from '../src/models/app-models.mjs';
const sources=[{path:'src/App.jsx',content:'// BIM-APP-SHELL v1'},{path:'src/app-config.json',content:'{"template":"bim-portal-v1"}'},{path:'src/styles.css',content:'SECRET_SOURCE_CONTENT'},{path:'src/studio/supabase.js',content:'SECRET_KEY'},{path:'.env.local',content:'SECRET_ENV'}];
const plan={goal:'Alle teksten oranje tonen',scope:'small',files:['src/styles.css'],approach:'Gebruik de gedeelde tekststijlen.',checks:["Checker alle schermen."],missingContext:''};
test('voorbereider krijgt oorspronkelijke prompt en structuur, geen broncode of sleutels',()=>{
 const prompt='maak alle teksten oranje';const request=plannerRequest(prompt,sources);
 assert.equal(request.model,PLANNER_MODEL);assert.equal(request.response_format,undefined);assert.equal(request.provider.max_price.prompt,0);
 const data=JSON.parse(request.messages[1].content);assert.equal(request.messages.at(-1).content,prompt);assert.ok(data.files.some(f=>f.path==='src/styles.css'));
 assert.doesNotMatch(JSON.stringify(request),/SECRET_SOURCE_CONTENT|SECRET_KEY|SECRET_ENV/);
 assert.ok(!data.files.some(f=>f.path==='src/App.jsx'||f.path.startsWith('src/studio/')));
 assert.equal(appPlan({modelId:PLANNER_MODEL}).model,PLANNER_MODEL);
});
test('voorbereidingsplan vereist echte bestanden, beperkte uitvoer en alle velden',()=>{
 assert.deepEqual(parsePlannerAnswer(JSON.stringify(plan),sources),plan);
 for(const bad of [{...plan,files:['src/studio/supabase.js']},{...plan,files:['src/missing.jsx']},{...plan,scope:'huge'},{...plan,checks:[]},{...plan,files:['src/styles.css','src/styles.css']},{...plan,reasoning:'hidden'},{...plan,approach:'x'.repeat(1001)},{}])assert.throws(()=>parsePlannerAnswer(JSON.stringify(bad),sources));
 assert.throws(()=>parsePlannerAnswer('not JSON',sources));
});
test('plannerbestanden krijgen voorrang; te grote context stopt voordat bouwer wordt aangeroepen',()=>{
 const files=[...sources,...Array.from({length:10},(_,i)=>({path:`src/other${i}.js`,content:'teksten oranje'}))];
 const result=projectContext(files,{prompt:'maak teksten oranje',plan:appPlan(),preferredPaths:plan.files});
 assert.equal(result.records[0].path,'src/styles.css');
 assert.throws(()=>projectContext([{path:'src/App.jsx',content:'x'.repeat(20000)}],{prompt:'pas aan',plan:appPlan(),preferredPaths:['src/App.jsx']}),/more source context/);
});
test("voorbereidingsmodel moet op het moment of gebruik aantoonbaar gratis zijn",async()=>{
 await checkFreeAppModel(PLANNER_MODEL,{fetchImpl:async()=>Response.json({data:[{id:PLANNER_MODEL,pricing:{prompt:'0',completion:'0'}}]})});
 await assert.rejects(checkFreeAppModel(PLANNER_MODEL,{fetchImpl:async()=>Response.json({data:[{id:PLANNER_MODEL,pricing:{prompt:'0',completion:'1'}}]})}));
});

test('foutkaart maakt onderscheid tussen voorbereiding en de codebouwer',async()=>{
 const {requestFeedback}=await import('../src/build/build-feedback.mjs');
 const feedback=requestFeedback({kind:'generation',step:'planning',message:'Meer informatie nodig'},'originele opdracht');
 assert.match(feedback.title,/Planning/);assert.match(feedback.explanation,/builder did not start/);assert.equal(feedback.retryPrompt,'originele opdracht');
});

test('alle acht gekozen bestanden en een expliciet gekozen README passen mee binnen het budget',()=>{
 const files=[...sources,{path:'README.md',content:'Het projectcontract'},...Array.from({length:7},(_,i)=>({path:`src/part${i}.js`,content:'export const value=1;'}))];
 const selected=['README.md',...Array.from({length:7},(_,i)=>`src/part${i}.js`)];
 const context=projectContext(files,{prompt:'Werk de gedeelde basis bij',plan:appPlan(),preferredPaths:selected});
 for(const path of selected)assert.ok(context.records.some(r=>r.path===path));
});


test('verplichte reasoning blijft aan terwijl alleen het openbare bouwplan wordt teruggegeven',()=>{
 const request=plannerRequest('maak alle teksten oranje',sources,{reasoningMandatory:true});
 assert.deepEqual(request.reasoning,{enabled:true,exclude:true});
 assert.equal(request.max_tokens,4096);
 assert.equal(request.response_format,undefined);
});


test('bestandsschema bevat uitsluitend bestaande bewerkbare paden en de opdracht staat apart als laatste bericht',()=>{
 const prompt='kun je de teksten oranje maken';
 const request=plannerRequest(prompt,sources);
 const choices=JSON.parse(request.messages[1].content).outputSchema.properties.files.items.enum;
 assert.deepEqual(choices,['src/app-config.json','src/styles.css']);
 assert.ok(!choices.includes('src/styles.css - globale stijldefinities'));
 assert.equal(request.messages.at(-1).content,prompt);
 assert.match(request.messages[0].content,/latest user request only/);
 assert.ok(request.messages[0].content.length<800);
 assert.doesNotMatch(request.messages[1].content,/nieuw scherm zonder route|Een route is/);
});

test('Nemotron is de voorbereider en mag zonder reasoning een kort plan maken',()=>{
 const request=plannerRequest('maak teksten oranje',sources);
 assert.equal(request.model,'nvidia/nemotron-3-super-120b-a12b:free');
 assert.deepEqual(request.reasoning,{enabled:false,exclude:true});
});

test('native schema wordt alleen aangevraagd als de catalogus dat ondersteunt',()=>{
 const native=plannerRequest('teksten oranje',sources,{structuredOutputs:true});
 assert.equal(native.response_format.type,'json_schema');
 assert.deepEqual(native.response_format.json_schema.schema,JSON.parse(native.messages[1].content).outputSchema);
 const plain=plannerRequest('teksten oranje',sources);
 assert.equal(plain.response_format,undefined);assert.match(plain.messages[0].content,/only one JSON object/);
});
