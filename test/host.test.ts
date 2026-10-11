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
  const dir=await realpath(await mkdtemp(join(tmpdir(),'ahp-host-')));const log=join(dir,'prompts.jsonl');
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

test('catalog navigation reads persisted summaries without hydrating chat bodies or active events',async()=>{
  const rows:any[]=[];
  const f=await setup({catalog:{list:async({limit}:any)=>({items:rows.slice(0,limit)}),get:async(uri:string)=>rows.find(row=>row.uri===uri),upsert:async()=>{}}});
  try {
    const client=await f.connect(),timestamp='2026-01-01T00:00:00.000Z';
    for(let i=0;i<3;i++){
      const uri='ahp-session:/metadata-'+i,chat=uri.replace('ahp-session:','ahp-chat:');
      rows.push({uri,engineId:'fixture',workingDirectory:f.dir,title:'Catalog '+i,createdAt:timestamp,modifiedAt:timestamp});
      if(i===2)continue;
      const summary={resource:uri,provider:'fixture',title:'Saved '+i,status:1,createdAt:timestamp,modifiedAt:'2026-01-02T00:00:00.000Z',workingDirectories:[pathToFileURL(f.dir).href]};
      f.host.store.save({uri,engineId:'fixture',workingDirectory:f.dir,summary,state:{} as any,chat:{resource:chat,turns:[]} as any});
      // Navigation must remain usable even when execution bodies require recovery.
      f.host.store.db.prepare('UPDATE sessions SET chat=?,state=? WHERE uri=?').run('unreadable chat','unreadable execution state',uri);
      f.host.store.db.prepare('INSERT INTO active_events(channel,action) VALUES(?,?)').run(chat,'unreadable active event');
      assert.deepEqual(f.host.store.summary(chat),summary);
    }
    const before=f.host.store.db.prepare('SELECT uri,chat,state FROM sessions ORDER BY uri').all();
    const events=f.host.store.db.prepare('SELECT * FROM active_events ORDER BY seq').all();
    const page=await client.request('listSessions',{channel:'ahp-root://',limit:2});
    assert.deepEqual(page.items.map((row:any)=>row.title),['Saved 0','Saved 1']);
    assert.ok(page.items.every((row:any)=>row.modifiedAt==='2026-01-02T00:00:00.000Z'));
    const all=await client.request('listSessions',{channel:'ahp-root://',limit:3});
    assert.equal(all.items[2].title,'Catalog 2');
    assert.equal(f.host.store.summary('ahp-session:/missing'),undefined);
    assert.deepEqual(f.host.store.db.prepare('SELECT uri,chat,state FROM sessions ORDER BY uri').all(),before);
    assert.deepEqual(f.host.store.db.prepare('SELECT * FROM active_events ORDER BY seq').all(),events);
    assert.equal(f.host.diagnostics().activeAgents,0);
    await assert.rejects(readFile(f.log,'utf8'));
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
  const other={...input,commandId:randomUUID()};
  const results=await Promise.all([f.host.submitScheduled(session,input),f.host.submitScheduled(session,other)]);
  assert.equal(results.filter(result=>result.accepted).length,1);
  // Canonical workspace validation is asynchronous; admission promises do not promise a winner order.
  const admitted=results[0].accepted?input:other;
  client.dispatch(chat,{type:'chat/turnCancelled',turnId:admitted.commandId,duration:0});
  await waitFor(()=>f.host.store.receipt(admitted.commandId)?.status==='cancelled');
  const after=await f.host.inspectSession(session);assert.equal(after.executionRevision,before.executionRevision+1);assert.equal(after.interruptionRevision,before.interruptionRevision+1);
  const stale=await f.host.submitScheduled(session,{...input,commandId:randomUUID()});assert.equal(stale.accepted,false);
  await assert.rejects(f.host.submitScheduled(session,admitted),/already admitted/);
  await assert.rejects(f.host.nativeControl(session,'schedule.submit',{}),/submitScheduled/);
  const recorded=JSON.parse((await readFile(f.log,'utf8')).trim());assert.equal(recorded.operation,'schedule.submit');assert.equal(recorded.args.inputId,admitted.commandId);assert.equal(recorded.args.taskRevision,1);
  const context=await f.host.readSessionContext(session);assert.equal(context.messages[0].inputOrigin,'scheduled');assert.equal(context.messages[0].scheduledRunId,admitted.commandId);
  const rejectedId=randomUUID();assert.equal((await f.host.submitScheduled(session,{...input,commandId:rejectedId,taskRevision:99,expectedExecutionRevision:after.executionRevision,expectedInterruptionRevision:after.interruptionRevision})).accepted,true);
  await waitFor(()=>f.host.store.receipt(rejectedId)?.status==='failed');
  assert.equal((await readFile(f.log,'utf8')).trim().split('\n').length,1);
 }finally{await f.cleanup();}
});

test('source-config creation shares durable creation and rejects changed or uncertain reuse',async()=>{
 const f=await setup();try{
  const client=await f.connect(),{session}=await f.create(client),before=await f.host.inspectSession(session);
  assert.equal(f.host.store.navigation.projection(session,0).agentCreated,false);
  await assert.rejects(f.host.createSession({commandId:randomUUID(),idempotencyKey:'bad-provenance',sourceSession:session,expectedConfigurationHash:before.configurationHash,creation:{creatorSessionId:'other',requestId:'r'}}),/Creation source differs/);
  const input={commandId:randomUUID(),idempotencyKey:'scheduled-once',sourceSession:session,expectedConfigurationHash:before.configurationHash,title:'Created task',creation:{creatorSessionId:session,requestId:'r'}};
  const created=await f.host.createSession(input);assert.equal(created.creationConfirmed,true);assert.equal((await f.host.inspectSession(created.uri)).title,'Created task');
  assert.equal(f.host.store.navigation.projection(created.uri,0).agentCreated,true);
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


test('independent ACP metadata, legacy modes, usage and raw input replacements preserve official AHP state',async()=>{
 const f=await setup();try{
  f.config.engines[0].env.FIXTURE_LEGACY='1';
  const client=await f.connect(),{session,chat}=await f.create(client);await client.subscribe(session);await client.subscribe(chat,{view:{turns:10}});
  // Drain through the final ordered metadata update, not just the preceding title.
  await waitFor(()=>f.host.store.get(session)?.state.title==='Idle peer title'&&f.host.store.get(session)?.state.config?.values?.mode==='fast');
  let state=f.host.store.get(session)!.state,meta=state._meta!['amplifier.dev/acp'] as any;
  assert.equal(meta.availableCommands[0].name,'inspect');assert.deepEqual(meta.usage.cost,{amount:0.12,currency:'USD'});assert.equal(meta.usage.used,123);assert.equal(meta.sessionInfo.updatedAt,'2026-10-02T00:00:00Z');assert.equal(state.config?.values?.mode,'fast');
  client.dispatch(session,{type:'session/configChanged',config:{mode:'safe'}});await waitFor(()=>f.host.store.get(session)?.state.config?.values?.mode==='safe');
  assert.equal(JSON.parse((await readFile(f.log,'utf8')).trim()).modeChange.modeId,'safe');
  const turn=action('mapping');client.dispatch(chat,turn);await waitFor(()=>f.host.store.receipt(turn.turnId)?.status==='completed');
  const final=(await client.subscribe(chat,{view:{turns:10}})).result.snapshot!.state as ChatState,tool=(final.turns[0].responseParts.find((part:any)=>part.toolCall?.toolCallId==='replace-tool') as any).toolCall;
  assert.equal(tool.toolName,'read_file');assert.equal(tool.toolInput,JSON.stringify({path:'final'}));assert.equal(tool.status,'completed');assert.equal(tool.content[0].text,'retained output');assert.equal(tool.partialInput,undefined);
  assert.equal(final.turns[0].usage?.inputTokens,20);assert.equal(final.turns[0].usage?.outputTokens,11);assert.equal(final.turns[0].usage?.cacheReadTokens,4);assert.equal((final.turns[0].usage?._meta?.['amplifier.dev/acp'] as any).usage.cachedWriteTokens,2);
  meta=f.host.store.get(session)!.state._meta!['amplifier.dev/acp'] as any;assert.deepEqual(meta.availableCommands,[]);assert.equal(meta.usage.used,321);
 }finally{await f.cleanup();}
});

test('session usage metadata during a long response never rewrites the active transcript checkpoint',async()=>{
 const f=await setup();try{
  const client=await f.connect(),{session,chat}=await f.create(client);await client.subscribe(chat,{view:{turns:1}});
  const turn=action('stream-metadata');client.dispatch(chat,turn);
  await waitFor(()=>(f.host.store.get(session)?.state._meta?.['amplifier.dev/acp'] as any)?.usage?.used===19);
  const checkpoint=f.host.store.db.prepare('SELECT chat FROM sessions WHERE uri=?').get(session)!.chat as string;
  assert.ok(checkpoint.length<2000,checkpoint.length);assert.ok(!checkpoint.includes('x'.repeat(100)));
  assert.equal(f.host.store.get(session)!.chat.activeTurn!.responseParts[0].kind,'markdown');
  assert.equal((f.host.store.get(session)!.chat.activeTurn!.responseParts[0] as any).content.length,32000);
  await waitFor(()=>f.host.store.receipt(turn.turnId)?.status==='completed');
 }finally{await f.cleanup();}
});


test('raw input replacement while awaiting permission never implies approval',async()=>{
 const f=await setup();try{
  const client=await f.connect(),{chat}=await f.create(client);await client.subscribe(chat,{view:{turns:1}});const turn=action('mapping-permission');client.dispatch(chat,turn);
  const tool=()=>f.host.store.get(chat)?.chat.activeTurn?.responseParts.find((part:any)=>part.toolCall?.toolCallId==='approval-replace') as any;
  await waitFor(()=>tool()?.toolCall.toolInput===JSON.stringify({path:'new'}));
  assert.equal(tool().toolCall.status,'pending-confirmation');assert.equal(f.host.store.receipt(turn.turnId)?.status,'dispatching');
  client.dispatch(chat,{type:'chat/toolCallConfirmed',turnId:turn.turnId,toolCallId:'approval-replace',approved:true,confirmed:'user-action',selectedOptionId:'allow'});
  await waitFor(()=>f.host.store.receipt(turn.turnId)?.status==='completed');
 }finally{await f.cleanup();}
});


test('relocation preserves history identity and configuration, resumes in target, and excludes deletion',async()=>{
 const f=await setup();try{
  f.config.engines[0].env.FIXTURE_LOCATIONS='1';
  const client=await f.connect(),{session,chat}=await f.create(client),target=join(await realpath(f.dir),'worktree');await mkdir(target);
  const first=randomUUID();await f.host.submitTurn(session,{commandId:first,text:'before move',clientId:'relocator'});await f.host.waitForTurn(session,first);
  const before=await f.host.inspectSession(session),commandId=randomUUID();
  const result=await f.host.relocateSession(session,{commandId,target,expectedExecutionRevision:before.executionRevision});assert.equal(result.applied,true,JSON.stringify(result));
  const after=await f.host.inspectSession(session);assert.equal(after.nativeSessionId,before.nativeSessionId);assert.equal(after.historyHome,before.historyHome);assert.equal(after.executionDirectory,target);assert.equal(after.executionRevision,before.executionRevision+1);assert.equal(after.configurationHash,before.configurationHash);
  assert.deepEqual(await f.host.relocateSession(session,{commandId,target,expectedExecutionRevision:before.executionRevision}),result);
  const stale=await f.host.relocateSession(session,{commandId:randomUUID(),target,expectedExecutionRevision:before.executionRevision});assert.equal(stale.executed,false);
  assert.equal((await f.host.directoryInUse(target)).inUse,true);let removed=false;await assert.rejects(f.host.withDirectoryGuard(target,async()=>{removed=true;}),/referenced/);assert.equal(removed,false);
  const second=randomUUID();await f.host.submitTurn(session,{commandId:second,text:'after move',clientId:'relocator'});assert.equal((await f.host.waitForTurn(session,second)).completed,true);
  const log=(await readFile(f.log,'utf8')).trim().split('\n').map(line=>JSON.parse(line)),resume=log.find(item=>item.resumed);assert.equal(resume.resumed.cwd,target);assert.equal(resume.resumed._meta['amplifier.dev/native'].historyCwd,before.historyHome);assert.equal(log.at(-1).processCwd,target);
  assert.equal(f.host.store.turns(chat).turns.length,2);
 }finally{await f.cleanup();}
});

test('lost relocation result survives restart, fences target, and reconciles durable native proof without replay',async()=>{
 const f=await setup();let replacement:any;try{
  const client=await f.connect(),{session}=await f.create(client),target=join(await realpath(f.dir),'lost');await mkdir(target);
  const before=await f.host.inspectSession(session),commandId=randomUUID();
  await assert.rejects(f.host.relocateSession(session,{commandId,target,expectedExecutionRevision:before.executionRevision}),(error:any)=>error.data?.receipt===commandId&&error.data.outcome==='unknown');
  assert.equal(f.host.store.receipt(commandId)?.status,'unknown');await assert.rejects(f.host.withSessionWorkspace(session,{},async()=>{throw new Error('Must not capture fenced mapping');}),/fenced/);assert.equal((await f.host.inspectSession(session)).executionDirectory,before.historyHome);assert.equal((await f.host.directoryInUse(target)).pending,true);
  const noReplay=randomUUID();await assert.rejects(f.host.submitTurn(session,{commandId:noReplay,text:'must not execute',clientId:'relocator'}),/fenced/);assert.equal(f.host.store.receipt(noReplay),undefined);
  await client.shutdown();await f.host.close();replacement=await createHost(f.config);
  assert.equal((await replacement.inspectSession(session)).relocationFence.commandId,commandId);
  const fix=randomUUID(),reconciled=await replacement.relocateSession(session,{commandId:fix,target,expectedExecutionRevision:before.executionRevision,reconciles:commandId,evidence:{reviewed:true}});
  assert.equal(reconciled.applied,true,JSON.stringify(reconciled));assert.equal((await replacement.inspectSession(session)).relocationFence,undefined);assert.equal(replacement.store.receipt(commandId)?.status,'completed');assert.equal((await replacement.directoryInUse(target)).pending,false);
  assert.equal((await replacement.relocateSession(session,{commandId,target,expectedExecutionRevision:before.executionRevision})).applied,true);
  const native=JSON.parse(await readFile(f.log+'.locations','utf8'))[before.nativeSessionId!];assert.equal(native.executionRevision,1);assert.equal(native.receipt.commandId,commandId);
 }finally{if(replacement)await replacement.close();else await f.host.close();await rm(f.dir,{recursive:true,force:true});}
});

test('directory removal reservation excludes racing new-session admission and unsupported preflight is known',async()=>{
 const f=await setup();try{
  const client=await f.connect(),target=join(await realpath(f.dir),'unused');await mkdir(target);
  let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>entered=resolve),hold=new Promise<void>(resolve=>release=resolve);
  const removing=f.host.withDirectoryGuard(target,async()=>{entered();await hold;await rm(target,{recursive:true});});await started;
  const session='ahp-session:/'+randomUUID(),creation=client.request('createSession',{channel:session,workingDirectories:[pathToFileURL(target).href]});const checked=assert.rejects(creation);await new Promise(resolve=>setTimeout(resolve,30));assert.equal(f.host.store.get(session),undefined);
  release();await removing;await checked;assert.equal(f.host.store.get(session),undefined);
  const created=await f.create(client),before=await f.host.inspectSession(created.session),bad=await f.host.relocateSession(created.session,{commandId:randomUUID(),target,expectedExecutionRevision:before.executionRevision});assert.equal(bad.executed,false);assert.equal(bad.applied,false);
 }finally{await f.cleanup();}
});


test('indexed removal evidence refuses incomplete, stale and issue-bearing catalog coverage',async()=>{
 const f=await setup();try{
  const target=join(await realpath(f.dir),'removable');await mkdir(target);
  let freshness:any={phase:'not-started',issues:0};f.host.config.catalog={list:async()=>({items:[]}),get:async()=>undefined,upsert:async()=>{},directoryInUse:async()=>({inUse:false,coverage:'indexed-native-history',freshness})};
  for(const evidence of [{phase:'not-started',issues:0},{phase:'running',issues:0},{phase:'complete',completedAt:new Date().toISOString(),issues:1},{phase:'complete',completedAt:new Date(Date.now()-700000).toISOString(),issues:0}]){freshness=evidence;await assert.rejects(f.host.withDirectoryGuard(target,async()=>{}),/referenced/);}
  freshness={phase:'complete',completedAt:new Date().toISOString(),issues:0};assert.equal(await f.host.withDirectoryGuard(target,async()=>true),true);
 }finally{await f.cleanup();}
});


test('workspace capture holds only the selected session mapping against relocation and admission',async()=>{
 const f=await setup();try{
  const client=await f.connect(),one=await f.create(client),two=await f.create(client),target=join(await realpath(f.dir),'capture-target');await mkdir(target);
  const initial=await f.host.inspectSession(one.session);let entered!:()=>void,release!:()=>void;let started=new Promise<void>(r=>entered=r),hold=new Promise<void>(r=>release=r);
  const capture=f.host.withSessionWorkspace(one.session,{expectedExecutionRevision:initial.executionRevision,expectedDirectory:initial.executionDirectory},async workspace=>{assert.ok(Object.isFrozen(workspace));assert.equal(workspace.executionDirectory,initial.executionDirectory);entered();await hold;return {captured:workspace.executionDirectory};});
  await started;const move=f.host.relocateSession(one.session,{commandId:randomUUID(),target,expectedExecutionRevision:initial.executionRevision});
  const independent=randomUUID();await f.host.submitTurn(two.session,{commandId:independent,text:'independent while capture waits',clientId:'publisher'});assert.equal((await f.host.waitForTurn(two.session,independent)).completed,true);
  assert.equal((await f.host.inspectSession(one.session)).executionDirectory,initial.executionDirectory);assert.equal(f.host.store.db.prepare('SELECT count(*) AS n FROM relocations').get()!.n,0);
  release();assert.deepEqual(await capture,{captured:initial.executionDirectory});assert.equal((await move).applied,true);
  const after=await f.host.inspectSession(one.session);started=new Promise<void>(r=>entered=r);hold=new Promise<void>(r=>release=r);
  const second=f.host.withSessionWorkspace(one.session,{expectedExecutionRevision:after.executionRevision,expectedDirectory:target},async()=>{entered();await hold;});await started;
  const commandId=randomUUID(),turn=f.host.submitTurn(one.session,{commandId,text:'after captured files',clientId:'publisher'});await new Promise(r=>setTimeout(r,30));assert.equal(f.host.store.receipt(commandId),undefined);
  release();await second;await turn;assert.equal((await f.host.waitForTurn(one.session,commandId)).completed,true);
  let touched=false;await assert.rejects(f.host.withSessionWorkspace(one.session,{expectedExecutionRevision:after.executionRevision},async()=>{touched=true;}),/revision changed/);await assert.rejects(f.host.withSessionWorkspace(one.session,{expectedDirectory:initial.executionDirectory},async()=>{touched=true;}),/directory changed/);assert.equal(touched,false);
  await assert.rejects(f.host.withSessionWorkspace(one.session,{},async()=>{throw new Error('capture failed');}),/capture failed/);assert.equal(await f.host.withSessionWorkspace(one.session,{},async view=>view.executionDirectory),target);
 }finally{await f.cleanup();}
});


test('exact indexed input lookup reaches beyond fifty turns without transcript paging or losing provenance',async()=>{
 const f=await setup();try{
  const client=await f.connect(),{session,chat}=await f.create(client),old=randomUUID();await f.host.submitTurn(session,{commandId:old,text:'Exact original authorization',clientId:'user-client'});await f.host.waitForTurn(session,old);
  for(let i=0;i<51;i++){const id=randomUUID();await f.host.submitTurn(session,{commandId:id,text:'later '+i,clientId:'user-client'});await f.host.waitForTurn(session,id);}
  assert.ok(!(await f.host.readSessionContext(session,50)).messages.some(row=>row.id===old));
  const originalTurns=f.host.store.turns;f.host.store.turns=()=>{throw new Error('Exact lookup must not page any transcript');};
  try{const found=await f.host.readUserMessage(session,old);assert.equal(found.text,'Exact original authorization');assert.equal(found.provenance.admission.clientId,'user-client');assert.equal(found.provenance.complete,true);assert.equal(found.inputOrigin,'user');}finally{f.host.store.turns=originalTurns;}
  for(const [kind,meta,expected] of [
   ['scheduled',{'amplifier.dev/scheduled':{scheduledRunId:'run-1',inputOrigin:'scheduled'}},{inputOrigin:'scheduled',scheduledRunId:'run-1'}],
   ['question',{'amplifier.dev/input':{inputOrigin:'ui',questionId:'question-1'}},{inputOrigin:'question',questionId:'question-1'}],
   ['voice',{'amplifier.dev/history':{via:'call',callId:'call-1',itemId:'item-1',recordedOnly:true}},{inputOrigin:'voice',voiceId:'call-1',voiceItemId:'item-1'}]
  ] as const){const turn=action('source '+kind);turn.message._meta=meta;client.dispatch(chat,turn);await waitFor(()=>f.host.store.receipt(turn.turnId)?.status==='completed');const found=await f.host.readUserMessage(session,turn.turnId);for(const [key,value]of Object.entries(expected))assert.equal(found[key],value);assert.deepEqual(found._meta,meta);}
  const large=action('😀'.repeat(500));client.dispatch(chat,large);await waitFor(()=>f.host.store.receipt(large.turnId)?.status==='completed');await assert.rejects(f.host.readUserMessage(session,large.turnId,{maxBytes:100}),(error:any)=>error instanceof MessageUnavailableError&&error.reason==='oversized');assert.equal((await f.host.readUserMessage(session,large.turnId)).text,large.message.text);
  const other=await f.create(client);await assert.rejects(f.host.readUserMessage(other.session,old),(error:any)=>error instanceof MessageUnavailableError&&error.reason==='not-indexed');
 }finally{await f.cleanup();}
});

test('unindexed legacy input refuses without starting native history and non-user records are explicit',async()=>{
 const f=await setup();try{
  const timestamp=new Date().toISOString(),uri='ahp-session:/cold-legacy';f.host.config.catalog={list:async()=>({items:[]}),get:async()=>({uri,engineId:'fixture',nativeSessionId:'legacy-native',workingDirectory:f.dir,title:'Legacy',createdAt:timestamp,modifiedAt:timestamp,status:'idle'}),upsert:async()=>{}};
  await assert.rejects(f.host.readUserMessage(uri,'never-indexed'),(error:any)=>error instanceof MessageUnavailableError&&error.reason==='not-indexed'&&error.data.available===false);assert.equal(f.host.diagnostics().activeAgents,0);await assert.rejects(readFile(f.log,'utf8'));
  f.host.store.saveTurn('ahp-chat:/cold-legacy',{id:'assistant-voice',startedAt:timestamp,state:'complete',message:{text:'Spoken assistant response',origin:{kind:'agent'}},responseParts:[]} as any);
  await assert.rejects(f.host.readUserMessage(uri,'assistant-voice'),(error:any)=>error instanceof MessageUnavailableError&&error.reason==='not-user');
 }finally{await f.cleanup();}
});

test('background work prevents idle capacity retirement; actual runtime loss not prompt completion notifies owners',async()=>{
 const stopped:any[]=[],f=await setup({maxActiveAgents:1,agentStopped:async(event:any)=>{stopped.push(event);}});try{
  const client=await f.connect(),one=await f.create(client);await f.host.nativeControl(one.session,'fixture.background.start',{});
  const id=randomUUID();await f.host.submitTurn(one.session,{commandId:id,text:'foreground can finish',clientId:'owner'});await f.host.waitForTurn(one.session,id);assert.equal(stopped.length,0);
  await new Promise(r=>setTimeout(r,30));const before=(await readFile(f.log+'.background','utf8')).length;
  await assert.rejects(f.create(client),/capacity/);assert.equal(f.host.diagnostics().activeAgents,1);await new Promise(r=>setTimeout(r,30));assert.ok((await readFile(f.log+'.background','utf8')).length>before);assert.equal(stopped.length,0);
  await f.host.nativeControlExisting(one.session,'fixture.runtime.loss',{});await waitFor(()=>stopped.length===1);await new Promise(r=>setTimeout(r,50));assert.equal(stopped.length,1);assert.equal(stopped[0].session,one.session);assert.equal(stopped[0].reason,'runtime-closed');assert.ok(stopped[0].nativeSessionId);
  await assert.rejects(f.host.nativeControlExisting(one.session,'fixture.background.stop',{}),/No existing owned native runtime/);assert.equal(stopped.length,1);
  const next=await f.create(client);assert.ok(next.session);assert.equal(f.host.diagnostics().activeAgents,1);
 }finally{await f.cleanup();}
});

test('only confirmed graceful retirement releases capacity; unnegotiated external agents remain retained',async()=>{
 const stopped:any[]=[],f=await setup({maxActiveAgents:1,agentStopped:async(event:any)=>{stopped.push(event);}});try{
  const client=await f.connect(),first=await f.create(client);await f.host.nativeControl(first.session,'fixture.background.start',{});await f.host.nativeControl(first.session,'fixture.background.stop',{});
  const next=await f.create(client);assert.notEqual(first.session,next.session);await waitFor(()=>stopped.length===1);assert.equal(stopped[0].reason,'idle-retired');assert.equal(stopped[0].session,first.session);
  assert.equal(f.host.diagnostics().activeAgents,1);await assert.rejects(f.host.nativeControlExisting(first.session,'fixture.background.stop',{}),/No existing owned native runtime/);
 }finally{await f.cleanup();}
 const generic=await setup({maxActiveAgents:1});try{
  generic.config.engines[0].env.FIXTURE_NO_RETIRE='1';const client=await generic.connect();await generic.create(client);await assert.rejects(generic.create(client),/capacity/);assert.equal(generic.host.diagnostics().activeAgents,1);
 }finally{await generic.cleanup();}
});

test('runtime-loss owner notification settles before the next native lifetime is admitted',async()=>{
 let release!:()=>void,entered!:()=>void;const hold=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);let notifications=0;
 const f=await setup({agentStopped:async()=>{notifications++;entered();await hold;}});try{
  const client=await f.connect(),{session}=await f.create(client);await f.host.nativeControlExisting(session,'fixture.runtime.loss',{});await started;
  const commandId=randomUUID(),submission=f.host.submitTurn(session,{commandId,text:'next lifetime',clientId:'owner'});await new Promise(r=>setTimeout(r,50));assert.equal(f.host.store.receipt(commandId),undefined);assert.equal(notifications,1);
  release();await submission;assert.equal((await f.host.waitForTurn(session,commandId)).completed,true);assert.equal(notifications,1);
 }finally{release();await f.cleanup();}
});


test('negotiated owned-operation observations continue after prompt settlement without idle dispatch authority',async()=>{
 const seen:any[]=[],f=await setup({nativeHostCapabilities:{version:1,features:{operations:true}},nativeHostRequest:async(context:any,request:any)=>{seen.push({context,request});return {observed:true};}});try{
  const client=await f.connect(),{session}=await f.create(client);await f.host.nativeControl(session,'fixture.background.start',{});
  const id=randomUUID();await f.host.submitTurn(session,{commandId:id,text:'foreground finished',clientId:'owner'});assert.equal((await f.host.waitForTurn(session,id)).completed,true);
  await f.host.nativeControlExisting(session,'fixture.background.observe',{});await waitFor(()=>seen.length===1);await new Promise(r=>setTimeout(r,50));
  assert.equal(seen.length,1);assert.equal(seen[0].request.operation,'operations.observe');assert.equal(seen[0].request.args.event.phase,'finished');assert.equal(seen[0].context.session,session);assert.equal(seen[0].context.nativeSessionId,seen[0].request.args.runtimeSessionId);assert.equal((await f.host.inspectSession(session)).status,'idle');assert.deepEqual(JSON.parse((await readFile(f.log+'.observations','utf8')).trim()),{observed:true});
 }finally{await f.cleanup();}
 const denied:any[]=[],plain=await setup({nativeHostRequest:async(_:any,request:any)=>{denied.push(request);return {};}});try{
  const client=await plain.connect(),{session}=await plain.create(client);await plain.host.nativeControlExisting(session,'fixture.background.observe',{});await new Promise(r=>setTimeout(r,120));assert.equal(denied.length,0);const result=JSON.parse((await readFile(plain.log+'.observations','utf8')).trim());assert.ok(result.error);
 }finally{await plain.cleanup();}
});

test('Recall inventories stay cold and pages retain exact messages, scoped cursors and unverified provenance',async()=>{
 const f=await setup();let reader:any;try{
  const dir=await realpath(f.dir),history=join(dir,'recall.json'),timestamp=new Date().toISOString();
  const groups=Array.from({length:4},(_,i)=>({id:'group-'+i,updates:[
   {sessionUpdate:'user_message_chunk',content:{type:'text',text:'request '+i},_meta:{'amplifier.dev/history':{messageId:'message-u-'+i,createdAt:timestamp,...(i===3?{inputOrigin:'question',questionId:'q1'}:{})}}},
   {sessionUpdate:'agent_message_chunk',content:{type:'text',text:'answer '},_meta:{'amplifier.dev/history':{messageId:'message-a-'+i}}},
   {sessionUpdate:'agent_message_chunk',content:{type:'text',text:String(i)},_meta:{'amplifier.dev/history':{messageId:'message-a-'+i}}},
   {sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'not recalled'}}
  ]}));await writeFile(history,JSON.stringify(groups));
  const records=Array.from({length:4},(_,i)=>({uri:'ahp-session:/recall-'+i,engineId:'fixture',nativeSessionId:'native-'+i,workingDirectory:dir,title:'History '+i,kind:'root',workspaceAvailability:'present',createdAt:timestamp,modifiedAt:timestamp})),queries:any[]=[];
  reader=await createHost({...f.config,stateDirectory:join(dir,'recall-state'),engines:f.config.engines.map((e:any)=>({...e,env:{...e.env,FIXTURE_HISTORY:history}})),catalog:{get:async(id:string)=>records.find(row=>row.uri===id),upsert:async()=>{},list:async(p:any)=>{queries.push(p);const offset=Number(p.cursor??0);return {items:records.slice(offset,offset+p.limit),nextCursor:offset+p.limit<records.length?String(offset+p.limit):undefined,freshness:{phase:'complete',issues:0}};}}});
  const first=await reader.listRecallSources({session:records[0].uri,scope:'workspace',limit:2});assert.equal(first.items.length,2);assert.ok(first.nextCursor);assert.equal(queries[0].workingDirectory,dir);assert.equal(queries[0].includeArchive,false);await assert.rejects(readFile(f.log+'.passive','utf8'));assert.equal(reader.diagnostics().activeAgents,0);
  const second=await reader.listRecallSources({session:records[0].uri,scope:'workspace',limit:2,cursor:first.nextCursor});assert.equal(second.items.length,2);assert.equal(second.nextCursor,undefined);await assert.rejects(reader.listRecallSources({session:records[0].uri,scope:'all',cursor:first.nextCursor}),/different source/);
  const inspected=await reader.inspectRecallSource(records[0].uri);assert.equal(inspected.revision,'fixture-revision');assert.equal(await readFile(f.log+'.passive','utf8'),'inspect\n');
  const page=await reader.readRecallSource(records[0].uri,{limit:1,expectedRevision:inspected.revision});assert.equal(page.rows.length,2);assert.equal(page.rows[0].id,'message-u-3');assert.equal(page.rows[0].questionId,'q1');assert.equal(page.rows[0].authorization,'unverified-native-history');assert.equal(page.rows[1].text,'answer 3');assert.equal(page.coverage.omittedUpdates,1);assert.ok(page.nextCursor);
  const prior=await reader.readRecallSource(records[0].uri,{limit:1,cursor:page.nextCursor,expectedRevision:inspected.revision});assert.equal(prior.rows[0].inputOrigin,'unknown');assert.equal(prior.rows[0].id,'message-u-2');await assert.rejects(reader.readRecallSource(records[1].uri,{cursor:page.nextCursor,expectedRevision:inspected.revision}),/different source/);await assert.rejects(reader.readRecallSource(records[0].uri,{expectedRevision:'changed'}),/History source changed/);
  const context=await reader.readSessionContext(records[0].uri,8);assert.equal(context.messages.find((m:any)=>m.id==='group-2').inputOrigin,'unknown');assert.equal(context.messages.find((m:any)=>m.id==='group-3').questionId,'q1');assert.equal(context.messages.find((m:any)=>m.id==='group-2').authorization,'unverified-native-history');
  await assert.rejects(reader.readUserMessage(records[0].uri,'message-u-3'),(e:any)=>e.reason==='not-indexed');assert.equal(reader.diagnostics().activeAgents,0);await assert.rejects(readFile(f.log,'utf8'));
  await writeFile(history,JSON.stringify([{id:'huge',updates:[{sessionUpdate:'user_message_chunk',content:{type:'text',text:'x'.repeat(2*1024*1024)},_meta:{'amplifier.dev/history':{messageId:'huge'}}}]}]));await assert.rejects(reader.readRecallSource(records[0].uri,{expectedRevision:inspected.revision}),/complete-message byte bound/);
  records[0].kind='child';await assert.rejects(reader.inspectRecallSource(records[0].uri),/Child\/internal/);
 }finally{if(reader)await reader.close();await f.cleanup();}
});

test('retained historical source lookup stays passive, bounded and separate from human admission',async()=>{
 const f=await setup();let reader:any;try{
  const dir=await realpath(f.dir),history=join(dir,'retained.json'),timestamp=new Date().toISOString();
  const groups=Array.from({length:51},(_,i)=>({id:'old-'+i,state:'complete',updates:[{sessionUpdate:'user_message_chunk',content:{type:'text',text:'historical '+i},_meta:{'amplifier.dev/history':{messageId:'old-'+i,nativeInput:{version:1,kind:'user',id:'old-'+i},createdAt:timestamp}}}]}));
  await writeFile(history,JSON.stringify(groups));
  const record={uri:'ahp-session:/retained',engineId:'fixture',nativeSessionId:'native-retained',workingDirectory:dir,title:'Retained',kind:'root',workspaceAvailability:'present',createdAt:timestamp,modifiedAt:timestamp};
  reader=await createHost({...f.config,stateDirectory:join(dir,'retained-state'),engines:f.config.engines.map((e:any)=>({...e,env:{...e.env,FIXTURE_HISTORY:history}})),catalog:{get:async(id:string)=>id===record.uri?record:undefined,upsert:async()=>{},list:async()=>({items:[record]})}});
  const row=await reader.readHistoricalMessage(record.uri,'old-50');
  assert.equal(row.text,'historical 50');assert.equal(row.role,'user');assert.equal(row._meta['amplifier.dev/history'].authorization,'unverified-native-history');
  assert.deepEqual(row.provenance,{source:'host-projection',complete:true});assert.equal(row._meta['amplifier.dev/history'].nativeInput.id,'old-50');
  await assert.rejects(reader.readUserMessage(record.uri,'old-50'),(e:any)=>e.reason==='not-indexed');
  await assert.rejects(reader.readHistoricalMessage(record.uri,'old-0'),(e:any)=>e.data.reason==='outside-window');
  await assert.rejects(reader.readHistoricalMessage(record.uri,'absent'),(e:any)=>e.data.reason==='outside-window');
  await writeFile(history,JSON.stringify([{...groups[50],updates:[{...groups[50]!.updates[0],content:{type:'text',text:'x'.repeat(65536)}}]}]));
  await assert.rejects(reader.readHistoricalMessage(record.uri,'old-50'),/complete-source byte bound/);
  assert.equal(reader.diagnostics().activeAgents,0);await assert.rejects(readFile(f.log,'utf8'));
 }finally{if(reader)await reader.close();await f.cleanup();}
});

test('question answers use settled common admission, preserve provenance and refuse busy or uncertain replay',async()=>{
 const f=await setup();try{
  const client=await f.connect(),{session}=await f.create(client),question={commandId:randomUUID(),text:'Use the blue option',questionId:'q-1',questionRevision:4,answerProvenance:{actor:'user',sourceMessageId:'answer-1',revision:7}};
  const accepted=await f.host.submitQuestionAnswer(session,question);assert.equal(accepted.accepted,true);assert.equal((await f.host.waitForTurn(session,question.commandId)).completed,true);
  const input=await f.host.readUserMessage(session,question.commandId);assert.equal(input.inputOrigin,'question');assert.equal(input.questionId,'q-1');assert.deepEqual(input._meta['amplifier.dev/input'],{inputOrigin:'question',questionId:'q-1',questionRevision:4,answerProvenance:question.answerProvenance});
  const line=JSON.parse((await readFile(f.log,'utf8')).trim());assert.equal(line.operation,'question.submit');assert.equal(line.args.inputId,question.commandId);assert.equal(line.args.questionRevision,4);assert.deepEqual(line.args.answerProvenance,question.answerProvenance);assert.equal(line.prompt,undefined);
  await assert.rejects(f.host.submitQuestionAnswer(session,question),/already admitted/);await assert.rejects(f.host.nativeControl(session,'question.submit',{}),/submitQuestionAnswer admission/);
  const slow=randomUUID();await f.host.submitTurn(session,{commandId:slow,text:'slow',clientId:'owner'});const busy={...question,commandId:randomUUID()};assert.deepEqual(await f.host.submitQuestionAnswer(session,busy),{accepted:false,executed:false,reason:'A turn is already running; use pending message actions'});assert.equal(f.host.store.receipt(busy.commandId),undefined);await f.host.waitForTurn(session,slow);
  const denied={...question,commandId:randomUUID(),questionRevision:99};assert.equal((await f.host.submitQuestionAnswer(session,denied)).accepted,true);assert.equal((await f.host.waitForTurn(session,denied.commandId)).status,'failed');
  const uncertain={...question,commandId:randomUUID(),text:'crash'};assert.equal((await f.host.submitQuestionAnswer(session,uncertain)).accepted,true);assert.equal((await f.host.waitForTurn(session,uncertain.commandId)).status,'unknown');await assert.rejects(f.host.submitQuestionAnswer(session,uncertain),/already admitted/);assert.equal((await readFile(f.log,'utf8')).split('\n').filter(line=>line.includes(uncertain.commandId)).length,1);
 }finally{await f.cleanup();}
});

test('standard queued messages share two-viewer state, upsert/reorder/cancel and drain exactly once',async()=>{
 const f=await setup();try{
  const a=await f.connect(),b=await f.connect(),{session,chat}=await f.create(a),events:any[]=[];const subscription=await b.subscribe(chat,{view:{turns:10}});let state=subscription.result.snapshot!.state as ChatState;void(async()=>{for await(const event of subscription.subscription)if(event.type==='action'){events.push(event.params);if(!event.params.rejectionReason)state=chatReducer(state,event.params.action as any);}})();
  await a.subscribe(chat,{view:{turns:10}});const initial=action('queue-hold');a.dispatch(chat,initial);await waitFor(()=>f.host.store.receipt(initial.turnId));
  const first=randomUUID(),second=randomUUID(),removed=randomUUID(),set=(id:string,text:string)=>({type:'chat/pendingMessageSet',kind:'queued',id,message:{text,origin:{kind:'user'}}} as any);
  a.dispatch(chat,set(first,'original'));a.dispatch(chat,set(second,'second'));a.dispatch(chat,set(removed,'never execute'));await waitFor(()=>state.queuedMessages?.length===3);
  await assert.rejects(f.host.submitTurn(session,{commandId:first,text:'bypass queued content',clientId:'owner'}),/reserved by a queued intent/);
  b.dispatch(chat,set(first,'edited'));b.dispatch(chat,{type:'chat/queuedMessagesReordered',order:[second,first]} as any);b.dispatch(chat,{type:'chat/pendingMessageRemoved',kind:'queued',id:removed} as any);await waitFor(()=>state.queuedMessages?.length===2&&state.queuedMessages[0].id===second&&state.queuedMessages[1].message.text==='edited');
  await waitFor(()=>f.host.store.receipt(first)?.status==='completed');assert.equal(state.queuedMessages,undefined);assert.equal(f.host.store.receipt(second)?.status,'completed');assert.equal(f.host.store.receipt(removed),undefined);
  const prompts=(await readFile(f.log,'utf8')).trim().split('\n').map(line=>JSON.parse(line).prompt[0].text);assert.deepEqual(prompts,['queue-hold','second','edited']);
  const removalIndex=events.findIndex(e=>e.action.type==='chat/pendingMessageRemoved'&&e.action.id===second),startIndex=events.findIndex(e=>e.action.type==='chat/turnStarted'&&e.action.queuedMessageId===second);assert.ok(removalIndex>=0&&startIndex>removalIndex);a.dispatch(chat,set(first,'do not repeat'));a.dispatch(chat,set(removed,'do not resurrect'));await waitFor(()=>events.filter(e=>e.rejectionReason).length>=2);assert.equal((await readFile(f.log,'utf8')).trim().split('\n').length,3);
 }finally{await f.cleanup();}
});

test('cancellation, restart and unknown receipt preserve held queues with explicit re-arm and no replay',async()=>{
 const f=await setup();let restarted:any;try{
  const a=await f.connect(),{session,chat}=await f.create(a),initial=action('slow');a.dispatch(chat,initial);await waitFor(()=>f.host.store.receipt(initial.turnId));const id=randomUUID(),queued={type:'chat/pendingMessageSet',kind:'queued',id,message:{text:'held across restart',origin:{kind:'user'}}} as any;
  await f.host.updatePendingQueue(session,queued,{clientId:'owner'});a.dispatch(chat,{type:'chat/turnCancelled',turnId:initial.turnId,duration:0} as any);await waitFor(()=>f.host.store.receipt(initial.turnId)?.status==='cancelled');assert.equal(f.host.store.receipt(id),undefined);assert.equal((f.host.store.get(session)!.chat.queuedMessages![0].message._meta!['amplifier.dev/queue'] as any).held,true);
  await a.shutdown();await f.host.close();restarted=await createHost(f.config);assert.equal(restarted.diagnostics().activeAgents,0);await new Promise(r=>setTimeout(r,30));assert.equal(restarted.store.receipt(id),undefined);assert.equal(restarted.store.get(session).chat.queuedMessages[0].message._meta['amplifier.dev/queue'].reason,'host-restarted');
  await restarted.updatePendingQueue(session,queued,{clientId:'owner'});assert.equal((await restarted.waitForTurn(session,id)).status,'completed');
  const crash=randomUUID();await restarted.submitTurn(session,{commandId:crash,text:'crash',clientId:'owner'});assert.equal((await restarted.waitForTurn(session,crash)).status,'unknown');const afterCrash={...queued,id:randomUUID()};await restarted.updatePendingQueue(session,afterCrash,{clientId:'owner'});assert.equal(restarted.store.receipt(afterCrash.id),undefined);assert.equal(restarted.store.get(session).chat.queuedMessages[0].message._meta['amplifier.dev/queue'].held,true);
  assert.equal((await readFile(f.log,'utf8')).trim().split('\n').length,3);
 }finally{if(restarted)await restarted.close();else await f.host.close();await rm(f.dir,{recursive:true,force:true});}
});

test('pending queue count and bytes are bounded; admission crash recovery removes consumed projection without replay',async()=>{
 const f=await setup();let restarted:any;try{
  const a=await f.connect(),{session,chat}=await f.create(a),turn=action('queue-hold');a.dispatch(chat,turn);await waitFor(()=>f.host.store.receipt(turn.turnId));
  const set=(id:string,text:string)=>({type:'chat/pendingMessageSet',kind:'queued',id,message:{text,origin:{kind:'user'}}} as any);
  await assert.rejects(f.host.updatePendingQueue(session,set(randomUUID(),'x'.repeat(1024*1024)),{clientId:'owner'}),/capacity/);
  for(let i=0;i<50;i++)await f.host.updatePendingQueue(session,set(randomUUID(),'queued '+i),{clientId:'owner'});await assert.rejects(f.host.updatePendingQueue(session,set(randomUUID(),'overflow'),{clientId:'owner'}),/capacity/);assert.equal(f.host.store.get(session)!.chat.queuedMessages!.length,50);
  await a.shutdown();await f.host.close();// Reopen the durable store only through a new host.
  restarted=await createHost(f.config);const id=restarted.store.get(session).chat.queuedMessages[0].id;
  restarted.store.db.prepare("UPDATE queue_intents SET status='consumed',projected=0,message=NULL WHERE id=?").run(id);restarted.store.admission(chat,{simulated:'crash after admission'},id,'owner',-1000);await restarted.close();restarted=await createHost(f.config);
  assert.equal(restarted.store.receipt(id).status,'unknown');assert.ok(!restarted.store.get(session).chat.queuedMessages.some((message:any)=>message.id===id));assert.equal(restarted.diagnostics().activeAgents,0);assert.equal((await readFile(f.log,'utf8')).trim().split('\n').length,1);
 }finally{if(restarted)await restarted.close();else await f.host.close();await rm(f.dir,{recursive:true,force:true});}
});

test('typed observations share revision admission and remain system input rather than human consent',async()=>{
 const f=await setup();try{
  const client=await f.connect(),{session}=await f.create(client),before=await f.host.inspectSession(session),input={commandId:randomUUID(),watchId:'watch-1',taskId:'task-1',taskRevision:3,outcome:{status:'changed',evidence:'untrusted observation text'},expectedExecutionRevision:before.executionRevision,expectedInterruptionRevision:before.interruptionRevision,expectedConfigurationHash:before.configurationHash};
  assert.equal((await f.host.submitObservation(session,input)).accepted,true);assert.equal((await f.host.waitForTurn(session,input.commandId)).status,'completed');
  const wire=JSON.parse((await readFile(f.log,'utf8')).trim());assert.equal(wire.operation,'observation.submit');assert.deepEqual(wire.args.outcome,input.outcome);assert.equal(wire.args.text,undefined);assert.equal(wire.prompt,undefined);
  const context=await f.host.readSessionContext(session,2);assert.equal(context.messages[0].role,'system');assert.equal(context.messages[0].inputOrigin,'observation');await assert.rejects(f.host.readUserMessage(session,input.commandId),(e:any)=>e.reason==='not-user');
  const stale=await f.host.submitObservation(session,{...input,commandId:randomUUID()});assert.equal(stale.accepted,false);assert.equal(stale.executed,false);assert.match(stale.reason!,/revisions changed/);await assert.rejects(f.host.submitObservation(session,input),/already admitted/);await assert.rejects(f.host.nativeControl(session,'observation.submit',{}),/submitObservation admission/);assert.equal((await readFile(f.log,'utf8')).trim().split('\n').length,1);
 }finally{await f.cleanup();}
});

test('selected context includes the current admitted input while its response is pending',async()=>{
 const f=await setup();try{
  const client=await f.connect(),{session}=await f.create(client),current=randomUUID();
  await f.host.submitTurn(session,{commandId:current,text:'queue-hold',clientId:'human'});
  let context=await f.host.readSessionContext(session,1);
  assert.equal(context.messages.length,1);assert.equal(context.messages[0].id,current);assert.equal(context.messages[0].inputOrigin,'user');
  assert.equal((await f.host.readUserMessage(session,context.messages[0].id)).text,'queue-hold');
  await f.host.waitForTurn(session,current);
  const next=randomUUID();await f.host.submitTurn(session,{commandId:next,text:'queue-hold',clientId:'human'});
  context=await f.host.readSessionContext(session,2);
  assert.equal(context.messages.at(-1)!.id,next);assert.equal(context.messages.filter(row=>row.id===next).length,1);assert.ok(context.messages.length<=2);
 }finally{await f.cleanup();}
});

test('turn settlement callback follows durable receipt and lock release, isolates failure and never replays at startup',async()=>{
 const events:any[]=[];let host:any;const f=await setup({turnSettled:async(event:any)=>{
  assert.equal(host.store.receipt(event.commandId).status,event.status);
  // Re-entering a read guard proves that the callback does not retain admission's mutex.
  await host.withSessionWorkspace(event.session,{},async()=>{events.push(event);});
  if(event.inputOrigin==='question')throw new Error('owner unavailable');
 }});host=f.host;
 try{
  const client=await f.connect(),{session}=await f.create(client),one=randomUUID();
  await host.submitTurn(session,{commandId:one,text:'settled',clientId:'human'});await host.waitForTurn(session,one);await waitFor(()=>events.length===1);
  assert.deepEqual(events[0],{session,commandId:one,status:'completed',inputOrigin:'user'});
  await host.submitQuestionAnswer(session,{commandId:'question-callback',text:'saved answer',questionId:'q',questionRevision:99,answerProvenance:{actor:'user'}});await host.waitForTurn(session,'question-callback');
  await waitFor(()=>host.diagnostics().turnSettledFailures===1);assert.equal(events[1].status,'failed');assert.equal(events[1].inputOrigin,'question');assert.equal(host.diagnostics().turnSettledPending,0);
  const transport=await f.connect('viewer-later');await transport.subscribe(session,{view:{turns:1}});assert.equal(events.length,2);
  await Promise.all(f.clients.map(c=>c.shutdown()));f.clients.length=0;await host.close();
  const restarted=await createHost({...f.config,turnSettled:async()=>{throw new Error('must never run at startup');}});host=restarted;f.host=restarted;
  assert.equal(restarted.diagnostics().turnSettledPending,0);assert.equal(restarted.diagnostics().turnSettledFailures,0);await restarted.close();
 }finally{
  // This test deliberately replaces the host and closes each instance exactly once.
  for(const client of f.clients)await client.shutdown();await rm(f.dir,{recursive:true,force:true});
 }
});

test('persisted task inspection stays passive and refuses a stale source revision',async()=>{
 const f=await setup();try{
  const timestamp=new Date().toISOString(),session='ahp-session:/cold-task';
  f.host.config.catalog={list:async()=>({items:[]}),get:async()=>({uri:session,engineId:'fixture',nativeSessionId:'native-task',workingDirectory:f.dir,title:'Task',createdAt:timestamp,modifiedAt:timestamp}),upsert:async()=>{}};
  const task=await f.host.readTaskState(session);assert.equal(task.source,'persisted-native-controls');assert.equal((task.task as any).revision,7);assert.equal(task.available,true);assert.equal(f.host.diagnostics().activeAgents,0);
  assert.equal((await f.host.readTaskState(session,{expectedRevision:String(task.revision)})).revision,task.revision);
  await assert.rejects(f.host.readTaskState(session,{expectedRevision:'stale'}),/revision changed/);
  await assert.rejects(readFile(f.log,'utf8'),/ENOENT/);assert.equal(await readFile(f.log+'.passive','utf8'),'task\ntask\ntask\n');
 }finally{await f.cleanup();}
});

test('standard steering stays in its active turn, with durable receipts and no second prompt',async()=>{
 const f=await setup();try{
  const client=await f.connect(),other=await f.connect(),{session,chat}=await f.create(client);
  const sub=await client.subscribe(chat,{view:{turns:3}});await other.subscribe(chat,{view:{turns:3}});const seen:any[]=[];void(async()=>{for await(const event of sub.subscription)if(event.type==='action')seen.push(event.params);})();
  const pending=(id:string,text:string)=>({type:'chat/pendingMessageSet',kind:'steering',id,message:{text,origin:{kind:'user'}}} as any);
  // Unconsumed idle input is editable/removable and does not start execution.
  await f.host.updatePendingQueue(session,pending('replace','old'),{clientId:'owner'});
  await f.host.updatePendingQueue(session,pending('replace','new'),{clientId:'owner'});
  await f.host.updatePendingQueue(session,{type:'chat/pendingMessageRemoved',kind:'steering',id:'replace'} as any,{clientId:'owner'});
  await assert.rejects(readFile(f.log,'utf8'),/ENOENT/);
  other.dispatch(chat,pending('next-boundary','Correct path'));
  await waitFor(()=>f.host.store.get(session)?.chat.steeringMessage?.id==='next-boundary');
  const initial=action('queue-hold');client.dispatch(chat,initial);
  await waitFor(()=>f.host.store.receipt('next-boundary')?.status==='completed');
  const request=JSON.parse((await readFile(f.log+'.steering','utf8')).trim());assert.equal(request.activeInputId,initial.turnId);assert.equal(request.inputId,'next-boundary');
  assert.equal((await f.host.readUserMessage(session,'next-boundary')).text,'Correct path');
  assert.ok((await f.host.readSessionContext(session,5)).messages.some(row=>row.id==='next-boundary'&&row.delivery==='steering'));
  await assert.rejects(f.host.updatePendingQueue(session,pending('next-boundary','duplicate'),{clientId:'owner'}),/already consumed/);
  await assert.rejects(f.host.updatePendingQueue(session,{type:'chat/pendingMessageRemoved',kind:'steering',id:'next-boundary'} as any,{clientId:'owner'}),/cannot be retracted/);
  await assert.rejects(f.host.nativeControl(session,'steer',{text:'bypass'}),/updatePendingQueue/);
  assert.equal((await f.host.waitForTurn(session,initial.turnId)).completed,true);
  assert.equal((await readFile(f.log,'utf8')).trim().split('\n').length,1);assert.equal(f.host.store.turns(chat).turns.length,1);
  assert.ok(seen.some(event=>event.action.type==='chat/pendingMessageRemoved'&&event.action.id==='next-boundary'));assert.equal(f.host.store.get(session)?.chat.steeringMessage,undefined);
 }finally{await f.cleanup();}
});

test('known held steering is never replayed and unknown steering fences new execution',async()=>{
 const f=await setup();try{
  const client=await f.connect(),{session}=await f.create(client),commandId=randomUUID();await f.host.submitTurn(session,{commandId,text:'queue-hold',clientId:'owner'});
  for(const [id,text,status] of [['held','held steering','failed'],['refused','refuse steering','failed']] as const){
   await f.host.updatePendingQueue(session,{type:'chat/pendingMessageSet',kind:'steering',id,message:{text,origin:{kind:'user'}}} as any,{clientId:'owner'});await waitFor(()=>f.host.store.receipt(id)?.status===status);
  }
  await f.host.updatePendingQueue(session,{type:'chat/pendingMessageSet',kind:'steering',id:'lost',message:{text:'crash steering',origin:{kind:'user'}}} as any,{clientId:'owner'});
  await waitFor(()=>f.host.store.receipt('lost')?.status==='unknown');await f.host.waitForTurn(session,commandId);
  await assert.rejects(f.host.submitTurn(session,{commandId:randomUUID(),text:'do not replay',clientId:'owner'}),/unknown/);
  assert.equal((await readFile(f.log+'.steering','utf8')).trim().split('\n').length,3);
  assert.equal((await readFile(f.log,'utf8')).trim().split('\n').length,1);
 }finally{await f.cleanup();}
});

test('pending steering cancelled before generation readiness stays held across later turns and restart',async()=>{
 const f=await setup();let restarted:any,closed=false;try{
  const client=await f.connect(),{session,chat}=await f.create(client),turn=action('steer-start-late');client.dispatch(chat,turn);await waitFor(()=>f.host.store.receipt(turn.turnId));
  await f.host.updatePendingQueue(session,{type:'chat/pendingMessageSet',kind:'steering',id:'not-delivered',message:{text:'Do not deliver after stop',origin:{kind:'user'}}} as any,{clientId:'owner'});
  client.dispatch(chat,{type:'chat/turnCancelled',turnId:turn.turnId,duration:0} as any);await f.host.waitForTurn(session,turn.turnId);
  assert.equal(f.host.store.receipt('not-delivered'),undefined);assert.equal((f.host.store.get(session)?.chat.steeringMessage?.message._meta?.['amplifier.dev/steering'] as any).held,true);
  const second=randomUUID();await f.host.submitTurn(session,{commandId:second,text:'explicit new work',clientId:'owner'});await f.host.waitForTurn(session,second);await assert.rejects(readFile(f.log+'.steering','utf8'),/ENOENT/);
  await client.shutdown();await f.host.close();closed=true;restarted=await createHost(f.config);
  const third=randomUUID();await restarted.submitTurn(session,{commandId:third,text:'explicit after restart',clientId:'owner'});await restarted.waitForTurn(session,third);await assert.rejects(readFile(f.log+'.steering','utf8'),/ENOENT/);
  assert.equal(restarted.store.get(session).chat.steeringMessage.id,'not-delivered');assert.equal(restarted.store.receipt('not-delivered'),undefined);
 }finally{if(!closed)await f.cleanup();else{await restarted?.close();await rm(f.dir,{recursive:true,force:true});}}
});

test('unconfirmed steering remains unknown when its original turn finishes successfully',async()=>{
 const f=await setup({steeringOutcomeTimeoutMs:100});try{
  const client=await f.connect(),{session}=await f.create(client),id=randomUUID();await f.host.submitTurn(session,{commandId:id,text:'slow',clientId:'owner'});
  await f.host.updatePendingQueue(session,{type:'chat/pendingMessageSet',kind:'steering',id:'unconfirmed',message:{text:'silent steering',origin:{kind:'user'}}} as any,{clientId:'owner'});
  assert.equal((await f.host.waitForTurn(session,id)).completed,true);await waitFor(()=>f.host.store.receipt('unconfirmed')?.status==='unknown');
  await assert.rejects(f.host.submitTurn(session,{commandId:randomUUID(),text:'blocked new work',clientId:'owner'}),/unknown/);
 }finally{await f.cleanup();}
});

test('cold receipt and steering archives stay out of current admission scans',async()=>{
 const f=await setup();try{
  const stamp=new Date().toISOString();f.host.store.transaction(()=>{
   const receipt=f.host.store.db.prepare('INSERT INTO receipts VALUES(?,?,?,?,?)'),steering=f.host.store.db.prepare("INSERT INTO steering_intents(id,chat,message,origin,status) VALUES(?,?,NULL,'{}','removed')");
   for(let i=0;i<25000;i++){const channel='ahp-chat:/cold-'+i;receipt.run('cold-'+i,channel,'old-client',i,JSON.stringify({commandId:'cold-'+i,channel,clientId:'old-client',clientSeq:i,status:'completed',fingerprint:'historical',createdAt:stamp,updatedAt:stamp}));steering.run('old-steer-'+i,channel);}
  });
  const plan=(sql:string,...args:any[])=>f.host.store.db.prepare('EXPLAIN QUERY PLAN '+sql).all(...args).map(row=>String(row.detail)).join('\n');
  assert.match(plan("SELECT 1 FROM receipts WHERE channel=? AND json_extract(payload,'$.status')='unknown' LIMIT 1",'ahp-chat:/selected'),/SEARCH receipts USING (?:COVERING )?INDEX receipt_status_channel/);
  assert.match(plan("SELECT payload FROM receipts WHERE json_extract(payload,'$.status') IN ('admitted','dispatching')"),/SEARCH receipts USING (?:COVERING )?INDEX receipt_status_channel/);
  assert.match(plan("SELECT count(*) FROM steering_intents WHERE status IN ('pending','dispatching')"),/SEARCH steering_intents USING COVERING INDEX steering_status/);
  assert.equal(f.host.store.unknown('ahp-chat:/selected'),false);
  f.host.store.admission('ahp-chat:/selected',{text:'admitted'},'selected','owner',1);f.host.store.finish('selected','unknown');assert.equal(f.host.store.unknown('ahp-chat:/selected'),true);f.host.store.finish('selected','completed');assert.equal(f.host.store.unknown('ahp-chat:/selected'),false);
 }finally{await f.cleanup();}
});

test('late held steering may settle after the parent prompt response without a false unknown',async()=>{
 const f=await setup();try{
  const release=join(f.dir,'release-late-steering');(f.config.engines[0]!.env as Record<string,string>).FIXTURE_AFTER_TURN_RELEASE=release;
  const client=await f.connect(),{session}=await f.create(client),commandId=randomUUID();await f.host.submitTurn(session,{commandId,text:'slow',clientId:'owner'});
  await f.host.updatePendingQueue(session,{type:'chat/pendingMessageSet',kind:'steering',id:'late-held',message:{text:'after-turn steering',origin:{kind:'user'}}} as any,{clientId:'owner'});
  assert.equal((await f.host.waitForTurn(session,commandId)).completed,true);assert.equal(f.host.store.receipt('late-held')?.status,'dispatching');
  await assert.rejects(f.host.submitTurn(session,{commandId:randomUUID(),text:'too soon',clientId:'owner'}),/steering disposition is pending/);
  await writeFile(release,'release');
  await waitFor(()=>f.host.store.receipt('late-held')?.status==='failed');assert.equal(f.host.diagnostics().steeringDispositionPending,0);
  const next=randomUUID();await f.host.submitTurn(session,{commandId:next,text:'confirmed new work',clientId:'owner'});assert.equal((await f.host.waitForTurn(session,next)).completed,true);
 }finally{await f.cleanup();}
});

test('a peer that never acknowledges steering cannot hang settlement or retire an uncertain effect',async()=>{
 const f=await setup({steeringOutcomeTimeoutMs:100});try{
  const client=await f.connect(),{session}=await f.create(client),commandId=randomUUID();await f.host.submitTurn(session,{commandId,text:'slow',clientId:'owner'});
  await f.host.updatePendingQueue(session,{type:'chat/pendingMessageSet',kind:'steering',id:'no-ack',message:{text:'no acknowledgement',origin:{kind:'user'}}} as any,{clientId:'owner'});
  assert.equal((await f.host.waitForTurn(session,commandId,2000)).completed,true);assert.equal(f.host.store.receipt('no-ack')?.status,'unknown');assert.match(f.host.store.receipt('no-ack')!.detail!,/acceptance deadline/);
  await assert.rejects(f.host.submitTurn(session,{commandId:randomUUID(),text:'new work',clientId:'owner'}),/unknown/);
 }finally{await f.cleanup();}
});

test('observation admission refuses a runtime retired after a resident precheck instead of mounting it',async()=>{
 const stopped:any[]=[],f=await setup({maxActiveAgents:1,agentStopped:async(event:any)=>{stopped.push(event);}});try{
  const client=await f.connect(),first=await f.create(client),before=await f.host.inspectSession(first.session);
  await f.host.nativeControlExisting(first.session,'configuration.snapshot',{});
  const other=await f.create(client);assert.equal(stopped[0].session,first.session);assert.equal(f.host.diagnostics().activeAgents,1);
  const input={commandId:randomUUID(),watchId:'watch',taskId:'task',taskRevision:1,outcome:{status:'ready'},expectedExecutionRevision:before.executionRevision,expectedInterruptionRevision:before.interruptionRevision,expectedConfigurationHash:before.configurationHash};
  assert.deepEqual(await f.host.submitObservation(first.session,input),{accepted:false,executed:false,reason:'waiting_worker'});assert.equal(f.host.store.receipt(input.commandId),undefined);assert.equal(f.host.diagnostics().activeAgents,1);
  assert.ok(await f.host.nativeControlExisting(other.session,'configuration.snapshot',{}));await assert.rejects(f.host.nativeControlExisting(first.session,'configuration.snapshot',{}),/No existing owned native runtime/);
 }finally{await f.cleanup();}
});

test('only explicit no-effect observation refusal may re-admit the same exact input ID',async()=>{
 const f=await setup();try{
  const flag=join(f.dir,'worker-unavailable');f.config.engines[0].env={...f.config.engines[0].env,FIXTURE_WORKER_UNAVAILABLE_FILE:flag};
  const client=await f.connect(),other=await f.connect(),{session,chat}=await f.create(client),before=await f.host.inspectSession(session);
  const subA=await client.subscribe(chat,{view:{turns:20}}),subB=await other.subscribe(chat,{view:{turns:20}});let stateA=subA.result.snapshot!.state as ChatState,stateB=subB.result.snapshot!.state as ChatState;
  const consume=async(sub:any,apply:(action:any)=>void)=>{for await(const event of sub.subscription)if(event.type==='action'&&!event.params.rejectionReason)apply(event.params.action);};void consume(subA,a=>stateA=chatReducer(stateA,a));void consume(subB,a=>stateB=chatReducer(stateB,a));
  const input={commandId:randomUUID(),watchId:'watch',taskId:'task',taskRevision:1,outcome:{status:'ready'},expectedExecutionRevision:before.executionRevision,expectedInterruptionRevision:before.interruptionRevision,expectedConfigurationHash:before.configurationHash};
  await writeFile(flag,'retired after host reservation');assert.equal((await f.host.submitObservation(session,input)).accepted,true);
  const refused=await f.host.waitForTurn(session,input.commandId);assert.equal(refused.status,'failed');assert.equal(refused.executed,false);assert.equal(refused.retryEligibility,'waiting_worker');assert.equal(refused.observationAdmission!.expectedExecutionRevision,before.executionRevision);assert.equal(refused.observationAdmission!.admittedExecutionRevision,before.executionRevision+1);assert.equal(stateA.turns.length,0);assert.equal(stateB.turns.length,0);assert.equal(stateA.activeTurn,undefined);await assert.rejects(readFile(f.log,'utf8'),/ENOENT/);
  await rm(flag);const current=await f.host.inspectSession(session),retry={...input,expectedExecutionRevision:current.executionRevision,expectedInterruptionRevision:current.interruptionRevision,expectedConfigurationHash:current.configurationHash};
  await assert.rejects(f.host.submitObservation(session,{...retry,outcome:{status:'changed'}}),/exact explicitly retryable/);
  assert.equal((await f.host.submitObservation(session,retry)).accepted,true);assert.equal((await f.host.waitForTurn(session,input.commandId)).completed,true);
  const old=f.host.store.db.prepare('SELECT receipt,turn_payload FROM receipt_attempts WHERE command_id=?').get(input.commandId)!;
  assert.equal(JSON.parse(String(old.receipt)).retryEligibility,'waiting_worker');assert.equal(old.turn_payload,null);
  await waitFor(()=>stateA.turns.length===1&&stateB.turns.length===1);assert.equal(stateA.turns[0].id,input.commandId);assert.deepEqual(stateA.turns,stateB.turns);assert.equal((await f.host.inspectSession(session)).observationAdmission,undefined);
  assert.equal((await readFile(f.log,'utf8')).trim().split('\n').length,1);assert.equal(f.host.store.receipt(input.commandId)?.retryEligibility,undefined);
  await assert.rejects(f.host.submitObservation(session,retry),/already admitted/);
 }finally{await f.cleanup();}
});

test('standard shared archive survives subsequent turn status updates and host restart',async()=>{
 const f=await setup();let restarted:any;try{
  const a=await f.connect(),b=await f.connect(),{session}=await f.create(a);const sub=await b.subscribe(session);const actions:any[]=[];void(async()=>{for await(const event of sub.subscription)if(event.type==='action')actions.push(event.params.action);})();
  a.dispatch(session,{type:'session/isArchivedChanged',isArchived:true});await waitFor(()=>actions.some(action=>action.type==='session/isArchivedChanged'));assert.ok(f.host.store.get(session)!.summary.status & 64);
  const commandId=randomUUID();await f.host.submitTurn(session,{commandId,text:'Archive is shared organization',clientId:'owner'});await f.host.waitForTurn(session,commandId);assert.ok(f.host.store.get(session)!.summary.status & 64);assert.ok((await a.request('listSessions',{channel:'ahp-root://'})).items[0].status & 64);
  for(const client of f.clients)await client.shutdown();await f.host.close();restarted=await createHost(f.config);assert.ok(restarted.store.get(session)!.summary.status & 64);await restarted.archiveSession(session,false);assert.equal(restarted.store.get(session)!.summary.status & 64,0);
 }finally{if(restarted){await restarted.close();await rm(f.dir,{recursive:true,force:true});}else await f.cleanup();}
});

test('lost native fork acknowledgement fences source and reserved identity until exact receipt recovery',async()=>{
 const f=await setup();try{
  const client=await f.connect(),{session}=await f.create(client),commandId='lost-'+randomUUID(),args={commandId,expectedHistoryRevision:'fixture-history'};
  await assert.rejects(f.host.forkSession(session,args),(error:any)=>error.data?.outcome==='unknown');const row=f.host.store.db.prepare('SELECT * FROM lifecycle_commands WHERE command_id=?').get(commandId)!;
  assert.equal(row.status,'unknown');await assert.rejects(f.host.submitTurn(session,{commandId:randomUUID(),text:'Unsafe continuation',clientId:'owner'}),/lifecycle outcome/);
  await assert.rejects(client.request('createSession',{channel:String(row.target),provider:'fixture',workingDirectories:[pathToFileURL(f.dir).href]}),/lifecycle outcome/);
  await assert.rejects(f.host.forkSession(session,args),/without replay/);const recovered=await f.host.inspectSessionLifecycleReceipt(session,commandId);assert.equal(recovered.status,'completed');assert.equal(recovered.result.uri,row.target);assert.equal(recovered.result.workReplayed,false);
  assert.deepEqual(await f.host.forkSession(session,args),recovered.result);const receipts=JSON.parse(await readFile(f.log+'.lifecycle','utf8'));assert.equal(Object.keys(receipts).length,1);assert.equal(f.host.diagnostics().activeAgents,0);
 }finally{await f.cleanup();}
});

test('committed attachment references resolve only on execution and never inflate retained history',async()=>{
 const calls:any[]=[],f=await setup({resolvePromptAttachment:async(context:any,attachment:any)=>{calls.push({context,attachment});if(attachment.uri.includes('too-large'))return [{type:'text',text:'x'.repeat(8*1024*1024)}];return [{type:'resource_link',uri:'file:///owned-immutable/blob',name:attachment.label,mimeType:attachment.contentType}];}});try{
  const a=await f.connect(),{session,chat}=await f.create(a),ref={type:'resource',uri:'amplifier-attachment://owned/body?session='+encodeURIComponent(session),label:'Report.pdf',contentType:'application/pdf'} as any;
  const id=randomUUID();await f.host.submitTurn(session,{commandId:id,text:'Read this',clientId:'owner',attachments:[ref]});assert.equal((await f.host.waitForTurn(session,id)).completed,true);assert.equal(calls.length,1);assert.equal(calls[0].context.session,session);assert.equal(calls[0].context.engineId,'fixture');assert.ok(calls[0].context.nativeSessionId);
  const wire=JSON.parse((await readFile(f.log,'utf8')).trim());assert.equal(wire.prompt[1].uri,'file:///owned-immutable/blob');assert.equal(wire.prompt[1].name,'Report.pdf');const state=(await a.subscribe(chat,{view:{turns:1}})).result.snapshot!.state as any;assert.deepEqual(state.turns[0].message.attachments,[ref]);assert.equal(calls.length,1);
  const slow=randomUUID();await f.host.submitTurn(session,{commandId:slow,text:'slow',clientId:'owner'});const queued=randomUUID();await f.host.updatePendingQueue(session,{type:'chat/pendingMessageSet',kind:'queued',id:queued,message:{text:'Later',origin:{kind:'user'},attachments:[ref]}} as any,{clientId:'owner'});assert.equal(calls.length,1);a.dispatch(chat,{type:'chat/turnCancelled',turnId:slow,duration:0});assert.equal((await f.host.waitForTurn(session,slow)).status,'cancelled');
  const rejected=randomUUID();await assert.rejects(f.host.submitTurn(session,{commandId:rejected,text:'Invalid resolved size',clientId:'owner',attachments:[{...ref,uri:'amplifier-attachment://too-large/body'}]}),/wire budget/);assert.equal(f.host.store.receipt(rejected),undefined);
 }finally{await f.cleanup();}
});

test('passive response parts preserve distinct canonical native message boundaries for export',async()=>{
 const f=await setup();try{
  const history=join(f.dir,'history.json');await writeFile(history,JSON.stringify([{id:'native-user',state:'complete',updates:[{sessionUpdate:'user_message_chunk',content:{type:'text',text:'User'},_meta:{'amplifier.dev/history':{messageId:'native:user',inputOrigin:'unknown'}}},{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'First answer'},_meta:{'amplifier.dev/history':{messageId:'native:first'}}},{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Second answer'},_meta:{'amplifier.dev/history':{messageId:'native:second'}}}]}]));f.config.engines[0].env={...f.config.engines[0].env,FIXTURE_HISTORY:history};
  const client=await f.connect(),{session,chat}=await f.create(client);await f.host.invalidateNativeHistory(session);const state=(await client.subscribe(chat,{view:{turns:1}})).result.snapshot!.state as any;const parts=state.turns[0].responseParts.filter((part:any)=>part.kind==='markdown');assert.deepEqual(parts.map((part:any)=>[part.content,part._meta['amplifier.dev/history'].messageId]),[['First answer','native:first'],['Second answer','native:second']]);
 }finally{await f.cleanup();}
});


test('explicit canonical refresh preserves active and unknown execution without reading history',async()=>{
 const f=await setup();try{
  const client=await f.connect(),{session}=await f.create(client),first=randomUUID();await f.host.submitTurn(session,{commandId:first,text:'slow',clientId:'refresh'});
  await assert.rejects(f.host.refreshSessionHistory(session),/conclusively idle/);assert.equal((await f.host.waitForTurn(session,first)).completed,true);
  const uncertain=randomUUID();await f.host.submitTurn(session,{commandId:uncertain,text:'crash',clientId:'refresh'});assert.equal((await f.host.waitForTurn(session,uncertain)).status,'unknown');
  await assert.rejects(f.host.refreshSessionHistory(session),/conclusively idle/);assert.equal(f.host.store.receipt(uncertain)?.status,'unknown');assert.equal((await readFile(f.log,'utf8')).trim().split('\n').length,2);
 }finally{await f.cleanup();}
});

test('mixed canonical voice and live receipts use one bounded shared window and a complete cursor',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ahp-mixed-')),history=join(dir,'history.json');await writeFile(history,'[]');
  const f=await setup({allowedWorkspaceRoots:[dir],engines:[{id:'fixture',label:'Fixture',command:process.execPath,args:[fileURLToPath(new URL('./agent.mjs',import.meta.url))],env:{FIXTURE_HISTORY:history}}]});
  try{
    const a=await f.connect(),b=await f.connect(),session='ahp-session:/'+randomUUID(),chat=session.replace('ahp-session:','ahp-chat:');
    await a.request('createSession',{channel:session,provider:'fixture',workingDirectories:[pathToFileURL(dir).href]});
    const first=action('before voice'),last=action('after voice');
    for(const input of [first,last]){a.dispatch(chat,input);await waitFor(()=>f.host.store.receipt(input.turnId)?.status==='completed');}
    const text=(id:string,value:string)=>({id,state:'unknown',updates:[{sessionUpdate:'user_message_chunk',content:{type:'text',text:value}},{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'saved '+value}}]});
    const voice={id:'native-voice-only',recordedOnly:true,updates:[{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'spoken between chats'},_meta:{'amplifier.dev/history':{via:'call',callId:'call',itemId:'speech',recordedOnly:true}}}]};
    const older=Array.from({length:58},(_,i)=>text('older-'+i,'older '+i));
    await writeFile(history,JSON.stringify([...older,text(first.turnId,'before voice'),voice,text(last.turnId,'after voice')]));
    const record=f.host.store.get(session)!;record.chat._meta={'amplifier.dev/history':{source:'native'}};f.host.store.save(record);
    const one=await a.subscribe(chat,{view:{turns:1}});let state=one.result.snapshot!.state as ChatState;assert.deepEqual(state.turns.map(turn=>turn.id),[last.turnId]);
    void(async()=>{for await(const event of one.subscription)if(event.type==='action'&&!event.params.rejectionReason)state=chatReducer(state,event.params.action as any);})();
    const two=(await b.subscribe(chat,{view:{turns:2}})).result.snapshot!.state as ChatState;
    assert.deepEqual(two.turns.map(turn=>turn.id),[voice.id,last.turnId]);assert.equal(two.turns.length,2);assert.equal(two.turns[1].state,'complete');assert.equal(two.turns[0].message.text,'');assert.equal(two.turns[0].message.origin?.kind,'agent');
    await waitFor(()=>state.turns.length===2);assert.deepEqual(state.turns.map(turn=>turn.id),two.turns.map(turn=>turn.id));
    const smaller=(await b.subscribe(chat,{view:{turns:1}})).result.snapshot!.state as ChatState;assert.equal(smaller.turns.length,2,'shared window cannot shrink under another viewer');
    await b.request('fetchTurns',{channel:chat,cursor:two.turnsNextCursor});await waitFor(()=>state.turns.length===52);
    assert.deepEqual(state.turns.slice(-3).map(turn=>turn.id),[first.turnId,voice.id,last.turnId]);assert.equal(state.turns.find(turn=>turn.id===first.turnId)!.state,'complete');assert.ok(state.turnsNextCursor);
    await a.request('fetchTurns',{channel:chat,cursor:state.turnsNextCursor});await waitFor(()=>state.turns.length===61);assert.equal(new Set(state.turns.map(turn=>turn.id)).size,61);assert.equal(state.turnsNextCursor,undefined);
    assert.deepEqual(state.turns.map(turn=>turn.id),[...older.map(turn=>turn.id),first.turnId,voice.id,last.turnId]);
    await a.unsubscribe(chat);await b.unsubscribe(chat);await waitFor(()=>!(f.host as any).hasSubscribers(chat));
    const reset=(await a.subscribe(chat,{view:{turns:2}})).result.snapshot!.state as ChatState;assert.equal(reset.turns.length,2);assert.ok(reset.turnsNextCursor);
    const context=await f.host.readSessionContext(session,3);assert.ok(context.messages.some(row=>row.text==='spoken between chats'));assert.ok(context.messages.findIndex(row=>row.text==='before voice')<context.messages.findIndex(row=>row.text==='spoken between chats'));
    const full=(await a.subscribe(chat)).result.snapshot!.state as ChatState;assert.equal(full.turns.length,50);assert.ok(full.turnsNextCursor);
  }finally{await f.cleanup();await rm(dir,{recursive:true,force:true});}
});

test('native mixed window refuses an unindexed ordering gap without scanning all history',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ahp-gap-')),history=join(dir,'history.json'),log=join(dir,'calls');await writeFile(history,'[]');
  const f=await setup({allowedWorkspaceRoots:[dir],engines:[{id:'fixture',label:'Fixture',command:process.execPath,args:[fileURLToPath(new URL('./agent.mjs',import.meta.url))],env:{FIXTURE_HISTORY:history,FIXTURE_LOG:log}}]});
  try{
    const client=await f.connect(),session='ahp-session:/'+randomUUID(),chat=session.replace('ahp-session:','ahp-chat:');await client.request('createSession',{channel:session,provider:'fixture',workingDirectories:[pathToFileURL(dir).href]});
    const input=action('host');client.dispatch(chat,input);await waitFor(()=>f.host.store.receipt(input.turnId)?.status==='completed');
    const groups=Array.from({length:5000},(_,i)=>({id:'native-'+i,recordedOnly:true,updates:[{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'voice '+i}}]}));await writeFile(history,JSON.stringify(groups));
    const record=f.host.store.get(session)!;record.chat._meta={'amplifier.dev/history':{source:'native'}};f.host.store.save(record);
    await assert.rejects(client.subscribe(chat,{view:{turns:2}}),(error:any)=>error.code===-32013&&error.data?.reason==='unindexed-ordering-boundary');
    assert.equal((await readFile(log+'.passive','utf8')).trim(),'page');assert.equal(f.host.store.receipt(input.turnId)?.status,'completed');assert.equal(f.host.store.turns(chat).turns.length,1);
    const context=await f.host.readSessionContext(session,2);
    assert.deepEqual(context.historyContext,{source:'native',complete:false,reason:'unindexed-ordering-boundary'});
    assert.deepEqual(context.messages.map(row=>row.text),['voice 4998','voice 4999']);
    assert.equal(f.host.store.turns(chat).turns.length,1,'context reads do not rebaseline or widen shared history');
    assert.equal((await readFile(log+'.passive','utf8')).trim().split('\n').length,3,'only bounded pages are read');
  }finally{await f.cleanup();await rm(dir,{recursive:true,force:true});}
});

test('native views above one owner page preserve the full requested window and reject changed paging baselines',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ahp-pages-')),history=join(dir,'history.json');
  const groups=Array.from({length:300},(_,i)=>({id:'saved-'+i,recordedOnly:true,updates:[{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'answer '+i}}]}));await writeFile(history,JSON.stringify(groups));
  const f=await setup({allowedWorkspaceRoots:[dir],engines:[{id:'fixture',label:'Fixture',command:process.execPath,args:[fileURLToPath(new URL('./agent.mjs',import.meta.url))],env:{FIXTURE_HISTORY:history}}]});
  try{
    const client=await f.connect(),session='ahp-session:/'+randomUUID(),chat=session.replace('ahp-session:','ahp-chat:');await client.request('createSession',{channel:session,provider:'fixture',workingDirectories:[pathToFileURL(dir).href]});const record=f.host.store.get(session)!;record.chat._meta={'amplifier.dev/history':{source:'native'}};f.host.store.save(record);
    const selected=(await client.subscribe(chat,{view:{turns:250}})).result.snapshot!.state as ChatState;assert.equal(selected.turns.length,250);assert.equal(selected.turns[0].id,'saved-50');assert.ok(selected.turnsNextCursor);
    const other='ahp-session:/'+randomUUID();await client.request('createSession',{channel:other,provider:'fixture',workingDirectories:[pathToFileURL(dir).href]});await assert.rejects(client.request('fetchTurns',{channel:other.replace('ahp-session:','ahp-chat:'),cursor:selected.turnsNextCursor}),/another chat/);
    groups[100].id='rewritten-turn';await writeFile(history,JSON.stringify(groups));await assert.rejects(client.request('fetchTurns',{channel:chat,cursor:selected.turnsNextCursor}),/fresh canonical baseline/);
    const fresh=(await client.subscribe(chat,{view:{turns:250}})).result.snapshot!.state as ChatState;await client.request('fetchTurns',{channel:chat,cursor:fresh.turnsNextCursor});assert.equal(((await client.subscribe(chat,{view:{turns:1}})).result.snapshot!.state as ChatState).turns.length,300);
  }finally{await f.cleanup();await rm(dir,{recursive:true,force:true});}
});

test('coordination uses bounded indexed results and preserves agent follow-up provenance',async()=>{
 const settled:any[]=[];const f=await setup({turnSettled:async(event:any)=>{settled.push(event);}});try{
  const client=await f.connect(),{session,chat}=await f.create(client),id=randomUUID();await f.host.submitTurn(session,{commandId:id,text:'Agent coordination follow-up',clientId:'coordinator',origin:'agent'});assert.equal((await f.host.waitForTurn(session,id)).completed,true);
  await waitFor(()=>settled.length===1);assert.equal(settled[0].inputOrigin,'coordination');await assert.rejects(f.host.readUserMessage(session,id),(error:any)=>error.reason==='not-user');assert.equal(f.host.store.turns(chat).turns[0].message.origin?.kind,'agent');
  const prompt=JSON.parse((await readFile(f.log,'utf8')).trim());assert.equal(prompt._meta['amplifier.dev/input'].inputOrigin,'coordination');
  const now=new Date().toISOString();for(let i=0;i<80;i++)f.host.store.saveTurn(chat,{id:'indexed-'+i,startedAt:now,state:'complete',message:{text:'request '+i,origin:{kind:'user'}},responseParts:[{kind:'markdown',id:'response-'+i,content:i===0?'😀'.repeat(10000):'answer '+i}]} as any);
  (f.host.store as any).turns=()=>{throw new Error('Result reads must not reconstruct turns');};
  const one=await f.host.readCoordinationSession(session,{limit:32});assert.equal(one.results.length,32);assert.equal(one.hasMore,true);assert.equal(one.results[1].sourceTruncated,true);assert.ok(Buffer.byteLength(one.results[1].text)<=20003);assert.equal(one.coverage.nativeHistoriesRead,false);assert.equal(one.attentionUnknown,true);assert.equal(one.attentionCoverage.questions,false);
  const two=await f.host.readCoordinationSession(session,{afterSequence:one.results.at(-1)!.sequence,limit:32});assert.equal(two.results.length,32);assert.ok(two.results[0].sequence>one.results.at(-1)!.sequence);assert.equal(new Set([...one.results,...two.results].map(result=>result.id)).size,64);assert.deepEqual((await f.host.readCoordinationSession(session,{afterSequence:two.latestSequence})).results,[]);
  const record=f.host.store.get(session)!;for(let i=0;i<5;i++)f.host.store.save({...record,uri:'ahp-session:/listed-'+i,chat:{...record.chat,resource:'ahp-chat:/listed-'+i},summary:{...record.summary,resource:'ahp-session:/listed-'+i,title:'Listed '+i}});
  const page=await f.host.listCoordinationSessions({limit:2});assert.equal(page.items.length,2);assert.ok(page.nextCursor);assert.equal(page.coverage.unselectedCatalogSessions,false);assert.equal((await f.host.listCoordinationSessions({cursor:page.nextCursor,limit:2})).items.length,2);
  await assert.rejects(f.host.readCoordinationSession(session,{limit:33}));
 }finally{await f.cleanup();}
});

test('coordination imported absence is explicit and worker inspection never starts a dormant runtime',async()=>{
 const f=await setup();let replacement:any;try{
  const client=await f.connect(),{session}=await f.create(client);const live=await f.host.readCoordinationWorkers(session);assert.equal(live.resident,true);assert.equal(f.host.diagnostics().activeAgents,1);await client.shutdown();await f.host.close();replacement=await createHost(f.config);
  const passive=await replacement.readCoordinationWorkers(session,{limit:1});assert.equal(passive.resident,false);assert.equal(passive.available,false);assert.equal(replacement.diagnostics().activeAgents,0);assert.equal((await readFile(f.log+'.passive','utf8')).trim(),'workers\nworkers');await assert.rejects(readFile(f.log,'utf8'));
  const timestamp=new Date().toISOString();replacement.config.catalog={get:async()=>({uri:'ahp-session:/unindexed',engineId:'fixture',nativeSessionId:'native-old',workingDirectory:f.dir,title:'Old',createdAt:timestamp,modifiedAt:timestamp}),list:async()=>({items:[]}),upsert:async()=>{}};
  const unknown=await replacement.readCoordinationSession('ahp-session:/unindexed');assert.equal(unknown.available,false);assert.equal(unknown.reason,'not-indexed');assert.equal(replacement.diagnostics().activeAgents,0);
 }finally{if(replacement)await replacement.close();else await f.host.close();await rm(f.dir,{recursive:true,force:true});}
});

test('durable conversation interruption targets only the admitted turn and duplicates never cancel again',async()=>{
 const f=await setup();try{
  const client=await f.connect(),{session}=await f.create(client),turnId=randomUUID(),commandId=randomUUID();await f.host.submitTurn(session,{commandId:turnId,text:'slow',clientId:'ui'});
  assert.equal((await f.host.interruptSession(session,{commandId:'wrong',turnId:'another-turn',clientId:'agent',origin:'agent'})).accepted,false);assert.equal(f.host.store.receipt('wrong'),undefined);
  const accepted=await f.host.interruptSession(session,{commandId,turnId,clientId:'agent',origin:'agent'});assert.equal(accepted.delivery,'requested');assert.equal((await f.host.waitForTurn(session,turnId)).status,'cancelled');
  const revision=(await f.host.inspectSession(session)).interruptionRevision,duplicate=await f.host.interruptSession(session,{commandId,turnId,clientId:'agent',origin:'agent'});assert.equal(duplicate.replayed,false);assert.equal((await f.host.inspectSession(session)).interruptionRevision,revision);
  await assert.rejects(f.host.interruptSession(session,{commandId,turnId:'changed',clientId:'agent',origin:'agent'}),/identity changed/);
 }finally{await f.cleanup();}
});

test('immutable export inspection proves exact selected ownership without hydrating native history',async()=>{
 const f=await setup();try{
  const client=await f.connect(),one=await f.create(client),two=await f.create(client),uri='amplifier-export:/'+('a'.repeat(64));
  const metadata={resource:uri,summary:{format:'markdown',scope:'all',minimal:true,bytes:10},mimeType:'text/markdown',contentHash:'b'.repeat(64)};f.host.store.db.prepare('INSERT INTO export_resources VALUES(?,?,?,?)').run(uri,one.session,'snapshot',JSON.stringify(metadata));
  (f.host as any).lifecycleAgent=()=>{throw new Error('Metadata inspection must not hydrate');};const found=await f.host.inspectExportResource(uri,one.session);assert.equal(found.session,one.session);assert.equal(found.summary.minimal,true);
  await assert.rejects(f.host.inspectExportResource(uri,two.session),/selected session/);await assert.rejects(f.host.inspectExportResource(uri+'?offset=0',one.session),/exact immutable/);
  f.host.store.db.prepare('UPDATE export_resources SET metadata=? WHERE uri=?').run(JSON.stringify({...metadata,summary:{bytes:10}}),uri);await assert.rejects(f.host.inspectExportResource(uri,one.session),/metadata is unavailable/);
 }finally{await f.cleanup();}
});

test('coordination interrupt transport uncertainty is durable and cannot be replayed',async()=>{
 const f=await setup();try{
  const client=await f.connect(),{session}=await f.create(client),turnId=randomUUID(),commandId=randomUUID();await f.host.submitTurn(session,{commandId:turnId,text:'slow',clientId:'ui'});
  const active=(f.host as any).active.get(session);let calls=0;active.agent.client.cancel=async()=>{calls++;throw new Error('Notification delivery lost');};
  await assert.rejects(f.host.interruptSession(session,{commandId,turnId,clientId:'coordinator',origin:'agent'}),/unknown/);assert.equal(f.host.store.receipt(commandId)?.status,'unknown');
  const duplicate=await f.host.interruptSession(session,{commandId,turnId,clientId:'coordinator',origin:'agent'});assert.equal(duplicate.delivery,'unknown');assert.equal(duplicate.replayed,false);assert.equal(calls,1);
  await f.host.waitForTurn(session,turnId);assert.equal((await f.host.readCoordinationSession(session)).status,'unknown');
 }finally{await f.cleanup();}
});


test('readable recovery preserves unknown source admission and requires bounded stable family metadata',async()=>{
 const records=new Map<string,any>();let changed=false,overflow=false;
 const catalog:any={list:async()=>({items:[...records.values()]}),get:async(uri:string)=>records.get(uri),upsert:async(record:any)=>{records.set(record.uri,structuredClone(record));},descendants:async({parentUri}:any)=>({parentUri,rootKnown:records.has(parentUri),root:records.get(parentUri),items:[...records.values()].filter(row=>row.parentUri===parentUri),completeIndexedCoverage:!overflow,truncated:overflow,issues:overflow?['result-limit']:[],excludedKinds:[],revision:changed?randomUUID():'stable',coverage:'indexed-native-history',externalWriterCoverage:false,freshness:{phase:'complete',issues:0,completedAt:new Date().toISOString()}})};
 const f=await setup({catalog});try{
  const client=await f.connect(),{session,chat}=await f.create(client),child=await f.create(client),input=randomUUID();
  records.get(child.session).parentUri=session;
  await f.host.submitTurn(session,{commandId:input,text:'crash',clientId:'owner'});await f.host.waitForTurn(session,input);assert.equal(f.host.store.receipt(input)!.status,'unknown');
  await assert.rejects(f.host.forkSession(session,{commandId:randomUUID(),expectedHistoryRevision:'fixture-history'}),/Unresolved execution/);
  overflow=true;await assert.rejects(f.host.forkSession(session,{commandId:randomUUID(),expectedHistoryRevision:'fixture-history',mode:'recovery'}),/coverage/);overflow=false;
  changed=true;await assert.rejects(f.host.forkSession(session,{commandId:randomUUID(),expectedHistoryRevision:'fixture-history',mode:'recovery'}),/family changed/);changed=false;
  const commandId=randomUUID(),args={commandId,expectedHistoryRevision:'fixture-history',mode:'recovery' as const};
  const copy=await f.host.forkSession(session,args);assert.equal(copy.mode,'recovery');assert.equal(copy.workReplayed,false);assert.equal(f.host.store.receipt(input)!.status,'unknown');assert.ok(f.host.store.unknown(chat));
  assert.deepEqual(await f.host.forkSession(session,args),copy);assert.equal((await readFile(f.log,'utf8')).trim().split('\n').length,1,'Copy must not prompt source, children, or target');
 }finally{await f.cleanup();}
});


test('selected family proof refreshes stale discovery but refuses partial, unbound and changed snapshots',async()=>{
 const records=new Map<string,any>();let bad:string|undefined,changed=false,refreshes=0;
 const family=(parentUri:string)=>({parentUri,rootKnown:records.has(parentUri),root:records.get(parentUri),items:[...records.values()].filter(row=>row.parentUri===parentUri),completeIndexedCoverage:true,truncated:false,issues:[],excludedKinds:[],revision:changed?'changed':'stable',coverage:'indexed-native-history',externalWriterCoverage:false,freshness:{phase:'not-started'}});
 const catalog:any={list:async()=>({items:[...records.values()]}),get:async(uri:string)=>records.get(uri),upsert:async(row:any)=>records.set(row.uri,structuredClone(row)),descendants:async({parentUri}:any)=>family(parentUri),reconcileFamily:async(args:any)=>{
  refreshes++;assert.equal(args.limit,100);assert.equal(args.maxEntries,512);const value=family(args.parentUri);
  const proof:any={version:1,scope:'selected-native-project-namespaces',phase:'complete',issues:[],maxEntries:512,metadataByteLimit:8388608,indexRevision:value.revision,entriesExamined:2,metadataReads:2,metadataBytesAdmitted:512,metadataFileLimit:2048,verificationToken:'opaque',inventoryHash:'a'.repeat(64),namespaces:['/owned/namespace'],completedAt:new Date().toISOString(),externalWriterCoverage:false,transcriptBodiesRead:false,nativeOwnershipVerified:false};
  if(bad==='partial')proof.phase='refused';if(bad==='binding')proof.indexRevision='unbound';if(bad==='body')proof.transcriptBodiesRead=true;if(bad==='overflow')proof.entriesExamined=513;if(bad==='old')proof.completedAt=new Date(Date.now()-700000).toISOString();
  if(bad==='unavailable')throw Error('catalog response lost');
  if(bad==='changed')changed=true;
  return {...value,familyDiscovery:proof};
 },verifyFamily:async({parentUri}:any)=>({version:1,scope:'selected-native-project-namespaces',valid:bad!=='physical-change',parentUri,indexRevision:'stable',inventoryHash:bad==='physical-binding'?'b'.repeat(64):'a'.repeat(64),issues:[],completedAt:new Date().toISOString(),externalWriterCoverage:false,nativeOwnershipVerified:false,transcriptBodiesRead:false})};
 const f=await setup({catalog});try{
  const client=await f.connect(),root=await f.create(client),child=await f.create(client);records.get(child.session).parentUri=root.session;
  for(const failure of ['partial','binding','body','overflow','old','unavailable','changed','physical-change','physical-binding']){
   bad=failure;changed=false;await assert.rejects(f.host.forkSession(root.session,{commandId:randomUUID(),expectedHistoryRevision:'fixture-history',mode:'recovery'}),/coverage|discovery|family changed/);
  }
  bad=undefined;changed=false;const result=await f.host.forkSession(root.session,{commandId:randomUUID(),expectedHistoryRevision:'fixture-history',mode:'recovery'});assert.equal(result.workReplayed,false);assert.equal(refreshes,10);
  await assert.rejects(readFile(f.log,'utf8'),/ENOENT/,'No source, child or target prompt is replayed');
 }finally{await f.cleanup();}
});

test('older catalog without reconcileFamily retains fresh indexed proof only',async()=>{
 const records=new Map<string,any>();let stale=false;
 const catalog:any={list:async()=>({items:[]}),get:async(uri:string)=>records.get(uri),upsert:async(row:any)=>records.set(row.uri,structuredClone(row)),reconcileFamily:async()=>{throw Object.assign(Error('Method not found'),{code:-32601});},descendants:async({parentUri}:any)=>({parentUri,rootKnown:true,root:records.get(parentUri),items:[],completeIndexedCoverage:true,truncated:false,issues:[],excludedKinds:[],revision:'stable',coverage:'indexed-native-history',externalWriterCoverage:false,freshness:{phase:'complete',issues:0,completedAt:new Date(Date.now()-(stale?700000:0)).toISOString()}})};
 const f=await setup({catalog});try{
  const client=await f.connect(),root=await f.create(client);stale=true;await assert.rejects(f.host.forkSession(root.session,{commandId:randomUUID(),expectedHistoryRevision:'fixture-history',mode:'recovery'}),/coverage/);stale=false;assert.equal((await f.host.forkSession(root.session,{commandId:randomUUID(),expectedHistoryRevision:'fixture-history',mode:'recovery'})).workReplayed,false);
 }finally{await f.cleanup();}
});


test('guarded peer inputs use exact recipient revisions and cannot become human authority',async()=>{
 const f=await setup();try{
  const client=await f.connect(),{session}=await f.create(client),before=await f.host.inspectSession(session),commandId=randomUUID();
  const input={commandId,grantId:'human-scope',text:'Saved peer request',peerEnvelope:{requestId:commandId,grantId:'human-scope',mode:'queue',senderSessionId:'source',recipientSessionId:session},taskId:null,taskRevision:null,expectedExecutionRevision:before.executionRevision,expectedInterruptionRevision:before.interruptionRevision,expectedConfigurationHash:before.configurationHash,expectedNativeSessionId:before.nativeSessionId!,expectedNativeLocationRevision:before.nativeLocationRevision};
  await assert.rejects(f.host.submitPeer(session,{...input,expectedNativeSessionId:'moved'}),/identity or location changed/);
  assert.equal((await f.host.submitPeer(session,input)).accepted,true);assert.equal((await f.host.waitForTurn(session,commandId)).status,'completed');
  const wire=JSON.parse((await readFile(f.log,'utf8')).trim());assert.equal(wire.operation,'peer.submit');assert.equal(wire.args.inputId,commandId);assert.equal(wire.args.text,undefined);assert.equal(wire.args.peerEnvelope,undefined);
  const context=await f.host.readSessionContext(session,2);assert.equal(context.messages[0].inputOrigin,'peer');await assert.rejects(f.host.readUserMessage(session,commandId),(e:any)=>e.reason==='not-user');
  await assert.rejects(f.host.submitPeer(session,input),/already admitted/);
  await assert.rejects(f.host.nativeControl(session,'peer.submit',{}),/submitPeer admission/);await assert.rejects(f.host.nativeControl(session,'peer.steer',{}),/submitPeerSteering admission/);
  const current=await f.host.inspectSession(session);assert.equal(current.peerAdmission,undefined);
  const refused=randomUUID();await f.host.submitPeer(session,{...input,commandId:refused,peerEnvelope:{...input.peerEnvelope,requestId:refused},taskRevision:99,expectedExecutionRevision:current.executionRevision});
  assert.equal((await f.host.waitForTurn(session,refused)).status,'failed');assert.equal(f.host.store.turns(session.replace('ahp-session:','ahp-chat:')).turns.length,1);
  assert.equal((await readFile(f.log,'utf8')).trim().split('\n').length,1);
 }finally{await f.cleanup();}
});
