import { createHash } from 'node:crypto';
import type { Turn } from '@microsoft/agent-host-protocol';

/** Add saved passive inputs between matched public parts without losing live
 * provider recordings. Their order relative to public content is canonical;
 * diagnostics retain their observed order within each public-content interval.
 */
export function retainPassiveInputs(canonical:any[],observed:any[],normalizeTool:(id:string)=>string):any[] {
  const key=(part:any)=>part.kind==='toolCall'?'tool:'+normalizeTool(String(part.toolCall.toolCallId)):
    part._meta?.['amplifier.dev/history']?.messageId?'message:'+part._meta['amplifier.dev/history'].messageId:undefined;
  const result=[...observed];
  for(let index=0;index<canonical.length;index++){
    const part=canonical[index],history=part._meta?.['amplifier.dev/history'];
    if(part.kind!=='systemNotification'||history?.inputOrigin!=='peer'||history.recordedOnly!==true||history.peerEnvelope?.mode!=='notify')continue;
    const identity=key(part);if(!identity)throw new Error('Passive input lacks canonical identity');
    if(result.some(row=>key(row)===identity))continue;
    const following=canonical.slice(index+1).map(key).find(value=>value&&result.some(row=>key(row)===value));
    const position=following?result.findIndex(row=>key(row)===following):result.length;
    result.splice(position,0,part);
  }
  return result;
}

/** Exact shared IDs anchor two ordered sources; receipt payloads never decide canonical order. */
export function mergeHistoryTurns(canonical:Turn[],live:Turn[]):Turn[] {
  const positions=new Map(live.map((turn,index)=>[turn.id,index]));
  const result:Turn[]=[];let nativeStart=0,liveStart=0;
  for(let index=0;index<canonical.length;index++){
    const position=positions.get(canonical[index].id);if(position===undefined)continue;
    if(position<liveStart)throw new Error('Native and host history ordering disagree; reconcile the canonical history boundary');
    if(position>liveStart&&index>nativeStart)throw new Error('Unindexed native and host rows share an ordering interval');
    result.push(...live.slice(liveStart,position),...canonical.slice(nativeStart,index),{...live[position],message:{...live[position].message,_meta:{...live[position].message._meta,...canonical[index].message._meta}}});
    nativeStart=index+1;liveStart=position+1;
  }
  if(nativeStart<canonical.length&&liveStart<live.length)throw new Error('Unindexed native and host rows share an ordering interval');
  result.push(...canonical.slice(nativeStart),...live.slice(liveStart));return result;
}
export function turnIdentityHash(turns:readonly (Turn|string)[]):string {
  return createHash('sha256').update(JSON.stringify(turns.map(turn=>typeof turn==='string'?turn:turn.id))).digest('hex');
}
