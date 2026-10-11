import {createHash} from 'node:crypto';
import {isAbsolute,resolve} from 'node:path';
type Json=Record<string,any>;
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Join metadata only. Native owns its complete indexed and unindexed family. */
export function historyCleanupCensus(census:Json,engineId:string,index:Json,local:Json[]){
 if(census?.version!==1||!Array.isArray(census.sessions)||!census.sessions.length||census.sessions.length>1000||!/^[a-f0-9]{64}$/.test(census.revision)||typeof census.workspace!=='string'||!isAbsolute(census.workspace)||resolve(census.workspace)!==census.workspace||index?.version!==1||index.coverage!=='indexed-metadata-only'||index.transcriptBodiesRead!==false||index.externalWriterCoverage!==false||!Array.isArray(index.items)||index.items.length>10000||local.length>10000)throw Error('Complete bounded shared-history census required');
 const selected=new Set<string>();
 for(const row of census.sessions){if(typeof row.nativeSessionId!=='string'||!row.nativeSessionId||row.cwd!==census.workspace||selected.has(row.nativeSessionId))throw Error('Invalid Native history family');selected.add(row.nativeSessionId);}
 const all=new Map<string,Json>();
 for(const row of index.items){if(typeof row.uri!=='string'||all.has(row.uri)||typeof row.workingDirectory!=='string'||typeof row.engineId!=='string')throw Error('Invalid indexed history identity');all.set(row.uri,row);}
 for(const row of local){const before=all.get(row.uri);if(before&&['engineId','nativeSessionId','workingDirectory'].some(k=>before[k]&&row[k]&&before[k]!==row[k]))throw Error('Indexed and Host history identities disagree');all.set(row.uri,{...before,...row});}
 if(all.size>10000)throw Error('Combined history census exceeds capacity');
 const sessions=[...all.values()].filter(row=>row.workingDirectory===census.workspace&&selected.has(row.nativeSessionId)).map(row=>{
  if(row.engineId!==engineId)throw Error('Selected history has another configured engine alias');
  return {session:row.uri,nativeSessionId:row.nativeSessionId,workingDirectory:row.workingDirectory,engineId:row.engineId};
 }).sort((a,b)=>a.session.localeCompare(b.session));
 if(sessions.length>1000)throw Error('Select at most 1000 indexed conversations per cleanup');
 const uris=new Set(sessions.map(row=>row.session));
 if([...all.values()].some(row=>uris.has(row.parentUri)&&!uris.has(row.uri)))throw Error('An indexed child outside the Native family protects this history');
 return {version:1,nativeRevision:census.revision,selection:census.selection,workspace:census.workspace,nativeSessionCount:census.sessions.length,sessions,revision:hash(sessions)};
}
export function completedHistoryReceipt(native:Json,selection:Json){
 const r=native?.result;
 if(native?.state!=='succeeded'||native.operation!=='maintenance.history.remove'||typeof native.commandId!=='string'||!native.commandId||r?.removed!==true||r.workspacePreserved!==true||r.stableLocksPreserved!==true||r.receiptsPreserved!==true||r.replayed!==false||r.confirmationId!==selection.nativeRevision||r.sessionCount!==selection.nativeSessionCount||JSON.stringify(r.selection)!==JSON.stringify(selection.selection)||!/^[a-f0-9]{64}$/.test(r.previewHash))throw Error('Exact completed Native history removal receipt required');
}
