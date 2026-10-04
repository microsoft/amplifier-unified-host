import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {CatalogHints} from '../src/catalog-hints.js';
const until=async(check:()=>boolean)=>{for(let n=0;n<200;n++){if(check())return;await new Promise(r=>setTimeout(r,5));}assert.fail('Bounded wait expired');};
test('coalesced hint capacity is durable and overflow requires a complete scan after its boundary',async()=>{
 const db=new DatabaseSync(':memory:');let calls=0,reason='';const ports={hint:async()=>{calls++;},ready:async()=>true,blocked:(value:string)=>reason=value};let hints=new CatalogHints(db,ports);
 try{
  hints.pause();for(let i=0;i<512;i++)hints.enqueue('/native/'+i);for(let i=0;i<500;i++)hints.enqueue('/native/0');assert.equal(hints.inspect().pending,512);
  const earlier=hints.scanBoundary();hints.enqueue('/native/overflow');assert.equal(hints.inspect().pending,512);assert.equal(hints.inspect().overflow,true);assert.match(reason,/capacity/);
  await hints.close();hints=new CatalogHints(db,ports);hints.pause();assert.equal(hints.inspect().overflow,true);hints.scanned(earlier);assert.throws(()=>hints.assertComplete(),/overflow/);
  hints.scanned(hints.scanBoundary());hints.assertComplete();hints.resume();await until(()=>hints.inspect().pending===0);assert.equal(calls,512);
 }finally{await hints.close();db.close();}
});
test('failed hint retains exact attempt across reopen; mismatched settlement cannot clear it',async()=>{
 const db=new DatabaseSync(':memory:');let proof:any,attempt:any;const ports={hint:async()=>{throw Error('uncertain');},ready:async()=>true,blocked:()=>{},settle:async(value:any)=>{attempt=value;return proof;}};let hints=new CatalogHints(db,ports);
 try{
  hints.enqueue('/native/session');await until(()=>hints.inspect().unsettled&&!hints.inspect().inFlight);await hints.close();hints=new CatalogHints(db,ports);
  proof={attemptId:'foreign',evidence:'process-exited',ownerReceipt:'retained-exit'};await assert.rejects(hints.quiet(),/Exact catalog-owner/);assert.equal(hints.inspect().unsettled,true);
  proof={attemptId:attempt.attemptId,evidence:'new-process-started',ownerReceipt:'new-pid'};await assert.rejects(hints.quiet(),/Exact catalog-owner/);
  proof={attemptId:attempt.attemptId,evidence:'process-exited',ownerReceipt:'retained-exit',unexpected:'private data'};await assert.rejects(hints.quiet(),/Exact catalog-owner/);assert.equal(hints.inspect().unsettled,true);
  proof={attemptId:attempt.attemptId,evidence:'process-exited',ownerReceipt:'retained-exit'};await hints.quiet();assert.equal(hints.inspect().unsettled,false);assert.equal(hints.inspect().pending,1);
 }finally{await hints.close();db.close();}
});
test('selected-family discovery shares durable writer settlement and joins exact in-flight work',async()=>{
 const db=new DatabaseSync(':memory:');let release!:()=>void,entered!:()=>void,settlement:any,observed:any;
 const hold=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
 const ports={hint:async()=>{},ready:async()=>true,blocked:()=>{},settle:async(attempt:any)=>{observed=attempt;return settlement;}};let hints=new CatalogHints(db,ports);
 try{
  hints.pause();const attempt={attemptId:'family-attempt',method:'reconcileFamily' as const,parentUri:'ahp-session:/root'};
  const writer=hints.discover(attempt,async()=>{entered();await hold;return 'complete';});await started;let quiet=false;const joining=hints.quiet().then(()=>quiet=true);await new Promise(r=>setTimeout(r,10));assert.equal(quiet,false);assert.equal(hints.inspect().inFlight,true);release();assert.equal(await writer,'complete');await joining;assert.equal(hints.inspect().unsettled,false);
  await assert.rejects(hints.discover(attempt,async()=>{throw Error('unknown writer');}),/unknown writer/);await hints.close();hints=new CatalogHints(db,ports);hints.pause();
  settlement={attemptId:'other',evidence:'process-exited',ownerReceipt:'exit'};await assert.rejects(hints.quiet(),/Exact catalog-owner/);assert.deepEqual(observed,attempt);assert.equal(hints.inspect().unsettled,true);
  settlement={attemptId:attempt.attemptId,evidence:'process-exited',ownerReceipt:'original-exit'};await hints.quiet();assert.equal(hints.inspect().unsettled,false);
  await assert.rejects(hints.discover({...attempt,attemptId:'settled'},async()=>{throw Object.assign(Error('refused'),{catalogDiscoverySettled:true});}),/refused/);assert.equal(hints.inspect().unsettled,false);
 }finally{release();await hints.close();db.close();}
});
