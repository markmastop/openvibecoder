import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prepareProjectAnswer} from '../src/parsing/project-answer.mjs';
import {parseJsx} from '../src/parsing/source-parser.mjs';
import {readFile} from 'node:fs/promises';
const plan={format:'files',separateScreens:true};
const source=`import React,{useState,useEffect} from 'react';
import {getSupabase} from './studio/supabase.js';
export default function App(){
 const [user,setUser]=useState(null);
 const [page,setPage]=useState('dashboard');
 useEffect(()=>{getSupabase().auth.getSession().then(s=>setUser(s.data.session?.user))},[]);
 const logout=()=>setUser(null);
 if(!user)return <form onSubmit={()=>setUser({name:'Test'})}><button>Sign in</button></form>;
 return <>{page==='dashboard'?<main><h1>{user.name}</h1><button onClick={()=>setPage('sick')}>Open</button></main>:<main><button onClick={logout}>Sign out</button><button onClick={()=>setPage('dashboard')}>Back</button></main>}</>;
}`;
const envelope=content=>JSON.stringify({files:[{path:'src/App.jsx',content}]});
test('AST-schermheuristiek bewaart JSX, handlers, hooks en relatieve imports',async()=>{
 const result=await prepareProjectAnswer(envelope(source),{plan});
 assert.equal(result.heuristics[0].id,'split-react-screens-v1');
 assert.equal(result.files.filter(f=>f.path.startsWith('src/screens/')).length,3);
 const entry=result.files.find(f=>f.path==='src/App.jsx').content;
 assert.ok(entry.split('\n').length<220);assert.ok(entry.includes('useStudioApp()'));
 const hook=result.files.find(f=>f.path==='src/hooks/useStudioApp.jsx').content;
 assert.ok(hook.includes('"../studio/supabase.js"'));assert.ok(hook.includes("useState('dashboard')"));assert.ok(hook.includes('useEffect('));
 assert.ok(result.files.some(f=>f.content.includes("<button onClick={logout}>Sign out</button>")));
 for(const f of result.files)await parseJsx(f.content);
});
test('reeds losse schermen blijven ongewijzigd; tweede verwerking is idempotent',async()=>{
 const first=await prepareProjectAnswer(envelope(source),{plan});
 const again=await prepareProjectAnswer(JSON.stringify({files:first.files}),{plan});
 assert.deepEqual(again.files,first.files);assert.deepEqual(again.heuristics,[]);
});
test('heuristiek weigert overschrijven, verweven hooks en contextafhankelijke code',async()=>{
 await assert.rejects(prepareProjectAnswer(envelope(source),{plan,sources:[{path:'src/hooks/useStudioApp.jsx',content:'eigen code'}]}),/overwrite/);
 await assert.rejects(prepareProjectAnswer(envelope(source.replace("if(!user)return", "if(!user)return").replace('return <>',"useEffect(()=>{},[]); return <>")),{plan}),/interleaved/);
 await assert.rejects(prepareProjectAnswer(envelope(source.replace('const logout=()=>setUser(null);','const logout=()=>arguments[0];')),{plan}),/context-dependent/);
 await assert.rejects(prepareProjectAnswer(envelope(source.replace('function App()','function App(props)')),{plan}),/parameters/);
});
test('toekomstige layoutregels zijn expliciet toevoegbaar en krijgen padvalidatie',async()=>{
 const first=await prepareProjectAnswer(envelope(source),{plan});
 const header={id:'test-header',description:'Opt-in header',applies:()=>true,transform:({files})=>({files:[...files,{path:'src/components/Header.jsx',content:'export default function Header(){return <header>Voorbeeld</header>}'}]})};
 const custom=await prepareProjectAnswer(JSON.stringify({files:first.files}),{plan},{rules:[header]});
 assert.equal(custom.heuristics[0].id,'test-header');assert.ok(custom.files.some(f=>f.path==='src/components/Header.jsx'));
 await assert.rejects(prepareProjectAnswer(JSON.stringify({files:first.files}),{plan},{rules:[{...header,transform:({files})=>({files:[...files,{path:'../outside.js',content:'x'}]})}]}),/Only source files/);
});
test("small patches starten geen architectuurheuristiek",async()=>{
 const result=await prepareProjectAnswer(JSON.stringify({edits:[{path:'src/App.jsx',search:"Sign in",replace:'Aanmelden'}]}),{plan:{format:'edits',separateScreens:false},sources:[{path:'src/App.jsx',content:source}]},{rules:[{id:'must-not-run',applies:()=>{throw new Error('mag niet')}}]});
 assert.deepEqual(result.heuristics,[]);assert.ok(result.files[0].content.includes('Aanmelden'));
});
test('desktopvoorbereiding bundelt heuristieken en de bestaande vaste AST-parser',async()=>{
 const prep=await readFile(new URL('../scripts/prepare-desktop.mjs',import.meta.url),'utf8');
 for(const name of ['src', 'templates', 'runtime/frontend', 'test/acceptance', 'runtime/specs', 'parser/babel.mjs', 'PRETTIER-LICENSE'])assert.ok(prep.includes(name));
});

test('extensieregel kan de uiteindelijke schermcontrole niet uitschakelen door contextmutatie',async()=>{
 const original={...plan};
 const rule={id:'test-context',applies:()=>true,transform:input=>{input.plan.separateScreens=false;return {files:input.files}}};
 await assert.rejects(prepareProjectAnswer(envelope(source),{plan:original},{rules:[rule]}),/separate file/);
 assert.equal(original.separateScreens,true);
});
test('heuristiek weigert conflicterende importnamen en behoudt geneste routetest',async()=>{
 await assert.rejects(prepareProjectAnswer(envelope(source.replace('import React,','import useStudioApp from "./custom.js"; import React,')),{plan}),/Name conflict/);
 const result=await prepareProjectAnswer(envelope(source.replace("page==='dashboard'?", "(user ? page==='dashboard' : false)?")),{plan});
 const entry=result.files.find(f=>f.path==='src/App.jsx').content;
 assert.ok(entry.includes("((user ? page==='dashboard' : false) ?"));
});
