import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ConversationPresentation,type PresentationPorts} from '../src/presentation.js';
import {QuiescenceGate} from '../src/quiescence.js';
import type {PresentationActor,VisibilityProjectionRequest} from '../src/presentation-types.js';
const actor:PresentationActor={actorId:'authenticated-user',origin:'ui'};
const pause=()=>{let release!:()=>void;const promise=new Promise<void>(r=>release=r);return {promise,release};};
async function fixture(count=3){
 const directory=await mkdtemp(join(tmpdir(),'presentation-')),path=join(directory,'host.sqlite');let db=new DatabaseSync(path),host:ConversationPresentation,gate:QuiescenceGate;
 const rows=new Map<string,any>(),checkpoints=new Map<string,number>(),receipts=new Map<string,any>();
 for(let i=0;i<count;i++){const uri='ahp-session:/'+String(i).padStart(4,'0');rows.set(uri,{uri,engineId:'fixture',nativeSessionId:'native-'+i,workingDirectory:'/workspace',title:'Conversation '+i,createdAt:'2026-01-01',modifiedAt:'2026-01-01',nativeDeleted:i===2,workspaceAvailability:'present'});}
 let writes=0,failAt=0,failAfter=false,protectedRefs:any[]=[],releaseFails=false,releaseCalls=0,metadataReads=0,coverage=true;
 const ports:PresentationPorts={
  metadata:async session=>{metadataReads++;const row=rows.get(session);return {identity:{session,engineId:row.engineId,nativeSessionId:row.nativeSessionId,workingDirectory:row.workingDirectory},title:row.title,catalog:{...row,productHidden:undefined}};},
  assertMaintenance:f=>gate.assertRecoveryMaintenance(f),validateSelection:async()=>{},
  protection:{presentationReset:{version:1,preservesCanonical:true,preservesAuthority:true},acquire:async c=>({leaseId:'selected-'+c.commandId,hostFenceId:c.maintenance.fenceId,selectionHash:c.selectionHash,ownerIds:coverage?[...c.ownerIds]:['missing'],coverage:'complete',protected:protectedRefs,release:async()=>{releaseCalls++;assert.notEqual(host.effect(c.commandId)?.status,'unknown');if(releaseFails)throw Error('lost release');}}),reconcile:async c=>{releaseCalls++;assert.notEqual(host.effect(c.commandId)?.status,'unknown');if(releaseFails)throw Error('lost release');}},
  projectionStatus:async source=>({source,revision:checkpoints.get(source)??0}),projectionReceipt:async(_source,id)=>receipts.get(id)??null,
  project:async request=>{writes++;if(writes===failAt&&!failAfter)throw Error('before dispatch');const prior=receipts.get(request.commandId);if(prior)return prior;
   assert.equal(request.afterRevision,checkpoints.get(request.source)??0);for(const item of request.items){assert.ok(rows.has(item.uri));rows.get(item.uri).productHidden=item.hidden;}
   const result={source:request.source,commandId:request.commandId,revision:request.throughRevision,projected:request.items.length};checkpoints.set(request.source,result.revision);receipts.set(request.commandId,result);if(writes===failAt&&failAfter)throw Error('lost acknowledgment');return result;
  },catalogGet:async session=>rows.get(session),catalogFreshness:async()=>({phase:'complete',issues:0}),changed:()=>{},
  mappings:async()=>({items:[]}),reconstructMetadata:async request=>{let cursor:string|undefined;do{const page=request.readMappings(cursor);for(const row of page.items)rows.set(row.uri as string,structuredClone(row));cursor=page.nextCursor??undefined;}while(cursor);},
 };
 const open=()=>{gate=new QuiescenceGate(db,{instanceId:'fixture-process',dataScope:directory,requiredOwners:['selected-owner'],coverage:{},participants:[{id:'selected-owner',acquire:async c=>({ownerId:'selected-owner',fenceId:c.fenceId,release:async()=>{}})}],verifyRelease:async c=>({verified:true,fenceId:c.fenceId,commandId:c.commandId,outcome:c.outcome,instanceId:'fixture-process',dataScope:directory,receiptId:'verified-product-'+c.commandId})},[],()=>({counts:{},gaps:[]}),async()=>({ready:true}));host=new ConversationPresentation(db,ports);};open();await host.checkReady();
 const review=async(command='review',ids=[...rows.keys()],operation:'reset'|'restore'='reset',resetCommandId?:string)=>host.prepare({commandId:command,operation,selection:{kind:'explicit',sessionIds:ids},expectedRevision:host.inspect().revision,resetCommandId},actor);
 const acquire=async(commandId='recovery')=>{const result:any=await gate.admit({commandId,purpose:'recovery'});assert.equal(result.admitted,true);return {fenceId:result.fenceId,commandId};};
 return {rows,ports,checkpoints,receipts,get host(){return host;},get gate(){return gate;},get db(){return db;},review,acquire,stats:()=>({writes,releaseCalls,metadataReads}),fail:(at:number,after=false)=>{failAt=at;failAfter=after;},protect:(p:any[])=>protectedRefs=p,coverage:(yes:boolean)=>coverage=yes,loseRelease:(yes:boolean)=>releaseFails=yes,
  restart:()=>{db.close();db=new DatabaseSync(path);open();},clearCatalog:()=>{rows.clear();checkpoints.clear();receipts.clear();},close:async()=>{db.close();await rm(directory,{recursive:true,force:true});}};
}

test('bounded immutable selection and private actor binding precede metadata reads',async()=>{
 const f=await fixture(501);try{
  await assert.rejects(f.review(),/Bounded explicit/);assert.equal(f.stats().metadataReads,0);
  await assert.rejects(f.review('dup',['ahp-session:/0000','ahp-session:/0000']),/Duplicate/);
  const r=await f.review('500',[...f.rows.keys()].slice(0,500));assert.equal(r.count,500);assert.equal(r.items.length,50);assert.ok(r.nextCursor);assert.equal('identity' in r.items[0],false);assert.equal('actor' in r,false);
  assert.throws(()=>f.host.page({reviewId:r.reviewId},{...actor,actorId:'foreign'}),/another actor/);
  assert.throws(()=>f.host.page({reviewId:r.reviewId,limit:51},actor),/50/);
  const seen=new Set(r.items.map(x=>x.session));let cursor=r.nextCursor;while(cursor){const page=f.host.page({reviewId:r.reviewId,cursor},actor);for(const row of page.items)seen.add(row.session);cursor=page.nextCursor;}assert.equal(seen.size,500);
 }finally{await f.close();}
});

test('actual held maintenance context, not a copied fence, reset and fresh restore retain authority',async()=>{
 const f=await fixture();try{
  f.db.exec("CREATE TABLE authority(key TEXT PRIMARY KEY,payload BLOB);INSERT INTO authority VALUES('unknown-input',X'010203');INSERT INTO authority VALUES('queue-tombstone',X'040506')");const before=f.db.prepare('SELECT * FROM authority ORDER BY key').all();
  const r=await f.review(),fence=await f.acquire(),input={commandId:'reset',reviewId:r.reviewId,reviewHash:r.reviewHash,maintenance:fence};
  await assert.rejects(f.host.apply(input,actor),/current recovery maintenance/);assert.equal(f.stats().writes,0);
  const result=await f.gate.maintain(fence,()=>f.host.apply(input,actor));assert.equal(result.effect.status,'completed');assert.equal(result.protection,'released');assert.equal(result.effect.revision,1);assert.equal(f.rows.get('ahp-session:/0002').nativeDeleted,true);
  assert.deepEqual(await f.host.apply(input,actor),result);assert.equal(f.stats().writes,1);await assert.rejects(f.host.apply({...input,reviewHash:'wrong'},actor),/hash/);
  const undo=await f.review('undo-review',undefined,'restore','reset');const restored=await f.gate.maintain(fence,()=>f.host.apply({commandId:'undo',reviewId:undo.reviewId,reviewHash:undo.reviewHash,maintenance:fence},actor));assert.equal(restored.effect.status,'completed');assert.equal(f.rows.get('ahp-session:/0000').productHidden,false);assert.equal(f.rows.get('ahp-session:/0002').nativeDeleted,true);assert.deepEqual(f.db.prepare('SELECT * FROM authority ORDER BY key').all(),before);
  await assert.rejects(f.review('stale-undo',undefined,'restore','reset'),/unchanged/);
  const barrier=pause();let detached:any;await f.gate.maintain(fence,async()=>{detached=barrier.promise.then(()=>f.gate.assertRecoveryMaintenance(fence));});barrier.release();await assert.rejects(detached,/current recovery/);
 }finally{await f.close();}
});

test('mixed prior hidden flags restore exactly; required references refuse while missing coverage retains unknown',async()=>{
 const f=await fixture();try{
  let r=await f.review('first',['ahp-session:/0000']),fence=await f.acquire();await f.gate.maintain(fence,()=>f.host.apply({commandId:'first',reviewId:r.reviewId,reviewHash:r.reviewHash,maintenance:fence},actor));
  r=await f.review('second');await f.gate.maintain(fence,()=>f.host.apply({commandId:'second',reviewId:r.reviewId,reviewHash:r.reviewHash,maintenance:fence},actor));
  r=await f.review('restore-second',undefined,'restore','second');await f.gate.maintain(fence,()=>f.host.apply({commandId:'restore-second',reviewId:r.reviewId,reviewHash:r.reviewHash,maintenance:fence},actor));assert.equal(f.rows.get('ahp-session:/0000').productHidden,true);assert.equal(f.rows.get('ahp-session:/0001').productHidden,false);
  f.protect([{session:'ahp-session:/0001',ownerId:'selected-owner',reasons:['future-required-work']}]);r=await f.review('protected');const refused=await f.gate.maintain(fence,()=>f.host.apply({commandId:'protected',reviewId:r.reviewId,reviewHash:r.reviewHash,maintenance:fence},actor));assert.equal(refused.effect.status,'refused');assert.equal(refused.effect.executed,false);assert.equal(f.host.inspect().ready,true);
  f.protect([]);f.coverage(false);r=await f.review('missing');const missing=await f.gate.maintain(fence,()=>f.host.apply({commandId:'missing',reviewId:r.reviewId,reviewHash:r.reviewHash,maintenance:fence},actor));assert.equal(missing.effect.status,'refused');assert.equal(missing.effect.executed,false);assert.equal(missing.protection,'unknown');assert.equal(f.host.inspect().ready,true);
 }finally{await f.close();}
});

test('lost projection acknowledgement survives reopen; passive reconcile never re-dispatches and lost release stays distinct',async()=>{
 const f=await fixture();try{
  const r=await f.review(),fence=await f.acquire();f.fail(1,true);f.loseRelease(true);const input={commandId:'lost',reviewId:r.reviewId,reviewHash:r.reviewHash,maintenance:fence};const lost=await f.gate.maintain(fence,()=>f.host.apply(input,actor));assert.equal(lost.effect.status,'unknown');assert.equal(f.host.inspect().ready,false);
  f.restart();assert.equal(f.host.inspect().ready,false);assert.equal((await f.host.apply(input,actor)).effect.status,'unknown');const repaired=await f.host.reconcile('lost',actor);assert.equal(repaired!.effect.status,'completed');assert.equal(repaired!.protection,'unknown');assert.equal(f.stats().writes,1);
  f.loseRelease(false);assert.equal((await f.host.reconcile('lost',actor))!.protection,'released');assert.equal(f.stats().writes,1);
 }finally{await f.close();}
});

test('105-row partial projection remains fenced, explicit rebuild repairs metadata and flags without replaying original effect',async()=>{
 const f=await fixture(105);try{
  const r=await f.review(),fence=await f.acquire();f.fail(2);const input={commandId:'partial',reviewId:r.reviewId,reviewHash:r.reviewHash,maintenance:fence};assert.equal((await f.gate.maintain(fence,()=>f.host.apply(input,actor))).effect.status,'unknown');assert.equal(f.stats().writes,2);
  assert.equal((await f.host.reconcile('partial',actor))!.effect.status,'unknown');assert.equal(f.stats().writes,2);await assert.rejects(f.host.read(async()=>[]),/unavailable/);
  f.clearCatalog();f.fail(0);const rebuild=await f.gate.maintain(fence,()=>f.host.rebuild({commandId:'rebuild',expectedRevision:1,maintenance:fence},actor));assert.equal(rebuild.status,'completed');assert.equal(rebuild.count,105);assert.equal(rebuild.markerCount,105);assert.equal(f.rows.size,105);assert.equal([...f.rows.values()].every(x=>x.productHidden),true);assert.equal(f.host.inspect().ready,true);
  assert.equal((await f.host.reconcile('partial',actor))!.effect.status,'completed');assert.equal(f.stats().writes,4);assert.equal(f.rows.get('ahp-session:/0002').nativeDeleted,true);
 }finally{await f.close();}
});

test('empty rebuild requires explicit completion; missing page and changed checkpoint cannot open reads',async()=>{
 const f=await fixture(0);try{
  const fence=await f.acquire();const result=await f.gate.maintain(fence,()=>f.host.rebuild({commandId:'empty',expectedRevision:0,maintenance:fence},actor));assert.equal(result.status,'completed');assert.equal(result.count,0);assert.equal(f.stats().writes,1);assert.equal(f.host.inspect().projectionRevision,1);
  f.checkpoints.clear();await assert.rejects(f.host.read(async()=>[]),/unavailable/);assert.equal(f.host.inspect().ready,false);
 }finally{await f.close();}
});

test('an in-flight catalog read cannot escape a concurrently closed presentation fence',async()=>{
 const f=await fixture(),entered=pause(),resume=pause();try{
  const pending=f.host.read(async()=>{entered.release();await resume.promise;return ['stale-visible-row'];});await entered.promise;
  const r=await f.review(),fence=await f.acquire();await f.gate.maintain(fence,()=>f.host.apply({commandId:'reset',reviewId:r.reviewId,reviewHash:r.reviewHash,maintenance:fence},actor));resume.release();await assert.rejects(pending,/changed/);
 }finally{resume.release();await f.close();}
});

test('large titles use byte-bounded preview pages without dropping reviewed rows',async()=>{
 const f=await fixture(50);try{for(const row of f.rows.values())row.title='A'.repeat(7000);const r=await f.review();assert.ok(r.items.length<50);assert.ok(Buffer.byteLength(JSON.stringify(r))<270000);const seen=new Set(r.items.map(x=>x.session));let cursor=r.nextCursor;while(cursor){const p=f.host.page({reviewId:r.reviewId,cursor},actor);p.items.forEach(row=>seen.add(row.session));cursor=p.nextCursor;}assert.equal(seen.size,50);}finally{await f.close();}
});

test('late readiness replies cannot overwrite a newer reset state',async()=>{
 const f=await fixture(),entered=pause(),resume=pause();try{
  const original=f.ports.projectionStatus;let first=true;f.ports.projectionStatus=async source=>{const value=await original(source);if(first){first=false;entered.release();await resume.promise;}return value;};
  const stale=f.host.checkReady();await entered.promise;const r=await f.review(),fence=await f.acquire();f.fail(1);await f.gate.maintain(fence,()=>f.host.apply({commandId:'unknown',reviewId:r.reviewId,reviewHash:r.reviewHash,maintenance:fence},actor));resume.release();await stale;assert.equal(f.host.inspect().phase,'unknown');assert.equal(f.host.inspect().revision,1);assert.equal(f.host.inspect().ready,false);
 }finally{resume.release();await f.close();}
});

test('distribution-update maintenance cannot grant presentation recovery authority',async()=>{
 const f=await fixture();try{const r=await f.review();const gate:any=await f.gate.admit({commandId:'update',purpose:'distribution-update'});assert.equal(gate.admitted,true);await assert.rejects(f.gate.maintain(gate,()=>f.host.apply({commandId:'wrong-purpose',reviewId:r.reviewId,reviewHash:r.reviewHash,maintenance:{fenceId:gate.fenceId,commandId:'update'}},actor)),/recovery maintenance/);assert.equal(f.stats().writes,0);assert.equal(f.host.effect('wrong-purpose'),null);}finally{await f.close();}
});
