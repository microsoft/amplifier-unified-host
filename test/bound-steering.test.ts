import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {AhpClient} from '@microsoft/agent-host-protocol/client';
import {WebSocketTransport} from '@microsoft/agent-host-protocol/ws';
import {createHost} from '../src/host.js';
const capability={version:1,mode:'request_boundary',cancellable:false};
const wait=async(check:()=>boolean)=>{for(let n=0;n<200;n++){if(check())return;await new Promise(r=>setTimeout(r,5));}assert.fail('fixture condition did not arrive');};
const message=(id:string,turnId:unknown)=>({type:'chat/pendingMessageSet',kind:'steering',id,message:{text:'Bound correction',origin:{kind:'user'},_meta:{sibling:{keep:true},'amplifier.dev/steering':{activeTurnId:turnId,note:'retain'}}}} as any);
async function fixture(report:unknown,wrongTurn=false){
 const dir=await mkdtemp(join(tmpdir(),'bound-steering-')),peer=join(dir,'peer.mjs'),log=join(dir,'native.log');
 let source=await readFile(new URL('../fixtures/acp-peer.mjs',import.meta.url),'utf8');
 source=source.replace('let permissionId=1000;', 'let permissionId=1000;let releaseTurn;');
 source=source.replace("else if(message.method==='_amplifier/native'&&p.operation==='fixture.worker.idle')", "else if(message.method==='_amplifier/native'&&p.operation==='fixture.release-turn'){releaseTurn?.();releaseTurn=undefined;reply(message.id,{});}\n  else if(message.method==='_amplifier/native'&&p.operation==='fixture.report'){send({method:'_amplifier/event',params:{sessionId:p.sessionId,event:p.args}});reply(message.id,{});}\n  else if(message.method==='_amplifier/native'&&p.operation==='fixture.worker.idle')");
 source=source.replace('const turn=active;', "const turn=active;if(text==='fixture-held')await new Promise(resolve=>releaseTurn=resolve);");
 source=source.replace('activeInputId:active.inputId}}};', "activeInputId:"+(wrongTurn?"'wrong-input'":"active.inputId")+(report===undefined?'':',activeSteering:'+JSON.stringify(report))+'}}};');
 await writeFile(peer,source);
 const host=await createHost({stateDirectory:join(dir,'host'),allowedWorkspaceRoots:[dir],engines:[{id:'fixture',command:process.execPath,args:[peer],env:{FIXTURE_LOG:log}}]});
 const client=new AhpClient(await WebSocketTransport.connect(host.url));client.connect();const init=await client.initialize({clientId:'owner',protocolVersions:['0.9.0']});
 const session='ahp-session:/bound',chat='ahp-chat:/bound';await client.request('createSession',{channel:session,provider:'fixture',workingDirectories:[pathToFileURL(dir).href]});
 let closed=false;
 const events:any[]=[];for(const channel of [session,chat]){const sub=await client.subscribe(channel);void(async()=>{for await(const event of sub.subscription)if(event.type==='action')events.push(event.params);})();}
 const mount=()=>host.store.get(session)?.state._meta?.['amplifier.dev/host']?.activeSteering as any;
 return {events,setClosed(){closed=true;},dir,host,client,init,session,chat,log,mount,async start(id:string){await host.submitTurn(session,{commandId:id,text:'fixture-held',clientId:'owner'});await wait(()=>host.store.get(session)?.chat.activeTurn?.id===id);await new Promise(r=>setTimeout(r,20));},async finish(id:string){await host.nativeControl(session,'fixture.release-turn',{});await host.waitForTurn(session,id);await wait(()=>!(host as any).active.get(session)?.busy);},async close(){if(closed){await rm(dir,{recursive:true,force:true});return;}try{await host.nativeControl(session,'fixture.release-turn',{});}catch{}await client.shutdown();await host.close();await rm(dir,{recursive:true,force:true});}};
}

test('optional binding rejects captured A after B begins, without replacing retained standard input',async()=>{
 const f=await fixture(capability);try{
  assert.deepEqual((f.init as any)._meta['amplifier.dev/host'].boundSteering,{version:1,messageMetaKey:'amplifier.dev/steering',turnIdField:'activeTurnId'});
  await f.start('A');await wait(()=>f.mount()?.supported===true);const captured=message('captured-A','A');
  await f.finish('A');assert.equal(f.mount().supported,false);
  await f.host.updatePendingQueue(f.session,{type:'chat/pendingMessageSet',kind:'steering',id:'standard-future',message:{text:'Future correction',origin:{kind:'user'}}} as any,{clientId:'owner'});
  const before=JSON.stringify(f.host.store.db.prepare("SELECT * FROM steering_intents WHERE id='standard-future'").get());
  await assert.rejects(f.host.updatePendingQueue(f.session,captured,{clientId:'owner'}),/captured active turn changed/);assert.equal(JSON.stringify(f.host.store.db.prepare("SELECT * FROM steering_intents WHERE id='standard-future'").get()),before);
  await f.start('B');await wait(()=>f.mount()?.supported===true);await assert.rejects(f.host.updatePendingQueue(f.session,captured,{clientId:'owner'}),/captured active turn changed/);
  assert.equal(f.host.store.receipt('captured-A'),undefined);assert.equal(f.host.store.db.prepare("SELECT count(*) n FROM steering_intents WHERE id='captured-A'").get()!.n,0);
  const sent=await readFile(f.log+'.steering','utf8');assert.ok(!sent.includes('captured-A'));assert.ok(sent.includes('standard-future'),'standard idle input still reaches next turn');
  await f.finish('B');
 }finally{await f.close();}
});

test('malformed opt-in is refused; concurrent current corrections retain binding and sibling metadata',async()=>{
 const f=await fixture(capability);try{
  await f.start('current');await wait(()=>f.mount()?.supported===true);
  for(const value of [undefined,'',null,{},'x'.repeat(129)])await assert.rejects(f.host.updatePendingQueue(f.session,message('invalid',value),{clientId:'owner'}),/bounded captured activeTurnId/);
  for(const value of [null,[],false,'bad']){const invalid=message('invalid-namespace','current');invalid.message._meta['amplifier.dev/steering']=value;await assert.rejects(f.host.updatePendingQueue(f.session,invalid,{clientId:'owner'}),/bounded captured activeTurnId/);}
  for(const id of ['one','two'])f.client.dispatch(f.chat,message(id,'current'));
  await wait(()=>['one','two'].every(id=>f.host.store.receipt(id)?.status==='completed'));
  for(const id of ['one','two']){const row=f.host.store.db.prepare('SELECT message,active_turn_id,generation_id FROM steering_intents WHERE id=?').get(id)!;const saved=JSON.parse(String(row.message));assert.deepEqual(saved._meta.sibling,{keep:true});assert.deepEqual(saved._meta['amplifier.dev/steering'],{activeTurnId:'current',note:'retain'});assert.equal(row.active_turn_id,'current');assert.equal(row.generation_id,f.mount().generationId);}
  await wait(()=>['one','two'].every(id=>f.events.some(e=>e.action.type==='chat/pendingMessageSet'&&e.action.id===id&&!e.rejectionReason)));
  for(const id of ['one','two']){const echo=f.events.find(e=>e.action.type==='chat/pendingMessageSet'&&e.action.id===id&&!e.rejectionReason).action.message._meta;assert.deepEqual(echo.sibling,{keep:true});assert.deepEqual(echo['amplifier.dev/steering'],{activeTurnId:'current',note:'retain',held:false});}
  assert.ok(f.events.some(e=>e.action.type==='session/metaChanged'&&e.action._meta?.['amplifier.dev/host']?.activeSteering?.supported===true));
  await f.finish('current');assert.equal(f.mount().supported,false);
 }finally{await f.close();}
});

for(const [name,report,wrong] of [['missing',undefined,false],['negative',{...capability,supported:false},false],['mode',{version:1,mode:'other'},false],['mismatched-input',capability,true]] as const){
 test(`protocol advertisement does not become mounted support: ${name}`,async()=>{const f=await fixture(report,wrong);try{await f.start('input');assert.equal(f.mount().supported,false);assert.equal((f.host.store.get(f.session)?.state._meta?.['amplifier.dev/acp'] as any).capabilities._meta['amplifier.dev/native'].activeSteering.version,1);await f.finish('input');}finally{await f.close();}});
}

test('only matching generation end clears mounted evidence; restart cannot reuse saved support',async()=>{
 const f=await fixture(capability);try{
  await f.start('input');await wait(()=>f.mount()?.supported===true);const generation=f.mount().generationId;
  await f.host.nativeControl(f.session,'fixture.report',{type:'generation.finished',generation_id:'wrong'});assert.equal(f.mount().supported,true);
  await f.host.nativeControl(f.session,'fixture.report',{type:'generation.finished',generation_id:generation});await wait(()=>f.mount()?.supported===false);
  await f.host.nativeControl(f.session,'fixture.report',{type:'generation.started',generation_id:generation,activeInputId:'input',activeSteering:capability});await wait(()=>f.mount()?.supported===true);
  await f.finish('input');
  // Simulate retained metadata from a prior lifetime; no runtime/report is mounted at replacement startup.
  const record=f.host.store.get(f.session)!;record.state._meta={...record.state._meta,retainedSibling:{keep:true},'amplifier.dev/host':{retainedHostSibling:{keep:true},activeSteering:{version:1,supported:true,activeTurnId:'old',generationId:'old'}}};f.host.store.save(record);
  await f.client.shutdown();await f.host.close();f.setClosed();
  const restarted=await createHost({stateDirectory:join(f.dir,'host'),allowedWorkspaceRoots:[f.dir],engines:[{id:'fixture',command:process.execPath,args:[join(f.dir,'peer.mjs')]}]});
  try{const metadata=restarted.store.get(f.session)?.state._meta;assert.deepEqual(metadata?.['amplifier.dev/host']?.activeSteering,{version:1,supported:false});assert.deepEqual(metadata?.retainedSibling,{keep:true});assert.deepEqual(metadata?.['amplifier.dev/host']?.retainedHostSibling,{keep:true});}finally{await restarted.close();}
 }finally{await f.close();}
});


test('unconsumed bound metadata survives turn end and restart without becoming current',async()=>{
 const f=await fixture(capability,true);try{
  await f.start('A');await f.host.updatePendingQueue(f.session,message('retained','A'),{clientId:'owner'});
  assert.equal(f.host.store.receipt('retained'),undefined);await f.finish('A');
  const ended=f.host.store.get(f.session)!.chat.steeringMessage!.message._meta as any;
  assert.deepEqual(ended.sibling,{keep:true});assert.deepEqual(ended['amplifier.dev/steering'],{activeTurnId:'A',note:'retain',held:true,reason:'target-turn-ended'});
  await f.client.shutdown();await f.host.close();f.setClosed();
  const restarted=await createHost({stateDirectory:join(f.dir,'host'),allowedWorkspaceRoots:[f.dir],engines:[{id:'fixture',command:process.execPath,args:[join(f.dir,'peer.mjs')]}]});
  const client=new AhpClient(await WebSocketTransport.connect(restarted.url));client.connect();try{
   await client.initialize({clientId:'cold',protocolVersions:['0.9.0']});const snapshot=(await client.subscribe(f.chat)).result.snapshot!.state as any;
   assert.deepEqual(snapshot.steeringMessage.message._meta.sibling,{keep:true});assert.deepEqual(snapshot.steeringMessage.message._meta['amplifier.dev/steering'],{activeTurnId:'A',note:'retain',held:true,reason:'host-restarted'});
   assert.equal(restarted.store.receipt('retained'),undefined);assert.equal(restarted.diagnostics().activeAgents,0);
  }finally{await client.shutdown();await restarted.close();}
 }finally{await f.close();}
});


test('stale opt-in cannot replace a pending standard message at admission',async()=>{
 const f=await fixture(capability);try{
  await f.start('A');const captured=message('old-bound','A');await f.finish('A');
  await f.host.updatePendingQueue(f.session,{type:'chat/pendingMessageSet',kind:'steering',id:'keep-standard',message:{text:'Retained future input',origin:{kind:'user'}}} as any,{clientId:'owner'});
  const prior=JSON.stringify(f.host.store.db.prepare("SELECT * FROM steering_intents WHERE id='keep-standard'").get());
  await assert.rejects(f.host.updatePendingQueue(f.session,captured,{clientId:'owner'}),/captured active turn changed/);
  assert.equal(JSON.stringify(f.host.store.db.prepare("SELECT * FROM steering_intents WHERE id='keep-standard'").get()),prior);
 }finally{await f.close();}
});
