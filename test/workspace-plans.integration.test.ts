import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,realpath,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHost} from '../src/host.js';
import {AhpClient} from '@microsoft/agent-host-protocol/client';
import {WebSocketTransport} from '@microsoft/agent-host-protocol/ws';

const python=process.env.PLAN_OVERVIEW_PYTHON;
test('installed native workspace plans read unopened and missing-folder chats without workers or subscriptions',{skip:!python,timeout:30000},async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'workspace-plan-installed-'))),cwd=join(root,'workspace');await mkdir(cwd);
 const config=join(root,'native.json'),sids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'];
 await writeFile(config,JSON.stringify({home:join(root,'native'),appHome:join(root,'app'),workerCommand:['/must-not-start']}));
 const files=JSON.parse(execFileSync(python!,['-I','-B','-c',`import json,sys
from pathlib import Path
from amplifier_acp.native.session_files import project_slug
root=Path(sys.argv[1]);files=[]
for index,sid in enumerate(json.loads(sys.argv[2])):
 cwd=root/('workspace' if index==0 else 'missing')
 p=root/'native'/'projects'/project_slug(str(cwd))/'sessions'/sid;p.mkdir(parents=True)
 (p/'metadata.json').write_text(json.dumps({'session_id':sid,'working_dir':str(cwd),'name':'Plan chat'}))
 rows=[]
 for done in (0,1):
  rows.extend([{'role':'user','content':'Plan'},{'role':'assistant','content':'','tool_calls':[{'id':'todo','tool':'todo','arguments':{'action':'update','todos':[{'content':'First step','status':'completed' if done else 'pending'},{'content':'Second step','status':'pending'}]}}]},{'role':'tool','tool_call_id':'todo','content':json.dumps({'status':'updated'})}])
 file=p/'transcript.jsonl';file.write_text(''.join(json.dumps(x)+'\\n' for x in rows));files.append(str(file))
print(json.dumps(files))`,root,JSON.stringify(sids)],{encoding:'utf8'}));
 const originals=await Promise.all(files.map((file:string)=>readFile(file)));
 const records=sids.map((sid,index)=>({uri:'ahp-session:/'+sid,engineId:'native',nativeSessionId:sid,workingDirectory:join(root,index?'missing':'workspace'),title:'Plan chat',createdAt:'2026-01-01T00:00:00Z',modifiedAt:'2026-01-01T00:00:00Z'}));
 const catalog:any={get:async(id:string)=>records.find(row=>row.uri===id),list:async()=>({items:records}),upsert:async()=>{}};
 const host=await createHost({stateDirectory:join(root,'host'),allowedWorkspaceRoots:[root],defaultWorkingDirectory:root,catalog,engines:[{id:'native',command:python!,args:['-I','-B','-m','amplifier_acp','--config',config]}]});
 const client=new AhpClient(await WebSocketTransport.connect(host.url));client.connect();
 try{
  const init=await client.initialize({clientId:'plan-review',protocolVersions:['0.9.0']});
  assert.equal((init as any)._meta?.['amplifier.dev/planOverview']?.passive,true);
  const ids=records.map(row=>row.uri),result:any=await client.request('x-amplifier/sessionPlans',{ids});
  assert.equal(result.readOnly,true);assert.equal(result.items.length,2);
  for(const row of result.items){assert.equal(row.plan.done,1);assert.equal(row.plan.total,2);assert.equal(row.plan.history.length,2);assert.equal(row.plan.items,undefined);}
  const details:any=await client.request('x-amplifier/sessionPlans',{ids:[ids[1]],includeItems:true});
  assert.equal(details.items[0].plan.items[0].content,'First step');
  await assert.rejects(client.request('x-amplifier/sessionPlans',{ids:[ids[0],ids[0]]}));
  await assert.rejects(client.request('x-amplifier/sessionPlans',{ids,includeItems:'yes'}));
  const missing:any=await client.request('x-amplifier/sessionPlans',{ids:['ahp-session:/unknown']});assert.equal(missing.items[0].plan.unavailable,true);
  assert.equal(host.diagnostics().activeAgents,0);
  assert.equal(host.diagnostics().workingSet.selectedNativeWindows,0);
  assert.equal(host.diagnostics().subscriptions,0);
  for(let i=0;i<files.length;i++)assert.deepEqual(await readFile(files[i]),originals[i]);
 }finally{await client.shutdown();await host.close();await rm(root,{recursive:true,force:true});}
});
