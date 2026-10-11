import {createHash} from 'node:crypto';
import {isAbsolute,resolve} from 'node:path';
type Json=Record<string,any>;
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function workspaceCleanupCensus(target:string,engineId:string,index:Json,local:Json[]){
 if(!isAbsolute(target)||resolve(target)!==target||index?.version!==1||index.coverage!=='indexed-metadata-only'||index.transcriptBodiesRead!==false||index.externalWriterCoverage!==false||!Array.isArray(index.items)||index.items.length>10000||local.length>10000)throw Error('Complete bounded workspace identity census required');
 const all=new Map<string,Json>();
 for(const row of index.items){
  if(typeof row.uri!=='string'||all.has(row.uri)||typeof row.workingDirectory!=='string'||!isAbsolute(row.workingDirectory)||typeof row.engineId!=='string')throw Error('Invalid indexed workspace identity');
  all.set(row.uri,{...row,executionDirectory:row.workingDirectory});
 }
 for(const row of local){
  const previous=all.get(row.uri);
  if(previous&&['engineId','nativeSessionId','workingDirectory'].some(key=>previous[key]&&row[key]&&previous[key]!==row[key]))throw Error('Indexed and Host workspace identities disagree');
  all.set(row.uri,{...previous,...row});
 }
 if(all.size>10000)throw Error('Combined workspace census exceeds capacity');
 const sessions:Json[]=[],archiveSessions:string[]=[],protectedPaths=new Set<string>();
 const rows=[...all.values()].sort((a,b)=>a.uri.localeCompare(b.uri));
 for(const row of rows){
  const selected=row.executionDirectory===target||row.workingDirectory===target;
  if(row.storagePath)protectedPaths.add(row.storagePath);
  for(const path of [row.workingDirectory,row.executionDirectory])if(path&&path!==target)protectedPaths.add(path);
  if(!selected)continue;
  if(row.engineId!==engineId||!row.nativeSessionId)throw Error('Every selected chat needs the configured native history owner');
  sessions.push({nativeSessionId:row.nativeSessionId,cwd:row.workingDirectory});
  if(!row.parentUri&&(!row.kind||['root','session'].includes(row.kind)))archiveSessions.push(row.uri);
 }
 const unique=[...new Map(sessions.map(row=>[JSON.stringify(row),row])).values()];
 return {version:1,coverage:'indexed-and-host-identities',revision:hash(rows),sessions:unique,archiveSessions,protectedPaths:[...protectedPaths].sort()};
}

export function completedCleanupReceipt(native:Json,workspaceId:string){
 const result=native?.result;
 if(native?.state!=='succeeded'||native.operation!=='maintenance.workspace.remove'||typeof native.commandId!=='string'||!native.commandId||result?.workspaceId!==workspaceId||result.removed!==true||result.historyPreserved!==true||result.canonicalFilesChanged!==0||result.replayed!==false)throw Error('Exact successful native workspace-removal receipt required');
}
