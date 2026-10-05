import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {AhpClient} from '@microsoft/agent-host-protocol/client';
import {WebSocketTransport} from '@microsoft/agent-host-protocol/ws';
import {createHost} from '../src/host.js';
import type {QuiescenceConfig,QuiescenceParticipant,ServiceIdentity,ServiceReleaseProof,ServiceLifecycleConfig} from '../src/quiescence.js';
const oldIdentity:ServiceIdentity={installationId:'installation-one',dataScope:'private-data',ownerId:'retained-process-owner',instanceId:'runtime-one',releaseDigest:'sha256:signed-release-one'};
const newIdentity:ServiceIdentity={...oldIdentity,instanceId:'runtime-two'};
const pause=()=>{let release!:()=>void;const promise=new Promise<void>(resolve=>release=resolve);return {promise,release};};
function config(identity=oldIdentity,owners:QuiescenceParticipant[]=[],verify?:ServiceLifecycleConfig['verifyRelease']):QuiescenceConfig {
 return {instanceId:identity.instanceId,dataScope:identity.dataScope,requiredOwners:owners.map(p=>p.id),participants:owners,coverage:{},timeoutMs:1000,
  verifyRelease:async()=>{throw Error('Generic update verifier must never authorize a service fence');},
  serviceLifecycle:{identity,verifyRelease:verify??(async r=>({verified:true,kind:'service-lifecycle',fenceId:r.fenceId,commandId:r.commandId,outcome:r.outcome==='resumed'?'ready':'unchanged',serviceOutcome:r.outcome,expected:r.serviceIdentity!,observed:identity,instanceId:identity.instanceId,dataScope:identity.dataScope,receiptId:'service-settlement',...(r.outcome==='resumed'?{resumeCommandId:r.resumeCommandId,exitReceiptId:'owned-child-exit',readyReceiptId:'authenticated-readiness'}:{refusalReceiptId:'verified-no-signal'})}))}};
}
async function fixture(quiescence=config(),stateDirectory?:string){
 const directory=stateDirectory??await mkdtemp(join(tmpdir(),'service-stop-'));
 const base={stateDirectory:join(directory,'host'),allowedWorkspaceRoots:[directory],engines:[{id:'fixture',command:process.execPath,args:[fileURLToPath(new URL('../fixtures/acp-peer.mjs',import.meta.url))]}]};
 let host=await createHost({...base,quiescence});const clients:AhpClient[]=[];
 const client=async()=>{const c=new AhpClient(await WebSocketTransport.connect(host.url));c.connect();await c.initialize({clientId:randomUUID(),protocolVersions:['0.9.0']});clients.push(c);return c;};
 // Retained legacy participant-fence fixtures exercise old release/reconciliation only.
 // They do not qualify the new ordinary shared-service admission path.
 return {directory,get host(){return host;},legacyStop:(input:any)=>(host as any).intake.admitBound({commandId:input.commandId,...(input.retryRefused===undefined?{}:{retryRefused:input.retryRefused}),purpose:'service-stop',serviceIdentity:input.expected}),client,create:async(c:AhpClient)=>{const channel='ahp-session:/'+randomUUID();await c.request('createSession',{channel,provider:'fixture',workingDirectories:[pathToFileURL(directory).href]});return channel;},restart:async(quiescence:QuiescenceConfig|undefined)=>{for(const c of clients)await c.shutdown();await host.close();host=await createHost({...base,quiescence});},close:async()=>{for(const c of clients)await c.shutdown();await host.close();await rm(directory,{recursive:true,force:true});}};
}

test('service stop authenticates every expected identity field and never borrows generic admission',async()=>{
 const f=await fixture();try{
  for(const key of Object.keys(oldIdentity))await assert.rejects(f.host.admitServiceStop({commandId:'stop',expected:{...oldIdentity,[key]:'foreign'}}),/exact configured/);
  await assert.rejects(f.host.admitQuiescence({commandId:'stop',purpose:'service-stop'} as any),/identity-bound/);
  assert.equal(f.host.inspectServiceLifecycle().intakeClosed,false);
  const admitted=await f.host.admitServiceStop({commandId:'stop',expected:oldIdentity});assert.equal(admitted.admitted,true);assert.equal(admitted.intakeClosed,true);assert.equal(admitted.purpose,'service-stop');assert.deepEqual(admitted.expected,oldIdentity);
  assert.deepEqual(f.host.serviceStopReceipt('stop'),admitted);
  assert.deepEqual(f.host.inspectServiceLifecycle().fence?.serviceIdentity,oldIdentity);
 }finally{await f.close();}
});

test('busy service stop records a known refusal, and only explicit same-identity retry may acquire after work settles',async()=>{
 const f=await fixture(config(oldIdentity,[{id:'fixture',serviceStop:{version:1},acquire:async c=>({ownerId:'fixture',fenceId:c.fenceId,release:async()=>{}})}])),gate=pause(),entered=pause();try{
  const pending=f.host.withExternalMutation('fixture',async()=>{entered.release();await gate.promise;});await entered.promise;
  const first=await f.legacyStop({commandId:'busy',expected:oldIdentity});assert.equal(first.admitted,false);assert.equal(first.executed,false);assert.equal(first.intakeClosed,false);assert.equal(first.purpose,'service-stop');
  gate.release();await pending;
  assert.deepEqual(await f.legacyStop({commandId:'busy',expected:oldIdentity}),first);
  const retry=await f.legacyStop({commandId:'busy',expected:oldIdentity,retryRefused:true});assert.equal(retry.admitted,true);assert.notEqual(retry.fenceId,first.fenceId);
 }finally{gate.release();await f.close();}
});

test('service acquisition closes all intake, keeps AHP reads available, and grants neither recovery maintenance nor generic release',async()=>{
 const entered=pause(),finish=pause();let releases=0;let acquired:any;
 const p:QuiescenceParticipant={id:'owner',serviceStop:{version:1},acquire:async c=>{acquired=structuredClone(c);entered.release();await finish.promise;return {ownerId:'owner',fenceId:c.fenceId,release:async(outcome,proof)=>{assert.equal(outcome,'unchanged');assert.equal((proof as ServiceReleaseProof).kind,'service-lifecycle');releases++;}};}};
 const f=await fixture(config(oldIdentity,[p]));try{
  const c=await f.client(),pending=f.legacyStop({commandId:'stop',expected:oldIdentity});await entered.promise;
  assert.equal(acquired.purpose,'service-stop');assert.deepEqual(acquired.serviceIdentity,oldIdentity);
  await assert.rejects(f.create(c),/intake is closed/);await c.request('listSessions',{channel:'ahp-root://',limit:1});
  finish.release();const held=await pending;
  await assert.rejects(f.host.withQuiescenceMaintenance({fenceId:held.fenceId,commandId:'stop'},async()=>{}),/Exact idle held/);
  await assert.rejects(f.host.releaseQuiescence({fenceId:held.fenceId,commandId:'stop',outcome:'unchanged'}),/service-specific/);
  await assert.rejects(f.host.releaseQuiescence({fenceId:held.fenceId,commandId:'stop',outcome:'unknown'}),/service-specific/);
  const release={fenceId:held.fenceId,commandId:'stop',outcome:'stop-refused' as const,evidence:{receipt:'verified-no-signal'}};
  const released=await f.host.releaseServiceStop(release);assert.equal(released.released,true);assert.equal(releases,1);
  assert.deepEqual(await f.host.releaseServiceStop(release),released);assert.equal(releases,1);
  await assert.rejects(f.host.releaseServiceStop({...release,evidence:{receipt:'changed'}}),/different arguments/);
 }finally{finish.release();await f.close();}
});

test('replacement must prove exact old and new identities plus durable exit/readiness; lost reply repeats no owner release',async()=>{
 let observed=newIdentity,patch:Partial<ServiceReleaseProof>={},released=0;
 const p:QuiescenceParticipant={id:'owner',serviceStop:{version:1},acquire:async c=>({ownerId:'owner',fenceId:c.fenceId,release:async()=>{throw Error('Old process lease is unavailable');}}),reconcileRelease:async c=>{assert.deepEqual(c.serviceIdentity,oldIdentity);assert.equal((c.proof as ServiceReleaseProof).kind,'service-lifecycle');released++;}};
 const f=await fixture(config(oldIdentity,[p]));try{
  const held=await f.legacyStop({commandId:'stop',expected:oldIdentity});
  const next=config(newIdentity,[p]);const baseVerify=next.serviceLifecycle!.verifyRelease;next.serviceLifecycle!.verifyRelease=async r=>({...await baseVerify(r),observed,...patch});
  await f.restart(next);assert.equal(f.host.inspectServiceLifecycle().fence?.phase,'unknown');await assert.rejects(f.create(await f.client()),/intake is closed/);
  const input={fenceId:held.fenceId,commandId:'stop',outcome:'resumed' as const,resumeCommandId:'resume',evidence:{ownerReceipt:'durable-confirmed-exit-and-ready'}};
  for(const key of Object.keys(newIdentity)){observed={...newIdentity,[key]:'foreign'};await assert.rejects(f.host.releaseServiceStop(input),/remains unknown/);}
  observed=newIdentity;
  for(const invalid of [{kind:'update'},{exitReceiptId:undefined},{readyReceiptId:undefined},{resumeCommandId:'different'},{expected:{...oldIdentity,ownerId:'foreign'}}]){patch=invalid as any;await assert.rejects(f.host.releaseServiceStop(input),/remains unknown/);}
  assert.equal(released,0);patch={};const result=await f.host.releaseServiceStop(input);assert.equal(result.released,true);assert.equal(released,1);assert.equal(f.host.inspectServiceLifecycle().intakeClosed,false);
  await f.restart(next);assert.deepEqual(await f.host.releaseServiceStop(input),result);assert.equal(released,1);
  patch={readyReceiptId:'contradictory-proof'};await assert.rejects(f.host.releaseServiceStop(input),/retained proof/);assert.equal(f.host.inspectServiceLifecycle().intakeClosed,false);assert.equal(released,1);
  await assert.rejects(f.host.releaseServiceStop({...input,outcome:'unknown'}),/cannot be changed/);
 }finally{await f.close();}
});

test('uncertain participant release persists exact accepted proof and refuses a changed settlement after restart',async()=>{
 let attempts=0,proofPatch:Partial<ServiceReleaseProof>={};
 const p:QuiescenceParticipant={id:'owner',serviceStop:{version:1},acquire:async c=>({ownerId:'owner',fenceId:c.fenceId,release:async()=>{attempts++;throw Error('Ack lost after owner released');}}),reconcileRelease:async()=>{attempts++;}};
 const configuration=config(oldIdentity,[p]);const baseVerify=configuration.serviceLifecycle!.verifyRelease;configuration.serviceLifecycle!.verifyRelease=async r=>({...await baseVerify(r),...proofPatch});
 const f=await fixture(configuration);try{
  const held=await f.legacyStop({commandId:'stop',expected:oldIdentity});const input={fenceId:held.fenceId,commandId:'stop',outcome:'stop-refused' as const,evidence:{receipt:'no-effect'}};
  await assert.rejects(f.host.releaseServiceStop(input),/remains unknown/);assert.equal(attempts,1);
  await f.restart(configuration);proofPatch={refusalReceiptId:'changed-proof'};await assert.rejects(f.host.releaseServiceStop(input),/remains unknown/);assert.equal(attempts,1);
  proofPatch={};await f.host.releaseServiceStop(input);assert.equal(attempts,2);assert.equal(f.host.inspectServiceLifecycle().intakeClosed,false);
 }finally{await f.close();}
});

test('known partial acquisition refusal unwinds only the same live leases; unknown or missing service configuration stays closed',async()=>{
 let rollbacks=0;
 const owners:QuiescenceParticipant[]=[{id:'one',serviceStop:{version:1},acquire:async c=>({ownerId:'one',fenceId:c.fenceId,release:async(outcome,proof)=>{assert.equal(outcome,'unchanged');assert.deepEqual(proof,{kind:'admission-refused'});rollbacks++;}})},{id:'two',serviceStop:{version:1},acquire:async()=>null}];
 const f=await fixture(config(oldIdentity,owners));try{const refused=await f.legacyStop({commandId:'busy-owner',expected:oldIdentity});assert.equal(refused.executed,false);assert.equal(refused.intakeClosed,false);assert.equal(rollbacks,1);}finally{await f.close();}
 const uncertain=await fixture();try{const held=await uncertain.legacyStop({commandId:'lost-stop',expected:oldIdentity});await uncertain.host.releaseServiceStop({fenceId:held.fenceId,commandId:'lost-stop',outcome:'unknown'});await uncertain.restart(undefined);assert.equal(uncertain.host.inspectServiceLifecycle().intakeClosed,true);assert.equal(uncertain.host.inspectServiceLifecycle().enabled,false);await assert.rejects(uncertain.host.releaseServiceStop({fenceId:held.fenceId,commandId:'lost-stop',outcome:'stop-refused'}),/not configured/);}finally{await uncertain.close();}
});

test('actual host process death retains service fence and no replacement admission is possible before exact proof',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'service-stop-crash-'));const hostModule=process.env.HOST_MODULE??pathToFileURL(fileURLToPath(new URL('../src/host.ts',import.meta.url))).href;
 const code=`import {createHost} from ${JSON.stringify(hostModule)}; const identity=${JSON.stringify(oldIdentity)}; const host=await createHost({stateDirectory:${JSON.stringify(join(directory,'host'))},allowedWorkspaceRoots:[${JSON.stringify(directory)}],engines:[{id:'fixture',command:'/unavailable-never-started'}],quiescence:{instanceId:identity.instanceId,dataScope:identity.dataScope,requiredOwners:[],participants:[],coverage:{},verifyRelease:async()=>{throw Error('Never');},serviceLifecycle:{identity,verifyRelease:async()=>{throw Error('Never');}}}}); const held=await host.admitServiceStop({commandId:'crash-stop',expected:identity}); process.send(held);`;
 const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',code],{stdio:['ignore','ignore','pipe','ipc']});let errors='';child.stderr!.on('data',d=>errors+=d);
 try{
  const held:any=await Promise.race([once(child,'message').then(([m])=>m),once(child,'exit').then(()=>{throw Error('Child exited before admission: '+errors);})]);assert.equal(held.admitted,true);child.kill('SIGKILL');await once(child,'exit');
  const f=await fixture(config(newIdentity),directory);try{assert.equal(f.host.inspectServiceLifecycle().fence?.phase,'unknown');await assert.rejects(f.create(await f.client()),/intake is closed/);await f.host.releaseServiceStop({fenceId:held.fenceId,commandId:'crash-stop',outcome:'resumed',resumeCommandId:'resume-after-crash',evidence:{fixtureOwnedExit:true}});assert.equal(f.host.inspectServiceLifecycle().intakeClosed,false);}finally{await f.close();}
 }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit');}await rm(directory,{recursive:true,force:true});}
});

 test('every declared execution owner must explicitly support service identity before any owner acquisition',async()=>{
 let acquisitions=0;const owners:QuiescenceParticipant[]=[{id:'modern',serviceStop:{version:1},acquire:async()=>{acquisitions++;return null;}},{id:'legacy',acquire:async()=>{acquisitions++;return null;}}];
 const f=await fixture(config(oldIdentity,owners));try{const result=await f.legacyStop({commandId:'unsupported-owner',expected:oldIdentity});assert.equal(result.admitted,false);assert.equal(result.executed,false);assert.equal(result.intakeClosed,false);assert.equal(result.reason,'service-stop-coverage-unavailable');assert.deepEqual(result.work.gaps,['legacy']);assert.equal(acquisitions,0);}finally{await f.close();}
});
