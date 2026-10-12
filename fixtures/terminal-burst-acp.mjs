// Independent wire fixture: completion and its preceding events share one read.
import readline from 'node:readline';
import {createHash} from 'node:crypto';
const nativeId='native-burst-root';
const write=rows=>process.stdout.write(rows.map(row=>JSON.stringify({jsonrpc:'2.0',...row})+'\n').join(''));
for await(const line of readline.createInterface({input:process.stdin})){
 const m=JSON.parse(line),p=m.params??{};
 if(m.method==='initialize')write([{id:m.id,result:{protocolVersion:1,agentCapabilities:{_meta:{'amplifier.dev/native':{version:1,peerTurns:{version:1,results:{version:1,checkpointed:true}}}}},authMethods:[]}}]);
 else if(m.method==='session/new')write([{id:m.id,result:{sessionId:nativeId}}]);
 else if(m.method==='session/prompt'){
  const inputId=p._meta?.['amplifier.dev/command']?.commandId,generationId='generation-'+m.id,text='Saved burst answer',mode=p.prompt?.[0]?.text;
  write([{method:'_amplifier/event',params:{sessionId:nativeId,event:{type:'generation.started',sessionId:nativeId,rootSessionId:nativeId,generation_id:generationId,activeInputId:inputId}}}]);
  setTimeout(()=>write([
   {method:'session/update',params:{sessionId:nativeId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}},
   {method:'_amplifier/event',params:{sessionId:mode==='foreign'?'wrong-session':nativeId,event:{type:'generation.finished',sessionId:nativeId,rootSessionId:nativeId,generation_id:generationId,input_ids:[inputId],active_job_ids:[],disposition:'manager_turn_finished',text,peerTerminal:{version:1,rootSessionId:nativeId,generationId,inputIds:[inputId],messageId:'native:burst-answer-'+inputId,sourceRevision:'saved-burst-revision',textDigest:createHash('sha256').update(text).digest('hex')}}}},
   mode==='reject'?{id:m.id,error:{code:-32603,message:'Fixture stopped after checkpoint'}}:{id:m.id,result:{stopReason:mode==='cancel'?'cancelled':'end_turn'}}
  ]),20);
 }
 else if(m.id!==undefined)write([{id:m.id,result:{}}]);
}
