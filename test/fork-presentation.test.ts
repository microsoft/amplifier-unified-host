import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {captureForkProjection,forkDisplay,forkAttachmentRequest,verifiedForkAttachments,forkDigest,type ForkAttachmentBindingReceipt,type ForkBinding,type SourceDisplay} from '../src/fork-presentation.js';

const fixture=JSON.parse(readFileSync(new URL('./fixtures/fork-canonical.json',import.meta.url),'utf8'));
const boundary=fixture.source.turnGroups[0].updates[0]._meta['amplifier.dev/history'].messageId;
const binding:ForkBinding={version:1,commandId:'fork-one',engineId:'native',source:{session:'ahp-session:/source',nativeSessionId:'source',historyRevision:fixture.source.revision},target:{session:'ahp-session:/target',nativeSessionId:'target',historyRevision:fixture.target.revision},throughMessageId:boundary,workReplayed:false};
const display:SourceDisplay[]=[{turnId:'input-one',text:'Read fictional-project-plan.pdf.\nEmbedded resource: literal user text',attachments:[{uri:'amplifier-attachment://fixture/body?session=ahp-session%3A%2Fsource',name:'fictional-project-plan.pdf',contentType:'application/pdf',size:2228,sha256:'a'.repeat(64)}],receipt:{commandId:'input-one',channel:'ahp-chat:/source',status:'completed'}}];
const args=()=>structuredClone({binding,sourceRevision:fixture.source.revision,targetRevision:fixture.target.revision,source:fixture.source.turnGroups,target:fixture.target.turnGroups,display});

test('real Native reader fixture maps the exact prefix and preserves literal display text',()=>{
 const before=JSON.stringify(fixture),p=captureForkProjection(args());
 assert.equal(p.facts.length,1);assert.equal(p.facts[0].text,display[0].text);assert.deepEqual(p.facts[0].attachments,display[0].attachments);
 assert.equal(p.facts[0].observedOutcome,'source-completed');assert.equal(p.executionAuthority,false);
 assert.deepEqual(forkDisplay(p,fixture.target.turnGroups[0],'target'),p.facts[0]);assert.equal(JSON.stringify(fixture),before);
 const raw=JSON.stringify(p);for(const field of ['receipt','jobs','permissions','activeTurn','selection','runtime','responseParts'])assert.equal(raw.includes('"'+field+'"'),false);
});
test('wrong reviewed source or creation revision is refused',()=>{
 for(const field of ['sourceRevision','targetRevision'] as const){const a=args();a[field]='b'.repeat(64);assert.throws(()=>captureForkProjection(a),/revision differs/);}
});
test('copy must end exactly at the reviewed user boundary',()=>{
 const a=args();a.binding.throughMessageId=a.source[1].updates[0]._meta['amplifier.dev/history'].messageId;
 assert.throws(()=>captureForkProjection(a),/prefix differs/);
 const b=args();b.binding.throughMessageId='native:'+'0'.repeat(24);assert.throws(()=>captureForkProjection(b),/boundary unavailable/);
});
test('changed canonical input or response row refuses the complete observation',()=>{
 for(const index of [0,1]){const a=args(),meta=a.target[0].updates[index]._meta['amplifier.dev/history'];meta.messageId='native:'+'0'.repeat(24);meta.messageReference.messageId=meta.messageId;assert.throws(()=>captureForkProjection(a),/prefix differs/);}
});
test('real Native tool rows stay bound; repaired or removed tool history is not marked completed',()=>{
 const a=args();a.source=structuredClone(fixture.toolsSource.turnGroups);a.target=structuredClone(fixture.toolsTarget.turnGroups);a.sourceRevision=a.binding.source.historyRevision=fixture.toolsSource.revision;a.targetRevision=a.binding.target.historyRevision=fixture.toolsTarget.revision;a.binding.throughMessageId=a.source[0].updates[0]._meta['amplifier.dev/history'].messageId;
 assert.equal(captureForkProjection(a).facts[0].targetRows.length,4);
 const changed=structuredClone(a);changed.target[0].updates.find((u:any)=>u.sessionUpdate==='tool_call_update')._meta['amplifier.dev/history'].messageId='native:'+'0'.repeat(24);assert.throws(()=>captureForkProjection(changed),/prefix differs/);
 const removed=structuredClone(a);removed.target[0].updates=removed.target[0].updates.filter((u:any)=>u.sessionUpdate!=='tool_call_update');assert.throws(()=>captureForkProjection(removed),/prefix differs/);
});
test('public-text digest, row position and group identity all remain bound',()=>{
 const edits=[(a:any)=>{a.target[0].updates[0]._meta['amplifier.dev/history'].messageReference.sourceDigest='b'.repeat(64);},(a:any)=>{const h=a.target[0].updates[0]._meta['amplifier.dev/history'];h.position=8;h.messageReference.position=8;},(a:any)=>{a.target[0].id='different-input';}];
 for(const edit of edits){const a=args();edit(a);assert.throws(()=>captureForkProjection(a));}
});
test('ambiguous source turn, canonical row or duplicate group refuses projection',()=>{
 const a=args();a.display.push(a.display[0]);assert.throws(()=>captureForkProjection(a),/Ambiguous source/);
 const b=args();b.source.push(b.source[0]);assert.throws(()=>captureForkProjection(b),/Ambiguous canonical turn/);
 const c=args();const duplicate=structuredClone(c.target[0].updates[0]);duplicate._meta['amplifier.dev/history'].messageReference.sourceDigest='c'.repeat(64);c.target[0].updates.push(duplicate);assert.throws(()=>captureForkProjection(c),/Ambiguous canonical row/);
});
test('no source completion is inferred from user role, a wrong receipt or another chat',()=>{
 for(const receipt of [undefined,{commandId:'input-one',channel:'ahp-chat:/source',status:'failed'},{commandId:'other-input',channel:'ahp-chat:/source',status:'completed'},{commandId:'input-one',channel:'ahp-chat:/other',status:'completed'}]){const a=args();a.display[0].receipt=receipt;assert.equal(captureForkProjection(a).facts[0].observedOutcome,'unknown');}
});
test('source and target epoch may differ at copy; later epoch change loses inherited facts',()=>{
 const a=args();for(const update of a.target[0].updates){const h=update._meta['amplifier.dev/history'];h.messageId=h.messageId.replace('native:','native:copied:');if(h.messageReference){h.messageReference.messageId=h.messageId;h.messageReference.historyEpoch='copied';}}
 const p=captureForkProjection(a);assert.ok(forkDisplay(p,a.target[0],'target'));
 const changed=structuredClone(a.target[0]);for(const update of changed.updates){const h=update._meta['amplifier.dev/history'];h.messageId=h.messageId.replace('native:copied:','native:edited:');if(h.messageReference)h.messageReference.messageId=h.messageId;}
 assert.equal(forkDisplay(p,changed,'target'),undefined);
});
test('new appended turns inherit no source presentation or source outcome',()=>{
 const p=captureForkProjection(args());assert.equal(forkDisplay(p,fixture.source.turnGroups[1],'target'),undefined);
 assert.ok(forkDisplay(p,fixture.target.turnGroups[0],'target'));
});
test('archived, changed or wrong-session rows cannot inherit the source facts',()=>{
 const p=captureForkProjection(args());assert.throws(()=>forkDisplay(p,fixture.target.turnGroups[0],'other'),/scope differs/);
 const changed=structuredClone(fixture.target.turnGroups[0]);changed.updates[0]._meta['amplifier.dev/history'].historicalOnly=true;assert.equal(forkDisplay(p,changed,'target'),undefined);
 const ref=structuredClone(fixture.target.turnGroups[0]);ref.updates[0]._meta['amplifier.dev/history'].messageReference.sessionId='other';assert.equal(forkDisplay(p,ref,'target'),undefined);
});
test('projection tamper and absent owner digest refuse; extra source runtime fields are not retained',()=>{
 const p=captureForkProjection(args());p.facts[0].text='changed';assert.throws(()=>forkDisplay(p,fixture.target.turnGroups[0],'target'),/integrity differs/);
 const a=args();a.display[0].attachments[0].sha256='';assert.throws(()=>captureForkProjection(a),/integrity unavailable/);
 const b=args();Object.assign(b.display[0],{jobs:[{id:'should-not-copy'}],activeTurn:{id:'old'},permissions:['approve']});const safe=captureForkProjection(b);assert.equal(JSON.stringify(safe).includes('should-not-copy'),false);
});
test('explicit count and byte bounds avoid unbounded history copies',()=>{
 const a=args();a.display=Array(201).fill(a.display[0]);assert.throws(()=>captureForkProjection(a),/capacity/);
 const b=args();b.display[0].text='x'.repeat(2*1024*1024);assert.throws(()=>captureForkProjection(b),/byte capacity/);
});
const resources=()=>{const request=forkAttachmentRequest(captureForkProjection(args()));const a=request.items[0].attachment;const receipt:ForkAttachmentBindingReceipt={owner:'unified.resources',version:1,commandId:'fork-one',requestDigest:forkDigest(request),sourceSession:binding.source.session,targetSession:binding.target.session,status:'completed',items:[{sourceUri:a.uri,targetUri:'amplifier-attachment://target-file/body?session=ahp-session%3A%2Ftarget',sha256:a.sha256,size:a.size,name:a.name,contentType:a.contentType}],replayed:false};return {request,receipt};};
test('Resources receipt binds fork command, exact request digest and target-scoped descriptor',()=>{
 const {request,receipt}=resources();const grants=verifiedForkAttachments(request,receipt)!;
 assert.equal(grants.size,1);assert.equal(grants.get(request.items[0].attachment.uri)?.uri,receipt.items[0].targetUri);
 assert.equal(forkDigest({b:2,a:1}),forkDigest({a:1,b:2}));
});
test('wrong Resources command, conversation or request digest cannot authorize a target card',()=>{
 for(const change of [{commandId:'another-fork'},{sourceSession:'ahp-session:/other'},{targetSession:'ahp-session:/other'},{requestDigest:'b'.repeat(64)},{replayed:true}]){const {request,receipt}=resources();Object.assign(receipt,change);assert.throws(()=>verifiedForkAttachments(request,receipt),/scope differs/);}
});
test('foreign URI, changed bytes/name and incomplete or duplicate grants refuse',()=>{
 const changes=[{targetUri:'amplifier-attachment://target-file/body?session=ahp-session%3A%2Fsource'},{targetUri:'https://example.com/body'},{sha256:'b'.repeat(64)},{size:0},{name:'different.pdf'}];
 for(const change of changes){const {request,receipt}=resources();Object.assign(receipt.items[0],change);assert.throws(()=>verifiedForkAttachments(request,receipt),/integrity differs/);}
 const missing=resources();missing.receipt.items=[];assert.throws(()=>verifiedForkAttachments(missing.request,missing.receipt),/coverage incomplete/);
 const duplicate=resources();duplicate.receipt.items.push(duplicate.receipt.items[0]);assert.throws(()=>verifiedForkAttachments(duplicate.request,duplicate.receipt),/integrity differs/);
});
test('refused or unresolved Resources outcomes do not produce target grants',()=>{
 for(const status of ['refused','unknown'] as const){const {request,receipt}=resources();receipt.status=status;assert.equal(verifiedForkAttachments(request,receipt),undefined);}
});
