import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectPeer, fixtureCommand, initializePeer } from './client.mjs';

test('standard peer keeps identity, streaming and explicit capability limits', { timeout: 10000 }, async (t) => {
  const updates = [];
  const peer = connectPeer(fixtureCommand(), async (update) => { updates.push(update); });
  t.after(() => peer.close());
  const hello = await initializePeer(peer);
  assert.equal(hello.protocolVersion, 1);
  assert.equal(hello.agentInfo.name, 'unified-baseline-fixture');
  assert.equal(hello.agentCapabilities.loadSession, false);
  assert.equal(hello.agentCapabilities.sessionCapabilities?.resume, undefined);
  assert.equal(hello.agentCapabilities._meta, undefined);
  const first = await peer.client.newSession({ cwd: process.cwd(), mcpServers: [] });
  const second = await peer.client.newSession({ cwd: process.cwd(), mcpServers: [] });
  assert.notEqual(first.sessionId, second.sessionId);
  const result = await peer.client.prompt({ sessionId: first.sessionId,
    prompt: [{ type: 'text', text: 'hello' }] });
  assert.equal(result.stopReason, 'end_turn');
  assert.deepEqual(updates.map((row) => row.sessionId), [first.sessionId, first.sessionId]);
  assert.equal(updates.map((row) => row.update.content.text).join(''), 'Fixture: hello');
  await assert.rejects(peer.client.loadSession({ ...first, cwd: process.cwd(), mcpServers: [] }),
    (error) => error.code === -32601);
  await assert.rejects(peer.client.resumeSession({ ...first, cwd: process.cwd(), mcpServers: [] }),
    (error) => error.code === -32601);
  await assert.rejects(peer.client.prompt({ sessionId: 'not-owned', prompt: [] }),
    (error) => error.code === -32602);
  await assert.rejects(peer.client.prompt({ ...first, prompt: [{ type: 'image', data: '', mimeType: 'image/png' }] }),
    (error) => error.code === -32602);
  await assert.rejects(peer.client.extMethod('_unavailable/feature', {}),
    (error) => error.code === -32601);
});

test('standard cancellation settles the pending prompt; it does not imply force termination', { timeout: 10000 }, async (t) => {
  let streamed;
  const started = new Promise((resolve) => { streamed = resolve; });
  const peer = connectPeer(fixtureCommand('wait-for-cancel'), async () => { streamed(); });
  t.after(() => peer.close());
  await initializePeer(peer);
  const identity = await peer.client.newSession({ cwd: process.cwd(), mcpServers: [] });
  const turn = peer.client.prompt({ ...identity, prompt: [{ type: 'text', text: 'wait' }] });
  await started;
  await peer.client.cancel(identity);
  assert.equal((await turn).stopReason, 'cancelled');
  // The same agent process still responds after cancellation.
  const another = await peer.client.newSession({ cwd: process.cwd(), mcpServers: [] });
  assert.notEqual(another.sessionId, identity.sessionId);
});
