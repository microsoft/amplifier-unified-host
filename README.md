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
`inspectSession`, `nativeControl`, `invokeClientTool`, `invalidateCapability`,
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
