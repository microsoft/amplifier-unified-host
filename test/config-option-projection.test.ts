import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {AhpClient} from '@microsoft/agent-host-protocol/client';
import {WebSocketTransport} from '@microsoft/agent-host-protocol/ws';
import {createHost} from '../src/host.js';

const grouped=[{id:'model',name:'Model',type:'select',category:'model',currentValue:'opaque:first',_meta:{'fixture.example/select':{grouped:true},type:'not-a-schema-type',enum:['not-authority']},options:[
  {group:'instance-A',name:'Same provider label',_meta:{'fixture.example/provider':{instance:'instance-A',fresh:false}},options:[{value:'opaque:first',name:'Same model label',_meta:{'fixture.example/model':{contextWindow:8192,capabilities:['thinking']}}}]},
  {group:'instance-B',name:'Same provider label',_meta:{'fixture.example/provider':{instance:'instance-B',fresh:true}},options:[{value:'opaque:second',name:'Same model label',_meta:{'fixture.example/model':{contextWindow:16384,reasoning:['brief','deep']}}}]}
]},{id:'effort',name:'Reasoning',type:'select',category:'thought_level',currentValue:'opaque:deep',_meta:{'fixture.example/effective':'opaque:first'},options:[{value:'opaque:deep',name:'Deep',_meta:{'fixture.example/effort':'deep'}}]}];
const flat=[{id:'mode',name:'Mode',description:'Plain external ACP selector',type:'select',currentValue:'safe',options:[{value:'safe',name:'Safe'},{value:'fast',name:'Fast'}]}];
async function waitFor(predicate:()=>unknown) {const until=Date.now()+5000;while(Date.now()<until){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Fixture timeout');}
async function fixture(options:any[]) {
  const directory=await mkdtemp(join(tmpdir(),'host-config-projection-')),data=join(directory,'options.json');await writeFile(data,JSON.stringify(options));
  const host=await createHost({stateDirectory:join(directory,'state'),allowedWorkspaceRoots:[directory],engines:[{id:'external',label:'External ACP',command:process.execPath,args:[fileURLToPath(new URL('./fixtures/config-options-peer.mjs',import.meta.url)),data]}]});
  const client=new AhpClient(await WebSocketTransport.connect(host.url));client.connect();await client.initialize({clientId:'configuration-reader',protocolVersions:['0.9.0'],initialSubscriptions:['ahp-root://']});
  const session='ahp-session:/config-projection';await client.request('createSession',{channel:session,provider:'external',workingDirectories:[pathToFileURL(directory).href]});await client.subscribe(session);
  return {host,client,session,property:(id:string)=>(host.store.get(session)!.state.config!.schema as any).properties[id],async close(){await client.shutdown();await host.close();await rm(directory,{recursive:true,force:true});}};
}
test('standard ACP grouped choices retain identities, metadata and category beside generic enums',async()=>{
  const f=await fixture(grouped);try {
    const model=f.property('model');assert.deepEqual(model.enum,['opaque:first','opaque:second']);assert.deepEqual(model.enumLabels,['Same model label','Same model label']);assert.equal(model.type,'string');assert.equal(model.sessionMutable,true);
    assert.deepEqual(model.options,grouped[0].options);assert.deepEqual(model._meta,grouped[0]._meta);assert.equal(model.category,'model');
    assert.equal(model.options[0].group,'instance-A');assert.equal(model.options[1].group,'instance-B');assert.equal(model._meta.type,'not-a-schema-type');assert.deepEqual(model._meta.enum,['not-authority']);
    assert.equal(f.property('effort').category,'thought_level');assert.deepEqual(f.property('effort').options,grouped[1].options);
    const snapshot=(await f.client.subscribe(f.session)).result.snapshot!.state as any;assert.deepEqual(snapshot.config.schema.properties.model,model);
  }finally{await f.close();}
});
test('standard replacement options remove obsolete fields and preserve reordered group metadata',async()=>{
  const f=await fixture(grouped);try {
    f.client.dispatch(f.session,{type:'session/configChanged',config:{model:'opaque:second'}} as any);
    await waitFor(()=>f.host.store.get(f.session)?.state.config?.values?.model==='opaque:second'&&!f.property('effort'));
    const model=f.property('model');assert.deepEqual(model.enum,['opaque:second','opaque:first']);assert.equal(model.options[0].group,'instance-B');assert.equal(model.options[0]._meta['fixture.example/fresh'],true);assert.equal(model.options[1].options[0].value,'opaque:first');
    assert.equal(f.host.store.get(f.session)!.state.config!.values.effort,undefined);
    const raw=(f.host.store.get(f.session)!.state._meta!['amplifier.dev/acp'] as any).configOptions;assert.deepEqual(model.options,raw[0].options);
  }finally{await f.close();}
});
test('plain foreign ACP selectors retain existing generic enum behavior without metadata requirements',async()=>{
  const f=await fixture(flat);try {
    assert.deepEqual(f.property('mode').enum,['safe','fast']);assert.deepEqual(f.property('mode').enumLabels,['Safe','Fast']);assert.deepEqual(f.property('mode').options,flat[0].options);assert.equal(f.property('mode').category,undefined);assert.equal(f.property('mode')._meta,undefined);
    f.client.dispatch(f.session,{type:'session/configChanged',config:{mode:'fast'}} as any);await waitFor(()=>f.host.store.get(f.session)?.state.config?.values?.mode==='fast');assert.equal(f.property('mode').type,'string');
  }finally{await f.close();}
});
