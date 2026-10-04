import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {AhpClient} from '@microsoft/agent-host-protocol/client';
import {WebSocketTransport} from '@microsoft/agent-host-protocol/ws';
const {createHost}=await import(process.env.CACHE_TEST_HOST_MODULE??'../src/host.js');
import {AcpProcess} from '../src/acp.js';
const ack={version:1,owner:'host',lifetime:'connection',standaloneIdleSeconds:60};
async function setup(options:any={}) {
 const dir=await mkdtemp(join(tmpdir(),'host-cache-')),log=join(dir,'prompts.jsonl');
 const engine={id:'fixture',label:'Fixture',command:process.execPath,args:[fileURLToPath(new URL('../fixtures/acp-peer.mjs',import.meta.url))],env:{FIXTURE_LOG:log,FIXTURE_MESSAGE_INIT:log+'.initialize',FIXTURE_RUNTIME_RETENTION:JSON.stringify(ack)}};
 const config={stateDirectory:join(dir,'state'),allowedWorkspaceRoots:[dir],engines:[engine],...options};
 const host=await createHost(config),h=host as any,clients:AhpClient[]=[];
 clearInterval(h.retireTimer); // Drive deterministic policy checks, never wait minutes.
 async function connect(){const client=new AhpClient(await WebSocketTransport.connect(host.url));client.connect();await client.initialize({clientId:randomUUID(),protocolVersions:['0.9.0'],initialSubscriptions:['ahp-root://']});clients.push(client);return client;}
 async function create(client:AhpClient){const session='ahp-session:/'+randomUUID(),chat=session.replace('ahp-session:','ahp-chat:');await client.request('createSession',{channel:session,provider:'fixture',workingDirectories:[pathToFileURL(dir).href]});await h.withLock(session,async()=>{});return {session,chat};}
 async function use(session:string){const id=randomUUID();await host.submitTurn(session,{commandId:id,text:'cache qualification',clientId:'fixture-owner'});await host.waitForTurn(session,id);await h.active.get(session).run;await h.withLock(session,async()=>{});}
 const active=(session:string)=>h.active.get(session);
 async function cleanup(){for(const c of clients)await c.shutdown();await host.close();await rm(dir,{recursive:true,force:true});}
 return {host,h,config,engine,dir,log,clients,connect,create,use,active,cleanup};
}
async function waitFor(f:()=>boolean){for(let i=0;i<200;i++){if(f())return;await new Promise(r=>setTimeout(r,5));}throw Error('Timed out');}

test('mutual retention offer is resident-only and exact acknowledgement rejects generic or malformed peers',async()=>{
 const f=await setup();try{
  const client=await f.connect(),one=await f.create(client);assert.equal(f.active(one.session).agent.runtimeRetention,'host');assert.equal(f.host.diagnostics().agentCache.hostManaged,1);
  const offered=JSON.parse((await readFile(f.log+'.initialize','utf8')).trim().split('\n')[0]);assert.deepEqual(offered.clientCapabilities._meta['amplifier.dev/host'].runtimeRetention,{version:1,owner:'host',lifetime:'connection'});
  for(const value of [null,{...ack,version:true},{...ack,owner:'native'},{...ack,lifetime:'session'},{...ack,standaloneIdleSeconds:0},{...ack,extra:true}]){
   const engine={...f.engine,env:{...f.engine.env,...(value===null?{FIXTURE_RUNTIME_RETENTION:''}:{FIXTURE_RUNTIME_RETENTION:JSON.stringify(value)})}};
   const process=new AcpProcess(engine,f.dir,{update:async()=>{},permission:async()=>({outcome:{outcome:'cancelled'}}),hostRuntimeRetention:true});
   try{await process.initialize();assert.equal(process.runtimeRetention,'unmanaged');}finally{await process.retire();}
  }
  const passive=new AcpProcess(f.engine,f.dir,{update:async()=>{},permission:async()=>({outcome:{outcome:'cancelled'}})});
  try{await passive.initialize();assert.equal(passive.runtimeRetention,'unmanaged');}finally{await passive.retire();}
  const rows=(await readFile(f.log+'.initialize','utf8')).trim().split('\n').map(JSON.parse);assert.equal(rows.at(-1).clientCapabilities._meta['amplifier.dev/host'],undefined);
 }finally{await f.cleanup();}
});

test('actual use LRU replaces insertion ordering under eight-slot pressure',async()=>{
 const f=await setup();try{
  const client=await f.connect(),sessions=[];for(let i=0;i<8;i++)sessions.push(await f.create(client));
  await f.use(sessions[0].session);const nine=await f.create(client);
  assert.equal(f.active(sessions[1].session),undefined);assert.ok(f.active(sessions[0].session));assert.ok(f.active(nine.session));assert.equal(f.host.diagnostics().activeAgents,8);assert.equal(f.host.diagnostics().startingAgents,0);
 }finally{await f.cleanup();}
});

test('viewer priority precedes LRU and all-selected cache still permits safe pressure eviction',async()=>{
 const f=await setup({maxActiveAgents:2});try{
  const client=await f.connect(),one=await f.create(client),two=await f.create(client);await client.subscribe(one.chat);await f.use(two.session);await f.create(client);
  assert.ok(f.active(one.session));assert.equal(f.active(two.session),undefined);
  const remaining=[...f.h.active.keys()].find((s:string)=>s!==one.session)!;await client.subscribe(remaining);await f.create(client);assert.equal(f.active(one.session),undefined);assert.ok(f.active(remaining));
 }finally{await f.cleanup();}
});

test('two viewers share interest; last disconnect starts grace; cold browse and reconnect never start agents',async()=>{
 const f=await setup();try{
  const a=await f.connect(),b=await f.connect(),one=await f.create(a);await f.use(one.session);await a.subscribe(one.chat);await b.subscribe(one.session);
  const entry=f.active(one.session),order=entry.useOrder;entry.lastUsed=performance.now()-1000000;entry.uninterestedSince=entry.lastUsed;
  await f.h.retireIdle();assert.equal(f.active(one.session),entry);assert.equal(entry.useOrder,order);
  await a.shutdown();await waitFor(()=>f.host.diagnostics().clients===1);assert.equal(entry.interested,true);await f.h.retireIdle();assert.equal(f.active(one.session),entry);
  await b.unsubscribe(one.session);await waitFor(()=>entry.interested===false);assert.equal(entry.interested,false);assert.ok(performance.now()-entry.uninterestedSince<1000);await f.h.retireIdle();assert.equal(f.active(one.session),entry);
  entry.uninterestedSince=performance.now()-900001;await f.h.retireIdle();assert.equal(f.active(one.session),undefined);
  const before=await readFile(f.log+'.initialize','utf8');await b.subscribe(one.chat);assert.equal(f.host.diagnostics().activeAgents,0);
  const reconnect=new AhpClient(await WebSocketTransport.connect(f.host.url));reconnect.connect();f.clients.push(reconnect);await reconnect.reconnect({clientId:randomUUID(),lastSeenServerSeq:f.host.diagnostics().serverSeq,subscriptions:[one.chat]});assert.equal(f.host.diagnostics().activeAgents,0);assert.equal(await readFile(f.log+'.initialize','utf8'),before);
 }finally{await f.cleanup();}
});

test('concurrent ninth admissions serialize reservations and never exceed eight resident or admitted starts',async()=>{
 const f=await setup();try{
  const clients=await Promise.all([f.connect(),f.connect(),f.connect()]);for(let i=0;i<8;i++)await f.create(clients[0]);
  let max=0;const sample=setInterval(()=>{const ids=new Set([...f.h.active.keys(),...f.h.admittedStarts]);max=Math.max(max,ids.size);},1);
  try{const results=await Promise.allSettled([f.create(clients[1]),f.create(clients[2])]);assert.ok(results.every(r=>r.status==='fulfilled'));assert.ok(max<=8);assert.equal(f.host.diagnostics().activeAgents,8);}finally{clearInterval(sample);}
 }finally{await f.cleanup();}
});

test('protected work and durable unknown outcomes block admission without eviction or replay',async()=>{
 const f=await setup({maxActiveAgents:1});try{
  const client=await f.connect(),one=await f.create(client),entry=f.active(one.session);
  for(const flag of ['busy','finishing','controlDepth','observationPending','updateCount']){
   entry[flag]=flag==='controlDepth'?1:true;await assert.rejects(f.create(client),/capacity/);assert.equal(f.active(one.session),entry);entry[flag]=false;
  }
  entry.permissions.set('approval',{});await assert.rejects(f.create(client),/capacity/);entry.permissions.clear();
  const id=randomUUID();f.host.store.admission(one.chat,{text:'original'},id,'owner',1);for(const status of ['admitted','dispatching','unknown'] as const){f.host.store.finish(id,status,'unresolved original');await assert.rejects(f.create(client),/capacity/);}const receipt=f.host.store.receipt(id);await assert.rejects(f.create(client),/capacity/);assert.deepEqual(f.host.store.receipt(id),receipt);assert.equal(f.active(one.session),entry);await assert.rejects(readFile(f.log+'.retirement-requests','utf8'));
 }finally{await f.cleanup();}
});

test('Native owned-work refusal tries next candidate; uncertain result stays counted with exact original retirement',async()=>{
 const f=await setup({maxActiveAgents:2});try{
  const client=await f.connect();f.engine.env.FIXTURE_RETIRE_RESPONSE=JSON.stringify({retired:false,reason:'owned_work'});const one=await f.create(client);delete f.engine.env.FIXTURE_RETIRE_RESPONSE;const two=await f.create(client);await f.create(client);assert.ok(f.active(one.session));assert.equal(f.active(two.session),undefined);
  // A genuine fixture response, not a simulated Host decision, supplies unknown.
  const g=await setup({maxActiveAgents:1});try{g.engine.env.FIXTURE_RETIRE_RESPONSE=JSON.stringify({retired:false,reason:'retirement_unknown'});const c=await g.connect(),s=await g.create(c);await assert.rejects(g.create(c),/capacity/);const before=await readFile(g.log+'.retirement-requests','utf8');await assert.rejects(g.create(c),/capacity/);assert.equal(await readFile(g.log+'.retirement-requests','utf8'),before);assert.equal(g.host.diagnostics().activeAgents,1);assert.equal(g.active(s.session).agent.retirementOutcome,'unknown');}finally{await g.cleanup();}
 }finally{await f.cleanup();}
});

test('selection or use racing candidate lock recheck prevents eviction',async()=>{
 const f=await setup({maxActiveAgents:1});try{
  const client=await f.connect(),one=await f.create(client),entry=f.active(one.session),original=f.h.withLock.bind(f.h);let raced=false;
  f.h.withLock=(uri:string,work:()=>Promise<any>)=>original(uri,async()=>{if(uri===one.session&&!raced){raced=true;await client.subscribe(one.chat);}return work();});
  assert.equal(await f.h.retireIdle(true),false);assert.equal(f.active(one.session),entry);await assert.rejects(readFile(f.log+'.retirement-requests','utf8'));
  f.h.withLock=(uri:string,work:()=>Promise<any>)=>original(uri,async()=>{if(uri===one.session)f.h.touchAgent(entry);return work();});assert.equal(await f.h.retireIdle(true),false);assert.equal(f.active(one.session),entry);
  f.h.withLock=original;
 }finally{await f.cleanup();}
});

test('owned terminal and held queue protect warm cache under capacity pressure',async()=>{
 const f=await setup({maxActiveAgents:1});try{
  const client=await f.connect(),one=await f.create(client),id=randomUUID();
  f.active(one.session).busy=true;
  await f.host.updatePendingQueue(one.session,{type:'chat/pendingMessageSet',kind:'queued',id:randomUUID(),message:{text:'held intent',origin:{kind:'user'}}},{clientId:'owner'});
  f.h.holdQueue(one.chat,'fixture-settled-with-held-work');f.active(one.session).busy=false;
  await assert.rejects(f.create(client),/capacity/);assert.ok(f.active(one.session));
  const queued=f.host.store.get(one.session)!.chat.queuedMessages[0];await f.host.updatePendingQueue(one.session,{type:'chat/pendingMessageRemoved',kind:'queued',id:queued.id},{clientId:'owner'});
  await f.host.submitTurn(one.session,{commandId:id,text:'terminal-background',clientId:'owner'});await f.host.waitForTurn(one.session,id);await f.active(one.session).run;await f.h.withLock(one.session,async()=>{});
  await assert.rejects(f.create(client),/capacity/);assert.ok(f.active(one.session));await assert.rejects(readFile(f.log+'.retirement-requests','utf8'));
 }finally{await f.cleanup();}
});

test('failed process startup releases capacity reservation for a later original request',async()=>{
 const f=await setup({maxActiveAgents:1});try{
  const client=await f.connect(),command=f.engine.command;f.engine.command=join(f.dir,'missing-executable');await assert.rejects(f.create(client));assert.equal(f.h.admittedStarts.size,0);assert.equal(f.host.diagnostics().activeAgents,0);
  f.engine.command=command;const one=await f.create(client);assert.ok(f.active(one.session));assert.equal(f.h.admittedStarts.size,0);
 }finally{await f.cleanup();}
});

test('viewer interest arriving while an earlier Native candidate refuses is rechecked against sorted snapshot',async()=>{
 const f=await setup({maxActiveAgents:3});try{
  const client=await f.connect();f.engine.env.FIXTURE_RETIRE_RESPONSE=JSON.stringify({retired:false,reason:'owned_work'});const one=await f.create(client);delete f.engine.env.FIXTURE_RETIRE_RESPONSE;const two=await f.create(client),three=await f.create(client);
  const agent=f.active(one.session).agent,retire=agent.retireIfIdle.bind(agent);agent.retireIfIdle=async(...args:any[])=>{await client.subscribe(two.chat);return retire(...args);};
  await f.create(client);assert.ok(f.active(one.session));assert.ok(f.active(two.session));assert.equal(f.active(three.session),undefined);
 }finally{await f.cleanup();}
});

test('long native control settlement renews grace and LRU for both existing and warming control paths',async()=>{
 for(const requireExisting of [true,false]){
  const f=await setup({maxActiveAgents:2});let release!:()=>void;
  try{
   const client=await f.connect(),one=await f.create(client),two=await f.create(client),entry=f.active(one.session),agent=entry.agent;
   let entered!:()=>void;const started=new Promise<void>(r=>entered=r),done=new Promise<void>(r=>release=r),rpc=agent.client.extMethod.bind(agent.client);
   agent.client.extMethod=async(method:string,params:any)=>{if(method==='_amplifier/native'&&params.operation==='configuration.snapshot'){entered();await done;}return rpc(method,params);};
   const control=requireExisting?f.host.nativeControlExisting(one.session,'configuration.snapshot',{}):f.host.nativeControl(one.session,'configuration.snapshot',{});
   await started;const before=entry.useOrder;entry.lastUsed=performance.now()-900001;entry.uninterestedSince=entry.lastUsed;
   await f.h.retireIdle();assert.equal(f.active(one.session),entry);assert.equal(entry.controlDepth,1);
   await f.use(two.session);release();const result=await control;assert.equal(result.configurationHash,'fixture-native-config');assert.equal(entry.controlDepth,0);assert.ok(entry.useOrder>before);assert.ok(performance.now()-entry.lastUsed<1000);
   await f.h.retireIdle();assert.equal(f.active(one.session),entry);
   await f.create(client);assert.equal(f.active(one.session),entry);assert.equal(f.active(two.session),undefined);
  }finally{release?.();await f.cleanup();}
 }
});

test('failed native control settlement also renews grace without manufacturing successful effect',async()=>{
 const f=await setup();let release!:()=>void;try{
  const client=await f.connect(),one=await f.create(client),entry=f.active(one.session),before=entry.useOrder;
  let entered!:()=>void;const started=new Promise<void>(r=>entered=r),done=new Promise<void>(r=>release=r);
  entry.agent.client.extMethod=async()=>{entered();await done;throw Error('Original control result unknown');};
  const control=f.host.nativeControlExisting(one.session,'configuration.snapshot',{});await started;entry.lastUsed=performance.now()-900001;entry.uninterestedSince=entry.lastUsed;release();await assert.rejects(control,/Original control result unknown/);
  assert.equal(entry.controlDepth,0);assert.ok(entry.useOrder>before);assert.ok(performance.now()-entry.lastUsed<1000);await f.h.retireIdle();assert.equal(f.active(one.session),entry);
 }finally{release?.();await f.cleanup();}
});

function gate(){let release!:()=>void,entered!:()=>void;const started=new Promise<void>(r=>entered=r),done=new Promise<void>(r=>release=r);return {release,entered,started,done};}
function age(entry:any){entry.lastUsed=performance.now()-900001;entry.uninterestedSince=entry.lastUsed;return entry.useOrder;}
async function retainedAfterSettlement(f:any,session:string,entry:any,order:number){assert.ok(entry.useOrder>order);assert.ok(performance.now()-entry.lastUsed<1000);await f.h.retireIdle();assert.equal(f.active(session),entry);}
for(const legacy of [false,true])for(const failure of [false,true])test(`class settlement: ${legacy?'legacy mode':'standard config'} actual RPC ${failure?'error':'success'} renews grace`,async()=>{
 const f=await setup(),barrier=gate();try{
  if(legacy)f.engine.env.FIXTURE_LEGACY='1';
  const client=await f.connect(),one=await f.create(client),entry=f.active(one.session),method=legacy?'setSessionMode':'setSessionConfigOption',rpc=entry.agent.client[method].bind(entry.agent.client);
  if(legacy)await new Promise(r=>setTimeout(r,60));
  entry.agent.client[method]=async(params:any)=>{barrier.entered();await barrier.done;const result=await rpc(params);if(failure)throw Error('Original config reply lost');return result;};
  client.dispatch(one.session,{type:'session/configChanged',config:{mode:'fast'}});await barrier.started;const order=age(entry);await f.h.retireIdle();assert.equal(f.active(one.session),entry);
  barrier.release();await f.h.withLock(one.session,async()=>{});await retainedAfterSettlement(f,one.session,entry,order);
  if(!failure)assert.equal(f.host.store.get(one.session)?.state.config?.values?.mode,'fast');
 }finally{barrier.release();await f.cleanup();}
});
for(const legacy of [false,true])test(`class settlement: ${legacy?'legacy unknown mode':'standard nonstring selector'} validation never renews use`,async()=>{
 const f=await setup();try{
  if(legacy)f.engine.env.FIXTURE_LEGACY='1';const client=await f.connect(),one=await f.create(client),entry=f.active(one.session);if(legacy)await new Promise(r=>setTimeout(r,60));
  const order=entry.useOrder,lastUsed=entry.lastUsed;client.dispatch(one.session,{type:'session/configChanged',config:{mode:legacy?'unknown':42}} as any);await new Promise(r=>setTimeout(r,30));await f.h.withLock(one.session,async()=>{});
  assert.equal(entry.useOrder,order);assert.equal(entry.lastUsed,lastUsed);
 }finally{await f.cleanup();}
});
for(const failure of [false,true])test(`class settlement: source clone snapshot ${failure?'error':'success'} renews source independently of target`,async()=>{
 const f=await setup(),barrier=gate();let creation:Promise<any>|undefined;try{
  const client=await f.connect(),one=await f.create(client),entry=f.active(one.session),before=await f.host.inspectSession(one.session),rpc=entry.agent.client.extMethod.bind(entry.agent.client);
  entry.agent.client.extMethod=async(method:string,params:any)=>{if(params.operation==='configuration.snapshot'){barrier.entered();await barrier.done;const result=await rpc(method,params);if(failure)throw Error('Original clone reply lost');return result;}return rpc(method,params);};
  creation=f.host.createSession({commandId:randomUUID(),idempotencyKey:randomUUID(),sourceSession:one.session,expectedConfigurationHash:before.configurationHash});void creation.catch(()=>{});
  await barrier.started;const order=age(entry);await f.h.retireIdle();assert.equal(f.active(one.session),entry);barrier.release();if(failure)await assert.rejects(creation,/Original clone reply lost/);else assert.equal((await creation).creationConfirmed,true);
  await retainedAfterSettlement(f,one.session,entry,order);
 }finally{barrier.release();await creation?.catch(()=>{});await f.cleanup();}
});
test('class settlement: startup completion starts full grace after awaited catalog projection',async()=>{
 const f=await setup(),barrier=gate();let creation:Promise<any>|undefined;try{
  const client=await f.connect(),sync=f.h.syncCatalog.bind(f.h);let selected:string|undefined;
  f.h.syncCatalog=async(record:any)=>{if(record.nativeSessionId&&!selected){selected=record.uri;barrier.entered();await barrier.done;}return sync(record);};
  creation=f.create(client);await barrier.started;const entry=f.active(selected!),order=age(entry);await f.h.retireIdle();assert.equal(f.active(selected!),entry);barrier.release();const one=await creation;await retainedAfterSettlement(f,one.session,entry,order);
 }finally{barrier.release();await creation?.catch(()=>{});await f.cleanup();}
});
test('class settlement: common run cleanup renews grace after final catalog and updates join',async()=>{
 const f=await setup(),barrier=gate();let use:Promise<void>|undefined;try{
  const client=await f.connect(),one=await f.create(client),entry=f.active(one.session),sync=f.h.syncCatalog.bind(f.h);
  f.h.syncCatalog=async(record:any)=>{if(record.uri===one.session&&entry.finishing&&!entry.busy){barrier.entered();await barrier.done;}return sync(record);};
  use=f.use(one.session);await barrier.started;const order=age(entry);await f.h.retireIdle();assert.equal(f.active(one.session),entry);barrier.release();await use;assert.equal(entry.finishing,false);await retainedAfterSettlement(f,one.session,entry,order);
 }finally{barrier.release();await use?.catch(()=>{});await f.cleanup();}
});
test('class settlement: refused relocation actual peer response renews retained source',async()=>{
 const f=await setup(),barrier=gate();let relocation:Promise<any>|undefined;try{
  const client=await f.connect(),one=await f.create(client),entry=f.active(one.session),before=await f.host.inspectSession(one.session),rpc=entry.agent.client.extMethod.bind(entry.agent.client);
  entry.agent.client.extMethod=async(method:string,params:any)=>{if(params.operation==='session.relocate'){barrier.entered();await barrier.done;return rpc(method,{...params,args:{...params.args,expectedExecutionRevision:params.args.expectedExecutionRevision+1}});}return rpc(method,params);};
  relocation=f.host.relocateSession(one.session,{commandId:randomUUID(),target:f.dir,expectedExecutionRevision:before.executionRevision});await barrier.started;const order=age(entry);barrier.release();assert.equal((await relocation).applied,false);await retainedAfterSettlement(f,one.session,entry,order);
 }finally{barrier.release();await relocation?.catch(()=>{});await f.cleanup();}
});
test('class settlement: matching cancellation RPC settling after parent turn renews grace',async()=>{
 const f=await setup(),barrier=gate();let cancel:Promise<any>|undefined;try{
  const client=await f.connect(),one=await f.create(client),entry=f.active(one.session),id=randomUUID();await f.host.submitTurn(one.session,{commandId:id,text:'slow',clientId:'owner'});await waitFor(()=>!!entry.generationId);
  const rpc=entry.agent.client.cancel.bind(entry.agent.client);entry.agent.client.cancel=async(params:any)=>{await rpc(params);barrier.entered();await barrier.done;};
  cancel=f.host.interruptSession(one.session,{commandId:randomUUID(),turnId:id,clientId:'owner'});await barrier.started;await entry.run;const order=age(entry);await f.h.retireIdle();assert.equal(f.active(one.session),entry);barrier.release();assert.equal((await cancel).delivery,'requested');await retainedAfterSettlement(f,one.session,entry,order);
 }finally{barrier.release();await cancel?.catch(()=>{});await f.cleanup();}
});
test('class settlement: steering actual RPC completion renews use without a new prompt',async()=>{
 const f=await setup(),barrier=gate();try{
  const client=await f.connect(),one=await f.create(client),entry=f.active(one.session),id=randomUUID();await f.host.submitTurn(one.session,{commandId:id,text:'queue-hold',clientId:'owner'});await waitFor(()=>!!entry.generationId);
  const rpc=entry.agent.client.extMethod.bind(entry.agent.client);entry.agent.client.extMethod=async(method:string,params:any)=>{if(params.operation==='steer.submit'){const result=await rpc(method,params);barrier.entered();await barrier.done;return result;}return rpc(method,params);};
  const steering=randomUUID();await f.host.updatePendingQueue(one.session,{type:'chat/pendingMessageSet',kind:'steering',id:steering,message:{text:'held steering',origin:{kind:'user'}}} as any,{clientId:'owner'});
  await barrier.started;const order=age(entry);barrier.release();await waitFor(()=>entry.steeringRuns.size===0);assert.equal(f.host.store.receipt(steering)?.status,'failed');assert.equal(entry.controlDepth,0);assert.ok(entry.useOrder>order);assert.ok(performance.now()-entry.lastUsed<1000);await entry.run;
  assert.equal((await readFile(f.log,'utf8')).trim().split('\n').length,1);
 }finally{barrier.release();await f.cleanup();}
});
test('class settlement: generation-bound late steering disposition renews grace; duplicate event is passive',async()=>{
 const f=await setup();try{
  const client=await f.connect(),one=await f.create(client),entry=f.active(one.session),id=randomUUID();await f.host.submitTurn(one.session,{commandId:id,text:'slow',clientId:'owner'});await waitFor(()=>!!entry.generationId);
  const steering=randomUUID();await f.host.updatePendingQueue(one.session,{type:'chat/pendingMessageSet',kind:'steering',id:steering,message:{text:'after-turn steering',origin:{kind:'user'}}} as any,{clientId:'owner'});await entry.run;const order=age(entry);
  await waitFor(()=>f.host.store.receipt(steering)?.status==='failed');await retainedAfterSettlement(f,one.session,entry,order);const settled=entry.useOrder;f.h.settleSteering(one.session,steering,'held','duplicate');assert.equal(entry.useOrder,settled);
 }finally{await f.cleanup();}
});
test('class settlement: all known Native read and polling controls never renew existing cache use',async()=>{
 const f=await setup();try{
  const client=await f.connect(),one=await f.create(client),entry=f.active(one.session);
  const reads=['capabilities','configuration.inspect','configuration.exportResources','configuration.providers','configuration.providerModels','configuration.providerLoginStatus','catalog.inspect','usage.inspect','context.clear.review','goals.get','budget.get','mode.list','native.status','bundle.preview','capacity.get','task.get','task.receipt','task.history','session.relocation.inspect','runtime.inspect','workers.inspect'];
  const order=age(entry),lastUsed=entry.lastUsed;
  for(const requireExisting of [false,true])for(const op of reads){const result=requireExisting?await f.host.nativeControlExisting(one.session,op,{}):await f.host.nativeControl(one.session,op,{});assert.equal(result.passive,op);assert.equal(entry.useOrder,order,op);assert.equal(entry.lastUsed,lastUsed,op);}
  await f.h.retireIdle();assert.equal(f.active(one.session),undefined);
 }finally{await f.cleanup();}
});
for(const failure of [false,true])test(`class settlement: final update join ${failure?'failure':'success'} renews completed turn grace`,async()=>{
 const f=await setup(),barrier=gate();let use:Promise<void>|undefined;try{
  const client=await f.connect(),one=await f.create(client),entry=f.active(one.session),sync=f.h.syncCatalog.bind(f.h);let held=false;
  f.h.syncCatalog=async(record:any)=>{if(record.uri===one.session&&entry.finishing&&!entry.busy&&!held){held=true;entry.updates=entry.updates.then(async()=>{barrier.entered();await barrier.done;if(failure)throw Error('Final update projection unavailable');});}return sync(record);};
  use=f.use(one.session);await barrier.started;const order=age(entry);await f.h.retireIdle();assert.equal(f.active(one.session),entry);barrier.release();await use;assert.equal(entry.finishing,false);await retainedAfterSettlement(f,one.session,entry,order);
 }finally{barrier.release();await use?.catch(()=>{});await f.cleanup();}
});
test('class settlement: failed passive polls and undispatched Native validation never renew use',async()=>{
 const f=await setup();try{
  const client=await f.connect(),one=await f.create(client),entry=f.active(one.session),rpc=entry.agent.client.extMethod.bind(entry.agent.client);
  entry.agent.client.extMethod=async(method:string,params:any)=>{await rpc(method,params);throw Error('Passive reply lost');};
  const order=entry.useOrder,lastUsed=entry.lastUsed;
  for(const requireExisting of [false,true]){await assert.rejects(f.host.nativeControl(one.session,'configuration.providerLoginStatus',{}, {requireExisting}),/Passive reply lost/);assert.equal(entry.useOrder,order);assert.equal(entry.lastUsed,lastUsed);}
  entry.agent.initialized.agentCapabilities._meta['amplifier.dev/native'].version=0;
  await assert.rejects(f.host.nativeControl(one.session,'configuration.snapshot',{}),/not negotiated/);assert.equal(entry.useOrder,order);assert.equal(entry.lastUsed,lastUsed);
 }finally{await f.cleanup();}
});
test('class settlement: steering acceptance timeout preserves underlying request depth and unknown receipt',async()=>{
 const f=await setup({steeringOutcomeTimeoutMs:30}),barrier=gate();try{
  const client=await f.connect(),one=await f.create(client),entry=f.active(one.session),id=randomUUID();await f.host.submitTurn(one.session,{commandId:id,text:'slow',clientId:'owner'});await waitFor(()=>!!entry.generationId);
  const rpc=entry.agent.client.extMethod.bind(entry.agent.client);entry.agent.client.extMethod=async(method:string,params:any)=>{if(params.operation==='steer.submit'){barrier.entered();await barrier.done;}return rpc(method,params);};
  const steering=randomUUID();await f.host.updatePendingQueue(one.session,{type:'chat/pendingMessageSet',kind:'steering',id:steering,message:{text:'held steering',origin:{kind:'user'}}} as any,{clientId:'owner'});await barrier.started;
  await entry.run;const unknown=f.host.store.receipt(steering);assert.equal(unknown?.status,'unknown');assert.equal(entry.controlDepth,1);const order=age(entry);await f.h.retireIdle();assert.equal(f.active(one.session),entry);
  barrier.release();await waitFor(()=>entry.controlDepth===0);assert.ok(entry.useOrder>order);assert.deepEqual(f.host.store.receipt(steering),unknown);await f.h.retireIdle();assert.equal(f.active(one.session),entry);
  await assert.rejects(f.host.submitTurn(one.session,{commandId:randomUUID(),text:'do not replay',clientId:'owner'}),/unknown/);assert.equal((await readFile(f.log,'utf8')).trim().split('\n').length,1);
 }finally{barrier.release();await f.cleanup();}
});
