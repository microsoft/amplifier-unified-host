import type {Message} from '@microsoft/agent-host-protocol';

export const PUBLIC_MESSAGE_META='amplifier.dev/publicMessage';
export interface NativeLocator {sessionId:string;messageId:string;position:number;historyEpoch:string|null;}
export interface PublicText {type:'text';text:string;}
export interface PublicCard {
  type:'attachment';reference:{owner:'resources'|'native-attachments';id:string};
  name:string;mimeType:string;size?:number;sha256?:string;
}
export interface PublicMessageV1 {version:1;inputId:string;capture:'host-standard'|'native-input';blocks:readonly (PublicText|PublicCard)[];}
export interface OriginalCopySourceV1 {version:1;source:NativeLocator;disposition:'retained'|'history-only';}
export interface PersistedPublicRow {locator:NativeLocator;publicMessage:PublicMessageV1;copySource?:OriginalCopySourceV1;}
export interface OriginalCardOccurrence {row:NativeLocator;blockIndex:number;}
export interface RetainOriginalAttachmentV2 {version:2;commandId:string;target:OriginalCardOccurrence;}
export interface CompletedForkAuthority {
  commandId:string;status:'completed';
  source:{sessionId:string;historyRevision:string;throughMessageId?:string};
  target:{sessionId:string;creationHistoryRevision:string};
  creationConfirmed:true;preservedSource:true;workReplayed:false;
}
export interface VerifiedOriginalAttachmentV2 {
  version:2;commandId:string;authority:CompletedForkAuthority;
  sourceOccurrence:OriginalCardOccurrence;targetOccurrence:OriginalCardOccurrence;
  card:PublicCard;disposition:'retained'|'history-only';
  sourceHostSession:string;targetHostSession:string;engineId:string;
}
export interface OriginalAttachmentGrantV2 {
  version:2;commandId:string;targetHostSession:string;originalReference:PublicCard['reference'];
  status:'completed'|'pending'|'unknown'|'refused';accessUri?:string;replayed:false;
}
export interface PublicOriginalResources {
  retainOriginalAttachment:(request:RetainOriginalAttachmentV2)=>Promise<OriginalAttachmentGrantV2>;
  resolveOriginalAttachment:(targetHostSession:string,reference:PublicCard['reference'])=>Promise<OriginalAttachmentGrantV2|null>;
}

const object=(value:unknown):value is Record<string,any>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const fields=(value:unknown,allowed:string[],required=allowed):value is Record<string,any>=>object(value)&&Object.keys(value).every(key=>allowed.includes(key))&&required.every(key=>Object.hasOwn(value,key));
const token=(value:unknown,max?:number):value is string=>typeof value==='string'&&value.length>0&&(max===undefined||[...value].length<=max)&&!/[\x00-\x1f]/.test(value);
const invalid=()=>{throw new Error('Invalid Native public original or exact row occurrence');};
export function resourcesBodyUri(value:string):URL|undefined {
  try{const uri=new URL(value);if(uri.protocol==='amplifier-attachment:'&&uri.pathname==='/body'&&!uri.username&&!uri.password&&!uri.port&&!uri.hash&&uri.searchParams.size===1&&uri.searchParams.get('session')?.startsWith('ahp-session:/')&&/^[-a-f0-9]{36}$/.test(uri.hostname))return uri;}catch{}
}
export function nativeLocator(value:unknown):NativeLocator {
  if(!fields(value,['sessionId','messageId','position','historyEpoch'])||!token(value.sessionId,200)||!token(value.messageId,200)||!Number.isSafeInteger(value.position)||value.position<0||(value.historyEpoch!==null&&!token(value.historyEpoch,200)))return invalid();
  return structuredClone(value) as NativeLocator;
}
export const sameLocator=(left:NativeLocator,right:NativeLocator)=>left.sessionId===right.sessionId&&left.messageId===right.messageId&&left.position===right.position&&left.historyEpoch===right.historyEpoch;
export const sameCard=(left:PublicCard,right:PublicCard)=>left.reference.owner===right.reference.owner&&left.reference.id===right.reference.id&&left.name===right.name&&left.mimeType===right.mimeType&&left.size===right.size&&left.sha256===right.sha256;
export const samePublicMessage=(left:PublicMessageV1,right:PublicMessageV1)=>left.version===right.version&&left.inputId===right.inputId&&left.capture===right.capture&&left.blocks.length===right.blocks.length&&left.blocks.every((block,index)=>{
  const other=right.blocks[index];return block.type==='text'?other?.type==='text'&&block.text===other.text:other?.type==='attachment'&&sameCard(block,other);
});
export function supportsPublicOriginal(capability:any,route:string,resources=false):boolean {
  return capability?.version===1&&Array.isArray(capability.routes)&&capability.routes.includes(route)&&Array.isArray(capability.variants)&&capability.variants.includes('text')&&(!resources||capability.variants.includes('resources'));
}
/** Initialization declares the protocol. Runtime negotiation qualifies the
 * mounted context; a negative report always overrides stale protocol support. */
export function mountedPublicOriginal(capability:any,mounted:any):any {
  if(mounted?.supported===false)return;
  if(capability?.runtimeNegotiated===true)return mounted?.version===1&&mounted.supported===true?mounted:undefined;
  return mounted?.supported===true?mounted:capability;
}
export function publicMessage(value:unknown):PublicMessageV1 {
  if(!fields(value,['version','inputId','capture','blocks'])||value.version!==1||!token(value.inputId,128)||!['host-standard','native-input'].includes(value.capture)||!Array.isArray(value.blocks))return invalid();
  for(const block of value.blocks){
    if(block?.type==='text'){if(!fields(block,['type','text'])||typeof block.text!=='string')return invalid();continue;}
    if(!fields(block,['type','reference','name','mimeType','size','sha256'],['type','reference','name','mimeType'])||block.type!=='attachment'||!fields(block.reference,['owner','id'])||!['resources','native-attachments'].includes(block.reference.owner)||!token(block.reference.id)||!token(block.name,block.reference.owner==='resources'?255:200)||!token(block.mimeType)||!/^[-\w.+]+\/[-\w.+]+$/.test(block.mimeType))return invalid();
    if(block.size!==undefined&&(!Number.isSafeInteger(block.size)||block.size<0)||block.sha256!==undefined&&(typeof block.sha256!=='string'||!/^[a-f0-9]{64}$/.test(block.sha256)))return invalid();
  }
  return structuredClone(value) as PublicMessageV1;
}
export function persistedPublicRow(value:unknown):PersistedPublicRow {
  if(!fields(value,['locator','publicMessage','copySource'],['locator','publicMessage']))return invalid();
  const row:PersistedPublicRow={locator:nativeLocator(value.locator),publicMessage:publicMessage(value.publicMessage)};
  if(value.copySource!==undefined){
    const source=value.copySource;
    if(!fields(source,['version','source','disposition'])||source.version!==1||!['retained','history-only'].includes(source.disposition))return invalid();
    row.copySource={version:1,source:nativeLocator(source.source),disposition:source.disposition};
  }
  return row;
}
export function cardOccurrence(value:unknown):OriginalCardOccurrence {
  if(!fields(value,['row','blockIndex'])||!Number.isSafeInteger(value.blockIndex)||value.blockIndex<0)return invalid();
  return {row:nativeLocator(value.row),blockIndex:value.blockIndex};
}
/** Capture literal supported AHP facts before any resolver. Other variants retain
 * their existing Host history/ACP route; no partial envelope is manufactured. */
export function capturePublicMessage(message:Message,inputId:string):PublicMessageV1|undefined {
  if(message.origin?.kind!=='user')return;
  const blocks:(PublicText|PublicCard)[]=[{type:'text',text:message.text}];
  for(const attachment of message.attachments??[]){
    if(attachment.type!=='resource'||Object.keys(attachment).some(key=>!['type','label','uri','contentType'].includes(key))||!resourcesBodyUri(attachment.uri)||!token(attachment.label,255)||!attachment.contentType||!/^[-\w.+]+\/[-\w.+]+$/.test(attachment.contentType))return;
    blocks.push({type:'attachment',reference:{owner:'resources',id:attachment.uri},name:attachment.label,mimeType:attachment.contentType});
  }
  return publicMessage({version:1,inputId,capture:'host-standard',blocks});
}
/** Access is a separate owner fact; never rewrite a copied original reference. */
export function qualifiedAccessUri(grant:OriginalAttachmentGrantV2|null,targetHostSession:string,reference:PublicCard['reference']):string|undefined {
  if(grant===null)return;
  if(!object(grant)||grant.version!==2||grant.targetHostSession!==targetHostSession||grant.replayed!==false||!token(grant.commandId)||!['completed','pending','unknown','refused'].includes(grant.status)||!object(grant.originalReference)||grant.originalReference.owner!==reference.owner||grant.originalReference.id!==reference.id)throw new Error('Resources original attachment grant scope changed');
  if(grant.status!=='completed'){if(grant.accessUri!==undefined)throw new Error('Unqualified attachment grant supplied access');return;}
  if(!token(grant.accessUri))throw new Error('Completed attachment grant has no scoped access');
  const uri=resourcesBodyUri(grant.accessUri);
  if(!uri||uri.searchParams.get('session')!==targetHostSession)throw new Error('Resources target attachment URI scope changed');
  return uri.href;
}
