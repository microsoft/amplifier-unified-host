import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LibraryIndex,type LibraryHooks} from '../src/library-index.js';
import {createHost,type Catalog,type CatalogRecord} from '../src/host.js';
import {AhpClient} from '@microsoft/agent-host-protocol/client';
import {WebSocketTransport} from '@microsoft/agent-host-protocol/ws';
const make=(n:number):CatalogRecord=>({uri:`ahp-session:/${n}`,engineId:'unused',nativeSessionId:String(n),workingDirectory:'/owned',title:'Retained',createdAt:'2026-10-04T00:00:00Z',modifiedAt:'2026-10-04T00:00:00Z',status:1});
const deferred=()=>{let resolve!:()=>void,reject!:(e:Error)=>void;const promise=new Promise<void>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
test('25k metadata reconciliation retains cold unknowns beyond residency, bounded pages and restart',async()=>{
 const writes=new Map<string,CatalogRecord>();let reads=0,maxPage=0;const unknown=new Set(Array.from({length:100},(_,i)=>make(i).uri));
 const catalog:Catalog={list:async()=>({items:[]}),get:async()=>undefined,upsert:async row=>{writes.set(row.uri,row);},libraryQuery:async p=>({version:1,items:[],observationFreshness:p.observationFreshness})};
 const hooks:LibraryHooks={page:after=>{const first=after?Number(after.slice(13))+1:0;const rows=Array.from({length:Math.min(100,25000-first)},(_,i)=>make(first+i).uri);maxPage=Math.max(maxPage,rows.length);return rows;},record:uri=>{reads++;return make(Number(uri.slice(13)));},unknown:uri=>unknown.has(uri),live:()=>[],changed:()=>{}};
 const index=new LibraryIndex(catalog,hooks,'/owned-host','one');await index.reconcile();assert.equal(writes.size,25000);assert.equal(reads,25000);assert.equal(maxPage,100);assert.equal([...writes.values()].filter(r=>r.hostObservation?.effect==='unknown').length,100);
 assert.equal((await index.query({connectionId:'reader',allowedWorkspaceRoots:['/owned']})).observationFreshness!.phase,'complete');await index.close();
 const restart=new LibraryIndex(catalog,hooks,'/owned-host','two');assert.equal((await restart.query({connectionId:'reader',allowedWorkspaceRoots:['/owned']})).observationFreshness!.phase,'reconciling');await restart.reconcile();assert.equal(writes.get(make(3).uri)!.hostObservation!.effect,'unknown');assert.equal(writes.get(make(3).uri)!.hostObservation!.incarnation,'two');await restart.close();
});
test('older delayed success cannot clear newer failed update; retry repair is explicit',async()=>{
 const old=deferred();let calls=0;const catalog:Catalog={list:async()=>({items:[]}),get:async()=>undefined,upsert:async()=>{if(++calls===1)return old.promise;if(calls===2)throw Error('missed update');},libraryQuery:async p=>({version:1,items:[],observationFreshness:p.observationFreshness})};
 const hooks:LibraryHooks={page:()=>[],record:()=>make(1),unknown:()=>true,live:()=>[],changed:()=>{}};
 const index=new LibraryIndex(catalog,hooks,'/owned','one');const pending=index.write(make(1));await assert.rejects(index.write(make(1)),/missed update/);old.resolve();await pending;
 assert.equal((await index.query({connectionId:'reader',allowedWorkspaceRoots:['/owned']})).observationFreshness!.phase,'degraded');await index.write(make(1));await index.reconcile();assert.equal((await index.query({connectionId:'reader',allowedWorkspaceRoots:['/owned']})).observationFreshness!.phase,'complete');await index.close();
});
test('metadata read failure is degraded and an explicit successful pass repairs it',async()=>{
 let broken=true;const catalog:Catalog={list:async()=>({items:[]}),get:async()=>undefined,upsert:async()=>{},libraryQuery:async p=>({observationFreshness:p.observationFreshness})};
 const hooks:LibraryHooks={page:()=>{if(broken)throw Error('metadata unavailable');return [];},record:()=>{throw Error('metadata unavailable');},unknown:()=>false,live:()=>[],changed:()=>{}};
 const index=new LibraryIndex(catalog,hooks,'/owned','one');await index.reconcile();index.point(make(1).uri);
 assert.equal((await index.query({connectionId:'reader',allowedWorkspaceRoots:['/owned']})).observationFreshness!.phase,'degraded');
 broken=false;await index.reconcile();assert.equal((await index.query({connectionId:'reader',allowedWorkspaceRoots:['/owned']})).observationFreshness!.phase,'complete');await index.close();
});
test('Host library authority is intersected and cold unresolved receipts survive restart without agent starts',async()=>{
 const dir=await realpath(await mkdtemp(join(tmpdir(),'host-library-'))),uri=make(1).uri,rows=new Map<string,CatalogRecord>();rows.set(uri,{...make(1),workingDirectory:dir});let captured:any;
 const catalog:Catalog={list:async()=>({items:[rows.get(uri)!]}),get:async u=>rows.get(u),upsert:async r=>{rows.set(r.uri,r);},libraryQuery:async p=>{captured=p;return {version:1,items:[rows.get(uri)!],observationFreshness:p.observationFreshness};}};
 const config={stateDirectory:join(dir,'host'),allowedWorkspaceRoots:[dir],engines:[{id:'unused',command:'/must-never-start'}],catalog};let host=await createHost(config);
 try{await host.archiveSession(uri,true);const store=(host as any).store;store.admission('ahp-chat:/1',{},'retained-unknown','fixture',1);store.finish('retained-unknown','unknown');const before=JSON.stringify(store.receipt('retained-unknown'));await host.reconcileLibrary();await host.queryLibrary({connectionId:'reader',allowedWorkspaceRoots:['/'],activity:'attention'});assert.deepEqual(captured.allowedWorkspaceRoots,[dir]);assert.equal(rows.get(uri)!.hostObservation!.effect,'unknown');assert.equal(captured.liveFacts.items.length,0);assert.equal(host.diagnostics().activeAgents,0);await host.close();
 host=await createHost(config);await host.reconcileLibrary();assert.equal(JSON.stringify((host as any).store.receipt('retained-unknown')),before);assert.equal(rows.get(uri)!.hostObservation!.effect,'unknown');assert.equal(host.diagnostics().activeAgents,0);
 const client=new AhpClient(await WebSocketTransport.connect(host.url));client.connect();try{await client.initialize({clientId:'plain',protocolVersions:['0.9.0']});const listed:any=await client.request('listSessions',{channel:'ahp-root://',limit:50});assert.equal(listed.items[0].resource,uri);assert.equal(listed.items[0].status&64,64);}finally{await client.shutdown();}
 }finally{await host.close();await rm(dir,{recursive:true,force:true});}
});

test('receipt observers publish only committed status changes, preserving rolled-back receipt bytes',async()=>{
 const {Store}=await import('../src/store.js');const dir=await realpath(await mkdtemp(join(tmpdir(),'library-commit-'))),store=new Store(dir);const changed:string[]=[];
 try{store.admission('ahp-chat:/kept',{},'receipt','fixture',1);const before=JSON.stringify(store.receipt('receipt'));store.onReceiptChanged=channel=>changed.push(channel);
 assert.throws(()=>store.transaction(()=>{store.finish('receipt','unknown');throw Error('rollback');}),/rollback/);
 assert.equal(JSON.stringify(store.receipt('receipt')),before);assert.deepEqual(changed,[]);
 store.transaction(()=>store.finish('receipt','unknown'));assert.deepEqual(changed,['ahp-chat:/kept']);assert.equal(store.receipt('receipt')!.status,'unknown');
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});

test('older Catalog keeps ordinary Host lists without observation sweeps or invented capability',async()=>{
 const dir=await realpath(await mkdtemp(join(tmpdir(),'library-older-')));let writes=0;
 const catalog:Catalog={supportsLibraryQuery:async()=>false,libraryQuery:async()=>{throw Error('must not call');},list:async()=>({items:[]}),get:async()=>undefined,upsert:async()=>{writes++;}};
 const host=await createHost({stateDirectory:join(dir,'host'),allowedWorkspaceRoots:[dir],engines:[{id:'unused',command:'/must-never-start'}],catalog});
 try{assert.equal(writes,0);await assert.rejects(host.queryLibrary({connectionId:'reader',allowedWorkspaceRoots:[dir]}),/unavailable/);assert.equal(host.diagnostics().activeAgents,0);}finally{await host.close();await rm(dir,{recursive:true,force:true});}
});
