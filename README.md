# Amplifier Unified Host

A standalone TypeScript host implementing AHP 0.9 over WebSocket and stable ACP 1
over agent stdio. Its execution path has no imports from Amplifier Core,
Foundation, the Unified application service, or the separate `amplifier-agent`
library. The Amplifier engine is provided by the independent `amplifier-acp`
adapter over the full native Core/Foundation application runtime.

See the local [vision](docs/VISION.md) and versioned [host boundary contract](docs/contracts/host-boundary.v1.md) for inherited direction, public promises, falsifiers and acceptance links.

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

Standard ACP select configuration projects to the existing generic `enum` and
`enumLabels` fields. Each schema property also retains the exact standard
`options` array (including groups, group IDs and choice metadata), optional
`category`, and nested option `_meta`. Rich clients can render those typed fields
without interpreting display labels. Vendor metadata never replaces schema type,
enum or mutability. Complete ACP option updates replace the prior selector list.

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

Already-started agents use a bounded recent-agent cache: eight resident or
admitted starting sessions by default. Selected session/chat subscriptions give
retention priority without starting a cold agent. Unreferenced idle entries get
fifteen minutes of grace; capacity pressure evicts safe unreferenced entries
first, then safe selected entries, using real use/settlement LRU in each tier.
Active work, approvals, unresolved outcomes and Native-owned work remain
protected. If no safe slot exists, new startup is refused.

Grace and use order renew at actual request dispatch and settlement, including
standard/legacy configuration, clone snapshots, cancellation, steering and
refused relocation. Startup renews after its initialization projections; turn
settlement renews after the final catalog projection and update join. Validation
failures, subscriptions, pings and known Native inspection/login-status polls
do not renew use. Snapshot controls persist state and count as use; generic
Native controls exclude exact known read contracts rather than guessed suffixes.
Steering acceptance timeouts retain their unknown receipt and protect the
underlying request until it settles, without replaying the input.

Host requests connection-scoped lifetime ownership at ACP initialization. Only
an exact negotiated acknowledgement suppresses Native's independent idle timer.
Generic or unacknowledged peers keep their own lifetime behavior; retaining the
ACP connection does not promise their inner runtime stays warm. Diagnostics
report managed/unmanaged counts. See [runtime retention v1](docs/contracts/runtime-retention.v1.md)
for negotiation, grace, pressure and validation boundaries. `idleAgentMs` remains
a server-side override; there is no selection-triggered preparation or UI setting.

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

Tool inputs and results larger than 4 KiB use standard AHP content references.
Snapshots retain their outcome and position; `resourceRead` returns the exact
saved body when requested. Result resources use
`application/vnd.amplifier.tool-result+json` to preserve the whole public result
envelope, including structured output and content blocks. Pending permission
arguments remain inline so the complete reviewed input is immediately available.
Content writes are atomic and reads verify the URI's SHA-256 digest. These are
derived projections; native history stays authoritative. This bounds large tool
bodies in snapshots, not native history indexing or the number of execution nodes.

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

## Generic canonical title metadata

A configured engine may provide `sessionMetadata: {readTitle, writeTitle}`. These
trusted ports receive the Host-selected session, engine, Native identity if mapped,
and canonical history working directory. They read or persist metadata passively;
they must not start an execution runtime or model. An adapter is authority for its
opaque `titleRevision`; Host does not interpret engine naming policy. Native
metadata persistence and original-command receipts remain with that engine.

`readSessionTitle(session)` returns `{title,titleRevision,metadata?}` without
mounting an agent. `commitSessionTitle(session,{commandId,expectedTitleRevision?},
persistCallback)` checks that revision under the existing selected-session lock
before calling trusted persistence. Generation belongs outside this lock. A stale
revision returns `applied:false` without calling persistence. Callback context
contains the selected mapping, current snapshot and original command identity.
A confirmed callback returns `{applied,title?,metadata?}`.

Ordinary AHP manual title actions use the same lock and pass a stable command ID
derived from their original session/client/sequence to `writeTitle`. Persistence
completes before AHP projection. Host rereads the current adapter snapshot after
a write or callback so a historical successful receipt cannot restore an old
title over a newer edit. Unknown writes do not emit optimistic success and are
not automatically replayed. ACP title notifications reconcile this same current
authority instead of projecting potentially stale stream values.

Snapshot metadata projects under session `_meta['amplifier.dev/sessionMetadata']`
via standard `session/metaChanged`; vendor keys cannot replace Host-owned metadata.
A policy-only callback omits title and produces no title action or title revision
increment. External ACP engines without an adapter retain standard title actions;
a title-only counter in existing session metadata supports generic CAS without a
new table. Titles are bounded to 1,000 characters, revision/command tokens to 200,
and metadata to 64 KiB. Adapter owners may enforce stricter engine limits.

These generic methods do not advertise naming. Composition must verify the actual
selected engine adapter, genuine engine capability marker and complete trusted
bridge ports before exposing an engine naming feature. Host fixtures qualify its
source/package boundary; Native, bridge, browser and account acceptance are separate.

## Background work and runtime loss

A settled prompt is not proof that its agent has no owned background work. Idle
capacity eviction requires negotiated native
`lifecycle: {version:1, gracefulRetire:true}` and a successful atomic
`_amplifier/retire` response. The native owner must refuse while jobs, processes,
approvals, bridge requests or auxiliary work remain; success permanently retires
the native session handle before the host closes its ACP connection. The host holds
the session admission lock through this decision and retains its own running ACP
terminals. A definite `owned_work` or `active_request` refusal retains a usable agent.
Unsupported capability retains the agent. Missing, malformed or uncertain
retirement responses retain the connection but fence new execution before
admission; they never authorize killing work or retrying the retirement. A
`runtime.closed` worker notification alone does not prove session retirement.
New capacity is refused rather than killing retained work.

An optional `lifecycle.retirementStatus: {version:1,
method:"_amplifier/retire/status",passive:true}` permits one bounded passive
`{sessionId}` read on the same existing connection. The response must identify
that exact session and return `retired:true` only after Native correlates the
literal worker retirement acknowledgement with the same captured worker clean exit 0. It must never start,
retire or close a worker, change history, or execute input. Host closes the old
connection only on this proof. `reconcileSessionRetirement(session)` exposes a
trusted selected-session recheck; a new original input also performs one read
when it encounters the fence. Unsupported, false, malformed, wrong-identity or
missing proof retains the fence. Any prior unknown input receipt remains unknown
and is never resubmitted. After confirmed retirement a new input resumes the same
Native identity through ordinary ACP load/resume. Generic ACP peers without
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

Negotiated `features.operations` also permits bounded `operations.observe` callbacks
from the currently bound native runtime after its foreground prompt settles. This
exception grants no idle dispatch, context or other host capability access. The host
limits pending observation count and bytes; the operations owner still validates the
reported runtime and event producer before recording them.

## Passive Recall source access

Independent indexing owners use `listRecallSources({session, scope, cursor?, limit?})`
with `scope: 'task' | 'workspace' | 'all'` and at most 25 root sources per page.
The catalog supplies indexed metadata and freshness; the standalone fallback reports
`host-owned-only` coverage. Listing never starts an ACP peer or reads history.
Child/internal sources are not advertised. Exact source reads authorize its existing
canonical history workspace; execution worktree changes do not move its history.

`inspectRecallSource(id)` returns `{id,title,workspace,kind,revision,limits,coverage}`.
It requires negotiated native `history.passiveInspect`, whose storage owner performs
only a source stat. `readRecallSource(id,{expectedRevision,cursor?,limit?})` returns
`{rows,revision,nextCursor?,limits,coverage}` from one complete-turn page, at most
50 turns, 1000 message rows and 2 MiB. Cursors are bounded and scoped to source and
revision. Unsupported/missing sources, changed revisions and oversized pages fail
explicitly; there is no eager history fallback or truncated successful message.
An index owner must inspect the revision again before committing its derived index.

Rows retain native stable message IDs and recorded user/assistant text. Tool,
reasoning and binary updates are omitted with an explicit `omittedUpdates` count.
Native rows always carry `sourceKind: 'native-history'` and
`authorization: 'unverified-native-history'`; missing input origin is `unknown`.
Imported conversation text is never substituted for `readUserMessage` admission
provenance. This seam does not mount a worker, request a model or mutate native files.

## Public offline fixture and CI

After installing/building this package, run
`node examples/offline-host.mjs /absolute/workspace /private/owned-state 8765`.
It starts this public host against the packaged independent JSON-RPC ACP echo peer
(`fixtures/acp-peer.mjs`); it makes no model/account calls. The fixture supports
streaming, permission choices and controlled failures for web/TUI/protocol acceptance.
The optional example browser origins are loopback Vite ports 5173 and 5179. Use a
private disposable state directory, stop the process when done, and configure real
engines through the production CLI separately.

The checked-in CI runs type checks, all offline tests, build and package creation.
Native/catalog integration tests require explicit `ACP_EXECUTABLE` and
`CATALOG_EXECUTABLE`; Core/Foundation execution tests additionally require the
owned fixture configuration variables documented in the integration test. Skipped
native tests are not native-runtime or real-account qualification.

## Question answer admission

`submitQuestionAnswer(session,{commandId,text,questionId,questionRevision,
answerProvenance})` uses the same durable admission and ACP stream as normal turns.
It requires negotiated native `questionTurns: {version:1,completion:'settled'}`;
the native owner verifies the exact saved answer through `questions.delivery.admit`
before execution. Both host input metadata and canonical native history retain
`inputOrigin:'question'`, the question revision and bounded answer provenance.

A known busy/unavailable preflight returns `{accepted:false,executed:false,reason}`.
Host admission returns `{accepted:true,turnId,receipt}`; `waitForTurn` observes its
terminal completed/failed/cancelled/unknown outcome. A lost response is unknown and
a reused command never repeats delivery. Generic `nativeControl('question.submit')`
is refused. In-flight answers to a waiting dependent turn require a separate native
steering lifecycle and are not faked by a competing prompt collector or idle queue.

## Standard pending-message queue

The host implements AHP `chat/pendingMessageSet` with `kind:'queued'`,
`chat/pendingMessageRemoved`, and `chat/queuedMessagesReordered`. Connected clients
and trusted capability owners (`updatePendingQueue(session, action, {clientId})`)
share the same durable queue and session admission mutex. Upserts edit a pending
message in place; reorder retains IDs omitted by stale clients. Drafts remain local.
Limits are 50 messages / 1 MiB of stored message payload per session, and 1024 /
16 MiB across pending queues. Consumed/removed identities leave small tombstones
without message text and cannot be resurrected or used as a bypass prompt ID.

An idle explicit queue submission starts through ordinary admission. A running turn
advances the queue only after a confirmed `end_turn` without a cancellation request.
The resulting standard `chat/turnStarted.queuedMessageId` consumes the pending item;
its durable receipt and queue consumption commit together before native delivery.
A crash in the subsequent projection gap removes that pending display on recovery
and leaves the receipt unknown, without repeating delivery.

Cancel, non-normal completion, uncertain outcome and host restart preserve pending
messages in a held state. Each published message carries
`_meta['amplifier.dev/queue']:{held:true,reason}`. An explicit upsert re-arms that
individual intent; reorder alone does not. A prior unknown execution still blocks
admission. Newer messages do not silently pass a held head item. Host shutdown
prevents automatic draining. Active steering remains unavailable until its separate
native in-flight acknowledgement contract is qualified.

## Typed observation admission

`submitObservation(session,{commandId,watchId,taskId,taskRevision,outcome,
expectedExecutionRevision,expectedInterruptionRevision,expectedConfigurationHash})`
requires the same atomic expected host revisions as scheduled work. `outcome` is a
bounded JSON object (64 KiB), not prompt text. Native `observationTurns` negotiation
must advertise settled completion; the native watch authority, active task CAS,
finite iteration and tool denial remain in force. The host projects this as a
standard `systemNotification` message with `inputOrigin:'observation'`, and exact
user-consent lookup rejects it as non-user. It is never routed through an ordinary
prompt, even when the engine lacks the extension. Known busy/stale preflight refuses
without execution; terminal refusal, completion or uncertainty is recorded in the
same durable receipts observed by `waitForTurn`. Duplicate IDs never replay.

`HostConfig.turnSettled` receives `{session, commandId, status, inputOrigin}`
after an actually dispatched turn's durable receipt settles and the admission
mutex has been released. It is a best-effort signal for bounded owner work such
as incremental Recall indexing, independent of viewers and streamed deltas.
It does not assert that background operations stopped. There is no startup
replay. At most 64 callbacks can be pending; failures and capacity drops are
reported by `diagnostics()` as `turnSettledFailures` and `turnSettledDropped`.
Callbacks may use public host APIs and must complete their own bounded work.
Shutdown drains already accepted callbacks. `readSessionContext` includes the
current admitted active input in its bounded selected window; provenance checks
still use exact `readUserMessage`, never a truncated context row.

`readTaskState(session, {expectedRevision?})` reads the selected agent's persisted
task through negotiated `taskState` passive inspection. It never resumes a
runtime, scans history, or invents an empty task for an unavailable source. The
result preserves `{available, revision, task, source}` from the native storage
owner, enforces a 32 KiB task bound, and rejects a changed expected revision.

Standard `chat/pendingMessageSet` / `chat/pendingMessageRemoved` with
`kind:'steering'` use the same trusted `updatePendingQueue` entrypoint as user
and agent capability owners. This requires the selected native agent's
`activeSteering` v1 request-boundary capability. A pending message can be edited,
replaced or removed before consumption. While idle it stays on disk without
starting a runtime. Once a generation starts, the host captures its immutable
turn/generation identity, durably reserves the input ID and appends a standard
`systemNotification` containing `Steering submitted: ` plus the exact original
text in that same turn. The notice and receipt commit before its publication,
pending-message removal, and negotiated `steer.submit`. Its
`amplifier.dev/steering` metadata contains only `inputId` and `activeTurnId`;
submission does not claim application or a physical Native history identity.
It never starts a second prompt collector. The mounted loop may still refuse an
unsupported provider mode; no legacy steering fallback is used.

Applied, held and unknown native outcomes map to durable completed, failed and
unknown command receipts, respectively; the receipt detail retains the steering
disposition. After consumption, replace/retract is unavailable because the
underlying loop cannot prove withdrawal. Duplicate IDs never replay. Pending
steering targeted at a cancelled/ended turn is held and cannot silently migrate
to a later turn. Restart also holds pending input; uncertain delivered input
fences execution. An explicit edit can re-arm an unconsumed held intent. A new ID
is needed for a distinct request after a consumed intent. Exact message lookup
preserves admitted steering provenance, and bounded selected context includes
confirmed applied corrections. Bounded explicit idle history refresh retains the
whole live response when any admitted steering original lacks a matching
canonical user steering descriptor (Native input v1, exact ID, original turn,
and exact text). Fully matched turns can refresh independently. The reply reports
`retainedTurns` and `unresolvedSteeringInputs`; clients resubscribe to the selected
view. No required history is fabricated or discarded.

Pending steering is bounded by 1,024 intents / 16 MiB globally and one editable
pending message per chat. At most 16 delivery calls and 50 unconfirmed steering
inputs can belong to an active turn. Identities/receipts remain on disk; restart
never replays them. Provider-native steering, attachments in steering, and
retraction of consumed context are explicitly unsupported until their effect
and attribution contracts are available.

A normally completed parent response may precede the loop's final held-steering
event. The host keeps that steering receipt pending, blocks subsequent admission
and idle retirement, and accepts the matching later disposition. It does not
infer application or loss from the parent response. Missing acceptance or terminal
proof reaches an explicit unknown outcome after a bounded deadline (10 seconds
default, `steeringOutcomeTimeoutMs` up to 60 seconds); native runtime/process loss
also produces unknown. Neither outcome replays input. `steeringDispositionPending`
in diagnostics counts outstanding post-turn proof deadlines.

Observation delivery requires the exact resident native worker. Admission never
starts or revives a worker to explain an observation. A known absent worker
returns `accepted:false, executed:false, reason:"waiting_worker"`. If native
retirement wins after host reservation, `waitForTurn` returns `status:"failed"`,
`executed:false`, `retryEligibility:"waiting_worker"`, and `observationAdmission`.
Only this explicit no-effect outcome permits the identical input ID and typed
payload to be admitted again. Previous attempts remain in the durable indexed
receipt archive; unknown outcomes never permit retry. Callers must refresh and
validate host revisions before an exact retry.

During typed delivery, `inspectSession.observationAdmission` identifies the exact
input/watch/task/revision/outcome digest, expected configuration/interruption/
execution revisions, admitted execution revision, and `status:"dispatching"`.
The admitted revision is exactly the pre-admission execution revision plus one.
This proof lets a policy owner distinguish its own admission bump from unrelated
user work; it does not prove native execution. The same proof is retained on the
receipt and returned with explicit retry eligibility. Observation chat projection
begins only after native input acceptance or execution evidence, so a refused
attempt never becomes a fictitious turn or duplicates a turn ID on connected
clients.

## Canonical session lifecycle

Initialization advertises `amplifier.dev/sessionLifecycle` v1 and the negotiated
`x-amplifier/sessionLifecycle` method. Parameters are `{channel,operation,args}`.
The selected agent must additionally advertise its native passive lifecycle.
`inspect`, `delete.preview`, `fork`, `export`, `delete`, `restore`, and `receipt`
map to the public host methods `inspectSessionHistory`, `previewDeleteSession`,
`forkSession`, `exportSession`, `deleteSession`, `restoreSession`, and
`inspectSessionLifecycleReceipt`. Fork/export/delete/restore require a stable
`commandId` and exact `expectedHistoryRevision`; fork optionally accepts a native
user `throughMessageId` and a host title. This is an actual canonical history fork,
not the separate configuration-only `createSession` API. Native task, job and
runtime authority is not cloned.

Mutations hold the selected session admission lock and ask the native owner to
retire idle work atomically. Busy or owned background work refuses; no process is
killed to acquire the history lease. A durable host reservation precedes the
native mutation. Unknown responses fence source and reserved destination; the
`receipt` operation can recover a completed native receipt without resending its
mutation. A restart preserves this fence. History and event logs remain native
owned. Delete requires the native preview token and removes the session from
discovery while preserving canonical files. Restore requires native confirmation.
Hard deletion is not advertised. Standard `session/isArchivedChanged` is shared
organization and survives subsequent turn status changes.

Exports contain public native conversation text/references with explicit omissions,
not portable execution archives. The returned host-issued `resource` supports
standard `resourceRead` with URI query `offset=<byte offset>&limit=<1..65536>`.
Its UTF-8 JSON body is `{data,encoding:"base64",offset,nextOffset,contentHash,
mimeType,totalBytes}`. Concatenate decoded bytes before UTF-8 decoding and verify
the full SHA-256 `contentHash`; `nextOffset:null` denotes EOF. This avoids adding
fields to the upstream `ResourceReadParams`. No storage path reaches clients.

`history.revise` maps to `reviseHistory(session,{commandId,operationId,
targetMessageId,expectedHistoryRevision,text})`. It admits one idle replacement
turn through the same durable execution boundary. The native owner resolves the
canonical boundary, rewinds its own context/checkpoint, and confirms the rewrite
before the host emits standard `chat/truncated`, a bounded retained
`chat/turnsLoaded` prefix, then the replacement `chat/turnStarted`. Superseded
host projections are archived, receipts and native event logs are preserved,
and an unknown rewrite never repeats input. The selected prefix is prepared
passively before mutation; clients with different history windows converge.
Older retained prefix pages use exact native boundaries and fresh revision checks.
A bare client `chat/truncated` is not permission to rewrite native history.

## Committed prompt resources

`HostConfig.resolvePromptAttachment(context,attachment)` optionally resolves a
committed resource reference to ACP blocks. Context contains the exact session,
engine ID, native session ID when known, and authorized execution directory.
Resolution runs only on new execution, before command admission; it never runs
while rendering snapshots or storing queued intent. `undefined` preserves an
ordinary ACP resource link. Each attachment yields at most sixteen blocks and
the aggregate resolved ACP prompt is limited to 8 MiB encoded. Immutable file
links require an explicitly configured shared-filesystem owner; generic remote
agents cannot assume host paths. The original AHP resource references remain in
history. Standard AHP 0.9 `resourceWrite` returns `{}`; upload progress belongs to
the registered owner's resource contract.

## Trusted session transfer ownership

The optional library boundary uses `transferIdentity` (the configured local
TransferNode Ed25519 public-key SHA256 fingerprint), never a browser-provided host
identity. Engines must advertise native `transfer` v1 with passive inspection.
The portability owner verifies its signed envelopes; the host independently
fetches persisted native proof and the actual Foundation writer fence.

- `beginTransfer(session, {commandId, transferId, destination,
  expectedExecutionRevision})` durably fences host admission before quiescing the
  resident worker and asking native `source.fence` to acquire real writer ownership.
- `commitTransfer(session, {commandId, transferId})` requires a confirmed source
  fence and the native signed release phase. A committed source never resumes.
- `cancelTransfer(session, {commandId, transferId})` clears admission only after
  native confirmation of the exact unreleased cancellation and absence of its fence.
- `inspectTransfer(session, transferId)` reads persisted proof without a worker or
  repeated mutation. It can reconcile confirmed native outcomes and retry only
  idempotent catalog synchronization, never execution, capture, transfer or probes.
- `adoptTransferredSession({session, commandId, transferId, engineId,
  nativeSessionId, historyHome, executionDirectory, source, destination,
  releaseHash, title?})` preserves the original AHP URI from the verified signed
  envelope and the native ID. The native activated receipt must independently match
  all identities, paths, destination and release hash; no writer fence may remain.
  Existing AHP identities mapped to another native session are never overwritten.

These are trusted composition APIs, not unqualified browser mutations. Transfer
IDs are canonical UUIDs; fingerprints are lowercase 64-character hex. Source
history remains in place. Uncertain admission or metadata handoff stays durably
fenced across host restarts. Exact completed command retries return their receipt;
unknown attempts require explicit inspection and cannot be replayed. Workspace
capture, runtime controls, relocation and execution share the selected session
admission boundary; unrelated sessions remain responsive. This does not freeze
external filesystem edits or grant authority over a noncooperating writer.

A selected session removed from discovery retains readable history and carries
`state._meta['amplifier.dev/lifecycle']={version:1,deleted:true,...}` via standard
`session/metaChanged`; confirmed restore changes `deleted` to false.

`refreshSessionHistory(session,{limit?:1..50,expectedHistoryRevision?})`, also
`x-amplifier/sessionLifecycle` operation `history.refresh`, explicitly loads a
bounded canonical native page and verifies its revision. Only stable-ID-matched
host turns with completed receipts receive saved native response boundaries;
admission outcomes, input provenance and original attachment references remain
host-owned. Active or unknown execution refuses the refresh. The result contains
`{refreshed:true,chat,revision,refreshedTurns,view:{turns:limit},requiresSubscribe:true}`.
The requesting client then obtains a fresh standard subscription snapshot. Existing
viewers keep their current projection until they request a fresh snapshot; no fake
truncation action, native rewrite, global reload or text-based identity match occurs.

Mixed native/host history uses canonical native turn order and exact turn IDs to
retain host receipt outcomes and input provenance. A requested view is one merged
window, rather than one native window plus another live window. The native reader
looks behind at most twice the requested turn count to find exact ordering anchors;
completed host rows are looked up by indexed ID. A shared window can expand through
another subscriber's larger view, explicit older-history paging, and new completed
turns; it is released after the last subscriber leaves. These are AHP advisory views,
not a promise to discard already-delivered turns from another client's reduced state.

Merged cursors verify the exact prior suffix and native revision before publishing
an older prefix through `chat/turnsLoaded`. Paging reprojects the explicitly expanded
selected window; it is not a per-delta transcript path. Omitting a view still returns
all retained turns. A native-only tail with no shared ordering anchor, or a native
and host-only receipt in the same unindexed interval, returns an explicit
`unindexed-ordering-boundary` error. No timestamp/text guesses or full-history scan
are substituted for a bounded request. Widening the explicit view may establish an
anchor; genuinely unmatched failed/unknown receipts require native-owner ordering
provenance. Both sources and admission receipts remain preserved.

## Indexed coordination callbacks

Trusted coordination owners use these public interfaces; they do not inspect the
host database or load global/native transcripts:

- `listCoordinationSessions({cursor?, limit?:1..100})` returns `{items,nextCursor,
  coverage}`. Items contain `uri,title,status,activeTurnId?` and execution,
  interruption/configuration revisions. Coverage is **host-indexed**, excluding
  unselected catalog history. Workspace authorization is filtered before paging;
  existence is last-admission evidence, not a fresh filesystem scan of every row.
- `readCoordinationSession(uri,{afterSequence?:0,limit?:1..32})` returns
  `{available,reason?,session,status,activeTurnId?,revision,latestSequence,results,
  hasMore,approvalIds,attentionUnknown,attentionCoverage,coverage,...revisions}`.
  Each indexed result has `{id,inputId,sequence,text,sourceTruncated,window:'head',
  source:'host-indexed-result',state}`. Text previews are at most 20,000 UTF-8 bytes
  plus a possible replacement character at the byte boundary. Stable sequences are
  scoped to the session. They describe host assistant results, not canonical native
  message IDs. Existing pre-index rows are an explicit `legacyGap`; imported native
  history is explicitly omitted. No read-time transcript reconstruction/backfill
  hides that gap. Questions belong to the separate question owner, so attention is
  conservatively unknown even if no standard host approval is pending.
- `readCoordinationWorkers(uri,{workerId?,cursor?,limit?:1..100,afterSequence?,
  resultLimit?:1..32,commandId?})` requires the native `workers` v1 capability and
  reads `_amplifier/workers` using the bound ACP connection when available, or a
  passive process otherwise. Native `resident` evidence is distinct from ACP
  process presence. Reads never call resume or mount a dormant worker. Native
  durable `worker.followup` / `worker.interrupt` use `nativeControlExisting` and
  their exact native command receipts; passive inspection also reads those receipts.
- `submitTurn(uri,{commandId,text,clientId,origin:'agent'})` uses common admission,
  an AHP agent origin, and `amplifier.dev/input.inputOrigin='coordination'` on the
  native prompt. It cannot become a user-consent record or a user Recall trigger.
  Explicit UI follow-ups retain the default user origin. A WebSocket client cannot
  forge the trusted agent-origin admission path.
- `interruptSession(uri,{commandId,turnId,clientId,origin?:'agent'|'ui'})` reserves an
  exact interruption receipt and targets only the current admitted turn. A completed
  control receipt means `delivery:'requested'`, not that execution stopped; inspect
  the original turn through `waitForTurn`. Unknown delivery never retries, duplicate
  commands return their receipt, and a cold/nonmatching turn is a known no-effect
  refusal. It shares the ordinary standard cancellation path and never mounts.

`inspectExportResource(uri, expectedSession)` returns immutable persisted export
metadata plus its verified selected `session`, without reading any native body. It
requires recorded `summary.format`, `scope`, and `minimal`; older incomplete export
metadata is explicitly unavailable. Byte reads remain separately bounded through
`readExportResource` and verified against `contentHash`.
# Request concurrency

The connection handshake is a barrier. Standard resource actions and subscription
changes retain their per-resource order. Advertised capability RPCs and independent
receipt/catalog/resource reads run concurrently after that barrier; a long wait
cannot block the same client's control or receipt request. Capability owners retain
their durable command admission and compare-and-set responsibilities. Clients must
await a result when a later request depends on its effect; wire response order is
not an effect-ordering guarantee. The per-peer in-flight request limit still applies.

`host.diagnostics()` exposes aggregate working-set, cursor, queued-intent and
retained-replay counts/bytes for qualification. It contains no session IDs or
history payloads. Selected native turn-ID windows disappear after their last
subscriber leaves; cursor caches retain at most 4,096 entries per cursor kind.
Calling diagnostics queries small indexed host projections and never asks a native
agent for history or starts an execution worker.

`StdioCatalog` also exposes the public workspace metadata projection methods
`listWorkspaces`, `getWorkspace`, `projectWorkspaces`, and
`workspaceProjectionStatus`. Optional workspace owners use these bounded catalog
RPCs for shared registration/visibility; the host does not own workspace folders
or mirror client selection. Native history and filesystem creation remain with
their respective owners.

# Held quiescence for restart and recovery

An optional trusted `HostConfig.quiescence` closes execution intake before checking
work. It is a supervisor/library API, not a browser-provided readiness claim.
With resident agents, Host confirms their atomic retirement and joins existing
stop callbacks before acquiring external writer exclusions. Public intake stays
closed throughout; cleanup/result continuations gain no general mutation admission.
The final held receipt follows a fresh work check with every required owner held.
With no resident, the existing pre-retirement owner acquisition path remains.
Retirement also uses the configured quiescence observation deadline. If process
stdio or its callbacks remain open, admission returns an unknown closed fence;
the deadline never proves process completion. Late close does not promote that
original admission or authorize another retirement. Exact retries inspect its
receipt. Settling such a fence requires separately reviewed maintenance recovery;
Host storage remains open until shutdown callbacks actually finish.
Configuration includes the actual launch `instanceId`, exact `dataScope`,
`requiredOwners`, `coverage`, `participants`, and authenticated `verifyRelease`.

```ts
const result = await host.admitQuiescence({
  commandId: durableJobId,
  purpose: 'distribution-update', // or 'recovery'
});
if (result.admitted) {
  // result.fenceId and result.commandId identify this exact durable intake gate.
  // result.evidence: {activeWork:0, intakeClosed:true, instanceId, dataScope, observedAt}
}
```

Known busy/no-effect admission returns `{admitted:false,executed:false,
intakeClosed:false,reason,work?}`. Unknown acquisition, retirement, or release keeps
`intakeClosed:true` and `fence.phase:'unknown'`. Retrying the same command reads its
receipt by default. Explicit `retryRefused:true` re-evaluates only an exact prior
`{admitted:false,executed:false,intakeClosed:false}` when no gate exists; the prior
refusal is archived before reserving a fresh fence under the same command. Held,
unknown, releasing, released and uncertain receipts never reacquire this way. `inspectQuiescence()` and
`quiescenceReceipt(commandId)` are passive exact inspections. An existing gate
survives process replacement, including a replacement accidentally omitting this
configuration; it never opens on a timeout or restart.

`coverage.capabilities` maps execution-capable manifest topics to owner IDs;
`coverage.resources` maps writable URI schemes; `coverage.nativeHostOwners` lists the actual effect-owner IDs behind a composite
trusted native callback bridge (`nativeHostRequest` / `nativeEvent`), while
`coverage.nativeHost` remains a single-owner shorthand. The router itself needs
no invented lease: host core counts in-flight callbacks, and composition declares
every actual effect authority behind its routes. The list must be nonempty and
bounded, and every listed owner must supply its real held participant. `requiredOwners` additionally names all
execution authorities without those surfaces: timers, scheduling, voice, upload
processing, native administration, and other background work. Each ID requires a
real `QuiescenceParticipant`. Undeclared coverage refuses admission. A participant
implements `acquire(context)` atomically, closing its intake and returning a held
`{ownerId,fenceId,release}` lease, or `null` for a proven no-effect busy refusal.
Sampling an idle flag is insufficient. Acquisition errors are uncertain. A durable
participant implements `reconcileRelease` for its exact fence after replacement.
Releasing a lease must be idempotent: recovery can revisit one whose release
acknowledgement was lost. Owner intake must also honor the aggregate host gate
until it is released, including when another owner's reconciliation is uncertain.

The host checks admitted turns, finishing turns, controls, callbacks, approvals,
client tools, terminal work, and preserved queued/steering intents. Viewer counts
are irrelevant. Every resident agent must support negotiated atomic native
`_amplifier/retire`: only a confirmed retired handle is closed. Busy owned work
stays alive; unconfirmed retirement keeps intake fenced. Generic engines without
this lifecycle proof cannot be declared safe for automatic restart. Native-home
writer exclusion and external legacy writers require the separately configured
native maintenance authority; the host does not claim filesystem-wide exclusion.

Ordinary AHP mutations, resource writes, capability mutations, direct host
admissions, native controls, and ACP filesystem/terminal effects pass the gate.
Passive native inspection peers cannot request filesystem or terminal effects. Composition wraps other effects in
`withExternalMutation(ownerId, callback)`. Existing result delivery can finish but
cannot inherit permission to start new work. Passive reads, subscriptions,
reconnection and receipt lookup remain available. Trusted composition may declare
`capabilities.quiescenceAccess` by **exact manifest action name**, with value
`'read'` or `'reconcile'`. Names are not heuristically classified. Such callbacks
inherit no mutation admission; reads must be side-effect free, and reconciliation
may only inspect/release an existing authoritative receipt/fence. It must not
start, retry, or schedule work. Unclassified actions remain mutations. Pure
read-only topics need no synthetic participant; background authorities still
belong in `requiredOwners` even if all their advertised actions are reads.

Recovery uses `withQuiescenceMaintenance({fenceId,commandId}, callback)` only after
admission. The callback performs bounded trusted maintenance I/O while the exact
gate is held. It cannot enter ordinary host/native execution methods, run alongside
another maintenance callback, or release while the callback is pending. A thrown
callback conservatively leaves the gate unknown. A recovery action must save and
return its job before its background worker asks for quiescence; otherwise its own
active action correctly prevents idle admission. A participant may exempt only
that exact pre-effect coordinator job, never unrelated work.

`releaseQuiescence({fenceId,commandId,outcome,evidence})` accepts `unknown` to retain
the gate. `ready`/`unchanged` require `verifyRelease` to read authenticated,
durable supervisor/recovery evidence and return `{verified:true,fenceId,
commandId,outcome,instanceId,dataScope,receiptId}`. `ready` requires the currently
running replacement identity to differ from the admitting instance; `unchanged`
requires the same instance with a proven no-replacement/conclusive-maintenance
outcome. Client assertions and an open socket do not prove this. The host opens
intake only after exact proof and all participant releases succeed. No history,
prompt, queue, uncertain operation, or mutation is replayed by reconciliation.
The external supervisor must survive the child it replaces. Existing `close()`
is shutdown, not an idle proof; restart composition must acquire this gate first.

`onMayBeIdle` is an advisory wakeup after tracked work settles, not authorization.
An idle-triggered retry may retain the durable supervisor command with explicit
`retryRefused:true` after a known busy/no-effect result; unknown remains a
reconciliation case. Acquisition/release callbacks have a
bounded `timeoutMs` (25–30,000; default 10,000). The public gate API does not invent
release version/digest, account readiness, or complete owner coverage.

### Pre-retirement admission abort (optional)

`abortQuiescenceAdmission({commandId,fenceId,instanceId,dataScope,evidence?})`
settles an original distribution-update admission that is unknown **before native
retirement**. It does not abort an update effect or claim a running replacement.
The trusted configuration must supply `verifyAdmissionAbort`, returning the exact
`AdmissionAbortProof` with `kind:'distribution-admission-abort'`,
`purpose:'distribution-update'`, `verified:true`, the four request identity fields,
and a durable `receiptId`. The supervisor is responsible for authenticating the
original admission-requested command, unchanged owned runtime, and absence of a
new-instance start. Caller evidence alone grants nothing.

Abort verifier and owner callbacks receive the five canonical context fields
`commandId`, `fenceId`, `instanceId`, `dataScope`, `purpose`, plus `evidence` or
`proof` respectively. Internal phase, attempted owners, observation time, reason
and admission stage remain in the durable Host fence and abort-attempt journal;
they are not callback arguments. Other purpose-specific callbacks are unchanged.

Every attempted participant needs `abortAdmission(contextWithProof)` returning an
exact `AdmissionAbortOwnerReceipt`: `ownerId`, the four bound identity fields,
`status:'released'|'not-acquired'`, and `receiptId`. The owner must authenticate its
original attempted acquisition and return durable idempotent settlement evidence.
A missing in-memory lease, a generic unchanged proof, or a void release result is
not such evidence. Retrying a lost owner reply may observe/settle only that exact
original fence; it must not reacquire or redispatch the update.

The Host journals the request/proof before callbacks, visits attempted owners in
reverse acquisition order, and persists each conclusive receipt. Any missing,
uncertain, changed, or misbound result retains closed intake. Completion atomically
stores `HostAdmissionAbortReceipt` (`schema:'host-admission-abort-v1'`,
`status:'aborted'`, `intakeClosed:false`, the bound identity, supervisor `receiptId`,
and ordered `owners`) and removes the fence. `quiescenceAdmissionAbortReceipt(id)`
is passive and returns only a completed abort, or `undefined`; the original
`quiescenceReceipt(id)` remains unknown until completion and then returns the same
abort receipt. An exact completed retry cannot repeat owner effects or start a new
admission, even with `retryRefused:true`.

New fences persist an admission stage before native retirement begins. Legacy
fences lacking this stage, retirement/held fences, post-retirement
`owner-exclusion` fences, other purposes, a replacement
Host instance, and still-running acquisition/release/verification calls refuse
abort. A timeout does not cancel those calls. Restart preserves the intent and
owner receipts; reopening with a different launch identity cannot use this abort
path. This additive API requires actual participant and supervisor support and
does not authorize repair of older unknown fences. Causal coverage:
[test/admission-abort.test.ts](test/admission-abort.test.ts).

### Persistent service stop and explicit resume

Service lifecycle is optional trusted composition, distinct from distribution
updates and recovery. `quiescence.serviceLifecycle` declares `identity` and its own
`verifyRelease` callback. Identity has five required fields: `installationId`,
`dataScope`, `ownerId`, `instanceId`, and `releaseDigest`. `instanceId` must identify
this actual runtime launch, and must match the enclosing quiescence configuration;
it cannot be a static installer ID. `dataScope` must also match. The remaining
fields come from the authenticated platform owner and retained signed release.

```ts
const admission = await host.admitServiceStop({
  commandId: durableStopCommandId,
  expected: authenticatedCurrentIdentity,
});
// Ordinary graceful stop requires phase === 'held' and evidence.activeWork === 0.
// The host sends no signal and discovers or adopts no PID.
```

`closeServiceIntake(request)` durably closes the shared local gate before any
await. Its `admitted:true,phase:'closed'` receipt proves only closure; measured
`evidence.activeWork` can be nonzero or unknown. `admitServiceStop` uses the same
command/fence/identity and waits for actual local work to drain, then returns
`phase:'held',evidence.activeWork:0`. Known running work remains pending without a
duration limit. Losing or timing out the caller's observation does not cancel the
original drain or change it to unknown. Passive reads of the same command receipt
observe its eventual settlement without replaying admission. Host shutdown/restart,
unmeasurable work and unknown platform stop outcomes still require authenticated
reconciliation; a sampled idle state cannot clear them.
New starts and configuration remain closed while exact admitted tool results,
approvals, cancellation, startup/turn/control callbacks and completion projections
continue under counted, expiring authority. Durable waiting intents, business
unknown receipts, cached residents and passive reads are not active work.
No participant marker census or lease fanout is used for ordinary service stops.
Actual writer/session locks and retained legacy maintenance holds remain intact.

All receipts retain `purpose:'service-stop'` and `expected`. A changed identity
never reuses a stop command. `serviceStopReceipt(commandId)` is passive;
`inspectServiceLifecycle()` exposes the retained fence without claiming OS
ownership. See the [shared admission contract](docs/contracts/shared-service-admission.v1.md).

The platform supervisor owns durable stop/resume receipts and authoritative
process exit. A stopped process, an absent endpoint, a PID, or an unknown outcome
never releases intake. Replacement startup preserves the original gate and only
explicit service reconciliation can open it:

```ts
await host.releaseServiceStop({
  fenceId, commandId: durableStopCommandId, outcome: 'resumed',
  resumeCommandId: durableResumeCommandId,
  evidence: authenticatedOwnerReceiptReference,
});
```

`verifyRelease` receives the retained fence, `serviceIdentity` (original exact
identity), requested outcome, resume command, and bounded evidence. It must read
actual authenticated owner receipts. It returns the ordinary proof fields
`verified:true,fenceId,commandId,outcome,instanceId,dataScope,receiptId` **plus**:

- `kind:'service-lifecycle'`, `serviceOutcome:'resumed'|'stop-refused'`;
- `expected` (exact original identity) and `observed` (exact currently configured
  identity);
- for resumed: `outcome:'ready'`, the exact `resumeCommandId`, `exitReceiptId` and
  `readyReceiptId`. The new instance must differ; installation, owner and scope
  remain identical. A different release digest additionally requires authenticated
  `activation:{schema:'distribution-service-activation-v1',target:{id,version,revision,digest}}`,
  whose qualified signed target matches the currently configured digest;
- for stop-refused: `outcome:'unchanged'` and `refusalReceiptId` proving no stop
  effect. Original and observed identities must be identical, with no resume or
  exit/readiness claims.

Passing `outcome:'unknown'` preserves the fence. Generic `releaseQuiescence` and
`withQuiescenceMaintenance` refuse service fences: service stop grants no recovery
or native-admin mutation privileges. Retained legacy participant-based service
holds retain their original identity, lease and proof meaning; they are not new
shared-drain receipts. Their recovered release still authenticates every original
owner. Maintenance, retention, recovery and real writer exclusion keep their
separate domain protections.

The host persists the canonical exact release request and authenticated proof
before releasing any participant. A lost acknowledgement can be reconciled with
the same request and same proof, including after process replacement. Changed
proof, outcome, or identity refuses; unknown never triggers another stop, launch,
agent turn, or queued-input replay. A host receipt reports only the admission gate,
not that a platform service is stopped or resumed. Actual platform qualification
belongs to the independently configured supervisor.

### Exclusive host state ownership

Before opening `host.sqlite` or running any recovery migration, the host holds a
separate `host-owner-lock.sqlite` lifetime SQLite `BEGIN EXCLUSIVE` lease with a
DELETE journal and zero lock wait. Only one cooperating process can own the state
directory. Process death releases the operating-system lock; durable admission and
quiescence receipts remain and are classified conservatively on the next open.
No PID file is unlinked to reclaim ownership. A surviving legacy `host.lock` is
retained as evidence, and a live legacy PID prevents opening the new journals.
Old releases do not participate in the new lease: retire an old instance before
activating this release, as required by the supervisor replacement protocol.

Archive organization is projected separately from native history. Standard
`session/isArchivedChanged` and public `archiveSession` persist the host flag and
send explicit `isArchived` to the derived catalog. A tiny durable pending
projection is updated in the same session transaction; restart repairs failed
acknowledgements in batches of100. The host's archived-summary partial index
repairs archive flags after catalog rebuild without loading transcripts, spawning
agents, or constructing a global session snapshot. Older custom catalogs can omit
`projectSessionArchives`; upgraded stdio catalogs implement that public repair
port. Native metadata scans must preserve explicit host archive flags.

## Verified native history import adoption

`authorizeWorkspace(directory)` returns only an existing canonical directory under
configured roots. Trusted product owners use it before staging an explicit import;
it grants no generic browser filesystem or native-administration capability.

`adoptImportedSession({commandId,session,engineId,workingDirectory,importCommandId,
sourceSha256,previewHash})` independently initializes the **configured** ACP engine
and queries its exact `history.import.receipt` through negotiated native
`admin.historyImport` v1. It never accepts a caller-provided native ID, transcript,
or successful-creation boolean. The native receipt must be a succeeded exact
`history.import.commit`, with a newly generated native UUID, matching canonical
workspace, source/review hashes, `creationConfirmed:true`, and `workReplayed:false`.
No ACP session, worker, model or history page is started by adoption.

The durable mapping is unique by configured engine and native import command.
Changed caller command IDs or requested URI hints cannot create duplicate chats.
Conflicting existing native/AHP identities refuse. A catalog must implement atomic
`claimNative`; it may reuse an already discovered URI, which becomes authoritative.
Ordinary upsert is not a safe substitute. A failed/lost catalog acknowledgement
retains unknown registration evidence. `importAdoptionReceipt(commandId)` is a
passive exact read; `{reconcile:true}` explicitly rechecks the original native proof
and repairs **derived metadata only** under host intake and directory guards.
Neither method ever invokes native import commit or replays source work.

Generic ACP engines lacking the extension report unsupported. The staged source,
normalization, native writer leases and original bytes belong exclusively to the
native import owner; the host stores only bounded proof and mapping receipts.

### Independent recovery copies and configured bundle forks

`forkSession` and negotiated `x-amplifier/sessionLifecycle` `fork` accept optional
`mode: 'recovery'` for a readable independent copy. Only the source's unknown
input outcome is allowed: its original receipt/fence stays unknown, and no input
is replayed. Native owner confirmation must prove the exact copy mode and identity.
Canonical corruption/pending rewrites, relocation/transfer fences, or active and
unknown descendant work refuse. Targets remain cold until a new explicit request.

Configured bundle forks use `bundle`, exact `bundleRevision` from
`inspectSessionHistory().forkBundles`, and optional `resetModel`. The native
launcher owns the named choices; client filesystem references are not accepted.
The original composition is retained in the source. Neither copying nor selecting
a bundle claims model/account readiness.

The independently installed catalog optionally exposes `descendants` and the
trusted `reconcileFamily` / `verifyFamily` pair. Before a copy guard, the host
requests bounded discovery of the selected root's known native project namespaces
(`limit:100,maxEntries:512`), not a global scan. A complete version1 scoped proof
must bind the exact family revision, identities, inventory hash and process-local
verification token. Partial, ambiguous, oversized, stale or missing proof refuses
copying. Reconciliation reads at most 8MiB of metadata and 2048 metadata files;
canonical transcript/event bodies are not read or changed.

Selected-family reconciliation joins the presentation owner's exclusive discovery
boundary. Metadata reconstruction pauses and joins that writer; an unknown reply
retains the exact durable `reconcileFamily` attempt and blocks rebuilding until
trusted response or actual process-exit evidence settles it. The owned stdio
adapter joins the original process exit after a discovery timeout. Revalidation
is read-only and does not join the derived-index writer queue.

Under source and child admission locks, the host asks `verifyFamily` to check the
retained namespace inventory again, then re-reads the pure indexed revision. An
unhinted new native child, changed metadata, expired token, restarted producer or
changed family refuses before native copy effects. Verification does not repair
the index or replay a copy. Actual native Foundation root/descendant leases and
native parent checks remain mandatory. The proof's `externalWriterCoverage:false`
does not exclude a later noncooperating filesystem writer.

Older producers lacking `reconcileFamily` (explicit method-not-found) retain the
existing complete indexed/global-freshness path. Supported reconciliation failures
never fall back to a weaker proof. Historical unknown outcomes remain preserved.
Ordinary complete forks without a catalog retain native selected-worker-family
coverage only. Recovery/bundle copies require catalog coverage, and configured
catalogs lacking descendant support refuse copy effects.

`inspectSessionHistory` exposes negotiated per-engine `lifecycleCapabilities` and
optional bounded native `failure` guidance. It never fabricates historical failure
causes from a generic host error. Capability absent means the operation is unavailable.

Read state uses standard AHP `session/isReadChanged` actions and is shared across
clients. New input, resumed work, required input and completion clear a previous
read flag. These boundary events are durable; token streaming and historical
page loads do not emit read-state writes. Reading a conversation never answers
or dismisses its pending tool approvals. Normal AHP server ordering governs
concurrent client actions; no private required revision field is added.


### Reviewed age-based discovery cleanup

`previewRetention({connectionId,modifiedBefore,limit?,cursor?,workingDirectory?,protectSessionIds?})`
reads only the public cold catalog (maximum50 rows). Cutoff is past Unix seconds;
review expiry is Unix milliseconds. Global `candidateCount` is unverified metadata;
`eligibleCountOnPage` is only host preflight, explicitly not permission to remove.
The ten-minute review binds the exact metadata and local protected IDs. Private
client drafts are never synchronized. Current session/chat subscriptions protect
selection, including new subscriptions arriving after review.

`applyRetention({commandId,reviewId,reviewHash,sessionIds})` selects a nonempty
reviewed subset of at most50. Every item has a durable deterministic command ID
and conclusive/unknown/not-attempted state. `retentionReceipt(commandId)` is a
passive exact batch read; `retentionItemReceipt(childCommandId)` is a lock-free
passive item proof, persisted before dependent protection release. Never retry an
unknown batch or silently skip it into a new command. An uncertain release can
leave the batch unknown while preserving an already-confirmed hidden effect.

Apply requires a configured `retentionProtection.acquire({commandId,session,
descendants,operation:'hide'})` returning an actual held `{ownerIds,release}`
lease. Missing coverage refuses. The aggregate must fence its dependent owners,
check retained scheduling/question/reference restrictions, and authenticate its
release using the exact durable item receipt. Its release must not reenter host
mutation/session-lock APIs. Native authority is separate: negotiated
`sessionLifecycle.retention` holds the native-home shared maintenance gate and
source/family Foundation leases, verifies current activity against cutoff, then
writes only a preserve-history discovery tombstone. Native admin/transfer global
gates must not deadlock this independent native ownership check.

`QuiescencePurpose` includes `retention-hide` for explicit participant contracts;
optional `retentionHide:{version:1}` declares support. Host global restart
admission does not accept that purpose. No existing recovery/update proof grants
retention release. The product must provide real supported owner coverage.

Canonical transcripts/events, workspace files and all owner records remain.
Retired legacy-copy purge and permanent managed-chat deletion are separate
authorities; this API performs neither.

If native hiding is confirmed but derived catalog acknowledgement is lost, explicit
`inspectSessionLifecycleReceipt(session, childCommandId)` may inspect the original
native receipt and repair metadata without repeating the mutation. It must run
outside the held session-lock callback. Thereafter passive retention item/batch
reads recognize that completed host lifecycle proof as `hidden`, with
`protectionRelease:'unconfirmed'`; an unknown batch remains non-replayable until
its dependent owner release has been separately reconciled.
# Verified retired private copies

Optional native `sessionLifecycle.retiredCopies` v1 enables selected public
`inventoryRetiredCopies(session)`, `previewRetiredCopyPurge(session,{rootId})`,
`purgeRetiredCopy(session,{commandId,previewId,previewHash,expectedHistoryRevision})`
and `retiredCopyPurgeReceipt(session,commandId)`. The browser wire uses the existing
negotiated `x-amplifier/sessionLifecycle` method with `legacyCopy.inventory`,
`legacyCopy.preview`, `legacyCopy.purge`, and `legacyCopy.receipt` respectively.
Unconfigured and generic ACP engines explicitly refuse this optional feature.

The native launcher alone identifies retired private app roots. Preview contains
bounded file names/counts/hashes, expiry in Unix seconds, canonical revision and
retained reasons. Caller-provided filesystem paths are rejected. The source
must have complete canonical proof; only duplicate metadata/transcript or fully
preserved checkpoint files can be removed. Directories, unique/unknown files,
every events.jsonl and current native history remain. **Legacy writer retirement
is a trusted launcher assertion**, not proof obtained from an old app lock.

Host source admission, transfer/unknown guards and native canonical writer
ownership protect the operation. The native receipt is checked for exact selected
identity, preview/hash/revision, duplicate file allowlist and zero canonical/event
deletions before host completion. Restart and changed command IDs cannot replay
unknown work. Exact receipt recovery may confirm a completed native effect only;
it never resends the removal. A source hidden by retention can still be selected
through its known identity for this separate reviewed operation. This feature
does not implement permanent managed-chat deletion or blanket legacy-directory
purge. Independent installed host/catalog/Core tests use fixture-owned roots only.

## Private managed chats

`managedSessionRoot` is an optional private allocation owner, separate from
`allowedWorkspaceRoots`. `createManagedSession({session,commandId,provider?,title?,bundle?,bundleRevision?,selection?})`
creates `<managedSessionRoot>/chats/<UUID>/files` only on an explicit request.
The canonical AHP UUID, allocation UUID, and reserved native UUID are identical.
`selection` is exactly `{instance,model,effort?}`. An explicit bundle is a
launcher-configured alias plus its reviewed SHA256 revision; omission uses the
configured engine default. No directory or arbitrary bundle path is accepted.

Initialize advertises `_meta['amplifier.dev/managedCreation']` with method
`x-amplifier/managedSession`; root-channel operations are `options`, `defaults`, `create` with the same
arguments and `receipt` with `{commandId}`. Success returns
`{session,uri,creationConfirmed:true,location,configurationScope:'global-and-session',runtimeStarted:false,workReplayed:false,receipt}`.
A created chat has a ready AHP resource, but provider/account/runtime readiness
is established only on the later explicit first prompt. Unsent drafts do not
allocate. Engines without the native managed-creation capability are refused
before directory allocation.

The allocation root has an OS lifetime lease and durable SQLite journal. The
host verifies marker bytes, directory identities, configured engine, native
identity and the adapter's committed creation proof. An interrupted allocation
or native request is retained as unknown. `managedSessionReceipt(commandId)`
may query only the original passive native receipt and repair its derived
mapping; it never repeats native creation, mkdir or input. Folder names, cwd,
self-hashed markers and catalog rows alone never grant managed ownership.
Native metadata includes the bounded location projection; catalog list calls
use independent `allowedManagedRoots`, while workspace authorization and file
browsing continue to exclude the private allocation root. Selected trusted I/O
uses `withSessionWorkspace` and the exact allocation authority.

History forks (including readable recovery and configured bundle choice) and exact
configuration clones reserve new owned allocations. They preserve source history,
leave generated files at the source, and do not start a target runtime. Relocation
and transfer still require an explicit ownership transition and refuse before
effects. This boundary does not implement permanent deletion.
Native global/session policy is authenticated on every mount; project/local
settings and routing are excluded. Canonical history, events and user files are
preserved. Full-product backup must include this separate configured host owner
root; native session backups alone do not cover its allocation journal/files.

### Managed choices and fresh copies

`managedSessionOptions({provider?})` / root operation `options` returns bounded
configured bundle aliases `{id,name,revision}`, `defaultBundle:{kind:'engine-default'}`,
and `runtimeStarted:false`. `managedSessionDefaults({provider?,bundle?,bundleRevision?})`
/ operation `defaults` resolves only that exact launcher choice with global settings.
It returns sanitized `{providers,effective,globalOnly:true,bundleSelection,configurationScope,runtimeStarted:false}`.
The Foundation provider metadata probe can prepare configured dependencies but
never creates a Core conversation, mounts tools/hooks or calls a model. Do not
pass these aliases to unrelated bundle-path APIs. No caller workspace is accepted.

Existing `forkSession` reserves a fresh UUID, directory and two durable creation
records for a managed source. Native canonical history stays authoritative;
managed fork result adds `location` and `generatedFilesCopied:false`. File-access
paths contained within the source allocation are rebound to the target allocation;
other explicit restrictions remain. Historical text/path references are unchanged.
Ordinary workspace forks retain their existing semantics.

Existing `createSession` with source/configuration hash uses an exact persisted
native snapshot for managed sources and leaves the target cold with empty history.
An unexecuted source without a saved effective configuration is explicitly
unavailable; creating a runtime only to guess its configuration is not a fallback.
`managedSessionReceipt(originalCommandId)` can repair an uncertain clone projection
from its original native receipt. Both copy kinds retain source identity/revision
in the host allocation ledger and compare the independent native proof.

Any failure after host reservation reports `{receipt,outcome:'unknown',allocationOccurred:true}`
for ordinary managed creation, even when native reports its own pre-effect refusal.
Allocated folders remain evidence. Never retry mkdir/native creation; only inspect
the exact original receipt. Live/restarted receipt repair never replays inputs.

`managedSessionModels({provider?,bundle?,bundleRevision?,instance,limit?,cursor?})`
and the negotiated root `x-amplifier/managedSession` operation `models` query the
selected bundle's provider rather than the global registry. Pages are at most
100 rows, with catalog-revision-bound cursors and a complete discovery ceiling
of 1,000 rows/512 KiB; unavailable/changed/oversized catalogs are explicit.
Only the selected provider's public metadata API runs (which may use network or
prepare dependencies). No Core runtime, session allocation, or prompt occurs.
Responses preserve exact bundle selection, `modelsSupported`, and
`runtimeStarted:false`. A discovered model is not a readiness assertion.

### Reviewed managed allocation files

Optional `managedFilesProtection` is a distinct held reference-owner contract;
retention-hide coverage never grants file removal. Its marker must be
`{managedFiles:{version:1,preservesCanonical:true}}`. `acquire` receives the exact
command/session, bounded descendant identities, `operation:'dispose-owned-files'`,
reviewHash and allocation `{allocationId,executionDirectory,allocationHash,
treeHash,entryCount,bytes}`. It must hold every configured product owner's intake
and file-reference protection and return `{ownerIds,release}`. Missing, partial,
retained or uncertain reference coverage refuses; no no-op adapter is supported.

`previewManagedFiles(session,{protectSessionIds?},{actorId,clientId?})` performs a
bounded selected native review without starting a runtime. `disposeManagedFiles`
uses `{commandId,reviewId,reviewHash,expectedHistoryRevision,protectSessionIds?}`
and the same authenticated actor. It fences source/family admissions and other
selected clients, acquires real owner protection, then invokes the negotiated
native storage owner. No filesystem path supplied by a client confers ownership.
The caller's selected client may review its own chat; other selected clients and
explicit protect IDs refuse. Dirty drafts remain private to each client.

`readManagedFilesEffectReceipt(session,commandId)` is a local passive coordinator
read. It returns `{commandId,session,reviewHash,operation:'dispose-owned-files',
status:'completed'|'refused'|'unknown',preservesCanonical:true,allocation,request,
descendants,familyCount,projection:'pending'|'completed',native?,executed?,
protectionRelease?}`. `executed:false` appears only on conclusive no-effect
refusal. `completed` proves the exact native durable file effect, written before
catalog repair or owner release. `protectionRelease:'unconfirmed'` does not erase
completed effect evidence or grant permission to replay. Duplicate commands read
the same journal and never perform removal again. Changed command arguments or
actor identity refuse. `managedFilesReceipt` additionally queries the original
native receipt and repairs derived catalog projection; it never repeats removal.
The browser wire uses existing `x-amplifier/sessionLifecycle` operations
`managedFiles.preview`, `managedFiles.dispose`, `managedFiles.receipt`.

Canonical native metadata/transcript/events and ownership journals are preserved.
Unknown stages and receipts remain fenced. Historical reads use the original
native identity and a valid private process cwd, never recreate the removed
folder. After confirmed disposal, an explicit recovery fork creates a new owned
allocation; old execution and restore-by-unhiding refuse. Known descendants in
the same private allocation are checked only under the source's proved authority,
without hydrating them or granting general managed-directory browsing. Native
family membership must match the product-reviewed family before file effects.
Foundation's public retained historical identity support is required; generic
engines without the capability are explicitly unsupported. These ownership gates
do not freeze non-cooperating external filesystem editors.

### Capability v1 conformance

Host-only authority is declared by `manifest.topics[action.topic].scope === 'host'`.
Such actions require `channel: 'ahp-root://'`; the host rejects other channels
before creating a receipt or invoking the provider. The explicit selected session
inside an owner's typed arguments remains subject to that owner's authorization.
Context topics retain their authorized host or selected-session behavior.

Advertised capability resource reads and watches require exactly one explicit
`scope` query value: `host` or an AHP session URI. Host-only topics require
`scope=host`. Missing, empty, duplicate, and invalid scopes are refused before
provider reads or watch creation. Clients must not treat the bare advertised URI
as an implicit host-scope request.

New v1 capability commands accept 1–256 characters in `commandId`, matching the
public extension schema. IDs are never truncated. Existing durable receipts,
including 257–512-character IDs admitted by earlier builds, remain available
through passive `x-commandReceipt` after restart. Re-reading a receipt does not
re-admit or replay its effect.

Trusted native embedding may pass `invokeCapability(request, {actorId,
origin:'agent', session})` to retain the authenticated originating conversation
when a host-only action uses the root channel. The host resolves that exact
session; a non-root channel must resolve to the same identity. UI actors cannot
set this binding. The WebSocket handler never derives it from request fields,
`args.sessionId`, or client metadata. Providers continue to authorize their typed
selectors against `context.session`; routing an action on the root channel does
not grant agents authority over other sessions.

### Reversible conversation presentation

An optional `conversationPresentation` embedding owns reviewed, reversible
product visibility. It preserves native histories, files, input provenance,
unknown/admission receipts, queue tombstones and other owners' records. It uses
selected host admission locks for the local marker transaction; visibility never
revokes authorized exact-ID reads, commands or deferred work. There is no global
maintenance dependency or client-asserted authority. Exact DTOs, limits,
catalog reconstruction obligations and remaining recovery boundaries are in
[conversation-presentation.v1](docs/contracts/conversation-presentation.v1.md).
The feature is unavailable without the configured indexed catalog projection. Removing that configuration cannot bypass retained authority.


### Quoted ordinary inputs

A trusted server composition may set `EngineConfig.messagePrincipal` to its
verified account string (1–200 characters, no control characters). The host
asserts it once at ACP initialize
`params.clientCapabilities._meta['amplifier.dev/messagePrincipal'] = {version:1,account}`,
alongside the native v1 grant. Browser account fields, `clientId`, and per-message
actor metadata never supply that principal.

An ordinary AHP input may carry
`message._meta['amplifier.dev/messageReply'] = {messageId,position,historyEpoch,sourceDigest?}`.
The exact reference is bounded to 2048 bytes: message/epoch tokens at most 200
characters, a nonnegative safe integer position, a nullable epoch, and an optional
64-character lowercase public-text SHA256 digest. Extra excerpts, paths, actors,
and session selectors refuse before prompt admission. The configured peer must
advertise native v1 and `messageInteractions:{version:1,quoteMeta:'amplifier.dev/messageReply'}`.
Unnegotiated queued inputs stay held with their original draft and identity.

The host forwards that reference to ordinary ACP prompt metadata, supplies
`sessionId` from its retained native mapping, and keeps the original
`amplifier.dev/command.commandId` equal to the turn identity. Native authority
resolves the canonical public text, freezes its bounded quote, and decides stale
reference or history-epoch validity. The host does not resolve excerpts or add a
selection RPC. A lost quoted input keeps its original unknown receipt and is not
retried. Reply selection/clear and passive reactions remain with their respective
client/native owners.


Actual quote availability is retained at the existing session metadata path
`_meta['amplifier.dev/acp'].capabilities._meta['amplifier.dev/native'].messageInteractions`.
After a settled live turn, a client may request a bounded selected history refresh
and a fresh snapshot. The refresh preserves validated canonical
`amplifier.dev/history.messageReference` and `replyTo` on user and assistant
metadata, without replacing host admission provenance. Historical-only rows gain
no selectable locator; missing canonical locators remove obsolete user overlays.
No whole-history eager read or quote text supplied by a client is introduced.


`session/metaChanged` publishes
`_meta['amplifier.dev/acp'].lastSettledTurnId` only after joined update/cleanup work
has finished and the agent is idle with a completed original receipt. Clients
coalesce one bounded refresh for each new marker value; an unchanged value in a
later full metadata update is not a new settlement. A queued next turn can defer
the marker until that turn settles. The prompt path performs no eager history
read or retry for this notification.

### Existing authoritative database schema

Startup refuses missing or incompatible authoritative tables before recreating
state or normalizing interrupted commands. Genuine new stores, documented legacy
migrations and never-initialized optional owners remain supported. Preserve a
refused database and its WAL for inspection or exact backup restoration; do not
clear it to retry. See [schema admission and its limits](docs/authoritative-schema.md).

Unresolved retirement is journaled before its RPC in the existing Host receipts
and selected session metadata. A closed ACP connection or Host restart cannot
erase this fence. Only the matching original connection, mapping and retirement
receipt may clear it on proof. If that connection is lost before proof arrives,
this seam cannot recover it: the chat stays blocked until a separate authoritative
recovery path resolves the original uncertainty. Process exit alone is not proof.
Definitive refusal or confirmed retirement settles only the retirement receipt;
ordinary cold resume remains available and user-input receipts are untouched.

### Live library queries

The optional [library query contract](docs/contracts/library-query.v1.md) adds a
trusted Workspace read with indexed whole-domain predicates and explicit freshness.
It preserves standard listSessions and selected-session AHP authority. Cold runtime
unknown differs from a retained uncertain executed effect; no global current count
or frozen-result snapshot is promised.

### ACP plans

Standard ACP `plan` updates retain bounded structured entries in an AHP
`systemNotification` part under `_meta["amplifier.dev/acp"].plan` (version 1).
The part also carries a plain-text fallback for generic clients. The shared
projection handles live updates and passive history identically; it never adds
a user input or starts execution. Invalid/oversized latest updates retain an
explicit unavailable snapshot rather than substituting a stale plan. Optional
Native todo active wording and unavailable metadata are presentation only.
`test/plan.test.ts` checks the official reducer and serialization boundary.

### Durable model-call accounting

The Host retains scalar model-call receipts independently of the loaded turn
window. Native owns the revisioned budget policy and supplies its snapshot for
each pre-provider `capacity.admit` request. The Host binds that request to its
currently owned Native process and session, records admission before replying,
and uses cumulative call snapshots rather than adding repeated usage events.
Input plus cache writes plus output is the gross token total; cache reads and
reasoning tokens are not added twice. Estimated cost, known zero, pending usage
and unknown settled usage remain distinct. Editing history does not refund calls.

`readCapacity` uses passive persisted Native policy without starting a worker.
`historicalUsage` is an optional trusted distribution migration callback. It
returns bounded scalar call rows for the exact engine, Native identity and
canonical history workspace; it is not a public import or policy authority.
The Host imports it before both inspection and admission, atomically and
idempotently by call identity. Invalid or ambiguous migration refuses rather
than reporting a zero balance. Interrupted calls become unknown and are never
replayed. An enabled policy pauses on unknown settled usage unless explicitly
configured otherwise. In-flight calls can finish above the limit.

`test/usage.test.ts` covers retained-window independence, cache accounting,
partial/duplicate revisions, unknowns, edited-away backfill and restart. The
composed distribution test separately exercises installed Native admission and
selected-main accounting migration before a provider invocation.
