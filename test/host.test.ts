import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import WebSocket from 'ws';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL,fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { AhpClient } from '@microsoft/agent-host-protocol/client';
import { WebSocketTransport } from '@microsoft/agent-host-protocol/ws';
import { chatReducer,type ChatState,type StateAction } from '@microsoft/agent-host-protocol';
import { createHost } from '../src/host.js';

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

test('scoped capability submission uses ordinary admission and observers cannot widen unrelated histories',async()=>{
 const f=await setup();let release:(()=>void)|undefined;try{
  const client=await f.connect(),one=await f.create(client),two=await f.create(client),events:any[]=[];
  release=await f.host.observeSession(one.session,event=>{events.push(event);});
  const commandId=randomUUID();const accepted=await f.host.submitTurn(one.session,{commandId,text:'media delegation',clientId:'owned-media-client'});assert.equal(accepted.accepted,true);
  const outcome=await f.host.waitForTurn(one.session,commandId);assert.equal(outcome.completed,true);assert.equal(outcome.workContinues,false);assert.match(outcome.text,/Echo: media delegation/);
  await assert.rejects(f.host.waitForTurn(two.session,commandId),/No admitted turn/);await waitFor(()=>events.some(event=>event.action.type==='chat/turnComplete'));
  await assert.rejects(f.host.submitTurn(one.session,{commandId,text:'media delegation',clientId:'owned-media-client'}),/already admitted/);
  assert.equal((await readFile(f.log,'utf8')).trim().split('\n').length,1);
  const selected=await f.host.readSessionContext(one.session,2);assert.match(selected.messages.at(-1)!.text,/Echo: media delegation/);assert.equal(selected.messages.length,2);
  assert.equal((await f.host.readSessionContext(two.session,2)).messages.length,0);
  assert.ok(events.every(event=>event.channel===one.session||event.channel===one.chat));assert.ok(events.every(event=>!event.origin||event.origin.clientSeq>=0));
  release();release=undefined;const count=events.length,id=randomUUID();await f.host.submitTurn(one.session,{commandId:id,text:'after observer left',clientId:'owned-media-client'});await waitFor(()=>f.host.store.receipt(id)?.status==='completed');assert.equal(events.length,count);
 }finally{release?.();await f.cleanup();}
});

test('official AHP client, two viewers, streaming reducer and durable admission',async()=>{
  const f=await setup();try {
    const a=await f.connect(),b=await f.connect(),{chat}=await f.create(a);
    const subA=await a.subscribe(chat,{view:{turns:20}}),subB=await b.subscribe(chat,{view:{turns:20}});
    let stateA=(subA.result.snapshot!.state as ChatState),stateB=(subB.result.snapshot!.state as ChatState);
    const eventsA:any[]=[],eventsB:any[]=[];
    const consume=async(sub:any,events:any[],update:(a:StateAction)=>void)=>{for await(const event of sub.subscription){if(event.type==='action'){events.push(event.params);if(!event.params.rejectionReason)update(event.params.action);}}};
    void consume(subA,eventsA,a=>stateA=chatReducer(stateA,a as any));void consume(subB,eventsB,a=>stateB=chatReducer(stateB,a as any));
    const turn=action('hello');a.dispatch(chat,turn);
    await waitFor(()=>stateA.turns.length===1&&stateB.turns.length===1);
    assert.deepEqual(stateA.turns,stateB.turns);assert.equal((stateA.turns[0].responseParts[0] as any).content,'Echo: hello');
    assert.equal(f.host.store.receipt(turn.turnId)?.status,'completed');
    a.dispatch(chat,turn);await waitFor(()=>eventsA.some(e=>e.rejectionReason));
    assert.equal((await readFile(f.log,'utf8')).trim().split('\n').length,1);
    assert.equal(eventsB.filter(e=>e.action.type==='chat/turnStarted'&&!e.rejectionReason).length,1);
  } finally {await f.cleanup();}
});

test('accepted work survives all viewers disconnecting; host restart resumes native identity without replay',async()=>{
  const f=await setup();try {
    const a=await f.connect(),{session,chat}=await f.create(a);await a.subscribe(chat,{view:{turns:20}});
    const turn=action('slow');a.dispatch(chat,turn);await waitFor(()=>f.host.store.receipt(turn.turnId));await a.shutdown();
    await waitFor(()=>f.host.store.receipt(turn.turnId)?.status==='completed');
    const b=await f.connect();const state=(await b.subscribe(chat,{view:{turns:20}})).result.snapshot!.state as ChatState;
    assert.equal(state.turns.length,1);assert.equal(f.host.diagnostics().activeAgents,1);assert.ok(f.host.store.get(session)?.nativeSessionId);
  }finally{await f.cleanup();}
});

test('reconnect replay, expired gap snapshots and erased baseline fresh subscribe',async()=>{
  const f=await setup({replayLimit:8});try {
    const a=await f.connect(),{chat}=await f.create(a);const initial=await a.subscribe(chat,{view:{turns:1}});const seq=initial.result.snapshot!.fromSeq;
    const turn=action('many');a.dispatch(chat,turn);await waitFor(()=>f.host.store.receipt(turn.turnId)?.status==='completed');
    const transport=await WebSocketTransport.connect(f.host.url),b=new AhpClient(transport);b.connect();f.clients.push(b);
    const result=await b.reconnect({clientId:'reconnected',lastSeenServerSeq:seq,subscriptions:[chat]});assert.equal(result.type,'snapshot');
    if(result.type==='snapshot')assert.equal((result.snapshots[0].state as ChatState).turns.length,1);
    const c=await f.connect();assert.equal(((await c.subscribe(chat,{view:{turns:1}})).result.snapshot!.state as ChatState).turns.length,1);
    const transportD=await WebSocketTransport.connect(f.host.url),d=new AhpClient(transportD);d.connect();f.clients.push(d);
    const replay=await d.reconnect({clientId:'d',lastSeenServerSeq:f.host.store.seq-1,subscriptions:[chat]});assert.equal(replay.type,'replay');
  }finally{await f.cleanup();}
});

test('ACP crash is durable unknown, rejects automatic duplicate or new execution',async()=>{
  const f=await setup();try {
    const a=await f.connect(),{chat}=await f.create(a);await a.subscribe(chat,{view:{turns:1}});const turn=action('crash');a.dispatch(chat,turn);
    await waitFor(()=>f.host.store.receipt(turn.turnId)?.status==='unknown');
    const next=action('should not replay');a.dispatch(chat,next);await new Promise(resolve=>setTimeout(resolve,80));
    assert.equal(f.host.store.receipt(next.turnId),undefined);assert.equal((await readFile(f.log,'utf8')).trim().split('\n').length,1);
  }finally{await f.cleanup();}
});

test('permission is one authoritative decision across two viewers',async()=>{
  const f=await setup();try {
    const a=await f.connect(),b=await f.connect(),{chat}=await f.create(a);await a.subscribe(chat,{view:{turns:1}});await b.subscribe(chat,{view:{turns:1}});
    const turn=action('approval');a.dispatch(chat,turn);
    await waitFor(()=>f.host.store.get(chat)?.chat.activeTurn?.responseParts.some((p:any)=>p.toolCall?.status==='pending-confirmation'));
    const approval:any={type:'chat/toolCallConfirmed',turnId:turn.turnId,toolCallId:'tool-1',approved:true,confirmed:'user-action',selectedOptionId:'allow'};
    a.dispatch(chat,approval);b.dispatch(chat,approval);
    await waitFor(()=>f.host.store.receipt(turn.turnId)?.status==='completed');
    const state=(await a.subscribe(chat,{view:{turns:1}})).result.snapshot!.state as ChatState;
    assert.equal((state.turns[0].responseParts.find((p:any)=>p.kind==='toolCall') as any).toolCall.status,'completed');
  }finally{await f.cleanup();}
});

test('catalog pages are bounded; chat windows retain full history on explicit unbounded subscribe',async()=>{
  const f=await setup();try {
    const a=await f.connect(),{chat}=await f.create(a);await a.subscribe(chat,{view:{turns:1}});
    for(let i=0;i<4;i++){const turn=action('turn '+i);a.dispatch(chat,turn);await waitFor(()=>f.host.store.receipt(turn.turnId)?.status==='completed');}
    await a.unsubscribe(chat);
    const tail=(await a.subscribe(chat,{view:{turns:1}})).result.snapshot!.state as ChatState;assert.equal(tail.turns.length,1);assert.ok(tail.turnsNextCursor);
    await a.request('fetchTurns',{channel:chat,cursor:tail.turnsNextCursor});
    const full=(await a.subscribe(chat)).result.snapshot!.state as ChatState;assert.equal(full.turns.length,4);
    const page=await a.request('listSessions',{channel:'ahp-root://',limit:1});assert.equal(page.items.length,1);
    assert.equal(f.host.diagnostics().activeAgents,1);
  }finally{await f.cleanup();}
});

test('origin and Host authority resist DNS rebinding; external workspace and forged server action rejected',async()=>{
  const f=await setup();try {
    await new Promise<void>((resolve,reject)=>{const ws=new WebSocket(f.host.url,{headers:{Host:'attacker.example',Origin:'http://attacker.example'}});ws.on('unexpected-response',(_request,response)=>{assert.equal(response.statusCode,403);response.destroy();resolve();});ws.on('open',()=>reject(new Error('Unauthorized peer connected')));ws.on('error',()=>{});});
    const a=await f.connect();await assert.rejects(a.request('createSession',{channel:'ahp-session:/forbidden',workingDirectories:['file:///etc']}));
    await assert.rejects(a.request('resourceRead',{channel:'ahp-root://',uri:pathToFileURL(join(f.dir,'missing-file')).href,encoding:'utf-8'}),(error:any)=>Number.isSafeInteger(error.code));
    const {chat}=await f.create(a);await a.subscribe(chat,{view:{turns:1}});
    a.dispatch(chat,{type:'chat/turnComplete',turnId:'forged',duration:0} as any);await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(f.host.store.turns(chat).turns.length,0);
  }finally{await f.cleanup();}
});

test('server restart preserves history/native identity and marks an uncompleted admission unknown',async()=>{
  const f=await setup();let replacement:any;try {
    const a=await f.connect(),{session,chat}=await f.create(a);await a.subscribe(chat,{view:{turns:1}});const turn=action('persisted');a.dispatch(chat,turn);await waitFor(()=>f.host.store.receipt(turn.turnId)?.status==='completed');
    const identity=f.host.store.get(session)!.nativeSessionId;
    f.host.store.transaction(()=>f.host.store.admission(chat,action('ambiguous','uncertain'),'uncertain','offline-client',99));
    await a.shutdown();await f.host.close();replacement=await createHost(f.config);
    await assert.rejects(replacement.nativeControlExisting(session,'operations.write',{operationId:'old',text:'must not restart'}),/No existing owned native runtime/);assert.equal(replacement.diagnostics().activeAgents,0);
    assert.equal(replacement.store.get(session).nativeSessionId,identity);assert.equal(replacement.store.turns(chat).turns.length,1);assert.equal(replacement.store.receipt('uncertain').status,'unknown');
    assert.equal((await readFile(f.log,'utf8')).trim().split('\n').length,1);
  }finally{if(replacement)await replacement.close();else await f.host.close();await rm(f.dir,{recursive:true,force:true});}
});

test('passive native history is paged without an ACP session/new/resume or prompt',async()=>{
  const f=await setup();let reader:any;try {
    const groups=Array.from({length:5},(_,index)=>({id:'native-turn-'+index,state:'unknown',updates:[{sessionUpdate:'user_message_chunk',content:{type:'text',text:'old '+index}},{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'answer '+index}}]}));
    const history=join(f.dir,'history.json');await writeFile(history,JSON.stringify(groups));
    const record={uri:'ahp-session:/historical',engineId:'fixture',nativeSessionId:'native-history',workingDirectory:f.dir,title:'History',createdAt:new Date().toISOString(),modifiedAt:new Date().toISOString(),status:'idle'};
    reader=await createHost({...f.config,stateDirectory:join(f.dir,'reader'),engines:f.config.engines.map((e:any)=>({...e,env:{...e.env,FIXTURE_HISTORY:history}})),catalog:{list:async()=>({items:[record]}),get:async()=>record,upsert:async()=>{}}});
    const transport=await WebSocketTransport.connect(reader.url),client=new AhpClient(transport);client.connect();await client.initialize({clientId:'history-reader',protocolVersions:['0.9.0']});
    const page=(await client.subscribe('ahp-chat:/historical',{view:{turns:2}})).result.snapshot!.state as ChatState;
    assert.equal(page.turns.length,2);assert.equal(page.turns[0].id,'native-turn-3');assert.equal(page.turns[0].state,'error');assert.ok(page.turnsNextCursor);assert.equal(reader.diagnostics().activeAgents,0);
    await assert.rejects(readFile(f.log,'utf8'));
    const full=(await client.subscribe('ahp-chat:/historical')).result.snapshot!.state as ChatState;assert.equal(full.turns.length,5);await client.shutdown();
  }finally{if(reader)await reader.close();await f.cleanup();}
});

test('ACP terminal callbacks publish standard AHP terminal state and retained output',async()=>{
  const f=await setup();try{
    const client=await f.connect(),{chat}=await f.create(client);await client.subscribe(chat,{view:{turns:1}});const turn=action('terminal');client.dispatch(chat,turn);await waitFor(()=>f.host.store.receipt(turn.turnId)?.status==='completed');
    const state=(await client.subscribe(chat,{view:{turns:1}})).result.snapshot!.state as ChatState;
    const tool=(state.turns[0].responseParts.find((part:any)=>part.kind==='toolCall') as any).toolCall;
    const terminal=tool.content.find((item:any)=>item.type==='terminal');assert.ok(terminal.resource);
    const snapshot=(await client.subscribe(terminal.resource)).result.snapshot!.state as any;assert.equal(snapshot.isPty,false);assert.equal(snapshot.lifecycle.status,'exited');assert.equal(snapshot.content[0].value,'terminal proof');
  }finally{await f.cleanup();}
});

test('client tools are targeted to their registered owner and do not mirror UI state',async()=>{
  const f=await setup();try {
    const owner=await f.connect('owner'),other=await f.connect('other'),{session,chat}=await f.create(owner);await owner.subscribe(session);const subscription=await owner.subscribe(chat,{view:{turns:1}});await other.subscribe(chat,{view:{turns:1}});
    owner.dispatch(session,{type:'session/activeClientSet',activeClient:{clientId:'owner',tools:[{name:'inspect-ui',description:'Explicit inspection'}]}} as any);
    await waitFor(()=>f.host.store.get(session)?.state.activeClients.length===1);
    f.host.config.nativeHostRequest=async()=>f.host.invokeClientTool(session,'owner','inspect-ui',{});
    // Existing process negotiated before callback injection; configure the handler through its public setup instead.
    const turn=action('slow');owner.dispatch(chat,turn);await waitFor(()=>f.host.store.receipt(turn.turnId)?.status==='dispatching');
    const result=f.host.invokeClientTool(session,'owner','inspect-ui',{});
    let toolId='';for await(const event of subscription.subscription){if(event.type==='action'&&event.params.action.type==='chat/toolCallReady'){toolId=event.params.action.toolCallId;break;}}
    other.dispatch(chat,{type:'chat/toolCallComplete',turnId:turn.turnId,toolCallId:toolId,result:{success:true,pastTenseMessage:'forged'}} as any);
    await new Promise(resolve=>setTimeout(resolve,20));
    owner.dispatch(chat,{type:'chat/toolCallComplete',turnId:turn.turnId,toolCallId:toolId,result:{success:true,pastTenseMessage:'Inspected',structuredContent:{draft:'explicit-only'}}} as any);
    assert.equal((await result).structuredContent.draft,'explicit-only');
    await waitFor(()=>f.host.store.receipt(turn.turnId)?.status==='completed');await owner.unsubscribe(session);await waitFor(()=>f.host.store.get(session)!.state.activeClients.length===0);
  }finally{await f.cleanup();}
});

test('cancellation waits for ACP completion and rejects overlapping work',async()=>{
  const f=await setup();try {
    const client=await f.connect(),{chat}=await f.create(client);await client.subscribe(chat,{view:{turns:1}});
    const first=action('slow');client.dispatch(chat,first);await waitFor(()=>f.host.store.receipt(first.turnId)?.status==='dispatching');
    client.dispatch(chat,{type:'chat/turnCancelled',turnId:first.turnId,duration:0} as any);const second=action('overlap');client.dispatch(chat,second);
    await waitFor(()=>f.host.store.receipt(first.turnId)?.status==='cancelled');assert.equal(f.host.store.receipt(second.turnId),undefined);
    const turn=f.host.store.turns(chat).turns[0];assert.equal(turn.state,'cancelled');assert.equal((turn.responseParts[0] as any).content,'Echo: slow');
  }finally{await f.cleanup();}
});

test('one host owns a state directory; a slow transport is disconnected without cancelling other viewers',async()=>{
  const f=await setup();try{
    await assert.rejects(createHost(f.config),/live owner/);
    const healthy=await f.connect('healthy'),slow=await f.connect('slow'),{chat}=await f.create(healthy);await healthy.subscribe(chat,{view:{turns:1}});await slow.subscribe(chat,{view:{turns:1}});
    const peer=[...(f.host as any).peers].find((peer:any)=>peer.clientId==='slow');Object.defineProperty(peer.socket,'bufferedAmount',{get:()=>8*1024*1024});
    const turn=action('slow');healthy.dispatch(chat,turn);await waitFor(()=>f.host.store.receipt(turn.turnId)?.status==='completed');assert.equal(f.host.diagnostics().clients,1);
  }finally{await f.cleanup();}
});

test('streaming appends narrow durable events instead of rewriting the active response checkpoint',async()=>{
  const f=await setup();try{
    const client=await f.connect(),{chat}=await f.create(client);await client.subscribe(chat,{view:{turns:1}});
    let checkpointBytes=0,checkpointWrites=0;const save=f.host.store.save.bind(f.host.store);
    f.host.store.save=(record:any)=>{checkpointWrites++;checkpointBytes+=Buffer.byteLength(JSON.stringify(record));return save(record);};
    const turn=action('many');client.dispatch(chat,turn);await waitFor(()=>f.host.store.receipt(turn.turnId)?.status==='completed');
    assert.ok(checkpointWrites<15,`Unexpected full checkpoint writes: ${checkpointWrites}`);assert.ok(checkpointBytes<30000);assert.equal((f.host.store.turns(chat).turns[0].responseParts[0] as any).content.length,100);
    assert.equal(Number(f.host.store.db.prepare('SELECT count(*) AS n FROM active_events').get()!.n),0);
  }finally{await f.cleanup();}
});


test('scheduled admission compares durable revisions, shares stop lifecycle, and never becomes a plain prompt',async()=>{
 const f=await setup();try{
  const client=await f.connect(),{session,chat}=await f.create(client);await client.subscribe(chat,{view:{turns:10}});
  const before=await f.host.inspectSession(session);
  const input={commandId:randomUUID(),text:'slow',taskId:'task',taskRevision:1,kind:'monitor' as const,expectedExecutionRevision:before.executionRevision,expectedInterruptionRevision:before.interruptionRevision,expectedConfigurationHash:before.configurationHash};
  const [first,second]=await Promise.all([f.host.submitScheduled(session,input),f.host.submitScheduled(session,{...input,commandId:randomUUID()})]);
  assert.equal(first.accepted,true);assert.equal(second.accepted,false);
  client.dispatch(chat,{type:'chat/turnCancelled',turnId:input.commandId,duration:0});
  await waitFor(()=>f.host.store.receipt(input.commandId)?.status==='cancelled');
  const after=await f.host.inspectSession(session);assert.equal(after.executionRevision,before.executionRevision+1);assert.equal(after.interruptionRevision,before.interruptionRevision+1);
  const stale=await f.host.submitScheduled(session,{...input,commandId:randomUUID()});assert.equal(stale.accepted,false);
  await assert.rejects(f.host.submitScheduled(session,input),/already admitted/);
  await assert.rejects(f.host.nativeControl(session,'schedule.submit',{}),/submitScheduled/);
  const recorded=JSON.parse((await readFile(f.log,'utf8')).trim());assert.equal(recorded.operation,'schedule.submit');assert.equal(recorded.args.inputId,input.commandId);assert.equal(recorded.args.taskRevision,1);
  const context=await f.host.readSessionContext(session);assert.equal(context.messages[0].inputOrigin,'scheduled');assert.equal(context.messages[0].scheduledRunId,input.commandId);
  const rejectedId=randomUUID();assert.equal((await f.host.submitScheduled(session,{...input,commandId:rejectedId,taskRevision:99,expectedExecutionRevision:after.executionRevision,expectedInterruptionRevision:after.interruptionRevision})).accepted,true);
  await waitFor(()=>f.host.store.receipt(rejectedId)?.status==='failed');
  assert.equal((await readFile(f.log,'utf8')).trim().split('\n').length,1);
 }finally{await f.cleanup();}
});

test('source-config creation shares durable creation and rejects changed or uncertain reuse',async()=>{
 const f=await setup();try{
  const client=await f.connect(),{session}=await f.create(client),before=await f.host.inspectSession(session);
  const input={commandId:randomUUID(),idempotencyKey:'scheduled-once',sourceSession:session,expectedConfigurationHash:before.configurationHash,title:'Created task'};
  const created=await f.host.createSession(input);assert.equal(created.creationConfirmed,true);assert.equal((await f.host.inspectSession(created.uri)).title,'Created task');
  assert.equal((await f.host.createSession(input)).uri,created.uri);assert.equal((await readFile(f.log,'utf8')).trim().split('\n').length,1);
  await assert.rejects(f.host.createSession({...input,title:'different'}),/reused/);
  await client.subscribe(session);client.dispatch(session,{type:'session/configChanged',config:{mode:'fast'}});
  await waitFor(()=>f.host.store.get(session)?.state.config?.values?.mode==='fast');
  await assert.rejects(f.host.createSession({...input,commandId:randomUUID(),idempotencyKey:'after-change'}),/configuration changed/);
  assert.equal((await f.host.submitScheduled(session,{commandId:randomUUID(),text:'must not execute',taskId:'t',taskRevision:1,kind:'task',expectedExecutionRevision:before.executionRevision,expectedInterruptionRevision:before.interruptionRevision,expectedConfigurationHash:before.configurationHash})).accepted,false);
 }finally{await f.cleanup();}
});

test('lost native creation response remains unknown and is never sent again',async()=>{
 const f=await setup();try{
  const client=await f.connect(),{session}=await f.create(client);f.config.engines[0].env.FIXTURE_CLONE_CRASH='1';
  const before=await f.host.inspectSession(session),input={commandId:randomUUID(),idempotencyKey:'lost-once',sourceSession:session,expectedConfigurationHash:before.configurationHash};
  await assert.rejects(f.host.createSession(input));assert.equal(f.host.store.receipt(input.commandId)?.status,'unknown');
  await assert.rejects(f.host.createSession(input),/unknown or incomplete/);
  assert.equal((await readFile(f.log,'utf8')).trim().split('\n').length,1);
 }finally{await f.cleanup();}
});


test('scheduled revisions and unknown creation receipts survive host restart without native replay',async()=>{
 const f=await setup();let replacement:any;try{
  const client=await f.connect(),{session,chat}=await f.create(client),before=await f.host.inspectSession(session);
  const input={commandId:randomUUID(),text:'finished',taskId:'t',taskRevision:1,kind:'task' as const,expectedExecutionRevision:before.executionRevision,expectedInterruptionRevision:before.interruptionRevision,expectedConfigurationHash:before.configurationHash};
  await f.host.submitScheduled(session,input);await waitFor(()=>f.host.store.receipt(input.commandId)?.status==='completed');
  const revision=(await f.host.inspectSession(session)).executionRevision;
  const pending=randomUUID();f.host.store.transaction(()=>{f.host.store.admission(chat,{scheduled:true},pending,'host:schedule',-99);f.host.store.bump(session,'execution');});
  await client.shutdown();await f.host.close();replacement=await createHost(f.config);
  assert.equal((await replacement.inspectSession(session)).executionRevision,revision+1);
  assert.equal(replacement.store.receipt(pending).status,'unknown');
  assert.equal((await replacement.submitScheduled(session,{...input,commandId:randomUUID()})).accepted,false);
  assert.equal((await readFile(f.log,'utf8')).trim().split('\n').length,1);
 }finally{if(replacement)await replacement.close();else await f.host.close();await rm(f.dir,{recursive:true,force:true});}
});
