/** Passive source DTOs, independent of any recall/index implementation. */
export interface RecallSource {id:string;title:string;workspace:string;kind:string;parentId?:string;}
export interface RecallRow {id:string;role:'user'|'assistant';text:string;createdAt?:string;via?:string;inputOrigin:string;sourceKind:'native-history';authorization:'unverified-native-history';questionId?:string;scheduledRunId?:string;voiceId?:string;voiceItemId?:string;}
export const RECALL_LIMITS=Object.freeze({maxTurns:50,maxRows:1000,maxBytes:2*1024*1024});
/** Map storage-owner supplied message identities, never infer consent from a user role. */
export function recallRows(groups:Array<{updates:Record<string,any>[]}>):{rows:RecallRow[];omittedUpdates:number} {
  const rows:RecallRow[]=[],byId=new Map<string,RecallRow>();let omittedUpdates=0;
  for(const group of groups)for(const update of group.updates){
    const role=update.sessionUpdate==='user_message_chunk'?'user':update.sessionUpdate==='agent_message_chunk'?'assistant':undefined;
    if(!role||update.content?.type!=='text'){omittedUpdates++;continue;}
    const meta=update._meta?.['amplifier.dev/history'];
    if(!meta||typeof meta.messageId!=='string'||!meta.messageId||meta.messageId.length>512||typeof update.content.text!=='string')throw new Error('Native history message identity/content is unavailable');
    let row=byId.get(meta.messageId);
    if(row&&row.role!==role)throw new Error('Native history message identity has conflicting roles');
    if(!row){
      row={id:meta.messageId,role,text:'',inputOrigin:typeof meta.inputOrigin==='string'?meta.inputOrigin:'unknown',sourceKind:'native-history',authorization:'unverified-native-history'};
      for(const [key,value] of Object.entries({createdAt:meta.createdAt,via:meta.via,questionId:meta.questionId,scheduledRunId:meta.scheduledRunId,voiceId:meta.voiceId??meta.callId,voiceItemId:meta.voiceItemId??meta.itemId}))if(typeof value==='string'&&value.length<=512)(row as any)[key]=value;
      rows.push(row);byId.set(row.id,row);
    }
    row.text+=update.content.text;
    if(rows.length>RECALL_LIMITS.maxRows)throw new Error('Native history page exceeds the complete-message row bound; use a smaller turn limit');
  }
  if(Buffer.byteLength(JSON.stringify(rows))>RECALL_LIMITS.maxBytes)throw new Error('Native history page exceeds the complete-message byte bound; use a smaller turn limit');
  return {rows,omittedUpdates};
}
