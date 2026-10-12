import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../src/store.js';
import {UsageReceipts,capacityPolicy,evaluateCapacity} from '../src/usage.js';
const session='ahp-session:/root',native='native-root';
const call=(id:string,patch:any={})=>({id,kind:'llm',sessionId:native,rootSessionId:native,producerId:'worker1',revision:1,phase:'running',provider:'fixture',model:'small',startedAt:10,...patch});
const policy=(patch:any={})=>capacityPolicy({revision:0,enabled:false,...patch});
function fixture(){const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE model_usage(session TEXT,call_id TEXT,payload TEXT,PRIMARY KEY(session,call_id))');return {db,owner:new UsageReceipts(db)};}
test('call revisions replace totals; partial updates retain measured buckets; cache reads and reasoning are not counted twice',()=>{
 const {db,owner}=fixture();try{
  owner.observe(session,native,call('a'));assert.equal(owner.snapshot(session).metrics.grossTotalTokens.status,'pending');
  owner.observe(session,native,call('a',{revision:2,usage:{inputTokens:100,outputTokens:12,totalTokens:112,cacheReadTokens:90,cacheWriteTokens:20,reasoningTokens:5,costUsd:.1}}));
  owner.observe(session,native,call('a',{revision:3,phase:'completed',endedAt:12,usage:{outputTokens:15,totalTokens:115,costUsd:.12}}));
  owner.observe(session,native,call('a',{revision:2,usage:{inputTokens:999}}));
  owner.observe(session,native,call('a',{revision:3,phase:'completed',endedAt:12,usage:{inputTokens:999}}));
  const value=owner.snapshot(session);assert.equal(value.calls,1);assert.equal(value.metrics.grossInputTokens.value,120);assert.equal(value.metrics.grossTotalTokens.value,135);assert.equal(value.metrics.costUsd.value,.12);assert.equal(value.metrics.grossTotalTokens.status,'known');
  assert.throws(()=>owner.observe(session,native,call('a',{revision:4,producerId:'different-worker'})),/identity changed/);
  owner.observe(session,native,call('a',{sessionId:'child',phase:'completed',endedAt:14,usage:{inputTokens:1,outputTokens:1}}));assert.equal(owner.snapshot(session).calls,2);
 }finally{db.close();}
});
test('admission persists before dispatch; duplicate call IDs and reached budgets cannot be replayed',()=>{
 const {db,owner}=fixture();try{
  const budget=policy({enabled:true,maxTotalTokens:110});
  assert.equal(owner.admit(session,native,call('a'),budget).allowed,true);
  assert.equal(owner.admit(session,native,call('a'),budget).allowed,false);
  owner.observe(session,native,call('a',{revision:2,phase:'completed',endedAt:12,usage:{inputTokens:100,outputTokens:0,cacheWriteTokens:10}}));
  assert.equal(owner.admit(session,native,call('b'),budget).allowed,false);assert.equal(owner.snapshot(session).calls,1);
  assert.equal(owner.admit(session,native,call('b'),policy({revision:1,enabled:false})).allowed,true);
  assert.throws(()=>owner.admit(session,native,call('c',{rootSessionId:'elsewhere'}),budget),/owned native root/);
 }finally{db.close();}
});
test('known zero, pending, interrupted unknown and excluded estimates have different budget meanings',()=>{
 const {db,owner}=fixture();try{
  owner.observe(session,native,call('a',{phase:'completed',endedAt:12,usage:{inputTokens:0,outputTokens:0,costUsd:0}}));
  owner.observe(session,native,call('b'));assert.equal(evaluateCapacity(policy({enabled:true,maxTotalTokens:100}),owner.snapshot(session)).allowed,true);
  owner.interrupted(session);assert.equal(owner.observe(session,native,call('b',{revision:2})),false);const unknown=owner.snapshot(session);assert.equal(unknown.inFlightCalls,0);assert.equal(unknown.metrics.grossTotalTokens.status,'partial');assert.equal(unknown.metrics.grossTotalTokens.unknownCalls,1);
  assert.equal(evaluateCapacity(policy({enabled:true,maxTotalTokens:100}),unknown).allowed,false);
  assert.equal(evaluateCapacity(policy({enabled:true,maxTotalTokens:100,unknownPolicy:'allow'}),unknown).allowed,true);
  owner.observe(session,native,call('b',{revision:2,phase:'completed',endedAt:14,usage:{inputTokens:1,outputTokens:1,costUsd:.2,costType:'estimated'}}));
  const estimates=owner.snapshot(session);assert.equal(evaluateCapacity(policy({enabled:true,maxCostUsd:1}),estimates).allowed,false);assert.equal(evaluateCapacity(policy({enabled:true,maxCostUsd:1,includeEstimatedCost:true}),estimates).allowed,true);
  assert.equal(evaluateCapacity(policy({enabled:true,maxCostUsd:1,includeEstimatedCost:true,lastDenial:{budgetRevision:0,reasons:['Paused until budget changes']}}),estimates).allowed,false);
 }finally{db.close();}
});
test('receipt pages stay bounded while accounting includes descendants and calls beyond the UI list',()=>{
 const {db,owner}=fixture();try{
  for(let i=0;i<1205;i++)owner.observe(session,native,call(String(i),{sessionId:i%2?'native-child':native,phase:'completed',endedAt:20,usage:{inputTokens:1,outputTokens:1},rawRequest:'sensitive payload excluded'}));
  assert.equal(owner.observe(session,native,call('foreign',{rootSessionId:'other'})),false);
  const page=owner.snapshot(session,{offset:1200,limit:3});assert.equal(page.calls,1205);assert.equal(page.receipts.length,3);assert.equal(page.metrics.grossTotalTokens.value,2410);assert.equal(page.nextOffset,1203);assert.ok(!JSON.stringify(page).includes('sensitive'));
  assert.throws(()=>owner.snapshot(session,{limit:501}),/bounds/);
 }finally{db.close();}
});
test('store restart retains final receipts and marks an admitted unconfirmed call unknown',()=>{
 const directory=mkdtempSync(join(tmpdir(),'usage-restart-'));let store:Store|undefined;try{
  store=new Store(directory);store.usage.admit(session,native,call('active'),policy());store.usage.observe(session,native,call('settled',{phase:'completed',endedAt:11,usage:{inputTokens:3,outputTokens:2}}));store.close();store=new Store(directory);
  const value=store.usage.snapshot(session);assert.equal(value.calls,2);assert.equal(value.inFlightCalls,0);assert.equal(value.metrics.grossTotalTokens.value,5);assert.equal(value.metrics.grossTotalTokens.unknownCalls,1);assert.equal(store.usage.admit(session,native,call('active',{producerId:'worker2'}),policy()).allowed,false);
 }finally{store?.close();rmSync(directory,{recursive:true,force:true});}
});
test('pre-usage schema backfills retained and edited-away call revisions only once',()=>{
 const directory=mkdtempSync(join(tmpdir(),'usage-migration-'));let store:Store|undefined;try{
  store=new Store(directory);const chat='ahp-chat:/root',turn=(id:string,row:any)=>({id,responseParts:[{kind:'systemNotification',_meta:{'amplifier.dev/modelCall':row}}]});
  store.db.prepare('INSERT INTO sessions(uri,chat_uri,engine_id,native_id,cwd,modified,summary,state,chat) VALUES(?,?,?,?,?,?,?,?,?)').run(session,chat,'native',native,'/fixture','2026-01-01','{}','{}',JSON.stringify({resource:chat,turns:[]}));
  store.db.prepare('INSERT INTO turns(chat,turn_id,payload) VALUES(?,?,?)').run(chat,'current',JSON.stringify(turn('current',call('kept',{phase:'completed',endedAt:11,usage:{inputTokens:2,outputTokens:3}}))));
  store.db.prepare('INSERT INTO history_edit_archives VALUES(?,?,?,?,?)').run('edit',chat,1,'retired',JSON.stringify(turn('retired',call('retired',{phase:'completed',endedAt:11,usage:{inputTokens:10,outputTokens:20}}))));
  store.db.exec("DROP TABLE model_usage; DELETE FROM meta WHERE key='model_usage_backfilled'; PRAGMA user_version=1095237953");store.close();store=new Store(directory);
  assert.equal(store.usage.snapshot(session).metrics.grossTotalTokens.value,35);assert.equal(store.usage.snapshot(session).calls,2);store.close();store=new Store(directory);assert.equal(store.usage.snapshot(session).calls,2);
 }finally{store?.close();rmSync(directory,{recursive:true,force:true});}
});
test('malformed saved budget cannot silently become an unlimited policy',()=>{
 for(const input of [null,{},policy({enabled:false}),{revision:0,enabled:true},{revision:0,enabled:true,maxTotalTokens:Infinity},{revision:0,enabled:true,maxTotalTokens:1.5},{revision:0,enabled:false,lastDenial:{budgetRevision:2,reasons:['stale']}}]){
  if(input?.enabled===false&&Object.keys(input).length===7)continue;
  assert.throws(()=>capacityPolicy(input as any));
 }
});
