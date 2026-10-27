import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {scaffold,saveSource,projectPath} from '../src/projects/project-files.mjs';
import {prepareProjectAnswer} from '../src/parsing/project-answer.mjs';
import {projectContext} from '../src/projects/project-context.mjs';
import {validatePortalConfig,PORTAL_CONFIG} from '../src/projects/portal-project.mjs';
import {buildProject,runtimeDirectory} from '../src/build/project-build.mjs';
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'bim-portal-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));await scaffold(dir,runtimeDirectory,{name:'Portaal Test'});return dir;}
async function sources(dir,prefix='src/'){const out=[];for(const e of await readdir(join(dir,prefix),{withFileTypes:true})){const path=prefix+e.name;if(e.isDirectory())out.push(...await sources(dir,path+'/'));else out.push({path,content:await readFile(join(dir,path),'utf8')});}return out;}
const plan={format:'files',separateScreens:true,size:'large',contextLimit:65000};
test('nieuw skelet krijgt configureerbare layout, optionele login en beschermde componenten',async t=>{
 const dir=await fixture(t),all=await sources(dir),config=JSON.parse(all.find(f=>f.path===PORTAL_CONFIG).content);
 assert.equal(config.appName,'Portaal Test');assert.equal(config.authentication,'none');assert.equal(config.footer.text,'Portaal Test');
 for(const file of ['App.jsx','studio/ui/AppShell.jsx','studio/ui/components.jsx','studio/ui/session.jsx','studio/ui/portal.css','screens/HomeScreen.jsx'])assert.ok(all.some(f=>f.path==='src/'+file));
 assert.doesNotThrow(()=>validatePortalConfig(config,new Set(all.map(f=>f.path))));
 assert.throws(()=>projectPath('src/studio/ui/AppShell.jsx'),/manages/);
 await assert.rejects(saveSource(dir,'src/App.jsx','export default function App(){return null}'),/Open Vibe Coder manages/);
 const readme=await readFile(join(dir,'README.md'),'utf8');assert.ok(readme.includes('app-config.json'));
});
test('één nieuw scherm wordt lokaal geregistreerd zonder App.jsx te herschrijven',async t=>{
 const dir=await fixture(t),all=await sources(dir),entry=all.find(f=>f.path==='src/App.jsx').content;
 const input={files:[{path:"src/screens/EmployeesScreen.jsx",content:"export default function EmployeesScreen(){return <h1>Employees</h1>}"}]};
 const out=await prepareProjectAnswer(JSON.stringify(input),{plan,sources:all});
 assert.equal(out.heuristics[0].id,'portal-route-registry-v1');assert.ok(!out.files.some(f=>f.path==='src/App.jsx'));
 const config=JSON.parse(out.files.find(f=>f.path===PORTAL_CONFIG).content);assert.deepEqual(config.routes[1],{path:'/employees',title:"Employees",screen:"EmployeesScreen",icon:'page'});
 for(const f of out.files)await saveSource(dir,f.path,f.content);
 assert.equal(await readFile(join(dir,'src/App.jsx'),'utf8'),entry);
 const again=await prepareProjectAnswer(JSON.stringify(input),{plan,sources:await sources(dir)});assert.deepEqual(again.heuristics,[]);
});
test('portaal weigert entry-overschrijving, dubbele routes en ontbrekende schermen',async t=>{
 const dir=await fixture(t),all=await sources(dir),config=JSON.parse(all.find(f=>f.path===PORTAL_CONFIG).content);
 await assert.rejects(prepareProjectAnswer(JSON.stringify({files:[{path:'src/App.jsx',content:'export default function App(){return null}'}]}),{plan,sources:all}),/Open Vibe Coder manages/);
 await assert.rejects(prepareProjectAnswer(JSON.stringify({files:[{path:"src/screens/StartScreen.jsx",content:"export default function StartScreen(){return null}"}]}),{plan,sources:all}),/menu path already exists/);
 for(const bad of [{...config,routes:[...config.routes,...config.routes]},{...config,routes:[{path:'/bad',title:'Bad',screen:'Missing'}]},{...config,authentication:'fake'},{...config,theme:{primary:'url(x)',accent:'#ffffff'}}])assert.throws(()=>validatePortalConfig(bad,new Set(all.map(f=>f.path))));
});
test('portaalcontext verstuurt schermen/config en een klein componentcontract, niet de layoutbron',async t=>{
 const dir=await fixture(t),all=await sources(dir),context=projectContext(all,{prompt:'Voeg een nieuw scherm toe',plan});
 assert.equal(context.portal,true);assert.ok(context.records.some(f=>f.path===PORTAL_CONFIG));assert.ok(context.records.every(f=>!f.path.startsWith('src/studio/')&&f.path!=='src/App.jsx'));
 assert.ok(context.contract.includes('ConfirmDialog'));assert.ok(context.sourceCharacters<6000);
});
test("portaal bouwt echt zonder koppelingen en na toevoegen of een scherm", {skip:process.platform!=='darwin',timeout:30000},async t=>{
 const dir=await fixture(t);assert.equal((await buildProject(dir)).passed,true);
 const out=await prepareProjectAnswer(JSON.stringify({files:[{path:'src/screens/ContactScreen.jsx',content:"import {Page,Button} from '../studio/ui/components.jsx'; export default function ContactScreen(){return <Page title='Contact'><Button onClick={()=>{}}>Contact</Button></Page>}"}]}),{plan,sources:await sources(dir)});
 for(const f of out.files)await saveSource(dir,f.path,f.content);assert.equal((await buildProject(dir)).passed,true);
 const cfg=JSON.parse(await readFile(join(dir,PORTAL_CONFIG),'utf8'));cfg.routes[1].screen='Missing';await writeFile(join(dir,PORTAL_CONFIG),JSON.stringify(cfg));await assert.rejects(buildProject(dir),/missing screen registration/);
});
