import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {CatalogRecord} from './host.js';
type Json=Record<string,any>;
export interface RetentionPreviewRequest {connectionId:string;modifiedBefore:number;limit?:number;cursor?:string;workingDirectory?:string;protectSessionIds?:string[];}
export interface RetentionApplyRequest {commandId:string;reviewId:string;reviewHash:string;sessionIds:string[];}
export interface RetentionProtection {acquire(context:{commandId:string;session:string;descendants:string[];operation:'hide'}):Promise<{ownerIds:string[];release():Promise<void>}>;}
export interface RetentionPorts {list(input:RetentionPreviewRequest):Promise<Json>;protected(row:CatalogRecord,protect:string[]):string|undefined;hide(row:CatalogRecord,input:{commandId:string;modifiedBefore:number;protectSessionIds:string[]}):Promise<Json>;}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fault=(message:string)=>Object.assign(new Error(message),{data:{executed:false}});
function identity(value:unknown){if(typeof value!=='string'||!value||value.length>200)throw fault('Bounded exact command identity required');return value;}
function sessions(value:unknown,max=200){if(!Array.isArray(value)||value.length>max||value.some(x=>typeof x!=='string'||!/^ahp-session:\/.{1,480}$/.test(x))||new Set(value).size!==value.length)throw fault('Bounded distinct session identities required');return value as string[];}
/** Bounded disk reviews and per-item outcome journal. Native state never lives here. */
export class Retention {
 constructor(private db:DatabaseSync,private ports:RetentionPorts){db.exec(`CREATE TABLE IF NOT EXISTS retention_reviews(id TEXT PRIMARY KEY,hash TEXT NOT NULL,expires INTEGER NOT NULL,payload TEXT NOT NULL);CREATE INDEX IF NOT EXISTS retention_reviews_expiry ON retention_reviews(expires);
 CREATE TABLE IF NOT EXISTS retention_items(command_id TEXT PRIMARY KEY,batch_id TEXT NOT NULL,session TEXT NOT NULL,payload TEXT NOT NULL);CREATE INDEX IF NOT EXISTS retention_items_batch ON retention_items(batch_id);
 CREATE TABLE IF NOT EXISTS retention_commands(command_id TEXT PRIMARY KEY,signature TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL,result TEXT NOT NULL);
 UPDATE retention_commands SET status='unknown' WHERE status='applying';
 UPDATE retention_items SET payload=json_set(payload,'$.status',CASE json_extract(payload,'$.status') WHEN 'dispatching' THEN 'unknown' ELSE 'not-attempted' END) WHERE batch_id IN(SELECT command_id FROM retention_commands WHERE status='unknown') AND json_extract(payload,'$.status') IN('pending','dispatching');`);}
 async preview(input:RetentionPreviewRequest){
  if(!input||Object.keys(input).some(k=>!['connectionId','modifiedBefore','limit','cursor','workingDirectory','protectSessionIds'].includes(k))||!Number.isFinite(input.modifiedBefore)||input.modifiedBefore<=0||input.modifiedBefore>=Date.now()/1000)throw fault('Explicit past cutoff required');identity(input.connectionId);
  const limit=input.limit??50;if(!Number.isInteger(limit)||limit<1||limit>50)throw fault('Retention pages are limited to50 entries');const protect=sessions(input.protectSessionIds??[]);
  const page=await this.ports.list({...input,limit}),rows=page.items as CatalogRecord[];
  if(!Array.isArray(rows)||rows.length>limit||page.eligibility!=='unverified'||page.nativeFilesRead!==false||page.removalAuthorized!==false||!Number.isSafeInteger(page.candidateCount)||page.candidateCount<0)throw fault('Catalog did not provide bounded unverified candidate metadata');
  const items=rows.map(row=>({session:row.uri,title:row.title,createdAt:row.createdAt,modifiedAt:row.modifiedAt,workingDirectory:row.workingDirectory,reason:this.ports.protected(row,protect)??null}));
  const reviewId=randomUUID(),expiresAt=Date.now()+600000,payload={modifiedBefore:input.modifiedBefore,protectSessionIds:protect,rows,items,expiresAt},reviewHash=hash(payload);
  this.db.prepare('DELETE FROM retention_reviews WHERE expires<?').run(Date.now());
  if(Number((this.db.prepare('SELECT count(*) AS n FROM retention_reviews').get() as Json).n)>=1000)throw fault('Retention review capacity reached');
  this.db.prepare('INSERT INTO retention_reviews VALUES(?,?,?,?)').run(reviewId,reviewHash,expiresAt,JSON.stringify(payload));
  return {reviewId,reviewHash,expiresAt,modifiedBefore:input.modifiedBefore,items,candidateCount:page.candidateCount,eligibleCountOnPage:items.filter(row=>!row.reason).length,eligibility:'host-preflight-only',dependencyCheck:'at-apply',nativeFilesRead:false,removalAuthorized:false,nextCursor:page.nextCursor??null,freshness:page.freshness,preserved:['canonical native history','events.jsonl','workspace files'],legacyFilesPurged:false};
 }
 itemReceipt(commandId:string){identity(commandId);const row=this.db.prepare('SELECT payload FROM retention_items WHERE command_id=?').get(commandId) as Json|undefined;return row?JSON.parse(row.payload):null;}
 settleItem(commandId:string,outcome:Json){const current=this.itemReceipt(commandId);if(!current)throw Error('Retention item admission is unavailable');this.db.prepare('UPDATE retention_items SET payload=? WHERE command_id=?').run(JSON.stringify({...current,...outcome}),commandId);}
 receipt(commandId:string){identity(commandId);const row=this.db.prepare('SELECT status,result FROM retention_commands WHERE command_id=?').get(commandId) as Json|undefined;if(!row)return null;const value=JSON.parse(row.result);value.items=value.items.map((item:Json)=>({...item,...this.itemReceipt(item.commandId)}));if(row.status==='unknown'){value.status='unknown';value.items=value.items.map((item:Json)=>item.status==='dispatching'?{...item,status:'unknown'}:item.status==='pending'?{...item,status:'not-attempted'}:item);}return value;}
 async apply(input:RetentionApplyRequest){
  if(!input||Object.keys(input).some(k=>!['commandId','reviewId','reviewHash','sessionIds'].includes(k)))throw fault('Exact reviewed retention request required');identity(input.commandId);identity(input.reviewId);sessions(input.sessionIds,50);if(!input.sessionIds.length||typeof input.reviewHash!=='string'||!/^[a-f0-9]{64}$/.test(input.reviewHash))throw fault('Choose a nonempty reviewed subset');
  const signature=hash(input),prior=this.db.prepare('SELECT signature FROM retention_commands WHERE command_id=?').get(input.commandId) as Json|undefined;
  if(prior){if(prior.signature!==signature)throw fault('Retention command conflicts with original request');return this.receipt(input.commandId);}
  const review=this.db.prepare('SELECT * FROM retention_reviews WHERE id=?').get(input.reviewId) as Json|undefined;if(!review||review.hash!==input.reviewHash||Number(review.expires)<=Date.now())throw fault('Retention review expired or changed');const saved=JSON.parse(review.payload),rows=new Map<string,CatalogRecord>(saved.rows.map((row:CatalogRecord)=>[row.uri,row]));
  if(input.sessionIds.some(id=>!rows.has(id)||saved.items.find((row:Json)=>row.session===id)?.reason))throw fault('Selected session was not eligible in this review');
  const result:Json={commandId:input.commandId,reviewId:input.reviewId,reviewHash:input.reviewHash,status:'applying',preservesCanonical:true,legacyFilesPurged:false,items:input.sessionIds.map(session=>({session,commandId:hash(['retention',input.commandId,session]),status:'pending'}))};
  this.db.prepare('INSERT INTO retention_commands VALUES(?,?,?,?,?)').run(input.commandId,signature,'applying',JSON.stringify(input),JSON.stringify(result));
  for(const item of result.items)this.db.prepare('INSERT INTO retention_items VALUES(?,?,?,?)').run(item.commandId,input.commandId,item.session,JSON.stringify({...item,batchCommandId:input.commandId}));
  const save=()=>{for(const item of result.items)this.settleItem(item.commandId,item);this.db.prepare('UPDATE retention_commands SET status=?,result=? WHERE command_id=?').run(result.status,JSON.stringify(result),input.commandId);};
  for(const item of result.items){
   const row=rows.get(item.session)!;const reason=this.ports.protected(row,saved.protectSessionIds);if(reason){Object.assign(item,{status:'refused',reason,executed:false});save();continue;}
   item.status='dispatching';save();
   try{item.result=await this.ports.hide(row,{commandId:item.commandId,modifiedBefore:saved.modifiedBefore,protectSessionIds:saved.protectSessionIds});item.status='hidden';item.executed=true;}
   catch(error){const settled=this.itemReceipt(item.commandId),confirmed=settled?.status==='hidden',known=!confirmed&&(error as any)?.data?.executed===false;if(confirmed)Object.assign(item,settled,{protectionRelease:'unknown'});else Object.assign(item,{status:known?'refused':'unknown',reason:(error as Error).message.slice(0,1000),...(known?{executed:false}:{})});if(!known){result.status='unknown';for(const next of result.items)if(next.status==='pending')next.status='not-attempted';save();return this.receipt(input.commandId);}}
   save();
  }
  result.status='completed';save();return this.receipt(input.commandId);
 }
}
