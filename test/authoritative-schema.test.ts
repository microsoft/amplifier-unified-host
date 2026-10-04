import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readFileSync,rmSync,writeFileSync,existsSync,realpathSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {Store} from '../src/store.js';
import {QuiescenceGate} from '../src/quiescence.js';
import {ManagedAllocations} from '../src/managed.js';
import {ManagedFilesJournal} from '../src/managed-files.js';
import {Retention} from '../src/retention.js';
import {ConversationPresentation} from '../src/presentation.js';
import {initializeAuthority} from '../src/authoritative-schema.js';
const hash=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
const fixture=()=>realpathSync(mkdtempSync(join(tmpdir(),'host-schema-')));
const absent=(db:DatabaseSync,table:string)=>!db.prepare('SELECT 1 FROM sqlite_schema WHERE name=?').get(table);
const config={instanceId:'test-instance',dataScope:'owned-fixture',requiredOwners:[],coverage:{},participants:[],verifyRelease:async()=>{throw Error('Not requested');}};
const gate=(db:DatabaseSync)=>new QuiescenceGate(db,config,[],()=>({counts:{},gaps:[]}),async()=>({ready:true}));
const admit=(store:Store)=>store.admission('ahp-chat:/fixture',{text:'never dispatched'},'original-input','fixture-user',1);
const refused={code:'HOST_AUTHORITATIVE_SCHEMA'};
function damage(directory:string,sql:string){const db=new DatabaseSync(join(directory,'host.sqlite'));db.exec(sql);db.close();}
function withoutWrites(directory:string,open:()=>unknown){const path=join(directory,'host.sqlite'),before=hash(path);assert.throws(open,refused);assert.equal(hash(path),before);}

for(const table of ['receipts','lifecycle_commands','transfer_fences','queue_intents','turns'])test(`existing ${table} loss refuses before restart normalization`,()=>{
 const directory=fixture();try{const store=new Store(directory);admit(store);store.close();damage(directory,`DROP TABLE ${table}`);
  withoutWrites(directory,()=>new Store(directory));withoutWrites(directory,()=>new Store(directory));
  const db=new DatabaseSync(join(directory,'host.sqlite'),{readOnly:true});try{assert.equal(absent(db,table),true);if(table!=='receipts')assert.equal(JSON.parse(String(db.prepare('SELECT payload FROM receipts').get()!.payload)).status,'admitted');}finally{db.close();}
 }finally{rmSync(directory,{recursive:true,force:true});}
});

test('actual held fence cannot disappear into an open intake, including all namespace tables missing',async()=>{
 for(const all of [false,true]){const directory=fixture();try{const store=new Store(directory);admit(store);const result=await gate(store.db).admit({commandId:'original-maintenance',purpose:'recovery'});assert.equal(result.admitted,true);store.close();
  damage(directory,all?'DROP TABLE host_quiescence_fence; DROP TABLE host_quiescence_commands; DROP TABLE host_quiescence_attempts; DROP TABLE host_service_releases':'DROP TABLE host_quiescence_fence');
  withoutWrites(directory,()=>new Store(directory));const db=new DatabaseSync(join(directory,'host.sqlite'),{readOnly:true});try{if(!all)assert.equal(JSON.parse(String(db.prepare('SELECT payload FROM host_quiescence_commands').get()!.payload)).admitted,true);}finally{db.close();}
 }finally{rmSync(directory,{recursive:true,force:true});}}
});

for(const [label,create,drop] of [
 ['managed-files',(db:DatabaseSync)=>new ManagedFilesJournal(db),'managed_file_effects'],
 ['retention',(db:DatabaseSync)=>new Retention(db,{} as any),'retention_commands'],
 ['presentation',(db:DatabaseSync)=>new ConversationPresentation(db,{} as any),'presentation_state'],
] as const)test(`${label} existing schema checked even before optional owner is reconstructed`,()=>{
 const directory=fixture();try{const store=new Store(directory);create(store.db);admit(store);store.close();damage(directory,`DROP TABLE ${drop}`);withoutWrites(directory,()=>new Store(directory));}
 finally{rmSync(directory,{recursive:true,force:true});}
});

test('managed allocation receipts cannot be recreated after ledger table loss; old copy_source migration remains supported',()=>{
 const directory=fixture(),path=join(directory,'managed-allocations.sqlite');try{const owner=new ManagedAllocations(directory);const input={session:'ahp-session:/11111111-1111-4111-8111-111111111111',provider:'fixture',commandId:'original-allocation'};owner.reserve(input);owner.close();let db=new DatabaseSync(path);db.exec('PRAGMA user_version=0; ALTER TABLE allocations DROP COLUMN copy_source');db.close();
  const migrated=new ManagedAllocations(directory);assert.equal(migrated.receipt(input.commandId)?.state,'unknown');migrated.close();db=new DatabaseSync(path);db.exec('DROP TABLE allocations');db.close();const before=hash(path);assert.throws(()=>new ManagedAllocations(directory),refused);assert.equal(hash(path),before);
 }finally{rmSync(directory,{recursive:true,force:true});}
});

test('missing required columns, substituted views and unsupported versions are retained rather than repaired',()=>{
 for(const sql of ['ALTER TABLE receipts RENAME COLUMN payload TO lost_payload','DROP TABLE receipts; CREATE VIEW receipts AS SELECT 1 AS command_id','PRAGMA user_version=123','PRAGMA user_version=1095238145']){const directory=fixture();try{new Store(directory).close();damage(directory,sql);withoutWrites(directory,()=>new Store(directory));}finally{rmSync(directory,{recursive:true,force:true});}}
});

test('existing empty file is not a genuinely new database',()=>{
 const directory=fixture();try{writeFileSync(join(directory,'host.sqlite'),'');withoutWrites(directory,()=>new Store(directory));}finally{rmSync(directory,{recursive:true,force:true});}
});

for(const sidecar of ['-wal','-shm','-journal'])test(`absent main with retained ${sidecar} is never a fresh authoritative store`,()=>{
 for(const managed of [false,true]){const directory=fixture(),path=join(directory,managed?'managed-allocations.sqlite':'host.sqlite');try{writeFileSync(path+sidecar,'');const before=hash(path+sidecar);assert.throws(()=>managed?new ManagedAllocations(directory):new Store(directory),refused);assert.equal(existsSync(path),false);assert.equal(hash(path+sidecar),before);}finally{rmSync(directory,{recursive:true,force:true});}}
});

test('genuinely new, partial optional profiles and derived indexes remain supported',()=>{
 const directory=fixture();try{let store=new Store(directory);admit(store);store.close();store=new Store(directory);assert.equal(store.receipt('original-input')!.status,'unknown');assert.equal(absent(store.db,'presentation_state'),true);
  new ManagedFilesJournal(store.db);new Retention(store.db,{} as any);gate(store.db);new ConversationPresentation(store.db,{} as any);const presentation=String(store.db.prepare('SELECT payload FROM presentation_state').get()!.payload);store.close();
  damage(directory,'DROP TABLE archive_projection_pending; DROP INDEX receipt_origin_lookup; DROP TABLE presentation_hints; DROP TABLE presentation_hint_state; DROP TABLE presentation_hint_settlements');
  store=new Store(directory);new ConversationPresentation(store.db,{} as any);assert.equal(absent(store.db,'archive_projection_pending'),false);assert.equal(absent(store.db,'presentation_hints'),false);assert.equal(store.receipt('original-input')!.status,'unknown');assert.equal(JSON.parse(String(store.db.prepare('SELECT payload FROM presentation_state').get()!.payload)).source,JSON.parse(presentation).source);store.close();
 }finally{rmSync(directory,{recursive:true,force:true});}
});

const history=JSON.parse(readFileSync(new URL('./fixtures/host-schema-history.json',import.meta.url),'utf8'));
for(const epoch of history.epochs)test(`documented legacy schema ${epoch.source.slice(0,7)} migrates atomically`,()=>{
 const directory=fixture();try{const db=new DatabaseSync(join(directory,'host.sqlite'));for(const index of epoch.statements)db.exec(history.statements[index]);for(const index of epoch.migrations){const m=history.migrations[index];if(!db.prepare(`PRAGMA table_info(${m.table})`).all().some(row=>row.name===m.column))db.exec(m.sql);}db.prepare('INSERT INTO meta VALUES(?,?)').run('seq',7);db.close();
  const owner=new Store(directory);assert.equal(owner.seq,7);assert.ok(Number(owner.db.prepare('PRAGMA user_version').get()!.user_version)>0);assert.equal(absent(owner.db,'import_adoptions'),false);owner.close();
 }finally{rmSync(directory,{recursive:true,force:true});}
});

test('unversioned current damage is not an arbitrary legacy subset',()=>{
 const directory=fixture();try{new Store(directory).close();damage(directory,'PRAGMA user_version=0; DROP TABLE lifecycle_commands');withoutWrites(directory,()=>new Store(directory));}finally{rmSync(directory,{recursive:true,force:true});}
});

test('later unversioned tables cannot authorize reconstruction of columns from older epochs',()=>{
 for(const sql of [
  'DROP INDEX sessions_execution; ALTER TABLE sessions DROP COLUMN execution_cwd; ALTER TABLE sessions DROP COLUMN native_location_revision',
  'DROP INDEX sessions_visible_order; ALTER TABLE sessions DROP COLUMN hidden',
  'DROP INDEX terminals_lifecycle; ALTER TABLE terminals DROP COLUMN lifecycle',
  'DROP INDEX queue_projection_pending; ALTER TABLE queue_intents DROP COLUMN projected',
 ]){const directory=fixture();try{const store=new Store(directory);admit(store);store.close();damage(directory,'PRAGMA user_version=0; '+sql);withoutWrites(directory,()=>new Store(directory));const db=new DatabaseSync(join(directory,'host.sqlite'),{readOnly:true});try{assert.equal(JSON.parse(String(db.prepare('SELECT payload FROM receipts').get()!.payload)).status,'admitted');}finally{db.close();}}finally{rmSync(directory,{recursive:true,force:true});}}
});

test('legacy quiescence service migration and independently initialized namespace are valid',()=>{
 const db=new DatabaseSync(':memory:');try{db.exec('CREATE TABLE host_quiescence_fence(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL);CREATE TABLE host_quiescence_commands(command_id TEXT PRIMARY KEY,signature TEXT NOT NULL,payload TEXT NOT NULL)');const owner=gate(db);assert.equal(owner.inspect().intakeClosed,false);assert.equal(absent(db,'host_service_releases'),false);new ManagedFilesJournal(db);assert.equal(absent(db,'sessions'),true);}finally{db.close();}
});

test('failed first creation rolls back both schema and initialized-component marker',()=>{
 const db=new DatabaseSync(':memory:');try{assert.throws(()=>initializeAuthority(db,'managedFiles',()=>{db.exec('CREATE TABLE managed_file_reviews(id TEXT PRIMARY KEY,session TEXT NOT NULL,body TEXT NOT NULL)');throw Error('injected before effect table');}),/injected/);assert.equal(absent(db,'managed_file_reviews'),true);assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,0);new ManagedFilesJournal(db);}finally{db.close();}
});

test('crash-left WAL evidence is unchanged when missing schema rejects startup',{timeout:10000},async()=>{
 const directory=process.env.HOST_SCHEMA_WAL_EVIDENCE?realpathSync(mkdtempSync(join(process.env.HOST_SCHEMA_WAL_EVIDENCE,'wal-fixture-'))):fixture(),path=join(directory,'host.sqlite');let child:ReturnType<typeof spawn>|undefined;
 try{const store=new Store(directory);admit(store);store.close();
  const script=`const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA wal_autocheckpoint=0; DROP TABLE lifecycle_commands');console.log('committed');setInterval(()=>{},1000);`;
  child=spawn(process.execPath,['-e',script,path],{stdio:['ignore','pipe','pipe']});let errors='';child.stderr!.on('data',chunk=>errors+=String(chunk));const exit=once(child,'exit');const data=await Promise.race([once(child.stdout!,'data'),exit.then(()=>{throw Error('fixture exited: '+errors);})]);assert.match(String(data[0]),/committed/);child.kill('SIGKILL');await exit;
  assert.equal(existsSync(path+'-wal'),true);const before={main:hash(path),wal:hash(path+'-wal')};assert.throws(()=>new Store(directory),refused);assert.deepEqual({main:hash(path),wal:hash(path+'-wal')},before);assert.throws(()=>new Store(directory),refused);assert.deepEqual({main:hash(path),wal:hash(path+'-wal')},before);
  renameSync(path,path+'.retained');assert.throws(()=>new Store(directory),refused);assert.equal(existsSync(path),false);assert.equal(hash(path+'-wal'),before.wal);renameSync(path+'.retained',path);
  if(process.env.HOST_SCHEMA_WAL_EVIDENCE)writeFileSync(join(directory,'receipt.json'),JSON.stringify({case:'crash-left-wal-refused-before-writable-open',before,after:{main:hash(path),wal:hash(path+'-wal')},noRecreatedTable:true},null,2)+'\n');
 }finally{if(child?.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit');}if(!process.env.HOST_SCHEMA_WAL_EVIDENCE)rmSync(directory,{recursive:true,force:true});}
});
