# Fork presentation and attachment binding, proposed v1

The canonical Native copy remains the resume and message-mutation authority.
Host retains a derived presentation of the exact copied prefix so a PDF fork can
show the original public input and card without exposing provider instructions.
Host wiring is opt-in through trusted `HostConfig.forkPresentation` callbacks.
The attachment protocol v1 export is sealed separately; full graph and browser
acceptance remain open.

## Authority and binding

`ForkBinding` in `src/fork-presentation.ts` identifies the original fork command,
engine, source Host URI and Native ID, reviewed source history revision, target
Host URI and Native ID, confirmed creation revision, optional user boundary, and
`workReplayed: false`. Only Host creates it after validating the completed Native
lifecycle receipt against its original retained command. Wire callers cannot
assert this proof. Host exposes navigation facts in `_meta['amplifier.dev/fork']`;
this is an owned additive extension, not a Native parent relationship.

All visible rows in a copied turn are matched using existing Native row position,
Native message identity suffix, and public-text `sourceDigest` when present. The
24 hexadecimal identity suffix is the existing Native row fingerprint, not a new
full SHA-256 row digest. Full row equality is not reconstructed from public text.
The identity suffix incorporates Native's complete canonical row and position.
Source and creation revisions must equal the validated fork receipt. The selected
source prefix ends after all response/tool rows for the reviewed user input.
The prototype accepts at most 200 turns and 2 MiB of presentation facts. Production
capture needs explicit paging/coverage for larger histories; it must not silently
claim complete presentation for omitted rows.

The real Native passive reader fixture tests these identities. Exact copies retain
them; bundle/system-row removal, recovery repair, voice group identity changes or
other transformed copies may not. Such rows retain honest Native fallback until
an explicit owner-proved mapping exists. Never match by text, timestamp, inferred
ordinal, or stripped attachment scaffolding.

## Derived display, not executable turns

`ForkProjection` retains only binding, selected public text, immutable attachment
descriptors, source/target row anchors, and a historical outcome observation.
It never contains source Turn objects, runtime state, jobs, permissions, model
selection, action receipts, or response/tool payloads. The observed completion
requires an exact source Host receipt command and source chat match. Failed,
cancelled, unresolved, or unavailable receipt observations remain unknown.

Host must load source display text from its original durable StandardMessage,
and source completion from its original receipt authority, under the same selected
source lock. It stores the bounded prepared source plan and derived projection in the
`fork_projection` column of its original `lifecycle_commands` journal. A separate
marker validates that optional column before restart normalization; no additional
database or transcript is created. The plan is bound to the retained lifecycle
command and manifest digest. It must not insert
copied rows in `turns`, `receipts`, `receipt_attempts`, or executable history-edit
inputs. A manifest hash checks retained data consistency; it is not authorization
or a MAC. Existing Host ownership and the validated lifecycle command provide trust.

When reading the fork, canonical target history still supplies message references,
response text, tools, quote relationships, and ordering. A display match can replace
public input text/card descriptors and annotate the observed historical outcome.
It cannot emit a new `chat/turnComplete` execution event or create target receipts.
Do not set message `historicalOnly`: that existing flag denies quote/edit/fork for
archived context. Use a separate presentation observation while preserving target
canonical mutation references. Truly unknown outcomes keep their fallback notice.

The initial target history revision is a capture boundary, not a requirement that
the target never append. Later reads require the exact captured target row IDs,
positions and digests. Newly appended rows get no source facts. Changed/archived
epochs, changed canonical rows or an ambiguous boundary lose inherited display.
Source deletion must not promote retained observations into execution authority.

## Resources-owned target attachment grants

`ForkAttachmentBindingRequest` is a private Host-to-Resources callback proposal.
It includes `ForkBinding`, `projectionDigest`, and selected items with turn ID,
source/target row anchors and a committed attachment's source URI, original name,
content type, size and SHA-256. Resources must resolve those integrity fields from
its own committed metadata; neither a client card nor an arbitrary parent link is
sufficient. Request identity is `forkDigest(request)`: SHA-256 of UTF-8 JSON with
object keys recursively sorted, arrays unchanged, no insignificant whitespace.

Resources verifies source/target ownership and the trusted Host binding, then
idempotently retains or copies the referenced immutable bytes and returns a
target-scoped descriptor. Its durable operation identity is the fork command plus
exact request digest. Reusing that command with different scope/bytes refuses.
Resources must reconcile partial completion after restart without rerunning Native
fork or creating duplicate bodies. A trusted callback is the API boundary; these
checks cannot be replaced by a wire-supplied Host-looking object.

The receipt declares owner/version, command, request digest, source/target Host
URIs, `completed|refused|unknown`, exact source-to-target descriptors and
`replayed: false`. Host verifies complete selected coverage, target conversation
scope, filename/type/size/digest, and one-to-one mapping before using target cards
for edit/regenerate. Unknown/refused status creates no target grants. Historical
transfer evidence remains viewing-only; URI query rewriting creates no grant.

Host verifies the original durable completed Native receipt, retained request
digest, engine/source/target mappings and fresh bounded target row anchors in
`verifyForkAttachmentBinding(request)`, an async trusted embedding method.
Resources must call that verifier and own its byte/grant operation. This Host
change does not implement Resources copying. No fallback widens
`AttachmentService.prompt`'s conversation ownership check.

## Integration and acceptance still required

Capture must cover ordinary and managed forks, lifecycle receipt reconciliation,
restart and cold catalog rediscovery. Managed confirmation can create the target
Host record before ordinary lifecycle materialization; provenance must be retained
there too, without changing Native `parent_id: None`. Web projects this provenance
to the existing original-chat link and independent-root fork presentation.

Source-model/configuration copying stays Native-owned. The projection neither copies
selection nor claims candidate execution/model acceptance. Recovery, bundle,
reset-model, imported history, voice-only groups, hidden reasoning and unrelated
client actions preserve their existing contracts. Mapping omissions must be explicit.

Next acceptance uses a fresh owned synthetic PDF session, not the confirmed fork:
source/installed Host tests; exact text/card/hash and origin link after reload;
unchanged source; Resources denial for unrelated scopes; crash/retry reconciliation;
canonical quote/reaction/edit references; and separately authorized fresh target
execution with copied configuration. Full graph/browser acceptance remains open.

The agreed whole-plan attachment bounds are 64 referenced items, 256 MiB total,
32 MiB per file and 256 KiB streaming chunks. Host preflights body-free committed
metadata before Native fork where available. Native completion is recorded before
attachment retention. An interrupted/refused copy grants no cards and leaves the
Native fork known complete. `reconcileForkPresentation(commandId)` is an explicit
owner retry of that same retained plan, under source and target Host locks; it
never calls Native fork. Target mapping becomes visible only after complete exact
Resources receipt verification. Source projection coverage is reported separately.
