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

test('closed idle worker keeps the live session handle usable for a new input',async()=>{
 const f=await setup();try{const client=await f.connect(),{session}=await f.create(client);await f.host.nativeControlExisting(session,'fixture.worker.idle',{});
 const id=randomUUID();await f.host.submitTurn(session,{commandId:id,text:'fresh input',clientId:'owner'});assert.equal((await f.host.waitForTurn(session,id)).completed,true);
 }finally{await f.cleanup();}
});
test('worker idle followed by uncertain handle retirement fences new input before admission',async()=>{
 const f=await setup();try{f.config.engines[0].env.FIXTURE_RETIRE_RESPONSE=JSON.stringify({retired:false,reason:'retirement_unknown'});const client=await f.connect(),{session}=await f.create(client);await f.host.nativeControlExisting(session,'fixture.worker.idle',{});await (f.host as any).retireIdle(true);
 const id=randomUUID();await assert.rejects(f.host.submitTurn(session,{commandId:id,text:'new input',clientId:'owner'}),(e:any)=>e.data?.executed===false&&/waiting for confirmation/.test(e.message));assert.equal(f.host.store.receipt(id),undefined);assert.equal(f.host.diagnostics().activeAgents,1);
 await assert.rejects(f.host.nativeControlExisting(session,'fixture.background.start',{}),/waiting for confirmation/);await assert.rejects(readFile(f.log+'.background','utf8'));
 }finally{await f.cleanup();}
});
test('lost retirement acknowledgement retains the bridge and fences new input without replay',async()=>{
 const f=await setup();try{f.config.engines[0].env.FIXTURE_RETIRE_LOST='1';const client=await f.connect(),{session}=await f.create(client);await (f.host as any).retireIdle(true);
 const before=await readFile(f.log+'.retired','utf8');await (f.host as any).retireIdle(true);assert.equal(await readFile(f.log+'.retired','utf8'),before);
 const id=randomUUID();await assert.rejects(f.host.submitTurn(session,{commandId:id,text:'new input',clientId:'owner'}),/waiting for confirmation/);assert.equal(f.host.store.receipt(id),undefined);assert.equal(f.host.diagnostics().activeAgents,1);
 }finally{await f.cleanup();}
});
test('definite retirement refusal preserves a usable handle, malformed results fence it',async()=>{
 for(const result of [{retired:false,reason:'owned_work'},{retired:false,reason:'active_request'},{retired:false},{retired:'true'}]){
  const f=await setup();try{f.config.engines[0].env.FIXTURE_RETIRE_RESPONSE=JSON.stringify(result);const client=await f.connect(),{session}=await f.create(client);await (f.host as any).retireIdle(true);const id=randomUUID();
  if(result.reason){await f.host.submitTurn(session,{commandId:id,text:'new input',clientId:'owner'});assert.equal((await f.host.waitForTurn(session,id)).completed,true);}
  else {await assert.rejects(f.host.submitTurn(session,{commandId:id,text:'new input',clientId:'owner'}),/waiting for confirmation/);assert.equal(f.host.store.receipt(id),undefined);}
  }finally{await f.cleanup();}
 }
});
test('confirmed handle retirement closes only that bridge and resumes the same native history for a new input',async()=>{
 const f=await setup();try{f.config.engines[0].env.FIXTURE_LOCATIONS='1';const client=await f.connect(),{session}=await f.create(client);const identity=f.host.store.get(session)!.nativeSessionId;await f.host.nativeControlExisting(session,'fixture.worker.idle',{});await (f.host as any).retireIdle(true);assert.equal(f.host.diagnostics().activeAgents,0);
 const id=randomUUID();await f.host.submitTurn(session,{commandId:id,text:'new input',clientId:'owner'});assert.equal((await f.host.waitForTurn(session,id)).completed,true);assert.equal(f.host.store.get(session)!.nativeSessionId,identity);const rows=(await readFile(f.log,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(rows.filter((r:any)=>r.resumed?.sessionId===identity).length,1);
 }finally{await f.cleanup();}
});

test('one passive recheck of newly arrived exact retirement proof permits one NEW original input',async()=>{
 const f=await setup();try{const proof=join(f.dir,'proof.json');await writeFile(proof,JSON.stringify({retired:false}));Object.assign(f.config.engines[0].env,{FIXTURE_RETIRE_RESPONSE:JSON.stringify({retired:false,reason:'retirement_unknown'}),FIXTURE_RETIRE_STATUS_CAPABILITY:'1',FIXTURE_RETIRE_STATUS_FILE:proof,FIXTURE_LOCATIONS:'1'});const client=await f.connect(),{session}=await f.create(client);const identity=f.host.store.get(session)!.nativeSessionId;await (f.host as any).retireIdle(true);
 const first=randomUUID();await assert.rejects(f.host.submitTurn(session,{commandId:first,text:'not yet sent',clientId:'owner'}),/waiting for confirmation/);assert.equal(f.host.store.receipt(first),undefined);
 await writeFile(proof,JSON.stringify({retired:true}));const id=randomUUID();await f.host.submitTurn(session,{commandId:id,text:'NEW original input',clientId:'owner'});assert.equal((await f.host.waitForTurn(session,id)).completed,true);assert.equal(f.host.store.get(session)!.nativeSessionId,identity);
 assert.equal((await readFile(f.log+'.retirement-requests','utf8')).trim().split('\n').length,1);const statuses=(await readFile(f.log+'.retirement-status','utf8')).trim().split('\n').map(JSON.parse);assert.equal(statuses.length,2);assert.ok(statuses.every((r:any)=>r.sessionId===identity));const rows=(await readFile(f.log,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(rows.filter((r:any)=>r.resumed?.sessionId===identity).length,1);assert.equal(rows.filter((r:any)=>r.prompt).length,1);
 }finally{await f.cleanup();}
});
test('wrong identity, malformed, absent and lost passive proof retain the fence and original retirement count',async()=>{
 for(const settings of [{FIXTURE_RETIRE_STATUS:JSON.stringify({sessionId:'another-session',retired:true}),FIXTURE_RETIRE_STATUS_CAPABILITY:'1'},{FIXTURE_RETIRE_STATUS:JSON.stringify({retired:'true'}),FIXTURE_RETIRE_STATUS_CAPABILITY:'1'},{},{FIXTURE_RETIRE_STATUS_LOST:'1',FIXTURE_RETIRE_STATUS_CAPABILITY:'1'}]){
  const f=await setup();try{Object.assign(f.config.engines[0].env,{FIXTURE_RETIRE_RESPONSE:JSON.stringify({retired:false,reason:'retirement_unknown'}),...settings});const client=await f.connect(),{session}=await f.create(client);await (f.host as any).retireIdle(true);
  const id=randomUUID();await assert.rejects(f.host.submitTurn(session,{commandId:id,text:'NEW input',clientId:'owner'}),/waiting for confirmation/);assert.equal(f.host.store.receipt(id),undefined);assert.equal(f.host.diagnostics().activeAgents,1);assert.equal((await readFile(f.log+'.retirement-requests','utf8')).trim().split('\n').length,1);
  }finally{await f.cleanup();}
 }
});
test('trusted retirement reconciliation leaves prior unknown work unknown and never resubmits it',async()=>{
 const f=await setup();try{Object.assign(f.config.engines[0].env,{FIXTURE_RETIRE_RESPONSE:JSON.stringify({retired:false,reason:'retirement_unknown'}),FIXTURE_RETIRE_STATUS_CAPABILITY:'1',FIXTURE_RETIRE_STATUS:JSON.stringify({retired:true})});const client=await f.connect(),{session}=await f.create(client);const old=randomUUID();await f.host.submitTurn(session,{commandId:old,text:'original work',clientId:'owner'});await f.host.waitForTurn(session,old);f.host.store.finish(old,'unknown','original proof remains unresolved');await (f.host as any).retireIdle(true);
 const receipt=f.host.store.receipt(old);assert.deepEqual(await f.host.reconcileSessionRetirement(session),{retired:true,connectionClosed:true,workReplayed:false});assert.deepEqual(f.host.store.receipt(old),receipt);const id=randomUUID();await assert.rejects(f.host.submitTurn(session,{commandId:id,text:'new input',clientId:'owner'}),/prior execution outcome is unknown/);assert.equal(f.host.store.receipt(id),undefined);assert.equal(f.host.diagnostics().activeAgents,0);
 }finally{await f.cleanup();}
});

test('late outer retirement response cannot overwrite newer passive proof or send another retirement',async()=>{
 const f=await setup();try{Object.assign(f.config.engines[0].env,{FIXTURE_RETIRE_DELAY:'80',FIXTURE_RETIRE_STATUS_CAPABILITY:'1',FIXTURE_RETIRE_STATUS:JSON.stringify({retired:true})});const client=await f.connect(),{session}=await f.create(client);const active=(f.host as any).active.get(session);
 assert.equal(await active.agent.retireIfIdle(10),false);assert.equal(active.agent.retirementOutcome,'unknown');assert.deepEqual(await active.agent.inspectRetirement(),{retired:true});await new Promise(r=>setTimeout(r,100));assert.equal(active.agent.retirementOutcome,'retired');await (f.host as any).retireIdle(true);assert.equal(f.host.diagnostics().activeAgents,0);assert.equal((await readFile(f.log+'.retirement-requests','utf8')).trim().split('\n').length,1);
 }finally{await f.cleanup();}
});
