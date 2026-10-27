import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fetchFreeModels } from '../src/models/openrouter-catalog.mjs';
import { appPlan, checkFreeAppModel } from '../src/models/app-models.mjs';
import { createClientServer } from '../src/server/ui-server.mjs';
const free = { id:'example/new-code-model:free', name:'New Code Model', context_length:32000, pricing:{prompt:'0',completion:'0',request:'0'}, architecture:{output_modalities:['text']} };

test('live catalogue admits new free text models and rejects paid, malformed and image-only entries', async () => {
  const data = [free, {...free,id:'example/paid',pricing:{prompt:'1',completion:'1'}}, {...free,id:'example/extra-fee:free',pricing:{prompt:'0',completion:'0',request:'.01'}}, {...free,id:'example/image:free',architecture:{output_modalities:['image']}}, {...free,id:'example/invalid:free',pricing:{prompt:null,completion:'0'}}];
  const fetchImpl = async () => Response.json({data});
  assert.deepEqual(await fetchFreeModels({fetchImpl}), [free]);
  assert.equal(appPlan({modelId:free.id}).model,free.id);
  assert.equal((await checkFreeAppModel('auto',{fetchImpl})).id,free.id);
  await assert.rejects(checkFreeAppModel('example/missing:free',{fetchImpl}));
  await assert.rejects(checkFreeAppModel('example/paid',{fetchImpl}));
});

test('connection validates a private stored key without making a model completion, and catalogue requests are cached', async t => {
  const root=await mkdtemp(join(tmpdir(),'open-vibe-router-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  let catalogueCalls=0, keyCalls=0;
  const token='fixture-secret-key';
  const server=createClientServer({root,
    catalogFetch:async url=>{assert.equal(url,'https://openrouter.ai/api/v1/models');catalogueCalls++;return Response.json({data:[free]});},
    usageFetch:async(url,options)=>{assert.equal(url,'https://openrouter.ai/api/v1/key');assert.equal(options.headers.Authorization,'Bearer '+token);keyCalls++;return Response.json({data:{usage:0,is_free_tier:true}});},
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const base=`http://127.0.0.1:${server.address().port}`;
  const post=(path,body)=>fetch(base+path,{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await post('/api/config',{provider:'openrouter',token})).status,200);
  const response=await post('/api/connection',{});assert.equal(response.status,200);
  const text=await response.text();assert.ok(!text.includes(token));assert.equal(JSON.parse(text).modelCount,1);
  const catalogue=await (await fetch(base+'/api/models')).json();assert.equal(catalogue.models[0].id,free.id);
  assert.equal(keyCalls,1);assert.equal(catalogueCalls,1);
  assert.ok((await readFile(join(root,'.env.local'),'utf8')).includes(token));
});
