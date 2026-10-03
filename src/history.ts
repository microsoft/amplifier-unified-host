import { createHash } from 'node:crypto';
import type { Turn } from '@microsoft/agent-host-protocol';

/** Exact shared IDs anchor two ordered sources; receipt payloads never decide canonical order. */
export function mergeHistoryTurns(canonical:Turn[],live:Turn[]):Turn[] {
  const positions=new Map(live.map((turn,index)=>[turn.id,index]));
  const result:Turn[]=[];let nativeStart=0,liveStart=0;
  for(let index=0;index<canonical.length;index++){
    const position=positions.get(canonical[index].id);if(position===undefined)continue;
    if(position<liveStart)throw new Error('Native and host history ordering disagree; reconcile the canonical history boundary');
    if(position>liveStart&&index>nativeStart)throw new Error('Unindexed native and host rows share an ordering interval');
    result.push(...live.slice(liveStart,position),...canonical.slice(nativeStart,index),live[position]);
    nativeStart=index+1;liveStart=position+1;
  }
  if(nativeStart<canonical.length&&liveStart<live.length)throw new Error('Unindexed native and host rows share an ordering interval');
  result.push(...canonical.slice(nativeStart),...live.slice(liveStart));return result;
}
export function turnIdentityHash(turns:readonly (Turn|string)[]):string {
  return createHash('sha256').update(JSON.stringify(turns.map(turn=>typeof turn==='string'?turn:turn.id))).digest('hex');
}
