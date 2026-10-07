import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {AhpClient} from '@microsoft/agent-host-protocol/client';
import {WebSocketTransport} from '@microsoft/agent-host-protocol/ws';
import {createHost} from '../src/host.js';

for(const mode of ['complete','cancel','reject','foreign','slow-listener'])test('wire completion admits preceding native evidence: '+mode,{timeout:10000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'terminal-burst-'));
 const settled:any[]=[],events:any[]=[];let release!:()=>void;const deferred=new Promise<void>(resolve=>{release=resolve;});
 const host=await createHost({stateDirectory:join(root,'state'),allowedWorkspaceRoots:[root],engines:[{id:'fixture',command:process.execPath,args:[resolve('fixtures/terminal-burst-acp.mjs')]}],turnSettled:event=>{settled.push(event);},nativeEvent:async(_binding,params)=>{events.push(params.event);if(mode==='slow-listener'&&(params.event as any).type==='generation.finished')await deferred;}});
 const client=new AhpClient(await WebSocketTransport.connect(host.url));client.connect();await client.initialize({clientId:'test',protocolVersions:['0.9.0']});
 try{
  const session='ahp-session:/11111111-1111-4111-8111-111111111111';
  await client.request('createSession',{channel:session,provider:'fixture',workingDirectories:[pathToFileURL(root).href]});
  for(let index=0;index<(mode==='complete'?2:1);index++){
   const id='peer:burst-'+index;
   await host.submitTurn(session,{commandId:id,text:mode,clientId:'test',origin:'ui'});
   const result=await host.waitForTurn(session,id,5000);
   for(let i=0;i<100&&host.diagnostics().turnSettledPending;i++)await new Promise(resolve=>setTimeout(resolve,5));
   assert.equal(result.status,mode==='cancel'?'cancelled':['reject','foreign'].includes(mode)?'unknown':'completed');
   assert.equal(settled.length,index+1);
   const proofs=settled[index].peerTerminals??[];
   if(['complete','slow-listener'].includes(mode)){
    assert.equal(result.text,'Saved burst answer');
    assert.equal(proofs.length,1,JSON.stringify({result,settled,receipt:host.store.receipt(id)}));
    assert.equal(proofs[0].messageId,'native:burst-answer-'+id);
   }else assert.equal(proofs.length,0);
   if(mode==='foreign')assert.ok(host.store.receipt(id)?.status==='unknown');
   else assert.ok(events.some(event=>event.type==='generation.finished'&&event.input_ids.includes(id)));
  }
 }finally{release();await client.shutdown();await host.close();await rm(root,{recursive:true,force:true});}
});
