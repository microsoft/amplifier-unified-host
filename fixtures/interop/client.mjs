import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

// A fixture connector, not a conversation owner or permission policy.
export function connectPeer({ command, args = [], cwd, env }, onUpdate = async () => {}) {
  const process = spawn(command, args, { cwd, env, stdio: 'pipe' });
  let stderr = '';
  process.stderr.on('data', (data) => { stderr = (stderr + data).slice(-4096); });
  const closed = once(process, 'close');
  // Observe spawn errors even when no protocol request has started yet.
  closed.catch(() => {});
  const client = new ClientSideConnection(() => ({
    sessionUpdate: onUpdate,
    requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
  }), ndJsonStream(Writable.toWeb(process.stdin), Readable.toWeb(process.stdout)));
  return {
    client,
    stderr: () => stderr,
    async close() {
      process.stdin.end();
      const timer = setTimeout(() => process.kill('SIGKILL'), 1000);
      try { await closed; } finally { clearTimeout(timer); }
    },
  };
}

export const fixtureCommand = (behavior = 'echo', log) => ({
  command: process.execPath,
  args: [fileURLToPath(new URL('./acp-peer.mjs', import.meta.url)), '--behavior', behavior,
    ...(log ? ['--log', log] : [])],
});

export async function initializePeer(peer) {
  return peer.client.initialize({ protocolVersion: 1,
    clientInfo: { name: 'independent-baseline-check', version: '1.0.0' },
    clientCapabilities: {},
  });
}
