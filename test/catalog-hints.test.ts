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
  proof={attemptId:attempt.attemptId,evidence:'process-exited',ownerReceipt:'retained-exit'};await hints.quiet();assert.equal(hints.inspect().unsettled,false);assert.equal(hints.inspect().pending,1);
 }finally{await hints.close();db.close();}
});
