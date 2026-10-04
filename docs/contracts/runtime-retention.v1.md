# Runtime retention v1

Host owns a bounded cache of agents already started by explicit work. Browsing,
history reads, subscriptions and reconnects never start or prewarm an agent.
The existing default capacity is eight resident or admitted starting sessions;
an unresolved resident still consumes its slot. Waiting admission is not a
started process. This is a session-count bound, not a process or byte budget.

## Immutable connection negotiation

Before starting or resuming any session, Host offers
`clientCapabilities._meta['amplifier.dev/host'].runtimeRetention`:

```json
{"version":1,"owner":"host","lifetime":"connection"}
```

Native accepts only those exact three keys and values, with integer version 1,
inside Host capability version 1. It acknowledges under
`agentCapabilities._meta['amplifier.dev/native'].lifecycle.runtimeRetention`:

```json
{"version":1,"owner":"host","lifetime":"connection","standaloneIdleSeconds":60}
```

The fallback interval reflects Native's configured standalone interval. Host
accepts only the exact four-key acknowledgement with positive finite interval,
Native capability version 1 and lifecycle version 1. The offer and acceptance
belong to the private ACP connection, not user input or session metadata. Native
suppresses its autonomous idle timer only on acceptance. Without acceptance,
the existing Native timer or generic engine lifetime remains in force; Host
reports unmanaged lifetime and does not promise a warm inner worker. Host's
cache policy still bounds retained generic ACP connections.

Connection loss ends the agreement. Existing cancellation, EOF shutdown and
no-replay semantics remain unchanged. Transport loss is never retirement proof.

## Host policy

Real runtime use and settlement advance a monotonic use order. Viewing does
not. Interest is any live subscription to the exact session or its chat, shared
across viewers; root/catalog subscriptions are excluded. Interest is retention
priority, not verified foreground visibility or an unlimited pin.

An interested warm agent is kept while capacity permits. Uninterested agents
receive a default fifteen-minute grace from the later of real use/settlement or
the last interested-to-uninterested transition. Existing `idleAgentMs` remains
the server override. Under capacity pressure, safe uninterested entries are
evicted first, then safe interested entries; each tier uses least-recent real
use. Capacity reservations and retirement decisions serialize. Selection,
identity and protection are rechecked under the existing selected-session lock.

Busy/finishing/starting/control work, pending approvals, callbacks, client tools,
queued work and unresolved input/ownership/lifecycle effects protect entries.
Native's existing atomic idle authority additionally protects owned descendants
and work Host cannot see. Known refusal tries another candidate. Unknown
retirement stays counted and fenced, with the original command and proof rules
unchanged. Exhausted protected capacity refuses new admission; it never kills
owned work or overbooks. Explicit proof reconciliation is not automatic cache
eviction and can preserve prior unknown input receipts.

## Review and acceptance boundary

Host and Native changes are separate drafts against this contract. Host-only
fixtures prove ordering/admission/negotiation, not Native runtime retention.
Require installed Host/Native composition with the same runtime identity after
75 seconds and five minutes, multi-viewer disconnect, zero cold-view starts,
pressure/LRU/race/refusal/unknown cases, and standalone/EOF fallback. Measure
target-host process trees and separated startup/provider/render phases before
claiming memory or latency improvements. Existing 6.128s versus 3.424s browser
responses do not identify the cause of the entire difference.
