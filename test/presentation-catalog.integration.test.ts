import {spawn} from 'node:child_process';
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {fileURLToPath,pathToFileURL} from 'node:url';
import {AhpClient} from '@microsoft/agent-host-protocol/client';import {WebSocketTransport} from '@microsoft/agent-host-protocol/ws';
import {createHost as sourceHost} from '../src/host.js';import {StdioCatalog as SourceCatalog} from '../src/catalog.js';
const python=process.env.PRESENTATION_CATALOG_PYTHON;
const api=process.env.HOST_PACKAGE?await import(pathToFileURL(process.env.HOST_PACKAGE).href):{createHost:sourceHost,StdioCatalog:SourceCatalog};
const productionReconstruct=process.env.PRESENTATION_DISTRIBUTION_MODULE?(await import(pathToFileURL(process.env.PRESENTATION_DISTRIBUTION_MODULE).href)).reconstructPresentationMetadata:undefined;
const actor={actorId:'reviewer',origin:'ui' as const};
const pause=()=>{let release!:()=>void;const promise=new Promise<void>(r=>release=r);return {promise,release};};
const waitScan=async(c:any)=>{const prior=(await c.status()).runId;await c.request('scan',{});for(let i=0;i<500;i++){const result=await c.status();if(result.phase==='complete'&&result.runId!==prior){assert.equal(result.issues,0);return;}if(result.phase==='failed')throw Error(JSON.stringify(result));await new Promise(r=>setTimeout(r,10));}throw Error('Metadata discovery did not finish');};
async function fixture(count:number,engineFixture=false){
 const directory=await realpath(await mkdtemp(join(tmpdir(),'presentation-installed-'))),home=join(directory,'native'),workspace=join(directory,'workspace'),index=join(directory,'catalog.sqlite'),log=join(directory,'prompts.jsonl'),history=join(directory,'history.json');await mkdir(workspace);await mkdir(home);await mkdir(join(home,'projects'));
 await writeFile(history,JSON.stringify([{id:'retained-turn',state:'complete',updates:[{sessionUpdate:'user_message_chunk',content:{type:'text',text:'Retained canonical user'},_meta:{'amplifier.dev/history':{messageId:'retained-user',inputOrigin:'unknown'}}},{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Retained canonical answer'},_meta:{'amplifier.dev/history':{messageId:'retained-answer'}}}]}]));
 const files=new Map<string,string>(),records:any[]=[];for(let i=0;i<count;i++){
  const nativeId='native-'+i,session='ahp-session:/stable-'+i,storagePath=join(home,'projects',workspace.replaceAll('/','-'),'sessions',nativeId);await mkdir(storagePath,{recursive:true});
  for(const [name,body] of Object.entries({'metadata.json':JSON.stringify({session_id:nativeId,working_dir:workspace,parent_id:null,title:'Retained '+i}),'transcript.jsonl':'{"role":"user","content":"retained canonical input"}\n','events.jsonl':'retained opaque audit bytes\n'})){const path=join(storagePath,name);await writeFile(path,body);files.set(path,body);}
  records.push({uri:session,engineId:'amplifier',nativeSessionId:nativeId,workingDirectory:workspace,storagePath,title:'Retained '+i,kind:'root',createdAt:'2026-01-01T00:00:00Z',modifiedAt:'2026-01-01T00:00:00Z',workspaceAvailability:'present'});
 }
 const launch=()=>new api.StdioCatalog({command:python!,args:['-I',fileURLToPath(new URL('../fixtures/catalog-no-history.py',import.meta.url)),'serve','--db',index,'--home',home,'--scan-interval','0','--workspace-check-interval','0']});let catalog=launch();try{for(const record of records)await catalog.upsert(record);await waitScan(catalog);}catch(error){const diagnostics=catalog.diagnostics();await catalog.close();await rm(directory,{recursive:true,force:true});throw new Error((error as Error).message+' '+JSON.stringify(diagnostics));}
 let hintOverride:undefined|((path:string,catalog:any,context:any)=>Promise<any>),settleHook:undefined|((attempt:any)=>Promise<any>);let hints=0,notifications=0,reconstructHook:undefined|(()=>Promise<void>),hintHook:undefined|(()=>Promise<void>);let calls=0,loseAt=0,failBefore=false,getHook:undefined|((id:string)=>Promise<void>);let host:any;
 const wrapper:any={hint:async(path:string,context?:any)=>{hints++;if(hintOverride)return hintOverride(path,catalog,context);await hintHook?.();return catalog.hint(path);},list:(p:any)=>catalog.list(p),get:async(id:string)=>{await getHook?.(id);return catalog.get(id);},upsert:(r:any)=>catalog.upsert(r),status:()=>catalog.status(),sessionVisibilityProjectionStatus:(p:any)=>catalog.sessionVisibilityProjectionStatus(p),sessionVisibilityProjectionReceipt:(p:any)=>catalog.sessionVisibilityProjectionReceipt(p),projectSessionVisibility:async(p:any)=>{calls++;if(calls===loseAt&&failBefore)throw Error('Before real catalog projection');const result=await catalog.projectSessionVisibility(p);if(calls===loseAt)throw Error('Lost real catalog reply');return result;}};
 const config:any={stateDirectory:join(directory,'host'),allowedWorkspaceRoots:[workspace],catalog:wrapper,engines:[{id:'amplifier',command:engineFixture?process.execPath:'/must-never-start-during-presentation',...(engineFixture?{args:[fileURLToPath(new URL('../fixtures/acp-peer.mjs',import.meta.url))],env:{FIXTURE_LOG:log,FIXTURE_HISTORY:history}}:{})}],
  nativeEvent:async(_context:any,params:any)=>{if(params.event?.type==='history.persisted')notifications++;},
  conversationPresentation:{settleDiscovery:async(attempt:any)=>{if(!settleHook)throw Error('Original catalog writer is not proven stopped');return settleHook(attempt);},reconstructMetadata:async(request:any)=>{await reconstructHook?.();if(productionReconstruct)return productionReconstruct(catalog)(request);let cursor;do{const page=request.readMappings(cursor);assert.ok(page.items.length<=100);for(const record of page.items)await catalog.upsert(record);cursor=page.nextCursor;}while(cursor);await waitScan(catalog);}},
 };
 const clients:AhpClient[]=[];try{host=await api.createHost(config);}catch(error){await catalog.close();await rm(directory,{recursive:true,force:true});throw error;}
 const connect=async()=>{const c=new AhpClient(await WebSocketTransport.connect(host.url));c.connect();await c.initialize({clientId:'viewer-'+clients.length,protocolVersions:['0.9.0']});clients.push(c);return c;};
 const review=(commandId:string,ids=records.map(r=>r.uri),operation='reset',resetCommandId?:string)=>host.prepareConversationPresentation({commandId,operation,selection:{kind:'explicit',sessionIds:ids},...(resetCommandId?{resetCommandId}:{})},actor);
 const apply=(r:any,commandId:string)=>host.applyConversationPresentation({commandId,reviewId:r.reviewId,reviewHash:r.reviewHash},actor);
 return {directory,records,files,log,workspace,config,get host(){return host;},get catalog(){return catalog;},connect,review,apply,calls:()=>calls,hints:()=>hints,notifications:()=>notifications,reconstructionHook:(fn?:typeof reconstructHook)=>reconstructHook=fn,hintHook:(fn?:typeof hintHook)=>hintHook=fn,overrideHint:(fn?:typeof hintOverride)=>hintOverride=fn,settlementHook:(fn?:typeof settleHook)=>settleHook=fn,fail:(at:number,before=false)=>{loseAt=at;failBefore=before;},hook:(fn?:typeof getHook)=>getHook=fn,
  restart:async()=>{for(const c of clients)await c.shutdown().catch(()=>{});await host.close();host=undefined;host=await api.createHost(config);},
  clearCatalog:async()=>{await catalog.close();for(const suffix of ['', '-wal','-shm'])await rm(index+suffix,{force:true});catalog=launch();},
  crashApply:async(review:any,killAt:number,after:boolean)=>{
   for(const c of clients)await c.shutdown().catch(()=>{});await host.close();host=undefined;
   const input=join(directory,'crash.json');await writeFile(input,JSON.stringify({stateDirectory:config.stateDirectory,workspace,index,home,review,killAt,after,actor,python}));
   const outcome=await new Promise<any>((resolve,reject)=>{const child=spawn(process.execPath,[fileURLToPath(new URL('../fixtures/presentation-crash.mjs',import.meta.url)),input],{env:process.env,stdio:['ignore','ignore','pipe']});let error='';child.stderr.on('data',chunk=>error+=chunk);child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal,error}));});assert.equal(outcome.signal,'SIGKILL',outcome.error);host=await api.createHost(config);
  },
  verify:async()=>{for(const [path,body] of files)assert.equal(await readFile(path,'utf8'),body);},
  close:async()=>{for(const c of clients)await c.shutdown().catch(()=>{});try{await host?.close();}finally{await catalog.close();await rm(directory,{recursive:true,force:true});}}};
}

test('installed catalog: viewed refusal,105-row restart repair,undo,index loss; zero agents and canonical bytes preserved',{skip:!python},async()=>{
 const f=await fixture(106);try{
  let client=await f.connect();const selected=f.records.slice(0,105).map(r=>r.uri);await client.subscribe(selected[0]);
  const seen=await f.apply(await f.review('selected-review',selected),'selected');assert.equal(seen.effect.status,'refused');assert.equal(seen.effect.executed,false);assert.match(seen.effect.reason,/viewer/);assert.equal(f.calls(),0);await client.unsubscribe(selected[0]);
  const r=await f.review('review',selected);f.fail(2,true);const result=await f.apply(r,'reset');assert.equal(result.effect.status,'completed');assert.equal(result.projection.status,'unknown');assert.equal(f.calls(),2);await assert.rejects(client.request('listSessions',{channel:'ahp-root://',limit:200}),/unavailable/);
  await f.restart();client=await f.connect();const observed=await f.host.reconcileConversationPresentation('reset',actor);assert.equal(observed.effect.status,'completed');assert.equal(observed.projection.status,'unknown');assert.equal(f.calls(),2);
  // Exact indexed identities survive a partial listing; no worker is required for status or explicit task source.
  assert.equal((await f.host.inspectSession(selected[1])).nativeSessionId,f.records[1].nativeSessionId);assert.equal((await f.host.listRecallSources({session:selected[1],scope:'task'})).items[0].id,selected[1]);
  const repair=await f.host.rebuildConversationPresentation({commandId:'repair',expectedRevision:1},actor);assert.equal(repair.status,'completed');assert.equal(f.host.conversationPresentationReceipt('reset',actor).projection.status,'ready');assert.equal((await client.request('listSessions',{channel:'ahp-root://',limit:200})).items.length,1);
  const undo=await f.review('undo-review',selected,'restore','reset');const restored=await f.apply(undo,'undo');assert.equal(restored.effect.status,'completed');assert.equal((await client.request('listSessions',{channel:'ahp-root://',limit:200})).items.length,106);
  await f.clearCatalog();await assert.rejects(f.host.withConversationCatalogRead(()=>f.catalog.list({connectionId:'raw',limit:50,allowedWorkspaceRoots:[f.workspace]})),/unavailable/);
  // An exact cold mapping retained by review can still be adopted while the index is empty.
  assert.equal((await f.host.inspectSession(selected[2])).nativeSessionId,f.records[2].nativeSessionId);
  const rebuilt=await f.host.rebuildConversationPresentation({commandId:'rebuild',expectedRevision:2},actor);assert.equal(rebuilt.status,'completed');assert.equal(rebuilt.markerCount,105);
  for(const uri of selected){const row=await f.catalog.get(uri);assert.equal(row?.uri,uri);assert.equal(row.productHidden,false);}assert.equal((await client.request('listSessions',{channel:'ahp-root://',limit:200})).items.length,106);
  await f.verify();assert.equal(f.host.diagnostics().activeAgents,0);
 }finally{await f.close();}
});

test('hidden exact-ID reads, artifacts, commands and deferred inputs continue during projection repair; selected races are atomic',{skip:!python},async()=>{
 const f=await fixture(5,true),gate=pause(),entered=pause();try{
  const selected=f.records[0].uri,other=f.records[1].uri,chat=selected.replace('ahp-session:','ahp-chat:');const client=await f.connect();
  const r=await f.review('hidden',[selected,f.records[3].uri]);let once=true;f.hook(async id=>{if(id===selected&&once){once=false;entered.release();await gate.promise;}});f.fail(1,true);
  const hiding=f.apply(r,'hidden');await entered.promise;
  let admitted=false;const pending=f.host.submitTurn(selected,{commandId:'selected-input',text:'visible by exact ID',clientId:'requester'}).then((result:any)=>{admitted=true;return result;});
  // Unrelated exact work must finish while the selected marker's metadata read is still paused.
  await f.host.submitTurn(other,{commandId:'unrelated',text:'unrelated input',clientId:'requester'});assert.equal((await f.host.waitForTurn(other,'unrelated')).completed,true);assert.equal(admitted,false);
  gate.release();const hidden=await hiding;assert.equal(hidden.effect.status,'completed');assert.equal(hidden.projection.status,'unknown');assert.equal((await pending).accepted,true);assert.equal((await f.host.waitForTurn(selected,'selected-input')).completed,true);f.hook();
  await assert.rejects(client.request('listSessions',{channel:'ahp-root://',limit:50}),/unavailable/);const snapshot=(await client.subscribe(selected)).result.snapshot!;assert.equal(snapshot.resource,selected);await client.unsubscribe(selected);const coldChat=f.records[3].uri.replace('ahp-session:','ahp-chat:');const history=(await client.subscribe(coldChat,{view:{turns:10}})).result.snapshot!.state as any;assert.equal(history.turns[0].id,'retained-turn');await client.unsubscribe(coldChat);
  assert.equal((await f.host.readUserMessage(selected,'selected-input')).text,'visible by exact ID');assert.equal((await f.host.listRecallSources({session:selected,scope:'task'})).items[0].id,selected);
  const inspected=await f.host.inspectRecallSource(selected);const recalled=await f.host.readRecallSource(selected,{expectedRevision:inspected.revision});assert.ok(recalled.rows.some((row:any)=>row.text==='Retained canonical answer'));
  const context=await f.host.inspectSession(selected);const scheduled=await f.host.submitScheduled(selected,{commandId:'deferred-input',text:'saved future input',taskId:'saved-task',taskRevision:1,kind:'task',expectedExecutionRevision:context.executionRevision,expectedInterruptionRevision:context.interruptionRevision,expectedConfigurationHash:context.configurationHash});assert.equal(scheduled.accepted,true);assert.equal((await f.host.waitForTurn(selected,'deferred-input')).completed,true);
  assert.equal((await f.host.readUserMessage(selected,'deferred-input')).inputOrigin,'scheduled');assert.equal((await f.host.inspectSessionHistory(selected)).session,selected);
  // Exact file resources remain governed by workspace authorization, not the discovery projection.
  const file=join(f.workspace,'artifact.txt');await writeFile(file,'retained artifact');const body:any=await client.request('resourceRead',{channel:selected,uri:pathToFileURL(file).href,encoding:'utf-8'});assert.ok(JSON.stringify(body).includes('retained artifact'));
  assert.equal(f.host.diagnostics().activeAgents,2);await f.verify();
  // Existing execution fences remain genuine: active and held pending work cannot be hidden.
  const activeReview=await f.review('active',[other]);await f.host.submitTurn(other,{commandId:'long',text:'queue-hold',clientId:'requester'});const active=await f.apply(activeReview,'active');assert.equal(active.effect.status,'refused');assert.match(active.effect.reason,/Active|admission/);
  await f.host.updatePendingQueue(other,{type:'chat/pendingMessageSet',kind:'queued',id:'held-queue',message:{text:'must remain held',origin:{kind:'user'}}},{clientId:'requester'});await f.host.interruptSession(other,{commandId:'cancel',turnId:'long',clientId:'requester'});await f.host.waitForTurn(other,'long');
  const queued=await f.apply(await f.review('queue',[other]),'queue');assert.equal(queued.effect.status,'refused');assert.match(queued.effect.reason,/Retained work/);
  const before=(await readFile(f.log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.equal(before.filter(row=>row.args?.inputId==='deferred-input').length,1);assert.ok(!before.some(row=>row._meta?.['amplifier.dev/command']?.commandId==='held-queue'));
 }finally{gate.release();f.hook();await f.close();}
});

for(const stage of [{at:1,after:false,name:'before first page'},{at:2,after:false,name:'between pages'},{at:2,after:true,name:'after final commit before reply'}])test('actual SIGKILL and independent repair '+stage.name,{skip:!python},async()=>{
 const f=await fixture(105);try{const review=await f.review('review');await f.crashApply(review,stage.at,stage.after);const original=f.host.conversationPresentationReceipt('killed-reset',actor);assert.equal(original.effect.status,'completed');assert.equal(f.host.inspectConversationPresentation().ready,false);const repaired=await f.host.rebuildConversationPresentation({commandId:'explicit-repair',expectedRevision:1},actor);assert.equal(repaired.status,'completed');assert.equal(f.host.conversationPresentationReceipt('killed-reset',actor).projection.status,'ready');assert.deepEqual(f.host.readConversationPresentationEffectReceipt('killed-reset'),original.effect);assert.equal(f.host.diagnostics().activeAgents,0);await f.verify();}finally{await f.close();}
});

const until=async(check:()=>boolean)=>{for(let n=0;n<200;n++){if(check())return;await new Promise(r=>setTimeout(r,10));}assert.fail('Bounded fixture wait expired');};
test('native discovery hints cannot race retained mapping reconstruction; failed projection and restart retain coalesced hints',{skip:!python},async()=>{
 const f=await fixture(2,true),gate=pause(),entered=pause();let repairing:Promise<any>|undefined;try{
  const selected=f.records[0].uri,other=f.records[1].uri;
  await f.host.submitTurn(selected,{commandId:'before',text:'first',clientId:'requester'});await f.host.waitForTurn(selected,'before');await f.catalog.hint(f.records[0].storagePath);
  const hidden=await f.apply(await f.review('hide-review',[selected]),'hide');assert.equal(hidden.projection.status,'ready');
  await f.host.inspectSession(other);await f.clearCatalog();f.reconstructionHook(async()=>{entered.release();await gate.promise;});
  repairing=f.host.rebuildConversationPresentation({commandId:'repair-lost',expectedRevision:1},actor);await entered.promise;
  for(let n=0;n<3;n++)await f.host.nativeControl(selected,'fixture.history.persisted',{metadataPath:join(f.records[0].storagePath,'metadata.json')});await until(()=>f.notifications()===3);
  const during=await f.catalog.list({connectionId:'raw',limit:50,allowedWorkspaceRoots:[f.workspace]});
  assert.deepEqual(during.items.map((row:any)=>row.uri),[],'A hint must not invent an alternate URI before retained mapping seeding');assert.equal(f.hints(),0);
  assert.equal((await f.host.inspectSession(selected)).nativeSessionId,f.records[0].nativeSessionId);
  assert.equal((await f.host.readUserMessage(selected,'before')).text,'first');assert.deepEqual(f.host.readConversationPresentationEffectReceipt('hide'),hidden.effect);
  const inspected=await f.host.inspectRecallSource(selected);assert.ok((await f.host.readRecallSource(selected,{expectedRevision:inspected.revision})).rows.length);
  // Both exact hidden-session work and an unrelated admission remain available, with no global hold.
  await f.host.submitTurn(selected,{commandId:'during',text:'still executable',clientId:'requester'});assert.equal((await f.host.waitForTurn(selected,'during')).completed,true);
  await f.host.submitTurn(other,{commandId:'other',text:'unrelated',clientId:'requester'});assert.equal((await f.host.waitForTurn(other,'other')).completed,true);
  f.fail(2,true);gate.release();assert.equal((await repairing).status,'unknown');assert.equal(f.hints(),2,'Retained paths were reobserved before the failed projection');
  await f.restart();assert.equal(f.hints(),2);assert.equal(f.host.inspectConversationPresentation().ready,false);
  assert.deepEqual(f.host.readConversationPresentationEffectReceipt('hide'),hidden.effect);
  f.reconstructionHook();const repaired=await f.host.rebuildConversationPresentation({commandId:'repair-confirmed',expectedRevision:1},actor);assert.equal(repaired.status,'completed');await until(()=>f.hints()===5);
  await until(()=>f.host.inspectConversationPresentation().ready);const all=await f.catalog.list({connectionId:'raw',limit:50,allowedWorkspaceRoots:[f.workspace]});assert.deepEqual(all.items.map((row:any)=>row.uri),[other]);
  const indexed=await f.catalog.get(selected);assert.equal(indexed.productHidden,true);assert.equal(indexed.nativeSessionId,f.records[0].nativeSessionId);
  await f.verify();assert.equal(f.host.diagnostics().activeAgents,0);
 }finally{gate.release();await repairing?.catch(()=>{});f.reconstructionHook();await f.close();}
});

test('actual catalog hint already dispatched is joined before reconstruction; other work remains available',{skip:!python},async()=>{
 const f=await fixture(2,true),entered=pause(),gate=pause();let rebuilding:Promise<any>|undefined;try{
  const selected=f.records[0].uri;await f.host.submitTurn(selected,{commandId:'warm',text:'warm',clientId:'test'});await f.host.waitForTurn(selected,'warm');
  let reconstructed=false;f.hintHook(async()=>{entered.release();await gate.promise;});f.reconstructionHook(async()=>{reconstructed=true;});
  await f.host.nativeControl(selected,'fixture.history.persisted',{metadataPath:join(f.records[0].storagePath,'metadata.json')});await entered.promise;
  rebuilding=f.host.rebuildConversationPresentation({commandId:'join-hint',expectedRevision:0},actor);
  await f.host.submitTurn(f.records[1].uri,{commandId:'unrelated',text:'unrelated',clientId:'test'});assert.equal((await f.host.waitForTurn(f.records[1].uri,'unrelated')).completed,true);assert.equal(reconstructed,false);
  gate.release();assert.equal((await rebuilding).status,'completed');assert.equal(reconstructed,true);assert.equal(f.hints(),3,'Joined hint plus two retained-source reobservations');await f.verify();
 }finally{gate.release();await rebuilding?.catch(()=>{});await f.close();}
});

test('unclassified hint timeout and restart refuse reconstruction until exact late-writer settlement, without replaying original reset',{skip:!python},async()=>{
 const f=await fixture(1,true),gate=pause();let late:Promise<any>|undefined,finished=false,reconstructions=0,originalAttempt:string|undefined;try{
  const selected=f.records[0].uri;await f.host.submitTurn(selected,{commandId:'warm',text:'warm',clientId:'test'});await f.host.waitForTurn(selected,'warm');
  f.overrideHint(async(path,catalog,context)=>{originalAttempt=context.attemptId;late=gate.promise.then(()=>catalog.hint(path)).then(result=>{finished=true;return result;});throw Error('Lost RPC reply while catalog writer remains active');});
  f.reconstructionHook(async()=>{reconstructions++;});
  await f.host.nativeControl(selected,'fixture.history.persisted',{metadataPath:join(f.records[0].storagePath,'metadata.json')});await until(()=>f.host.diagnostics().catalogHints.unsettled&&!f.host.diagnostics().catalogHints.inFlight);
  const first=await f.host.rebuildConversationPresentation({commandId:'cannot-rebuild',expectedRevision:0},actor);assert.equal(first.status,'unknown');assert.equal(reconstructions,0);
  await f.restart();assert.equal(f.host.diagnostics().catalogHints.unsettled,true);
  assert.equal((await f.host.readUserMessage(selected,'warm')).text,'warm');assert.equal((await f.host.inspectSession(selected)).nativeSessionId,f.records[0].nativeSessionId);
  const unknown=await f.host.rebuildConversationPresentation({commandId:'still-unsettled',expectedRevision:0},actor);assert.equal(unknown.status,'unknown');assert.equal(reconstructions,0);
  f.settlementHook(async attempt=>{if(!finished)throw Error('Original writer still runs');assert.equal(attempt.attemptId,originalAttempt);return {attemptId:attempt.attemptId,evidence:'response-settled',ownerReceipt:'fixture:exact-completed-hint'};});
  assert.equal((await f.host.rebuildConversationPresentation({commandId:'before-late-reply',expectedRevision:0},actor)).status,'unknown');assert.equal(reconstructions,0);
  gate.release();await late;f.overrideHint();
  const repaired=await f.host.rebuildConversationPresentation({commandId:'after-late-reply',expectedRevision:0},actor);assert.equal(repaired.status,'completed');assert.equal(reconstructions,1);await until(()=>f.host.diagnostics().catalogHints.pending===0);
  assert.deepEqual(await f.host.rebuildConversationPresentation({commandId:'cannot-rebuild',expectedRevision:0},actor),first);assert.equal(reconstructions,1);
  assert.equal((await f.catalog.list({connectionId:'raw',limit:50,allowedWorkspaceRoots:[f.workspace]})).items.length,1);await f.verify();
 }finally{gate.release();await late?.catch(()=>{});await f.close();}
});

test('startup history hint waits for native binding and reconstruction without blocking session creation',{skip:!python},async()=>{
 const f=await fixture(0,true),gate=pause(),entered=pause();let rebuilding:Promise<any>|undefined;try{
  const nativeId='native-startup',session='ahp-session:/chosen-startup',storage=join(f.directory,'native','projects',f.workspace.replaceAll('/','-'),'sessions',nativeId);await mkdir(storage,{recursive:true});
  const metadata=join(storage,'metadata.json');await writeFile(metadata,JSON.stringify({session_id:nativeId,working_dir:f.workspace,parent_id:null,title:'Startup'}));await writeFile(join(storage,'transcript.jsonl'),'');
  Object.assign(f.config.engines[0].env,{FIXTURE_STARTUP_NATIVE_ID:nativeId,FIXTURE_STARTUP_HINT:metadata});
  const client=await f.connect();f.reconstructionHook(async()=>{entered.release();await gate.promise;});rebuilding=f.host.rebuildConversationPresentation({commandId:'startup-repair',expectedRevision:0},actor);await entered.promise;
  await client.request('createSession',{channel:session,provider:'amplifier',workingDirectories:[pathToFileURL(f.workspace).href]});assert.equal((await f.host.inspectSession(session)).nativeSessionId,nativeId);assert.equal(f.hints(),0);assert.equal(f.host.diagnostics().catalogHints.pending,1);
  gate.release();assert.equal((await rebuilding).status,'completed');await until(()=>f.host.diagnostics().catalogHints.pending===0);assert.equal(f.hints(),1);
  assert.deepEqual((await f.catalog.list({connectionId:'startup',limit:50,allowedWorkspaceRoots:[f.workspace]})).items.map((row:any)=>row.uri),[session]);
 }finally{gate.release();await rebuilding?.catch(()=>{});await f.close();}
});


test('index loss reobserves missing retained source and restored changed metadata before ready',{skip:!python},async()=>{
 const f=await fixture(2);try{
  const missing=f.records[0],present=f.records[1];await f.host.inspectSession(missing.uri);
  const original=await f.apply(await f.review('hide-present',[present.uri]),'hide-present');assert.equal(original.projection.status,'ready');
  await rm(missing.storagePath,{recursive:true});await f.catalog.hint(missing.storagePath);assert.equal((await f.catalog.get(missing.uri)).availability,'read-only');
  await f.clearCatalog();await assert.rejects(f.host.withConversationCatalogRead(()=>f.catalog.list({connectionId:'product',limit:25,allowedWorkspaceRoots:[f.workspace]})),/unavailable/);
  const rebuilt=await f.host.rebuildConversationPresentation({commandId:'rebuild-missing',expectedRevision:1},actor);assert.equal(rebuilt.status,'completed');
  const listed=await f.host.withConversationCatalogRead(()=>f.catalog.list({connectionId:'product',limit:25,allowedWorkspaceRoots:[f.workspace]}));assert.deepEqual(listed.items,[]);
  const absent=await f.catalog.get(missing.uri);assert.equal(absent.nativeDeleted,false);assert.equal(absent.productHidden,false);assert.equal(absent.availability,'read-only');
  await mkdir(missing.storagePath,{recursive:true});await writeFile(join(missing.storagePath,'metadata.json'),JSON.stringify({session_id:missing.nativeSessionId,working_dir:f.workspace,parent_id:null,name:'Restored changed title',turn_count:1}));await writeFile(join(missing.storagePath,'transcript.jsonl'),'opaque restored native history');
  await f.clearCatalog();assert.equal((await f.host.rebuildConversationPresentation({commandId:'rebuild-restored',expectedRevision:1},actor)).status,'completed');
  const restored=await f.host.withConversationCatalogRead(()=>f.catalog.list({connectionId:'product',limit:25,allowedWorkspaceRoots:[f.workspace]}));assert.deepEqual(restored.items.map((row:any)=>row.uri),[missing.uri]);assert.equal(restored.items[0].title,'Restored changed title');assert.equal(restored.items[0].nativeDeleted,false);assert.equal(restored.items[0].productHidden,false);assert.equal((await f.catalog.get(present.uri)).productHidden,true);
  assert.deepEqual(f.host.readConversationPresentationEffectReceipt('hide-present'),original.effect);assert.equal(f.host.diagnostics().activeAgents,0);
  for(const [path,body]of f.files)if(path.startsWith(present.storagePath+'/'))assert.equal(await readFile(path,'utf8'),body);
 }finally{await f.close();}
});
