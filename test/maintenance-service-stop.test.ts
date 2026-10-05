import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHost} from '../src/host.js';
import type {QuiescenceParticipant} from '../src/quiescence.js';
const identity={installationId:'installation',dataScope:'owned',ownerId:'owner',instanceId:'A',releaseDigest:'a'.repeat(64)};
async function fixture(t:any,participants:QuiescenceParticipant[]){
 const directory=await mkdtemp(join(tmpdir(),'maintenance-stop-'));
 const host=await createHost({stateDirectory:join(directory,'host'),allowedWorkspaceRoots:[directory],engines:[{id:'unused',command:'/never-start'}],quiescence:{instanceId:identity.instanceId,dataScope:identity.dataScope,requiredOwners:participants.map(p=>p.id),participants,coverage:{},timeoutMs:100,verifyRelease:async()=>{throw Error('Not service authority');},serviceLifecycle:{identity,verifyRelease:async r=>({kind:'service-lifecycle',verified:true,fenceId:r.fenceId,commandId:r.commandId,serviceOutcome:'stop-refused',outcome:'unchanged',expected:identity,observed:identity,instanceId:identity.instanceId,dataScope:identity.dataScope,receiptId:'authenticated-no-stop',refusalReceiptId:'owned-no-signal'})}}});
 t.after(async()=>{await host.close();await rm(directory,{recursive:true,force:true});});return host;
}
test('maintenance stop acquires real owner fences; ordinary stop remains shared and command modes cannot change',async t=>{
 let acquired=0,released=0;
 const host=await fixture(t,[{id:'storage',serviceStop:{version:1},acquire:async c=>{acquired++;assert.deepEqual(c.serviceIdentity,identity);return {ownerId:'storage',fenceId:c.fenceId,release:async()=>{released++;}};}}]);
 for(const key of Object.keys(identity))await assert.rejects(host.admitMaintenanceServiceStop({commandId:'foreign',expected:{...identity,[key]:'foreign'}}),/exact configured/);
 const held:any=await host.admitMaintenanceServiceStop({commandId:'archive',expected:identity});
 assert.equal(held.admitted,true);assert.deepEqual(host.inspectServiceLifecycle().fence?.owners,['storage']);assert.equal(acquired,1);
 assert.deepEqual(await host.admitMaintenanceServiceStop({commandId:'archive',expected:identity}),held);assert.equal(acquired,1);
 await assert.rejects(host.admitServiceStop({commandId:'archive',expected:identity}),/legacy admission/);
 await host.releaseServiceStop({fenceId:held.fenceId,commandId:'archive',outcome:'stop-refused'});assert.equal(released,1);
 const shared:any=await host.admitServiceStop({commandId:'shutdown',expected:identity});assert.equal(shared.admitted,true);assert.deepEqual(shared.fence.owners,[]);assert.equal(acquired,1);
 await assert.rejects(host.admitMaintenanceServiceStop({commandId:'shutdown',expected:identity}),/different arguments/);
});
test('maintenance stop refuses uncovered or busy owners without pretending to have capture coverage',async t=>{
 let released=0;
 const host=await fixture(t,[{id:'first',serviceStop:{version:1},acquire:async c=>({ownerId:'first',fenceId:c.fenceId,release:async()=>{released++;}})},{id:'busy',serviceStop:{version:1},acquire:async()=>null}]);
 const result:any=await host.admitMaintenanceServiceStop({commandId:'busy',expected:identity});assert.equal(result.admitted,false);assert.equal(result.executed,false);assert.equal(result.intakeClosed,false);assert.equal(released,1);
 const uncovered=await fixture(t,[{id:'unsupported',acquire:async()=>{throw Error('Must not be attempted');}}]);
 const refused:any=await uncovered.admitMaintenanceServiceStop({commandId:'unsupported',expected:identity});assert.equal(refused.admitted,false);assert.equal(refused.reason,'service-stop-coverage-unavailable');
});
test('lost owner acquisition stays unknown and never reacquires the original maintenance command',async t=>{
 let acquired=0;const host=await fixture(t,[{id:'uncertain',serviceStop:{version:1},acquire:async()=>{acquired++;throw Error('Lost owner reply');}}]);
 const result:any=await host.admitMaintenanceServiceStop({commandId:'unknown',expected:identity});assert.equal(result.fence.phase,'unknown');assert.equal(host.inspectServiceLifecycle().intakeClosed,true);
 assert.deepEqual(await host.admitMaintenanceServiceStop({commandId:'unknown',expected:identity}),result);assert.equal(acquired,1);
});
