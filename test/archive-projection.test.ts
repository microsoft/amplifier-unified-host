import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {AhpClient} from '@microsoft/agent-host-protocol/client';
import {WebSocketTransport} from '@microsoft/agent-host-protocol/ws';
import {SessionStatus} from '@microsoft/agent-host-protocol';
import {createHost,type CatalogRecord} from '../src/host.js';

test('archive projection is durable across host restart and failed unarchive acknowledgement without native startup',async()=>{
 const temp=await realpath(await mkdtemp(join(tmpdir(),'archive-projection-'))),uri='ahp-session:/'+randomUUID(),rows=new Map<string,CatalogRecord>(),batches:any[]=[];let refuse=false;
 rows.set(uri,{uri,engineId:'unused',nativeSessionId:randomUUID(),workingDirectory:temp,title:'Historical',createdAt:'2026-10-02T00:00:00Z',modifiedAt:'2026-10-02T00:00:00Z',isArchived:false});
 const catalog={async list(){return {items:[...rows.values()]};},async get(uri:string){return rows.get(uri);},async upsert(record:CatalogRecord){if(refuse)throw Error('lost projection');rows.set(record.uri,structuredClone(record));},async projectSessionArchives({items}:any){assert.ok(items.length<=100);batches.push(items);for(const item of items)rows.set(item.uri,{...rows.get(item.uri)!,isArchived:item.isArchived});}};
 const config={stateDirectory:join(temp,'host'),allowedWorkspaceRoots:[temp],engines:[{id:'unused',command:'/must-never-start'}],catalog};let host=await createHost(config);
 try{
  await host.archiveSession(uri,true);assert.equal(rows.get(uri)!.isArchived,true);assert.equal(host.diagnostics().activeAgents,0);await host.close();
  rows.set(uri,{...rows.get(uri)!,isArchived:false});host=await createHost(config);assert.equal(rows.get(uri)!.isArchived,true);assert.equal(batches.at(-1)[0].isArchived,true);
  refuse=true;await assert.rejects(host.archiveSession(uri,false),/lost projection/);await host.close();refuse=false;
  host=await createHost(config);assert.equal(rows.get(uri)!.isArchived,false);assert.equal(batches.at(-1)[0].isArchived,false);
  const client=new AhpClient(await WebSocketTransport.connect(host.url));client.connect();try{await client.initialize({clientId:'archive-reader',protocolVersions:['0.9.0']});const result:any=await client.request('listSessions',{channel:'ahp-root://',limit:50});assert.equal(result.items[0].status & SessionStatus.IsArchived,0);}finally{await client.shutdown();}
  assert.equal(host.diagnostics().activeAgents,0);
 }finally{await host.close();await rm(temp,{recursive:true,force:true});}
});
