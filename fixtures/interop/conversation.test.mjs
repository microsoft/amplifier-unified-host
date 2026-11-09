import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectPeer, fixtureCommand, initializePeer } from './client.mjs';

test('experience owns shared conversation; ACP identities belong to agent participation', { timeout: 10000 }, async (t) => {
  // Fixture-local responsibility sketch, not a product wire format or durable store.
  const conversations = new Map([
    ['shared', { members: new Set(['person', 'agent-a', 'agent-b']), messages: [] }],
    ['neighbor', { members: new Set(['person', 'agent-a']), messages: [] }],
  ]);
  const append = (conversationId, author, text) => {
    const conversation = conversations.get(conversationId);
    assert.ok(conversation.members.has(author), 'Author must participate in this conversation');
    conversation.messages.push({ author, text });
  };
  const retrieve = (conversationId, participant, limit = 10) => {
    const conversation = conversations.get(conversationId);
    assert.ok(conversation.members.has(participant), 'Participant is not connected');
    return structuredClone(conversation.messages.slice(-Math.min(limit, 10)));
  };
  const connectors = new Map();
  for (const participant of ['agent-a', 'agent-b']) {
    const current = { text: '', execution: undefined };
    const peer = connectPeer(fixtureCommand(), async ({ sessionId, update }) => {
      assert.equal(sessionId, current.execution);
      if (update.sessionUpdate === 'agent_message_chunk') current.text += update.content.text;
    });
    t.after(() => peer.close());
    await initializePeer(peer);
    connectors.set(participant, { peer, current, bindings: new Map() });
  }
  async function participate(conversationId, participant) {
    const context = retrieve(conversationId, participant);
    const connector = connectors.get(participant);
    let execution = connector.bindings.get(conversationId);
    if (!execution) {
      const created = await connector.peer.client.newSession({ cwd: process.cwd(), mcpServers: [] });
      execution = created.sessionId;
      connector.bindings.set(conversationId, execution);
    }
    connector.current.execution = execution;
    connector.current.text = '';
    const result = await connector.peer.client.prompt({ sessionId: execution,
      prompt: [{ type: 'text', text: context.map(({ author, text }) => `${author}: ${text}`).join('\n') }] });
    assert.equal(result.stopReason, 'end_turn');
    append(conversationId, participant, connector.current.text);
  }

  append('shared', 'person', 'Work together');
  await participate('shared', 'agent-a');
  await participate('shared', 'agent-b');
  append('neighbor', 'person', 'Different conversation');
  await participate('neighbor', 'agent-a');
  assert.deepEqual(retrieve('shared', 'person').map((row) => row.author), ['person', 'agent-a', 'agent-b']);
  assert.deepEqual(retrieve('neighbor', 'person').map((row) => row.author), ['person', 'agent-a']);
  assert.notEqual(connectors.get('agent-a').bindings.get('shared'), connectors.get('agent-b').bindings.get('shared'));
  assert.notEqual(connectors.get('agent-a').bindings.get('shared'), connectors.get('agent-a').bindings.get('neighbor'));
  assert.throws(() => retrieve('neighbor', 'agent-b'), /not connected/);
  const saved = retrieve('shared', 'person');
  await connectors.get('agent-a').peer.close();
  assert.deepEqual(retrieve('shared', 'person'), saved, 'Agent disconnection does not remove the conversation');
  conversations.get('shared').members.delete('agent-a');
  assert.throws(() => retrieve('shared', 'agent-a'), /not connected/);
  assert.equal(retrieve('shared', 'person', 1).length, 1);
});
