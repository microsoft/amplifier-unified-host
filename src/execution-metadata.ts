/** Bounded presentation only. This header supplies no worker-control authority. */
export function toolExecutionMetadata(meta:unknown):Record<string,unknown> {
 const value=(meta as any)?.['amplifier.dev/execution'];
 if(!value||value.version!==1||Buffer.byteLength(JSON.stringify(value))>8192)return {};
 const text=(v:unknown)=>typeof v==='string'&&v.length>0&&v.length<=512;
 const result:Record<string,unknown>={version:1};
 for(const key of ['sessionId','parentId'])if(text(value[key]))result[key]=value[key];
 for(const key of ['startedAt','endedAt'])if(Number.isFinite(value[key]))result[key]=value[key];
 const owner=value.delegate;
 if(owner&&text(owner.id)&&text(owner.sessionId)&&owner.sessionId===result.sessionId){
  const header:Record<string,unknown>={id:owner.id,sessionId:owner.sessionId};
  for(const key of ['label','provider','model','phase','parentProvider','runId','workerId'])if(text(owner[key]))header[key]=owner[key];
  // Reuse the existing routing vocabulary, never arbitrary instruction bodies.
  if(owner.routing&&typeof owner.routing==='object'&&!Array.isArray(owner.routing)){
   const routing:Record<string,unknown>={};
   for(const key of ['selectionSource','modelInheritance','matrixSource','resolverName'])if(text(owner.routing[key]))routing[key]=owner.routing[key];
   if(typeof owner.routing.resolverActive==='boolean')routing.resolverActive=owner.routing.resolverActive;
   if(Object.keys(routing).length)header.routing=routing;
  }
  result.delegate=header;
 }
 return {'amplifier.dev/execution':result};
}
