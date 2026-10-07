# Host live library query v1

This source lane implements the approved eventual-consistency direction. It does
not qualify installed or live behavior. Standard AHP listSessions is unchanged.

Optional negotiated Catalog libraryQuery is exposed to a trusted Workspace owner
through Host.queryLibrary. Owner-configured roots are intersected with Host roots;
managed grants come separately from the Host allocation owner. User input cannot
choose source/incarnation, private DBs, status evidence or arbitrary roots. Older
Catalogs negotiate unavailable and keep ordinary queries.

The Host supplies at most64 current resident/admitted URI facts, bounded64KiB;
SQL filters them before LIMIT. This set is not a complete durable unknown inventory.
Unknown receipts and existing transfer/lifecycle/relocation/history/steering/import
journals stay authoritative and may outnumber residents. Library observations do
not mutate old receipts or read native/Host transcript bodies.

Semantic turn/input boundaries and committed receipt-status changes point-update
observations and invalidate the Workspace capability. Receipt observation fires
only after commit; rollback publishes nothing. Token chunks never schedule library
writes or change the live turn's ordering timestamp. Canonical title/archive writes
retain their existing explicit synchronization path. Current selected AHP state is
independent of index delivery.

Startup and explicit reconcileLibrary run a paged metadata-only pass:100 URI keys,
then existing lightweight session metadata and indexed unresolved checks per row.
It never runs per query. Observation-only writes cannot overwrite canonical titles,
parent/child kinds, visibility, location, archive, or mappings. Source identities use
the canonical Host state directory on first admission, then persist in the Host
database. A stopped full restore carries that identity to its new directory.
The identity is never inferred from a Catalog row or a client-supplied value.
An older backup captured before this migration must first be upgraded at its
original location; restoring such a backup elsewhere is not qualified.
Source/incarnation/revisions order observations;
restart preserves retained unknown/error and invalidates prior live claims.

Delivery failure is recorded in bounded in-memory freshness state; no failed user
action is replayed. An older late acknowledgement cannot clear a newer failure.
A failed/missed write may leave last-indexed observations stale. Explicit repair
and startup refresh them without changing retained outcomes. No durable delivery
outbox/checkpoint or always-hot second status authority is introduced. At most64
point jobs and128 distinct in-flight row writes are admitted. Failure markers are
bounded and capacity loss is degraded, never silent truncation. Shutdown joins
owned metadata jobs before Catalog and Host storage close.

Cold runtime unknown alone is not attention. Known uncertain effect/error and
input-needed are attention; current working is working. Historical settled never
proves cold runtime idle. Complete observation freshness describes a completed
Host metadata pass, not exact current global/external activity. Global counts are
not promised. Live query guards may request explicit refresh; Host translates the
Catalog -32014 refusal into available:false/refreshRequired:true, not an empty
successful library. Clients retain displayed pages until refresh.
