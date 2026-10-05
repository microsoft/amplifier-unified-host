import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {ConversationPresentation,type PresentationPorts} from '../src/presentation.js';
const initial='11111111-1111-4111-8111-111111111111',replacement='22222222-2222-4222-8222-222222222222';
const actor={actorId:'fixture-user',origin:'ui' as const};
const pause=()=>{let release!:()=>void;const promise=new Promise<void>(r=>release=r);return {promise,release};};
async function fixture(){
 const db=new DatabaseSync(':memory:');let host:ConversationPresentation,phase='complete',index=initial,peer='new',checkpoint=0;let statusHook:(()=>Promise<void>)|undefined;
 const calls={freshness:0,project:0,hint:0,validate:0,changed:0,status:0};
 const row={uri:'ahp-session:/root',engineId:'fixture',nativeSessionId:'root',workingDirectory:'/fixture',title:'Root'};
 const receipts=new Map();
 const ports:PresentationPorts={metadata:async()=>({identity:{session:row.uri,engineId:row.engineId,nativeSessionId:row.nativeSessionId,workingDirectory:row.workingDirectory},title:row.title,catalog:row}),withSelection:async(_s,work)=>work(),validateSelection:async()=>{calls.validate++;},mappings:async()=>({items:[]}),projectionStatus:async source=>{calls.status++;await statusHook?.();return {source,revision:checkpoint,...(peer==='old'?{}:peer==='partial'?{indexIncarnation:index}:{indexIncarnation:index,projectionPresent:checkpoint>0})};},project:async request=>{calls.project++;checkpoint=request.throughRevision;const result={source:request.source,commandId:request.commandId,revision:checkpoint,projected:request.items.length};receipts.set(request.commandId,result);return result;},projectionReceipt:async(_s,id)=>receipts.get(id)??null,catalogGet:async()=>({...row,productHidden:host.hidden(row.uri)}),catalogFreshness:async()=>{calls.freshness++;return {phase,issues:0};},changed:()=>{calls.changed++;},hint:async()=>{calls.hint++;}};
 const reopen=()=>host=new ConversationPresentation(db,ports);reopen();
 const state=()=>JSON.parse(String(db.prepare('SELECT payload FROM presentation_state WHERE id=1').get()!.payload));
 const save=(value:object)=>db.prepare('UPDATE presentation_state SET payload=? WHERE id=1').run(JSON.stringify(value));
 const changes=()=>Number(db.prepare('SELECT total_changes() n').get()!.n);
 return {db,ports,calls,row,get host(){return host;},reopen,state,save,changes,setPhase:(v:string)=>{phase=v;},setIndex:(v:string)=>{index=v;},setPeer:(v:string)=>{peer=v;},loseCheckpoint:()=>{checkpoint=0;},hook:(fn?:()=>Promise<void>)=>{statusHook=fn;},close:async()=>{await host.close();db.close();}};
}
for(const positive of [false,true])test(`retained ${positive?'positive':'zero'} refresh read neither qualifies nor wakes writes`,async()=>{
 const f=await fixture();try{
  await f.host.checkReady(false);assert.equal(f.state().acknowledgedIndexIncarnation,initial);
  if(positive){const r=await f.host.prepare({commandId:'review',operation:'reset',selection:{kind:'explicit',sessionIds:[f.row.uri]}},actor);assert.equal((await f.host.apply({commandId:'reset',reviewId:r.reviewId,reviewHash:r.reviewHash},actor)).projection.status,'ready');}
  await f.host.close();f.setPhase('running');f.reopen();assert.equal(f.state().ready,false);
  f.db.prepare('INSERT INTO presentation_hints VALUES(?,1)').run('/queued-location');
  const before=f.state(),count=f.changes(),calls={...f.calls};let reads=0;
  assert.equal(await f.host.read(async()=>{reads++;return 'retained-page';}),'retained-page');
  assert.equal(reads,1);assert.deepEqual(f.state(),before);assert.equal(f.changes(),count);
  assert.deepEqual({...f.calls,status:calls.status},calls);assert.equal(f.calls.status-calls.status,2);
  assert.equal(f.host.hintDiagnostics().pending,1);assert.equal(f.calls.hint,0);assert.equal(f.state().ready,false);
 }finally{await f.close();}
});
test('policy revision and projection sequence are independent retained facts',async()=>{
 const f=await fixture();try{await f.host.checkReady(false);f.save({...f.state(),revision:7,projectionRevision:0});let calls=0;await assert.rejects(f.host.read(async()=>{calls++;}),/no qualified projection/);assert.equal(calls,0);}finally{await f.close();}
});
for(const phase of ['unknown','applying','rebuilding'])test(`unchanged checkpoint cannot admit ${phase} visibility`,async()=>{
 const f=await fixture();try{await f.host.checkReady(false);f.save({...f.state(),ready:false,phase});const before=f.changes();let calls=0;await assert.rejects(f.host.read(async()=>{calls++;}),/unresolved/);assert.equal(calls,0);assert.equal(f.changes(),before);}finally{await f.close();}
});
test('missing legacy acknowledgment requires complete qualification once',async()=>{
 const f=await fixture();try{f.setPhase('running');let calls=0;await assert.rejects(f.host.read(async()=>{calls++;}),/unavailable/);assert.equal(calls,0);assert.equal(f.state().acknowledgedIndexIncarnation,undefined);f.setPhase('complete');await f.host.read(async()=>{calls++;});assert.equal(f.state().acknowledgedIndexIncarnation,initial);f.setPhase('running');await f.host.close();f.reopen();await f.host.read(async()=>{calls++;});assert.equal(calls,2);assert.equal(f.state().ready,false);}finally{await f.close();}
});
test('old peer follows old coverage gate without invented acknowledgment',async()=>{
 const f=await fixture();try{f.setPeer('old');await f.host.checkReady(false);assert.equal(f.state().acknowledgedIndexIncarnation,undefined);await f.host.close();f.setPhase('running');f.reopen();await assert.rejects(f.host.read(async()=>{}),/unavailable/);f.setPhase('complete');await f.host.read(async()=>{});assert.equal(f.state().acknowledgedIndexIncarnation,undefined);}finally{await f.close();}
});
test('partial new peer never downgrades to old-peer success',async()=>{
 const f=await fixture();try{await f.host.checkReady(false);f.setPeer('partial');let calls=0;const before=f.changes();await assert.rejects(f.host.read(async()=>{calls++;}),/Invalid catalog/);assert.equal(calls,0);assert.equal(f.changes(),before);await f.host.checkReady(false);assert.equal(f.state().ready,false);assert.equal(f.state().acknowledgedIndexIncarnation,initial);}finally{await f.close();}
});
for(const positive of [false,true])test(`changed ${positive?'positive':'zero'} database never rebounds through full scan`,async()=>{
 const f=await fixture();try{await f.host.checkReady(false);if(positive){const r=await f.host.prepare({commandId:'review',operation:'reset',selection:{kind:'explicit',sessionIds:[f.row.uri]}},actor);await f.host.apply({commandId:'reset',reviewId:r.reviewId,reviewHash:r.reviewHash},actor);}await f.host.close();f.reopen();f.setIndex(replacement);await assert.rejects(f.host.read(async()=>{}),/identity or checkpoint differs/);await f.host.checkReady(false);assert.equal(f.state().ready,false);assert.equal(f.state().acknowledgedIndexIncarnation,initial);}finally{await f.close();}
});
test('lost positive checkpoint refuses without writes or receipt settlement',async()=>{
 const f=await fixture();try{await f.host.checkReady(false);const r=await f.host.prepare({commandId:'review',operation:'reset',selection:{kind:'explicit',sessionIds:[f.row.uri]}},actor);await f.host.apply({commandId:'reset',reviewId:r.reviewId,reviewHash:r.reviewHash},actor);f.loseCheckpoint();const before=f.changes();await assert.rejects(f.host.read(async()=>{}),/identity or checkpoint differs/);assert.equal(f.changes(),before);}finally{await f.close();}
});
test('same-revision unknown hold while status awaits refuses before page',async()=>{
 const f=await fixture();try{await f.host.checkReady(false);const gate=pause(),entered=pause();f.hook(async()=>{entered.release();await gate.promise;});let calls=0;const reading=f.host.read(async()=>{calls++;});await entered.promise;f.save({...f.state(),ready:false,phase:'unknown'});gate.release();await assert.rejects(reading,/changed or is unresolved/);assert.equal(calls,0);}finally{await f.close();}
});
for(const change of ['phase','revision','projectionRevision','source','acknowledgedIndexIncarnation','working','catalog'])test(`mid-read ${change} change refuses returned page`,async()=>{
 const f=await fixture();try{await f.host.checkReady(false);await assert.rejects(f.host.read(async()=>{if(change==='working')(f.host as any).working=true;else if(change==='catalog')f.setIndex(replacement);else f.save({...f.state(),[change]:change==='phase'?'unknown':change==='revision'||change==='projectionRevision'?1:replacement});return 'must not escape';}),/changed|differs/);}finally{(f.host as any).working=false;await f.close();}
});
test('qualification replacement and same-revision hold never capture an acknowledgment',async()=>{
 const f=await fixture();try{let calls=0;f.hook(async()=>{if(++calls===2)f.setIndex(replacement);});await f.host.checkReady(false);assert.equal(f.state().ready,false);assert.equal(f.state().acknowledgedIndexIncarnation,undefined);f.hook();f.setIndex(initial);const gate=pause(),entered=pause();f.ports.catalogFreshness=async()=>{entered.release();await gate.promise;return {phase:'complete',issues:0};};const ready=f.host.checkReady(false);await entered.promise;f.save({...f.state(),phase:'unknown'});gate.release();await ready;assert.equal(f.state().acknowledgedIndexIncarnation,undefined);assert.equal(f.state().phase,'unknown');}finally{await f.close();}
});
