// Independent standard ACP peer; no Host imports, model calls or credentials.
import readline from 'node:readline';
import {readFileSync} from 'node:fs';
const options=JSON.parse(readFileSync(process.argv[2],'utf8'));
const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
for await(const line of readline.createInterface({input:process.stdin})) {
  const message=JSON.parse(line),params=message.params??{};
  if(message.method==='initialize')send({id:message.id,result:{protocolVersion:1,agentInfo:{name:'configuration-fixture',version:'1'},agentCapabilities:{}}});
  else if(message.method==='session/new')send({id:message.id,result:{sessionId:'configuration-session',configOptions:options}});
  else if(message.method==='session/set_config_option') {
    const option=options.find(value=>value.id===params.configId);
    const choices=option?.options.flatMap(value=>value.options??[value])??[];
    if(!choices.some(value=>value.value===params.value))send({id:message.id,error:{code:-32602,message:'Unknown opaque option'}});
    else {
      option.currentValue=params.value;
      // The complete replacement list drops an obsolete selector and changes
      // group order/metadata without changing any opaque option identities.
      if(option.category==='model') {
        option.options.reverse();option.options[0]._meta={...option.options[0]._meta,'fixture.example/fresh':true};
        const effort=options.findIndex(value=>value.category==='thought_level');if(effort>=0)options.splice(effort,1);
      }
      send({id:message.id,result:{configOptions:options}});
      send({method:'session/update',params:{sessionId:params.sessionId,update:{sessionUpdate:'config_option_update',configOptions:options}}});
    }
  }
}
