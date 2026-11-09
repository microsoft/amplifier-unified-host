#!/usr/bin/env node
// Deterministic standard ACP peer. No host/native imports, accounts or persistence.
import { agent, ndJsonStream, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk';
import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  behavior: { type: 'string', default: 'echo' },
  log: { type: 'string' },
} });
if (!['echo', 'wait-for-cancel', 'lose-reply'].includes(values.behavior)) {
  throw new Error('behavior must be echo, wait-for-cancel or lose-reply');
}
const sessions = new Map();
const audit = async (row) => {
  if (values.log) await appendFile(values.log, JSON.stringify(row) + '\n');
};
const session = (id) => {
  const found = sessions.get(id);
  if (!found) throw RequestError.invalidParams(undefined, 'Unknown fixture session');
  return found;
};

agent({ name: 'unified-baseline-fixture' })
  .onRequest('initialize', () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentInfo: { name: 'unified-baseline-fixture', version: '1.0.0' },
    agentCapabilities: { loadSession: false, promptCapabilities: {
      image: false, audio: false, embeddedContext: false,
    } },
    authMethods: [],
  }))
  .onRequest('session/new', async ({ params }) => {
    if (params.mcpServers.length) throw RequestError.invalidParams(undefined, 'MCP is not supported');
    if (sessions.size >= 16) throw new RequestError(-32000, 'Fixture session limit reached');
    const sessionId = randomUUID();
    sessions.set(sessionId, { pending: undefined });
    await audit({ event: 'new', sessionId });
    return { sessionId };
  })
  .onRequest('session/prompt', async ({ params, client }) => {
    const current = session(params.sessionId);
    if (current.pending) throw new RequestError(-32000, 'Fixture session is busy');
    if (params.prompt.some((part) => part.type !== 'text')) {
      throw RequestError.invalidParams(undefined, 'Only text prompts are supported');
    }
    const text = params.prompt.map((part) => part.text).join('');
    if (Buffer.byteLength(text) > 65536) throw RequestError.invalidParams(undefined, 'Prompt exceeds 64 KiB');
    const controller = new AbortController();
    current.pending = controller;
    try {
      await audit({ event: 'prompt', sessionId: params.sessionId, text });
      if (values.behavior === 'lose-reply') process.exit(17);
      const chunk = (text) => client.notify('session/update', {
        sessionId: params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
      });
      await chunk('Fixture: ');
      if (values.behavior === 'wait-for-cancel') {
        if (!controller.signal.aborted) await new Promise((resolve) => {
          controller.signal.addEventListener('abort', resolve, { once: true });
        });
      } else if (!controller.signal.aborted) await chunk(text);
      return { stopReason: controller.signal.aborted ? 'cancelled' : 'end_turn' };
    } finally {
      current.pending = undefined;
    }
  })
  .onNotification('session/cancel', ({ params }) => {
    sessions.get(params.sessionId)?.pending?.abort();
  })
  .connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
