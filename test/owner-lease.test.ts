import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {createHost} from '../src/host.js';
const module=process.env.HOST_PUBLIC_MODULE??new URL('../dist/index.js',import.meta.url).href;
function config(directory:string){return {stateDirectory:join(directory,'state'),allowedWorkspaceRoots:[directory],engines:[{id:'unused',command:process.execPath}],quiescence:{instanceId:'fixture-instance',dataScope:'private',requiredOwners:[],coverage:{},participants:[],verifyRelease:async()=>{throw Error('No release was requested')}}};}

test('OS lifetime lease rejects second owner before it can classify retained fence as unknown',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'host-owner-lease-'));const host=await createHost(config(directory));
 try{const admitted=await host.admitQuiescence({commandId:'held',purpose:'recovery'});assert.equal(admitted.admitted,true);await assert.rejects(createHost(config(directory)),/live owner/);assert.equal(host.inspectQuiescence().fence?.phase,'held');}
 finally{await host.close();await rm(directory,{recursive:true,force:true});}
});

test('replacement processes race after SIGKILL without sharing ownership or losing the retained fence',{timeout:15000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'host-owner-race-'));const children:ChildProcessWithoutNullStreams[]=[];
 const script=`import {createHost} from ${JSON.stringify(module)};import {createInterface} from 'node:readline';import {once} from 'node:events';const lines=createInterface({input:process.stdin});console.log(JSON.stringify({ready:true}));await once(lines,'line');let host;try{const config=${JSON.stringify(config(directory))};config.quiescence.verifyRelease=async()=>{throw Error('No release requested')};host=await createHost(config);if(process.argv[2]==='initial')await host.admitQuiescence({commandId:'crash-fence',purpose:'recovery'});console.log(JSON.stringify({owned:true,fence:host.inspectQuiescence()}));}catch(error){console.log(JSON.stringify({owned:false,error:error.message}));}await once(lines,'line');await host?.close();lines.close();`;
 // Serialize configuration only; no callback or agent startup is needed to retain the fence.
 const childScript=script;
 const start=()=>{const child=spawn(process.execPath,['--input-type=module','-e',childScript,directory,children.length?'replacement':'initial'],{stdio:'pipe'});children.push(child);let diagnostics='';child.stderr.on('data',chunk=>{diagnostics=(diagnostics+String(chunk)).slice(-8192)});const lines=createInterface({input:child.stdout});const exited=once(child,'exit');const next=()=>Promise.race([once(lines,'line'),exited.then(([code,signal])=>{throw Error(`Lease fixture exited before reply (code=${code}, signal=${signal}): ${diagnostics}`)})]);return {child,lines,next,exited,ready:next()};};
 try{
  const first=start();assert.deepEqual(JSON.parse((await first.ready)[0]),{ready:true});const initial=first.next();first.child.stdin.write('go\n');assert.equal(JSON.parse((await initial)[0]).owned,true);first.child.kill('SIGKILL');await first.exited;first.lines.close();
  const one=start(),two=start();await Promise.all([one.ready,two.ready]);const replies=[one.next(),two.next()];one.child.stdin.write('go\n');two.child.stdin.write('go\n');const results=(await Promise.all(replies)).map(row=>JSON.parse(row[0]));const owners=results.filter(row=>row.owned);assert.ok(owners.length<=1,JSON.stringify(results));if(owners.length)assert.equal(owners[0].fence.fence.phase,'unknown');for(const refused of results.filter(row=>!row.owned))assert.match(refused.error,/live owner/);
  // Nonblocking SQLite contenders may both refuse; that is a safe acquisition failure.
  // Once both lifetimes end, the next owner must acquire and retain the same unknown fence.
  one.child.stdin.write('close\n');two.child.stdin.write('close\n');await Promise.all([one.exited,two.exited]);one.lines.close();two.lines.close();
  const next=await createHost(config(directory));try{assert.equal(next.inspectQuiescence().fence?.phase,'unknown')}finally{await next.close()}
 }finally{for(const child of children)if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit')}await rm(directory,{recursive:true,force:true});}
});

test('legacy live marker refuses opening; stale marker remains evidence without unlink reclamation',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'host-legacy-marker-'));let host=await createHost(config(directory));await host.close();const marker=join(directory,'state','host.lock');
 try{await writeFile(marker,JSON.stringify({pid:process.pid,incarnation:'legacy-live'}));await assert.rejects(createHost(config(directory)),/live owner/);const stale=JSON.stringify({pid:2147483647,incarnation:'legacy-retained'});await writeFile(marker,stale);host=await createHost(config(directory));await host.close();assert.equal(await readFile(marker,'utf8'),stale);}
 finally{await rm(directory,{recursive:true,force:true});}
});
