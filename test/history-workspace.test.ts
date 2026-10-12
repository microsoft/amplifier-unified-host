import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,realpath,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {missingHistoryWorkspace} from '../src/history-workspace.js';

test('missing history keeps canonical root authority without following changed symlink ancestors',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'missing-history-')));
 try{
  assert.equal(await missingHistoryWorkspace(root,[root]),false);
  assert.equal(await missingHistoryWorkspace(join(root,'gone','child'),[root]),true);
  await mkdir(join(root,'managed'));
  await assert.rejects(missingHistoryWorkspace(join(root,'managed','gone'),[root],join(root,'managed')),/authorized ordinary/);
  await assert.rejects(missingHistoryWorkspace(join(root,'..','escape'),[root]),/authorized ordinary/);
  await assert.rejects(missingHistoryWorkspace(join(root+'-outside','gone'),[root]),/authorized ordinary/);
  await symlink(root,join(root,'alias'));
  await assert.rejects(missingHistoryWorkspace(join(root,'alias','gone'),[root]),/unchanged canonical/);
  await symlink(join(root,'absent'),join(root,'dangling'));
  await assert.rejects(missingHistoryWorkspace(join(root,'dangling','gone'),[root]),/unchanged canonical/);
  await writeFile(join(root,'file'),'not a directory');
  await assert.rejects(missingHistoryWorkspace(join(root,'file'),[root]),/unchanged canonical/);
 }finally{await rm(root,{recursive:true,force:true});}
});
