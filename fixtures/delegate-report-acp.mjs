// Independent wire peer: no model or external services.
import readline from 'node:readline';
import {appendFileSync,readFileSync} from 'node:fs';
const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
for await(const line of readline.createInterface({input:process.stdin})){
 const m=JSON.parse(line),p=m.params||{};
 if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true,_meta:{'amplifier.dev/native':{version:1,sessionLifecycle:{version:1,passive:true,deletion:'preserve-history'},history:{version:1,paging:'complete-turns',passive:true,passiveInspect:true}}}},authMethods:[]}});
 else if(m.method==='_amplifier/session'&&p.operation==='inspect')send({id:m.id,result:{sessionId:p.sessionId,historyRevision:'fixture-revision',metadata:{},location:{historyCwd:p.cwd,executionDirectory:p.cwd,executionRevision:0,blocked:false},state:{deleted:false},preserved:['transcript','events']}});
 else if(m.method==='_amplifier/history/inspect')send({id:m.id,result:{available:true,revision:'fixture-revision',diagnostics:[]}});
 else if(m.method==='_amplifier/history')send({id:m.id,result:{turnGroups:JSON.parse(readFileSync(process.env.FIXTURE_LOG+'.history','utf8')),revision:'fixture-revision',diagnostics:[],nextCursor:null}});
 else if(['session/new','session/load'].includes(m.method))send({id:m.id,result:{sessionId:p.sessionId||'report-root'}});
 else if(m.method==='session/prompt'){
  appendFileSync(process.env.FIXTURE_LOG,'prompt\n');
  const input=p._meta?.['amplifier.dev/command']?.commandId;
  const observation=(revision,summary,activeInputId=input)=>send({method:'_amplifier/event',params:{sessionId:p.sessionId,event:{type:'execution.event',activeInputId,event:{id:'worker:review',kind:'worker',sessionId:'review',label:'Reviewer',phase:revision===1?'running':'completed',revision,startedAt:10,...(revision>1?{endedAt:12}:{}),summary,ignoredAuthority:'not-a-grant'}}}});
  observation(1,'');
  send({method:'session/update',params:{sessionId:p.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Review finished.'}}}});
  observation(2,'**Saved report.**\n\n'+'Evidence line.\n'.repeat(600)+'END-OF-REPORT');
  observation(3,'FOREIGN-INPUT-REPORT','different-input');
  send({id:m.id,result:{stopReason:'end_turn'}});
 }else if(m.id!==undefined)send({id:m.id,result:{}});
}
