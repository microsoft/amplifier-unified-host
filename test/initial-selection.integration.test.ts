import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,readFile,rm,realpath,readdir} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {execFileSync} from 'node:child_process';import {pathToFileURL} from 'node:url';import {randomUUID} from 'node:crypto';import {AhpClient} from '@microsoft/agent-host-protocol/client';import {WebSocketTransport} from '@microsoft/agent-host-protocol/ws';
const python=process.env.INITIAL_SELECTION_PYTHON,source=process.env.NATIVE_ADMISSION_SOURCE,tests=process.env.NATIVE_ADMISSION_TESTS;
for(const scenario of ['bundle','workspace','saved-app'])test(`actual Native standard AHP creation applies selected model and effort before first prompt (${scenario})`,{skip:!python||!source||!tests,timeout:90000},async()=>{
 const {createHost}=await import(process.env.INITIAL_SELECTION_HOST_MODULE??'../src/host.js');
 const dir=await realpath(await mkdtemp(join(tmpdir(),'native-host-initial-selection-'))),env={NATIVE_ADMISSION_SOURCE:source!,NATIVE_ADMISSION_TESTS:tests!};
 const setup=JSON.parse(execFileSync(python!,['-c',`import json,sys,yaml
from pathlib import Path
from test_initial_selection import setup
root=Path(sys.argv[1]);scenario=sys.argv[2];config,cwd,audit,discovery,_=setup(root)
values=json.loads(config.read_text());bundle=Path(values['bundle']);doc=yaml.safe_load(bundle.read_text())
if scenario=='workspace':
 source=doc['providers'][0]['source'];doc['bundle']['version']='1.0.0';doc['providers']=[];bundle.write_text(yaml.safe_dump(doc))
 def settings(label):return {'bundle':{'app':[]},'config':{'providers':[{'module':'provider-fixture','source':source,'instance_id':label,'config':{'fixtureLabel':label,'fixtureDefaultModel':label+'-model','fixtureModels':[{'id':label+'-model','defaults':{'supported_reasoning_efforts':['low']}}],'modelDiscoveryAudit':str(discovery),'requestSelectionAudit':str(audit)}}]}}
 (root/'home/settings.yaml').write_text(yaml.safe_dump(settings('global')));local=cwd/'.amplifier';local.mkdir();(local/'settings.local.yaml').write_text(yaml.safe_dump(settings('workspace')))
if scenario=='saved-app':
 saved=root/'app-selected.yaml';saved.write_bytes(bundle.read_bytes());doc['providers']=doc['providers'][:1];bundle.write_text(yaml.safe_dump(doc));app=root/'app';app.mkdir();(app/'admin-settings.yaml').write_text(yaml.safe_dump({'bundle':{'active':str(saved)}}))
print(json.dumps({'config':str(config),'cwd':str(cwd),'audit':str(audit)}))`,dir,scenario],{env:{...process.env,...env},encoding:'utf8'}));
 const host=await createHost({stateDirectory:join(dir,'host'),allowedWorkspaceRoots:[dir],engines:[{id:'native',label:'Native',command:python!,args:['-I','-B','-m','amplifier_acp','--config',setup.config],env}]});const client=new AhpClient(await WebSocketTransport.connect(host.url));client.connect();await client.initialize({clientId:'initial-selection-real',protocolVersions:['0.9.0']});
 const selected=scenario==='workspace'?{instance:'workspace',model:'workspace-model',effort:'low'}:{instance:'work',model:'work-new',effort:'low'},workingDirectories=[pathToFileURL(setup.cwd).href];let web:any,storage:any;
 try{
  const resolved:any=await client.request('resolveSessionConfig',{channel:'ahp-root://',provider:'native',workingDirectory:workingDirectories[0],config:selected});assert.deepEqual(resolved.values,selected);assert.deepEqual(resolved.schema.properties.effort.enum,scenario==='workspace'?['low']:['low','high']);assert.equal(host.diagnostics().activeAgents,0);if(scenario==='workspace'){assert.deepEqual(resolved.schema.properties.instance.enum,['workspace']);assert.deepEqual(resolved.schema.properties.model.enum,['workspace-model']);}await assert.rejects(readFile(setup.audit));
  for(const config of [{...selected,instance:scenario==='workspace'?'global':'absent'},{...selected,model:'absent'},{...selected,effort:'thorough'},{...selected,model:scenario==='workspace'?'global-model':'work-default'}]){const session='ahp-session:/'+randomUUID();await assert.rejects(client.request('createSession',{channel:session,provider:'native',workingDirectories,config}));assert.equal(host.store.get(session),undefined);assert.equal(host.store.receipt('create:'+session),undefined);}
  await assert.rejects(readdir(join(dir,'app/sessions')),(error:any)=>error.code==='ENOENT');await assert.rejects(readFile(setup.audit));
  const creationId=randomUUID(),session='ahp-session:/'+creationId;
  if(process.env.INITIAL_SELECTION_WEB_SOURCE){
    const webRoot=process.env.INITIAL_SELECTION_WEB_SOURCE;
    const {indexedDB}=await import(pathToFileURL(join(webRoot,'node_modules/fake-indexeddb/build/esm/index.js')).href);
    const {LocalStore}=await import(pathToFileURL(join(webRoot,'src/ahp/local-store.js')).href),{AhpWebClient}=await import(pathToFileURL(join(webRoot,'src/ahp/client.js')).href);
    storage=new LocalStore({host:host.url,account:'owned',tab:creationId,indexedDB});web=new AhpWebClient({url:host.url,storage,transportFactory:()=>WebSocketTransport.connect(host.url)});await web.connect();
    const created=await web.action('session.create',{workspace:setup.cwd,provider:'native',selection:selected},creationId);assert.equal(created.accepted,true);assert.equal(created.sessionId,session);
  }else await client.request('createSession',{channel:session,provider:'native',workingDirectories,config:resolved.values});
  const record=host.store.get(session)!;
  const options=(record.state._meta?.['amplifier.dev/acp'] as any).configOptions;const effective=options.find((option:any)=>option.category==='model')._meta['amplifier.dev/native'].effective;assert.deepEqual(effective,selected);
  const controls=JSON.parse(await readFile(join(dir,'app/sessions',record.nativeSessionId!,'control-state.json'),'utf8'));assert.deepEqual(controls.selection,selected);await assert.rejects(readFile(setup.audit));
  if(web)assert.equal((await web.action('conversation.send',{sessionId:session,text:'One explicit offline request'},'first-real-input')).accepted,true);else await host.submitTurn(session,{commandId:'first-real-input',clientId:'initial-selection-real',text:'One explicit offline request'});assert.equal((await host.waitForTurn(session,'first-real-input')).completed,true);
  const audit=(await readFile(setup.audit,'utf8')).trim().split('\n').map(JSON.parse);assert.deepEqual(audit[0],selected);console.log(JSON.stringify({scenario,session,nativeSessionId:record.nativeSessionId,selection:controls.selection,effectiveBeforeFirstPrompt:effective,firstPromptSelection:audit[0],invalidSelectionsRefusedBeforeAllocation:true,webPublicActions:!!web,providerRequestsAfterFirst:audit.slice(1)}));web?.close();storage?.close();
 }finally{web?.close();storage?.close();await client.shutdown();await host.close();await rm(dir,{recursive:true,force:true});}
});
