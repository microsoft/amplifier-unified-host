import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';

test('overlapping equal-clock admissions settle by identity, not timestamp',()=>{
 for(const results of [['rejected','rejected'],['rejected','accepted'],['accepted','rejected'],['retained','rejected']] as const){
  for(const order of [[0,1],[1,0]]){
   const dir=mkdtempSync(join(tmpdir(),'navigation-')),store=new Store(dir),nav=store.navigation;
   try{nav.post('s','a',20,10);nav.post('s','b',20,10);for(const i of order)nav.disposition('s',i?'b':'a',results[i]!,10);assert.equal(nav.projection('s',10).activityAt,results.every(r=>r==='rejected')?10:20);}
   finally{store.close();rmSync(dir,{recursive:true,force:true});}
  }
 }
});
test('independent progress, settlement and restart cannot be undone by late refusal',()=>{
 const dir=mkdtempSync(join(tmpdir(),'navigation-'));let store=new Store(dir);
 try{
  store.navigation.post('s','a',20,10);store.navigation.progress('s',25,10);
  store.close();store=new Store(dir);
  store.navigation.disposition('s','a','rejected',10);assert.equal(store.navigation.projection('s',10).activityAt,10);
  store.navigation.progress('s',24,10,true);assert.equal(store.navigation.projection('s',10).activityAt,25);
  store.navigation.disposition('s','a','rejected',10);assert.equal(store.navigation.projection('s',10).activityAt,25);
  store.navigation.post('s','unknown',30,10);store.navigation.disposition('s','unknown','retained',10);store.navigation.disposition('s','unknown','rejected',10);assert.equal(store.navigation.projection('s',10).activityAt,30);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('admission rollback is atomic, bounded and isolated from other sessions',()=>{
 const dir=mkdtempSync(join(tmpdir(),'navigation-')),store=new Store(dir);
 try{
  assert.throws(()=>store.transaction(()=>{store.navigation.post('s','a',20,10);store.admission('chat',{},'a','ui',1);throw Error('abort');}));
  assert.equal(store.receipt('a'),undefined);assert.equal(store.navigation.projection('s',10).activityAt,10);
  for(let i=0;i<16;i++)store.navigation.post('s','p'+i,20+i,10);
  assert.throws(()=>store.navigation.post('s','overflow',99,10),/capacity/);
  store.navigation.disposition('other','p15','rejected',10);assert.equal(store.navigation.projection('s',10).activityAt,35);
  store.navigation.disposition('s','p15','accepted',10);store.navigation.post('s','next',36,10);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('only positive immutable creation provenance marks an agent-created root',()=>{
 const dir=mkdtempSync(join(tmpdir(),'navigation-')),store=new Store(dir);
 try{
  assert.equal(store.navigation.projection('fork',10).agentCreated,false);
  store.navigation.created('task',{creatorSessionId:'s',requestId:'request'},10);
  assert.equal(store.navigation.projection('task',10).agentCreated,true);
  assert.throws(()=>store.navigation.created('task',{creatorSessionId:'other',requestId:'request'},10),/immutable/);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('seeding is idempotent without write traffic and corrupt provenance is never guessed',()=>{
 const dir=mkdtempSync(join(tmpdir(),'navigation-')),store=new Store(dir);
 try{
  store.navigation.initialize('s',10);const before=store.db.prepare('SELECT total_changes() n').get()!.n;
  for(let i=0;i<1000;i++)store.navigation.initialize('s',20+i);
  assert.equal(store.db.prepare('SELECT total_changes() n').get()!.n,before);
  assert.equal(store.navigation.projection('s',30).activityAt,10);
  store.db.prepare('UPDATE session_admission SET navigation=? WHERE uri=?').run(JSON.stringify({version:1,base:10,raw:10,posts:[],creation:{creatorSessionId:'s'}}),'s');
  assert.throws(()=>store.navigation.projection('s',0),/provenance/);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
