import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {AhpClient} from '@microsoft/agent-host-protocol/client';
import {WebSocketTransport} from '@microsoft/agent-host-protocol/ws';

const python=process.env.HISTORY_NATIVE_PYTHON,source=process.env.HISTORY_NATIVE_SOURCE;
test('actual passive Native ACP history keeps steering between tool and answer through official AHP state',{skip:!python||!source},async()=>{
  const {createHost}=await import(process.env.HISTORY_HOST_MODULE??'../src/host.js');
  const dir=await realpath(await mkdtemp(join(tmpdir(),'host-native-steering-'))),workspace=join(dir,'workspace'),home=join(dir,'native-home');await mkdir(workspace);
  const original='fae0e058-e6ef-4f41-9717-a9c3dd2cd95e',steer='bd01da78-5019-4c83-b2fc-020fc6bb98de',queue='b6f95283-92e4-4a7f-b424-44353fbcd66d',native='612cd35e-81ab-4877-9ba4-2559b6226295';
  const slug=execFileSync(python!,['-I','-B','-c','import sys;sys.path.insert(0,sys.argv[1]);from amplifier_acp.native.session_files import project_slug;print(project_slug(sys.argv[2]))',source!,workspace],{encoding:'utf8'}).trim();
  const sessionDir=join(home,'projects',slug,'sessions',native);await mkdir(sessionDir,{recursive:true});
  const user=(id:string,text:string,extra:any={})=>({role:'user',content:text,metadata:{amplifier_input:{version:1,kind:id===steer?'steer':'user',id,source:'user'},amplifier_public_message:{version:1,inputId:id,capture:'host-standard',blocks:[{type:'text',text}]},...extra}});
  const rows=[user(original,'Run checkpoint then welcome',{_seq:1}),{role:'assistant',content:'I will run the checkpoint',tool_calls:[{id:'checkpoint',function:{name:'shell',arguments:'{}'}}]},{role:'tool',tool_call_id:'checkpoint',content:'checkpoint done'},user(steer,'One short sentence; mention a document',{inputOrigin:'steering',activeInputId:original,_seq:4}),{role:'assistant',content:'Welcome; bring a document.'},user(queue,'Suggest four-word title',{_seq:6}),{role:'assistant',content:'Amplifier Unified Welcome Checkpoint'}];
  const bytes=rows.map(row=>JSON.stringify(row)+'\n').join(''),transcript=join(sessionDir,'transcript.jsonl');await writeFile(transcript,bytes);
  const config=join(dir,'config.json');await writeFile(config,JSON.stringify({home,appHome:join(dir,'app'),workerCommand:['/must-not-start-for-passive-history']}));
  const uri='ahp-session:/steering-history',chat='ahp-chat:/steering-history',stamp='2026-10-04T00:00:00.000Z',record={uri,engineId:'native',nativeSessionId:native,workingDirectory:workspace,title:'Owned history',createdAt:stamp,modifiedAt:stamp};
  const bootstrap=`import sys,runpy;sys.path.insert(0,${JSON.stringify(source)});runpy.run_module('amplifier_acp',run_name='__main__')`;
  const host=await createHost({stateDirectory:join(dir,'host'),allowedWorkspaceRoots:[dir],engines:[{id:'native',label:'Native',command:python!,args:['-I','-B','-c',bootstrap,'--config',config]}],catalog:{list:async()=>({items:[record]}),get:async(id:string)=>id===uri?record:undefined,upsert:async()=>{}}});
  const client=new AhpClient(await WebSocketTransport.connect(host.url));client.connect();await client.initialize({clientId:'steering-history',protocolVersions:['0.9.0']});
  try{
    await client.request('listSessions',{channel:'ahp-root://',limit:10});
    const response=await client.subscribe(chat,{view:{turns:2}}),state=response.result.snapshot.state as any;
    assert.deepEqual(state.turns.map((turn:any)=>turn.id),[original,queue]);
    const turn=state.turns[0];assert.equal(turn.message.text,'Run checkpoint then welcome');
    assert.deepEqual(turn.responseParts.map((part:any)=>part.kind),['markdown','toolCall','systemNotification','markdown','error']);
    const history=turn.responseParts[2]._meta['amplifier.dev/history'];assert.equal(history.nativeInput.id,steer);assert.equal(history.activeInputId,original);assert.equal(history.rowLocator.messageId,history.messageId);
    const position=rows.slice(0,3).reduce((total,row)=>total+Buffer.byteLength(JSON.stringify(row)+'\n'),0);assert.equal(history.rowLocator.position,position);
    assert.equal(turn.responseParts[2].content,'Steering input: One short sentence; mention a document');assert.equal(history.message.origin.kind,'user');
    assert.equal(turn.responseParts[1].toolCall.toolCallId,'checkpoint');assert.equal(turn.responseParts[1].toolCall.status,'completed');assert.equal(turn.responseParts[3].content,'Welcome; bring a document.');assert.equal(turn.responseParts.at(-1).error.errorType,'NATIVE_OUTCOME_UNKNOWN');
    assert.equal(state.turns[1].message.text,'Suggest four-word title');assert.equal(host.diagnostics().activeAgents,0);assert.equal(await readFile(transcript,'utf8'),bytes);
    console.log(JSON.stringify({nativeSessionId:native,turnIds:state.turns.map((t:any)=>t.id),steeringMessageId:history.messageId,steeringRowLocator:history.rowLocator,activeAgents:host.diagnostics().activeAgents,canonicalBytesUnchanged:true}));
  }finally{await client.shutdown();await host.close();await rm(dir,{recursive:true,force:true});}
});
