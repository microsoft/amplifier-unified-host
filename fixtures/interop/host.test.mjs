import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { AhpClient } from '@microsoft/agent-host-protocol/client';
import { WebSocketTransport } from '@microsoft/agent-host-protocol/ws';
import { createHost } from '../../dist/index.js';
import { fixtureCommand } from './client.mjs';

for (const behavior of ['echo', 'lose-reply']) {
  test(`packaged host preserves admission with a standard ACP peer: ${behavior}`, { timeout: 15000 }, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'acp-baseline-'));
    const log = join(dir, 'fixture-observations.jsonl');
    const config = { stateDirectory: join(dir, 'state'), allowedWorkspaceRoots: [dir],
      engines: [{ id: 'baseline', label: 'Baseline fixture', ...fixtureCommand(behavior, log) }] };
    let host = await createHost(config);
    let client;
    t.after(async () => { await client?.shutdown(); await host.close(); await rm(dir, { recursive: true, force: true }); });
    client = new AhpClient(await WebSocketTransport.connect(host.url));
    client.connect();
    await client.initialize({ clientId: 'fixture-owner', protocolVersions: ['0.9.0'] });
    const session = 'ahp-session:/' + randomUUID();
    await client.request('createSession', { channel: session, provider: 'baseline',
      workingDirectories: [pathToFileURL(dir).href] });
    const input = { commandId: randomUUID(), text: 'one dispatch', clientId: 'fixture-owner' };
    await host.submitTurn(session, input);
    // A viewer is not the execution owner.
    await client.shutdown(); client = undefined;
    const expected = behavior === 'echo' ? 'completed' : 'unknown';
    assert.equal((await host.waitForTurn(session, input.commandId, 5000)).status, expected);
    await assert.rejects(host.submitTurn(session, input), /already admitted/);
    await assert.rejects(host.submitTurn(session, { ...input, text: 'conflicting retry' }), /already admitted/);
    await host.close();
    host = await createHost(config);
    assert.equal((await host.waitForTurn(session, input.commandId, 5000)).status, expected);
    await assert.rejects(host.submitTurn(session, input), /already admitted/);
    if (behavior === 'echo') {
      await assert.rejects(host.submitTurn(session, { ...input, commandId: randomUUID() }), /cannot resume/);
    }
    const observations = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(observations.filter((row) => row.event === 'prompt').length, 1);
    assert.equal(observations.filter((row) => row.event === 'new').length, 1);
    // The log proves the fixture received a prompt. It does not resolve the host's unknown effects.
  });
}
