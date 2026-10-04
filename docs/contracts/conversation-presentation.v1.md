# Conversation presentation boundary, version 1 (candidate)

This host boundary implements the approved WS1/WS4 and MA11 direction for a
reviewed, reversible discovery reset. It changes product visibility only. It
neither revokes execution authority nor changes canonical history, workspace
files, native visibility, execution receipts, provenance, queues, ownership
fences, settings or independently owned artifacts.

The independent F17 boundary review superseded the initial candidate's global
recovery coupling. The preserved d8508cfe packet is earlier evidence; this
contract requires no global maintenance hold, participant census, cross-owner
reference query, or post-restart revalidation API. Product recovery must call
this distinct presentation branch directly instead of wrapping it in a whole
application reset. Normal pre-existing host maintenance fences still apply to
new mutations; visibility cannot bypass them.

## Public ports and authority

The public TypeScript definitions are in
[`src/presentation-types.ts`](../../src/presentation-types.ts). The trusted
embedding supplies `PresentationActor`; wire arguments never establish actor,
native identity, originating agent session or filesystem authority.

- `prepareConversationPresentation({commandId,operation:'reset'|'restore',selection:{kind:'explicit',sessionIds},resetCommandId?}, actor)` retains an immutable selected review. Restore refers to the original exact completed local reset.
- `readConversationPresentationReview({reviewId,cursor?,limit?}, actor)` returns bounded metadata pages and an ordered selection hash. `observedRevision` is diagnostic, not a global reset/undo CAS.
- `applyConversationPresentation({commandId,reviewId,reviewHash}, actor)` atomically validates selected native identities and each selected visibility revision, then persists the original before-images, markers, local receipt and projection outbox.
- `conversationPresentationReceipt(commandId, actor)` returns the original local effect plus separate derived projection progress. `readConversationPresentationEffectReceipt(commandId)` is a trusted metadata-only exact effect read.
- `reconcileConversationPresentation(commandId, actor)` reads original child receipts only. It does not dispatch any missing original page or replay the original reset.
- `rebuildConversationPresentation({commandId,expectedRevision}, actor)` explicitly reconstructs the derived projection from retained identity/marker authority. It can repair an interrupted reset after host death. This new repair command does not resubmit the original user operation or any native input.
- `reconcileConversationPresentationRebuild(commandId, actor)` observes an original repair's exact child receipts. Missing pages remain unconfirmed; another explicit derived repair may reconstruct from authority.
- `inspectConversationPresentation()` reports discovery readiness and policy/checkpoint revisions.
- `withConversationCatalogRead(callback)` guards discovery reads before and after projection changes. It is not an execution-admission or exact-ID authorization boundary.

`HostConfig.conversationPresentation` enables this owner when the configured
catalog supports the visibility projection protocol. Its optional metadata port is
`reconstructMetadata({commandId,source,readMappings})`, a trusted scheduler for
repairing lost metadata. Existing complete metadata can be reprojected without
that callback. Missing metadata without a reconstruction owner remains explicitly
unavailable; identities cannot be guessed.

## Selected transaction and undo

The host synchronously reserves all idle selected admission mutexes. If any
selected admission is already in progress, it refuses before effect rather than
holding a partial family lock. Existing selected viewers, active or unknown
inputs, pending queue/steering and unresolved ownership transitions prevent
hiding. Relevant subscriptions and new admissions use the same mutexes. A new
selected action waits until the marker transaction releases; unrelated sessions
continue. Locks are released before catalog projection I/O.

Restore does not stop ongoing exact-ID work when its target visibility is visible.
A restore that reinstates a previously hidden flag follows the hiding guard.
There is no query to immutable artifacts, completed receipts, exports or undo
records. They remain reachable by their authorized exact identifiers. Future
scheduled work retains its original admission and permission checks.

Each selected row's identity and visibility revision must still match its review.
A mutable title does not establish or revoke native identity. Undo checks the
selected rows against the original reset revision, not the current global policy
revision. Disjoint reviewed resets and disjoint undos therefore coexist. Changes
to the same selected row require a new review; a changed native identity refuses.

The review's before-images and local effect are immutable. `effect.status` is
`completed` once the SQLite marker transaction commits, or `refused` with
`executed:false` on a known local pre-commit refusal. Derived failure does not
change completed into unknown. Receipt `projection.status` independently reports
`pending`, `unknown` or `ready`. Product UI must distinguish a saved visibility
change from list reconstruction readiness. An exact command repeat returns the
receipt, never reexecutes the marker transaction.

## Discovery versus exact identifiers

Product-hidden rows are excluded by indexed catalog filtering before pagination.
Host coordination discovery and ordinary Recall inventories use the same list
readiness boundary. Root summary notifications cannot reinsert a hidden row.

Authorized exact-ID status, subscriptions, history, original command/undo
receipts, resources/artifacts, Recall source reads and deferred commands remain
available despite hidden discovery or an incomplete derived projection. The host
uses its retained canonical mapping when a derived catalog row is temporarily
missing; conflicting identities still refuse. Existing native deletion, missing
workspace, managed allocation, transfer, relocation and unknown execution guards
remain unchanged. Hiding does not make unknown work complete or runnable and
never triggers replay. Visibility itself does not disable execution.

Every composition consumer must distinguish these two uses. Workspace/Recall
lists, migration discovery and complete inventory claims need the list guard.
Authorized exact-ID reads and original receipt lookup must not be wrapped in it.
New mapping claims still require their own verified native creation/adoption
proof. The listing guard is not that proof.

A creation reservation with no native identity or native location revision is
not a retained canonical mapping. Reconstruction excludes that reservation only
when its lifecycle is still creating or failed and the host retains an unknown
creation receipt for that exact session under its internal `host:creation`
origin. The failed snapshot and original receipt remain available by exact ID;
creation and execution are not replayed. A possible native checkpoint does not
authorize guessing a mapping from a path or timestamp. Reconstruction counts
confirmed mappings, not these unresolved reservations. Every bound session and
every unexplained missing mapping still requires retained canonical metadata.
This distinction does not add failed reservations to catalog discovery or
resolve their original outcomes.

## Bounds

Selection contains 1–500 explicit unique AHP IDs; no live cursor is an immutable
all-conversations selection. Reviews expire after ten minutes (`expiresAt` is
Unix milliseconds). Pages contain at most 50 rows and 256 KiB of row metadata;
a smaller page has an exact next cursor. Each retained metadata row is at most
16 KiB, the review at most 8 MiB, and at most 64 live unapplied reviews are kept.
Oversized input refuses without truncation. Expired unapplied reviews may be
removed; reviews attached to effects remain.

Private metadata reconstruction pages contain at most 100 rows, with a manifest
ceiling of 100,000 rows/64 MiB. Public product journals retain hashes, counts and
command references rather than canonical paths or private before-images.

## Catalog reconstruction and restart

The host's projection source UUID survives process restart and catalog loss.
Each original bounded catalog page is recorded before dispatch. Listing is closed
before incomplete projection can escape. No uncertain page is automatically
redispatched. Passive acknowledgement recovery may finish a proven original
projection. Otherwise an explicit repair reads retained markers, including false
flags, and creates new derived pages against the catalog's actual checkpoint.
It leaves all original marker effects, receipts and native inputs unchanged.

For metadata loss, the trusted reconstruction owner launches the catalog without
`--scan-on-start` or `--hint-directory`, with `--scan-interval 0` and preferably
`--workspace-check-interval 0`. Seed exact canonical parent/child URI mappings and
retained storage paths before requesting a new scan. Await the new scan's runId
completing with zero issues, not a previous scan's complete status. Automatic
scans/hints must not race seeding; later maintenance needs its own ordered owner.

A scan enumerates existing directories; it cannot reobserve a retained home that
has disappeared. After the scheduler returns, the host pages the captured
manifest (at most 100 rows per page) and reobserves each exact known storage path
through the same durable discovery attempt boundary described below. The hint
must identify that retained URI with no unresolved issues before freshness,
identity and visibility verification can open listing. Native absence remains a
derived presence observation, independent of product hiding and native deletion.
Pathless historical mappings retain their existing identity checks. A known path
without a hint owner keeps reconstruction unavailable. This adds no filesystem
inventory, history-body reads, native commands, or public wire fields.

Native `history.persisted` hints and hints buffered during session creation use
one durable host outbox. It coalesces at most 512 native directory paths, each at
most 8 KiB. A presentation transaction pauses discovery dispatch synchronously
and joins an already admitted hint before metadata reconstruction. Pending hints
remain saved across failed projection and host restart. They drain only after
confirmed metadata and visibility readiness. Exact host mapping writes, exact-ID
reads, original receipts and native execution do not take this discovery hold.
No native command is queued or replayed by this outbox.

Capacity overflow records an explicit reconstruction requirement; it never
grows an unbounded queue or claims complete discovery. A successful full metadata
reconstruction clears only overflow observed before its scan boundary. New
overflow during that reconstruction keeps listing unavailable until another
explicit metadata repair. Counts and uncertainty, never paths, appear in host
`diagnostics().catalogHints`.

Each dispatched hint records a private `attemptId` before sending. A timeout
cannot establish writer quiescence. The built-in `StdioCatalog.hint` waits for its
owned child process's actual exit on timeout/transport failure before reporting
settlement; an ordinary complete RPC refusal leaves a healthy process running.
A custom adapter's unclassified error, or host death with an unresolved attempt,
keeps reconstruction unknown before any seeding or scan. Exact-ID work remains
available. The optional trusted `settleDiscovery(attempt)` callback may return
`{attemptId,evidence:'response-settled'|'process-exited',ownerReceipt}` only from
retained evidence for that original writer. `Catalog.hint(path,{attemptId})`
receives the same private attempt identity so a catalog owner can bind its
receipt. A replacement PID, a new catalog, caller assertions, or elapsed time
are not evidence. Without that owner evidence the host refuses repair. Accepted
settlement is retained durably; the original failed rebuild receipt is unchanged
and a new explicit derived repair is needed. This callback never reissues the
hint or an original user operation. Independent scanner/inbox writers still
require the reconstruction owner's launch and exclusion policy described above.

The host independently verifies every exact mapping, native storage path,
visibility flag, manifest count and final projection checkpoint before opening
discovery. Even an empty manifest requires an explicit checkpoint. Missing,
aliased, conflicting or unverified legacy mappings remain unavailable rather
than being silently rekeyed. A failed reconstruction limits discovery completeness;
it does not fence unrelated execution or retained exact-ID recovery.

## Acceptance and limits

Journal tests cover bounds, actor binding, per-row CAS, mixed before-images,
disjoint undo, local authority preservation, every projection interruption stage,
explicit reconstruction, empty/missing pages and in-flight list races. Public
host tests use an independently installed catalog and ACP fixture: selected
viewer/active/queue refusal, hidden exact-ID history/resources/input provenance,
deferred scheduled input, unrelated work during a selected transaction and
catalog loss. Actual SIGKILL cases test post-marker/pre-page, between-page and
post-catalog-commit/pre-reply recovery with preserved canonical bytes.

These are owned offline fixtures. They do not establish the product adapter,
browser UI or live deployment. No production native model or account call is
part of this qualification. The earlier Linux service qualification is separate.
