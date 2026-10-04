import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ConversationPresentation,type PresentationPorts} from '../src/presentation.js';
import type {PresentationActor} from '../src/presentation-types.js';
const actor:PresentationActor={actorId:'authenticated-user',origin:'ui'};
const pause=()=>{let release!:()=>void;const promise=new Promise<void>(r=>release=r);return {promise,release};};
async function fixture(count=3){
 const directory=await mkdtemp(join(tmpdir(),'presentation-')),path=join(directory,'host.sqlite');let db=new DatabaseSync(path),host:ConversationPresentation;
 const rows=new Map<string,any>(),checkpoints=new Map<string,number>(),receipts=new Map<string,any>();
 for(let i=0;i<count;i++){const uri='ahp-session:/'+String(i).padStart(4,'0');rows.set(uri,{uri,engineId:'fixture',nativeSessionId:'native-'+i,workingDirectory:'/workspace',title:'Conversation '+i,createdAt:'2026-01-01',modifiedAt:'2026-01-01',nativeDeleted:i===2,workspaceAvailability:'present'});}
 let writes=0,failAt=0,failAfter=false,metadataReads=0;
 const ports:PresentationPorts={
  metadata:async session=>{metadataReads++;const row=rows.get(session)??host.mapping(session);return {identity:{session,engineId:row.engineId,nativeSessionId:row.nativeSessionId,workingDirectory:row.workingDirectory},title:row.title,catalog:{...row,productHidden:undefined}};},
  withSelection:async(_sessions,work)=>work(),validateSelection:async()=>{},
  projectionStatus:async source=>({source,revision:checkpoints.get(source)??0}),projectionReceipt:async(_source,id)=>receipts.get(id)??null,
  project:async request=>{writes++;if(writes===failAt&&!failAfter)throw Error('No projection receipt');const prior=receipts.get(request.commandId);if(prior)return prior;
   assert.equal(request.afterRevision,checkpoints.get(request.source)??0);for(const item of request.items){assert.ok(rows.has(item.uri));rows.get(item.uri).productHidden=item.hidden;}
   const result={source:request.source,commandId:request.commandId,revision:request.throughRevision,projected:request.items.length};checkpoints.set(request.source,result.revision);receipts.set(request.commandId,result);if(writes===failAt&&failAfter)throw Error('Lost acknowledgement');return result;
  },catalogGet:async session=>rows.get(session),catalogFreshness:async()=>({phase:'complete',issues:0}),changed:()=>{},
  mappings:async()=>({items:[]}),reconstructMetadata:async request=>{let cursor:string|undefined;do{const page=request.readMappings(cursor);for(const row of page.items)rows.set(row.uri as string,structuredClone(row));cursor=page.nextCursor??undefined;}while(cursor);},
 };
 const open=()=>{host=new ConversationPresentation(db,ports);};open();await host.checkReady();
 const review=async(command='review',ids=[...rows.keys()],operation:'reset'|'restore'='reset',resetCommandId?:string)=>host.prepare({commandId:command,operation,selection:{kind:'explicit',sessionIds:ids},resetCommandId},actor);
 const apply=(review:any,commandId='reset')=>host.apply({commandId,reviewId:review.reviewId,reviewHash:review.reviewHash},actor);
 return {rows,ports,checkpoints,receipts,get host(){return host;},get db(){return db;},review,apply,stats:()=>({writes,metadataReads}),fail:(at:number,after=false)=>{failAt=at;failAfter=after;},
  restart:()=>{db.close();db=new DatabaseSync(path);open();},clearCatalog:()=>{rows.clear();checkpoints.clear();receipts.clear();},close:async()=>{db.close();await rm(directory,{recursive:true,force:true});}};
}

test('bounded immutable explicit selection and actor binding precede metadata reads',async()=>{
 const f=await fixture(501);try{
  await assert.rejects(f.review(),/Bounded explicit/);assert.equal(f.stats().metadataReads,0);
  await assert.rejects(f.review('dup',['ahp-session:/0000','ahp-session:/0000']),/Duplicate/);
  const r=await f.review('500',[...f.rows.keys()].slice(0,500));assert.equal(r.count,500);assert.equal(r.items.length,50);assert.ok(r.nextCursor);assert.equal('identity' in r.items[0],false);assert.equal('actor' in r,false);
  assert.throws(()=>f.host.page({reviewId:r.reviewId},{...actor,actorId:'foreign'}),/another actor/);
  await assert.rejects(f.host.apply({commandId:'foreign',reviewId:r.reviewId,reviewHash:r.reviewHash},{...actor,actorId:'foreign'}),/actor/);
  const ids=[];let page=r;for(;;){ids.push(...page.items.map(row=>row.session));if(!page.nextCursor)break;page=f.host.page({reviewId:r.reviewId,cursor:page.nextCursor},actor);}assert.equal(new Set(ids).size,500);assert.equal(f.stats().writes,0);
 }finally{await f.close();}
});

test('reset and undo preserve unrelated authority, mixed prior flags and native exclusions',async()=>{
 const f=await fixture();try{
  f.db.exec('CREATE TABLE authority(kind TEXT PRIMARY KEY,payload BLOB);');for(const kind of ['unknown-receipt','queue-tombstone','provenance','fence'])f.db.prepare('INSERT INTO authority VALUES(?,?)').run(kind,Buffer.from('original '+kind));
  const before=f.db.prepare('SELECT * FROM authority ORDER BY kind').all();const first=await f.review('first',['ahp-session:/0000']);await f.apply(first,'first');
  const all=await f.review();const reset=await f.apply(all);assert.equal(reset.effect.status,'completed');assert.equal(reset.projection.status,'ready');
  assert.equal((await f.apply(all)).effect.revision,2);assert.equal(f.stats().writes,2);
  const undo=await f.review('undo',undefined,'restore','reset');await f.apply(undo,'undo');assert.equal(f.rows.get('ahp-session:/0000').productHidden,true);assert.equal(f.rows.get('ahp-session:/0001').productHidden,false);assert.equal(f.rows.get('ahp-session:/0002').nativeDeleted,true);
  assert.deepEqual(f.db.prepare('SELECT * FROM authority ORDER BY kind').all(),before);
 }finally{await f.close();}
});

test('disjoint prepared resets and undos coexist; selected identity and row revision still CAS',async()=>{
 const f=await fixture();try{
  const a=await f.review('a',['ahp-session:/0000']),b=await f.review('b',['ahp-session:/0001']);await f.apply(a,'a');await f.apply(b,'b');
  const undoA=await f.review('undo-a',['ahp-session:/0000'],'restore','a'),undoB=await f.review('undo-b',['ahp-session:/0001'],'restore','b');
  assert.equal((await f.apply(undoA,'undo-a')).effect.status,'completed');assert.equal((await f.apply(undoB,'undo-b')).effect.status,'completed');
  await assert.rejects(f.review('stale',['ahp-session:/0000'],'restore','a'),/Selected row changed/);
  const c=await f.review('c',['ahp-session:/0000']);f.rows.get('ahp-session:/0000').nativeSessionId='foreign';const refused=await f.apply(c,'c');assert.equal(refused.effect.status,'refused');assert.equal(refused.effect.executed,false);assert.match(refused.effect.reason!,/identity/);
  assert.deepEqual(await f.apply(c,'c'),refused);
 }finally{await f.close();}
});

test('mutable title changes do not revoke a reviewed native identity; held selected work refuses before markers',async()=>{
 const f=await fixture();try{
  const r=await f.review('title',['ahp-session:/0000']);f.rows.get('ahp-session:/0000').title='New title';assert.equal((await f.apply(r,'title')).effect.status,'completed');
  const next=await f.review('busy',['ahp-session:/0001']);f.ports.validateSelection=async()=>{throw Error('Selected active input');};const refused=await f.apply(next,'busy');assert.equal(refused.effect.status,'refused');assert.equal(refused.effect.executed,false);assert.equal(f.host.hidden('ahp-session:/0001'),false);
 }finally{await f.close();}
});

for(const failure of [{at:1,after:false,label:'after marker before first projection'},{at:2,after:false,label:'between pages'},{at:2,after:true,label:'after final projection before acknowledgement'}])test('restart repair '+failure.label,async()=>{
 const f=await fixture(105);try{
  const r=await f.review();f.fail(failure.at,failure.after);const receipt=await f.apply(r);assert.equal(receipt.effect.status,'completed');assert.equal(receipt.projection.status,'unknown');assert.equal(f.host.inspect().ready,false);assert.equal(f.host.inspect().revision,1);
  const original=f.host.effect('reset');f.restart();const calls=f.stats().writes;assert.equal((await f.apply(r)).effect.status,'completed');assert.equal(f.stats().writes,calls);
  const observed=await f.host.reconcile('reset',actor);assert.equal(f.stats().writes,calls);if(failure.after)assert.equal(observed?.projection.status,'ready');else assert.equal(observed?.projection.status,'unknown');
  const repair=await f.host.rebuild({commandId:'repair',expectedRevision:1},actor);assert.equal(repair.status,'completed');assert.equal(repair.markerCount,105);assert.equal(f.host.inspect().ready,true);assert.equal(f.host.receipt('reset',actor)?.projection.status,'ready');assert.equal(f.host.effect('reset')?.revision,original?.revision);assert.equal(f.host.effect('reset')?.selectionHash,original?.selectionHash);
  for(const row of f.rows.values())assert.equal(row.productHidden,true);
 }finally{await f.close();}
});

test('catalog loss restores exact mappings and false flags; incomplete reconstruction never opens listing',async()=>{
 const f=await fixture(105);try{
  await f.apply(await f.review());await f.apply(await f.review('undo',undefined,'restore','reset'),'undo');f.clearCatalog();f.restart();await f.host.checkReady();assert.equal(f.host.inspect().ready,false);
  const reconstruct=f.ports.reconstructMetadata!;f.ports.reconstructMetadata=async()=>{};const missing=await f.host.rebuild({commandId:'missing',expectedRevision:2},actor);assert.equal(missing.status,'unknown');assert.equal(f.host.inspect().ready,false);
  f.ports.reconstructMetadata=reconstruct;const rebuilt=await f.host.rebuild({commandId:'rebuild',expectedRevision:2},actor);assert.equal(rebuilt.status,'completed');assert.equal(f.rows.size,105);assert.ok([...f.rows.values()].every(row=>row.productHidden===false));
 }finally{await f.close();}
});

test('empty reconstruction requires explicit checkpoint; lost rebuild reply is passively observable',async()=>{
 const f=await fixture(0);try{f.fail(1,true);const result=await f.host.rebuild({commandId:'empty',expectedRevision:0},actor);assert.equal(result.status,'unknown');assert.equal(f.host.inspect().ready,false);f.restart();const done=await f.host.reconcileRebuild('empty',actor);assert.equal(done?.status,'completed');assert.equal(f.stats().writes,1);assert.equal(f.host.inspect().ready,true);}finally{await f.close();}
});

test('readiness and in-flight discovery cannot escape newer selected markers',async()=>{
 const f=await fixture(),entered=pause(),resume=pause();try{
  const reading=f.host.read(async()=>{entered.release();await resume.promise;return 'stale-visible';});await entered.promise;f.fail(1);await f.apply(await f.review());resume.release();await assert.rejects(reading,/unavailable|changed/);
 }finally{resume.release();await f.close();}
});

test('preview byte pages are complete and bounded; oversized review refuses without truncation',async()=>{
 const f=await fixture(50);try{
  for(const row of f.rows.values())row.title='x'.repeat(7000);const r=await f.review();assert.ok(r.items.length<50);assert.ok(Buffer.byteLength(JSON.stringify(r.items))<=256*1024);const p=f.host.page({reviewId:r.reviewId,cursor:r.nextCursor!},actor);assert.equal(r.items.length+p.items.length,50);
  f.rows.get('ahp-session:/0000').title='x'.repeat(20000);await assert.rejects(f.review('too-large'),/bounds/);assert.equal(f.stats().writes,0);
 }finally{await f.close();}
});
test('selected family discovery and metadata reconstruction exclude each other before writes',async()=>{
 const f=await fixture(),entered=pause(),resume=pause();let discoveries=0,reconstructions=0;
 try{
  const original=f.ports.reconstructMetadata!;f.ports.reconstructMetadata=async request=>{reconstructions++;await original(request);};
  const writer=f.host.discoverFamily('ahp-session:/0000',async()=>{discoveries++;entered.release();await resume.promise;return 'family';});await entered.promise;
  await assert.rejects(f.host.rebuild({commandId:'during-family',expectedRevision:0},actor),/transaction already/);assert.equal(reconstructions,0);assert.equal(f.host.hintDiagnostics().inFlight,true);resume.release();assert.equal(await writer,'family');
  const rebuilding=pause(),finish=pause();f.ports.reconstructMetadata=async request=>{reconstructions++;rebuilding.release();await finish.promise;await original(request);};
  const rebuild=f.host.rebuild({commandId:'after-family',expectedRevision:0},actor);await rebuilding.promise;
  await assert.rejects(f.host.discoverFamily('ahp-session:/0000',async()=>{discoveries++;}),/transaction already/);assert.equal(discoveries,1);finish.release();assert.equal((await rebuild).status,'completed');
 }finally{resume.release();await f.close();}
});
test('unknown selected-family writer survives restart and blocks reconstruction without exact owner settlement',async()=>{
 const f=await fixture();let reconstructions=0;
 try{
  f.ports.reconstructMetadata=async()=>{reconstructions++;};await assert.rejects(f.host.discoverFamily('ahp-session:/0000',async()=>{throw Error('lost reply');}),/lost reply/);assert.equal(f.host.hintDiagnostics().unsettled,true);f.restart();
  const rebuild=await f.host.rebuild({commandId:'unknown-family',expectedRevision:0},actor);assert.equal(rebuild.status,'unknown');assert.equal(reconstructions,0);assert.equal(f.host.hintDiagnostics().unsettled,true);assert.equal(f.host.inspect().ready,false);
 }finally{await f.close();}
});

test('failed reconstruction blocks selected-family writers across restart until exact reconstruction completes',async()=>{
 const f=await fixture();let discoveries=0;const reconstruct=f.ports.reconstructMetadata!;
 try{
  f.ports.reconstructMetadata=async()=>{throw Error('Reconstruction result unavailable');};const failed=await f.host.rebuild({commandId:'failed-reconstruction',expectedRevision:0},actor);assert.equal(failed.status,'unknown');assert.equal(f.host.inspect().phase,'unknown');
  await assert.rejects(f.host.discoverFamily('ahp-session:/0000',async()=>{discoveries++;}),/Retained presentation outcome is unknown/);assert.equal(discoveries,0);assert.equal(f.host.hintDiagnostics().unsettled,false);
  f.restart();await assert.rejects(f.host.discoverFamily('ahp-session:/0000',async()=>{discoveries++;}),/Retained presentation outcome is unknown/);assert.equal(discoveries,0);
  f.ports.reconstructMetadata=reconstruct;assert.equal((await f.host.rebuild({commandId:'exact-reconstruction',expectedRevision:0},actor)).status,'completed');assert.equal(await f.host.discoverFamily('ahp-session:/0000',async()=>{discoveries++;return 'complete';}),'complete');assert.equal(discoveries,1);
 }finally{await f.close();}
});
