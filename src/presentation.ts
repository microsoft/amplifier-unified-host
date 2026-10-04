import {CatalogHints} from './catalog-hints.js';
import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {PresentationActor,PresentationPrepare,PresentationApply,PresentationIdentity,PresentationReadiness,PresentationEffectReceipt,VisibilityProjectionRequest,VisibilityProjectionReceipt,PresentationRebuild,PresentationReceipt,PresentationReviewPage,PresentationMappingPage,ConversationPresentationConfig} from './presentation-types.js';

type Json=Record<string,any>;
export interface PresentationMetadata {identity:PresentationIdentity;title:string;catalog:Json;hostBeforeImage?:Json;}
export interface PresentationPorts {
 hint?:(path:string,context:{attemptId:string})=>Promise<unknown>;
 settleDiscovery?:ConversationPresentationConfig['settleDiscovery'];
 metadata(session:string):Promise<PresentationMetadata>;
 withSelection<T>(sessions:string[],work:()=>Promise<T>):Promise<T>;
 validateSelection(sessions:PresentationIdentity[]):Promise<void>;
 reconstructMetadata?:(request:{commandId:string;source:string;readMappings:(cursor?:string)=>PresentationMappingPage})=>Promise<void>;
 mappings(after?:string):Promise<{items:Json[];nextCursor?:string}>;
 projectionStatus(source:string):Promise<{source:string;revision:number}>;
 project(request:VisibilityProjectionRequest):Promise<VisibilityProjectionReceipt>;
 projectionReceipt(source:string,commandId:string):Promise<VisibilityProjectionReceipt|null>;
 catalogGet(session:string):Promise<Json|undefined>;
 catalogFreshness():Promise<{phase?:string;issues?:number}>;
 changed(sessions:Array<{session:string;hidden:boolean}>):void;
}
export class PresentationError extends Error {
 readonly code=-32015;
 constructor(message:string,readonly data:Json={executed:false}){super(message);}
}
export const PRESENTATION_LIMITS=Object.freeze({selection:500,metadataBytes:16384,reviewBytes:8*1024*1024,previewPage:50,previewBytes:256*1024,projectionPage:100,reviewMs:600000});
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const hash=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
const id=(value:unknown,name='command identity',max=256)=>{if(typeof value!=='string'||!value||[...value].length>max||/[\x00-\x1f]/.test(value))throw new PresentationError('Invalid '+name);return value;};
const uri=(value:unknown)=>{id(value,'session',512);if(!/^ahp-session:\/[^?#\s]+$/.test(value as string))throw new PresentationError('Exact AHP session identity required');return value as string;};
const revision=(value:unknown)=>{if(!Number.isSafeInteger(value)||Number(value)<0)throw new PresentationError('Exact nonnegative presentation revision required');return value as number;};
const actorKey=(value:PresentationActor)=>{if(!value||Object.keys(value).some(key=>!['actorId','origin','session'].includes(key))||!['ui','agent'].includes(value.origin))throw new PresentationError('Trusted presentation actor required');id(value.actorId,'actor identity',256);if(value.session!==undefined)uri(value.session);if(value.origin==='agent'&&!value.session)throw new PresentationError('Agent requires its trusted originating session');return canonical(value);};
const identity=(value:PresentationIdentity)=>{if(!value||Object.keys(value).sort().join(',')!=='engineId,nativeSessionId,session,workingDirectory')throw new PresentationError('Exact retained native identity required');uri(value.session);id(value.engineId,'engine',128);id(value.nativeSessionId,'native session',512);id(value.workingDirectory,'workspace',8192);return value;};

/** Product presentation authority only. Canonical and execution tables are never rewritten. */
export class ConversationPresentation {
 private working=false;
 private hints:CatalogHints;
 constructor(private db:DatabaseSync,private ports:PresentationPorts){
  db.exec(`CREATE TABLE IF NOT EXISTS presentation_state(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS presentation_reviews(id TEXT PRIMARY KEY,command_id TEXT UNIQUE NOT NULL,signature TEXT NOT NULL,payload TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS presentation_review_rows(review_id TEXT NOT NULL,ordinal INTEGER NOT NULL,session TEXT NOT NULL,metadata TEXT NOT NULL,metadata_hash TEXT NOT NULL,before_hidden INTEGER NOT NULL,before_revision INTEGER NOT NULL,target_hidden INTEGER NOT NULL,PRIMARY KEY(review_id,ordinal),UNIQUE(review_id,session));
   CREATE TABLE IF NOT EXISTS presentation_markers(session TEXT PRIMARY KEY,hidden INTEGER NOT NULL,revision INTEGER NOT NULL,identity TEXT NOT NULL,metadata TEXT NOT NULL,command_id TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS presentation_markers_visibility ON presentation_markers(hidden,session);
   CREATE TABLE IF NOT EXISTS presentation_commands(command_id TEXT PRIMARY KEY,signature TEXT NOT NULL,review_id TEXT NOT NULL,payload TEXT NOT NULL,effect TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS presentation_projection_batches(command_id TEXT NOT NULL,ordinal INTEGER NOT NULL,request TEXT NOT NULL,result TEXT,state TEXT NOT NULL,PRIMARY KEY(command_id,ordinal));
   CREATE TABLE IF NOT EXISTS presentation_mappings(session TEXT PRIMARY KEY,metadata TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS presentation_rebuilds(command_id TEXT PRIMARY KEY,signature TEXT NOT NULL,payload TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS presentation_rebuild_rows(command_id TEXT NOT NULL,ordinal INTEGER NOT NULL,session TEXT NOT NULL,metadata TEXT NOT NULL,hidden INTEGER,PRIMARY KEY(command_id,ordinal),UNIQUE(command_id,session));`);
  const old=this.state();
  if(!old)this.save({enabled:true,ready:false,revision:0,source:'host:'+randomUUID()+':conversation-presentation-v1',projectionRevision:0,phase:'checking'});
  else this.save({...old,ready:false,phase:old.phase==='ready'?'checking':old.phase,reason:old.phase==='ready'?'confirm-catalog-checkpoint':'host-restarted'});
  this.hints=new CatalogHints(db,{hint:(path,context)=>this.ports.hint!(path,context),ready:async()=>{await this.checkReady(false);return this.inspect().ready;},blocked:reason=>this.save({...this.state()!,ready:false,phase:'unknown',reason}),settle:ports.settleDiscovery});
 }
 private state():PresentationReadiness|undefined{const row=this.db.prepare('SELECT payload FROM presentation_state WHERE id=1').get();return row?JSON.parse(String(row.payload)):undefined;}
 private save(value:PresentationReadiness){this.db.prepare('INSERT INTO presentation_state VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(JSON.stringify(value));}
 inspect():PresentationReadiness{return structuredClone(this.state()!);}
 assertReadable(){const state=this.state()!;if(!state.ready)throw new PresentationError('Conversation catalog is unavailable until its exact projection is reconstructed',{available:false,phase:state.phase,reason:state.reason});}
 async read<T>(work:()=>Promise<T>):Promise<T>{await this.checkReady();this.assertReadable();const generation=canonical([this.state()!.revision,this.state()!.projectionRevision]);const value=await work();this.assertReadable();if(canonical([this.state()!.revision,this.state()!.projectionRevision])!==generation)throw new PresentationError('Conversation presentation changed during catalog read',{available:false});return value;}
 hidden(session:string){return !!this.db.prepare('SELECT 1 FROM presentation_markers WHERE session=? AND hidden=1').get(uri(session));}
 enqueueHint(path:string){if(this.ports.hint)this.hints.enqueue(path);}
 hintDiagnostics(){return this.hints.inspect();}
 async discoverFamily<T>(parentUri:string,work:()=>Promise<T>):Promise<T>{return this.serial(()=>{if(this.state()!.phase==='unknown')throw new PresentationError('Retained presentation outcome is unknown; reconstruct its exact authority before family discovery',{executed:false});return this.hints.discover({attemptId:randomUUID(),method:'reconcileFamily',parentUri},work);});}
 async close(){await this.hints.close();}
 async checkReady(wake=true){
  const state=this.state()!;if(!state.ready&&state.phase!=='checking')return this.inspect();
  try{const result=await this.ports.projectionStatus(state.source!),fresh=await this.ports.catalogFreshness();
   if(canonical(this.state())!==canonical(state))return this.inspect();
   if(result.source!==state.source||result.revision!==state.projectionRevision||!state.ready&&(fresh.phase!=='complete'||fresh.issues!==0)){this.save({...state,ready:false,phase:'checking',reason:'metadata-or-visibility-reconstruction-required'});return this.inspect();}
   if(!state.ready)this.save({...state,ready:true,phase:'ready',reason:undefined});
  }catch{if(canonical(this.state())===canonical(state))this.save({...state,ready:false,phase:'checking',reason:'catalog-unavailable'});}if(wake)this.hints.wake();return this.inspect();
 }
 private marker(session:string){const row=this.db.prepare('SELECT * FROM presentation_markers WHERE session=?').get(session) as Json|undefined;return {hidden:!!row?.hidden,revision:Number(row?.revision??0)};}
 private review(reviewId:string){const row=this.db.prepare('SELECT payload FROM presentation_reviews WHERE id=?').get(id(reviewId,'review'));if(!row)throw new PresentationError('Unknown presentation review');return JSON.parse(String(row.payload)) as Json;}
 private rows(reviewId:string,after=-1,limit=50){return this.db.prepare('SELECT * FROM presentation_review_rows WHERE review_id=? AND ordinal>? ORDER BY ordinal LIMIT ?').all(reviewId,after,limit) as Json[];}
 private async serial<T>(work:()=>Promise<T>,wait=true){if(this.working)throw new PresentationError('Presentation transaction already in progress');this.working=true;this.hints.pause();try{if(wait)await this.hints.quiet();return await work();}finally{this.working=false;this.hints.resume();}}
 async prepare(input:PresentationPrepare,actor:PresentationActor){
  if(!input||Object.keys(input).some(key=>!['commandId','operation','selection','resetCommandId'].includes(key))||!['reset','restore'].includes(input.operation))throw new PresentationError('Exact presentation review required');
  id(input.commandId);const by=actorKey(actor),signature=hash({input,actor:by});
  const existing=this.db.prepare('SELECT signature,payload FROM presentation_reviews WHERE command_id=?').get(input.commandId);
  if(existing){if(existing.signature!==signature)throw new PresentationError('Review identity conflicts with original request');return this.page({reviewId:JSON.parse(String(existing.payload)).reviewId},actor);}
  if(input.selection?.kind!=='explicit'||Object.keys(input.selection).sort().join(',')!=='kind,sessionIds'||!Array.isArray(input.selection.sessionIds)||!input.selection.sessionIds.length||input.selection.sessionIds.length>PRESENTATION_LIMITS.selection)throw new PresentationError('Bounded explicit session selection required');
  const selected=input.selection.sessionIds.map(uri).sort();if(new Set(selected).size!==selected.length)throw new PresentationError('Duplicate selected identity');
  const state=this.state()!;
  let original:Json|undefined;if(input.operation==='restore'){
   if(!input.resetCommandId)throw new PresentationError('Restore requires the original reset command');original=this.effect(input.resetCommandId)??undefined;
   if(original?.operation!=='reset'||original.status!=='completed')throw new PresentationError('Original completed reset required');
  }else if(input.resetCommandId!==undefined)throw new PresentationError('Reset cannot claim an earlier operation');
  this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare("DELETE FROM presentation_review_rows WHERE review_id IN (SELECT id FROM presentation_reviews WHERE json_extract(payload,'$.expiresAt')<=? AND id NOT IN (SELECT review_id FROM presentation_commands))").run(Date.now());this.db.prepare("DELETE FROM presentation_reviews WHERE json_extract(payload,'$.expiresAt')<=? AND id NOT IN (SELECT review_id FROM presentation_commands)").run(Date.now());this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
  const pending=Number(this.db.prepare("SELECT count(*) n FROM presentation_reviews WHERE id NOT IN (SELECT review_id FROM presentation_commands) AND json_extract(payload,'$.expiresAt')>?").get(Date.now())!.n);if(pending>=64)throw new PresentationError('Unapplied presentation review capacity reached');
  const reviewId=randomUUID(),rows:Json[]=[];let bytes=0;
  for(const session of selected){
   const metadata=await this.ports.metadata(session);identity(metadata.identity);if(metadata.identity.session!==session)throw new PresentationError('Selected identity changed');
   const payload=canonical(metadata);bytes+=Buffer.byteLength(payload);if(Buffer.byteLength(payload)>PRESENTATION_LIMITS.metadataBytes||bytes>PRESENTATION_LIMITS.reviewBytes)throw new PresentationError('Presentation metadata exceeds reviewed bounds');
   const before=this.marker(session);let target=true;
   if(original){const saved=this.db.prepare('SELECT before_hidden,metadata FROM presentation_review_rows WHERE review_id=? AND session=?').get(original.reviewId,session);if(!saved||canonical(JSON.parse(String(saved.metadata)).identity)!==canonical(metadata.identity))throw new PresentationError('Restore selection or identity differs from retained original');if(before.revision!==original.revision)throw new PresentationError('Selected row changed after reset');target=!!saved.before_hidden;}
   rows.push({session,metadata,payload,metadataHash:hash(metadata),before,target});
  }
  const selectionHash=hash(rows.map(row=>({identity:row.metadata.identity,metadataHash:row.metadataHash,before:row.before,targetHidden:row.target}))),expiresAt=Date.now()+PRESENTATION_LIMITS.reviewMs;
  const review:Json={reviewId,commandId:input.commandId,operation:input.operation,observedRevision:state.revision,resetCommandId:input.resetCommandId,actor:by,selectionHash,count:rows.length,bytes,expiresAt,preservesCanonical:true,preservesAuthority:true,eligibility:'requires-selected-validation'};review.reviewHash=hash(review);
  this.db.exec('BEGIN IMMEDIATE');try{
   for(const row of rows){const current=this.marker(row.session);if(current.revision!==row.before.revision||current.hidden!==row.before.hidden)throw new PresentationError('Selected presentation changed while preparing review');}
   this.db.prepare('INSERT INTO presentation_reviews VALUES(?,?,?,?)').run(reviewId,input.commandId,signature,JSON.stringify(review));
   for(let n=0;n<rows.length;n++){const row=rows[n];this.retainMapping(row.metadata.catalog);this.db.prepare('INSERT INTO presentation_review_rows VALUES(?,?,?,?,?,?,?,?)').run(reviewId,n,row.session,row.payload,row.metadataHash,Number(row.before.hidden),row.before.revision,Number(row.target));}
   this.db.exec('COMMIT');
  }catch(error){this.db.exec('ROLLBACK');throw error;}
  return this.page({reviewId},actor);
 }
 page(input:{reviewId:string;cursor?:string;limit?:number},actor:PresentationActor):PresentationReviewPage{
  const review=this.review(input.reviewId),limit=input.limit??50;if(review.actor!==actorKey(actor))throw new PresentationError('Review belongs to another actor');if(!Number.isSafeInteger(limit)||limit<1||limit>50)throw new PresentationError('Preview page is limited to 50 entries');
  let after=-1;if(input.cursor!==undefined){try{const decoded=JSON.parse(Buffer.from(input.cursor,'base64url').toString());if(decoded.reviewId!==review.reviewId||decoded.reviewHash!==review.reviewHash||!Number.isSafeInteger(decoded.after)||decoded.after<0||decoded.after>=review.count)throw Error();after=decoded.after;}catch{throw new PresentationError('Invalid immutable review cursor');}}
  const rows:Json[]=[];let pageBytes=0;for(const row of this.rows(review.reviewId,after,limit)){const publicRow={session:row.session,title:JSON.parse(row.metadata).title,priorHidden:!!row.before_hidden,targetHidden:!!row.target_hidden};const bytes=Buffer.byteLength(JSON.stringify(publicRow));if(pageBytes+bytes>PRESENTATION_LIMITS.previewBytes)break;pageBytes+=bytes;rows.push(row);}const last=rows.at(-1),nextCursor=last&&Number(last.ordinal)+1<review.count?Buffer.from(JSON.stringify({reviewId:review.reviewId,reviewHash:review.reviewHash,after:Number(last.ordinal)})).toString('base64url'):null;
  const {actor:privateActor,...publicReview}=review;return {...publicReview,items:rows.map(row=>({session:row.session,title:JSON.parse(row.metadata).title,priorHidden:!!row.before_hidden,targetHidden:!!row.target_hidden})),nextCursor} as PresentationReviewPage;
 }
 effect(commandId:string):PresentationEffectReceipt|null{const row=this.db.prepare('SELECT effect FROM presentation_commands WHERE command_id=?').get(id(commandId));return row?JSON.parse(String(row.effect)):null;}
 receipt(commandId:string,actor?:PresentationActor):PresentationReceipt|null{const row=this.db.prepare('SELECT payload,effect,review_id FROM presentation_commands WHERE command_id=?').get(id(commandId));if(!row)return null;const payload=JSON.parse(String(row.payload));if(actor&&this.review(String(row.review_id)).actor!==actorKey(actor))throw new PresentationError('Receipt belongs to another actor');const effect=JSON.parse(String(row.effect)),state=this.state()!,projection=payload.mutationCommitted&&state.ready&&effect.revision<=state.revision?{status:'ready' as const,source:state.source!,revision:state.projectionRevision}:payload.projection??{status:'unknown',source:state.source!};return {commandId,effect,projection};}
 private setEffect(commandId:string,effect:PresentationEffectReceipt){this.db.prepare('UPDATE presentation_commands SET effect=? WHERE command_id=?').run(JSON.stringify(effect),commandId);}
 private payload(commandId:string):Json{return JSON.parse(String(this.db.prepare('SELECT payload FROM presentation_commands WHERE command_id=?').get(commandId)!.payload));}
 private setPayload(commandId:string,payload:Json){this.db.prepare('UPDATE presentation_commands SET payload=? WHERE command_id=?').run(JSON.stringify(payload),commandId);}
 private exactProjection(request:VisibilityProjectionRequest,result:VisibilityProjectionReceipt|null){
  if(!result||result.source!==request.source||result.commandId!==request.commandId||result.revision!==request.throughRevision||result.projected!==request.items.length)throw new PresentationError('Original catalog projection receipt is unavailable or inconsistent',{available:false});
 }
 private async verifyRows(rows:Json[],checkpoint:number){
  const state=this.state()!,fresh=await this.ports.catalogFreshness();if(fresh.phase!=='complete'||fresh.issues!==0)throw Error('Catalog metadata reconstruction is incomplete');
  for(const row of rows){const expected=JSON.parse(String(row.metadata)).identity??JSON.parse(String(row.metadata)),current=await this.ports.catalogGet(String(row.session));
   if(!current||current.uri!==expected.session||current.engineId!==expected.engineId||current.nativeSessionId!==expected.nativeSessionId||current.workingDirectory!==expected.workingDirectory)throw Error('Retained catalog mapping differs');
   const retained=JSON.parse(String(row.metadata)).catalog;if(retained?.storagePath&&current.storagePath!==retained.storagePath)throw Error('Retained native storage mapping differs');
   if(row.target_hidden!==undefined&&!!current.productHidden!==!!row.target_hidden)throw Error('Retained product visibility differs');
  }
  const status=await this.ports.projectionStatus(state.source!);if(status.source!==state.source||status.revision!==checkpoint)throw Error('Catalog checkpoint differs');
 }
 private makeBatches(commandId:string,rows:Json[],after:number){
  const source=this.state()!.source!,requests:VisibilityProjectionRequest[]=[];
  for(let offset=0;offset<Math.max(rows.length,1);offset+=100){const page=rows.slice(offset,offset+100),n=requests.length;requests.push({source,commandId:'presentation:'+hash(commandId)+':'+n,afterRevision:after+n,throughRevision:after+n+1,items:page.map(row=>({uri:row.session,hidden:!!row.target_hidden,revision:after+n+1}))});}
  return requests;
 }
 private saveBatches(commandId:string,requests:VisibilityProjectionRequest[]){for(let i=0;i<requests.length;i++)this.db.prepare('INSERT INTO presentation_projection_batches VALUES(?,?,?,NULL,?)').run(commandId,i,JSON.stringify(requests[i]),'prepared');}
 private async dispatchBatches(commandId:string){
  for(const row of this.db.prepare('SELECT * FROM presentation_projection_batches WHERE command_id=? ORDER BY ordinal').all(commandId)){
   if(row.state!=='prepared')throw Error('An admitted projection is never redispatched');const request=JSON.parse(String(row.request));
   this.db.prepare('UPDATE presentation_projection_batches SET state=? WHERE command_id=? AND ordinal=?').run('dispatching',commandId,row.ordinal);
   const result=await this.ports.project(request);this.exactProjection(request,result);
   this.db.prepare('UPDATE presentation_projection_batches SET state=?,result=? WHERE command_id=? AND ordinal=?').run('confirmed',JSON.stringify(result),commandId,row.ordinal);
  }
 }
 private async observeBatches(commandId:string){
  let checkpoint:number|undefined;for(const row of this.db.prepare('SELECT * FROM presentation_projection_batches WHERE command_id=? ORDER BY ordinal').all(commandId)){
   const request=JSON.parse(String(row.request)),result=await this.ports.projectionReceipt(request.source,request.commandId);this.exactProjection(request,result);
   this.db.prepare('UPDATE presentation_projection_batches SET state=?,result=? WHERE command_id=? AND ordinal=?').run('confirmed',JSON.stringify(result),commandId,row.ordinal);checkpoint=result!.revision;
  }if(checkpoint===undefined)throw Error('Projection was not admitted');return checkpoint;
 }
 private complete(commandId:string,rows:Json[],checkpoint:number){
  const state=this.state()!;
  this.db.exec('BEGIN IMMEDIATE');try{this.setPayload(commandId,{...this.payload(commandId),projection:{status:'ready',source:state.source!,revision:checkpoint}});this.save({...state,projectionRevision:checkpoint,phase:'ready',ready:true,reason:undefined});this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
  try{this.ports.changed(rows.map(row=>({session:row.session,hidden:!!row.target_hidden})));}catch{/* Notification loss cannot erase the committed receipt. */}
 }
 async apply(input:PresentationApply,actor:PresentationActor):Promise<PresentationReceipt>{return this.serial(async()=>{
  if(!input||Object.keys(input).sort().join(',')!=='commandId,reviewHash,reviewId')throw new PresentationError('Exact apply request required');id(input.commandId);id(input.reviewHash,'review hash',64);
  const review=this.review(input.reviewId);if(review.reviewHash!==input.reviewHash||review.actor!==actorKey(actor))throw new PresentationError('Review hash or actor differs');
  if(this.db.prepare('SELECT 1 FROM presentation_rebuilds WHERE command_id=?').get(input.commandId))throw new PresentationError('Command already belongs to reconstruction');
  const signature=hash(input),old=this.db.prepare('SELECT signature FROM presentation_commands WHERE command_id=?').get(input.commandId);
  if(old){if(old.signature!==signature)throw new PresentationError('Apply identity conflicts with original request');return this.receipt(input.commandId,actor)!;}
  await this.checkReady();if(review.expiresAt<Date.now())throw new PresentationError('Review expired');
  const rows=this.rows(review.reviewId,-1,501);if(rows.length!==review.count)throw new PresentationError('Retained selection is incomplete');
  const sessions:PresentationIdentity[]=rows.map(row=>JSON.parse(row.metadata).identity);
  // Session admission locks cover validation and the one local authority transaction, not catalog I/O.
  try{await this.ports.withSelection(sessions.map(row=>row.session),async()=>{
   for(const row of rows){const current=this.marker(row.session);if(current.revision!==row.before_revision||current.hidden!==!!row.before_hidden)throw new PresentationError('Selected visibility revision changed');const metadata=await this.ports.metadata(row.session);if(canonical(metadata.identity)!==canonical(JSON.parse(row.metadata).identity))throw new PresentationError('Selected native identity changed since review');}
   // Restoring discoverability never needs to stop ongoing exact-ID work.
   if(rows.some(row=>!!row.target_hidden))await this.ports.validateSelection(sessions.filter((_item,index)=>!!rows[index].target_hidden));
   const state=this.state()!,projection={status:'pending' as const,source:state.source!};
   const effect:PresentationEffectReceipt={commandId:input.commandId,operation:review.operation,part:'conversation-presentation',reviewId:review.reviewId,reviewHash:review.reviewHash,selectionHash:review.selectionHash,count:rows.length,previousRevision:state.revision,revision:state.revision+1,status:'completed',preservesCanonical:true,preservesAuthority:true};
   this.db.exec('BEGIN IMMEDIATE');try{
    for(const row of rows){const current=this.marker(row.session);if(current.revision!==row.before_revision||current.hidden!==!!row.before_hidden)throw new PresentationError('Selected visibility revision changed');const metadata=JSON.parse(row.metadata);this.db.prepare('INSERT INTO presentation_markers VALUES(?,?,?,?,?,?) ON CONFLICT(session) DO UPDATE SET hidden=excluded.hidden,revision=excluded.revision,identity=excluded.identity,metadata=excluded.metadata,command_id=excluded.command_id').run(row.session,row.target_hidden,state.revision+1,canonical(metadata.identity),row.metadata,input.commandId);}
    this.db.prepare('INSERT INTO presentation_commands VALUES(?,?,?,?,?)').run(input.commandId,signature,review.reviewId,JSON.stringify({mutationCommitted:true,projection}),JSON.stringify(effect));
    // Do not attach new outbox pages to an unconfirmed checkpoint. Explicit derived repair includes all markers.
    if(state.ready)this.saveBatches(input.commandId,this.makeBatches(input.commandId,rows,state.projectionRevision!));
    this.save({...state,revision:state.revision+1,ready:false,phase:'applying'});this.db.exec('COMMIT');
   }catch(error){this.db.exec('ROLLBACK');throw error;}
  });}catch(error){
   // Every pre-commit operation above is read-only. The SQLite transaction is atomic.
   if(this.effect(input.commandId))throw error;
   const state=this.state()!,effect:PresentationEffectReceipt={commandId:input.commandId,operation:review.operation,part:'conversation-presentation',reviewId:review.reviewId,reviewHash:review.reviewHash,selectionHash:review.selectionHash,count:rows.length,previousRevision:state.revision,status:'refused',executed:false,preservesCanonical:true,preservesAuthority:true,reason:String((error as Error).message).slice(0,512)};
   this.db.prepare('INSERT INTO presentation_commands VALUES(?,?,?,?,?)').run(input.commandId,signature,review.reviewId,JSON.stringify({mutationCommitted:false,projection:{status:state.ready?'ready':'unknown',source:state.source!,revision:state.projectionRevision}}),JSON.stringify(effect));return this.receipt(input.commandId,actor)!;
  }
  try{this.ports.changed(rows.map(row=>({session:row.session,hidden:!!row.target_hidden})));}catch{/* Marker authority is already durable. */}
  try{
   const batches=this.db.prepare('SELECT request FROM presentation_projection_batches WHERE command_id=? ORDER BY ordinal').all(input.commandId);if(!batches.length)throw Error('Prior catalog projection requires derived reconstruction');
   await this.dispatchBatches(input.commandId);const checkpoint=JSON.parse(String(batches.at(-1)!.request)).throughRevision;await this.verifyRows(rows,checkpoint);this.complete(input.commandId,rows,checkpoint);
  }catch{this.setPayload(input.commandId,{...this.payload(input.commandId),projection:{status:'unknown',source:this.state()!.source!}});this.save({...this.state()!,ready:false,phase:'unknown',reason:'derived-projection-unconfirmed'});}
  return this.receipt(input.commandId,actor)!;
 });}
 async reconcile(commandId:string,actor:PresentationActor){return this.serial(async()=>{
  const receipt=this.receipt(commandId,actor);if(!receipt||receipt.effect.status==='refused'||receipt.projection.status==='ready')return receipt;
  try{
   const rows=this.rows(receipt.effect.reviewId,-1,501);if(rows.length!==receipt.effect.count)throw Error('Selection incomplete');
   const checkpoint=await this.observeBatches(commandId);
   // Only open listing if this is the latest marker policy; otherwise an explicit rebuild is required.
   if(this.state()!.revision!==receipt.effect.revision)throw Error('Later presentation policy requires reconstruction');
   await this.verifyRows(rows,checkpoint);this.complete(commandId,rows,checkpoint);
  }catch{/* Passive original-receipt observation never redispatches a missing page. */}
  return this.receipt(commandId,actor);
 });}
 /** Persist only indexed canonical mappings learned through admitted host/catalog boundaries. */
 retainMapping(record:Json){
  if(!record||typeof record.uri!=='string'||Buffer.byteLength(canonical(record))>PRESENTATION_LIMITS.metadataBytes)throw new PresentationError('Retained catalog mapping exceeds metadata bounds');
  identity({session:record.uri,engineId:record.engineId,nativeSessionId:record.nativeSessionId,workingDirectory:record.workingDirectory});
  const prior=this.mapping(record.uri);if(prior){for(const key of ['uri','engineId','nativeSessionId','workingDirectory'])if(prior[key]!==record[key])throw new PresentationError('Retained catalog identity cannot be overwritten');if(prior.storagePath&&record.storagePath&&prior.storagePath!==record.storagePath)throw new PresentationError('Retained native home cannot be overwritten');if(prior.storagePath&&!record.storagePath)record={...record,storagePath:prior.storagePath};}
  this.db.prepare('INSERT INTO presentation_mappings VALUES(?,?) ON CONFLICT(session) DO UPDATE SET metadata=excluded.metadata').run(record.uri,canonical(record));
 }
 mapping(session:string):Json|undefined{const row=this.db.prepare('SELECT metadata FROM presentation_mappings WHERE session=?').get(session);return row?JSON.parse(String(row.metadata)):undefined;}
 async rebuild(input:PresentationRebuild,actor:PresentationActor){return this.serial(async()=>{
  if(!input||Object.keys(input).sort().join(',')!=='commandId,expectedRevision')throw new PresentationError('Exact reconstruction request required');id(input.commandId);revision(input.expectedRevision);const by=actorKey(actor),signature=hash({input,actor:by});
  if(this.db.prepare('SELECT 1 FROM presentation_commands WHERE command_id=?').get(input.commandId))throw new PresentationError('Command already belongs to reset or restore');
  const old=this.db.prepare('SELECT signature,payload FROM presentation_rebuilds WHERE command_id=?').get(input.commandId);if(old){if(old.signature!==signature)throw new PresentationError('Reconstruction identity conflicts');return this.publicRebuild(JSON.parse(String(old.payload)));}
  const state=this.state()!;if(state.revision!==input.expectedRevision)throw new PresentationError('Presentation revision changed');
  let payload:Json={commandId:input.commandId,actor:by,status:'unknown',revision:state.revision,source:state.source,count:0,bytes:0,markerCount:0,manifestHash:'',phase:'capturing'};
  this.db.prepare('INSERT INTO presentation_rebuilds VALUES(?,?,?)').run(input.commandId,signature,JSON.stringify(payload));this.save({...state,ready:false,phase:'rebuilding',reason:'exact-metadata-reconstruction'});
  const save=()=>this.db.prepare('UPDATE presentation_rebuilds SET payload=? WHERE command_id=?').run(JSON.stringify(payload),input.commandId);
  try{
   await this.hints.quiet();
   let cursor:string|undefined;const digest=createHash('sha256');const seenCursors=new Set<string>();
   const add=(record:Json)=>{const prior=this.db.prepare('SELECT metadata FROM presentation_rebuild_rows WHERE command_id=? AND session=?').get(input.commandId,record.uri);if(prior){const previous=JSON.parse(String(prior.metadata));for(const key of ['uri','engineId','nativeSessionId','workingDirectory'])if(previous[key]!==record[key])throw Error('Rebuild mapping collision');return;}
    identity({session:record.uri,engineId:record.engineId,nativeSessionId:record.nativeSessionId,workingDirectory:record.workingDirectory});const data=canonical(record),bytes=Buffer.byteLength(data);if(bytes>16384||payload.count>=100000||payload.bytes+bytes>64*1024*1024)throw Error('Metadata reconstruction capacity exceeded');
    const marker=this.db.prepare('SELECT hidden FROM presentation_markers WHERE session=?').get(record.uri);this.db.prepare('INSERT INTO presentation_rebuild_rows VALUES(?,?,?,?,?)').run(input.commandId,payload.count++,record.uri,data,marker?Number(marker.hidden):null);payload.bytes+=bytes;if(marker)payload.markerCount++;digest.update(data+'\n');
   };
   do{const page=await this.ports.mappings(cursor);if(page.items.length>100)throw Error('Mapping page exceeded100');for(const item of page.items)add(item);if(page.nextCursor&&seenCursors.has(page.nextCursor))throw Error('Repeated mapping cursor');if(page.nextCursor)seenCursors.add(page.nextCursor);cursor=page.nextCursor;}while(cursor);
   let after='';for(;;){const rows=this.db.prepare('SELECT session,metadata FROM presentation_markers WHERE session>? ORDER BY session LIMIT 100').all(after);if(!rows.length)break;for(const row of rows)add(JSON.parse(String(row.metadata)).catalog);after=String(rows.at(-1)!.session);}
   payload.manifestHash=digest.digest('hex');payload.phase='metadata';save();
   const hintBoundary=this.hints.scanBoundary();
   await this.ports.reconstructMetadata?.({commandId:input.commandId,source:state.source!,readMappings:cursor=>this.mappingPage(input.commandId,cursor)});
   if(this.ports.reconstructMetadata)this.hints.scanned(hintBoundary);
   const fresh=await this.ports.catalogFreshness();if(fresh.phase!=='complete'||fresh.issues!==0)throw Error('Metadata discovery is incomplete');
   for(let after=-1;;){const rows=this.db.prepare('SELECT * FROM presentation_rebuild_rows WHERE command_id=? AND ordinal>? ORDER BY ordinal LIMIT 100').all(input.commandId,after);if(!rows.length)break;for(const row of rows){const expected=JSON.parse(String(row.metadata)),current=await this.ports.catalogGet(String(row.session));for(const key of ['uri','engineId','nativeSessionId','workingDirectory'])if(!current||current[key]!==expected[key])throw Error('Metadata reconstruction identity differs');if(expected.storagePath&&current!.storagePath!==expected.storagePath)throw Error('Native home mapping differs');}after=Number(rows.at(-1)!.ordinal);}
   const checkpoint=await this.ports.projectionStatus(state.source!);if(checkpoint.source!==state.source||!Number.isSafeInteger(checkpoint.revision)||checkpoint.revision<0)throw Error('Invalid projection checkpoint');
   let ordinal=0,pageAfter=-1;for(;;){const rows=this.db.prepare('SELECT session,hidden AS target_hidden FROM presentation_rebuild_rows WHERE command_id=? AND hidden IS NOT NULL AND ordinal>? ORDER BY ordinal LIMIT 100').all(input.commandId,pageAfter) as Json[];
    // Cursor uses the original manifest ordinal, never inferred from selected page size.
    const page=this.db.prepare('SELECT ordinal FROM presentation_rebuild_rows WHERE command_id=? AND hidden IS NOT NULL AND ordinal>? ORDER BY ordinal LIMIT 100').all(input.commandId,pageAfter);if(!rows.length&&ordinal)break;
    const request:VisibilityProjectionRequest={source:state.source!,commandId:'rebuild:'+hash(input.commandId)+':'+ordinal,afterRevision:checkpoint.revision+ordinal,throughRevision:checkpoint.revision+ordinal+1,items:rows.map(row=>({uri:row.session,hidden:!!row.target_hidden,revision:checkpoint.revision+ordinal+1}))};
    this.db.prepare('INSERT INTO presentation_projection_batches VALUES(?,?,?,NULL,?)').run(input.commandId,ordinal,JSON.stringify(request),'prepared');ordinal++;if(!rows.length||rows.length<100)break;pageAfter=Number(page.at(-1)!.ordinal);
   }
   payload.phase='projection';payload.targetCheckpoint=checkpoint.revision+ordinal;save();await this.dispatchBatches(input.commandId);await this.finishRebuild(input.commandId);return this.publicRebuild(JSON.parse(String(this.db.prepare('SELECT payload FROM presentation_rebuilds WHERE command_id=?').get(input.commandId)!.payload)));
  }catch{payload.phase='unknown';payload.reason=this.hints.inspect().unsettled?'catalog-discovery-unsettled':'metadata-or-projection-reconstruction-unconfirmed';save();this.save({...this.state()!,ready:false,phase:'unknown',reason:payload.reason});return this.publicRebuild(payload);}
 },false);}
 private publicRebuild(payload:Json){const {actor,...result}=payload;return result;}
 private mappingPage(commandId:string,cursor?:string):PresentationMappingPage{
  const payload=JSON.parse(String(this.db.prepare('SELECT payload FROM presentation_rebuilds WHERE command_id=?').get(commandId)!.payload));let after=-1;
  if(cursor!==undefined){try{const value=JSON.parse(Buffer.from(cursor,'base64url').toString());if(value.commandId!==commandId||value.hash!==payload.manifestHash||!Number.isSafeInteger(value.after)||value.after<0)throw Error();after=value.after;}catch{throw new PresentationError('Invalid mapping manifest cursor');}}
  const rows=this.db.prepare('SELECT ordinal,metadata FROM presentation_rebuild_rows WHERE command_id=? AND ordinal>? ORDER BY ordinal LIMIT 100').all(commandId,after),last=rows.at(-1),next=last&&Number(last.ordinal)+1<payload.count;
  return {items:rows.map(row=>JSON.parse(String(row.metadata))),count:payload.count,manifestHash:payload.manifestHash,nextCursor:next?Buffer.from(JSON.stringify({commandId,hash:payload.manifestHash,after:Number(last!.ordinal)})).toString('base64url'):null};
 }
 private async finishRebuild(commandId:string){
  const row=this.db.prepare('SELECT payload FROM presentation_rebuilds WHERE command_id=?').get(commandId);if(!row)throw Error('Unknown rebuild');const payload=JSON.parse(String(row.payload));if(payload.revision!==this.state()!.revision||!Number.isSafeInteger(payload.targetCheckpoint))throw Error('Rebuild revision changed');
  let count=0,markers=0;for(let after=-1;;){const rows=this.db.prepare('SELECT * FROM presentation_rebuild_rows WHERE command_id=? AND ordinal>? ORDER BY ordinal LIMIT 100').all(commandId,after);if(!rows.length)break;
   const check=rows.map(row=>{const record=JSON.parse(String(row.metadata));count++;if(row.hidden!==null)markers++;return {session:row.session,metadata:JSON.stringify({identity:{session:record.uri,engineId:record.engineId,nativeSessionId:record.nativeSessionId,workingDirectory:record.workingDirectory}}),...(row.hidden!==null?{target_hidden:row.hidden}:{})};});await this.verifyRows(check,payload.targetCheckpoint);after=Number(rows.at(-1)!.ordinal);
  }if(count!==payload.count||markers!==payload.markerCount)throw Error('Reconstruction count differs');if(!count)await this.verifyRows([],payload.targetCheckpoint);
  this.hints.assertComplete();
  // This repair reprojects authoritative markers; it never replays original reset/restore effects.
  this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('UPDATE presentation_rebuilds SET payload=? WHERE command_id=?').run(JSON.stringify({...payload,status:'completed',phase:'ready'}),commandId);this.save({...this.state()!,ready:true,phase:'ready',projectionRevision:payload.targetCheckpoint,reason:undefined});this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 async reconcileRebuild(commandId:string,actor:PresentationActor){return this.serial(async()=>{const row=this.db.prepare('SELECT payload FROM presentation_rebuilds WHERE command_id=?').get(id(commandId));if(!row)return null;const payload=JSON.parse(String(row.payload));if(payload.actor!==actorKey(actor))throw new PresentationError('Rebuild belongs to another actor');if(payload.status==='completed')return this.publicRebuild(payload);try{const checkpoint=await this.observeBatches(commandId);if(checkpoint!==payload.targetCheckpoint)throw Error('Rebuild checkpoint differs');await this.finishRebuild(commandId);}catch{}return this.publicRebuild(JSON.parse(String(this.db.prepare('SELECT payload FROM presentation_rebuilds WHERE command_id=?').get(commandId)!.payload)));});}

}
