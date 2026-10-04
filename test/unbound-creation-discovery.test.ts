import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,realpath,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {fileURLToPath,pathToFileURL} from 'node:url';
import {AhpClient} from '@microsoft/agent-host-protocol/client';import {WebSocketTransport} from '@microsoft/agent-host-protocol/ws';
const {createHost}=await import(process.env.HOST_PACKAGE?pathToFileURL(process.env.HOST_PACKAGE).href:'../src/host.js');
const actor={actorId:'fixture-owner',origin:'ui' as const};
async function fixture(){
 const directory=await realpath(await mkdtemp(join(process.env.HOST_UNBOUND_EVIDENCE??tmpdir(),'unbound-creation-'))),workspace=join(directory,'workspace');await mkdir(workspace);
 const checkpoint=join(directory,'possible-checkpoint.json'),calls=join(directory,'calls.txt'),known='ahp-session:/zz-known';
 const original={uri:known,engineId:'fixture',nativeSessionId:'confirmed-native',workingDirectory:workspace,title:'Known conversation',createdAt:'2026-01-01T00:00:00Z',modifiedAt:'2026-01-01T00:00:00Z'};
 const rows=new Map([[known,original]]),projections=new Map<string,any>(),revisions=new Map<string,number>();let reconstructCalls=0,failReconstruction=false;const manifests:any[]=[];
 const catalog={get:async(uri:string)=>rows.get(uri),upsert:async(row:any)=>{rows.set(row.uri,row);},list:async()=>({items:[...rows.values()].filter((row:any)=>!row.productHidden)}),status:async()=>({phase:'complete',issues:0}),
  sessionVisibilityProjectionStatus:async({source}:any)=>({source,revision:revisions.get(source)??0}),sessionVisibilityProjectionReceipt:async({source,commandId}:any)=>projections.get(source+commandId)??null,
  projectSessionVisibility:async(request:any)=>{assert.equal(request.afterRevision,revisions.get(request.source)??0);const result={source:request.source,commandId:request.commandId,revision:request.throughRevision,projected:request.items.length};revisions.set(request.source,result.revision);projections.set(request.source+request.commandId,result);return result;}};
 const config={stateDirectory:join(directory,'host'),allowedWorkspaceRoots:[workspace],catalog,engines:[{id:'fixture',command:process.execPath,args:[fileURLToPath(new URL('./fixtures/unbound-create-peer.mjs',import.meta.url))],env:{FIXTURE_CALLS:calls,FIXTURE_CHECKPOINT:checkpoint}}],
  conversationPresentation:{reconstructMetadata:async(request:any)=>{reconstructCalls++;if(failReconstruction)throw Error('Owned reconstruction reply lost');let cursor;const items=[];do{const page=request.readMappings(cursor);assert.ok(page.items.length<=100);items.push(...page.items);cursor=page.nextCursor;}while(cursor);manifests.push(items);for(const row of items)await catalog.upsert(row);}}};
 let host=await createHost(config);const clients:AhpClient[]=[];
 const connect=async()=>{const client=new AhpClient(await WebSocketTransport.connect(host.url));client.connect();await client.initialize({clientId:'fixture-'+clients.length,protocolVersions:['0.9.0']});clients.push(client);return client;};
 const createFailure=async(client:AhpClient,uri='ahp-session:/aa-unbound')=>{await assert.rejects(client.request('createSession',{channel:uri,provider:'fixture',workingDirectories:[pathToFileURL(workspace).href]}),/possible checkpoint/);return uri;};
 return {directory,workspace,checkpoint,calls,known,original,rows,manifests,connect,createFailure,get host(){return host;},reconstructCalls:()=>reconstructCalls,failReconstruction:(value:boolean)=>failReconstruction=value,
  restart:async()=>{for(const client of clients)await client.shutdown();clients.length=0;await host.close();host=await createHost(config);},
  close:async()=>{for(const client of clients)await client.shutdown();await host.close();if(!process.env.HOST_UNBOUND_EVIDENCE)await rm(directory,{recursive:true,force:true});}};
}
const retained=(host:any,uri:string)=>({row:host.store.db.prepare('SELECT * FROM sessions WHERE uri=?').get(uri),receipt:host.store.db.prepare('SELECT payload FROM receipts WHERE command_id=?').get('create:'+uri)});

test('failed ACP creation stays unknown while a new explicit reconstruction discovers confirmed mappings',async()=>{
 const f=await fixture();try{
  let client=await f.connect();await f.host.inspectSession(f.known);const uri=await f.createFailure(client),before=retained(f.host,uri),bytes=await readFile(f.checkpoint);
  assert.equal(before.row.native_id,null);assert.equal(before.row.native_location_revision,0);assert.equal(JSON.parse(before.row.state).lifecycle,'failed');assert.equal(JSON.parse(before.receipt.payload).status,'unknown');
  assert.deepEqual((await client.request('listSessions',{channel:'ahp-root://',limit:50})).items.map(row=>row.resource),[f.known]);
  f.failReconstruction(true);const prior=await f.host.rebuildConversationPresentation({commandId:'original-unconfirmed-rebuild',expectedRevision:0},actor);assert.equal(prior.status,'unknown');
  const oldRebuild=f.host.store.db.prepare('SELECT payload FROM presentation_rebuilds WHERE command_id=?').get(prior.commandId).payload;
  await assert.rejects(client.request('listSessions',{channel:'ahp-root://',limit:50}),/unavailable/);
  f.failReconstruction(false);const repaired=await f.host.rebuildConversationPresentation({commandId:'new-explicit-rebuild',expectedRevision:0},actor);assert.equal(repaired.status,'completed');assert.equal(repaired.count,1);
  assert.deepEqual(f.manifests.map(items=>items.map((row:any)=>row.uri)),[[f.known]]);assert.deepEqual(retained(f.host,uri),before);assert.equal(f.host.store.db.prepare('SELECT payload FROM presentation_rebuilds WHERE command_id=?').get(prior.commandId).payload,oldRebuild);
  assert.deepEqual((await client.request('listSessions',{channel:'ahp-root://',limit:50})).items.map(row=>row.resource),[f.known]);
  const snapshot=(await client.subscribe(uri)).result.snapshot!;assert.equal((snapshot.state as any).lifecycle,'failed');assert.match((snapshot.state as any).creationError.message,/possible checkpoint/);
  assert.equal((await client.request('x-commandReceipt',{commandId:'create:'+uri}) as any).status,'unknown');
  await assert.rejects(client.request('createSession',{channel:uri,provider:'fixture',workingDirectories:[pathToFileURL(f.workspace).href]}),/already exists/);
  await assert.rejects(f.host.submitTurn(uri,{commandId:'must-not-run',text:'no replay',clientId:'fixture'}),/creation has not completed/);assert.equal(f.host.store.receipt('must-not-run'),undefined);
  await f.restart();client=await f.connect();assert.deepEqual(retained(f.host,uri),before);assert.equal((await client.request('listSessions',{channel:'ahp-root://',limit:50})).items[0].resource,f.known);
  assert.equal(f.host.store.db.prepare('SELECT payload FROM presentation_rebuilds WHERE command_id=?').get(prior.commandId).payload,oldRebuild);assert.equal(f.host.diagnostics().activeAgents,0);
  assert.deepEqual(await readFile(f.checkpoint),bytes);assert.equal(await readFile(f.calls,'utf8'),'session/new\n');assert.equal(f.rows.has(uri),false,'No native mapping is guessed for the unbound host URI');
 }finally{await f.close();}
});

test('a bound native identity still refuses reconstruction when retained canonical metadata is missing',async()=>{
 const f=await fixture();try{await f.host.inspectSession(f.known);const before=f.host.store.get(f.known);f.host.store.db.prepare('DELETE FROM presentation_mappings WHERE session=?').run(f.known);
  const outcome=await f.host.rebuildConversationPresentation({commandId:'missing-bound-mapping',expectedRevision:0},actor);assert.equal(outcome.status,'unknown');assert.equal(f.reconstructCalls(),0);assert.deepEqual(f.host.store.get(f.known),before);assert.equal(f.host.inspectConversationPresentation().ready,false);
 }finally{await f.close();}
});

for(const alteration of ['missing-receipt','different-receipt-owner','different-receipt-channel','completed-receipt','dispatching-receipt','ready-lifecycle','location-revision'])test('unexplained missing mapping stays unavailable: '+alteration,async()=>{
 const f=await fixture();try{const client=await f.connect(),uri=await f.createFailure(client);
  if(alteration==='missing-receipt')f.host.store.db.prepare('DELETE FROM receipts WHERE command_id=?').run('create:'+uri);
  if(alteration==='different-receipt-owner')f.host.store.db.prepare('UPDATE receipts SET client_id=? WHERE command_id=?').run('unrelated-owner','create:'+uri);
  if(alteration==='different-receipt-channel')f.host.store.db.prepare('UPDATE receipts SET channel=? WHERE command_id=?').run('ahp-session:/different','create:'+uri);
  if(alteration==='completed-receipt')f.host.store.finish('create:'+uri,'completed');
  if(alteration==='dispatching-receipt')f.host.store.finish('create:'+uri,'dispatching');
  if(alteration==='ready-lifecycle')f.host.store.db.prepare("UPDATE sessions SET state=json_set(state,'$.lifecycle','ready') WHERE uri=?").run(uri);
  if(alteration==='location-revision')f.host.store.db.prepare('UPDATE sessions SET native_location_revision=1 WHERE uri=?').run(uri);
  const outcome=await f.host.rebuildConversationPresentation({commandId:'unexplained-mapping',expectedRevision:0},actor);assert.equal(outcome.status,'unknown');assert.equal(f.reconstructCalls(),0);
 }finally{await f.close();}
});

test('interrupted creation reservations page past an empty mapping page without inventing native identities',async()=>{
 const f=await fixture();try{
  await f.host.inspectSession(f.known);const client=await f.connect(),first=await f.createFailure(client),template=f.host.store.get(first)!;
  // Small owned journal fixtures model process loss before session/creationFailed publication.
  // They use the same host admission API and internal origin as ordinary and clone creation.
  f.host.store.db.prepare("UPDATE sessions SET state=json_set(state,'$.lifecycle','creating') WHERE uri=?").run(first);
  const saved=[];
  for(let index=0;index<100;index++){
   const uri='ahp-session:/ab-reserved-'+String(index).padStart(3,'0'),commandId='fixture-creation-'+index;
   const chat='ahp-chat:/'+uri.slice('ahp-session:/'.length);
   f.host.store.save({...template,uri,summary:{...template.summary,resource:uri},state:{...template.state,lifecycle:'creating',defaultChat:chat,chats:[]},chat:{...template.chat,resource:chat}});
   f.host.store.admission(uri,{kind:'session.create',params:{channel:uri}},commandId,'host:creation',f.host.store.extensionSequence('host:creation'));f.host.store.finish(commandId,'dispatching');saved.push({uri,commandId});
  }
  await f.restart();
  const originals=saved.map(({uri,commandId})=>({row:f.host.store.db.prepare('SELECT * FROM sessions WHERE uri=?').get(uri),receipt:f.host.store.receipt(commandId)}));
  assert.ok(originals.every(value=>value.receipt?.status==='unknown'));
  const query=f.host.store.db.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM receipts WHERE json_extract(payload,'$.status')='unknown' AND channel=? AND client_id='host:creation' LIMIT 1").all(first);
  assert.ok(query.some(row=>String(row.detail).includes('receipt_status_channel')),'Exact status/channel lookup uses the existing receipt index');
  const result=await f.host.rebuildConversationPresentation({commandId:'paged-rebuild',expectedRevision:0},actor);
  assert.equal(result.status,'completed');assert.equal(result.count,1);assert.deepEqual(f.manifests.map(items=>items.map((row:any)=>row.uri)),[[f.known]]);
  assert.deepEqual(saved.map(({uri,commandId})=>({row:f.host.store.db.prepare('SELECT * FROM sessions WHERE uri=?').get(uri),receipt:f.host.store.receipt(commandId)})),originals);
  assert.equal(await readFile(f.calls,'utf8'),'session/new\n');assert.equal(f.host.diagnostics().activeAgents,0);
 }finally{await f.close();}
});
