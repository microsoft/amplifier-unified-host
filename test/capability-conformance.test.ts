import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {AhpClient} from '@microsoft/agent-host-protocol/client';
import {WebSocketTransport} from '@microsoft/agent-host-protocol/ws';
const {createHost}=await import(process.env.CONFORMANCE_HOST_ENTRY?pathToFileURL(process.env.CONFORMANCE_HOST_ENTRY).href:'../src/host.js');
const ROOT='ahp-root://';
function configuration(directory:string,calls:any[]){return {stateDirectory:directory,allowedWorkspaceRoots:[directory],engines:[{id:'unused',command:'/must-not-start'}],capabilities:{manifest:{version:1 as const,topics:{global:{uri:'fixture://global',version:1,scope:'host' as const},selected:{uri:'fixture://selected',version:1,scope:'context' as const}},actions:{global:{topic:'global',operation:'effect',method:'x-amplifier/capabilityAction'},selected:{topic:'selected',operation:'effect',method:'x-amplifier/capabilityAction'}}},read:async(request:any)=>{calls.push({read:request});return {...request,revision:0,data:{}};},action:async(request:any,context:any)=>{calls.push({action:request,context});return {accepted:true};}}};}
async function connect(host:any){const client=new AhpClient(await WebSocketTransport.connect(host.url));client.connect();await client.initialize({clientId:'conformance',protocolVersions:['0.9.0']});return client;}
const action=(commandId:string,topic='global',channel=ROOT)=>({channel,topic,operation:'effect',version:1,args:{},commandId});

test('host-only topic authority is enforced before admission for client and native callers',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'ahp-topic-authority-')),calls:any[]=[],host=await createHost(configuration(directory,calls)),client=await connect(host);
 try{
  for(const native of [false,true]){
   const request=action('wrong-'+native,'global','ahp-session:/not-authorized');
   await assert.rejects(native?host.invokeCapability(request,{actorId:'native-owner',origin:'agent'}):client.request('x-amplifier/capabilityAction' as any,request as any),/root channel/);
   await assert.rejects(client.request('x-commandReceipt' as any,{channel:ROOT,commandId:request.commandId} as any),/not found/);
  }
  assert.equal(calls.length,0);await client.request('x-amplifier/capabilityAction' as any,action('root-valid') as any);await host.invokeCapability(action('context-root','selected'),{actorId:'native-owner',origin:'agent'});
  assert.equal(calls.length,2);assert.equal(calls[1].context.actorId,'native-owner');assert.equal(host.diagnostics().activeAgents,0);
 }finally{await client.shutdown();await host.close();await rm(directory,{recursive:true,force:true});}
});

test('capability reads and watches require one explicit scope and respect host-only topics',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'ahp-topic-scope-')),calls:any[]=[],host=await createHost(configuration(directory,calls)),client=await connect(host);
 try{
  for(const suffix of ['', '?scope=', '?scope=host&scope=host', '?scope=host&scope=ahp-session%3A%2Fx','?scope=%2Fprivate','?scope=ahp-session%3A%2Fx']){
   for(const method of ['resourceRead','createResourceWatch'])await assert.rejects(client.request(method as any,{channel:ROOT,uri:'fixture://global'+suffix,encoding:'utf-8'} as any),/scope/);
  }
  assert.equal(calls.length,0);
  for(const [topic,scope] of [['global','host'],['selected','host'],['selected','ahp-session:/selected']]){
   const uri='fixture://'+topic+'?scope='+encodeURIComponent(scope),result:any=await client.request('resourceRead',{channel:ROOT,uri,encoding:'utf-8'});assert.equal(JSON.parse(result.data).scope,scope);
   const watch:any=await client.request('createResourceWatch',{channel:ROOT,uri});assert.ok(watch.channel);
  }
  assert.equal(calls.length,3);assert.equal(host.diagnostics().activeAgents,0);
 }finally{await client.shutdown();await host.close();await rm(directory,{recursive:true,force:true});}
});

test('new command IDs obey the published bound without truncation; legacy durable receipts survive restart',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'ahp-command-conformance-')),calls:any[]=[];let host=await createHost(configuration(directory,calls)),client=await connect(host);
 const legacy=['l'.repeat(257),'z'.repeat(512)];
 try{
  // Simulate receipts durably admitted by the previous host release. No effect is
  // replayed or inferred while opening these legacy records with the new host.
  for(const id of legacy){host.store.transaction(()=>host.store.admission(ROOT,action(id),id,'conformance',host.store.extensionSequence('conformance')));host.store.finish(id,'unknown','Legacy response was lost');}
  await client.shutdown();await host.close();host=await createHost(configuration(directory,calls));client=await connect(host);
  for(const id of legacy){const receipt:any=await client.request('x-commandReceipt' as any,{channel:ROOT,commandId:id} as any);assert.equal(receipt.commandId,id);assert.equal(receipt.status,'unknown');await assert.rejects(host.invokeCapability(action(id),{actorId:'conformance'}),/256/);}
  const valid='a'.repeat(256);await client.request('x-amplifier/capabilityAction' as any,action(valid) as any);
  for(const id of ['',valid+'b']){await assert.rejects(client.request('x-amplifier/capabilityAction' as any,action(id) as any),/256/);await assert.rejects(client.request('x-commandReceipt' as any,{channel:ROOT,commandId:id} as any),/not found/);}
  assert.equal(calls.length,1);assert.equal(calls[0].action.commandId,valid);const receipt:any=await client.request('x-commandReceipt' as any,{channel:ROOT,commandId:valid} as any);assert.equal(receipt.status,'completed');
  const unicode='🧪'.repeat(256);await host.invokeCapability(action(unicode),{actorId:'conformance'});assert.equal(calls[1].action.commandId,unicode);await assert.rejects(host.invokeCapability(action(unicode+'x'),{actorId:'conformance'}),/256/);
 }finally{await client.shutdown();await host.close();await rm(directory,{recursive:true,force:true});}
});

test('trusted native origin survives a root-scoped action without accepting client session claims',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'ahp-native-capability-origin-')),calls:any[]=[],config=configuration(directory,calls),one='ahp-session:/one',two='ahp-session:/two';
 const rows=new Map([one,two].map(uri=>[uri,{uri,engineId:'unused',nativeSessionId:uri.slice('ahp-session:/'.length),workingDirectory:directory,title:uri,createdAt:new Date().toISOString(),modifiedAt:new Date().toISOString(),status:'historical',kind:'root',availability:'available',workspaceAvailability:'present'}]));
 const host=await createHost({...config,catalog:{list:async()=>({items:[...rows.values()]}),get:async(uri:string)=>rows.get(uri)??null,upsert:async(record:any)=>record} as any}),client=await connect(host);
 try{
  await host.invokeCapability({...action('native-root'),args:{sessionId:one}},{actorId:'native:one',origin:'agent',session:one});assert.equal(calls[0].context.session.uri,one);
  await host.invokeCapability({...action('native-foreign-args'),args:{sessionId:two}},{actorId:'native:one',origin:'agent',session:one});assert.equal(calls[1].context.session.uri,one,'Arguments cannot replace authenticated native origin; the owner validates its own selector');
  for(const actor of [{actorId:'ui',origin:'ui' as const,session:one},{actorId:'unspecified',session:one}])await assert.rejects(host.invokeCapability(action('bad-'+actor.actorId),actor),/trusted agent/);
  await assert.rejects(host.invokeCapability(action('foreign-channel','selected',two),{actorId:'native:one',origin:'agent',session:one}),/differs/);
  await assert.rejects(client.request('x-commandReceipt' as any,{channel:ROOT,commandId:'foreign-channel'} as any),/not found/);
  await client.request('x-amplifier/capabilityAction' as any,{...action('client-claim'),args:{sessionId:one},actor:{origin:'agent',session:one},session:one} as any);assert.equal(calls[2].context.session,undefined);assert.equal(calls[2].context.origin,'ui');
  await host.invokeCapability(action('native-context','selected',one),{actorId:'native:one',origin:'agent',session:one});assert.equal(calls[3].context.session.uri,one);assert.equal(host.diagnostics().activeAgents,0);
 }finally{await client.shutdown();await host.close();await rm(directory,{recursive:true,force:true});}
});
