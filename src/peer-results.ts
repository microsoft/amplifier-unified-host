import {createHash} from 'node:crypto';
type Json=Record<string,any>;
/** Native owner evidence only; an agent-supplied reply cannot manufacture this. */
export function peerTerminal(event:Json,nativeId:string,generationId:string|undefined,capability:Json|undefined):Json|undefined {
 const p=event.peerTerminal;
 if(capability?.version!==1||capability.checkpointed!==true||event.type!=='generation.finished'||!generationId||
    event.generation_id!==generationId||event.sessionId!==nativeId||event.rootSessionId!==nativeId||
    event.disposition!=='manager_turn_finished'||!Array.isArray(event.active_job_ids)||event.active_job_ids.length||
    !Array.isArray(event.input_ids)||event.input_ids.length>200||typeof event.text!=='string'||!event.text.trim()||!p||p.version!==1||p.rootSessionId!==nativeId||p.generationId!==generationId||
    !Array.isArray(p.inputIds)||!p.inputIds.length||p.inputIds.length>200||new Set(p.inputIds).size!==p.inputIds.length||
    p.inputIds.some((id:any)=>typeof id!=='string'||!id.startsWith('peer:')||id.length>200||!event.input_ids?.includes(id))||
    typeof p.messageId!=='string'||!p.messageId.startsWith('native:')||p.messageId.length>512||
    typeof p.sourceRevision!=='string'||!p.sourceRevision||p.sourceRevision.length>512||
    p.textDigest!==createHash('sha256').update(event.text).digest('hex'))return;
 return structuredClone({version:1,rootSessionId:nativeId,generationId,inputIds:p.inputIds,messageId:p.messageId,sourceRevision:p.sourceRevision,textDigest:p.textDigest});
}
