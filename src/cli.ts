#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createHost, type HostConfig } from './host.js';
import { StdioCatalog, type CatalogProcessConfig } from './catalog.js';

const path=process.argv[process.argv.indexOf('--config')+1];
if(!process.argv.includes('--config')||!path)throw new Error('Usage: amplifier-unified-host --config /absolute/host.json');
const config:HostConfig&{catalogProcess?:CatalogProcessConfig}=JSON.parse(await readFile(path,'utf8'));
const host=await createHost({...config,port:config.port??8765,catalog:config.catalogProcess?new StdioCatalog(config.catalogProcess):undefined});
process.stdout.write(JSON.stringify({url:host.url,protocol:'0.9.0',pid:process.pid})+'\n');
let stopping=false;
async function stop(){if(stopping)return;stopping=true;await host.close();process.exit(0);}
process.once('SIGINT',()=>void stop());process.once('SIGTERM',()=>void stop());
