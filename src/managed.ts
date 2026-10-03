import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {constants,lstatSync,mkdirSync,realpathSync} from 'node:fs';
import {open,mkdir,lstat,realpath} from 'node:fs/promises';
import {join,dirname,isAbsolute} from 'node:path';
import {OwnerLease} from './owner-lease.js';
type Json=Record<string,any>;
export interface ManagedLocation {version:1;kind:'managed';allocationId:string;creationReceipt:string;allocationHash:string;owner:'amplifier-unified';}
export interface ManagedSessionCreate {session:string;commandId:string;provider?:string;title?:string;bundle?:string;bundleRevision?:string;selection?:{instance:string;model:string;effort?:string};}
const canonical=(v:any):string=>JSON.stringify(v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).filter(k=>v[k]!==undefined).sort().map(k=>[k,JSON.parse(canonical(v[k]))])):v);
export const managedHash=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
const fault=(message:string)=>Object.assign(new Error(message),{code:-32011,data:{executed:false}});
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
/** Explicit private allocation owner. A cwd or catalog label never grants ownership. */
export class ManagedAllocations {
 readonly root:string;readonly db!:DatabaseSync;private lease:OwnerLease;private rootIdentity:{dev:string;ino:string};
 constructor(root:string){
  if(!isAbsolute(root))throw fault('Managed allocation root must be absolute');
  for(let part=root;;part=dirname(part)){try{if(lstatSync(part).isSymbolicLink())throw fault('Managed root cannot traverse symlinks');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}if(dirname(part)===part)break;}
  mkdirSync(root,{recursive:true,mode:0o700});this.root=realpathSync(root);const rootStat=lstatSync(this.root,{bigint:true});this.rootIdentity={dev:String(rootStat.dev),ino:String(rootStat.ino)};for(const name of ['host-owner-lock.sqlite','managed-allocations.sqlite','managed-allocations.sqlite-wal','managed-allocations.sqlite-shm']){try{const item=lstatSync(join(this.root,name));if(!item.isFile()||item.nlink!==1)throw fault('Managed owner ledger is not a private regular file');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}this.lease=new OwnerLease(this.root);
  try{this.db=new DatabaseSync(join(this.root,'managed-allocations.sqlite'));this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;
   CREATE TABLE IF NOT EXISTS allocations(command_id TEXT PRIMARY KEY,session TEXT UNIQUE NOT NULL,signature TEXT NOT NULL,state TEXT NOT NULL,request TEXT NOT NULL,marker TEXT NOT NULL,result TEXT,identity TEXT);
   UPDATE allocations SET state='unknown' WHERE state IN ('reserved','allocated','dispatching');`);if(!this.db.prepare('PRAGMA table_info(allocations)').all().some(row=>row.name==='copy_source'))this.db.exec('ALTER TABLE allocations ADD COLUMN copy_source TEXT');}catch(error){this.db?.close();this.lease.close();throw error;}
 }
 validate(input:ManagedSessionCreate){
  if(!input||Object.keys(input).some(k=>!['session','commandId','provider','title','bundle','bundleRevision','selection'].includes(k))||typeof input.session!=='string'||!input.session.startsWith('ahp-session:/')||!uuid.test(input.session.slice(13))||typeof input.commandId!=='string'||!input.commandId||input.commandId.length>200||typeof input.provider!=='string'||!input.provider||input.provider.length>200)throw fault('Exact managed creation identity and configured provider required');
  if(input.title!==undefined&&(typeof input.title!=='string'||input.title.length>200))throw fault('Managed title exceeds200 characters');
  if(input.bundle!==undefined&&(typeof input.bundle!=='string'||!input.bundle||input.bundle.length>200||typeof input.bundleRevision!=='string'||!/^[a-f0-9]{64}$/.test(input.bundleRevision))||input.bundle===undefined&&input.bundleRevision!==undefined)throw fault('Initial bundle requires a configured alias and exact revision');
  const s=input.selection;if(s!==undefined&&(typeof s!=='object'||!s||Array.isArray(s)||Object.keys(s).some(k=>!['instance','model','effort'].includes(k))||typeof s.instance!=='string'||!s.instance.trim()||s.instance.length>200||typeof s.model!=='string'||!s.model.trim()||s.model.length>500||s.effort!==undefined&&(typeof s.effort!=='string'||!s.effort||s.effort.length>100)))throw fault('Initial provider/model selection must be complete and typed');
 }
 receipt(commandId:string):Json|null {if(typeof commandId!=='string'||!commandId||commandId.length>200)throw fault('Bounded managed creation command ID required');const row=this.db.prepare('SELECT * FROM allocations WHERE command_id=?').get(commandId);return row?{commandId,session:row.session,signature:row.signature,state:row.state,request:JSON.parse(String(row.request)),marker:JSON.parse(String(row.marker)),result:row.result?JSON.parse(String(row.result)):null,identity:row.identity?JSON.parse(String(row.identity)):null,copySource:row.copy_source?JSON.parse(String(row.copy_source)):null}:null;}
 bySession(session:string):Json|null {const row=this.db.prepare('SELECT command_id FROM allocations WHERE session=?').get(session);return row?this.receipt(String(row.command_id)):null;}
 reserve(input:ManagedSessionCreate,copySource?:Json){this.validate(input);const prior=this.receipt(input.commandId),signature=managedHash(copySource?[input,copySource]:input);if(prior){if(prior.signature!==signature)throw fault('Managed creation command conflicts with its original request');return prior;}
  if(this.bySession(input.session))throw fault('Managed allocation identity already belongs to another creation');
  const id=input.session.slice(13),workspace=join(this.root,'chats',id,'files'),body={version:1,id,workspace,creationReceipt:input.commandId,owner:'amplifier-unified'},marker={...body,allocationHash:managedHash(body)};
  this.db.prepare('INSERT INTO allocations(command_id,session,signature,state,request,marker,result,copy_source) VALUES(?,?,?,?,?,?,NULL,?)').run(input.commandId,input.session,signature,'reserved',JSON.stringify(input),JSON.stringify(marker),copySource?JSON.stringify(copySource):null);return this.receipt(input.commandId)!;
 }
 settle(commandId:string,state:string,result?:Json){this.db.prepare('UPDATE allocations SET state=?,result=coalesce(?,result) WHERE command_id=?').run(state,result?JSON.stringify(result):null,commandId);}
 location(receipt:Json):ManagedLocation {const marker=receipt.marker;return {version:1,kind:'managed',allocationId:marker.id,creationReceipt:receipt.commandId,allocationHash:marker.allocationHash,owner:'amplifier-unified'};}
 async inspect(receipt:Json){const {marker}=receipt,files=marker.workspace;
  const rootStat=await lstat(this.root,{bigint:true});if(String(rootStat.dev)!==this.rootIdentity.dev||String(rootStat.ino)!==this.rootIdentity.ino)throw fault('Managed allocation root changed; owner inspection required');
  const saved=this.receipt(receipt.commandId)?.identity;
  for(const part of [this.root,join(this.root,'chats'),dirname(files),files]){const s=await lstat(part,{bigint:true});if(saved?.[part]&&(saved[part].dev!==String(s.dev)||saved[part].ino!==String(s.ino)))throw fault('Managed allocation directory identity changed');if(!s.isDirectory()||s.isSymbolicLink()||await realpath(part)!==part)throw fault('Managed allocation path was replaced; original files preserved');}
  const handle=await open(join(dirname(files),'managed-chat.json'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const before=await handle.stat({bigint:true});if(!before.isFile()||before.nlink!==1n||before.size>4096n)throw fault('Managed allocation marker is not a bounded private file');const data=await handle.readFile('utf8'),after=await handle.stat({bigint:true});if(before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs||before.size!==after.size||managedHash(JSON.parse(data))!==managedHash(marker))throw fault('Managed allocation marker differs from its durable owner record');}finally{await handle.close();}
  return files as string;
 }
 async allocate(receipt:Json){const files=receipt.marker.workspace,chats=join(this.root,'chats'),directory=dirname(files);await mkdir(chats,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});const parent=await lstat(chats);if(!parent.isDirectory()||parent.isSymbolicLink())throw fault('Managed chats boundary is not owned');
  // Existing directories are never adopted on a new reservation, even if empty.
  await mkdir(directory,{mode:0o700});const handle=await open(join(directory,'managed-chat.json'),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{await handle.writeFile(JSON.stringify(receipt.marker));await handle.sync();}finally{await handle.close();}
  await mkdir(files,{mode:0o700});for(const part of [directory,chats]){const fd=await open(part,constants.O_RDONLY|constants.O_DIRECTORY);try{await fd.sync();}finally{await fd.close();}}
  const identity:Json={};for(const part of [this.root,chats,directory,files]){const st=await lstat(part,{bigint:true});identity[part]={dev:String(st.dev),ino:String(st.ino)};}this.db.prepare('UPDATE allocations SET identity=? WHERE command_id=?').run(JSON.stringify(identity),receipt.commandId);
  await this.inspect(receipt);this.settle(receipt.commandId,'allocated');return files;
 }
 close(){this.db.close();this.lease.close();}
}
