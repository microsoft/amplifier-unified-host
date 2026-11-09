#!/usr/bin/env node
// An independent SDK client for an installed ACP executable; no native imports.
import { parseArgs } from 'node:util';
import { connectPeer, initializePeer } from './client.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  cwd: { type: 'string', default: process.cwd() },
  text: { type: 'string', default: 'Reply briefly to this synthetic interoperability check.' },
  timeout: { type: 'string', default: '30' },
} });
const [command, ...args] = positionals;
const timeout = Number(values.timeout);
if (!command || !Number.isFinite(timeout) || timeout <= 0 || timeout > 600) {
  throw new Error('Usage: node probe.mjs [--cwd DIR] [--timeout SECONDS] -- EXECUTABLE [ARGS...]');
}
let updateCount = 0;
let observedSession;
let identityMismatch = false;
const peer = connectPeer({ command, args, cwd: values.cwd }, async (update) => {
  updateCount++;
  identityMismatch ||= observedSession !== undefined && update.sessionId !== observedSession;
  observedSession ??= update.sessionId;
});
let timer;
try {
  const result = await Promise.race([
    (async () => {
      const hello = await initializePeer(peer);
      if (hello.protocolVersion !== 1) throw new Error('Peer did not negotiate ACP 1');
      const identity = await peer.client.newSession({ cwd: values.cwd, mcpServers: [] });
      const response = await peer.client.prompt({ ...identity, prompt: [{ type: 'text', text: values.text }] });
      if (identityMismatch || (observedSession !== undefined && observedSession !== identity.sessionId)) {
        throw new Error('Update identity mismatch');
      }
      return { protocolVersion: hello.protocolVersion, agent: hello.agentInfo,
        capabilities: { loadSession: hello.agentCapabilities?.loadSession === true,
          resume: !!hello.agentCapabilities?.sessionCapabilities?.resume },
        stopReason: response.stopReason, updates: updateCount,
        qualification: 'new/prompt only; no resume, authorization, recovery or product parity claim' };
    })(),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Probe deadline expired; effects are unknown')), timeout * 1000); }),
  ]);
  console.log(JSON.stringify(result));
} finally {
  clearTimeout(timer);
  await peer.close();
}
