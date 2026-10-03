import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {AhpClient} from '@microsoft/agent-host-protocol/client';
import {WebSocketTransport} from '@microsoft/agent-host-protocol/ws';
import {createHost} from '../src/host.js';
import type {QuiescenceConfig,QuiescenceParticipant} from '../src/quiescence.js';
const pause=()=>{let release!:()=>void;const promise=new Promise<void>(resolve=>release=resolve);return {promise,release};};
const until=async(predicate:()=>unknown)=>{for(let n=0;n<300;n++){if(predicate())return;await new Promise(r=>setTimeout(r,5));}throw Error('Condition unavailable');};
function configuration(extra:Partial<QuiescenceConfig>={}):QuiescenceConfig{return {instanceId:'launch-one',dataScope:'private-data',requiredOwners:[],coverage:{},participants:[],timeoutMs:1000,verifyRelease:async request=>({verified:true,fenceId:request.fenceId,commandId:request.commandId,outcome:request.outcome,instanceId:'launch-one',dataScope:'private-data',receiptId:'trusted-supervisor-no-restart'}),...extra};}
async function fixture(options:any={}){
 const directory=await mkdtemp(join(tmpdir(),'host-quiescence-')),log=join(directory,'native.log');
 const config={stateDirectory:join(directory,'host'),allowedWorkspaceRoots:[directory],engines:[{id:'fixture',command:process.execPath,args:[fileURLToPath(new URL('../fixtures/acp-peer.mjs',import.meta.url))],env:{FIXTURE_LOG:log,...options.env}}],quiescence:configuration(),...options};delete config.env;
 let host=await createHost(config);const clients:AhpClient[]=[];
 const connect=async()=>{const client=new AhpClient(await WebSocketTransport.connect(host.url));client.connect();await client.initialize({clientId:randomUUID(),protocolVersions:['0.9.0']});clients.push(client);return client;};
 const create=async(client:AhpClient)=>{const session='ahp-session:/'+randomUUID();await client.request('createSession',{channel:session,provider:'fixture',workingDirectories:[pathToFileURL(directory).href]});return session;};
 return {directory,log,config,get host(){return host;},connect,create,restart:async(next:any)=>{for(const c of clients)await c.shutdown();await host.close();host=await createHost({...config,...next});},close:async()=>{for(const c of clients)await c.shutdown();await host.close();await rm(directory,{recursive:true,force:true});}};
}
function participant(id:string,extra:Partial<QuiescenceParticipant>={}):QuiescenceParticipant{return {id,acquire:async c=>({ownerId:id,fenceId:c.fenceId,release:async()=>{}}),...extra};}

test('zero viewers does not imply idle: active turns and native-owned background work refuse retirement',async()=>{
 const f=await fixture();try{
  const client=await f.connect(),session=await f.create(client),commandId=randomUUID();await f.host.submitTurn(session,{commandId,text:'slow',clientId:'owner'});await client.shutdown();
  const busy=await f.host.admitQuiescence({commandId:'during-turn',purpose:'distribution-update'});assert.equal(busy.admitted,false);assert.equal(busy.intakeClosed,false);assert.ok(busy.work.counts.activeTurns>0);
  await f.host.waitForTurn(session,commandId);await f.host.nativeControl(session,'fixture.background.start',{});await new Promise(r=>setTimeout(r,20));const before=(await readFile(f.log+'.background','utf8')).length;
  const background=await f.host.admitQuiescence({commandId:'background',purpose:'distribution-update'});assert.equal(background.admitted,false);assert.equal(background.reason,'native-owned-work');assert.equal(f.host.inspectQuiescence().intakeClosed,false);
  await new Promise(r=>setTimeout(r,30));assert.ok((await readFile(f.log+'.background','utf8')).length>before);assert.equal(f.host.diagnostics().activeAgents,1);
  await f.host.nativeControlExisting(session,'fixture.background.stop',{});const lease=await f.host.admitQuiescence({commandId:'quiet',purpose:'distribution-update'});assert.equal(lease.admitted,true);assert.equal(f.host.diagnostics().activeAgents,0);
  assert.deepEqual(lease.evidence,{activeWork:0,intakeClosed:true,instanceId:'launch-one',dataScope:'private-data',observedAt:lease.evidence.observedAt});
  await f.host.releaseQuiescence({fenceId:lease.fenceId,commandId:'quiet',outcome:'unchanged',evidence:{receipt:'no-restart'}});
 }finally{await f.close();}
});

test('closed intake precedes participant acquisition and blocks public writes while reads and reconnect remain usable',async()=>{
 const acquiring=pause(),entered=pause();let effects=0;
 const owner=participant('owner',{acquire:async context=>{entered.release();await acquiring.promise;return {ownerId:'owner',fenceId:context.fenceId,release:async()=>{}};}});
 const f=await fixture({quiescence:configuration({requiredOwners:['owner'],coverage:{capabilities:{fixture:'owner'},resources:{fixture:'owner'}},participants:[owner]}),capabilities:{manifest:{version:1,topics:{fixture:{uri:'fixture://topic',version:1}},actions:{effect:{topic:'fixture',operation:'effect',method:'x-amplifier/capabilityAction'}}},read:async()=>({topic:'fixture',scope:'host',revision:1,data:{ready:true}}),action:async()=>{effects++;return {accepted:true};}},resourceProviders:[{scheme:'fixture',write:async()=>{effects++;return {bytesWritten:1};}}]});
 try{
  const client=await f.connect(),session=await f.create(client);const admitted=f.host.admitQuiescence({commandId:'atomic-gate',purpose:'recovery'});await entered.promise;
  assert.equal(f.host.inspectQuiescence().fence?.phase,'checking');
  await assert.rejects(f.host.submitTurn(session,{commandId:'blocked',text:'Never execute',clientId:'user'}),/intake is closed/);
  await assert.rejects(f.host.nativeControl(session,'fixture.background.start',{}),/intake is closed/);
  await assert.rejects(f.host.withExternalMutation('owner',async()=>{effects++;}),/intake is closed/);
  await assert.rejects(client.request('createSession',{channel:'ahp-session:/'+randomUUID(),provider:'fixture',workingDirectories:[pathToFileURL(f.directory).href]}),/intake is closed/);
  await assert.rejects(client.request('resourceWrite' as any,{channel:'ahp-root://',uri:'fixture://body',data:'x'} as any),/intake is closed/);
  await assert.rejects(client.request('x-amplifier/capabilityAction' as any,{channel:'ahp-root://',topic:'fixture',version:1,operation:'effect',args:{},commandId:'never'} as any),/intake is closed/);
  await client.request('listSessions',{channel:'ahp-root://',limit:50});await client.request('resourceRead',{channel:'ahp-root://',uri:'fixture://topic',encoding:'utf-8'});await client.subscribe(session);
  const reconnect=new AhpClient(await WebSocketTransport.connect(f.host.url));reconnect.connect();try{await reconnect.reconnect({clientId:randomUUID(),lastSeenServerSeq:0,subscriptions:['ahp-root://']});}finally{await reconnect.shutdown();}
  assert.equal(effects,0);acquiring.release();const lease=await admitted;assert.equal(lease.admitted,true);
  assert.deepEqual(await f.host.admitQuiescence({commandId:'atomic-gate',purpose:'recovery'}),lease);
  await f.host.releaseQuiescence({fenceId:lease.fenceId,commandId:'atomic-gate',outcome:'unchanged'});
  await f.host.withExternalMutation('owner',async()=>{effects++;});assert.equal(effects,1);
 }finally{acquiring.release();await f.close();}
});

test('in-flight native admin/owner effects and missing owner coverage cannot be called idle',async()=>{
 const gate=pause(),entered=pause();const f=await fixture({quiescence:configuration({requiredOwners:['native-admin'],participants:[participant('native-admin')]})});try{
  const work=f.host.withExternalMutation('native-admin',async()=>{entered.release();await gate.promise;});await entered.promise;
  const result=await f.host.admitQuiescence({commandId:'admin-active',purpose:'recovery'});assert.equal(result.admitted,false);assert.equal(result.work.counts.admissions,1);gate.release();await work;
 }finally{gate.release();await f.close();}
 const missing=await fixture({capabilities:{manifest:{version:1,topics:{hidden:{uri:'hidden://topic',version:1}},actions:{job:{topic:'hidden',operation:'job',method:'x-amplifier/capabilityAction'}}},read:async()=>({topic:'hidden',scope:'host',revision:1,data:{}}),action:async()=>({accepted:true})}});try{const result=await missing.host.admitQuiescence({commandId:'missing-coverage',purpose:'recovery'});assert.equal(result.admitted,false);assert.deepEqual(result.work.gaps,['uncovered-capability:hidden']);assert.equal(missing.host.inspectQuiescence().intakeClosed,false);}finally{await missing.close();}
});

test('pending user input is retained and refuses restart; generic resident engines require atomic lifecycle coverage',async()=>{
 const f=await fixture();try{
  const client=await f.connect(),session=await f.create(client);
  const running=randomUUID();await f.host.submitTurn(session,{commandId:running,text:'slow',clientId:'user'});
  await f.host.updatePendingQueue(session,{type:'chat/pendingMessageSet',kind:'queued',id:'saved-intent',message:{text:'Preserve pending work',origin:{kind:'user'}}},{clientId:'user'});
  await f.host.interruptSession(session,{commandId:'stop-before-queued-input',turnId:running,clientId:'user'});await f.host.waitForTurn(session,running);
  const result=await f.host.admitQuiescence({commandId:'queued',purpose:'distribution-update'});assert.equal(result.admitted,false);assert.equal(result.work.counts.pendingQueue,1);assert.equal(f.host.diagnostics().pendingQueue.messages,1);
 }finally{await f.close();}
 const generic=await fixture({env:{FIXTURE_NO_RETIRE:'1'}});try{await generic.create(await generic.connect());const result=await generic.host.admitQuiescence({commandId:'unsupported',purpose:'recovery'});assert.equal(result.admitted,false);assert.ok(result.work.gaps.includes('resident-agent-has-no-atomic-retirement'));assert.equal(generic.host.diagnostics().activeAgents,1);}finally{await generic.close();}
});

test('lost native retirement acknowledgement retains an unknown durable gate without force-killing the peer',async()=>{
 const f=await fixture({env:{FIXTURE_RETIRE_LOST:'1',FIXTURE_RETIRE_CALLBACK:'1'},quiescence:configuration({timeoutMs:50})});try{
  await f.create(await f.connect());const result=await f.host.admitQuiescence({commandId:'lost-retirement',purpose:'recovery'});assert.equal(result.admitted,false);assert.equal(result.fence.phase,'unknown');assert.equal(f.host.diagnostics().activeAgents,1);assert.match(await readFile(f.log+'.retired','utf8'),/without acknowledgement/);
  const callback=JSON.parse((await readFile(f.log+'.late-write','utf8')).trim());assert.match(callback.error.message,/intake is closed/);assert.equal(callback.error.data.executed,false);await assert.rejects(readFile(join(f.directory,'blocked-native-write')),{code:'ENOENT'});
  await assert.rejects(async()=>f.host.withExternalMutation('unlisted',async()=>{}));assert.equal(f.host.inspectQuiescence().intakeClosed,true);
 }finally{await f.close();}
});

test('restart preserves the fence and only exact authenticated new-instance proof releases recovered owner gates',async()=>{
 let acquired=0,reconciled=0;
 const p=participant('owner',{acquire:async c=>{acquired++;return {ownerId:'owner',fenceId:c.fenceId,release:async()=>{}};},reconcileRelease:async proof=>{assert.equal(proof.outcome,'ready');reconciled++;}});
 const f=await fixture({quiescence:configuration({requiredOwners:['owner'],participants:[p]})});try{
  const lease=await f.host.admitQuiescence({commandId:'replace',purpose:'distribution-update'});assert.equal(lease.admitted,true);
  await f.host.releaseQuiescence({fenceId:lease.fenceId,commandId:'replace',outcome:'unknown'});assert.equal(f.host.inspectQuiescence().fence?.phase,'unknown');
  let valid=false;
  await f.restart({quiescence:configuration({instanceId:'launch-two',requiredOwners:['owner'],participants:[p],verifyRelease:async request=>({verified:true,fenceId:request.fenceId,commandId:request.commandId,outcome:request.outcome,instanceId:valid?'launch-two':'forged-launch',dataScope:'private-data',receiptId:'durable-ready-receipt'})})});
  const client=await f.connect();await client.request('listSessions',{channel:'ahp-root://',limit:50});await assert.rejects(f.create(client),/intake is closed/);
  await assert.rejects(f.host.releaseQuiescence({fenceId:lease.fenceId,commandId:'different',outcome:'ready'}),/Exact current/);
  await assert.rejects(f.host.releaseQuiescence({fenceId:lease.fenceId,commandId:'replace',outcome:'ready',evidence:{assertedReady:true}}),/remains unknown/);
  assert.equal(reconciled,0);valid=true;await f.host.releaseQuiescence({fenceId:lease.fenceId,commandId:'replace',outcome:'ready',evidence:{receiptId:'durable-ready-receipt'}});
  assert.equal(reconciled,1);assert.equal(acquired,1);assert.equal(f.host.inspectQuiescence().intakeClosed,false);assert.equal(f.host.quiescenceReceipt('replace').outcome,'ready');await f.create(client);
 }finally{await f.close();}
});

test('a lost participant acquisition stays fenced, and removing quiescence configuration does not silently reopen intake',async()=>{
 const f=await fixture({quiescence:configuration({requiredOwners:['voice'],participants:[participant('voice',{acquire:async()=>{throw Error('Owner may have closed intake before connection loss');}})]})});try{
  const result=await f.host.admitQuiescence({commandId:'uncertain-owner',purpose:'recovery'});assert.equal(result.fence.phase,'unknown');
  await f.restart({quiescence:undefined});assert.equal(f.host.inspectQuiescence().enabled,false);assert.equal(f.host.inspectQuiescence().intakeClosed,true);await assert.rejects(f.create(await f.connect()),/intake is closed/);
 }finally{await f.close();}
});

test('completed turns wake a waiting supervisor after settlement without a polling loop',async()=>{
 let wake=0;const f=await fixture({quiescence:configuration({onMayBeIdle:()=>{wake++;}})});try{
  const client=await f.connect(),session=await f.create(client),commandId=randomUUID();await f.host.submitTurn(session,{commandId,text:'slow',clientId:'user'});
  const result=await f.host.admitQuiescence({commandId:'waiting-turn',purpose:'distribution-update'});assert.equal(result.admitted,false);const before=wake;
  await f.host.waitForTurn(session,commandId);await until(()=>wake>before);assert.ok(wake>before);
 }finally{await f.close();}
});

test('trusted maintenance is exact-fence exclusive, cannot reopen normal admissions, and cannot be released in flight',async()=>{
 const f=await fixture();const entered=pause(),finish=pause();try{
  const lease=await f.host.admitQuiescence({commandId:'snapshot',purpose:'recovery'});assert.equal(lease.admitted,true);
  await assert.rejects(f.host.withQuiescenceMaintenance({fenceId:'foreign',commandId:'snapshot'},async()=>{}),/Exact idle held/);
  const work=f.host.withQuiescenceMaintenance({fenceId:lease.fenceId,commandId:'snapshot'},async()=>{
   await assert.rejects(f.host.submitTurn('ahp-session:/unloaded',{commandId:'never',text:'Not maintenance',clientId:'user'}),/intake is closed/);entered.release();await finish.promise;return {captured:true};
  });await entered.promise;
  assert.equal(f.host.inspectQuiescence().activeMaintenance,1);await assert.rejects(f.host.releaseQuiescence({fenceId:lease.fenceId,commandId:'snapshot',outcome:'unchanged'}),/still running/);
  finish.release();assert.deepEqual(await work,{captured:true});await f.host.releaseQuiescence({fenceId:lease.fenceId,commandId:'snapshot',outcome:'unchanged'});
  const next=await f.host.admitQuiescence({commandId:'uncertain-snapshot',purpose:'recovery'});
  await assert.rejects(f.host.withQuiescenceMaintenance({fenceId:next.fenceId,commandId:'uncertain-snapshot'},async()=>{throw Error('Lost native effect acknowledgement');}),/Lost native/);
  assert.equal(f.host.inspectQuiescence().fence?.phase,'unknown');await assert.rejects(f.host.withQuiescenceMaintenance({fenceId:next.fenceId,commandId:'uncertain-snapshot'},async()=>{}),/Exact idle held/);
 }finally{finish.release();await f.close();}
});

test('detached work cannot reuse an admission scope after its initiating operation returns',async()=>{
 let late:Promise<unknown>|undefined;const start=pause(),f=await fixture({quiescence:configuration({requiredOwners:['owner'],participants:[participant('owner')]})});try{
  await f.host.withExternalMutation('owner',async()=>{late=start.promise.then(()=>f.host.withExternalMutation('owner',async()=>{throw Error('Must not execute');}));});
  const lease=await f.host.admitQuiescence({commandId:'after-admission',purpose:'recovery'});assert.equal(lease.admitted,true);start.release();await assert.rejects(late!,/intake is closed/);
 }finally{start.release();await f.close();}
});

test('explicit receipt and reconciliation actions remain available behind held or unknown intake without granting nested mutation rights',async()=>{
 let effects=0;let host:any;
 const f=await fixture({quiescence:configuration({requiredOwners:['recovery'],coverage:{capabilities:{recovery:'recovery'}},participants:[participant('recovery')]}),capabilities:{manifest:{version:1,topics:{recovery:{uri:'recovery://topic',version:1}},actions:{status:{topic:'recovery',operation:'status',method:'x-amplifier/capabilityAction'},receipt:{topic:'recovery',operation:'looksLikeMutation',method:'x-amplifier/capabilityAction'},reconcile:{topic:'recovery',operation:'reconcile',method:'x-amplifier/capabilityAction'}}},quiescenceAccess:{receipt:'read',reconcile:'reconcile'},read:async()=>({topic:'recovery',scope:'host',revision:1,data:{}}),action:async(request:any)=>{
  if(request.operation==='status'){effects++;return {accepted:true};}
  if(request.operation==='reconcile')return {accepted:true,result:await host.releaseQuiescence({...request.args,outcome:'unchanged'})};
  await assert.rejects(host.withExternalMutation('recovery',async()=>{effects++;}),/intake is closed/);
  return {accepted:true,result:host.quiescenceReceipt(request.args.commandId)};
 }}});host=f.host;
 try{
  const client=await f.connect(),lease=await host.admitQuiescence({commandId:'inspect-recovery',purpose:'recovery'});
  const call=(operation:string,args:any)=>client.request('x-amplifier/capabilityAction' as any,{channel:'ahp-root://',topic:'recovery',operation,version:1,commandId:randomUUID(),args} as any) as Promise<any>;
  const held=await call('looksLikeMutation',{commandId:'inspect-recovery'});assert.equal(held.result.admitted,true);
  await assert.rejects(call('status',{}),/intake is closed/);assert.equal(effects,0);
  await host.releaseQuiescence({fenceId:lease.fenceId,commandId:lease.commandId,outcome:'unknown'});
  const unknown=await call('looksLikeMutation',{commandId:'inspect-recovery'});assert.equal(unknown.result.fence.phase,'unknown');
  const result=await call('reconcile',{fenceId:lease.fenceId,commandId:lease.commandId});assert.equal(result.result.released,true);
  await call('status',{});assert.equal(effects,1);
 }finally{await f.close();}
});

test('known busy owner unwinds only confirmed leases; uncertain release keeps the durable gate',async()=>{
 for(const uncertain of [false,true]){
  let released=0;
  const first=participant('one',{acquire:async context=>({ownerId:'one',fenceId:context.fenceId,release:async(outcome,proof)=>{released++;assert.equal(outcome,'unchanged');assert.deepEqual(proof,{kind:'admission-refused'});if(uncertain)throw Error('Release acknowledgement lost');}})});
  const f=await fixture({quiescence:configuration({requiredOwners:['one','two'],participants:[first,participant('two',{acquire:async()=>null})]})});try{
   const result=await f.host.admitQuiescence({commandId:'busy-owner',purpose:'recovery'});assert.equal(released,1);assert.equal(result.admitted,false);assert.equal(result.intakeClosed,uncertain);if(uncertain)assert.equal(result.fence.phase,'unknown');else assert.equal(result.executed,false);
  }finally{await f.close();}
 }
});


test('an ACP terminal that outlives its prompt remains owned work, even with zero viewers',async()=>{
 const f=await fixture();try{
  const client=await f.connect(),session=await f.create(client),commandId=randomUUID();await f.host.submitTurn(session,{commandId,text:'terminal-background',clientId:'owner'});await f.host.waitForTurn(session,commandId);await client.shutdown();
  const result=await f.host.admitQuiescence({commandId:'terminal-owned',purpose:'distribution-update'});assert.equal(result.admitted,false);assert.equal(result.work.counts.terminalJobs,1);assert.equal(f.host.diagnostics().activeAgents,1);assert.equal(f.host.inspectQuiescence().intakeClosed,false);
 }finally{await f.close();}
});

test('explicit retryRefused rechecks a known no-effect busy result under the same command and never replays held or unknown admission',async()=>{
 let acquired=0;const entered=pause(),done=pause();const f=await fixture({quiescence:configuration({requiredOwners:['owner'],participants:[participant('owner',{acquire:async context=>{acquired++;return {ownerId:'owner',fenceId:context.fenceId,release:async()=>{}}}})]})});
 try{
  const work=f.host.withExternalMutation('owner',async()=>{entered.release();await done.promise});await entered.promise;
  const command={commandId:'same-durable-update',purpose:'distribution-update' as const};const busy=await f.host.admitQuiescence(command);assert.equal(busy.executed,false);assert.equal(busy.intakeClosed,false);assert.equal(acquired,0);done.release();await work;
  assert.deepEqual(await f.host.admitQuiescence(command),busy);assert.equal(acquired,0);
  const held=await f.host.admitQuiescence({...command,retryRefused:true});assert.equal(held.admitted,true);assert.notEqual(held.fenceId,busy.fenceId);assert.equal(acquired,1);
  assert.deepEqual(await f.host.admitQuiescence({...command,retryRefused:true}),held);assert.equal(acquired,1);
  const unknown=await f.host.releaseQuiescence({fenceId:held.fenceId,commandId:command.commandId,outcome:'unknown'});assert.deepEqual(await f.host.admitQuiescence({...command,retryRefused:true}),unknown);assert.equal(acquired,1);
  await assert.rejects(f.host.admitQuiescence({...command,purpose:'recovery',retryRefused:true}),/different arguments/);
  const released=await f.host.releaseQuiescence({fenceId:held.fenceId,commandId:command.commandId,outcome:'unchanged'});assert.deepEqual(await f.host.admitQuiescence({...command,retryRefused:true}),released);assert.equal(acquired,1);
 }finally{done.release();await f.close();}
});

test('composite native callback coverage holds actual owners without inventing a router participant',async()=>{
 const acquired:string[]=[];const owners=['operations','resources'].map(id=>participant(id,{acquire:async context=>{acquired.push(id);return {ownerId:id,fenceId:context.fenceId,release:async()=>{}}}}));
 const f=await fixture({nativeHostRequest:async()=>({}),nativeEvent:async()=>{},quiescence:configuration({coverage:{nativeHostOwners:['operations','resources']},participants:owners})});
 try{const lease=await f.host.admitQuiescence({commandId:'composite-native',purpose:'recovery'});assert.equal(lease.admitted,true);assert.deepEqual(acquired,['operations','resources']);}finally{await f.close();}
 const missing=await fixture({nativeEvent:async()=>{},quiescence:configuration({coverage:{nativeHostOwners:['resources']}})});
 try{const result=await missing.host.admitQuiescence({commandId:'missing-native-authority',purpose:'recovery'});assert.equal(result.admitted,false);assert.deepEqual(result.work.gaps,['resources']);}finally{await missing.close();}
});
