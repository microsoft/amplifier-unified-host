#!/usr/bin/env node
// Public package smoke server. Echo fixture only: no native model or account calls.
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHost} from '../dist/index.js';
const [workspace,stateDirectory,port='8765']=process.argv.slice(2);
if(!workspace||!stateDirectory)throw new Error('Usage: node examples/offline-host.mjs WORKSPACE PRIVATE_STATE_DIRECTORY [PORT]');
const host=await createHost({stateDirectory:resolve(stateDirectory),allowedWorkspaceRoots:[resolve(workspace)],port:Number(port),allowedOrigins:['http://127.0.0.1:5173','http://127.0.0.1:5179'],engines:[{id:'offline-fixture',label:'Offline protocol fixture',command:process.execPath,args:[fileURLToPath(new URL('../fixtures/acp-peer.mjs',import.meta.url))],env:{FIXTURE_LOG:join(resolve(stateDirectory),'fixture-prompts.jsonl')}}]});
console.log(host.url);
let closing=false;
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{if(closing)return;closing=true;await host.close();process.exit(0);});
