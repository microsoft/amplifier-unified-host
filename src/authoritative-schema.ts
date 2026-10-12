import {DatabaseSync} from 'node:sqlite';
import {lstatSync} from 'node:fs';

/** Host-local schema admission, not a row-integrity or backup authority. */
type Tables=Record<string,Record<string,string>>;
const tables = {
 store: {
  model_usage: {"session":"TEXT","call_id":"TEXT","payload":"TEXT"},
  meta: {"key":"TEXT","value":"INTEGER"},
  library_identity: {"id":"INTEGER","source":"TEXT"},
  sessions: {"uri":"TEXT","chat_uri":"TEXT","engine_id":"TEXT","native_id":"TEXT","cwd":"TEXT","modified":"TEXT","summary":"TEXT","state":"TEXT","chat":"TEXT","execution_cwd":"TEXT","native_location_revision":"INTEGER","hidden":"INTEGER"},
  turns: {"chat":"TEXT","ordinal":"INTEGER","turn_id":"TEXT","payload":"TEXT"},
  coordination_results: {"chat":"TEXT","turn_id":"TEXT","sequence":"INTEGER","text":"TEXT","truncated":"INTEGER","state":"TEXT"},
  actions: {"seq":"INTEGER","channel":"TEXT","payload":"TEXT","bytes":"INTEGER"},
  receipts: {"command_id":"TEXT","channel":"TEXT","client_id":"TEXT","client_seq":"INTEGER","payload":"TEXT"},
  receipt_attempts: {"command_id":"TEXT","attempt":"INTEGER","receipt":"TEXT","turn_payload":"TEXT"},
  terminals: {"uri":"TEXT","session":"TEXT","modified":"TEXT","payload":"TEXT","lifecycle":"TEXT"},
  session_admission: {"uri":"TEXT","execution":"INTEGER","interruption":"INTEGER","configuration":"INTEGER"},
  relocations: {"command_id":"TEXT","uri":"TEXT","source":"TEXT","target":"TEXT","status":"TEXT","payload":"TEXT"},
  history_edit_archives: {"operation_id":"TEXT","chat":"TEXT","ordinal":"INTEGER","turn_id":"TEXT","payload":"TEXT"},
  history_edits: {"operation_id":"TEXT","session":"TEXT","input_id":"TEXT","status":"TEXT","payload":"TEXT"},
  lifecycle_commands: {"command_id":"TEXT","session":"TEXT","operation":"TEXT","target":"TEXT","status":"TEXT","payload":"TEXT","result":"TEXT"},
  session_visibility: {"uri":"TEXT","deleted":"INTEGER","command_id":"TEXT"},
  export_resources: {"uri":"TEXT","session":"TEXT","snapshot_id":"TEXT","metadata":"TEXT"},
  transfer_fences: {"session":"TEXT","transfer_id":"TEXT","source":"TEXT","destination":"TEXT","status":"TEXT","payload":"TEXT"},
  transfer_commands: {"command_id":"TEXT","session":"TEXT","transfer_id":"TEXT","operation":"TEXT","status":"TEXT","payload":"TEXT","result":"TEXT"},
  import_adoptions: {"command_id":"TEXT","engine_id":"TEXT","import_command_id":"TEXT","session":"TEXT","status":"TEXT","payload":"TEXT","proof":"TEXT","result":"TEXT"},
  creation_keys: {"identity":"TEXT","command_id":"TEXT","uri":"TEXT","fingerprint":"TEXT"},
  queue_intents: {"id":"TEXT","chat":"TEXT","message":"TEXT","origin":"TEXT","position":"INTEGER","status":"TEXT","held":"INTEGER","reason":"TEXT","projected":"INTEGER"},
  steering_intents: {"id":"TEXT","chat":"TEXT","message":"TEXT","origin":"TEXT","status":"TEXT","held":"INTEGER","active_turn_id":"TEXT","generation_id":"TEXT","reason":"TEXT","projected":"INTEGER"},
  active_events: {"seq":"INTEGER","channel":"TEXT","action":"TEXT"},
 },
 quiescence: {
  host_quiescence_fence: {"id":"INTEGER","payload":"TEXT"},
  host_quiescence_commands: {"command_id":"TEXT","signature":"TEXT","payload":"TEXT"},
  host_quiescence_attempts: {"id":"INTEGER","command_id":"TEXT","payload":"TEXT"},
  host_service_releases: {"fence_id":"TEXT","command_id":"TEXT","request_signature":"TEXT","proof_signature":"TEXT","fence":"TEXT","proof":"TEXT","state":"TEXT","result":"TEXT"},
 },
 managedFiles: {
  managed_file_reviews: {"id":"TEXT","session":"TEXT","body":"TEXT"},
  managed_file_effects: {"command_id":"TEXT","session":"TEXT","signature":"TEXT","body":"TEXT"},
 },
 retention: {
  retention_reviews: {"id":"TEXT","hash":"TEXT","expires":"INTEGER","payload":"TEXT"},
  retention_items: {"command_id":"TEXT","batch_id":"TEXT","session":"TEXT","payload":"TEXT"},
  retention_commands: {"command_id":"TEXT","signature":"TEXT","status":"TEXT","payload":"TEXT","result":"TEXT"},
 },
 presentation: {
  presentation_state: {"id":"INTEGER","payload":"TEXT"},
  presentation_reviews: {"id":"TEXT","command_id":"TEXT","signature":"TEXT","payload":"TEXT"},
  presentation_review_rows: {"review_id":"TEXT","ordinal":"INTEGER","session":"TEXT","metadata":"TEXT","metadata_hash":"TEXT","before_hidden":"INTEGER","before_revision":"INTEGER","target_hidden":"INTEGER"},
  presentation_markers: {"session":"TEXT","hidden":"INTEGER","revision":"INTEGER","identity":"TEXT","metadata":"TEXT","command_id":"TEXT"},
  presentation_commands: {"command_id":"TEXT","signature":"TEXT","review_id":"TEXT","payload":"TEXT","effect":"TEXT"},
  presentation_projection_batches: {"command_id":"TEXT","ordinal":"INTEGER","request":"TEXT","result":"TEXT","state":"TEXT"},
  presentation_mappings: {"session":"TEXT","metadata":"TEXT"},
  presentation_rebuilds: {"command_id":"TEXT","signature":"TEXT","payload":"TEXT"},
  presentation_rebuild_rows: {"command_id":"TEXT","ordinal":"INTEGER","session":"TEXT","metadata":"TEXT","hidden":"INTEGER"},
 },
 managed: {
  allocations: {"command_id":"TEXT","session":"TEXT","signature":"TEXT","state":"TEXT","request":"TEXT","marker":"TEXT","result":"TEXT","identity":"TEXT","copy_source":"TEXT"},
 },
} satisfies Record<string,Tables>;
type Owner=keyof typeof tables;
const owners=Object.keys(tables) as Owner[];
const ownedTables=owners.flatMap(owner=>Object.keys(tables[owner]));
// AH schema admission v1. Low six bits record initialized namespaces; bit 64
// records the additive library-identity epoch; bit 128 records usage receipts.
// The markers survive table loss.
const marker=0x41480100, mask=0xff, libraryIdentityBit=64, usageBit=128;
const beforeUsageStore=Object.fromEntries(Object.entries(tables.store).filter(([name])=>name!=='model_usage'));
const previousStore=Object.fromEntries(Object.entries(beforeUsageStore).filter(([name])=>name!=='library_identity'));
const namespaceBits:Record<Owner,number>={store:1,quiescence:2,managedFiles:4,retention:8,presentation:16,managed:32};
const bits=(owner:Owner)=>namespaceBits[owner];
const initialStore=['meta','sessions','turns','actions','receipts','terminals','active_events'];
// Exact table-set epochs from public Host history; not arbitrary subsets. Derived
// archive_projection_pending was added between coordination and import adoption.
const storeEpochs=[
 initialStore,
 ['session_admission','creation_keys'], // 563b43e
 ['relocations'], // 8c273c5
 ['queue_intents'], // 73b3b5f
 ['steering_intents'], // 6987590
 ['receipt_attempts'], // 34cedf3
 ['history_edit_archives','history_edits','lifecycle_commands','session_visibility','export_resources'], // eee0ad1
 ['transfer_fences','transfer_commands'], // 0352915
 ['coordination_results'], // f55a2ff
 ['import_adoptions'], // f78d604
].map((_,i,all)=>all.slice(0,i+1).flat());
function profile(owner:Owner,names:string[],omit:Record<string,string[]>={}):Tables {
 const spec:Tables=tables[owner];
 return Object.fromEntries(names.map(name=>[name,Object.fromEntries(Object.entries(spec[name]!).filter(([column])=>!omit[name]?.includes(column)))]));
}
// These are completed initializer schemas, including ALTER migrations. Columns
// are bound to their exact table epoch; newer tables cannot excuse lost columns.
const legacyProfiles:Partial<Record<Owner,Tables[]>>={
 store:[...storeEpochs.map((names,i)=>profile('store',names,{sessions:i<2?['execution_cwd','native_location_revision','hidden']:i<6?['hidden']:[]})),beforeUsageStore,tables.store],
 quiescence:[profile('quiescence',['host_quiescence_fence','host_quiescence_commands']),profile('quiescence',['host_quiescence_fence','host_quiescence_commands','host_quiescence_attempts']),tables.quiescence],
 managed:[profile('managed',['allocations'],{allocations:['copy_source']}),tables.managed],
};
export class AuthoritativeSchemaError extends Error {
 readonly code='HOST_AUTHORITATIVE_SCHEMA';
 constructor(detail:string){super(`Authoritative Host database schema is unavailable (${detail}); preserve the database and inspect or restore its original backup. No state was recreated.`);}
}
const fail=(detail:string):never=>{throw new AuthoritativeSchemaError(detail);};
function inspect(db:DatabaseSync){
 const version=Number(db.prepare('PRAGMA user_version').get()!.user_version);
 if(version!==0&&((version&~mask)!==marker||(version&mask)===0))fail('unsupported schema version');
 const objects=new Map(db.prepare(`SELECT name,type FROM sqlite_schema WHERE type IN ('table','view') AND name IN (${ownedTables.map(()=>'?').join(',')})`).all(...ownedTables).map(row=>[String(row.name),String(row.type)]));
 let presentBits=version===0?0:version&mask;
 if((presentBits&(libraryIdentityBit|usageBit))&&!(presentBits&bits('store')))fail('library identity without Store');
 for(const owner of owners){
  const spec:Tables=tables[owner],expected=Object.keys(spec),present=expected.filter(name=>objects.has(name)),marked=!!(presentBits&bits(owner));
  if(!marked&&!present.length)continue;
  const columns=new Map<string,Map<string,string>>();
  for(const name of present){
   if(objects.get(name)!=='table')fail(`${name} is not a table`);
   columns.set(name,new Map(db.prepare(`PRAGMA table_info("${name}")`).all().map(row=>[String(row.name),String(row.type).toUpperCase()])));
  }
  const matches=(schema:Tables,exact:boolean)=>Object.keys(schema).length===present.length&&Object.entries(schema).every(([name,fields])=>{
   const actual=columns.get(name);return !!actual&&(!exact||actual.size===Object.keys(fields).length)&&Object.entries(fields).every(([column,type])=>actual.get(column)===type);
  });
  const profiles=marked?[owner==='store'&&!(presentBits&libraryIdentityBit)?previousStore:owner==='store'&&!(presentBits&usageBit)?beforeUsageStore:spec]:(legacyProfiles[owner]??[spec]);
  if(!profiles.some(schema=>matches(schema,!marked)))fail(`${owner} table/column profile`);
  if(owner==='store'&&objects.has('library_identity')){
   const rows=db.prepare('SELECT id,source FROM library_identity LIMIT 2').all();
   if(rows.length!==1||rows[0].id!==1||typeof rows[0].source!=='string'||!/^[a-f0-9]{64}$/.test(rows[0].source))fail('library identity missing or invalid');
  }
  if(matches(spec,false))presentBits|=bits(owner)|(owner==='store'?libraryIdentityBit|usageBit:0);
 }
 return {version,presentBits,objects};
}
/** Validate every previously initialized authority before this owner's writes.
 * An existing file owned by Store/ManagedAllocations cannot become a fresh DB.
 * A never-initialized optional namespace can be added on a later composition.
 */
function pathExists(path:string){try{lstatSync(path);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}}
export function preflightAuthorityFile(path:string,owner:Owner):boolean {
 if(!pathExists(path)){
  // Even an empty/dangling sidecar is evidence of a prior database lifetime.
  if(['-wal','-shm','-journal'].some(suffix=>pathExists(path+suffix)))fail(`${owner} main database missing with retained sidecar`);
  return false;
 }
 // Closing a writable SQLite handle can checkpoint a crash-left WAL, even when
 // validation fails. Read-only preflight preserves that evidence before opening
 // the owner's ordinary writable connection.
 const db=new DatabaseSync(path,{readOnly:true});
 try{const state=inspect(db);if(!Object.keys(tables[owner]).some(name=>state.objects.has(name)))fail(`${owner} missing from existing file`);}
 finally{db.close();}
 return true;
}
export function initializeAuthority(db:DatabaseSync,owner:Owner,initialize:()=>void,options:{existingFile?:boolean;configure?:string}={}){
 const before=inspect(db);
 if(options.existingFile&&!Object.keys(tables[owner]).some(name=>before.objects.has(name)))fail(`${owner} missing from existing file`);
 if(options.configure)db.exec(options.configure);
 db.exec('SAVEPOINT host_schema_admission');
 try{
  // Acquire SQLite's write lock, then recheck before restart normalization.
  db.exec('PRAGMA user_version = '+before.version);
  const locked=inspect(db);
  initialize();
  db.exec('PRAGMA user_version = '+(marker|locked.presentBits|bits(owner)|(owner==='store'?libraryIdentityBit|usageBit:0)));
  const after=inspect(db);
  db.exec('PRAGMA user_version = '+(marker|after.presentBits));
  db.exec('RELEASE host_schema_admission');
 }catch(error){db.exec('ROLLBACK TO host_schema_admission; RELEASE host_schema_admission');throw error;}
}
