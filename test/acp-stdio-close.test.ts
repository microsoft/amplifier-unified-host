import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHost} from '../src/index.js';
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(predicate:()=>boolean){for(let n=0;n<400;n++){if(predicate())return;await delay(5);}throw Error('Fixture state unavailable');}
for(const mode of ['natural','force'])test('Host storage survives parent exit until ACP stdio and stopped callback close: '+mode,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'host-acp-stdio-')),marker=join(dir,'stdio-owner'),release=join(dir,'stdio-release');let stopJoined=false;
 const host=await createHost({stateDirectory:join(dir,'host'),allowedWorkspaceRoots:[dir],engines:[{id:'fixture',command:process.execPath,args:[fileURLToPath(new URL('../fixtures/acp-stdio-close.mjs',import.meta.url))],env:{FIXTURE_STDIO_MARKER:marker,FIXTURE_STDIO_RELEASE:release,FIXTURE_PARENT_MODE:mode}}],
  agentStopped:async()=>{await delay(20);host.store.db.prepare('SELECT count(*) FROM steering_intents').get();stopJoined=true;}});
 let closing:Promise<void>|undefined,closed=false;
 try{
  const session='ahp-session:/'+randomUUID();await host.createSessionResource({channel:session,provider:'fixture',workingDirectories:[pathToFileURL(dir).href]});
  const agent=(host as any).active.get(session).agent;
  await until(()=>!!agent.nativeId);await readFile(marker);
  const actualClose=new Promise<void>(resolve=>agent.process.once('close',resolve));
  if(mode==='natural')await until(()=>agent.process.exitCode===0);
  closing=host.close().then(()=>{closed=true;});
  await delay(mode==='natural'?100:1200);
  assert.equal(closed,false,'Database closed before ACP stdio and stop callback');
  await writeFile(release,'release');await closing;await actualClose;
  assert.equal(stopJoined,true);assert.equal(agent.closed,true);
 }finally{await writeFile(release,'release');await (closing??host.close());await delay(50);await rm(dir,{recursive:true,force:true});}
});
