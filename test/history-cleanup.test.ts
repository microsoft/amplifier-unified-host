import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHost} from '../src/host.js';
import {historyCleanupCensus} from '../src/history-cleanup.js';
const uri='ahp-session:/saved',other='ahp-session:/child';
const index=(items:any[])=>({version:1,coverage:'indexed-metadata-only',transcriptBodiesRead:false,externalWriterCoverage:false,items});
const native=(workspace='/work')=>({version:1,workspace,selection:{project:'saved',nativeSessionId:'original'},revision:'a'.repeat(64),sessions:[{nativeSessionId:'original',cwd:workspace}]});
const row=(workspace='/work')=>({uri,engineId:'native',nativeSessionId:'original',workingDirectory:workspace,title:'Saved original',createdAt:'2026-10-01T00:00:00Z',modifiedAt:'2026-10-01T00:00:00Z'});
test('shared-history metadata join rejects aliases, mapping conflicts and an omitted indexed child',()=>{
 assert.equal(historyCleanupCensus(native(),'native',index([row()]),[]).sessions[0].session,uri);
 assert.equal(historyCleanupCensus(native(),'native',index([]),[]).sessions.length,0);
 assert.throws(()=>historyCleanupCensus(native(),'native',index([{...row(),engineId:'other'}]),[]),/engine alias/);
 assert.throws(()=>historyCleanupCensus(native(),'native',index([row()]),[{...row(),nativeSessionId:'different'}]),/disagree/);
 assert.throws(()=>historyCleanupCensus(native(),'native',index([row(),{...row(),uri:other,nativeSessionId:'other',parentUri:uri}]),[]),/outside the Native family/);
});
test('shared-history reference review uses every live owner and settles only visibility after confirmed Native removal',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'history-cleanup-'))),folder=join(root,'workspace');await mkdir(folder);
 let held=false,protectedWork=true,projectionFailure=false,inspections=0;const rows=new Map([[uri,row(folder)]]);
 const participant={id:'future-work',recoveryReferences:{version:1 as const},async acquire(context:any){held=true;return {ownerId:'future-work',fenceId:context.fenceId,release:async()=>{held=false},inspectRetentionReferences:async(input:any)=>{assert.equal(held,true);assert.deepEqual(input,{sessions:[uri],limit:101});inspections++;return {coverage:'complete',protected:protectedWork?[{session:uri,reasons:['schedule']}]:[],omissions:[]};}};}};
 const catalog={list:async()=>({items:[...rows.values()]}),get:async(id:string)=>rows.get(id),upsert:async()=>{},libraryCapabilities:async()=>({workspaceCleanupCensus:{version:1}}),workspaceCleanupCensus:async()=>index([...rows.values()]),setVisibility:async(input:any)=>{if(projectionFailure)throw Error('projection unavailable');assert.equal(input.deleted,true);return input;}};
 const host=await createHost({stateDirectory:join(root,'host'),allowedWorkspaceRoots:[root],engines:[{id:'native',command:'/must-not-start'}],catalog,quiescence:{instanceId:'instance',dataScope:'scope',requiredOwners:['future-work'],coverage:{},participants:[participant],verifyRelease:async(input:any)=>({verified:true,...input,receiptId:'trusted'})}});
 try{
  const admission:any=await host.admitQuiescence({commandId:'review-history',purpose:'recovery'}),fence={fenceId:admission.fenceId,commandId:'review-history',instanceId:'instance',dataScope:'scope',purpose:'recovery'};
  const input={census:native(folder),engineId:'native',canonicalOwners:[]};let selection:any;
  await host.withQuiescenceMaintenance(fence,async()=>{
   await assert.rejects(host.inspectHistoryCleanup(input,fence),/protect history/);
   protectedWork=false;selection=await host.inspectHistoryCleanup(input,fence);
  });
  assert.equal(inspections,2);assert.deepEqual(selection.references.owners,['future-work']);
  const effect={commandId:'history-projection',selection,nativeReceipt:{commandId:'native-original',operation:'maintenance.history.remove',state:'succeeded',result:{removed:true,workspacePreserved:true,stableLocksPreserved:true,receiptsPreserved:true,replayed:false,confirmationId:'a'.repeat(64),sessionCount:1,selection:input.census.selection,previewHash:'b'.repeat(64)}}};
  projectionFailure=true;await assert.rejects(host.withQuiescenceMaintenance(fence,()=>host.settleHistoryCleanup(effect,fence)),/projection unavailable/);
  assert.equal(host.historyCleanupReceipt(effect.commandId).receipt?.state,'unknown');
  assert.equal(host.inspectQuiescence().fence?.phase,'unknown');
  projectionFailure=false;await host.withQuiescenceSettlement(fence,()=>host.settleHistoryCleanup(effect,fence));
  assert.equal(host.historyCleanupReceipt(effect.commandId).receipt?.state,'succeeded');
  await host.withQuiescenceSettlement(fence,()=>host.settleHistoryCleanup(effect,fence));
  await assert.rejects(host.withQuiescenceSettlement(fence,()=>host.settleHistoryCleanup({...effect,selection:{...selection,nativeRevision:'c'.repeat(64)}},fence)),/exact completed/i);
  assert.equal(host.diagnostics().activeAgents,0);await host.releaseQuiescence({...fence,outcome:'unchanged'});
 }finally{await host.close();await rm(root,{recursive:true,force:true});}
});

test('large project reference review checks every bounded batch and refuses missing or late protection',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'history-batches-'))),folder=join(root,'workspace');await mkdir(folder);
 const rows=Array.from({length:240},(_,i)=>({...row(folder),uri:'ahp-session:/saved-'+i,nativeSessionId:'native-'+i}));
 const census={...native(folder),sessions:rows.map(r=>({nativeSessionId:r.nativeSessionId,cwd:folder}))};
 let protect=false,missing=false;const batches:number[]=[];
 const participant={id:'references',recoveryReferences:{version:1 as const},async acquire(context:any){return {ownerId:'references',fenceId:context.fenceId,release:async()=>{},inspectRetentionReferences:async(input:any)=>{batches.push(input.sessions.length);return {coverage:'complete',protected:protect&&input.sessions.includes(rows[239].uri)?[{session:rows[239].uri}]:[],omissions:missing?['unavailable']:[]}}}}};
 const host=await createHost({stateDirectory:join(root,'host'),allowedWorkspaceRoots:[root],engines:[{id:'native',command:'/must-not-start'}],catalog:{list:async()=>({items:rows}),get:async(id:string)=>rows.find(r=>r.uri===id),upsert:async()=>{},libraryCapabilities:async()=>({workspaceCleanupCensus:{version:1}}),workspaceCleanupCensus:async()=>index(rows),setVisibility:async()=>({})},quiescence:{instanceId:'i',dataScope:'d',requiredOwners:['references'],coverage:{},participants:[participant],verifyRelease:async(input:any)=>({verified:true,...input,receiptId:'trusted'})}});
 try{
  const admission:any=await host.admitQuiescence({commandId:'review',purpose:'recovery'}),fence={fenceId:admission.fenceId,commandId:'review',instanceId:'i',dataScope:'d',purpose:'recovery'};
  await host.withQuiescenceMaintenance(fence,async()=>{
   const input={census,engineId:'native',canonicalOwners:[]};
   const result=await host.inspectHistoryCleanup(input,fence);assert.equal(result.sessions.length,240);assert.deepEqual(batches,[101,101,38]);
   protect=true;await assert.rejects(host.inspectHistoryCleanup(input,fence),/protect history/);
   protect=false;missing=true;await assert.rejects(host.inspectHistoryCleanup(input,fence),/protect history/);
   missing=false;(participant as any).recoveryReferences=undefined;await assert.rejects(host.inspectHistoryCleanup(input,fence),/coverage unavailable/);
  });
  await host.releaseQuiescence({...fence,outcome:'unchanged'});assert.equal(host.diagnostics().activeAgents,0);
 }finally{await host.close();await rm(root,{recursive:true,force:true})}
});
