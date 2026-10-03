import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHost,AmplifierHost} from '../src/host.js';
import {AhpClient} from '@microsoft/agent-host-protocol/client';
import {WebSocketTransport} from '@microsoft/agent-host-protocol/ws';

test('configured default is canonical child workspace while authorization retains broader roots',async()=>{
 const temp=await mkdtemp(join(tmpdir(),'ahp-default-workspace-')),workspace=join(temp,'workspace');await mkdir(workspace);
 const config={stateDirectory:join(temp,'host'),allowedWorkspaceRoots:[temp],defaultWorkingDirectory:workspace,engines:[{id:'unused',command:'/must-not-start'}]};
 const host=await createHost(config),client=new AhpClient(await WebSocketTransport.connect(host.url));client.connect();
 try{
  const initialized=await client.initialize({clientId:'default-test',protocolVersions:['0.9.0'],initialSubscriptions:['ahp-root://']});
  assert.equal(initialized.defaultDirectory,pathToFileURL(await realpath(workspace)).href);
  assert.equal((initialized.snapshots![0].state as any)._meta['amplifier.dev/host'].defaultDirectory,initialized.defaultDirectory);
  assert.equal(host.diagnostics().activeAgents,0);
 }finally{await client.shutdown();await host.close();}
 const bad=new AmplifierHost({...config,stateDirectory:join(temp,'invalid'),allowedWorkspaceRoots:[workspace],defaultWorkingDirectory:temp});
 try{await assert.rejects(bad.listen(),/outside allowed/);}finally{await bad.close();}
 const fallback=await createHost({...config,stateDirectory:join(temp,'fallback'),defaultWorkingDirectory:undefined}),other=new AhpClient(await WebSocketTransport.connect(fallback.url));other.connect();
 try{assert.equal((await other.initialize({clientId:'fallback',protocolVersions:['0.9.0']})).defaultDirectory,pathToFileURL(await realpath(temp)).href);}finally{await other.shutdown();await fallback.close();await rm(temp,{recursive:true,force:true});}
});
