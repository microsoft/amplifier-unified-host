import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {QuiescenceGate,type QuiescenceConfig,type QuiescenceContext} from '../src/quiescence.js';

function fixture(options:{unknown?:boolean;busy?:boolean;lost?:boolean;work?:boolean;owned?:boolean}={}) {
 const db=new DatabaseSync(':memory:'),events:string[]=[];let resident=true,retireCalls=0,ownerCalls=0;
 const config:QuiescenceConfig={instanceId:'launch',dataScope:'owned',requiredOwners:['first','transfer'],coverage:{},timeoutMs:1000,
 participants:['first','transfer'].map(id=>({id,acquire:async(c:Readonly<QuiescenceContext>)=>{
  ownerCalls++;events.push('acquire:'+id);assert.equal(gate.inspect().intakeClosed,true);
  if(id==='transfer'){if(options.lost)throw Error('owner acknowledgement unknown');if(resident||options.busy)return null;}
  return {ownerId:id,fenceId:c.fenceId,release:async()=>{events.push('release:'+id);}};
 }})),verifyRelease:async c=>({verified:true,...c,outcome:c.outcome,receiptId:'trusted'}),
 verifyAdmissionAbort:async c=>({kind:'distribution-admission-abort',verified:true,purpose:'distribution-update',commandId:c.commandId,fenceId:c.fenceId,instanceId:c.instanceId,dataScope:c.dataScope,receiptId:'abort'})};
 const gate=new QuiescenceGate(db,config,[],()=>({counts:{active:options.work?1:0},gaps:[]}),async()=>{
  retireCalls++;events.push('retire');assert.equal(gate.inspect().intakeClosed,true);
  await assert.rejects(gate.run(async()=>assert.fail('public intake must stay closed')),/intake is closed/);
  await gate.continuation(async()=>{events.push('cleanup');await assert.rejects(gate.run(async()=>assert.fail('cleanup cannot start public work')),/intake is closed/);});
  if(options.owned)return {ready:false,reason:'native-owned-work'};
  if(options.unknown)return {ready:false,unknown:true,reason:'retirement-unknown'};
  resident=false;return {ready:true};
 },()=>resident);
 return {db,gate,config,events,get retireCalls(){return retireCalls;},get ownerCalls(){return ownerCalls;}};
}
test('resident cleanup releases its shared writer before external owner exclusion',async()=>{
 const f=fixture();try{const r=await f.gate.admit({commandId:'ordered',purpose:'distribution-update'});assert.equal(r.admitted,true);assert.deepEqual(f.events,['retire','cleanup','acquire:first','acquire:transfer']);assert.equal(f.gate.inspect().fence?.admissionStage,'held');}finally{f.db.close();}
});
test('unknown retirement acquires no owners and cannot replay or use pre-retirement abort',async()=>{
 const f=fixture({unknown:true});try{const input={commandId:'unknown',purpose:'distribution-update' as const},r=await f.gate.admit(input);assert.equal(r.fence.phase,'unknown');assert.equal(r.fence.admissionStage,'native-retirement');assert.equal(f.ownerCalls,0);assert.deepEqual(await f.gate.admit({...input,retryRefused:true}),r);assert.equal(f.retireCalls,1);await assert.rejects(f.gate.abortAdmission({commandId:r.fence.commandId,fenceId:r.fence.fenceId,instanceId:r.fence.instanceId,dataScope:r.fence.dataScope}),/pre-retirement/);assert.equal(f.gate.inspect().intakeClosed,true);}finally{f.db.close();}
});
test('post-retirement known owner refusal unwinds only acquired owners',async()=>{
 const f=fixture({busy:true});try{const r=await f.gate.admit({commandId:'refused',purpose:'recovery'});assert.equal(r.admitted,false);assert.equal(r.intakeClosed,false);assert.deepEqual(f.events,['retire','cleanup','acquire:first','acquire:transfer','release:first']);assert.equal(f.retireCalls,1);}finally{f.db.close();}
});
test('post-retirement uncertain owner acquisition stays distinct from pre-retirement abort',async()=>{
 const f=fixture({lost:true});try{const r=await f.gate.admit({commandId:'lost',purpose:'distribution-update'});assert.equal(r.fence.phase,'unknown');assert.equal(r.fence.admissionStage,'owner-exclusion');await assert.rejects(f.gate.abortAdmission({commandId:r.fence.commandId,fenceId:r.fence.fenceId,instanceId:r.fence.instanceId,dataScope:r.fence.dataScope}),/pre-retirement/);assert.equal(f.gate.inspect().intakeClosed,true);assert.equal(f.retireCalls,1);}finally{f.db.close();}
});
test('protected accepted work refuses before retirement or owner acquisition',async()=>{
 const f=fixture({work:true});try{const r=await f.gate.admit({commandId:'protected',purpose:'distribution-update'});assert.equal(r.admitted,false);assert.equal(f.retireCalls,0);assert.equal(f.ownerCalls,0);assert.deepEqual(f.events,[]);}finally{f.db.close();}
});

test('atomic Native owned-work refusal leaves the resident and never acquires exclusion',async()=>{
 const f=fixture({owned:true});try{const r=await f.gate.admit({commandId:'owned',purpose:'recovery'});assert.equal(r.admitted,false);assert.equal(r.intakeClosed,false);assert.equal(r.reason,'native-owned-work');assert.equal(f.ownerCalls,0);}finally{f.db.close();}
});
test('reconstructed post-retirement owner uncertainty cannot become an abort or a new acquisition',async()=>{
 const f=fixture({lost:true});try{const input={commandId:'restart-unknown',purpose:'distribution-update' as const},r=await f.gate.admit(input);
  const replacement=new QuiescenceGate(f.db,f.config,[],()=>({counts:{},gaps:[]}),async()=>assert.fail('retirement must not replay'),()=>true);
  assert.equal(replacement.inspect().fence?.admissionStage,'owner-exclusion');await replacement.admit({...input,retryRefused:true});
  await assert.rejects(replacement.abortAdmission({commandId:r.fence.commandId,fenceId:r.fence.fenceId,instanceId:r.fence.instanceId,dataScope:r.fence.dataScope}),/pre-retirement/);
  assert.equal(f.retireCalls,1);assert.equal(f.ownerCalls,2);
 }finally{f.db.close();}
});
