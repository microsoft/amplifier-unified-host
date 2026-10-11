import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createHost} from '../src/host.js';
import {workspaceCleanupCensus} from '../src/workspace-cleanup.js';
const census=(items:any[])=>({version:1,coverage:'indexed-metadata-only',transcriptBodiesRead:false,externalWriterCoverage:false,items});
test('cleanup census includes hidden children and independent overlapping paths',()=>{
 const rows=[{uri:'ahp-session:/root',engineId:'native',nativeSessionId:'one',workingDirectory:'/work'}, {uri:'ahp-session:/child',engineId:'native',nativeSessionId:'two',workingDirectory:'/work',parentUri:'ahp-session:/root',storagePath:'/native/two'}, {uri:'ahp-session:/other',engineId:'native',nativeSessionId:'three',workingDirectory:'/work/nested'}];
 const result=workspaceCleanupCensus('/work','native',census(rows),[]);
 assert.equal(result.sessions.length,2);assert.deepEqual(result.archiveSessions,['ahp-session:/root']);assert.deepEqual(result.protectedPaths,['/native/two','/work/nested']);
 assert.throws(()=>workspaceCleanupCensus('/work','native',census(rows),[{...rows[0],workingDirectory:'/elsewhere'}]),/disagree/);
 assert.throws(()=>workspaceCleanupCensus('/work','foreign',census(rows),[]),/configured native/);
 assert.throws(()=>workspaceCleanupCensus('/work','native',census(Array(10001).fill(rows[0])),[]),/bounded/);
});
test('completed folder removal archives root chats under live holds without starting an agent; settlement never repeats the effect',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'workspace-cleanup-'))),folder=join(root,'work');await mkdir(folder);
 const uri='ahp-session:/'+randomUUID(),child='ahp-session:/'+randomUUID(),rows=new Map<string,any>();
 for(const id of [uri,child])rows.set(id,{uri:id,engineId:'native',nativeSessionId:randomUUID(),workingDirectory:folder,title:'Retained chat',createdAt:'2026-10-01T00:00:00Z',modifiedAt:'2026-10-01T00:00:00Z',...(id===child?{parentUri:uri}:{})});
 let failed=false;
 const catalog={list:async()=>({items:[...rows.values()]}),get:async(id:string)=>rows.get(id),upsert:async()=>{},libraryCapabilities:async()=>({workspaceCleanupCensus:{version:1}}),workspaceCleanupCensus:async()=>census([...rows.values()]),projectSessionArchives:async({items}:any)=>{if(failed)throw Error('lost projection');for(const item of items)rows.get(item.uri).isArchived=item.isArchived;}};
 const host=await createHost({stateDirectory:join(root,'host'),allowedWorkspaceRoots:[root],engines:[{id:'native',command:'/must-not-start'}],catalog,quiescence:{instanceId:'instance',dataScope:'scope',requiredOwners:[],coverage:{},participants:[],verifyRelease:async(input:any)=>({verified:true,...input,receiptId:'trusted'})}});
 try{
  await assert.rejects(host.inspectWorkspaceCleanup({path:folder,engineId:'native'},{}),/held/);
  const admission:any=await host.admitQuiescence({commandId:'reviewed-cleanup',purpose:'recovery'}),fence={fenceId:admission.fenceId,commandId:'reviewed-cleanup',instanceId:'instance',dataScope:'scope',purpose:'recovery'};
  let selected:any;await host.withQuiescenceMaintenance(fence,async()=>{selected=await host.inspectWorkspaceCleanup({path:folder,engineId:'native'},fence);});
  assert.deepEqual(selected.archiveSessions,[uri]);await rm(folder,{recursive:true});
  const input={commandId:'archive',workspaceId:'work',path:folder,sessions:selected.archiveSessions,nativeReceipt:{commandId:'native-remove',operation:'maintenance.workspace.remove',state:'succeeded',result:{workspaceId:'work',removed:true,historyPreserved:true,canonicalFilesChanged:0,replayed:false,previewHash:'review'}}};
  failed=true;await assert.rejects(host.withQuiescenceMaintenance(fence,()=>host.archiveWorkspaceCleanup(input,fence)),/lost projection/);
  assert.equal(host.inspectQuiescence().fence?.phase,'unknown');assert.equal(host.workspaceCleanupReceipt('archive').receipt?.state,'succeeded');
  failed=false;await host.withQuiescenceSettlement(fence,()=>host.archiveWorkspaceCleanup(input,fence));
  assert.equal(host.workspaceCleanupReceipt('archive').receipt?.result.historyPreserved,true);assert.equal(rows.get(uri).isArchived,true);assert.equal(rows.get(child).isArchived,undefined);assert.equal(host.diagnostics().activeAgents,0);
  await assert.rejects(host.withQuiescenceSettlement({...fence,commandId:'other'},async()=>{}),/Original completed/);
  await host.releaseQuiescence({...fence,outcome:'unchanged'});
 }finally{await host.close();await rm(root,{recursive:true,force:true});}
});
