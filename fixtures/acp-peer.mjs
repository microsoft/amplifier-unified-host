// Independent JSON-RPC ACP fixture: no host imports and no production models/accounts.
import readline from 'node:readline';
import { appendFileSync,readFileSync,writeFileSync,existsSync } from 'node:fs';
const sessions=new Map();let active,background,retired=false;let permissionId=1000;const pending=new Map();
const send=m=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\n');
const update=(sessionId,update)=>send({method:'session/update',params:{sessionId,update}});
const reply=(id,result)=>send({id,result});
const locations=()=>process.env.FIXTURE_LOG&&existsSync(process.env.FIXTURE_LOG+'.locations')?JSON.parse(readFileSync(process.env.FIXTURE_LOG+'.locations','utf8')):{};
for await(const line of readline.createInterface({input:process.stdin})) {
  const message=JSON.parse(line),p=message.params??{};
  if(message.result!==undefined||message.error){pending.get(message.id)?.(message.error?{error:message.error}:message.result);pending.delete(message.id);continue;}
  if(message.method==='initialize')reply(message.id,{protocolVersion:1,agentInfo:{name:'independent-fixture',version:'1'},agentCapabilities:{loadSession:true,sessionCapabilities:{resume:{},close:{}},promptCapabilities:{image:true,audio:true,embeddedContext:true},_meta:{'amplifier.dev/native':{version:1,configurationClone:{version:1},...(process.env.FIXTURE_NO_RETIRE?{}:{lifecycle:{version:1,gracefulRetire:true}}),relocation:{version:1,passiveInspection:true},scheduledTurns:{version:1,completion:'settled'},questionTurns:{version:1,completion:'settled',active:false},history:{version:1,paging:'complete-turns',passive:true,passiveInspect:true}}}},authMethods:[]});
  else if(message.method==='_amplifier/retire'){
    if(background){reply(message.id,{retired:false,reason:'owned_work'});continue;}
    retired=true;reply(message.id,{retired:true});
  }
  else if(message.method==='_amplifier/native'&&p.operation==='fixture.background.start'){
    background=setInterval(()=>appendFileSync(process.env.FIXTURE_LOG+'.background','tick\n'),10);reply(message.id,{id:'background-1'});
  }
  else if(message.method==='_amplifier/native'&&p.operation==='fixture.background.observe'){
    reply(message.id,{});setTimeout(async()=>{
      const observed=permissionId++;const result=new Promise(resolve=>pending.set(observed,resolve));send({id:observed,method:'_amplifier/host',params:{sessionId:p.sessionId,operation:'operations.observe',args:{runtimeSessionId:p.sessionId,event:{id:'background-1',phase:'finished',output:'late owned result'}}}});const value=await result;appendFileSync(process.env.FIXTURE_LOG+'.observations',JSON.stringify(value)+'\n');
      send({id:permissionId++,method:'_amplifier/host',params:{sessionId:p.sessionId,operation:'app.dispatch',args:{}}});
    },50);
  }
  else if(message.method==='_amplifier/native'&&p.operation==='fixture.background.stop'){clearInterval(background);background=undefined;reply(message.id,{});}
  else if(message.method==='_amplifier/native'&&p.operation==='fixture.runtime.loss'){
    send({method:'_amplifier/event',params:{sessionId:p.sessionId,event:{type:'runtime.closed'}}});reply(message.id,{});setTimeout(()=>process.exit(17),20);
  }
  else if(message.method==='_amplifier/history/inspect'){if(process.env.FIXTURE_LOG)appendFileSync(process.env.FIXTURE_LOG+'.passive','inspect\n');reply(message.id,{available:!!process.env.FIXTURE_HISTORY,revision:process.env.FIXTURE_HISTORY?'fixture-revision':null,diagnostics:[]});}
  else if(message.method==='_amplifier/history'){
    if(process.env.FIXTURE_LOG)appendFileSync(process.env.FIXTURE_LOG+'.passive','page\n');
    if(p.expectedRevision&&p.expectedRevision!=='fixture-revision'){send({id:message.id,error:{code:-32011,message:'History source changed'}});continue;}
    const groups=JSON.parse(readFileSync(process.env.FIXTURE_HISTORY,'utf8'));const end=p.cursor?Number(p.cursor):groups.length,start=Math.max(0,end-p.limit);
    reply(message.id,{turnGroups:groups.slice(start,end),revision:'fixture-revision',diagnostics:[],nextCursor:start?String(start):null});
  }
  else if(message.method==='_amplifier/relocation'||message.method==='_amplifier/relocation/reconcile'){
    const location=locations()[p.sessionId]??{sessionId:p.sessionId,historyCwd:p.historyCwd,executionDirectory:p.historyCwd,executionRevision:0,blocked:false};
    reply(message.id,{...location,...(message.method.endsWith('/reconcile')?{reconciled:location.receipt?.commandId===p.commandId&&location.receipt?.status==='applied'}:{})});
  }
  else if(message.method==='_amplifier/native'&&p.operation==='session.relocate'){
    const entries=locations(),prior=entries[p.sessionId]??{historyCwd:process.cwd(),executionDirectory:process.cwd(),executionRevision:0};
    if(p.args.expectedExecutionRevision!==prior.executionRevision){reply(message.id,{applied:false,reason:'Location revision changed'});continue;}
    const result={sessionId:p.sessionId,historyCwd:prior.historyCwd,executionDirectory:p.args.target,executionRevision:prior.executionRevision+1,blocked:false,receipt:{commandId:p.args.commandId,status:'applied',target:p.args.target}};
    entries[p.sessionId]=result;writeFileSync(process.env.FIXTURE_LOG+'.locations',JSON.stringify(entries));
    if(p.args.target.endsWith('/lost')){process.exit(17);continue;}
    reply(message.id,{...result,applied:true});
  }
  else if(message.method==='_amplifier/native'&&p.operation==='configuration.snapshot')reply(message.id,{version:1,sourceSessionId:p.sessionId,sourceCwd:process.cwd(),configurationHash:'fixture-native-config'});
  else if(message.method==='_amplifier/session/new'){if(process.env.FIXTURE_LOG)appendFileSync(process.env.FIXTURE_LOG,JSON.stringify({creation:p})+'\n');if(process.env.FIXTURE_CLONE_CRASH)process.exit(17);sessions.set(p.sessionId,{});reply(message.id,{sessionId:p.sessionId,configOptions:[],_meta:{'amplifier.dev/native':{creationConfirmed:true,configurationHash:p.source.configurationHash}}});}
  else if(message.method==='session/new'){const sessionId='native-'+Math.random().toString(36).slice(2);sessions.set(sessionId,{});reply(message.id,{sessionId,...(process.env.FIXTURE_LEGACY?{modes:{currentModeId:'safe',availableModes:[{id:'safe',name:'Safe'},{id:'fast',name:'Fast'}]}}:{configOptions:[{id:'mode',name:'Mode',type:'select',currentValue:'safe',options:[{value:'safe',name:'Safe'},{value:'fast',name:'Fast'}]}]})});
    if(process.env.FIXTURE_LEGACY)setTimeout(()=>{update(sessionId,{sessionUpdate:'available_commands_update',availableCommands:[{name:'inspect',description:'Inspect local context',input:{hint:'path'}}]});update(sessionId,{sessionUpdate:'usage_update',used:123,size:4096,cost:{amount:0.12,currency:'USD'}});update(sessionId,{sessionUpdate:'session_info_update',title:'Idle peer title',updatedAt:'2026-10-02T00:00:00Z'});update(sessionId,{sessionUpdate:'current_mode_update',currentModeId:'fast'});},30);
  }
  else if(message.method==='session/resume'||message.method==='session/load'){sessions.set(p.sessionId,{});if(process.env.FIXTURE_LOCATIONS)appendFileSync(process.env.FIXTURE_LOG,JSON.stringify({resumed:p,processCwd:process.cwd()})+'\n');reply(message.id,{configOptions:[]});}
  else if(message.method==='session/set_mode'){if(process.env.FIXTURE_LOG)appendFileSync(process.env.FIXTURE_LOG,JSON.stringify({modeChange:p})+'\n');update(p.sessionId,{sessionUpdate:'current_mode_update',currentModeId:p.modeId});reply(message.id,{});}
  else if(message.method==='session/set_config_option')reply(message.id,{configOptions:[{id:'mode',name:'Mode',type:'select',currentValue:p.value,options:[{value:'safe',name:'Safe'},{value:'fast',name:'Fast'}]}]});
  else if(message.method==='session/close')reply(message.id,{});
  else if(message.method==='session/prompt'||message.method==='_amplifier/native'&&['schedule.submit','question.submit'].includes(p.operation)){
    if(retired){send({id:message.id,error:{code:-32000,message:'Session handle retired'}});continue;}
    const scheduled=message.method==='_amplifier/native';
    if(scheduled&&(p.args.taskRevision===99||p.args.questionRevision===99)){reply(message.id,{accepted:false,reason:'Saved task changed'});continue;}
    if(process.env.FIXTURE_LOG)appendFileSync(process.env.FIXTURE_LOG,JSON.stringify({...p,...(process.env.FIXTURE_LOCATIONS?{processCwd:process.cwd()}: {})})+'\n');
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
      if(text==='mapping-permission'){
        update(p.sessionId,{sessionUpdate:'tool_call',toolCallId:'approval-replace',title:'Changed permission input',status:'pending',rawInput:{path:'old'}});
        const requestId=permissionId++;
        const choice=new Promise(resolve=>{pending.set(requestId,resolve);send({id:requestId,method:'session/request_permission',params:{sessionId:p.sessionId,toolCall:{toolCallId:'approval-replace',title:'Changed permission input',status:'pending'},options:[{optionId:'allow',name:'Allow once',kind:'allow_once'},{optionId:'deny',name:'Deny once',kind:'reject_once'}]}});});
        await new Promise(resolve=>setTimeout(resolve,30));
        update(p.sessionId,{sessionUpdate:'tool_call_update',toolCallId:'approval-replace',rawInput:{path:'new'}});
        const result=await choice;
        update(p.sessionId,{sessionUpdate:'tool_call_update',toolCallId:'approval-replace',status:result.outcome.optionId==='allow'?'completed':'failed'});
      }
      if(text==='mapping'){
        update(p.sessionId,{sessionUpdate:'tool_call',toolCallId:'replace-tool',name:'read_file',title:'Read file',kind:'read',status:'pending',rawInput:{path:'initial'},content:[{type:'content',content:{type:'text',text:'retained output'}}]});
        update(p.sessionId,{sessionUpdate:'tool_call_update',toolCallId:'replace-tool',rawInput:{path:'replacement'}});
        update(p.sessionId,{sessionUpdate:'tool_call_update',toolCallId:'replace-tool',status:'in_progress'});
        update(p.sessionId,{sessionUpdate:'tool_call_update',toolCallId:'replace-tool',rawInput:{path:'final'}});
        update(p.sessionId,{sessionUpdate:'tool_call_update',toolCallId:'replace-tool',status:'completed'});
        update(p.sessionId,{sessionUpdate:'available_commands_update',availableCommands:[]});
        update(p.sessionId,{sessionUpdate:'usage_update',used:321,size:4096,cost:{amount:0.34,currency:'USD'}});
      }
      if(text==='stream-metadata'){
        update(p.sessionId,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'x'.repeat(32000)}});
        for(let i=0;i<20;i++)update(p.sessionId,{sessionUpdate:'usage_update',used:i,size:4096});
        await new Promise(resolve=>setTimeout(resolve,150));
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
      reply(id,{...(text==='mapping'?{usage:{totalTokens:31,inputTokens:20,outputTokens:11,cachedReadTokens:4,cachedWriteTokens:2,thoughtTokens:3}}:{}),...(scheduled?{accepted:true,inputId:p.args.inputId}:{}),stopReason:turn.cancelled?'cancelled':'end_turn'});
    })();
  } else if(message.method==='session/cancel'){if(active)active.cancelled=true;}
  else if(message.id!==undefined)send({id:message.id,error:{code:-32601,message:'Unsupported'}});
}
