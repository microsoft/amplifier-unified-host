# Conversation presentation boundary, version 1 (candidate)

This is a host integration candidate for the approved WS1/WS4 and MA11 direction.
It does not change AHP or ACP schemas and is not a whole application or native
history reset. Implementation and complete owner qualification remain separate.

## Public ports

- `prepareConversationPresentation({commandId, operation:'reset'|'restore', selection:{kind:'explicit',sessionIds}, expectedRevision, resetCommandId?}, actor)` retains an immutable review. The explicit selection contains at most 500 unique AHP IDs; all identifiers and aggregate metadata are bounded before retained payload I/O. Restore refers to one exact original reset and its retained flags/identities.
- `readConversationPresentationReview({reviewId,cursor?,limit?}, actor)` returns at most 50 reviewed metadata rows, exact total count, ordered selection hash, expiry and preserved-part explanation. It reads no native history bodies and starts no agent.
- `applyConversationPresentation({commandId,reviewId,reviewHash,maintenance:{fenceId,commandId}}, actor)` requires an actual held recovery fence, exact trusted actor binding, fresh policy and per-row CAS, and complete declared presentation-reference protection. It changes only product presentation visibility. It never repeats an admitted command.
- `conversationPresentationReceipt(commandId, actor)` returns the original host receipt. `reconcileConversationPresentation(commandId, actor)` observes original catalog child receipts only, without redispatching a reset/restore.
- `rebuildConversationPresentation({commandId,expectedRevision,maintenance:{fenceId,commandId}}, actor)` is a separately admitted derived-index reconstruction from retained authoritative identities and visibility markers. It never replays a reset, restore, native command or agent input.
- `inspectConversationPresentation()` reports availability, host policy revision and catalog projection/reconstruction readiness.
- `withConversationCatalogRead(callback)` checks readiness before and after the bounded read. Every product catalog listing/adoption consumer must use this guard; there is no unfenced fallback.

The host exports concrete TypeScript DTOs from its public package. The wire
product adapter is independently owned and must not invent a client-supplied
actor, fence, native identity, global catalog revision or completion proof.

## Retained authority

The host persists one opaque projection source UUID across process restarts and
catalog loss. It retains immutable exact identity/before-image metadata, original
selection and batch hashes, host policy/per-row revisions, command receipts and
projection checkpoints. Reset hides the selected product rows; restore uses the
exact prior visibility flag after a fresh review and CAS. Neither operation
changes nativeDeleted, native archive/workspace state or managed file authority.

Canonical native metadata/transcripts/events, workspace/managed files, input and
provenance indexes, admitted/unknown receipts, queue-consumption tombstones,
transfer/relocation/disposal fences and independently owned records remain intact.
Retained records do not become consent or permission to replay work.

Protection is distinct from `retentionHide` and `managedFiles`. Configured owners
must provide genuine held coverage for active/queued/unknown work, required future
work and dependent records that cannot remain recoverably reachable. Merely
reporting idle, having zero viewers or returning a no-op lease is insufficient.
Absent or partial coverage leaves this capability unavailable. A selected client
is protected without synchronizing its private draft or editor state.

## Catalog projection and reconstruction

The catalog remains derived. Its qualified `projectSessionVisibility` protocol
supports at most 100 unique indexed identities per batch, stable source ownership,
monotonic checkpoints and exact child receipts. The host records every original
request before dispatch. An old successful retry cannot overwrite newer state.
Its checkpoint is not a global catalog snapshot revision; initial selection is
explicit only.

Before incomplete projection/reconstruction can be served, the host durably
fences listing and ordinary adoption. Root/session resource paths and every
optional product catalog consumer observe that fence. Passive original receipts
and metadata writer hints remain available. An unknown child receipt never
implicitly opens listing.

Reconstruction captures a stable-URI manifest of every host-owned marker,
including explicit false flags, exact unique count, bounded page digests, rebuild
epoch and final checkpoint. It first verifies complete metadata discovery and
exact mappings, then reconstructs markers in bounded pages, verifies each identity
and flag and the aggregate count/checkpoint, and finally CAS-opens readiness.
Empty reconstruction requires an explicit completion batch. Missing rows,
conflicting source/identity, incomplete discovery or changed checkpoints keep the
fence. Native external-writer coverage is not inferred from the catalog.

## Required falsifiers

Reset/undo and rebuild must preserve byte hashes of all canonical and retained
authority; cold reads must not start an agent or read native event/transcript bodies.
Test duplicate/changed commands, changed review/identity/row revisions, prior true
flags, native/workspace exclusion, retained active/future/unknown owner work,
selected viewers and missing coverage. Kill/reopen before dispatch, between two
pages, after catalog commit before acknowledgement and before readiness CAS.
A 105+ row snapshot, empty snapshot, absent second page, unexpected checkpoint and
catalog loss must all retain correct list/adoption fencing and exact restoration.

Candidate limits and API names above are proposed integration details; they are
not a claim of shipped/runtime/browser acceptance. The preserved Linux service
qualification is a separate completed gate and does not prove this feature.

## Frozen embedding contract and acceptance boundary

The source of truth for method arguments and results is
[`src/presentation-types.ts`](../../src/presentation-types.ts). `PresentationActor`
is a trusted embedding value, never wire data; its identity/origin/optional agent
session must match at preview, apply, page read and original receipt lookup.
Agent origin retains its originating session; application authorization determines
which explicit shared selection it may administer. Host-only resource scope does
not erase that origin. No native ID supplied by a browser proves ownership.

`expiresAt` is Unix **milliseconds**. A preview is valid for ten minutes. Pages
contain at most 50 rows and 256 KiB of row metadata (a smaller page has an exact
next cursor). Individual retained metadata is limited to 16 KiB, the complete
explicit review to 8 MiB, and there are at most 64 live unapplied reviews. Expired
unapplied reviews may be removed; any review attached to an effect remains.
Oversized metadata is refused without truncation. The product adapter stores
review/selection hashes and command references, not the private before-images.

Apply must execute **inside** the existing `withQuiescenceMaintenance` callback
for the exact recovery fence. Matching two strings outside that live callback is
insufficient. Detached continuations lose authority when the callback ends.
Service-stop and distribution-update contexts cannot grant presentation rights.
Preview may run inside that same callback or through ordinary host admission.

The selected protection coordinator receives the already-held recovery owner
census. It must derive its distinct `presentationReset` inspection from those
actual leases, not acquire them a second time. Its `leaseId`, owner set, selected
hash and host fence must match. Selected current viewers, unknown/pending input,
ownership transitions and required future work protect the selected rows.
Immutable artifacts, exports, completed receipts and undo links are not by
themselves blockers: exact-ID retained reads and recovery remain available and
those records are untouched. A reference owner must report any dependency whose
only recoverable access path would be lost. Root composition owns this complete
configured-owner audit; the host fixture does not qualify those owners.

`PresentationReceipt` separates `effect.status` from `protection`. A conclusive
local refusal has `executed:false`, even when reference acquisition is uncertain.
A completed effect remains completed if releasing its selected hold loses an
acknowledgement. In both cases `protection:'unknown'` prevents a product adapter
from claiming global recovery settlement. Passive reconciliation checks exact
original catalog receipts and calls only the selected coordinator's reconcile
port. It never dispatches a missing original page.

## Reconstruction scheduling obligations

The trusted `reconstructMetadata` callback receives bounded private mapping
manifest pages (100 rows, 16 KiB per row; at most 100,000 rows/64 MiB in the retained
manifest). Root must launch a replacement catalog without `--scan-on-start` or
`--hint-directory`, with `--scan-interval 0` and preferably
`--workspace-check-interval 0`. Seed exact canonical parent/child URI mappings,
including native storage paths where retained, before explicit `scan`. Poll its
status to complete with zero issues, then return. No automatic 300-second scan
may race seeding. Existing metadata hints and migrations must share that schedule.

The host independently checks every mapping, native source path, visibility flag,
manifest count and final checkpoint. An empty manifest still needs an explicit
empty projection completion. A separate explicit reconstruction may repair a
partially projected local policy; the original reset then reconciles against that
complete repair at the exact unchanged policy revision. It does not rerun the
original visibility transaction or native work.

Legacy host rows without retained canonical catalog mappings cannot be guessed
after index loss. They remain fenced until their original mapping is restored.
Do not silently rekey, accept a caller identity, or claim that a live catalog
cursor is an immutable all-conversations snapshot. The supported initial
selection is explicit only.

**Current recovery limit:** passive final-ack recovery works across host restart.
An interrupted multi-page projection can be explicitly reconstructed while the
original genuine recovery hold remains live. After host death the global gate is
intentionally unknown; re-entering mutation maintenance requires independently
verified owner-hold revalidation. This candidate supplies no boolean bypass or
implicit release for that case. That composition mechanism is still required
before claiming automatic post-crash reconstruction.

Source acceptance covers immutable selection, actor/CAS/expiry/byte bounds,
actual host maintenance scope, no-op mutation replay refusal, selected-reference
refusal, lost catalog/release acknowledgements, mixed prior flags, 105-row and
empty reconstruction, readiness races, and an installed catalog over public
stdio. The installed fixture uses a failing agent executable and rejects catalog
transcript/event opens; all canonical fixture bytes remain identical. Full
product-owner, browser and live-deployment acceptance are separate gates.

## Pending design review

The current candidate uses the existing recovery hold. An independent boundary
review is evaluating whether presentation-only visibility requires this global
maintenance dependency or can use a smaller selected admission/reference lease.
No new all-owner hold-revalidation API is implemented or implied by this packet.
Any replacement must preserve the concrete viewed/active/queued/required-future
and unreachable-reference protections above without treating immutable retained
records as blockers. The current package is not a shipped product feature.
