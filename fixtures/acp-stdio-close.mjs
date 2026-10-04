import {createInterface} from 'node:readline';
import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const marker=process.env.FIXTURE_STDIO_MARKER;
const release=process.env.FIXTURE_STDIO_RELEASE;
let retainer;
function retain(){
 if(retainer)return;
 retainer=spawn(process.execPath,['-e',"const fs=require('node:fs');const stop=()=>{if(fs.existsSync(process.argv[1]))process.exit(0);};setInterval(stop,10);setTimeout(()=>process.exit(0),8000);",release],{detached:true,stdio:['ignore',process.stdout,process.stderr]});retainer.unref();
 writeFileSync(marker,JSON.stringify({retainerPid:retainer.pid,parentPid:process.pid}));
}
if(process.env.FIXTURE_PARENT_MODE==='force')process.on('SIGTERM',()=>{});
const reply=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');
createInterface({input:process.stdin}).on('line',line=>{
 const p=JSON.parse(line);if(p.id===undefined)return;
 if(p.method==='initialize')reply(p.id,{protocolVersion:1,agentCapabilities:{loadSession:false,sessionCapabilities:{close:false},_meta:{'amplifier.dev/native':{version:1,lifecycle:{version:1,gracefulRetire:true}}}}});
 else if(p.method==='session/new'){retain();reply(p.id,{sessionId:'stdio-owned'});if(process.env.FIXTURE_PARENT_MODE==='natural')setTimeout(()=>process.exit(0),20);}
 else if(p.method==='_amplifier/retire')reply(p.id,{retired:true});
 else reply(p.id,{});
});
