import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {AhpClient} from '@microsoft/agent-host-protocol/client';
import {WebSocketTransport} from '@microsoft/agent-host-protocol/ws';
const {createHost}=await import(process.env.HOST_PACKAGE_URL??'../src/index.js');
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFile(path:string){for(let i=0;i<400;i++){try{return await readFile(path,'utf8');}catch{}await delay(5);}throw Error('Missing fixture marker');}

for(const mode of ['terminal-delayed','terminal-released','terminal-force-kill'])test('shutdown joins actual terminal close before closing storage: '+mode,async()=>{
 const directory=await mkdtemp(join(tmpdir(),'host-terminal-close-')),log=join(directory,'peer'),stateDirectory=join(directory,'host');
 const host=await createHost({stateDirectory,allowedWorkspaceRoots:[directory],engines:[{id:'fixture',label:'Fixture',command:process.execPath,args:[fileURLToPath(new URL('../fixtures/acp-peer.mjs',import.meta.url))],env:{FIXTURE_LOG:log}}]});
 const client=new AhpClient(await WebSocketTransport.connect(host.url));client.connect();let closing:Promise<void>|undefined,closed=false;
 try{
  await client.initialize({clientId:randomUUID(),protocolVersions:['0.9.0']});const session='ahp-session:/'+randomUUID(),commandId=randomUUID();
  await client.request('createSession',{channel:session,provider:'fixture',workingDirectories:[pathToFileURL(directory).href]});
  await host.submitTurn(session,{commandId,text:mode==='terminal-force-kill'?'terminal-delayed':mode,clientId:'owner'});await host.waitForTurn(session,commandId);await waitFile(log+'.terminal-ready');await client.shutdown();
  closing=host.close().then(()=>{closed=true;});await waitFile(log+'.terminal-stopping');
  // The terminal is deliberately still alive after its parent ACP has been
  // asked to stop. A released protocol handle must also retain this lifetime.
  await delay(100);assert.equal(closed,false,'close returned while owned terminal callbacks were pending');
  if(mode!=='terminal-force-kill')await writeFile(log+'.terminal-release','release');await closing;
  const db=new DatabaseSync(join(stateDirectory,'host.sqlite'),{readOnly:true});
  try{const rows=db.prepare('SELECT payload FROM terminals').all();assert.equal(rows.length,1);assert.equal(JSON.parse(String(rows[0].payload)).lifecycle.status,'exited');}finally{db.close();}
 }finally{await writeFile(log+'.terminal-release','release');await client.shutdown();await (closing??host.close());await rm(directory,{recursive:true,force:true});}
});
