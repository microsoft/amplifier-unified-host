import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
const native='amplifier.dev/native',log=value=>{if(process.env.SELECTION_LOG)appendFileSync(process.env.SELECTION_LOG,JSON.stringify(value)+'\n');};
const managed={version:1,passive:true,typedSelection:true,configurationScope:'global-and-session',defaults:{version:1},models:{version:1}};
let selection;
for await(const line of createInterface({input:process.stdin})){
 const request=JSON.parse(line),p=request.params??{};let result={};
 if(request.method==='initialize')result={protocolVersion:1,agentCapabilities:{loadSession:true,_meta:{[native]:{version:1,managedCreation:managed,...(process.env.NO_SELECTION?{}:{initialSelection:{version:1,typedSelection:true,passive:true,resolveMethod:'_amplifier/initial-selection'}})}}}};
 else if(request.method==='_amplifier/initial-selection'){
  const config=p.selection??{},model=config.model??'first-model',efforts=model==='second-model'?['low']:model==='no-effort'?[]:['low','high'];
  if(config.instance!==undefined&&config.instance!=='configured'||!['first-model','second-model','no-effort'].includes(model)||config.effort!==undefined&&!efforts.includes(config.effort)){
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32602,message:'Invalid fixture selection',data:{executed:false,runtimeStarted:false}}})+'\n');continue;
  }
  const schema={type:'object',properties:{instance:{type:'string',enum:['configured']},model:{type:'string',enum:['first-model','second-model','no-effort']},...(efforts.length?{effort:{type:'string',enum:efforts}}:{})},required:['instance','model']};
  const values={instance:'configured',model,...(efforts.length?{effort:config.effort??efforts.at(-1)}:{})};
  if(process.env.BAD_RESOLUTION)values.model='first-model';
  if(process.env.NO_DEFAULT_MODEL)delete values.model;
  result={version:1,schema,values};log({method:request.method,cwd:p.cwd,selection:p.selection});
 }else if(request.method==='session/new'){
  selection=p._meta?.[native]?.selection;log({method:request.method,selection});
  result={sessionId:'selection-fixture',_meta:{[native]:{initialSelection:{version:1,selection:process.env.BAD_PROOF?{...selection,effort:'high'}:selection}}}};
 }else if(request.method==='session/prompt'){log({method:request.method,selection,prompt:p.prompt});result={stopReason:'end_turn'};}
 else if(request.method==='session/load'||request.method==='session/cancel')result={};
 else{process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Unknown fixture method'}})+'\n');continue;}
 if(request.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
}
