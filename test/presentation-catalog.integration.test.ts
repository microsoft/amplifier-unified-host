import {spawn} from 'node:child_process';
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {fileURLToPath,pathToFileURL} from 'node:url';
import {AhpClient} from '@microsoft/agent-host-protocol/client';import {WebSocketTransport} from '@microsoft/agent-host-protocol/ws';
import {createHost as sourceHost} from '../src/host.js';import {StdioCatalog as SourceCatalog} from '../src/catalog.js';
const python=process.env.PRESENTATION_CATALOG_PYTHON;
const api=process.env.HOST_PACKAGE?await import(pathToFileURL(process.env.HOST_PACKAGE).href):{createHost:sourceHost,StdioCatalog:SourceCatalog};
const actor={actorId:'reviewer',origin:'ui' as const};
const pause=()=>{let release!:()=>void;const promise=new Promise<void>(r=>release=r);return {promise,release};};
const waitScan=async(c:any)=>{const prior=(await c.status()).runId;await c.request('scan',{});for(let i=0;i<500;i++){const result=await c.status();if(result.phase==='complete'&&result.runId!==prior){assert.equal(result.issues,0);return;}if(result.phase==='failed')throw Error(JSON.stringify(result));await new Promise(r=>setTimeout(r,10));}throw Error('Metadata discovery did not finish');};
async function fixture(count:number,engineFixture=false){
 const directory=await realpath(await mkdtemp(join(tmpdir(),'presentation-installed-'))),home=join(directory,'native'),workspace=join(directory,'workspace'),index=join(directory,'catalog.sqlite'),log=join(directory,'prompts.jsonl'),history=join(directory,'history.json');await mkdir(workspace);await mkdir(home);
 await writeFile(history,JSON.stringify([{id:'retained-turn',state:'complete',updates:[{sessionUpdate:'user_message_chunk',content:{type:'text',text:'Retained canonical user'},_meta:{'amplifier.dev/history':{messageId:'retained-user',inputOrigin:'unknown'}}},{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Retained canonical answer'},_meta:{'amplifier.dev/history':{messageId:'retained-answer'}}}]}]));
 const files=new Map<string,string>(),records:any[]=[];for(let i=0;i<count;i++){
  const nativeId='native-'+i,session='ahp-session:/stable-'+i,storagePath=join(home,'projects',workspace.replaceAll('/','-'),'sessions',nativeId);await mkdir(storagePath,{recursive:true});
  for(const [name,body] of Object.entries({'metadata.json':JSON.stringify({session_id:nativeId,working_dir:workspace,parent_id:null,title:'Retained '+i}),'transcript.jsonl':'{"role":"user","content":"retained canonical input"}\n','events.jsonl':'retained opaque audit bytes\n'})){const path=join(storagePath,name);await writeFile(path,body);files.set(path,body);}
  records.push({uri:session,engineId:'amplifier',nativeSessionId:nativeId,workingDirectory:workspace,storagePath,title:'Retained '+i,kind:'root',createdAt:'2026-01-01T00:00:00Z',modifiedAt:'2026-01-01T00:00:00Z',workspaceAvailability:'present'});
 }
 const launch=()=>new api.StdioCatalog({command:python!,args:['-I',fileURLToPath(new URL('../fixtures/catalog-no-history.py',import.meta.url)),'serve','--db',index,'--home',home,'--scan-interval','0','--workspace-check-interval','0']});let catalog=launch();for(const record of records)await catalog.upsert(record);await waitScan(catalog);
 let calls=0,loseAt=0,failBefore=false,getHook:undefined|((id:string)=>Promise<void>);let host:any;
 const wrapper:any={list:(p:any)=>catalog.list(p),get:async(id:string)=>{await getHook?.(id);return catalog.get(id);},upsert:(r:any)=>catalog.upsert(r),status:()=>catalog.status(),sessionVisibilityProjectionStatus:(p:any)=>catalog.sessionVisibilityProjectionStatus(p),sessionVisibilityProjectionReceipt:(p:any)=>catalog.sessionVisibilityProjectionReceipt(p),projectSessionVisibility:async(p:any)=>{calls++;if(calls===loseAt&&failBefore)throw Error('Before real catalog projection');const result=await catalog.projectSessionVisibility(p);if(calls===loseAt)throw Error('Lost real catalog reply');return result;}};
 const config:any={stateDirectory:join(directory,'host'),allowedWorkspaceRoots:[workspace],catalog:wrapper,engines:[{id:'amplifier',command:engineFixture?process.execPath:'/must-never-start-during-presentation',...(engineFixture?{args:[fileURLToPath(new URL('../fixtures/acp-peer.mjs',import.meta.url))],env:{FIXTURE_LOG:log,FIXTURE_HISTORY:history}}:{})}],
  conversationPresentation:{reconstructMetadata:async(request:any)=>{let cursor;do{const page=request.readMappings(cursor);assert.ok(page.items.length<=100);for(const record of page.items)await catalog.upsert(record);cursor=page.nextCursor;}while(cursor);await waitScan(catalog);}},
 };
 const clients:AhpClient[]=[];host=await api.createHost(config);
 const connect=async()=>{const c=new AhpClient(await WebSocketTransport.connect(host.url));c.connect();await c.initialize({clientId:'viewer-'+clients.length,protocolVersions:['0.9.0']});clients.push(c);return c;};
 const review=(commandId:string,ids=records.map(r=>r.uri),operation='reset',resetCommandId?:string)=>host.prepareConversationPresentation({commandId,operation,selection:{kind:'explicit',sessionIds:ids},...(resetCommandId?{resetCommandId}:{})},actor);
 const apply=(r:any,commandId:string)=>host.applyConversationPresentation({commandId,reviewId:r.reviewId,reviewHash:r.reviewHash},actor);
 return {directory,records,files,log,workspace,config,get host(){return host;},get catalog(){return catalog;},connect,review,apply,calls:()=>calls,fail:(at:number,before=false)=>{loseAt=at;failBefore=before;},hook:(fn?:typeof getHook)=>getHook=fn,
  restart:async()=>{for(const c of clients)await c.shutdown().catch(()=>{});await host.close();host=await api.createHost(config);},
  clearCatalog:async()=>{await catalog.close();for(const suffix of ['', '-wal','-shm'])await rm(index+suffix,{force:true});catalog=launch();},
  crashApply:async(review:any,killAt:number,after:boolean)=>{
   for(const c of clients)await c.shutdown().catch(()=>{});await host.close();
   const input=join(directory,'crash.json');await writeFile(input,JSON.stringify({stateDirectory:config.stateDirectory,workspace,index,home,review,killAt,after,actor,python}));
   const outcome=await new Promise<any>((resolve,reject)=>{const child=spawn(process.execPath,[fileURLToPath(new URL('../fixtures/presentation-crash.mjs',import.meta.url)),input],{env:process.env,stdio:['ignore','ignore','pipe']});let error='';child.stderr.on('data',chunk=>error+=chunk);child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal,error}));});assert.equal(outcome.signal,'SIGKILL',outcome.error);host=await api.createHost(config);
  },
  verify:async()=>{for(const [path,body] of files)assert.equal(await readFile(path,'utf8'),body);},
  close:async()=>{for(const c of clients)await c.shutdown().catch(()=>{});await host?.close();await catalog.close();await rm(directory,{recursive:true,force:true});}};
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
