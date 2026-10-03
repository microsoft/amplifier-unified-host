// Independent passive receipt fixture. Any attempt to mount/execute is an error.
import {readFileSync,appendFileSync} from 'node:fs';import {createInterface} from 'node:readline';
for await(const line of createInterface({input:process.stdin})){
 const m=JSON.parse(line),p=m.params??{};const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,...value})+'\n');
 appendFileSync(process.env.IMPORT_CALLS,JSON.stringify({method:m.method,operation:p.operation})+'\n');
 if(m.method==='initialize')send({result:{protocolVersion:1,agentCapabilities:{_meta:{'amplifier.dev/native':{version:1,...(process.env.IMPORT_UNSUPPORTED?{}:{admin:{historyImport:{version:1,staged:true,maxBytes:1048576,chunkBytes:16384}}})}}},authMethods:[]}});
 else if(m.method==='_amplifier/admin'&&p.operation==='history.import.receipt'){const r=JSON.parse(readFileSync(process.env.IMPORT_RECEIPTS,'utf8'));send({result:r[p.args.commandId]??null});}
 else send({error:{code:-32601,message:'Passive fixture never mounts or executes'}});
}
