import type {DatabaseSync} from 'node:sqlite';

type Json=Record<string,any>;
export const EXPORT_FLAGS=['includeExecution','includeConversationId','includeTimestamps','includeReferenceIds'] as const;
/** Read indexed scalar observations only. Never copy prompts, tools or reasoning. */
export async function exportObservations(db:DatabaseSync,chat:string,session:string,includeWork:boolean,capabilities?:{
 manifest:{topics:Record<string,{uri:string;version:number}>};
 read:(request:{uri:string;topic:string;scope:string;clientId:string})=>Promise<{topic:string;scope:string;revision:number;data:unknown}>;
}){
 const omissions:string[]=[],work:Json[]=[],artifacts:Json[]=[];
 if(includeWork){
  const rows=db.prepare(`WITH selected AS MATERIALIZED (SELECT turn_id,payload FROM turns WHERE chat=? ORDER BY ordinal DESC LIMIT 1001)
   SELECT turn_id,json_extract(payload,'$.state') state,json_extract(payload,'$.duration') duration,
   (SELECT count(*) FROM json_each(selected.payload,'$.responseParts') WHERE json_extract(value,'$.error.errorType')='NATIVE_OUTCOME_UNKNOWN') unknownOutcome,
   (SELECT count(DISTINCT json_extract(value,'$.toolCall.toolCallId')) FROM json_each(selected.payload,'$.responseParts') WHERE json_extract(value,'$.kind')='toolCall') tools,
   (SELECT count(DISTINCT json_extract(value,'$._meta."amplifier.dev/modelCall".id')) FROM json_each(selected.payload,'$.responseParts')) models
   FROM selected`).all(chat);
  if(rows.length>1000)omissions.push('older_host_work_summaries_exceed_export_limit');
  for(const row of rows.slice(0,1000).reverse()){
   if(typeof row.turn_id!=='string'||row.turn_id.length>1000) {omissions.push('invalid_host_work_summary_omitted');continue;}
   const duration=row.duration;
   work.push({anchor:row.turn_id,status:Number(row.unknownOutcome)>0?'unknown':row.state==='complete'?'completed':['error','cancelled'].includes(String(row.state))?row.state:'unknown',toolCalls:Number(row.tools),modelCalls:Number(row.models),
    ...(!Number(row.unknownOutcome)&&typeof duration==='number'&&Number.isFinite(duration)&&duration>=0&&duration<=31536000000?{durationSeconds:duration/1000}:{})});
  }
 }
 const topic=capabilities?.manifest.topics.canvas;
 if(topic?.version===1){
  try{
   let cursor:string|undefined,revision:number|undefined;const seen=new Set<string>(),cursors=new Set<string>();
   do{
    const uri=new URL(topic.uri);uri.searchParams.set('limit','200');if(cursor)uri.searchParams.set('cursor',cursor);
    const result=await capabilities!.read({uri:uri.href,topic:'canvas',scope:session,clientId:'host:export'}),data=result.data as Json;
    if(result.topic!=='canvas'||result.scope!==session||!Number.isSafeInteger(result.revision)||revision!==undefined&&result.revision!==revision||!Array.isArray(data?.canvasArtifacts)||data.canvasArtifacts.length>200)throw Error('Changed artifact metadata');
    revision=result.revision;
    for(const item of data.canvasArtifacts){
     if(item.sessionId!==session||typeof item.id!=='string'||!item.id||item.id.length>1000||seen.has(item.id)||typeof item.title!=='string'||!item.title||item.title.length>4000||typeof item.kind!=='string'||!item.kind||item.kind.length>1000||item.messageId!=null&&(typeof item.messageId!=='string'||!item.messageId||item.messageId.length>1000))throw Error('Invalid artifact metadata');
     seen.add(item.id);artifacts.push({id:item.id,title:item.title,kind:item.kind,...(item.messageId?{messageId:item.messageId}:{})});
    }
    cursor=data.canvasPage?.nextCursor;
    if(cursor!==undefined&&(typeof cursor!=='string'||!cursor||cursor.length>8192||cursors.has(cursor)))throw Error('Invalid artifact cursor');
    if(cursor)cursors.add(cursor);
    if(artifacts.length>=1000&&cursor){omissions.push('older_artifact_references_exceed_export_limit');break;}
   }while(cursor);
  }catch{artifacts.length=0;omissions.push('artifact_references_unavailable');}
 }else omissions.push('artifact_owner_not_available');
 const value={version:1,source:'host-retained-observations',work,artifacts,omissions:[...new Set(omissions)]};
 // Never silently omit oversized contributions; preserve the original request.
 if(Buffer.byteLength(JSON.stringify(value))>1048576)throw Error('Export observations exceed the 1 MiB bound; select a smaller conversation');
 return value;
}
