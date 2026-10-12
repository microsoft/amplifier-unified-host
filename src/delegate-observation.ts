import {toolExecutionMetadata} from './execution-metadata.js';
type Json = Record<string, any>;
/** Worker reports are saved observations, never messages or control grants. */
export async function delegateObservation(value: Json, save: (block: Json)=>Promise<Json>): Promise<Json|undefined> {
 if(value?.kind!=='worker'||!Number.isSafeInteger(value.revision)||value.revision<1||
    typeof value.id!=='string'||value.id.length>200||Buffer.byteLength(JSON.stringify(value))>65536)return;
 const metadata=toolExecutionMetadata({'amplifier.dev/execution':{version:1,sessionId:value.sessionId,
  parentId:value.parentId,startedAt:value.startedAt,endedAt:value.endedAt,
  delegate:Object.fromEntries(['id','sessionId','label','provider','model','phase','parentProvider','routing','runId','workerId'].filter(k=>k in value).map(k=>[k,value[k]]))}}) as Json;
 const header=metadata['amplifier.dev/execution'];if(!header?.delegate)return;
 const {delegate,...timing}=header;
 const node:Json={...timing,...delegate,kind:'worker',revision:value.revision};
 if(typeof value.summary==='string'&&value.summary.length<=12000){
  if(Buffer.byteLength(value.summary)>4096){
   const ref=await save({data:Buffer.from(value.summary).toString('base64'),mimeType:'text/markdown'});
   node.summary=value.summary.slice(0,1024);node.summaryDetail={uri:ref.uri,contentType:ref.contentType};
  }else node.summary=value.summary;
 }
 return node;
}
