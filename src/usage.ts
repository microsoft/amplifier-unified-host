import type {DatabaseSync} from 'node:sqlite';

type Json=Record<string,any>;
const live=new Set(['running','working','starting','queued','retrying','pending']);
const metrics=['inputTokens','outputTokens','totalTokens','grossInputTokens','grossTotalTokens','reasoningTokens','cacheReadTokens','cacheWriteTokens','costUsd'];
const number=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const key=(call:Json)=>JSON.stringify([call.sessionId,call.id]);
const text=(value:unknown,max=200):value is string=>typeof value==='string'&&!!value&&value.length<=max;
export function capacityPolicy(value:Json):Json {
 if(!value||typeof value!=='object'||Array.isArray(value)||!Number.isSafeInteger(value.revision)||value.revision<0||typeof value.enabled!=='boolean')throw Error('Saved budget policy is invalid; no budget was silently disabled');
 const policy={revision:value.revision,enabled:value.enabled,maxTotalTokens:value.maxTotalTokens??null,maxCostUsd:value.maxCostUsd??null,warningFraction:value.warningFraction??.8,unknownPolicy:value.unknownPolicy??'pause',includeEstimatedCost:value.includeEstimatedCost??false,...(value.lastDenial?{lastDenial:value.lastDenial}:{})};
 if(!number(policy.warningFraction)||policy.warningFraction<=0||policy.warningFraction>1||!['pause','allow'].includes(policy.unknownPolicy)||typeof policy.includeEstimatedCost!=='boolean'||['maxTotalTokens','maxCostUsd'].some(key=>policy[key as keyof typeof policy]!==null&&(!number(policy[key as keyof typeof policy])||Number(policy[key as keyof typeof policy])<=0))||policy.maxTotalTokens!==null&&!Number.isSafeInteger(policy.maxTotalTokens)||policy.enabled&&policy.maxTotalTokens===null&&policy.maxCostUsd===null)throw Error('Saved budget limits are invalid');
 if(policy.lastDenial&&(!Array.isArray(policy.lastDenial.reasons)||policy.lastDenial.reasons.length>16||policy.lastDenial.reasons.some((reason:unknown)=>!text(reason,1000))||policy.lastDenial.budgetRevision!==policy.revision))throw Error('Saved budget denial is invalid');
 return {...policy,...(policy.lastDenial?{lastDenial:{budgetRevision:policy.revision,reasons:[...policy.lastDenial.reasons]}}:{})};
}
function gross(value:Json={}) {
 const result:Json={};for(const key of metrics)if(!key.startsWith('gross')&&number(value[key]))result[key]=value[key];
 const writes=value.cacheWriteTokens??0;
 if(number(writes)){if(number(result.inputTokens)){result.grossInputTokens=result.inputTokens+writes;if(number(result.outputTokens))result.grossTotalTokens=result.grossInputTokens+result.outputTokens;}if(result.grossTotalTokens===undefined&&number(result.totalTokens))result.grossTotalTokens=result.totalTokens+writes;}
 if(result.costUsd!==undefined)result.costType=value.costType==='estimated'?'estimated':'reported';
 return result;
}
function accumulator(){return Object.fromEntries(metrics.map(key=>[key,{value:null,unit:key==='costUsd'?'USD':'tokens',knownCalls:0,pendingCalls:0,unknownCalls:0,status:'empty',...(key==='costUsd'?{estimatedValue:0,estimatedCalls:0}:{})}])) as Json;}
function add(totals:Json,row:Json){for(const key of metrics){const metric=totals[key],value=row.usage?.[key];if(number(value)){metric.value=(metric.value??0)+value;metric.knownCalls++;if(key==='costUsd'&&row.usage.costType==='estimated'){metric.estimatedValue+=value;metric.estimatedCalls++;}}else if(live.has(row.phase)&&!row.endedAt)metric.pendingCalls++;else metric.unknownCalls++;const n=metric.knownCalls+metric.pendingCalls+metric.unknownCalls;metric.status=!n?'empty':metric.knownCalls===n?'known':metric.pendingCalls===n?'pending':!metric.knownCalls?'unknown':'partial';}}
export function evaluateCapacity(policy:Json,usage:Json):Json {
 const reasons:string[]=[],warnings:string[]=[];
 for(const [metric,key,label] of [['grossTotalTokens','maxTotalTokens','Total tokens (including cache writes)'],['costUsd','maxCostUsd','Cost (USD)']]){
  const limit=policy[key];if(!policy.enabled||limit==null)continue;
  const row=usage.metrics[metric];let value=row.value??0,uncertain=row.unknownCalls;
  if(metric==='costUsd'&&!policy.includeEstimatedCost){value-=row.estimatedValue;uncertain+=row.estimatedCalls;}
  if(value>=limit)reasons.push(`${label} limit reached (${value} of ${limit})`);else if(value>=limit*policy.warningFraction)warnings.push(`${label} approaching limit (${value} of ${limit})`);
  if(uncertain&&policy.unknownPolicy==='pause')reasons.push(`${label} is unknown for ${uncertain} settled call(s)`);
 }
 if(policy.enabled)for(const reason of policy.lastDenial?.reasons??[])if(!reasons.includes(reason))reasons.push(reason);
 return {allowed:!reasons.length,state:reasons.length?'paused':warnings.length?'warning':policy.enabled?'active':'disabled',reasons,warnings,inFlightCalls:usage.inFlightCalls,enforcement:'before each supported model call; existing calls and effects may finish and exceed the limit'};
}

/** Host-owned scalar receipts. Never stores prompts, responses or budget policy. */
export class UsageReceipts {
 constructor(private db:DatabaseSync){}
 observe(session:string,native:string,input:Json):boolean {
  if(input.kind!=='llm'||input.rootSessionId!==native)return false;
  if(!text(input.id)||!text(input.sessionId,512)||!Number.isSafeInteger(input.revision??0)||(input.revision??0)<0||!text(input.phase,40)||input.producerId!==undefined&&!text(input.producerId))throw Error('Invalid model-call accounting identity');
  const old=this.db.prepare('SELECT payload FROM model_usage WHERE session=? AND call_id=?').get(session,key(input));
  const prior=old?JSON.parse(String(old.payload)):undefined;
  if(prior&&(prior.sessionId!==input.sessionId||prior.producerId&&input.producerId&&prior.producerId!==input.producerId))throw Error('Model-call accounting identity changed');
  if(prior&&((input.revision??0)<prior.revision||(input.revision??0)===prior.revision&&(!input.endedAt||prior.endedAt)))return false;
  const row:Json={id:input.id,sessionId:input.sessionId,revision:input.revision??0,phase:input.phase,usage:gross(input.usage)};
  for(const key of ['producerId','provider','model','lifecycle'])if(text(input[key],200))row[key]=input[key];
  for(const key of ['startedAt','endedAt','admittedAt','budgetRevision'])if(number(input[key]))row[key]=input[key];
  // Later partial lifecycle publications cannot erase already measured buckets.
  if(prior?.usage)row.usage=gross({...prior.usage,...row.usage});
  if(prior?.admittedAt!==undefined){row.admittedAt=prior.admittedAt;row.budgetRevision=prior.budgetRevision;}
  if((prior?.endedAt||prior?.interrupted)&&live.has(row.phase))return false;
  this.db.prepare('INSERT INTO model_usage(session,call_id,payload) VALUES(?,?,?) ON CONFLICT(session,call_id) DO UPDATE SET payload=excluded.payload').run(session,key(row),JSON.stringify(row));return true;
 }
 observeTurn(session:string,native:string,turn:Json){for(const part of turn.responseParts??[]){const row=part?._meta?.['amplifier.dev/modelCall'];if(row)this.observe(session,native,row);}}
 backfill(){
  if(this.db.prepare("SELECT 1 FROM meta WHERE key='model_usage_backfilled'").get())return;
  // The retained call IDs make this migration idempotent. Include edited-away
  // turns, since editing history does not refund the calls already performed.
  for(const table of ['turns','history_edit_archives'])for(const value of this.db.prepare(`SELECT s.uri,s.native_id,t.payload FROM ${table} t JOIN sessions s ON s.chat_uri=t.chat WHERE s.native_id IS NOT NULL`).iterate())this.observeTurn(String(value.uri),String(value.native_id),JSON.parse(String(value.payload)));
  for(const value of this.db.prepare('SELECT uri,native_id,chat FROM sessions WHERE native_id IS NOT NULL').iterate()){const active=JSON.parse(String(value.chat)).activeTurn;if(active)this.observeTurn(String(value.uri),String(value.native_id),active);}
  for(const value of this.db.prepare('SELECT s.uri,s.native_id,e.action FROM active_events e JOIN sessions s ON s.chat_uri=e.channel WHERE s.native_id IS NOT NULL').iterate()){const action=JSON.parse(String(value.action));if(action.part)this.observeTurn(String(value.uri),String(value.native_id),{responseParts:[action.part]});}
  this.db.prepare("INSERT INTO meta(key,value) VALUES('model_usage_backfilled',1)").run();
 }
 interrupted(session?:string,exceptProducer?:string){
  const where=session?'WHERE session=?':'',rows=this.db.prepare('SELECT session,call_id,payload FROM model_usage '+where).iterate(...(session?[session]:[]));
  for(const item of rows){const row=JSON.parse(String(item.payload));if(live.has(row.phase)&&!row.endedAt&&(!exceptProducer||row.producerId!==exceptProducer)){row.phase='outcome_unknown';row.interrupted=true;this.db.prepare('UPDATE model_usage SET payload=? WHERE session=? AND call_id=?').run(JSON.stringify(row),item.session!,item.call_id!);}}
 }
 snapshot(session:string,{offset=0,limit=100}:{offset?:number;limit?:number}={}):Json {
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>500)throw Error('Usage receipt page is out of bounds');
  const totals=accumulator(),groups=new Map<string,Json>(),receipts:Json[]=[];let calls=0,inFlightCalls=0,omittedGroups=false;
  for(const value of this.db.prepare('SELECT payload FROM model_usage WHERE session=? ORDER BY rowid').iterate(session)){
   const row=JSON.parse(String(value.payload));row.usage=gross(row.usage);add(totals,row);if(live.has(row.phase)&&!row.endedAt)inFlightCalls++;
   if(calls>=offset&&receipts.length<limit)receipts.push(row);calls++;
   const provider=row.provider??'unknown',model=row.model??'unknown',key=JSON.stringify([provider,model]);
   if(!groups.has(key)&&groups.size<100)groups.set(key,{provider,model,calls:0,metrics:accumulator()});
   const group=groups.get(key);if(group){group.calls++;add(group.metrics,row);}else omittedGroups=true;
  }
  return {scope:'root and observed descendants',sessionId:session,source:'durable host model-call receipts',calls,inFlightCalls,metrics:totals,providers:[...groups.values()],omittedGroups,receipts,receiptCount:calls,offset,nextOffset:offset+limit<calls?offset+limit:null,coverage:'observed calls only; historical calls without telemetry and provider-internal retries may be unreported'};
 }
 admit(session:string,native:string,call:Json,budget:Json):Json {
  const policy=capacityPolicy(budget);
  if(call?.kind!=='llm'||call.rootSessionId!==native||!text(call.id)||!text(call.producerId)||!text(call.sessionId,512)||call.phase!=='running'||call.endedAt!==undefined||call.usage!==undefined)throw Error('Budget admission requires one new call from the owned native root');
  this.interrupted(session,call.producerId);
  if(this.db.prepare('SELECT 1 FROM model_usage WHERE session=? AND call_id=?').get(session,key(call)))return {allowed:false,state:'paused',budgetRevision:policy.revision,reasons:['This model-call ID was already observed; its outcome must not be replayed']};
  const result:Json={...evaluateCapacity(policy,this.snapshot(session)),budgetRevision:policy.revision};
  if(result.allowed){const admittedAt=Date.now()/1000;this.observe(session,native,{...call,revision:0,budgetRevision:policy.revision,admittedAt});return {...result,admittedAt};}
  return result;
 }
}
