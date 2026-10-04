import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {fileURLToPath,pathToFileURL} from 'node:url';
import {StdioCatalog as SourceCatalog} from '../src/catalog.js';
const python=process.env.PRESENTATION_CATALOG_PYTHON;
const {StdioCatalog}=process.env.HOST_PACKAGE?await import(pathToFileURL(process.env.HOST_PACKAGE).href):{StdioCatalog:SourceCatalog};
test('owned catalog hint timeout joins actual process exit before settled-failure proof',{skip:!python,timeout:20000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'catalog-timeout-')),home=join(dir,'native'),entered=join(dir,'entered'),late=join(dir,'late');await mkdir(home);
 const catalog=new StdioCatalog({command:python!,args:['-I',fileURLToPath(new URL('../fixtures/catalog-late-hint.py',import.meta.url)),'serve','--db',join(dir,'catalog.sqlite'),'--home',home,'--scan-interval','0','--workspace-check-interval','0'],env:{HINT_ENTERED:entered,HINT_LATE:late}});
 try{
  await assert.rejects(catalog.hint(home),(error:any)=>{assert.match(error.message,/timed out/);assert.equal(error.catalogDiscoverySettled,true);return true;});
  assert.equal(await readFile(entered,'utf8'),'entered');assert.equal(catalog.diagnostics().closed,true);assert.equal(catalog.diagnostics().pending,0);await assert.rejects(readFile(late));
  await assert.rejects(catalog.request('status',{}),/unavailable/);
 }finally{await catalog.close();await rm(dir,{recursive:true,force:true});}
});

test('actual catalog rejected hint proves response settlement without closing the healthy owner',{skip:!python},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'catalog-refusal-')),home=join(dir,'native');await mkdir(home);
 const catalog=new StdioCatalog({command:python!,args:['-I','-m','amplifier_session_catalog','serve','--db',join(dir,'catalog.sqlite'),'--home',home,'--scan-interval','0','--workspace-check-interval','0']});
 try{await assert.rejects(catalog.hint(join(dir,'outside')),(error:any)=>error.catalogDiscoverySettled===true);assert.equal(catalog.diagnostics().closed,false,JSON.stringify(catalog.diagnostics()));assert.ok(await catalog.status());}finally{await catalog.close();await rm(dir,{recursive:true,force:true});}
});

test('selected-family timeout joins actual writer exit before reconstruction may settle',{skip:!python,timeout:20000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'family-timeout-')),home=join(dir,'native'),entered=join(dir,'entered'),late=join(dir,'late');await mkdir(home);
 const catalog=new StdioCatalog({command:python!,args:['-I','-B',fileURLToPath(new URL('../fixtures/catalog-late-family.py',import.meta.url)),'serve','--db',join(dir,'catalog.sqlite'),'--home',home,'--scan-interval','0','--workspace-check-interval','0'],env:{HINT_ENTERED:entered,HINT_LATE:late}});
 try{
  await assert.rejects(catalog.reconcileFamily({parentUri:'ahp-session:/root',limit:100,maxEntries:512}),(error:any)=>{assert.match(error.message,/timed out/);assert.equal(error.catalogDiscoverySettled,true);return true;});
  assert.equal(await readFile(entered,'utf8'),'entered');assert.equal(catalog.diagnostics().closed,true);assert.equal(catalog.diagnostics().pending,0);await assert.rejects(readFile(late));
 }finally{await catalog.close();await rm(dir,{recursive:true,force:true});}
});
