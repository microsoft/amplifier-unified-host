// Independent JSON-RPC ACP fixture: no host imports and no production models/accounts.
import readline from 'node:readline';
import { appendFileSync,readFileSync } from 'node:fs';
const sessions=new Map();let active;let permissionId=1000;const pending=new Map();
const send=m=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\n');
const update=(sessionId,update)=>send({method:'session/update',params:{sessionId,update}});
const reply=(id,result)=>send({id,result});
for await(const line of readline.createInterface({input:process.stdin})) {
  const message=JSON.parse(line),p=message.params??{};
  if(message.result!==undefined){pending.get(message.id)?.(message.result);pending.delete(message.id);continue;}
  if(message.method==='initialize')reply(message.id,{protocolVersion:1,agentInfo:{name:'independent-fixture',version:'1'},agentCapabilities:{loadSession:true,sessionCapabilities:{resume:{},close:{}},promptCapabilities:{image:true,audio:true,embeddedContext:true},_meta:{'amplifier.dev/native':{version:1,configurationClone:{version:1},scheduledTurns:{version:1,completion:'settled'},history:{version:1,paging:'complete-turns',passive:true}}}},authMethods:[]});
  else if(message.method==='_amplifier/history'){
    const groups=JSON.parse(readFileSync(process.env.FIXTURE_HISTORY,'utf8'));const end=p.cursor?Number(p.cursor):groups.length,start=Math.max(0,end-p.limit);
    reply(message.id,{turnGroups:groups.slice(start,end),revision:'fixture-revision',diagnostics:[],nextCursor:start?String(start):null});
  }
  else if(message.method==='_amplifier/native'&&p.operation==='configuration.snapshot')reply(message.id,{version:1,sourceSessionId:p.sessionId,sourceCwd:process.cwd(),configurationHash:'fixture-native-config'});
  else if(message.method==='_amplifier/session/new'){if(process.env.FIXTURE_LOG)appendFileSync(process.env.FIXTURE_LOG,JSON.stringify({creation:p})+'\n');if(process.env.FIXTURE_CLONE_CRASH)process.exit(17);sessions.set(p.sessionId,{});reply(message.id,{sessionId:p.sessionId,configOptions:[],_meta:{'amplifier.dev/native':{creationConfirmed:true,configurationHash:p.source.configurationHash}}});}
  else if(message.method==='session/new'){const sessionId='native-'+Math.random().toString(36).slice(2);sessions.set(sessionId,{});reply(message.id,{sessionId,configOptions:[{id:'mode',name:'Mode',type:'select',currentValue:'safe',options:[{value:'safe',name:'Safe'},{value:'fast',name:'Fast'}]}]});}
  else if(message.method==='session/resume'||message.method==='session/load'){sessions.set(p.sessionId,{});reply(message.id,{configOptions:[]});}
  else if(message.method==='session/set_config_option')reply(message.id,{configOptions:[{id:'mode',name:'Mode',type:'select',currentValue:p.value,options:[{value:'safe',name:'Safe'},{value:'fast',name:'Fast'}]}]});
  else if(message.method==='session/close')reply(message.id,{});
  else if(message.method==='session/prompt'||message.method==='_amplifier/native'&&p.operation==='schedule.submit'){
    const scheduled=message.method==='_amplifier/native';
    if(scheduled&&p.args.taskRevision===99){reply(message.id,{accepted:false,reason:'Saved task changed'});continue;}
    if(process.env.FIXTURE_LOG)appendFileSync(process.env.FIXTURE_LOG,JSON.stringify(p)+'\n');
    const text=scheduled?p.args.text:p.prompt.filter(b=>b.type==='text').map(b=>b.text).join(' '),id=message.id;
    active={id,sessionId:p.sessionId,cancelled:false};
    void(async()=>{
      const turn=active;
      if(text==='crash'){process.exit(17);return;}
      if(text==='approval'){
        const requestId=permissionId++;
        const choice=await new Promise(resolve=>{pending.set(requestId,resolve);send({id:requestId,method:'session/request_permission',params:{sessionId:p.sessionId,toolCall:{toolCallId:'tool-1',title:'Write file',kind:'edit',status:'pending'},options:[{optionId:'allow',name:'Allow once',kind:'allow_once'},{optionId:'deny',name:'Deny once',kind:'reject_once'}]}});});
        update(p.sessionId,{sessionUpdate:'tool_call_update',toolCallId:'tool-1',title:'Write file',status:choice.outcome.optionId==='allow'?'completed':'failed',content:[{type:'content',content:{type:'text',text:JSON.stringify(choice)}}]});
      }
      if(text==='slow')await new Promise(resolve=>setTimeout(resolve,180));
      if(text==='client-tool'){
        const requestId=permissionId++;
        const outcome=await new Promise(resolve=>{pending.set(requestId,resolve);send({id:requestId,method:'_amplifier/host',params:{sessionId:p.sessionId,operation:'ui.inspect',args:{}}});});
        update(p.sessionId,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(outcome)}});
      }
      if(text==='terminal'){
        const call=method=>async params=>{const requestId=permissionId++;return new Promise(resolve=>{pending.set(requestId,resolve);send({id:requestId,method,params:{sessionId:p.sessionId,...params}});});};
        const terminal=await call('terminal/create')({command:process.execPath,args:['-e','process.stdout.write("terminal proof")']});
        await call('terminal/wait_for_exit')({terminalId:terminal.terminalId});
        update(p.sessionId,{sessionUpdate:'tool_call',toolCallId:'terminal-tool',title:'Run process',kind:'execute',status:'completed',content:[{type:'terminal',terminalId:terminal.terminalId}]});
      }
      if(text==='many')for(let i=0;i<100;i++)update(p.sessionId,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'x'}});
      else update(p.sessionId,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Echo: '+text}});
      reply(id,{...(scheduled?{accepted:true,inputId:p.args.inputId}:{}),stopReason:turn.cancelled?'cancelled':'end_turn'});
    })();
  } else if(message.method==='session/cancel'){if(active)active.cancelled=true;}
  else if(message.id!==undefined)send({id:message.id,error:{code:-32601,message:'Unsupported'}});
}
