import {test} from 'node:test';
import assert from 'node:assert/strict';
import {turnOutcome} from '../src/turn-outcome.js';
const message=(content:string,id?:string)=>({kind:'markdown',content,id,_meta:id?{'amplifier.dev/history':{messageId:id}}:{}});
test('voice receives the latest verified answer after progress, tools and steering',()=>{
 const parts=[message('I will file feedback','a'),{kind:'toolCall'},message('Submission unconfirmed','b'),{kind:'systemNotification',_meta:{'amplifier.dev/steering':{}}},message('I will read recent items','c'),{kind:'toolCall'},message('No saved receipts were found; submission remains unconfirmed.','d')];
 assert.deepEqual(turnOutcome(parts,true),{text:'No saved receipts were found; submission remains unconfirmed.',responseId:'d'});
 assert.deepEqual(turnOutcome(parts,false),{text:''});
});
test('message identities and tool boundaries preserve only the final answer',()=>{
 assert.equal(turnOutcome([message('Progress','first'),message('Answer','last')],true).text,'Answer');
 assert.equal(turnOutcome([message('Progress'),{kind:'toolCall'},message('Answer'),{kind:'systemNotification',_meta:{'amplifier.dev/modelCall':{}}}],true).text,'Answer');
 assert.equal(turnOutcome([message('I will check'),{kind:'toolCall'}],true).text,'');
 assert.equal(turnOutcome([message('One'),message('Two')],true).text,'One\nTwo');
});
