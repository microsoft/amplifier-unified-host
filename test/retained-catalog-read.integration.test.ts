import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp, mkdir, readFile, writeFile, rm, realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {StdioCatalog} from '../src/catalog.js';
import {ConversationPresentation, type PresentationPorts} from '../src/presentation.js';

// Use an independently installed Catalog 15+; an optional wheel selects an exact
// artifact without installing another environment or importing sibling sources.
const python = process.env.PRESENTATION_CATALOG_PYTHON;
const wheel = process.env.PRESENTATION_CATALOG_WHEEL;
const prefix = wheel ? ['-I', '-B', '-c',
  "import sys,runpy;sys.path.insert(0,sys.argv.pop(1));runpy.run_module('amplifier_session_catalog',run_name='__main__')", wheel]
  : ['-I', '-B', '-m', 'amplifier_session_catalog'];
const actor = {actorId: 'fixture-user', origin: 'ui' as const};

for (const positive of [false, true]) test(`installed catalog: retained ${positive ? 'positive' : 'zero'} checkpoint survives restart during refresh`, {skip: !python}, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'retained-browse-')));
  const workspace = join(directory, 'existing'), index = join(directory, 'catalog.sqlite');
  await mkdir(workspace);
  const nativeFile = join(directory, 'transcript.jsonl'), nativeBody = '{"role":"user","content":"preserved"}\n';
  await writeFile(nativeFile, nativeBody);
  const launch = () => new StdioCatalog({command: python!, args: [...prefix, 'serve', '--db', index, '--scan-interval', '0', '--workspace-check-interval', '0']});
  const progress = (phase: string) => {
    const result = spawnSync(python!, ['-I', '-B', '-c',
      "import sys;wheel=sys.argv[1];sys.path.insert(0,wheel) if wheel else None;from amplifier_session_catalog import Catalog;Catalog(sys.argv[2]).progress({'phase':sys.argv[3],'issues':0})",
      wheel ?? '', index, phase], {encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
  };
  let catalog = launch(), db = new DatabaseSync(join(directory, 'host.sqlite'));
  let host: ConversationPresentation | undefined;
  const calls = {status: 0, freshness: 0, project: 0, hint: 0, validate: 0, changed: 0};
  const ports: PresentationPorts = {
    metadata: async session => {
      const row = await catalog.get(session); assert.ok(row);
      return {identity: {session, engineId: row.engineId, nativeSessionId: row.nativeSessionId, workingDirectory: row.workingDirectory}, title: row.title, catalog: row};
    },
    withSelection: async (_ids, work) => work(),
    validateSelection: async () => {calls.validate++;},
    mappings: async () => ({items: []}),
    projectionStatus: source => {calls.status++; return catalog.sessionVisibilityProjectionStatus({source});},
    projectionReceipt: (source, commandId) => catalog.sessionVisibilityProjectionReceipt({source, commandId}),
    project: request => {calls.project++; return catalog.projectSessionVisibility(request);},
    catalogGet: session => catalog.get(session),
    catalogFreshness: () => {calls.freshness++; return catalog.status();},
    changed: () => {calls.changed++;},
    hint: async () => {calls.hint++; throw Error('Browsing cannot hydrate sources');},
  };
  try {
    for (const [id, kind, workingDirectory, parentUri] of [
      ['root-a', 'root', workspace], ['root-b', 'root', workspace],
      ['deleted', 'root', workspace], ['child', 'child', workspace, 'ahp-session:/root-a'],
      ['missing', 'root', join(directory, 'absent')],
    ]) await catalog.upsert({uri: 'ahp-session:/' + id, engineId: 'fixture', nativeSessionId: id, workingDirectory, kind, title: id, createdAt: '2026-01-01T00:00:00Z', modifiedAt: '2026-01-01T00:00:00Z', ...(parentUri ? {parentUri} : {})});
    await catalog.setVisibility({uri: 'ahp-session:/deleted', nativeSessionId: 'deleted', workingDirectory: workspace, deleted: true, commandId: 'native-deletion', evidence: 'native-completed-receipt'});
    progress('complete');
    host = new ConversationPresentation(db, ports);
    await host.checkReady(false);
    assert.equal(host.inspect().ready, true);
    if (positive) {
      const review = await host.prepare({commandId: 'review', operation: 'reset', selection: {kind: 'explicit', sessionIds: ['ahp-session:/root-b']}}, actor);
      assert.equal((await host.apply({commandId: 'hide', reviewId: review.reviewId, reviewHash: review.reviewHash}, actor)).projection.status, 'ready');
    }
    const source = host.inspect().source!;
    const checkpoint = await catalog.sessionVisibilityProjectionStatus({source});
    assert.equal(checkpoint.projectionPresent, positive);
    assert.equal(checkpoint.revision, positive ? 1 : 0);
    assert.equal(host.inspect().acknowledgedIndexIncarnation, checkpoint.indexIncarnation);

    // Reopen both processes from their existing stores while discovery is busy.
    progress('running');
    await host.close(); db.close(); await catalog.close();
    catalog = launch(); db = new DatabaseSync(join(directory, 'host.sqlite'));
    host = new ConversationPresentation(db, ports);
    const before = host.inspect(), beforeCalls = {...calls};
    const changes = () => db.prepare('SELECT total_changes() n').get()!.n;
    const beforeChanges = changes();
    assert.equal(before.ready, false);
    const query = {connectionId: 'fixture', allowedWorkspaceRoots: [directory], limit: 1};
    const ids: string[] = []; let cursor: string | undefined, reads = 0;
    do {
      const page = await host.read(() => catalog.list({...query, ...(cursor ? {cursor} : {})})); reads++;
      assert.ok(page.items.length <= 1);
      ids.push(...page.items.map((row: any) => row.uri)); cursor = page.nextCursor ?? undefined;
      assert.ok(reads <= 2);
    } while (cursor);
    assert.deepEqual(ids, positive ? ['ahp-session:/root-a'] : ['ahp-session:/root-a', 'ahp-session:/root-b']);
    const workspaces = await host.read(() => catalog.listWorkspaces(query)); reads++;
    assert.deepEqual(workspaces.items.map((row: any) => row.path), [workspace]);
    assert.deepEqual(host.inspect(), before);
    assert.equal(changes(), beforeChanges);
    assert.equal(calls.status - beforeCalls.status, reads * 2);
    assert.deepEqual({...calls, status: beforeCalls.status}, beforeCalls);
    assert.equal(await readFile(nativeFile, 'utf8'), nativeBody);

    // Replacing the database cannot silently rebind the acknowledged identity,
    // even at the legitimate zero checkpoint or after a complete fresh scan.
    await catalog.close();
    for (const suffix of ['', '-wal', '-shm']) await rm(index + suffix, {force: true});
    catalog = launch(); await catalog.status(); progress('complete');
    let callbacks = 0;
    await assert.rejects(host.read(async () => {callbacks++;}), /identity or checkpoint differs/);
    assert.equal(callbacks, 0);
    assert.equal(changes(), beforeChanges);
    await host.checkReady(false);
    assert.equal(host.inspect().ready, false);
    assert.equal(host.inspect().acknowledgedIndexIncarnation, checkpoint.indexIncarnation);
  } finally {
    await host?.close(); db.close(); await catalog.close();
    await rm(directory, {recursive: true, force: true});
  }
});
