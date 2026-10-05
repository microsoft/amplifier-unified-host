import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {AhpClient} from '@microsoft/agent-host-protocol/client';
import {WebSocketTransport} from '@microsoft/agent-host-protocol/ws';
import {createHost,type HostConfig} from '../src/host.js';
import type {ServiceIdentity,QuiescenceConfig,ServiceReleaseProof} from '../src/quiescence.js';
const A:ServiceIdentity={installationId:'installation',dataScope:'owned-data',ownerId:'unit-owner',instanceId:'launch-A',releaseDigest:'digest-A'};
const B={...A,instanceId:'launch-B',releaseDigest:'digest-B'};
const wait=async(check:()=>unknown)=>{for(let n=0;n<1000;n++){if(check())return;await new Promise(r=>setTimeout(r,5));}throw Error('Fixture deadline');};
function lifecycle(identity=A):QuiescenceConfig{return {instanceId:identity.instanceId,dataScope:identity.dataScope,requiredOwners:['legacy-facade'],coverage:{},participants:[{id:'legacy-facade',acquire:async()=>{throw Error('Ordinary stop must not acquire facades');}}],timeoutMs:1000,verifyRelease:async()=>{throw Error('Generic release is not service authority');},serviceLifecycle:{identity,verifyRelease:async r=>({kind:'service-lifecycle',verified:true,fenceId:r.fenceId,commandId:r.commandId,serviceOutcome:r.outcome,outcome:r.outcome==='resumed'?'ready':'unchanged',expected:r.serviceIdentity!,observed:identity,instanceId:identity.instanceId,dataScope:identity.dataScope,receiptId:'authenticated-settlement',...(r.outcome==='resumed'?{resumeCommandId:r.resumeCommandId,exitReceiptId:'unit-A-exit',readyReceiptId:'unit-B-ready',activation:{schema:'distribution-service-activation-v1',target:{id:'B',version:'2',revision:'revision-B',digest:B.releaseDigest}}}:{refusalReceiptId:'no-stop-effect'})})}};}
async function client(host:any,id='owner'){const c=new AhpClient(await WebSocketTransport.connect(host.url));c.connect();await c.initialize({clientId:id,protocolVersions:['0.9.0']});return c;}
async function create(c:AhpClient,dir:string){const uri='ahp-session:/'+randomUUID();await c.request('createSession',{channel:uri,provider:'fixture',workingDirectories:[pathToFileURL(dir).href]});return uri;}
const peer=fileURLToPath(new URL('../fixtures/acp-peer.mjs',import.meta.url));

test('real Host admitted client-tool drain, scoped nested completion, closed A->B and immutable unrelated unknown',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'actual-service-drain-'));let host:any,c:AhpClient|undefined;let effects=0,projection=0;
 const base:HostConfig={stateDirectory:join(dir,'host'),allowedWorkspaceRoots:[dir],engines:[{id:'fixture',command:process.execPath,args:[peer]}],quiescence:lifecycle(),capabilities:{manifest:{version:1,topics:{fixture:{uri:'fixture://topic',version:1}},actions:{effect:{topic:'fixture',operation:'effect',method:'x-amplifier/capabilityAction'}}},read:async()=>({topic:'fixture',scope:'host',revision:1,data:{}}),action:async()=>{effects++;return {accepted:true};}},nativeHostRequest:async context=>{
  const result=await host.invokeClientTool(context.session,'owner','inspect',{});
  await host.invokeCapability({channel:context.session,topic:'fixture',operation:'effect',version:1,args:{},commandId:'accepted-native-effect'},{actorId:'agent:'+context.nativeSessionId,origin:'agent',session:context.session});
  await host.withAdmittedNativeContinuation(context,async()=>{await new Promise(r=>setImmediate(r));await host.commitSessionTitle(context.session,{commandId:'accepted-name'},async()=>{projection++;return {applied:true,title:'Settled accepted turn'};});});
  return result;
 }};
 try{
  // Initial A uses explicit fixture provisioning. This does not qualify pristine closed startup.
  host=await createHost(base);c=await client(host);const uri=await create(c,dir),old=await create(c,dir),chat=uri.replace('ahp-session:','ahp-chat:');await c.subscribe(uri);await c.subscribe(chat,{view:{turns:1}});
  host.store.admission(old.replace('ahp-session:','ahp-chat:'),{},'retained-unknown','prior',1);host.store.finish('retained-unknown','unknown');const before=JSON.stringify(host.store.receipt('retained-unknown'));
  c.dispatch(uri,{type:'session/activeClientSet',activeClient:{clientId:'owner',tools:[{name:'inspect',description:'Explicit owned tool'}]}} as any);await wait(()=>host.store.get(uri)?.state.activeClients.length===1);
  const turn='original-turn';await host.submitTurn(uri,{commandId:turn,text:'client-tool',clientId:'owner'});await wait(()=>host.clientTools.size===1);const [toolId]=host.clientTools.keys();
  const closed=await host.closeServiceIntake({commandId:'stop-A',expected:A});assert.equal(closed.admitted,true);assert.equal(closed.phase,'closed');assert.ok(closed.evidence.activeWork>0);assert.deepEqual(closed.fence.owners,[]);
  let drained=false;const pending=host.admitServiceStop({commandId:'stop-A',expected:A}).then((r:any)=>{drained=true;return r;});await new Promise(r=>setImmediate(r));assert.equal(drained,false);
  await assert.rejects(host.submitTurn(uri,{commandId:'new',text:'must not start',clientId:'owner'}),/intake is closed/);await assert.rejects(create(c,dir),/intake is closed/);await assert.rejects(host.nativeControl(uri,'configuration.apply',{}),/intake is closed/);
  await assert.rejects(host.submitScheduled(uri,{} as any),/intake is closed/);await assert.rejects(host.withExternalMutation('unregistered-composition',async()=>{}),/intake is closed/);
  await assert.rejects(host.invokeCapability({channel:uri,topic:'fixture',operation:'effect',version:1,args:{},commandId:'forged-scope'},{actorId:'agent:fake',origin:'agent',session:uri}),/intake is closed/);
  await c.request('listSessions',{channel:'ahp-root://',limit:1});assert.equal(host.store.receipt('original-turn').status,'dispatching');
  c.dispatch(chat,{type:'chat/toolCallComplete',turnId:'stale-turn',toolCallId:toolId,result:{success:true,pastTenseMessage:'forged'}} as any);await new Promise(r=>setTimeout(r,20));assert.equal(host.clientTools.size,1);assert.equal(drained,false);
  c.dispatch(chat,{type:'chat/toolCallComplete',turnId:turn,toolCallId:toolId,result:{success:true,pastTenseMessage:'Original completed'}} as any);
  const held=await pending;assert.equal(held.phase,'held');assert.equal(held.fenceId,closed.fenceId);assert.equal(held.evidence.activeWork,0);assert.equal(effects,1);assert.equal(projection,1);assert.equal(host.store.receipt(turn).status,'completed');assert.equal(JSON.stringify(host.store.receipt('retained-unknown')),before);assert.equal(host.diagnostics().activeAgents,2);
  await c.shutdown();c=undefined;await host.close();host=undefined;
  const next=lifecycle(B);let patch:Partial<ServiceReleaseProof>={};const verifier=next.serviceLifecycle!.verifyRelease;next.serviceLifecycle!.verifyRelease=async request=>({...await verifier(request),...patch});
  host=await createHost({...base,quiescence:next});c=await client(host);assert.equal(host.inspectServiceLifecycle().intakeClosed,true);await assert.rejects(create(c,dir),/intake is closed/);
  const release={fenceId:held.fenceId,commandId:'stop-A',outcome:'resumed' as const,resumeCommandId:'resume-B',evidence:{untrustedCallerClaims:'ignored by verifier'}};
  patch={observed:{...B,instanceId:'wrong-B'}};await assert.rejects(host.releaseServiceStop(release),/remains unknown/);
  patch={activation:{schema:'distribution-service-activation-v1',target:{id:'B',version:'2',revision:'revision-B',digest:A.releaseDigest}}};await assert.rejects(host.releaseServiceStop(release),/remains unknown/);assert.equal(host.inspectServiceLifecycle().intakeClosed,true);
  patch={};const opened=await host.releaseServiceStop(release);assert.equal(opened.released,true);assert.equal(host.inspectServiceLifecycle().intakeClosed,false);assert.deepEqual(await host.releaseServiceStop(release),opened);
  const unrelated=await create(c,dir);await host.submitTurn(unrelated,{commandId:'after-ready',text:'hello',clientId:'owner'});await host.waitForTurn(unrelated,'after-ready');assert.equal(JSON.stringify(host.store.receipt('retained-unknown')),before);
 }finally{await c?.shutdown();await host?.close();await rm(dir,{recursive:true,force:true});}
});

test('exact active approval drains ACP file effects while new controls stay closed, then authenticated refusal reopens',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'approval-service-drain-'));let host:any,c:AhpClient|undefined;
 try{host=await createHost({stateDirectory:join(dir,'host'),allowedWorkspaceRoots:[dir],engines:[{id:'fixture',command:process.execPath,args:[peer]}],quiescence:lifecycle()});c=await client(host);const uri=await create(c,dir),chat=uri.replace('ahp-session:','ahp-chat:');await c.subscribe(chat,{view:{turns:1}});
  await host.submitTurn(uri,{commandId:'approval-turn',text:'drain-approval',clientId:'owner'});await wait(()=>host.store.get(uri)?.state.inputNeeded?.length);
  const closed=await host.closeServiceIntake({commandId:'approval-stop',expected:A});const pending=host.admitServiceStop({commandId:'approval-stop',expected:A});
  c.dispatch(chat,{type:'chat/toolCallConfirmed',turnId:'forged',toolCallId:'tool-1',approved:true,selectedOptionId:'allow'} as any);await new Promise(r=>setTimeout(r,20));assert.equal(host.store.get(uri).state.inputNeeded.length,1);
  c.dispatch(chat,{type:'chat/toolCallConfirmed',turnId:'approval-turn',toolCallId:'tool-1',approved:true,selectedOptionId:'allow'} as any);const held=await pending;assert.equal(held.evidence.activeWork,0);assert.equal(held.fenceId,closed.fenceId);assert.equal(await readFile(join(dir,'admitted-approval.txt'),'utf8'),'accepted approval drained');
  await host.releaseServiceStop({fenceId:held.fenceId,commandId:'approval-stop',outcome:'stop-refused',evidence:{}});assert.equal(host.inspectServiceLifecycle().intakeClosed,false);
  await assert.rejects(host.withAdmittedNativeContinuation({session:uri,nativeSessionId:host.store.get(uri).nativeSessionId},async()=>{}),/Exact admitted/);
 }finally{await c?.shutdown();await host?.close();await rm(dir,{recursive:true,force:true});}
});

test('exact active cancellation drains without promoting durable waiting intents',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cancel-service-drain-'));let host:any,c:AhpClient|undefined;
 try{host=await createHost({stateDirectory:join(dir,'host'),allowedWorkspaceRoots:[dir],engines:[{id:'fixture',command:process.execPath,args:[peer]}],quiescence:lifecycle()});c=await client(host);const uri=await create(c,dir);
  await host.submitTurn(uri,{commandId:'running',text:'slow',clientId:'owner'});await host.updatePendingQueue(uri,{type:'chat/pendingMessageSet',kind:'queued',id:'saved-intent',message:{text:'keep my draft',origin:{kind:'user'}}},{clientId:'owner'});
  const closed=await host.closeServiceIntake({commandId:'cancel-stop',expected:A});assert.equal(closed.work.counts.pendingQueue,undefined);const pending=host.admitServiceStop({commandId:'cancel-stop',expected:A});
  await assert.rejects(host.interruptSession(uri,{commandId:'stale-cancel',turnId:'wrong',clientId:'owner'}),/intake is closed/);
  await host.interruptSession(uri,{commandId:'exact-cancel',turnId:'running',clientId:'owner'});const held=await pending;assert.equal(held.evidence.activeWork,0);assert.equal(host.store.receipt('running').status,'cancelled');assert.equal(host.diagnostics().pendingQueue.messages,1);assert.equal(host.store.receipt('saved-intent'),undefined);
 }finally{await c?.shutdown();await host?.close();await rm(dir,{recursive:true,force:true});}
});

test('drain timeout preserves the same closed fence without interrupting or clearing platform uncertainty',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'deadline-service-drain-'));let host:any,release!:()=>void;const gate=new Promise<void>(r=>release=r);let entered!:()=>void;const begun=new Promise<void>(r=>entered=r);
 try{const config=lifecycle();config.timeoutMs=25;host=await createHost({stateDirectory:join(dir,'host'),allowedWorkspaceRoots:[dir],engines:[{id:'fixture',command:'/must-not-start'}],quiescence:config});
  const running=host.withExternalMutation('trusted-job',async()=>{entered();await gate;});await begun;
  const closed=await host.closeServiceIntake({commandId:'deadline-stop',expected:A});const uncertain=await host.admitServiceStop({commandId:'deadline-stop',expected:A});assert.equal(uncertain.intakeClosed,true);assert.equal(uncertain.fence.phase,'unknown');assert.equal(uncertain.fence.fenceId,closed.fenceId);assert.equal(uncertain.fence.reason,'service-drain-unconfirmed');
  release();await running;const held=await host.admitServiceStop({commandId:'deadline-stop',expected:A});assert.equal(held.phase,'held');assert.equal(held.evidence.activeWork,0);assert.equal(held.fenceId,closed.fenceId);
  await host.releaseServiceStop({fenceId:held.fenceId,commandId:'deadline-stop',outcome:'unknown'});const preserved=await host.admitServiceStop({commandId:'deadline-stop',expected:A});assert.equal(preserved.fence.phase,'unknown');assert.equal(preserved.fence.reason,'service-owner-outcome-unknown');
 }finally{release();await host?.close();await rm(dir,{recursive:true,force:true});}
});
