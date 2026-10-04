# Host boundary contract — v1

Status: local traceability and implementation obligations under the approved
2026-10-02 family direction; recorded 2026-10-03. Clause prefix **HB**.
Parent: [repository vision](../VISION.md). No new wire schema or product proposal
is introduced here. The reviewed family packet is source revision
`625af2f2832fafc8152f6078061d626f160362a4`; linked main documents remain the living
owners of family direction, not a standing dependency pin.

## Producers, consumers and owning definitions

This repository produces `@amplifier/unified-host`, its exported `HostConfig` and
host methods, the CLI, an AHP WebSocket server and an ACP stdio client. Consumers
are independent AHP clients, configured ACP agents, catalog implementations,
capability/resource owners and trusted distribution/supervisor composition.
[README](../../README.md) owns executable setup, current limits and optional API
inventory; [src/index.ts](../../src/index.ts) exports the actual package surface.

[AHP][ahp] and its official SDK/schema/reducers own AHP wire meaning. [ACP][acp]
owns agent wire meaning. The implemented negotiated versions are AHP `0.9.0`
and ACP `1`; package numbers are separate. The [Unified extension registry][ext]
owns capability v1 schemas, while [the native adapter][native] owns its ACP
extension schemas. This document references those definitions instead of copying
or redefining them. Follow owning definitions when descriptions conflict, then
qualify the changed producer/consumer combination.

The inherited clause owners are [HP][hp], [WS][ws], [CB][cb], [AP][ap] and [MA][ma].
Their approved direction is separate from the implementation evidence below.

## Public promises and falsifiers

| Local clause / inherited clauses | Promise | Concrete falsifier | Acceptance entrypoint |
| --- | --- | --- | --- |
| **HB1** — HP1, HP5; CB2–4 | Negotiate upstream versions, use official state semantics, and advertise only supported optional behavior. Normal execution crosses ACP; no native private imports. | An ordinary peer requires a private reducer, an unadvertised operation executes, or host core imports an Amplifier loop. | [Host protocol tests](../../test/host.test.ts), [public ACP fixture](../../fixtures), [package dependencies](../../package.json) |
| **HB2** — HP2; WS2–3, WS5–6 | Root state, catalog pages and selected history are separate. Filter indexed metadata before paging; detail reads stay cold. | A sidebar/scalar update scans all event logs, starts a dormant worker, or returns global transcript state. | [Host catalog/history tests](../../test/host.test.ts), [catalog integration](../../test/integration.test.ts) |
| **HB3** — HP3; WS4 | Sequence, replay and snapshots follow AHP. Expired replay or missing baselines recover authority without intent replay. Bound queues and disconnect slow peers for recovery. | A delta is applied without its base, a slow viewer grows an unbounded queue, or reconnect reexecutes a command. | [Reconnect/slow-peer tests](../../test/host.test.ts) |
| **HB4** — HP4, HP6; WS1, WS4; AP3–4 | Persist admission before dispatch; preserve engine/native identity and unknown outcomes. Viewer lifetime is independent of execution lifetime. | A lost reply creates another turn, viewer loss kills work, or stale catalog metadata acquires a writer. | [Admission/runtime tests](../../test/host.test.ts), [exclusive owner tests](../../test/owner-lease.test.ts) |
| **HB5** — HP5–6; CB3, CB7 | Scoped capability effects share admission; authenticated origin is distinct from resource routing. Optional owners authorize selectors and retain their own effects. | A UI argument impersonates an agent/session, a host-only topic executes on a session channel, or an unknown effect is retried. | [Capability conformance](../../test/capability-conformance.test.ts), [concurrency/admission tests](../../test/capabilities.test.ts) |
| **HB6** — WS1–2, WS6; CB2–3 | Index repair changes derived discoverability, not canonical history, command authority or product-owner records. Identity adoption requires exact owning receipts. | Index rebuild deletes native history, silently clears a product fence, or trusts a browser-supplied native ID. | [Import proof tests](../../test/import.test.ts), [archive repair](../../test/archive-projection.test.ts) |
| **HB7** — HP4; CB7; MA1–6 | Maintenance covers every configured effect owner with actual held intake/lifetime proof. Exact service identity and release evidence govern reopening. | Zero viewers is declared idle, a missing participant is ignored, or a changed/replayed release proof opens a fence. | [Quiescence](../../test/quiescence.test.ts), [service lifecycle](../../test/service-lifecycle.test.ts) |
| **HB8** — WS1; CB3; MA7–11 | Hiding discovery, purging a retired copy and disposing managed files are distinct reviewed authorities. Preserve canonical history unless separately authorized. | Age or an arbitrary cwd implies ownership; incomplete family/reference coverage permits disposal. | [Retention](../../test/retention.integration.test.ts), [retired copies](../../test/retired-copy.integration.test.ts), [managed files](../../test/managed-files.integration.test.ts) |
| **HB9** — CB1, CB4–6 | Develop with public fixture peers and owned state; record exact source, package, installed and runtime evidence independently. | A local green test is reported as vendor, browser, Linux process or deployed acceptance. | [Run/verification guide](../../README.md#verification-boundary), [family Q1–Q12 gates][gates] |

## Scope, actor and command authority

A capability topic marked `scope:'host'` requires resource `scope=host` and action
channel `ahp-root://`. Context topics use an explicitly selected authorized scope.
Reads and watches require exactly one nonempty scope query, `host` or an AHP
session URI; a bare advertised URI is not implicit host authority. Providers
still authorize the requested scope and typed arguments.

The resource channel is not the originating agent identity. Trusted embedding
may call `invokeCapability(request, {actorId, origin:'agent', session})`. The host
resolves that exact originating session; any non-root channel must match it.
This lets a root-scoped action retain its agent's authorized context. The wire
handler does not accept that binding from client arguments, metadata or claimed
actor fields. A UI actor cannot set it. `args.sessionId` is an owner-validated
selector, never proof that the caller owns that session. Owners enforce own-session
restrictions against authenticated context even when the action's topic is global.

New capability v1 command IDs follow the registry's 1–256-character bound, with
no truncation. Existing longer durable IDs remain passively inspectable through
`x-commandReceipt`; reading their receipts does not admit or replay the effect.
Known no-effect refusals and uncertain effects must not be conflated. A specific
API may permit an explicit exact retry only when its durable no-effect proof says
so; reconnect, timeouts and generic error messages grant no retry authority.

## Cold discovery and rebuilding

The catalog owns bounded indexed native metadata, existence/freshness and parent
links. It reports coverage; an incomplete index is not proof that no children or
writers exist. The host owns admitted identities, receipts, session mappings and
its shared projections. Product owners retain registration/visibility/reference
rules; catalog rebuild cannot erase them or convert discovery into execution
permission. Host projection repair and atomic native-identity claims use public
catalog interfaces with exact ownership proof, not transcript parsing or ordinary
upsert as a substitute for a claim.

Changing visibility does not dispose an allocation or native records. A catalog
row, matching path string, requested URI, self-hashed marker or session selector
alone grants none of those authorities. New reversible product-visibility/reset
semantics under development remain a separately reviewed producer/consumer seam;
this packet does not claim they are implemented or replace the current contract.

Copy consumers use the catalog's trusted, bounded `reconcileFamily` and
`verifyFamily` seams when supported. Initial selected namespace discovery supplies
an exact scoped inventory/revision proof; under admitted child locks the host
revalidates that physical inventory and then the pure indexed revision before
native dispatch. Cache freshness alone cannot account for a child created after
discovery. Incomplete coverage, source changes and unavailable verification refuse
without copying or replaying; native parent checks and actual writer leases still
own execution safety. Metadata discovery never reads canonical body files or
claims exclusion of noncooperating external writers. Legacy peers retain their
existing complete global-freshness requirement; a supported refusal does not
permit downgrade. Acceptance: [focused family integration](../../test/family-refresh.integration.test.ts)
and the selected-family/legacy/unknown regressions in [host tests](../../test/host.test.ts).
Selected-family reconciliation joins the presentation owner's exclusive discovery
boundary. Metadata reconstruction pauses and joins that writer; an unknown reply
retains the exact durable `reconcileFamily` attempt and blocks rebuilding until
trusted response or actual process-exit evidence settles it. The owned stdio
adapter joins the original process exit after a discovery timeout. Revalidation
is read-only and does not join the derived-index writer queue.

These are public catalog seams, not private SQL contracts or new AHP fields.

Upstream omitted-view semantics remain authoritative: omitting `view.turns` can
request all retained turns. Normal clients request bounded windows, but the host
must not silently truncate required state to claim a universal memory bound.
Full-history response size and OS resource limits remain explicit limits.

## Evidence, gaps and change process

The last runtime qualification for this local packet is source `721c7af`: 86 host,
capability and quiescence regressions, plus four independently installed Node22
capability tests, with no skips in those groups. This packet adds only documents;
compiled runtime bytes are compared with that sealed artifact. These counts are
not a full current native, catalog, family-feature or deployment acceptance claim.

Optional installed native/catalog cases require the explicit fixture environment
in README. External peer/account, rich UI/device, complete-owner service-manager
and deployment gates belong to the [family evidence ledger][status]. In
particular, Linux manual-systemd/pidfd qualification of the next coherent package
is pending at this documentation checkpoint; a macOS signed fixture is not proof.
Numeric performance targets in the family plan remain targets unless a named
measurement receipt qualifies them. Do not infer compatibility from package names.

For any change, name HB plus inherited clauses, producer/consumers, effect/storage
authority, a falsifier and the smallest real acceptance fixture. Wire changes go
to the upstream or extension owner first. New direction must be labeled proposed
and ratified at its owning family contract. Keep old evidence as historical
receipts and record new source/package/runtime adoption separately.

[ahp]: https://github.com/microsoft/agent-host-protocol
[acp]: https://agentclientprotocol.com/protocol/overview
[ext]: https://github.com/microsoft/amplifier-unified-protocol-extensions
[native]: https://github.com/microsoft/amplifier-app-acp
[gates]: https://github.com/microsoft/amplifier-unified/blob/main/docs/architecture/delivery-plan.md#required-acceptance-scenarios
[status]: https://github.com/microsoft/amplifier-unified/blob/main/docs/architecture/implementation-status.md

[hp]: https://github.com/microsoft/amplifier-unified/blob/main/contracts/host-protocol.v1.md
[ws]: https://github.com/microsoft/amplifier-unified/blob/main/contracts/working-set.v1.md
[cb]: https://github.com/microsoft/amplifier-unified/blob/main/contracts/component-boundaries.v1.md
[ap]: https://github.com/microsoft/amplifier-unified/blob/main/contracts/agent-protocol.v1.md
[ma]: https://github.com/microsoft/amplifier-unified/blob/main/contracts/maintenance.v1.md


## Trusted message quote forwarding

The optional server-only engine principal is asserted exactly at
`initialize.params.clientCapabilities._meta['amplifier.dev/messagePrincipal']`
with `{version:1,account}`, alongside the native v1 negotiation. It comes from
trusted composition, never a browser body, client identity, per-action actor or
path. Ordinary quoted inputs require the actual peer's messageInteractions v1
quoteMeta grant. The host validates the bounded exact reference and binds its
native session identity at prompt dispatch, preserving the original input command.
Native authority freezes canonical public text and validates stale epochs/digests.
Unknown quoted deliveries are retained without replay; unsupported queued inputs
retain their drafts and identities. Local selection and passive reaction authority
are outside this forwarding seam. Acceptance: [protocol regressions](../../test/message-reply.test.ts)
and [installed full-native quoted execution](../../test/message-reply.integration.test.ts).


The existing initialized ACP capability projection is the quote availability
marker. Bounded selected history reconstruction validates canonical locator and
frozen quote metadata before copying it into user/assistant overlays, removes
obsolete or historical-only selectable references, and preserves original host
receipts and admission provenance. A completed turn does not trigger a host-side
eager whole-history scan; a client requests the bounded selected refresh.


The post-settlement selected-chat refresh trigger is the new
`session/metaChanged` value at ACP `lastSettledTurnId`, after joined updates and
idle finishing cleanup with a completed original receipt. It is advisory, bounded,
and has no execution/history-read effect. Clients process each new value once and
defer while another turn is busy. Protocol tests cover the early turnComplete
race and queued next input.

### Cold selected message capability projection

A successful selected passive native history read retains its negotiated ACP
capabilities in the existing session metadata path. This allows canonical reply
and reaction references in copied or transferred chats to be used before any
runtime is mounted. It preserves config options, command receipts and settlement
markers; it does not infer effective bundle/provider configuration, load a
session, resume a worker or replay an input. Native history remains the owner of
canonical locators and annotation copying.

### Negotiated durable terminal input failure

An ordinary prompt error is unknown unless the configured native peer advertises
`inputOutcome:{version:1,method:"_amplifier/input/receipt",passive:true,durable:true}`
and the same dispatch returns an exact bounded `data["amplifier.dev/inputOutcome"]`
receipt. The receipt must bind the original native `sessionId` and admitted AHP
`inputId`, with `version:1,status:"failed",terminal:true,noReplay:true,
inputPersisted:true`. `effectBoundary` is one of `unknown`, `input-persisted`,
`provider-request`, `model-output`, or `tool-effects`; `error` contains only bounded
`type` and safe public `message`. Unknown fields, including `executed:false`, are
not terminal proof. The native owner must durably write the receipt before sending
it; the host does not reconstruct one from an exception class or a last-failure
sidecar.

After joining update projection, the host records the original admission as
failed and retains the native proof in its receipt. This does not roll back
effects, grant retry eligibility, replay a queue, or reclassify any previously
unknown command. The original input ID remains nonreplayable across restart.
Missing, mismatched, nonterminal or unnegotiated proofs remain unknown. Explicit
new corrected input is independent of the failed original input.


## Additive pre-retirement admission abort

An optional trusted supervisor/participant port can settle an exact unknown
`distribution-update` admission before native retirement. It does not change
execution or replacement authority. The Host requires its own durable stage,
matching current launch/scope, no still-running transition, distinct authenticated
abort proof, and a conclusive receipt from every attempted owner in reverse order.
Legacy stage absence and any unknown owner result keep intake closed. Exact retries
observe original settlement and never repeat admission or update work.

The exported `AdmissionAbortBinding`, `AdmissionAbortRequest`,
`AdmissionAbortProof`, `AdmissionAbortOwnerReceipt`, and
`HostAdmissionAbortReceipt` are defined in [quiescence.ts](../../src/quiescence.ts).
The completed wire receipt is `host-admission-abort-v1`; integration obligations
and passive reads are documented in the [README](../../README.md#pre-retirement-admission-abort-optional).
[Focused acceptance](../../test/admission-abort.test.ts) falsifies late-timeout
races, wrong identity/proof, missing owner coverage, retirement/legacy fences,
changed retries, and owner-commit/lost-reply recovery through the public Host.
This is source/API coverage, not authority to hot-patch or reopen an older deployed
unknown fence.
