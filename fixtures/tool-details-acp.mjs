// Independent ACP peer: deterministic large public results, no model/network.
import readline from 'node:readline';
import {appendFileSync} from 'node:fs';
const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
const reply=(id,result)=>send({id,result});
let permission;
for await(const line of readline.createInterface({input:process.stdin})){
 const m=JSON.parse(line),p=m.params||{};
 if(m.id===9000&&permission){const pending=permission;permission=null;pending(m.result);continue;}
 if(m.method==='initialize')reply(m.id,{protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[]});
 else if(['session/new','session/load'].includes(m.method))reply(m.id,{sessionId:p.sessionId||'details-session'});
 else if(m.method==='session/prompt'){
  appendFileSync(process.env.FIXTURE_LOG,'prompt\n');
  const text=p.prompt.filter(b=>b.type==='text').map(b=>b.text).join('\n');
  const update=body=>send({method:'session/update',params:{sessionId:p.sessionId,update:body}});
  const input={command:'echo details',payload:'INPUT-LARGE-'.repeat(1000)};
  const finish=()=>{
   update({sessionUpdate:'tool_call',toolCallId:'large',name:'bash',kind:'execute',title:'Read large output',status:'in_progress',rawInput:input,_meta:{'amplifier.dev/execution':{version:1,sessionId:'review',startedAt:12,delegate:{id:'worker:review',sessionId:'review',label:'Reviewer',summary:'PRIVATE-REPORT-NOT-IN-HEADER'}}}});
   update({sessionUpdate:'tool_call_update',toolCallId:'large',status:'completed',rawOutput:{stdout:'OUTPUT-LARGE-'.repeat(12000)+'FINAL-OUTPUT-MARKER',stderr:'',exit_code:0},content:[{type:'content',content:{type:'text',text:'OUTPUT-LARGE-'.repeat(12000)+'FINAL-OUTPUT-MARKER'}}]});
   update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'The first output is saved.'}});
   update({sessionUpdate:'tool_call',toolCallId:'failed',name:'read_file',kind:'read',title:'Second result failed',status:'failed',rawInput:{path:'missing'},rawOutput:{success:false,error:'FAILURE-LARGE-'.repeat(1000)+'FINAL-ERROR-MARKER'}});
   update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'The second result is available for inspection.'}});
   reply(m.id,{stopReason:'end_turn'});
  };
  if(text.includes('approval')){
   permission=result=>{appendFileSync(process.env.FIXTURE_LOG,JSON.stringify(result)+'\n');finish();};
   send({id:9000,method:'session/request_permission',params:{sessionId:p.sessionId,toolCall:{toolCallId:'large',title:'Review the complete input',kind:'execute',rawInput:input},options:[{optionId:'allow',name:'Allow once',kind:'allow_once'},{optionId:'deny',name:'Deny once',kind:'reject_once'}]}});
   update({sessionUpdate:'tool_call_update',toolCallId:'large',status:'in_progress',rawInput:{...input,command:'echo reviewed replacement'}});
  }else finish();
 }else if(m.id!==undefined)reply(m.id,{});
}
