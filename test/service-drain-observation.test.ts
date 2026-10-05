import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {AhpClient} from '@microsoft/agent-host-protocol/client';
import {WebSocketTransport} from '@microsoft/agent-host-protocol/ws';
import {createHost,type HostConfig} from '../src/host.js';
import {QuiescenceGate,type QuiescenceConfig,type ServiceIdentity} from '../src/quiescence.js';

const A:ServiceIdentity={installationId:'installation',dataScope:'owned-data',ownerId:'unit-owner',instanceId:'launch-A',releaseDigest:'same-release'};
const B={...A,instanceId:'launch-B'};
const pause=()=>{let release!:()=>void;const promise=new Promise<void>(r=>release=r);return {promise,release};};
function lifecycle(identity=A):QuiescenceConfig{return {instanceId:identity.instanceId,dataScope:identity.dataScope,requiredOwners:[],coverage:{},participants:[],verifyRelease:async()=>{throw Error('Generic proof is not service authority');},serviceLifecycle:{identity,verifyRelease:async r=>({kind:'service-lifecycle',verified:true,fenceId:r.fenceId,commandId:r.commandId,serviceOutcome:r.outcome,outcome:r.outcome==='resumed'?'ready':'unchanged',expected:r.serviceIdentity!,observed:identity,instanceId:identity.instanceId,dataScope:identity.dataScope,receiptId:'authenticated-fixture-settlement',...(r.outcome==='resumed'?{resumeCommandId:r.resumeCommandId,exitReceiptId:'fixture-A-exit',readyReceiptId:'fixture-B-ready'}:{refusalReceiptId:'fixture-no-stop-effect'})})}};}
async function fixture(callback:NonNullable<HostConfig['turnSettled']>,quiescence=lifecycle()){
 const dir=await mkdtemp(join(tmpdir(),'service-drain-observation-'));
 const base={stateDirectory:join(dir,'host'),allowedWorkspaceRoots:[dir],engines:[{id:'fixture',command:process.execPath,args:[fileURLToPath(new URL('../fixtures/acp-peer.mjs',import.meta.url))]}]};
 const host=await createHost({...base,turnSettled:callback,quiescence});
 const client=new AhpClient(await WebSocketTransport.connect(host.url));client.connect();await client.initialize({clientId:'owner',protocolVersions:['0.9.0']});
 const session='ahp-session:/long-drain';await client.request('createSession',{channel:session,provider:'fixture',workingDirectories:[pathToFileURL(dir).href]});
 return {host,client,session,dir,base,async close(){await client.shutdown();await host.close();await rm(dir,{recursive:true,force:true});}};
}
function held(receipt:any,fenceId:string){assert.equal(receipt.phase,'held');assert.equal(receipt.fenceId,fenceId);assert.equal(receipt.evidence.activeWork,0);assert.equal(receipt.intakeClosed,true);}

test('actual turn callback exceeding default ten seconds drains under the original command after observer loss', {timeout:25000},async()=>{
 const started=pause(),finish=pause();let callbacks=0;
 const f=await fixture(async()=>{callbacks++;started.release();await finish.promise;});
 try{
  await f.host.submitTurn(f.session,{commandId:'original-turn',text:'hello',clientId:'owner'});await started.promise;
  f.host.store.admission('ahp-chat:/retained',{},'unrelated-business-unknown','prior',1);f.host.store.finish('unrelated-business-unknown','unknown');const before=JSON.stringify(f.host.store.receipt('unrelated-business-unknown'));
  const closed=await f.host.closeServiceIntake({commandId:'original-stop',expected:A});let settled=false;
  const original=f.host.admitServiceStop({commandId:'original-stop',expected:A}).then(value=>{settled=true;return value;});
  // The first observer goes away; only passive same-command reads follow.
  await new Promise(r=>setTimeout(r,11000));
  assert.equal(settled,false);const observed=f.host.serviceStopReceipt('original-stop') as any;
  assert.equal(observed.phase,'closed');assert.equal(observed.fence.phase,'closed');assert.equal(observed.fenceId,closed.fenceId);assert.ok(observed.evidence.activeWork>0);
  assert.equal(f.host.diagnostics().turnSettledPending,1);assert.equal(callbacks,1);
  await assert.rejects(f.host.submitTurn(f.session,{commandId:'new-turn',text:'must wait',clientId:'owner'}),/intake is closed/);
  await assert.rejects(f.host.releaseServiceStop({fenceId:closed.fenceId!,commandId:'original-stop',outcome:'stop-refused'}),/still running/);
  finish.release();held(await original,closed.fenceId!);held(f.host.serviceStopReceipt('original-stop'),closed.fenceId!);
  assert.equal(callbacks,1);assert.equal(f.host.store.db.prepare('SELECT count(*) n FROM host_quiescence_commands').get()!.n,1);
  assert.equal(f.host.store.receipt('original-turn')!.status,'completed');assert.equal(JSON.stringify(f.host.store.receipt('unrelated-business-unknown')),before);
 }finally{finish.release();await f.close();}
});

test('a completed failed callback drains, while an unknown owner outcome never becomes idle proof',async()=>{
 const started=pause(),finish=pause(),config=lifecycle();config.timeoutMs=25;
 const f=await fixture(async()=>{started.release();await finish.promise;throw Error('Owner callback failed');},config);
 try{
  await f.host.submitTurn(f.session,{commandId:'turn',text:'hello',clientId:'owner'});await started.promise;
  f.host.store.admission(f.session.replace('ahp-session:','ahp-chat:'),{},'retained-business-unknown','prior',1);f.host.store.finish('retained-business-unknown','unknown');const before=JSON.stringify(f.host.store.receipt('retained-business-unknown'));
  const closed=await f.host.closeServiceIntake({commandId:'stop',expected:A});const first=f.host.admitServiceStop({commandId:'stop',expected:A}),second=f.host.admitServiceStop({commandId:'stop',expected:A});
  await new Promise(r=>setTimeout(r,60));assert.equal(f.host.inspectServiceLifecycle().fence!.phase,'closed');
  finish.release();held(await first,closed.fenceId!);held(await second,closed.fenceId!);assert.equal(f.host.diagnostics().turnSettledFailures,1);
  const unknown=await f.host.releaseServiceStop({fenceId:closed.fenceId!,commandId:'stop',outcome:'unknown'});
  assert.deepEqual(await f.host.admitServiceStop({commandId:'stop',expected:A}),unknown);assert.deepEqual(f.host.serviceStopReceipt('stop'),unknown);
  assert.equal(f.host.inspectServiceLifecycle().fence!.reason,'service-owner-outcome-unknown');
  await assert.rejects(f.host.admitServiceStop({commandId:'new-stop',expected:A}),/authoritative reconciliation/);
  await f.host.releaseServiceStop({fenceId:closed.fenceId!,commandId:'stop',outcome:'stop-refused'});
  await assert.rejects(f.host.submitTurn(f.session,{commandId:'fresh',text:'must still reconcile this chat',clientId:'owner'}),/prior execution outcome is unknown/);
  assert.equal(JSON.stringify(f.host.store.receipt('retained-business-unknown')),before);assert.equal(f.host.store.receipt('fresh'),undefined);
 }finally{finish.release();await f.close();}
});

test('closing and reopening Host cannot turn an unfinished original drain into sampled idle proof',async()=>{
 const started=pause(),finish=pause();const f=await fixture(async()=>{started.release();await finish.promise;});let next:Awaited<ReturnType<typeof createHost>>|undefined,closing:Promise<void>|undefined;
 try{
  await f.host.submitTurn(f.session,{commandId:'turn',text:'hello',clientId:'owner'});await started.promise;
  const closed=await f.host.closeServiceIntake({commandId:'stop',expected:A});const pending=f.host.admitServiceStop({commandId:'stop',expected:A});await new Promise(r=>setImmediate(r));
  await f.client.shutdown();closing=f.host.close();const ended:any=await pending;assert.equal(ended.fence.reason,'host-closing');assert.equal(ended.fence.phase,'unknown');assert.equal(ended.fenceId,closed.fenceId);
  finish.release();await closing;next=await createHost({...f.base,quiescence:lifecycle(B)});
  const retained:any=next.serviceStopReceipt('stop');assert.equal(retained.fence.reason,'host-restarted');assert.equal(retained.fenceId,closed.fenceId);assert.deepEqual(retained.expected,A);
  await assert.rejects(next.withExternalMutation('fresh',async()=>{}),/intake is closed/);
  await assert.rejects(next.admitServiceStop({commandId:'stop',expected:B}),/differs/);
  assert.deepEqual(next.serviceStopReceipt('stop'),retained);
  // Existing authenticated service release, not an idle sample, opens the replacement.
  await next.releaseServiceStop({fenceId:closed.fenceId!,commandId:'stop',outcome:'resumed',resumeCommandId:'resume-B'});assert.equal(next.inspectServiceLifecycle().intakeClosed,false);
 }finally{finish.release();if(closing)await closing;else await f.host.close();await next?.close();await rm(f.dir,{recursive:true,force:true});}
});

test('passive receipt reads cannot start a close-only drain or erase unmeasurable work',async()=>{
 for(const invalid of [{counts:{job:-1},gaps:[]},{counts:{job:0},gaps:['owner-observation-unavailable']},'throws'] as const){
  const db=new DatabaseSync(':memory:');let bad=false;
  const gate=new QuiescenceGate(db,lifecycle(),[],()=>{if(bad){if(invalid==='throws')throw Error('Unavailable');return invalid as any;}return {counts:{job:0},gaps:[]};},async()=>({ready:true}));
  try{
   const closed=await gate.closeServiceIntake({commandId:'stop',expected:A});assert.equal(gate.serviceStopReceipt('stop')!.intakeClosed,true);assert.equal((gate.serviceStopReceipt('stop') as any).phase,'closed');
   bad=true;const result:any=await gate.admitServiceStop({commandId:'stop',expected:A});assert.equal(result.fence.phase,'unknown');assert.equal(result.fence.reason,'service-work-unconfirmed');assert.equal(result.fenceId,closed.fenceId);
   bad=false;gate.workChanged();assert.deepEqual(await gate.admitServiceStop({commandId:'stop',expected:A}),result);assert.deepEqual(gate.serviceStopReceipt('stop'),result);
  }finally{db.close();}
 }
});

test('shutdown between durable intake closure and the first drain continuation stays unknown',async()=>{
 const db=new DatabaseSync(':memory:');const gate=new QuiescenceGate(db,lifecycle(),[],()=>({counts:{job:0},gaps:[]}),async()=>({ready:true}));
 try{
  const pending=gate.admitServiceStop({commandId:'stop',expected:A});gate.hostClosing();
  const result:any=await pending;assert.equal(result.fence.phase,'unknown');assert.equal(result.fence.reason,'host-closing');
  gate.workChanged();assert.deepEqual(gate.serviceStopReceipt('stop'),result);assert.deepEqual(await gate.admitServiceStop({commandId:'stop',expected:A}),result);
 }finally{db.close();}
});

test('concurrent observers of an already idle original drain both see the current held receipt',async()=>{
 const db=new DatabaseSync(':memory:');const gate=new QuiescenceGate(db,lifecycle(),[],()=>({counts:{job:0},gaps:[]}),async()=>({ready:true}));
 try{
  const [first,second]=await Promise.all([gate.admitServiceStop({commandId:'stop',expected:A}),gate.admitServiceStop({commandId:'stop',expected:A})]);
  held(first,first.fenceId!);assert.deepEqual(first,second);assert.deepEqual(second,gate.serviceStopReceipt('stop'));
  assert.equal(db.prepare('SELECT count(*) n FROM host_quiescence_commands').get()!.n,1);
 }finally{db.close();}
});
