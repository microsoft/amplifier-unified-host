/** Preserve standard ACP plan snapshots in an AHP presentation part.
 * This is read-only projection metadata, not a user input or executable action.
 */
export function planPart(update: any) {
  let unavailable = update._meta?.['amplifier.dev/todo']?.unavailable === true;
  let size = 0;
  const entries: {content: string; status: string; priority: string; activeForm?: string}[] = [];
  if (!Array.isArray(update.entries) || update.entries.length > 200) unavailable = true;
  else for (const item of update.entries) {
    const activeForm = item?._meta?.['amplifier.dev/todo']?.activeForm;
    if (!item || typeof item.content !== 'string' || item.content.length > 4000 ||
      !['pending', 'in_progress', 'completed'].includes(item.status) ||
      !['low', 'medium', 'high'].includes(item.priority) ||
      (activeForm !== undefined && (typeof activeForm !== 'string' || activeForm.length > 4000))) {unavailable = true; break;}
    size += item.content.length + (activeForm?.length ?? 0);
    if (size > 16000) {unavailable = true; break;}
    entries.push({content: item.content, status: item.status, priority: item.priority, ...(activeForm ? {activeForm} : {})});
  }
  const plan = unavailable ? {version: 1, unavailable: true, entries: []} : {version: 1, entries};
  return {kind: 'systemNotification', content: unavailable ? 'Plan details unavailable.' : entries.map(e => `${e.status}: ${e.content}`).join('\n'),
    _meta: {'amplifier.dev/acp': {sessionUpdate: 'plan', plan}}};
}

/** Validate a passive native projection before exposing it to any client. */
export function checkedPlanOverview(value:any,includeItems:boolean):any {
  if(value===null)return null;
  if(!value||typeof value!=='object'||typeof value.unavailable!=='boolean'||
    !Number.isSafeInteger(value.done)||!Number.isSafeInteger(value.total)||value.done<0||value.total<value.done||value.total>200||
    !Array.isArray(value.history)||value.history.length>16)throw Error('Invalid native plan overview');
  const history=value.history.map((point:any)=>{
    if(!point||!Number.isSafeInteger(point.done)||!Number.isSafeInteger(point.total)||point.done<0||point.total<point.done||point.total>200)throw Error('Invalid recorded plan progress');
    return {done:point.done,total:point.total,...(typeof point.at==='string'&&point.at.length<=100?{at:point.at}:{})};
  });
  const result:any={unavailable:value.unavailable,done:value.done,total:value.total,history};
  if(includeItems&&!value.unavailable){
    const part=planPart({entries:value.items?.map((item:any)=>({...item,priority:'medium'}))});
    if(part._meta['amplifier.dev/acp'].plan.unavailable||part._meta['amplifier.dev/acp'].plan.entries.length!==value.total)throw Error('Invalid plan details');
    result.items=part._meta['amplifier.dev/acp'].plan.entries.map(({content,status})=>({content,status}));
    if(result.items.filter((item:any)=>item.status==='completed').length!==value.done)throw Error('Plan counts differ from details');
  }
  return result;
}

export function activePlanOverview(turn:any,base:any,includeItems:boolean):any {
  if(!turn)return base;
  let latest=base;
  for(const part of turn.responseParts??[]){
    const acp=part?._meta?.['amplifier.dev/acp'];
    if(part.kind!=='systemNotification'||acp?.sessionUpdate!=='plan')continue;
    const plan=planPart({entries:acp.plan?.entries,_meta:{'amplifier.dev/todo':{unavailable:acp.plan?.unavailable}}})._meta['amplifier.dev/acp'].plan;
    const entries=plan.entries,done=entries.filter(e=>e.status==='completed').length,total=entries.length,history=[...(latest?.history??[])];
    if(!plan.unavailable&&(history.at(-1)?.done!==done||history.at(-1)?.total!==total))history.push({done,total});
    latest={unavailable:!!plan.unavailable,done,total,history:history.slice(-16),...(includeItems&&!plan.unavailable?{items:entries.map(({content,status})=>({content,status}))}:{})};
  }
  return latest;
}
