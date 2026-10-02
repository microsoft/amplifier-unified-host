# Amplifier Unified Host

A standalone TypeScript host implementing AHP 0.9 over WebSocket and stable ACP 1
over agent stdio. Its execution path has no imports from Amplifier Core,
Foundation, the Unified application service, or the separate `amplifier-agent`
library. The Amplifier engine is provided by the independent `amplifier-acp`
adapter over the full native Core/Foundation application runtime.

## Run

Node 22.16 or later is required. Qualification currently uses Node 22.22; its
built-in SQLite API emits an experimental-feature notice.

```sh
npm ci
npm run check
npm test
npm run build
node dist/cli.js --config /absolute/host.json
```

Installed executable: `amplifier-unified-host --config /absolute/host.json`.
The published API is `createHost(config)` and the returned host's `url`,
`inspectSession`, `createSession`, `submitScheduled`, `nativeControl`, `invokeClientTool`, `invalidateCapability`,
`diagnostics`, and `close` methods. `npm pack` produces a standalone artifact.

```json
{
  "stateDirectory": "/private/owned-instance/host",
  "host": "127.0.0.1",
  "port": 8765,
  "allowedWorkspaceRoots": ["/work"],
  "allowedOrigins": ["http://127.0.0.1:5173"],
  "engines": [{
    "id": "amplifier",
    "label": "Amplifier",
    "command": "/installation/bin/amplifier-acp",
    "args": ["--config", "/private/owned-instance/agent.json"]
  }],
  "catalogProcess": {
    "command": "/installation/bin/amplifier-session-catalog",
    "args": ["serve", "--db", "/private/owned-instance/catalog.sqlite",
      "--home", "/private/owned-instance/native", "--scan-on-start"]
  }
}
```

All configured engine executables and arguments are trusted administrator input.
Clients choose an advertised engine ID; they cannot provide arbitrary commands.
Native engine authentication is configured in that engine's supported setup.
This host does not equate ACP authentication-method selection with AHP OAuth.

Use the independent catalog for historical/scaled deployments. `StdioCatalog`
owns one long-lived child process, never a process per query. It forwards scoped
list/get/upsert/hint operations, correlates concurrent replies, and bounds pending
requests. The catalog owns source discovery and background existence rechecks.
Without a catalog, the host lists only its own created records; that small local
fixture mode does not provide external discovery or background workspace rechecks.

## Authority, durability and working set

- Bind defaults to loopback. Both Origin and Host authority are checked against
  configured/listening authorities, never an attacker-supplied Host header.
  `bearerToken` requires the Authorization header; URL query tokens are not used.
  A non-loopback bind requires authentication. Browser deployments use an
  authenticated same-origin gateway; all clients on this host are one authorized
  principal, not separate tenants. TLS and account management belong to the gateway.
- Workspace access resolves real paths and checks configured roots. ACP filesystem
  callbacks are restricted further to the session's execution workspace. Agents
  remain trusted local executable code; this boundary is not a process sandbox.
- One host holds the state directory lease. SQLite WAL with synchronous FULL
  stores command admission before prompt dispatch, identity mappings, lightweight
  resource checkpoints, completed turns, active-turn events, and bounded replay.
  Token deltas append narrow durable records instead of rewriting the active
  response checkpoint. Native `transcript.jsonl`, metadata and events remain owned
  by the native adapter; the host never edits those files.
- Stable AHP turn IDs are durable command IDs. Reusing one cannot dispatch another
  prompt. ACP errors/disconnection or interrupted admission become `unknown`.
  Unknown means inspect/reconcile native evidence; no automatic resubmission or
  fabricated success. `x-commandReceipt` is advertised explicitly during initialize.
  The host intentionally has no “assume success” reconciliation shortcut.
- Agent processes belong to admitted work, not viewers. Unsubscribing or closing
  every viewer does not cancel a turn. Idle processes retire only when the engine
  supports native reload/resume. An active native control is also retained.
- Root state contains agent descriptors and active terminal descriptors, not the
  session catalog or historical transcripts. Catalog pages, session resources and
  chat windows are independent. Native child discovery remains the catalog owner's
  explicit query, not eager loading into the root state.
- AHP subscriptions use official reducers and action envelopes. Reconnect returns
  bounded replay when available; replay does not read transcripts. When replay has
  expired, snapshots recover authority. A client missing its own baseline must
  initialize/subscribe afresh, never apply a delta to an absent state.
- Omitting `view.turns` returns all retained turns, including during snapshot
  reconnect. This upstream behavior can create a large response; it is not silently
  truncated. Explicit chat-window requests and `fetchTurns` keep normal browsing
  paged. Native history reads use the negotiated passive complete-turn extension,
  never session/load just to browse. Unknown historical outcomes are represented
  visibly rather than inferred from a saved assistant message.

Default limits: eight active agents, four concurrent passive history readers,
128 connected clients, 64 subscriptions per client, 32 concurrent requests per
client, 512 queued ACP updates / 8 MiB, 8 MiB of active-turn projection input,
4,096 replay actions / 16 MiB, and 4 MiB of socket buffered output. A slow peer is
disconnected for resynchronization; other viewers and execution remain independent.
Agent process count is bounded; this is not an OS-level RSS or CPU quota.
Full-history snapshots are the explicit protocol exception to normal view bounds.

ACP-created terminals have standard AHP channels, session ownership, plain output
(`isPty:false`) and real exit status. Their visible scrollback is bounded with a
standard clear action; full emitted output is preserved in host terminal logs.
The host does not advertise interactive PTY creation, resizing or shell integration.
It supports ACP terminal callbacks, rather than pretending pipes are pseudoterminals.

## Independent capability owners

`HostConfig` is exported from the package. Its optional seams are:

- `catalog`: typed catalog interface, or CLI `catalogProcess` configuration.
- `resourceProviders`: registered URI schemes with standard AHP `read`, `resolve`,
  `list`, and `write` handlers. Providers authorize scoped identity and implement
  conditional-write semantics. Filesystem read/list/resolve are scoped built-ins;
  arbitrary filesystem writes are not granted by an ordinary subscription.
- `capabilities`: a versioned manifest, bounded topic reader and admitted action
  handler. Numeric topic revisions match the client contract. Standard resource
  watches signal cross-client invalidations. No legacy global snapshot is exposed.
- `nativeHostRequest`: negotiated `_amplifier/host` callbacks receive trusted host
  session, native session and execution workspace, only during admitted native
  work or an explicitly scoped native control. Providers route the same shared
  operations used by clients and must not trust caller-supplied authority.
- `nativeEvent`: private scoped event delivery. Native history-save hints go to
  the catalog after the host stores native identity, and the catalog validates
  the configured native roots. Native filesystem locators are not sent to clients.

Client-provided tools use upstream `session/activeClientSet` and standard tool
contributor actions. A client can register/remove only its own tools while
subscribed. `invokeClientTool` requires an admitted native turn and an explicit
target client. Only that client can return its tool result. Disconnect/timeout
becomes an unknown-effects failure, never an automatic device-action replay.
Private drafts and DOM state are not mirrored. An external ACP agent needs an
MCP/client-tool bridge before it can discover these optional tools; that bridge
is a separate capability integration, not claimed by this package.

`nativeControl` uses the negotiated ACP extension, with no native runtime import.
Capability owners must invoke it through their admitted, authorized action path.
It is a process-local provider API, not an unguarded network RPC endpoint.
`nativeControlExisting` refuses cold or retired runtimes without starting a process;
operation write/cancel uses this seam to preserve original runtime ownership.

Trusted distribution capabilities share the same admission through
`invokeCapability(request, {actorId, clientId?, origin})`. Origin is supplied by
the authenticated entry point (`agent` or `ui`), never an action argument; MCP
owners use it to enforce model-visible versus app-visible tools. Native callbacks
receive only capabilities actually supplied in `nativeHostCapabilities`.

Media and other user-authorized inputs use `submitTurn` with a stable command ID,
then `waitForTurn` to obtain its actual bounded result. Timeout leaves admitted
work running and does not resubmit. `readSessionContext` reads a selected bounded
window without expanding another subscriber's history. `observeSession` returns
an explicit unsubscribe and limits consumers and their event queues. Consumers
must coalesce context refreshes instead of reading history on every token.
`invalidateNativeHistory` makes externally recorded native messages available
on the next history read; live voice projections use their scoped capability.

Optional `clientMetadata` contributes bounded initialization metadata. The
distribution may advertise a client-bound, read-only migration resource; the
generic host does not import old client state, drafts or browser storage.

## ACP projection fidelity

Standard ACP text/reasoning, tool calls, offered permissions, plans, resources,
filesystem/terminal callbacks and mode/config updates project through ordinary
AHP actions. Tool update fields replace their prior values: `rawInput` objects
are never concatenated into malformed JSON, and omitted completion fields retain
previous tool content. A pending permission stays pending when input changes.

Idle `session_info_update` values are preserved, and title changes update the
session/catalog. Opaque `available_commands_update` lists and context-window /
cumulative-cost `usage_update` reports have full replacement semantics under
session `_meta['amplifier.dev/acp']`. They are not invented file-backed AHP skills
or mislabeled turn token counts. Supplied experimental ACP `PromptResponse.usage`
reports map matching AHP `chat/usage` fields; unmatched counters and the original
report remain in usage `_meta['amplifier.dev/acp']`. Clients may render this
explicit metadata when supported. This does not claim vendor-specific ACP
extensions or provider authentication UI are implemented.

Session-only metadata updates do not serialize or rewrite the active transcript
checkpoint. Tool and text state changes append authoritative reducer actions;
completion writes the retained turn once.

## Scheduled and source-configured admission

`inspectSession(uri)` reads selected metadata without starting an agent, including
`executionRevision`, `interruptionRevision` and `configurationHash`. Revisions
are durable and shared with standard user turn, cancellation and configuration
actions. The hash describes host-observed configuration and the trusted engine
configuration; it does not claim detection of arbitrary out-of-band native edits.

`submitScheduled(uri, {commandId, text, taskId, taskRevision, kind,
expectedExecutionRevision, expectedInterruptionRevision,
expectedConfigurationHash, scheduledRunId?})` compares all three expected values
inside the ordinary session admission lock. `kind` is `task` or `monitor`.
Its `{accepted:true, turnId, receipt}` confirms durable **host admission**;
`waitForTurn` or the receipt supplies the later conclusive native result.
The negotiated native `schedule.submit` validates saved task revision, idle state
and continuation policy, emits normal ACP updates, and returns only on settlement.
A pre-execution native rejection becomes a failed receipt; uncertain transport
outcomes become unknown. No path substitutes an ordinary prompt, resends an input,
or bypasses stop ordering. Generic engines without this extension refuse it.

`createSession({commandId, idempotencyKey, sourceSession,
expectedConfigurationHash, title?})` captures an opaque native configuration
reference, reserves a stable destination identity and uses the same creation
path as standard AHP `createSession`. The native storage owner clones the exact
configuration into the same workspace; no transcript, tasks or goals are copied.
Configuration references and actual engine state remain behind ACP. Completed
identical calls return `{uri, creationConfirmed:true, receipt}`; changed arguments
or uncertain creation never trigger another native creation. Native configuration
cloning must be explicitly advertised. These APIs are trusted capability-provider
seams, not new unguarded network methods.

`readSessionContext` includes stable IDs, input provenance, creation time and an
explicit truncation marker. It reads at most 50 selected messages; callers cannot
treat missing older authorization as proof that authorization never existed.

## Verification boundary

The tests use the official AHP TypeScript client and an independent JSON-RPC ACP
fixture process. They cover two viewers, zero-viewer continuation, ordered
streaming, permission ownership, cancellation completion, duplicate/unknown
admission, restart, snapshot/replay recovery, directory authorization, DNS
rebinding, injected slow-transport pressure, terminal output, client tools and
narrow streaming writes. The real cross-component passive-history test is enabled
with `CATALOG_EXECUTABLE` and `ACP_EXECUTABLE`; it uses an intentionally unavailable
bundle to prove that browsing does not prepare a native runtime.

The extracted React client has separately exercised browser -> this host -> ACP
fixture streaming and approval. Real-account Copilot/Codex/Claude execution,
production Spark load, native model execution and physical-device media are not
established by these tests. Advanced queue/steer/automation, voice, Canvas, publishing
and native composition UI require their registered capability owners. Unsupported
core methods/actions fail explicitly; copying UI components is not feature parity.

The official package lock records AHP SDK 0.9.0 and ACP SDK 1.5.0. ACP wire version
is 1, independently of SDK package numbering. Upstream schemas/reducers are used
without a private fork.

## Worktree relocation ownership

`inspectSession(uri)` separates immutable `historyHome` (the canonical original
workspace used for native history lookup) from `executionDirectory`. Its
`executionRevision` is the host admission counter; `nativeLocationRevision` is
the adapter's independent location revision. Catalog project membership and AHP
canonical working-directory metadata remain at the original history home.

Trusted composition providers can call
`relocateSession(uri, {commandId, target, expectedExecutionRevision})`. The target
must be an existing authorized directory, and the negotiated native adapter must
prove the same Git repository and quiesce its writer before remounting. A durable
host reservation precedes the native relocation. Success returns
`{applied:true, historyHome, executionDirectory, executionRevision, receipt}`;
known pre-admission refusal returns `{applied:false, executed:false, reason}`.
Post-admission uncertainty throws with `error.data = {receipt, outcome:'unknown',
executed:true}` and fences all subsequent session execution. No relocation or
prompt is automatically replayed after restart.

An explicit new command may add `reconciles: priorReceiptId` and bounded
`evidence`. Reconciliation reads the native durable location proof without
mounting a worker and commits only an already proven outcome. It cannot repeat
a move or clear an unresolved native remount marker. Source configuration cloning
preserves both directory identities through an opaque native snapshot; ordinary
ACP agents without this negotiated capability receive a known refusal.

`directoryInUse(path)` checks indexed host history/execution references and
unresolved source/target reservations, plus the independent catalog. Explanations
are bounded to 100 rows. `withDirectoryGuard(path, callback)` performs the same
check while excluding concurrent host create/relocate admissions. The callback
may perform Git/filesystem removal only and must not reenter host mutations.
Catalog-backed deletion requires complete, issue-free discovery evidence no
older than ten minutes. This is a cooperative-host guard, not proof against an
undiscovered or noncooperating external process; no filesystem scan or transcript
read is substituted during a query. The capability owner retains its own durable
Git removal receipt and explicit handling for an unknown filesystem outcome.

`withSessionWorkspace(session, {expectedExecutionRevision?, expectedDirectory?},
async captured => ...)` authorizes the selected execution directory and holds only
that session's relocation/admission mutex through trusted bounded source-capture
I/O. The immutable callback value is `{session, engineId, nativeSessionId?,
historyHome, executionDirectory, executionRevision}`. Stale expectations and an
unresolved relocation fence reject before invoking the callback. Omitting the
expectations captures the current mapping, which is useful when a capability owner
is only inspecting its existing receipt after the session moved.

The callback must impose its own byte/time limits and must not reenter host mutation
or admission APIs. The lock is held until its promise settles, including failure;
a timed-out caller cannot assume its still-running I/O released the mapping. The
host does not freeze external filesystem edits or an already-running agent, and
this guard is not an immutable file snapshot. Publishers must independently capture
content/version evidence and use their own durable effect receipts. Other sessions
remain available throughout the capture.

`readUserMessage(session, messageId, {maxBytes?})` selects one indexed host input,
including an input older than the recent 50-message context window. Success returns
the complete raw message plus `id`, `role`, `createdAt`, normalized `inputOrigin`,
question/schedule/voice identifiers and `provenance`. The default bound is 64 KiB
for the complete message; callers may explicitly request up to 1 MiB. Text and
attachments are never silently truncated for an authorization decision.

`MessageUnavailableError` is exported with numeric code `-32012` and
`data: {available:false, reason, session, messageId}`. Reasons are `not-indexed`,
`not-user`, `oversized`, or `invalid-provenance`. A missing host index entry is not
proof that no native message exists. This API never searches recent pages, starts
an agent, or scans native transcripts. Callers must refuse unavailable provenance;
legacy native lookup requires a separate storage-owner index/capability.

A role label alone is not proof of human authorization. The returned observation
preserves scheduled/question/voice provenance and the original admission client and
status when present. Unadmitted projections default to `inputOrigin: 'unknown'`
unless recorded provenance explicitly identifies another origin. Consumers must
apply their own authenticated actor, timing and content policies to this evidence.

## Background work and runtime loss

A settled prompt is not proof that its agent has no owned background work. Idle
capacity eviction requires negotiated native
`lifecycle: {version:1, gracefulRetire:true}` and a successful atomic
`_amplifier/retire` response. The native owner must refuse while jobs, processes,
approvals, bridge requests or auxiliary work remain; success permanently retires
the native session handle before the host closes its ACP connection. The host holds
the session admission lock through this decision and retains its own running ACP
terminals. Refusal, unsupported capability or a missing response retains the agent;
new capacity is refused rather than killing that work. Generic ACP peers without
this explicit retirement proof are not automatically evicted from the configured
active-agent bound. Explicit host shutdown remains a separate stopping operation.

`HostConfig.agentStopped(event)` notifies capability owners of actual native runtime
closure or ACP process loss. The exported `AgentStopped` includes session/native
identity, engine, execution directory and observed stopping reason. A prompt's
completion never emits this callback. Native runtime/process observations are
deduplicated for that lifetime, and a subsequent `runtime.ready` starts a new one.
Owners must make handling idempotent and mark affected live operations interrupted
rather than assuming completed. Callback failures are visible in
`diagnostics().agentStoppedFailures`; pending callbacks are drained on host close.
