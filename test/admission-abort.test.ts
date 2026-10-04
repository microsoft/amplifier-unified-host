import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import type {QuiescenceConfig,QuiescenceContext,QuiescenceParticipant,AdmissionAbortRequest,AdmissionAbortProof,AdmissionAbortOwnerReceipt} from '../src/quiescence.js';
const {QuiescenceGate}=await import(process.env.ABORT_TEST_PACKAGE?pathToFileURL(join(process.env.ABORT_TEST_PACKAGE,'dist/quiescence.js')).href:'../src/quiescence.js');
const {createHost}=await import(process.env.ABORT_TEST_PACKAGE?pathToFileURL(join(process.env.ABORT_TEST_PACKAGE,'dist/index.js')).href:'../src/index.js');
const pause=()=>{let release!:()=>void;const promise=new Promise<void>(resolve=>release=resolve);return {promise,release};};
const proof=(c:QuiescenceContext):AdmissionAbortProof=>({kind:'distribution-admission-abort',verified:true,purpose:'distribution-update',commandId:c.commandId,fenceId:c.fenceId,instanceId:c.instanceId,dataScope:c.dataScope,receiptId:'supervisor-exact-abort'});
const receipt=(ownerId:string,c:QuiescenceContext,status:'released'|'not-acquired'='released'):AdmissionAbortOwnerReceipt=>({ownerId,status,commandId:c.commandId,fenceId:c.fenceId,instanceId:c.instanceId,dataScope:c.dataScope,receiptId:ownerId+'-exact-settlement'});
function config(participants:QuiescenceParticipant[],extra:Partial<QuiescenceConfig>={}):QuiescenceConfig{return {instanceId:'original-launch',dataScope:'owned-scope',requiredOwners:participants.map(p=>p.id),coverage:{},participants,timeoutMs:1000,verifyRelease:async()=>{throw Error('Generic release verifier must not authorize an abort');},verifyAdmissionAbort:async c=>proof(c),...extra};}
function owner(id:string,extra:Partial<QuiescenceParticipant>={}):QuiescenceParticipant{return {id,acquire:async c=>({ownerId:id,fenceId:c.fenceId,release:async()=>{}}),abortAdmission:async c=>receipt(id,c),...extra};}
async function fixture(participants:QuiescenceParticipant[],extra:Partial<QuiescenceConfig>={},retire=async()=>({ready:true})){
 const directory=await mkdtemp(join(tmpdir(),'host-admission-abort-')),path=join(directory,'authority.sqlite');let db=new DatabaseSync(path),retired=0;
 const configuration=config(participants,extra),open=()=>new QuiescenceGate(db,configuration,[],()=>({counts:{},gaps:[]}),async()=>{retired++;return retire();});let gate=open();
 return {directory,get db(){return db;},get gate(){return gate;},configuration,get retired(){return retired;},restart:()=>{db.close();db=new DatabaseSync(path);gate=open();},close:async()=>{db.close();await rm(directory,{recursive:true,force:true});}};
}
async function failAdmission(f:any,commandId='original-update'):Promise<AdmissionAbortRequest>{const r=await f.gate.admit({commandId,purpose:'distribution-update'});assert.equal(r.fence.phase,'unknown');return {commandId,fenceId:r.fence.fenceId,instanceId:r.fence.instanceId,dataScope:r.fence.dataScope,evidence:{abortCommand:'original-update-abort'}};}

test('actual public Host keeps reads available and requires distinct receipts before reopening pre-retirement intake',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'host-public-abort-'));let acquired=0,settled=0;
 const p=owner('uncertain',{acquire:async()=>{acquired++;throw Error('Acknowledgement lost after local owner acquisition');},abortAdmission:async c=>{settled++;return receipt('uncertain',c);}});
 const host=await createHost({stateDirectory:join(directory,'host'),allowedWorkspaceRoots:[directory],engines:[{id:'fixture',command:process.execPath,args:[fileURLToPath(new URL('../fixtures/acp-peer.mjs',import.meta.url))]}],quiescence:config([p])});
 try {
  const r=await host.admitQuiescence({commandId:'original-update',purpose:'distribution-update'}),input={commandId:r.fence.commandId,fenceId:r.fence.fenceId,instanceId:r.fence.instanceId,dataScope:r.fence.dataScope};
  assert.equal(host.quiescenceReceipt(input.commandId).fence.admissionStage,'participants');assert.equal(host.quiescenceAdmissionAbortReceipt(input.commandId),undefined);
  await assert.rejects(host.withExternalMutation('uncertain',async()=>assert.fail('closed')),/intake is closed/);
  const result=await host.abortQuiescenceAdmission(input);assert.equal(result.schema,'host-admission-abort-v1');assert.equal(result.status,'aborted');assert.equal(result.intakeClosed,false);assert.deepEqual(result.owners.map(x=>[x.ownerId,x.status]),[['uncertain','released']]);
  assert.deepEqual(host.quiescenceReceipt(input.commandId),result);assert.deepEqual(host.quiescenceAdmissionAbortReceipt(input.commandId),result);
  await host.withExternalMutation('uncertain',async()=>{});assert.deepEqual(await host.abortQuiescenceAdmission(input),result);
  assert.deepEqual(await host.admitQuiescence({commandId:input.commandId,purpose:'distribution-update',retryRefused:true}),result);assert.equal(acquired,1);assert.equal(settled,1);assert.equal(host.diagnostics().activeAgents,0);
 }finally{await host.close();await rm(directory,{recursive:true,force:true});}
});

test('abort releases only attempted owners in reverse order and records proven not-acquired separately',async()=>{
 const order:string[]=[];let acquisitions=0;
 const f=await fixture([owner('first',{abortAdmission:async c=>{order.push('first');return receipt('first',c);}}),owner('second',{acquire:async()=>{acquisitions++;throw Error('Negotiation failed before owning a lease');},abortAdmission:async c=>{order.push('second');return receipt('second',c,'not-acquired');}}),owner('never',{acquire:async()=>assert.fail('must not acquire'),abortAdmission:async()=>assert.fail('must not settle')})]);
 try{const input=await failAdmission(f),result=await f.gate.abortAdmission(input);assert.deepEqual(order,['second','first']);assert.deepEqual(result.owners.map(x=>x.status),['not-acquired','released']);assert.equal(f.retired,0);assert.equal(acquisitions,1);}finally{await f.close();}
});

test('timed-out acquisition cannot race abort, even after admission has returned unknown',async()=>{
 const acquire=pause();let settled=0;const f=await fixture([owner('slow',{acquire:async c=>{await acquire.promise;return {ownerId:'slow',fenceId:c.fenceId,release:async()=>{}};},abortAdmission:async c=>{settled++;return receipt('slow',c);}})],{timeoutMs:25});
 const keep=setInterval(()=>{},1000);
 try{const input=await failAdmission(f);await assert.rejects(f.gate.abortAdmission(input),/still running/);await assert.rejects(f.gate.release({...input,outcome:'unchanged'}),/still running/);assert.equal(settled,0);assert.equal(f.gate.inspect().intakeClosed,true);acquire.release();await new Promise(r=>setImmediate(r));await f.gate.abortAdmission(input);assert.equal(settled,1);assert.equal(f.retired,0);}finally{clearInterval(keep);acquire.release();await f.close();}
});

test('legacy, held, retirement, other-purpose and replacement-instance fences cannot be aborted',async()=>{
 for(const variant of ['legacy','held','native-retirement','recovery','service-stop','new-instance']){
  let settled=0;const f=await fixture([owner('owner',{acquire:async()=>{throw Error('Lost reply');},abortAdmission:async c=>{settled++;return receipt('owner',c);}})]);
  try{const input=await failAdmission(f),saved=JSON.parse(String(f.db.prepare('SELECT payload FROM host_quiescence_fence').get()!.payload));
   if(variant==='legacy')delete saved.admissionStage;else if(variant==='held')saved.phase='held';else if(variant==='native-retirement')saved.admissionStage='native-retirement';else if(variant==='recovery'||variant==='service-stop')saved.purpose=variant;else f.configuration.instanceId='replacement-launch';
   f.db.prepare('UPDATE host_quiescence_fence SET payload=?').run(JSON.stringify(saved));await assert.rejects(f.gate.abortAdmission(input),/pre-retirement/);assert.equal(settled,0);assert.equal(f.gate.inspect().intakeClosed,true);
  }finally{await f.close();}
 }
 const f=await fixture([],{},async()=>({ready:false,unknown:true,reason:'native-ack-lost'}));try{const input=await failAdmission(f);assert.equal(f.gate.inspect().fence?.admissionStage,'native-retirement');await assert.rejects(f.gate.abortAdmission(input),/pre-retirement/);assert.equal(f.retired,1);}finally{await f.close();}
});

test('wrong/missing supervisor authority and changed request identity cannot settle owners',async()=>{
 for(const variant of ['missing','foreign-fence','foreign-command','foreign-instance','foreign-scope','generic-proof','unverified','extra']){
  let settled=0;const f=await fixture([owner('owner',{acquire:async()=>{throw Error('Lost reply');},abortAdmission:async c=>{settled++;return receipt('owner',c);}})],{verifyAdmissionAbort:variant==='missing'?undefined:async c=>{const p:any=proof(c);if(variant==='foreign-fence')p.fenceId='foreign';if(variant==='foreign-command')p.commandId='foreign';if(variant==='foreign-instance')p.instanceId='foreign';if(variant==='foreign-scope')p.dataScope='foreign';if(variant==='generic-proof'){delete p.kind;p.outcome='unchanged';}if(variant==='unverified')p.verified=false;if(variant==='extra')p.admittedRunning=true;return p;}});
  try{const input=await failAdmission(f);await assert.rejects(f.gate.abortAdmission(input));assert.equal(settled,0);assert.equal(f.gate.inspect().intakeClosed,true);}finally{await f.close();}
 }
});

test('unknown, missing, conflicting or misbound owner receipts never reopen intake',async()=>{
 for(const variant of ['absent','null','unknown','wrong-owner','wrong-fence','wrong-command','wrong-instance','wrong-scope','extra','contradicts-lease']){
  const p=owner('owner',{acquire:async()=>{throw Error('Lost reply');},abortAdmission:variant==='absent'?undefined:async c=>{const r:any=receipt('owner',c);if(variant==='null')return null as any;if(variant==='unknown')r.status='unknown';if(variant==='wrong-owner')r.ownerId='foreign';if(variant==='wrong-fence')r.fenceId='foreign';if(variant==='wrong-command')r.commandId='foreign';if(variant==='wrong-instance')r.instanceId='foreign';if(variant==='wrong-scope')r.dataScope='foreign';if(variant==='extra')r.verified=true;if(variant==='contradicts-lease')r.status='not-acquired';return r;}});
  const participants=variant==='contradicts-lease'?[{...p,acquire:async(c:QuiescenceContext)=>({ownerId:p.id,fenceId:c.fenceId,release:async()=>{throw Error('Lost release');}})},owner('busy',{acquire:async()=>null})]:[p];const f=await fixture(participants);
  try{const input=await failAdmission(f);await assert.rejects(f.gate.abortAdmission(input));assert.equal(f.gate.inspect().intakeClosed,true);assert.equal(f.gate.admissionAbortReceipt(input.commandId),undefined);}finally{await f.close();}
 }
});

test('restart resumes only original owner settlement receipts, never acquisition or the update effect',async()=>{
 let acquisitions=0,releases=0,reads=0,lose=true;const durable=new Map<string,AdmissionAbortOwnerReceipt>();
 const settle=(id:string)=>async(c:QuiescenceContext)=>{const previous=durable.get(id);if(previous){reads++;return previous;}const r=receipt(id,c);durable.set(id,r);releases++;if(id==='first'&&lose){lose=false;throw Error('Lost settlement acknowledgement');}return r;};
 const f=await fixture([owner('first',{acquire:async c=>{acquisitions++;return {ownerId:'first',fenceId:c.fenceId,release:async()=>assert.fail('generic release')};},abortAdmission:settle('first')}),owner('second',{acquire:async()=>{acquisitions++;throw Error('lost acquire');},abortAdmission:settle('second')})]);
 try{const input=await failAdmission(f);await assert.rejects(f.gate.abortAdmission(input),/remains unknown/);assert.equal(releases,2);assert.equal(f.gate.inspect().intakeClosed,true);assert.equal(f.gate.admissionAbortReceipt(input.commandId),undefined);
  await assert.rejects(f.gate.release({...input,outcome:'unchanged'}),/distinct settlement/);f.restart();const result=await f.gate.abortAdmission(input);assert.deepEqual(result.owners.map(x=>x.ownerId),['second','first']);assert.equal(reads,1);assert.equal(releases,2);assert.equal(acquisitions,2);assert.equal(f.retired,0);f.restart();assert.deepEqual(f.gate.admissionAbortReceipt(input.commandId),result);assert.deepEqual(await f.gate.abortAdmission(input),result);
  await assert.rejects(f.gate.abortAdmission({...input,evidence:{different:true}}),/different arguments/);f.configuration.verifyAdmissionAbort=async c=>({...proof(c),receiptId:'different-proof'});await assert.rejects(f.gate.abortAdmission(input),/retained proof/);assert.deepEqual(f.gate.admissionAbortReceipt(input.commandId),result);assert.equal(f.gate.inspect().intakeClosed,false);
 }finally{await f.close();}
});

test('timed-out abort callback stays closed until actual completion, then exact receipt observation settles',async()=>{
 const done=pause();let starts=0;let durable:AdmissionAbortOwnerReceipt|undefined;
 const f=await fixture([owner('owner',{acquire:async()=>{throw Error('Lost reply');},abortAdmission:async c=>{if(durable)return durable;starts++;await done.promise;durable=receipt('owner',c);return durable;}})],{timeoutMs:25});const keep=setInterval(()=>{},1000);
 try{const input=await failAdmission(f);await assert.rejects(f.gate.abortAdmission(input),/remains unknown/);await assert.rejects(f.gate.abortAdmission(input),/still running/);done.release();await new Promise(r=>setImmediate(r));await f.gate.abortAdmission(input);assert.equal(starts,1);assert.equal(f.gate.inspect().intakeClosed,false);}finally{clearInterval(keep);done.release();await f.close();}
});


test('public Host recovers a durable participant abort receipt after owner commit and lost reply',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'host-durable-owner-abort-')),db=new DatabaseSync(join(directory,'owner.sqlite'));
 db.exec('CREATE TABLE fences(id TEXT PRIMARY KEY,context TEXT NOT NULL);CREATE TABLE receipts(id TEXT PRIMARY KEY,payload TEXT NOT NULL)');let lose=true,acquired=0,effects=0;
 const p=owner('durable',{acquire:async c=>{acquired++;db.prepare('INSERT INTO fences VALUES(?,?)').run(c.fenceId,JSON.stringify(c));throw Error('Owner acquired before lost acknowledgement');},abortAdmission:async c=>{
  const old=db.prepare('SELECT payload FROM receipts WHERE id=?').get(c.fenceId);if(old)return JSON.parse(String(old.payload));
  const retained=JSON.parse(String(db.prepare('SELECT context FROM fences WHERE id=?').get(c.fenceId)!.context));assert.equal(retained.commandId,c.commandId);assert.equal(c.proof.kind,'distribution-admission-abort');
  const result=receipt('durable',c);db.exec('BEGIN IMMEDIATE');try{db.prepare('INSERT INTO receipts VALUES(?,?)').run(c.fenceId,JSON.stringify(result));db.prepare('DELETE FROM fences WHERE id=?').run(c.fenceId);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}effects++;
  if(lose){lose=false;throw Error('Reply lost after durable settlement');}return result;
 }});
 const settings={stateDirectory:join(directory,'host'),allowedWorkspaceRoots:[directory],engines:[{id:'fixture',command:process.execPath,args:[fileURLToPath(new URL('../fixtures/acp-peer.mjs',import.meta.url))]}],quiescence:config([p])};let host=await createHost(settings);
 try{const admitted=await host.admitQuiescence({commandId:'durable-update',purpose:'distribution-update'}),f=admitted.fence,input={fenceId:f.fenceId,commandId:f.commandId,instanceId:f.instanceId,dataScope:f.dataScope};
  await assert.rejects(host.abortQuiescenceAdmission(input),/remains unknown/);assert.equal(effects,1);assert.equal(host.inspectQuiescence().intakeClosed,true);assert.equal(host.quiescenceAdmissionAbortReceipt(input.commandId),undefined);
  await host.close();host=await createHost(settings);assert.equal(host.inspectQuiescence().intakeClosed,true);const completed=await host.abortQuiescenceAdmission(input);assert.equal(completed.status,'aborted');assert.equal(acquired,1);assert.equal(effects,1);assert.equal(host.diagnostics().activeAgents,0);
  await host.close();host=await createHost(settings);assert.deepEqual(host.quiescenceAdmissionAbortReceipt(input.commandId),completed);assert.deepEqual(await host.abortQuiescenceAdmission(input),completed);assert.equal(effects,1);
 }finally{await host.close();db.close();await rm(directory,{recursive:true,force:true});}
});
