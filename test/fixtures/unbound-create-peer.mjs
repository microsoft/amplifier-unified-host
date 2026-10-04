// Standalone ACP peer: an uncorrelated possible checkpoint is not a creation receipt.
import readline from 'node:readline';
import {appendFileSync,writeFileSync} from 'node:fs';
const send=message=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...message})+'\n');
for await(const line of readline.createInterface({input:process.stdin})){
 const message=JSON.parse(line);
 if(message.method==='initialize')send({id:message.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[]}});
 else if(message.method==='session/new'){
  appendFileSync(process.env.FIXTURE_CALLS,'session/new\n');
  writeFileSync(process.env.FIXTURE_CHECKPOINT,JSON.stringify({session_id:'uncorrelated-native-checkpoint',working_dir:message.params.cwd}));
  send({id:message.id,error:{code:-32603,message:'Creation failed after possible checkpoint'}});
 }else if(message.id!==undefined){appendFileSync(process.env.FIXTURE_CALLS,message.method+'\n');send({id:message.id,error:{code:-32601,message:'No other work is implemented'}});}
}
