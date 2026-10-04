import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,realpath,readFile,rm,writeFile } from 'node:fs/promises';
import WebSocket from 'ws';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL,fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { AhpClient } from '@microsoft/agent-host-protocol/client';
import { WebSocketTransport } from '@microsoft/agent-host-protocol/ws';
import { chatReducer,type ChatState,type StateAction } from '@microsoft/agent-host-protocol';
import { createHost,MessageUnavailableError } from '../src/host.js';

async function setup(options:any={}) {
  const dir=await mkdtemp(join(tmpdir(),'ahp-host-'));const log=join(dir,'prompts.jsonl');
  const config={stateDirectory:join(dir,'state'),allowedWorkspaceRoots:[dir],engines:[{id:'fixture',label:'Fixture',command:process.execPath,args:[fileURLToPath(new URL('./agent.mjs',import.meta.url))],env:{FIXTURE_LOG:log}}],...options};
  const host=await createHost(config);const clients:AhpClient[]=[];
  async function connect(id=randomUUID()) {const transport=await WebSocketTransport.connect(host.url);const client=new AhpClient(transport);client.connect();await client.initialize({clientId:id,protocolVersions:['0.9.0'],initialSubscriptions:['ahp-root://']});clients.push(client);return client;}
  async function create(client:AhpClient) {const session='ahp-session:/'+randomUUID(),chat=session.replace('ahp-session:','ahp-chat:');await client.request('createSession',{channel:session,provider:'fixture',workingDirectories:[pathToFileURL(dir).href]});return {session,chat};}
  async function cleanup(){for(const client of clients)await client.shutdown();await host.close();await rm(dir,{recursive:true,force:true});}
  return {dir,log,config,host,clients,connect,create,cleanup};
}
function action(text:string,turnId=randomUUID()):any{return {type:'chat/turnStarted',turnId,startedAt:new Date().toISOString(),message:{text,origin:{kind:'user'}}};}
async function waitFor(predicate:()=>unknown,timeout=5000){const deadline=Date.now()+timeout;while(Date.now()<deadline){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Timed out');}

test('uncertain retirement plus actual outer connection loss stays refused before NEW input admission',async()=>{
 const f=await setup();try{Object.assign(f.config.engines[0].env,{FIXTURE_RETIRE_RESPONSE:JSON.stringify({retired:false,reason:'retirement_unknown'}),FIXTURE_RETIRE_STATUS_CAPABILITY:'1',FIXTURE_LOCATIONS:'1'});const client=await f.connect(),{session}=await f.create(client);await (f.host as any).retireIdle(true);const active=(f.host as any).active.get(session),fence=f.host.store.get(session)!.state._meta!['amplifier.dev/retirement'];active.agent.process.kill('SIGTERM');await waitFor(()=>active.agent.closed);
 const id=randomUUID();await assert.rejects(f.host.submitTurn(session,{commandId:id,text:'NEW input',clientId:'owner'}),/waiting for confirmation/);assert.equal(f.host.store.receipt(id),undefined);assert.deepEqual(f.host.store.get(session)!.state._meta!['amplifier.dev/retirement'],fence);assert.equal(f.host.diagnostics().activeAgents,1);const rows=(await readFile(f.log,'utf8').catch(()=>'' )).trim().split('\n').filter(Boolean).map(JSON.parse);assert.equal(rows.filter((r:any)=>r.resumed||r.prompt).length,0);
 }finally{await f.cleanup();}
});
test('closed unknown entry cannot satisfy lifecycle or host quiescence shortcuts',async()=>{
 const f=await setup();try{await (f.host as any).quiesceLifecycle({uri:'ahp-session:/cold-unmounted'});f.config.engines[0].env.FIXTURE_RETIRE_RESPONSE=JSON.stringify({retired:false,reason:'retirement_unknown'});const client=await f.connect(),{session}=await f.create(client);await (f.host as any).retireIdle(true);const active=(f.host as any).active.get(session);active.agent.process.kill('SIGTERM');await waitFor(()=>active.agent.closed);
 await assert.rejects((f.host as any).quiesceLifecycle({uri:session}),/waiting for confirmation/);assert.deepEqual(await (f.host as any).quiesceAgents(),{ready:false,unknown:true,reason:'native-retirement-unconfirmed'});assert.equal((f.host as any).active.get(session),active);
 const plan=f.host.store.db.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM receipts WHERE client_id='host:retirement' AND json_extract(payload,'$.status') IN ('admitted','unknown') LIMIT 1").all();assert.ok(plan.some((r:any)=>r.detail.includes('receipt_origin_lookup')));
 }finally{await f.cleanup();}
});
test('Host restart preserves retirement uncertainty without reopening the original history',async()=>{
 const f=await setup();let replacement:any,closed=false;try{Object.assign(f.config.engines[0].env,{FIXTURE_RETIRE_RESPONSE:JSON.stringify({retired:false,reason:'retirement_unknown'}),FIXTURE_RETIRE_STATUS_CAPABILITY:'1',FIXTURE_LOCATIONS:'1'});const client=await f.connect(),{session}=await f.create(client);await (f.host as any).retireIdle(true);const fence=f.host.store.get(session)!.state._meta!['amplifier.dev/retirement'],receipt=f.host.store.receipt((fence as any).commandId);for(const c of f.clients)await c.shutdown();await f.host.close();closed=true;const before=await readFile(f.log,'utf8').catch(()=>'' );replacement=await createHost(f.config);
 assert.deepEqual(replacement.store.get(session).state._meta['amplifier.dev/retirement'],fence);assert.deepEqual(replacement.store.receipt((fence as any).commandId),receipt);const id=randomUUID();await assert.rejects(replacement.submitTurn(session,{commandId:id,text:'NEW input after Host restart',clientId:'owner'}),/waiting for confirmation/);assert.equal(replacement.store.receipt(id),undefined);assert.equal(replacement.diagnostics().activeAgents,0);assert.equal(await readFile(f.log,'utf8').catch(()=>'' ),before);assert.equal((await replacement.reconcileSessionRetirement(session)).retired,false);assert.equal((await replacement.quiesceAgents()).unknown,true);
 }finally{if(replacement)await replacement.close();if(closed)await rm(f.dir,{recursive:true,force:true});else await f.cleanup();}
});
test('pending retirement is journaled before the RPC and survives loss of that outer connection',async()=>{
 const f=await setup();try{f.config.engines[0].env.FIXTURE_RETIRE_LOST='1';const client=await f.connect(),{session}=await f.create(client);const active=(f.host as any).active.get(session),attempt=(f.host as any).withLock(session,()=>(f.host as any).retireActive(session,active,60));await waitFor(()=>f.host.store.get(session)!.state._meta?.['amplifier.dev/retirement']);const fence=f.host.store.get(session)!.state._meta!['amplifier.dev/retirement'] as any;assert.equal(fence.outcome,'pending');assert.equal(f.host.store.receipt(fence.commandId)?.status,'admitted');active.agent.process.kill('SIGTERM');assert.equal(await attempt,false);await waitFor(()=>active.agent.closed);assert.equal((f.host.store.get(session)!.state._meta!['amplifier.dev/retirement'] as any).outcome,'unknown');assert.equal(f.host.store.receipt(fence.commandId)?.status,'unknown');
 const id=randomUUID();await assert.rejects(f.host.submitTurn(session,{commandId:id,text:'NEW input',clientId:'owner'}),/waiting for confirmation/);assert.equal(f.host.store.receipt(id),undefined);
 }finally{await f.cleanup();}
});
test('status cannot clear a changed captured retirement fence',async()=>{
 const f=await setup();try{Object.assign(f.config.engines[0].env,{FIXTURE_RETIRE_RESPONSE:JSON.stringify({retired:false,reason:'retirement_unknown'}),FIXTURE_RETIRE_STATUS_CAPABILITY:'1',FIXTURE_RETIRE_STATUS:JSON.stringify({retired:true})});const client=await f.connect(),{session}=await f.create(client);await (f.host as any).retireIdle(true);const record=f.host.store.get(session)!;record.state._meta!['amplifier.dev/retirement']={...(record.state._meta!['amplifier.dev/retirement'] as any),connectionId:'different-captured-connection'};f.host.store.saveSessionMetadata(record);
 assert.equal((await f.host.reconcileSessionRetirement(session)).retired,false);await assert.rejects(readFile(f.log+'.retirement-status','utf8'));const id=randomUUID();await assert.rejects(f.host.submitTurn(session,{commandId:id,text:'NEW input',clientId:'owner'}),/waiting for confirmation/);assert.equal(f.host.store.receipt(id),undefined);
 }finally{await f.cleanup();}
});
test('definitive refusal and confirmed retirement leave safe cold resume unchanged after restart',async()=>{
 for(const proof of [{retired:false,reason:'owned_work'},{retired:true}]){
  const f=await setup();let replacement:any,closed=false;try{f.config.engines[0].env.FIXTURE_RETIRE_RESPONSE=JSON.stringify(proof);const client=await f.connect(),{session}=await f.create(client);const identity=f.host.store.get(session)!.nativeSessionId;await (f.host as any).retireIdle(true);assert.equal(f.host.store.get(session)!.state._meta?.['amplifier.dev/retirement'],undefined);for(const c of f.clients)await c.shutdown();await f.host.close();closed=true;replacement=await createHost(f.config);
  const id=randomUUID();await replacement.submitTurn(session,{commandId:id,text:'NEW input',clientId:'owner'});assert.equal((await replacement.waitForTurn(session,id)).completed,true);assert.equal(replacement.store.get(session).nativeSessionId,identity);
  }finally{if(replacement)await replacement.close();if(closed)await rm(f.dir,{recursive:true,force:true});else await f.cleanup();}
 }
});
