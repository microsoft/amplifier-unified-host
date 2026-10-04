import {createHash} from 'node:crypto';

/** Derived display facts only. This module has no store, process, or admission API. */
export const FORK_META='amplifier.dev/fork';
export interface ForkBinding {
 version:1;commandId:string;engineId:string;
 source:{session:string;nativeSessionId:string;historyRevision:string};
 target:{session:string;nativeSessionId:string;historyRevision:string};
 throughMessageId?:string;workReplayed:false;
}
export interface CanonicalGroup {id:string;updates:Array<Record<string,any>>;}
export interface CanonicalRow {position:number;messageId:string;rowDigest:string;sourceDigest?:string;}
export interface AttachmentFact {uri:string;name:string;contentType:string;size:number;sha256:string;}
/** Receipt is a trusted source-store observation, not caller-provided proof. */
export interface SourceDisplay {
 turnId:string;text:string;attachments:AttachmentFact[];
 receipt?:{commandId:string;channel:string;status:string};
}
export interface ForkDisplayFact {
 turnId:string;sourceRows:CanonicalRow[];targetRows:CanonicalRow[];
 text:string;attachments:AttachmentFact[];
 observedOutcome:'source-completed'|'unknown';
}
export interface ForkProjection {
 binding:ForkBinding;facts:ForkDisplayFact[];digest:string;
 presentationOnly:true;executionAuthority:false;
}
const ordered=(value:any):any=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])])):value;
/** JSON keys are sorted recursively; array order and UTF-8 string bytes remain exact. */
export const forkDigest=(value:unknown)=>createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
const hash=forkDigest;
const token=(s:unknown):s is string=>typeof s==='string'&&s.length>0&&s.length<=512;
const digest=(s:unknown):s is string=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const uri=(s:string)=>/^ahp-session:\/[^\s/]+$/.test(s);
function binding(value:ForkBinding) {
 if(value.version!==1||!token(value.commandId)||!token(value.engineId)||value.workReplayed!==false||
    !uri(value.source.session)||!uri(value.target.session)||value.source.session===value.target.session||
    !token(value.source.nativeSessionId)||!token(value.target.nativeSessionId)||value.source.nativeSessionId===value.target.nativeSessionId||
    !digest(value.source.historyRevision)||!digest(value.target.historyRevision)||
    value.throughMessageId!==undefined&&!token(value.throughMessageId))throw Error('Invalid retained fork binding');
}
/** Canonical row digests include full row content, unlike public-text sourceDigest. */
export function canonicalRows(group:CanonicalGroup,nativeSessionId:string):CanonicalRow[] {
 const rows=new Map<number,CanonicalRow>();
 for(const update of group.updates){
  const meta=update._meta?.['amplifier.dev/history'],ref=meta?.messageReference;
  if(!meta||!Number.isSafeInteger(meta.position)||meta.position<0||!token(meta.messageId)||meta.historicalOnly||meta.archiveId)throw Error('Current canonical row anchor unavailable');
  const leaf=/^native:(?:[^:]+:)?([a-f0-9]{24})$/.exec(meta.messageId)?.[1];
  if(!leaf)throw Error('Unsupported canonical row identity');
  if(ref&&(ref.sessionId!==nativeSessionId||ref.messageId!==meta.messageId||ref.position!==meta.position||!digest(ref.sourceDigest)))throw Error('Canonical reference scope differs');
  const row:CanonicalRow={position:meta.position,messageId:meta.messageId,rowDigest:leaf,...(ref?{sourceDigest:ref.sourceDigest}:{})};
  const prior=rows.get(row.position);
  if(prior&&JSON.stringify(prior)!==JSON.stringify(row))throw Error('Ambiguous canonical row anchor');
  rows.set(row.position,row);
 }
 const result=[...rows.values()].sort((a,b)=>a.position-b.position);
 if(!result.length)throw Error('Empty canonical group');
 return result;
}
const equivalent=(a:CanonicalRow[],b:CanonicalRow[])=>a.length===b.length&&a.every((r,i)=>r.position===b[i].position&&r.rowDigest===b[i].rowDigest&&r.sourceDigest===b[i].sourceDigest);
const exact=(a:CanonicalRow[],b:CanonicalRow[])=>equivalent(a,b)&&a.every((r,i)=>r.messageId===b[i].messageId);
function groups(values:CanonicalGroup[],nativeSessionId:string) {
 const ids=new Set<string>(),positions=new Set<number>();let last=-1;
 return values.map(group=>{
  if(!token(group.id)||ids.has(group.id))throw Error('Ambiguous canonical turn identity');ids.add(group.id);
  const rows=canonicalRows(group,nativeSessionId);
  for(const row of rows){if(positions.has(row.position)||row.position<=last)throw Error('Canonical prefix order differs');positions.add(row.position);last=row.position;}
  return {group,rows};
 });
}
/** Call only after Host validates the original completed Native lifecycle receipt.
 * Source page must have the reviewed revision, and target page the creation revision.
 * Caller passes oldest-first groups covering the copied prefix, never a guessed text match.
 */
export function captureForkProjection(input:{binding:ForkBinding;sourceRevision:string;targetRevision:string;source:CanonicalGroup[];target:CanonicalGroup[];display:SourceDisplay[]}):ForkProjection {
 const b=input.binding;binding(b);
 if(input.sourceRevision!==b.source.historyRevision||input.targetRevision!==b.target.historyRevision)throw Error('Reviewed fork revision differs');
 if(input.source.length>200||input.target.length>200||input.display.length>200)throw Error('Fork display window exceeds capacity');
 let source=groups(input.source,b.source.nativeSessionId);
 const target=groups(input.target,b.target.nativeSessionId);
 if(b.throughMessageId){const index=source.findIndex(({group})=>group.updates.some(update=>update.sessionUpdate==='user_message_chunk'&&update._meta?.['amplifier.dev/history']?.messageId===b.throughMessageId));if(index<0)throw Error('Reviewed user boundary unavailable');source=source.slice(0,index+1);}
 if(source.length!==target.length||source.some((s,i)=>s.group.id!==target[i].group.id||!equivalent(s.rows,target[i].rows)))throw Error('Copied canonical prefix differs');
 const display=new Map<string,SourceDisplay>();
 for(const row of input.display){if(display.has(row.turnId))throw Error('Ambiguous source display turn');display.set(row.turnId,row);}
 const facts:ForkDisplayFact[]=[];
 for(let i=0;i<source.length;i++){
  const s=source[i],d=display.get(s.group.id);if(!d)continue;
  if(typeof d.text!=='string'||d.attachments.length>8)throw Error('Invalid source display facts');
  const attachments=d.attachments.map(a=>{if(!token(a.uri)||!token(a.name)||!token(a.contentType)||!Number.isSafeInteger(a.size)||a.size<0||!digest(a.sha256))throw Error('Resources attachment integrity unavailable');return {uri:a.uri,name:a.name,contentType:a.contentType,size:a.size,sha256:a.sha256};});
  facts.push({turnId:s.group.id,sourceRows:s.rows,targetRows:target[i].rows,text:d.text,attachments,observedOutcome:d.receipt?.status==='completed'&&d.receipt.commandId===d.turnId&&d.receipt.channel===b.source.session.replace('ahp-session:/','ahp-chat:/')?'source-completed':'unknown'});
 }
 const body={binding:structuredClone(b),facts,presentationOnly:true as const,executionAuthority:false as const};
 if(Buffer.byteLength(JSON.stringify(body))>2*1024*1024)throw Error('Fork display facts exceed byte capacity');
 return {...body,digest:hash(body)};
}
/** Later append is allowed; edited/archived/reordered rows never inherit old display facts.
 * A match supplies public input and historical outcome only. Fresh target Native
 * locators, response content, tools and admission state stay with their owners.
 */
export function forkDisplay(projection:ForkProjection,group:CanonicalGroup,nativeSessionId:string):ForkDisplayFact|undefined {
 const {digest:claimed,...body}=projection;
 if(claimed!==hash(body)||projection.presentationOnly!==true||projection.executionAuthority!==false)throw Error('Retained display projection integrity differs');
 binding(projection.binding);
 if(nativeSessionId!==projection.binding.target.nativeSessionId)throw Error('Fork display target scope differs');
 const fact=projection.facts.find(row=>row.turnId===group.id);if(!fact)return;
 let current:CanonicalRow[];try{current=canonicalRows(group,nativeSessionId);}catch{return;}
 return exact(fact.targetRows,current)?structuredClone(fact):undefined;
}

/** Trusted Host-to-Resources callback proposal; never accepts a wire parentId grant. */
export interface ForkAttachmentBindingRequest {
 binding:ForkBinding;projectionDigest:string;
 items:Array<{turnId:string;sourceRows:CanonicalRow[];targetRows:CanonicalRow[];attachment:AttachmentFact}>;
}
export interface ForkAttachmentBindingReceipt {
 owner:'unified.resources';version:1;commandId:string;requestDigest:string;
 sourceSession:string;targetSession:string;
 status:'completed'|'refused'|'unknown';
 items:Array<{sourceUri:string;targetUri:string;sha256:string;size:number;name:string;contentType:string}>;
 replayed:false;
}
export function forkAttachmentRequest(projection:ForkProjection):ForkAttachmentBindingRequest {
 const {digest:claimed,...body}=projection;if(claimed!==hash(body))throw Error('Retained display projection integrity differs');
 return {binding:structuredClone(projection.binding),projectionDigest:claimed,items:projection.facts.flatMap(fact=>fact.attachments.map(attachment=>({turnId:fact.turnId,sourceRows:structuredClone(fact.sourceRows),targetRows:structuredClone(fact.targetRows),attachment:{...attachment}})))};
}
/** Verifies an owner response, without creating grants or mutating display/history. */
export function verifiedForkAttachments(request:ForkAttachmentBindingRequest,receipt:ForkAttachmentBindingReceipt):Map<string,AttachmentFact>|undefined {
 binding(request.binding);
 if(receipt.owner!=='unified.resources'||receipt.version!==1||receipt.commandId!==request.binding.commandId||receipt.requestDigest!==hash(request)||receipt.sourceSession!==request.binding.source.session||receipt.targetSession!==request.binding.target.session||receipt.replayed!==false)throw Error('Resources fork binding scope differs');
 if(receipt.status!=='completed')return;
 const expected=new Map<string,AttachmentFact>();
 for(const item of request.items){const prior=expected.get(item.attachment.uri);if(prior&&hash(prior)!==hash(item.attachment))throw Error('Conflicting source attachment integrity');expected.set(item.attachment.uri,item.attachment);}
 const result=new Map<string,AttachmentFact>(),targets=new Set<string>();
 for(const item of receipt.items){
  const original=expected.get(item.sourceUri);let target:URL;try{target=new URL(item.targetUri);}catch{throw Error('Invalid target attachment URI');}
  if(!original||result.has(item.sourceUri)||targets.has(item.targetUri)||target.protocol!=='amplifier-attachment:'||target.pathname!=='/body'||target.searchParams.get('session')!==request.binding.target.session||item.sha256!==original.sha256||item.size!==original.size||item.name!==original.name||item.contentType!==original.contentType)throw Error('Resources target attachment integrity differs');
  targets.add(item.targetUri);result.set(item.sourceUri,{uri:item.targetUri,name:item.name,contentType:item.contentType,size:item.size,sha256:item.sha256});
 }
 if(result.size!==expected.size)throw Error('Resources fork attachment coverage incomplete');return result;
}
