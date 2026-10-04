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
  if(message.method==='initialize'){if(process.env.FIXTURE_MESSAGE_INIT)appendFileSync(process.env.FIXTURE_MESSAGE_INIT,JSON.stringify(p)+'\n');reply(message.id,{protocolVersion:1,agentInfo:{name:'independent-fixture',version:'1'},agentCapabilities:{loadSession:true,sessionCapabilities:{resume:{},close:{}},promptCapabilities:{image:true,audio:true,embeddedContext:true},_meta:{'amplifier.dev/native':{version:1,...(process.env.FIXTURE_INPUT_OUTCOME?{inputOutcome:JSON.parse(process.env.FIXTURE_INPUT_OUTCOME)}:{}),...(process.env.FIXTURE_MESSAGE_INTERACTIONS?{messageInteractions:JSON.parse(process.env.FIXTURE_MESSAGE_INTERACTIONS)}:{}),...(process.env.FIXTURE_MANAGED?{managedCreation:{version:1,passive:true,configurationScope:'global-and-session',typedSelection:true}}:{}),...(process.env.FIXTURE_TRANSFER?{transfer:{version:1,passiveInspection:true}}:{}),sessionLifecycle:{version:1,passive:true,deletion:'preserve-history',retention:{version:1},...(process.env.FIXTURE_RETIRED_COPIES?{retiredCopies:{version:1,duplicateFilesOnly:true,retirementAuthority:'launcher-assertion'}}:{}),recoveryCopy:{version:1},bundleFork:{version:1},descendantGuard:{version:1}},configurationClone:{version:1},taskState:{version:1,passive:true},workers:{version:1,passiveInspection:true,residentControls:true},activeSteering:{version:1,mode:'request_boundary',cancellable:false},...(process.env.FIXTURE_NO_RETIRE?{}:{lifecycle:{version:1,gracefulRetire:true,...(process.env.FIXTURE_RUNTIME_RETENTION?{runtimeRetention:JSON.parse(process.env.FIXTURE_RUNTIME_RETENTION)}:{}),...(process.env.FIXTURE_RETIRE_STATUS_CAPABILITY?{retirementStatus:{version:1,method:'_amplifier/retire/status',passive:true}}:{})}}),relocation:{version:1,passiveInspection:true},scheduledTurns:{version:1,completion:'settled'},questionTurns:{version:1,completion:'settled',active:false},observationTurns:{version:1,completion:'settled',active:false},history:{version:1,paging:'complete-turns',passive:true,passiveInspect:true}}}},authMethods:[]});}
  else if(message.method==='_amplifier/managed'){
    const file=process.env.FIXTURE_LOG+'.managed',rows=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{};
    if(p.operation==='receipt'){reply(message.id,rows[p.commandId]??null);continue;}
    appendFileSync(process.env.FIXTURE_LOG+'.creations',JSON.stringify(p)+'\n');
    if(p.commandId==='refused-managed'){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:-32011,message:'Native preflight refused',data:{executed:false}}})+'\n');continue;}
    const result={sessionId:p.sessionId,historyCwd:p.cwd,executionDirectory:p.cwd,executionRevision:0,creationConfirmed:true,location:{version:1,kind:'managed',allocationId:p.sessionId,creationReceipt:p.commandId,allocationHash:p.allocationHash,owner:'amplifier-unified'},title:p.title??'New chat',bundle:'fixture',configurationScope:'global-and-session',runtimeStarted:false,workReplayed:false};
    const receipt={commandId:p.commandId,status:p.commandId.startsWith('unknown-')?'unknown':'completed',result,replayed:false};rows[p.commandId]=receipt;writeFileSync(file,JSON.stringify(rows));
    if(p.commandId.startsWith('lost-')||p.commandId.startsWith('unknown-')){process.exit(17);continue;}reply(message.id,receipt);
  }
  else if(message.method==='_amplifier/transfer'){
    const file=process.env.FIXTURE_TRANSFER,entries=JSON.parse(readFileSync(file,'utf8')),value=entries[p.args.transferId];
    if(!value||value.nativeSessionId!==p.sessionId||value.historyCwd!==p.cwd){send({id:message.id,error:{code:-32011,message:'Fixture signed authority differs'}});continue;}
    if(p.operation==='inspect'){reply(message.id,{receipt:value.receipt??null,fence:value.fence??null,transferPhase:value.transferPhase??'prepared'});continue;}
    appendFileSync(file+'.calls',p.operation+'\n');
    const phase={'source.fence':'source-fenced','source.commit':'source-committed','source.cancel':'cancelled'}[p.operation];
    if(!phase){send({id:message.id,error:{code:-32601,message:'Unknown fixture transition'}});continue;}
    value.fence=phase==='cancelled'?null:{transfer_id:p.args.transferId,role:'source',destination_host:value.destination,phase:phase==='source-committed'?'committed':'prepared'};
    value.receipt={version:1,transferId:p.args.transferId,nativeSessionId:p.sessionId,historyCwd:p.cwd,executionDirectory:p.cwd,phase,source:value.source,destination:value.destination,inputsReplayed:false,authority:'foundation-transfer-fence',...(value.fence?{fence:value.fence}:{})};
    writeFileSync(file,JSON.stringify(entries));
    if(process.env.FIXTURE_TRANSFER_LOST_OPERATION===p.operation){process.exit(17);continue;}reply(message.id,value.receipt);
  }
  else if(message.method==='_amplifier/session'){
    const file=process.env.FIXTURE_LOG+'.lifecycle',rows=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{};
    if(p.operation==='inspect'){reply(message.id,{sessionId:p.sessionId,historyRevision:process.env.FIXTURE_HISTORY_LIFECYCLE?'fixture-revision':'fixture-history',metadata:{},location:{historyCwd:p.cwd,executionDirectory:p.cwd,executionRevision:0,blocked:false},state:{deleted:false},preserved:['transcript','events']});continue;}
    if(p.operation==='receipt'){reply(message.id,{receipt:rows[p.args.commandId]??null});continue;}
    if(p.operation==='legacyCopy.inventory'){reply(message.id,{roots:[{id:'old-app',format:'unified-session-store-v1',writerState:'retired'}],selectedSessionId:p.sessionId,canonicalFilesRead:false});continue;}
    if(p.operation==='legacyCopy.preview'){reply(message.id,{sessionId:p.sessionId,rootId:p.args.rootId,historyRevision:'fixture-history',previewId:'11111111-1111-4111-8111-111111111111',previewHash:'a'.repeat(64),canonicalFilesDeleted:0,legacyWriterCoverage:'launcher-attested-retired',files:[{name:'transcript.jsonl',bytes:123,sha256:'b'.repeat(64)}],retained:[{name:'events.jsonl',reason:'event-log-preserved'}]});continue;}
    const prior=rows[p.args.commandId];if(prior){reply(message.id,{...prior.result,receipt:prior});continue;}
    if(p.operation==='legacyCopy.purge'){
      appendFileSync(process.env.FIXTURE_LOG+'.purges',p.args.commandId+'\n');
      const result={sessionId:p.sessionId,historyCwd:p.cwd,historyRevision:p.args.expectedHistoryRevision,rootId:'old-app',previewId:p.args.previewId,previewHash:p.args.previewHash,removed:[{name:'transcript.jsonl',bytes:123,sha256:'b'.repeat(64)}],canonicalFilesDeleted:process.env.FIXTURE_PURGE_UNSAFE?1:0,eventsDeleted:0,legacyWriterCoverage:'launcher-attested-retired'};
      const receipt={commandId:p.args.commandId,operation:p.operation,status:p.args.commandId.startsWith('unknown-')?'unknown':'completed',result};rows[p.args.commandId]=receipt;writeFileSync(file,JSON.stringify(rows));
      if(p.args.commandId.startsWith('lost-')||p.args.commandId.startsWith('unknown-')){process.exit(17);continue;}reply(message.id,{...result,receipt});continue;
    }
    if(p.operation==='retention.hide'){
      const result={sessionId:p.sessionId,historyCwd:p.cwd,deleted:true,historyRevision:p.args.expectedHistoryRevision,preserved:['transcript','events'],retention:{modifiedBefore:p.args.modifiedBefore,canonicalFilesDeleted:0},familyGuard:{ownersHeld:true}};const receipt={commandId:p.args.commandId,operation:p.operation,status:'completed',result};rows[p.args.commandId]=receipt;writeFileSync(file,JSON.stringify(rows));reply(message.id,{...result,receipt});continue;
    }
    if(p.operation==='fork'){
      const result={sessionId:p.args.targetSessionId,creationConfirmed:true,historyCwd:p.cwd,executionDirectory:p.cwd,historyRevision:'fixture-history',source:{sessionId:p.sessionId,historyRevision:p.args.expectedHistoryRevision},workReplayed:false,mode:p.args.mode??'complete',bundleSelection:p.args.bundle,preservedSource:true,familyGuard:{ownersHeld:true,count:p.args.descendants?.length??0}};const receipt={commandId:p.args.commandId,operation:'fork',status:'completed',result};rows[p.args.commandId]=receipt;writeFileSync(file,JSON.stringify(rows));
      if(p.args.commandId.startsWith('lost-')){process.exit(17);continue;}reply(message.id,{...result,receipt});continue;
    }
    send({id:message.id,error:{code:-32601,message:'Unsupported fixture lifecycle operation'}});
  }
  else if(message.method==='_amplifier/retire/status'){
    appendFileSync(process.env.FIXTURE_LOG+'.retirement-status',JSON.stringify(p)+'\n');
    if(process.env.FIXTURE_RETIRE_STATUS_LOST)continue;
    const value=process.env.FIXTURE_RETIRE_STATUS_FILE?JSON.parse(readFileSync(process.env.FIXTURE_RETIRE_STATUS_FILE,'utf8')):JSON.parse(process.env.FIXTURE_RETIRE_STATUS??'{"retired":false}');
    reply(message.id,{sessionId:p.sessionId,...value});
  }
  else if(message.method==='_amplifier/retire'){
    if(process.env.FIXTURE_RETIRE_CALLBACK){const id=permissionId++;pending.set(id,result=>appendFileSync(process.env.FIXTURE_LOG+'.late-write',JSON.stringify(result)+'\n'));send({id,method:'fs/write_text_file',params:{sessionId:p.sessionId,path:process.cwd()+'/blocked-native-write',content:'must not write'}});}
    if(process.env.FIXTURE_RETIRE_LOST){retired=true;appendFileSync(process.env.FIXTURE_LOG+'.retired','retired without acknowledgement\n');continue;}
    if(process.env.FIXTURE_LOG)appendFileSync(process.env.FIXTURE_LOG+'.retirement-requests','retire\n');
    if(process.env.FIXTURE_RETIRE_DELAY){retired=true;setTimeout(()=>reply(message.id,{retired:false,reason:'retirement_unknown'}),Number(process.env.FIXTURE_RETIRE_DELAY));continue;}
    if(process.env.FIXTURE_RETIRE_RESPONSE){const result=JSON.parse(process.env.FIXTURE_RETIRE_RESPONSE);if(result.retired!==false||!['owned_work','active_request'].includes(result.reason))retired=true;reply(message.id,result);continue;}
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
  else if(message.method==='_amplifier/native'&&p.operation==='fixture.history.persisted'){
    send({method:'_amplifier/event',params:{sessionId:p.sessionId,event:{type:'history.persisted',metadataPath:p.args.metadataPath}}});reply(message.id,{});
  }
  else if(message.method==='_amplifier/native'&&p.operation==='fixture.worker.idle'){
    send({method:'_amplifier/event',params:{sessionId:p.sessionId,event:{type:'runtime.closed'}}});reply(message.id,{});
  }
  else if(message.method==='_amplifier/native'&&p.operation==='fixture.runtime.loss'){
    send({method:'_amplifier/event',params:{sessionId:p.sessionId,event:{type:'runtime.closed'}}});reply(message.id,{});setTimeout(()=>process.exit(17),20);
  }
  else if(message.method==='_amplifier/workers'){
    if(process.env.FIXTURE_LOG)appendFileSync(process.env.FIXTURE_LOG+'.passive','workers\n');
    reply(message.id,p.commandId?{receipt:null}:{available:false,items:[],nextCursor:null,revision:0,source:'native-worker-index',resident:sessions.has(p.sessionId)&&!retired});
  }
  else if(message.method==='_amplifier/task/inspect'){if(process.env.FIXTURE_LOG)appendFileSync(process.env.FIXTURE_LOG+'.passive','task\n');reply(message.id,{available:true,revision:'task-revision',task:{id:'task-1',revision:7,objective:'Bounded persisted task'},source:'persisted-native-controls'});}
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
  else if(message.method==='_amplifier/native'&&p.operation==='steer.submit'){
    if(process.env.FIXTURE_LOG)appendFileSync(process.env.FIXTURE_LOG+'.steering',JSON.stringify(p.args)+'\n');
    if(!active||active.inputId!==p.args.activeInputId){reply(message.id,{accepted:false,executed:false,reason:'No matching active input'});continue;}
    const result={accepted:true,inputId:p.args.inputId,activeInputId:p.args.activeInputId,generationId:active.generationId,disposition:'queued'};
    if(p.args.text==='crash steering'){process.exit(17);continue;}
    if(p.args.text==='refuse steering'){reply(message.id,{accepted:false,executed:false,reason:'Loop mode unavailable'});continue;}
    if(p.args.text==='no acknowledgement')continue;
    if(p.args.text==='silent steering'){reply(message.id,result);continue;}
    if(p.args.text==='after-turn steering'){active.afterTurn={method:'_amplifier/event',params:{sessionId:p.sessionId,event:{type:'steering.held',input_id:p.args.inputId,activeInputId:p.args.activeInputId,target_generation_id:active.generationId,reason:'after turn checkpoint'}}};reply(message.id,result);continue;}
    const disposition=p.args.text==='held steering'?'held':'applied';
    send({method:'_amplifier/event',params:{sessionId:p.sessionId,event:{type:'steering.'+disposition,input_id:p.args.inputId,activeInputId:p.args.activeInputId,target_generation_id:active.generationId,reason:'independent fixture'}}});
    reply(message.id,result);
  }
  else if(message.method==='_amplifier/native'&&p.operation==='configuration.snapshot')reply(message.id,{version:1,sourceSessionId:p.sessionId,sourceCwd:process.cwd(),configurationHash:'fixture-native-config'});
  else if(message.method==='_amplifier/session/new'){if(process.env.FIXTURE_LOG)appendFileSync(process.env.FIXTURE_LOG,JSON.stringify({creation:p})+'\n');if(process.env.FIXTURE_CLONE_CRASH)process.exit(17);sessions.set(p.sessionId,{});reply(message.id,{sessionId:p.sessionId,configOptions:[],_meta:{'amplifier.dev/native':{creationConfirmed:true,configurationHash:p.source.configurationHash}}});}
  else if(message.method==='session/new'){const sessionId=process.env.FIXTURE_STARTUP_NATIVE_ID??'native-'+Math.random().toString(36).slice(2);sessions.set(sessionId,{});if(process.env.FIXTURE_STARTUP_HINT)send({method:'_amplifier/event',params:{sessionId,event:{type:'history.persisted',metadataPath:process.env.FIXTURE_STARTUP_HINT}}});reply(message.id,{sessionId,...(process.env.FIXTURE_LEGACY?{modes:{currentModeId:'safe',availableModes:[{id:'safe',name:'Safe'},{id:'fast',name:'Fast'}]}}:{configOptions:[{id:'mode',name:'Mode',type:'select',currentValue:'safe',options:[{value:'safe',name:'Safe'},{value:'fast',name:'Fast'}]}]})});
    if(process.env.FIXTURE_LEGACY)setTimeout(()=>{update(sessionId,{sessionUpdate:'available_commands_update',availableCommands:[{name:'inspect',description:'Inspect local context',input:{hint:'path'}}]});update(sessionId,{sessionUpdate:'usage_update',used:123,size:4096,cost:{amount:0.12,currency:'USD'}});update(sessionId,{sessionUpdate:'session_info_update',title:'Idle peer title',updatedAt:'2026-10-02T00:00:00Z'});update(sessionId,{sessionUpdate:'current_mode_update',currentModeId:'fast'});},30);
  }
  else if(message.method==='session/resume'||message.method==='session/load'){sessions.set(p.sessionId,{});if(process.env.FIXTURE_LOCATIONS)appendFileSync(process.env.FIXTURE_LOG,JSON.stringify({resumed:p,processCwd:process.cwd()})+'\n');reply(message.id,{configOptions:[]});}
  else if(message.method==='session/set_mode'){if(process.env.FIXTURE_LOG)appendFileSync(process.env.FIXTURE_LOG,JSON.stringify({modeChange:p})+'\n');update(p.sessionId,{sessionUpdate:'current_mode_update',currentModeId:p.modeId});reply(message.id,{});}
  else if(message.method==='session/set_config_option')reply(message.id,{configOptions:[{id:'mode',name:'Mode',type:'select',currentValue:p.value,options:[{value:'safe',name:'Safe'},{value:'fast',name:'Fast'}]}]});
  else if(message.method==='session/close')reply(message.id,{});
  else if(message.method==='session/prompt'||message.method==='_amplifier/native'&&['schedule.submit','question.submit','observation.submit'].includes(p.operation)){
    if(p.operation==='observation.submit'&&process.env.FIXTURE_WORKER_UNAVAILABLE_FILE&&existsSync(process.env.FIXTURE_WORKER_UNAVAILABLE_FILE)){if(p._meta?.['amplifier.dev/native']?.requireExisting!==true)throw new Error('Resident observation guard missing');send({id:message.id,error:{code:-32008,message:'waiting_worker',data:{executed:false,replayed:false}}});continue;}
    if(retired){send({id:message.id,error:{code:-32000,message:'Session handle retired'}});continue;}
    const scheduled=message.method==='_amplifier/native';
    if(scheduled&&(p.args.taskRevision===99||p.args.questionRevision===99)){reply(message.id,{accepted:false,reason:'Saved task changed'});continue;}
    if(process.env.FIXTURE_LOG)appendFileSync(process.env.FIXTURE_LOG,JSON.stringify({...p,...(process.env.FIXTURE_LOCATIONS?{processCwd:process.cwd()}: {})})+'\n');
    const text=scheduled?(p.args.text??JSON.stringify(p.args.outcome)):p.prompt.filter(b=>b.type==='text').map(b=>b.text).join(' '),id=message.id;
    active={id,sessionId:p.sessionId,cancelled:false,inputId:scheduled?p.args.inputId:p._meta?.['amplifier.dev/command']?.commandId,generationId:'generation-'+id};
    const started={method:'_amplifier/event',params:{sessionId:p.sessionId,event:{type:'generation.started',generation_id:active.generationId,activeInputId:active.inputId}}};
    if(text==='steer-start-late')setTimeout(()=>send(started),100);else send(started);
    void(async()=>{
      const turn=active;
      if(text==='crash'){process.exit(17);return;}
      if(text==='terminal-failure'){const proof={version:1,sessionId:p.sessionId,inputId:turn.inputId,status:'failed',terminal:true,noReplay:true,inputPersisted:true,effectBoundary:'provider-request',error:{type:'InvalidRequestError',message:'The provider could not accept the request format.'},...JSON.parse(process.env.FIXTURE_INPUT_PROOF??'{}')};send({id,error:{code:-32000,message:'Recorded native failure',data:{'amplifier.dev/inputOutcome':proof}}});active=undefined;return;}
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
      if(text==='slow'||text==='queue-hold'||text==='steer-start-late')await new Promise(resolve=>setTimeout(resolve,text==='slow'?180:1000));
      if(text==='client-tool'){
        const requestId=permissionId++;
        const outcome=await new Promise(resolve=>{pending.set(requestId,resolve);send({id:requestId,method:'_amplifier/host',params:{sessionId:p.sessionId,operation:'ui.inspect',args:{}}});});
        update(p.sessionId,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(outcome)}});
      }
      if(text==='terminal'||text==='terminal-background'||text==='terminal-delayed'||text==='terminal-released'){
        const call=method=>async params=>{const requestId=permissionId++;return new Promise(resolve=>{pending.set(requestId,resolve);send({id:requestId,method,params:{sessionId:p.sessionId,...params}});});};
        const delayed=text==='terminal-delayed'||text==='terminal-released';
        const terminal=await call('terminal/create')({command:process.execPath,args:delayed?[new URL('./terminal-close.mjs',import.meta.url).pathname,process.env.FIXTURE_LOG]:['-e',text==='terminal-background'?'setInterval(()=>process.stdout.write("owned terminal work\\n"),10)':'process.stdout.write("terminal proof")']});
        if(delayed){while(!existsSync(process.env.FIXTURE_LOG+'.terminal-ready'))await new Promise(resolve=>setTimeout(resolve,5));}
        if(text==='terminal-released')await call('terminal/release')({terminalId:terminal.terminalId});
        if(text==='terminal')await call('terminal/wait_for_exit')({terminalId:terminal.terminalId});
        update(p.sessionId,{sessionUpdate:'tool_call',toolCallId:'terminal-tool',title:'Run process',kind:'execute',status:'completed',content:[{type:'terminal',terminalId:terminal.terminalId}]});
      }
      if(text==='many')for(let i=0;i<100;i++)update(p.sessionId,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'x'}});
      else update(p.sessionId,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Echo: '+text}});
      reply(id,{...(text==='mapping'?{usage:{totalTokens:31,inputTokens:20,outputTokens:11,cachedReadTokens:4,cachedWriteTokens:2,thoughtTokens:3}}:{}),...(scheduled?{accepted:true,inputId:p.args.inputId}:{}),stopReason:turn.cancelled?'cancelled':'end_turn'});
      if(turn.afterTurn)setTimeout(()=>send(turn.afterTurn),100);
    })();
  } else if(message.method==='session/cancel'){if(active)active.cancelled=true;}
  else if(message.id!==undefined)send({id:message.id,error:{code:-32601,message:'Unsupported'}});
}
