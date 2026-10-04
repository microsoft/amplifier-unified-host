# Authoritative SQLite schema admission

Host startup must not manufacture an empty command ledger or an open intake when
an existing authoritative table is missing. This follows HB4, HB6 and HB7 in
[the host boundary contract](contracts/host-boundary.v1.md). The guard is local to
this Host; it does not change ACP/AHP semantics or native history ownership.

## Inventory and admission

| Initializer | Database / tables | Treatment |
| --- | --- | --- |
| `Store` | `host.sqlite`: admissions/receipts, input queues, session identity, turns, lifecycle, transfer, import, history-edit and export records | Required authoritative schema before restart normalization |
| `QuiescenceGate` | `host_quiescence_*`, `host_service_releases` | Required once initialized, including when quiescence is subsequently disabled |
| `ManagedFilesJournal` | `managed_file_reviews`, `managed_file_effects` | Required disposal review/effect evidence |
| `Retention` | `retention_reviews`, `retention_items`, `retention_commands` | Required reviewed hide/effect evidence |
| `ConversationPresentation` | `presentation_state`, reviews, markers, commands, projection batches, mappings and rebuild records | Required owner records; optional only before first initialization |
| `ManagedAllocations` | separate `managed-allocations.sqlite`, `allocations` | Required creation/ownership evidence |
| `CatalogHints` | `presentation_hints`, `presentation_hint_state`, `presentation_hint_settlements` | Derived native discovery observations; existing bounded rebuild semantics remain |
| `OwnerLease` | separate `host-owner-lock.sqlite`, `owner` | Transient OS lock, not command authority |

`Store` validates every present/previously initialized authoritative namespace,
not just the configured optional owner, before its own restart writes. Existing
file owners first use a **read-only SQLite connection**. This matters after a
crash: closing a writable preflight connection could checkpoint and alter a
retained WAL even when validation failed. Owned-file refusal leaves main/WAL
bytes unchanged; SHM is derived coordination state and is not included in that
byte-equality claim. The separate OS lifetime lease is still acquired normally.
Shared-connection initializers validate again before their DDL. Admission reads
only schema metadata for the fixed owned table names and their columns. It does
not scan, hash or copy production database contents, add a persistent mirror, or
run during ordinary incremental updates. Whole-file hashes are test-only checks
on small owned fault fixtures.

`PRAGMA user_version` stores schema-admission version `0x41480100` plus fixed
namespace bits (Store 1, quiescence 2, managed-files 4, retention 8, presentation
16, managed-allocation 32). An initialized namespace requires all of its tables
and expected column names/types. Unsupported versions refuse. Creation,
recognized migrations, restart normalization and the marker commit in one SQLite
savepoint. A failed first initialization cannot publish half a namespace.

First creation requires the main file and every `-wal`, `-shm` and `-journal`
sidecar to be absent. Even an empty surviving sidecar causes refusal before
SQLite is opened; an orphan WAL must not be consumed as fresh state. An existing empty or unrelated
file is not treated as a new Host/managed allocation store. A never-initialized
optional namespace can be added later; independent in-memory component profiles
remain supported. Non-authoritative indexes and `archive_projection_pending`
remain rebuildable from retained records.

## Existing unversioned stores

Public Host releases previously had no schema marker. Their exact table-set
migration epochs are recorded in `test/fixtures/host-schema-history.json`, with
source revisions and original DDL. The guard accepts those known complete
profiles and documented additive column migrations, rather than accepting any
subset of known tables. Quiescence's original two-table profile and later
attempt/service-release additions are also supported. Current complete optional
namespaces are recognized and marked on admission; arbitrary partial namespaces
refuse without recreation.

The guard is **schema admission**, not a complete corruption detector. It cannot
detect deletion of valid rows, a coherent whole-database replacement, deletion
of the database and all its sidecars, or removal
of an entire unversioned namespace that is indistinguishable from a release
which never initialized it. Similarly, an unversioned schema deliberately made
identical to an older complete profile cannot be distinguished from that release.
No native transcript scan, row census or inferred repair is introduced. A future
schema change must explicitly version/migrate this admission contract. An older
Host without this guard does not acquire its protections by reading this marker.

## Refusal and evidence

`HOST_AUTHORITATIVE_SCHEMA` names only fixed owner/table/column identifiers. It
instructs the operator to preserve the database and inspect/restore its original
backup; startup does not delete, reset, replay, reconstruct command history, or
release a retained fence. A conclusive damaged-schema refusal is not an outcome
receipt for any previously admitted operation.

`test/authoritative-schema.test.ts` reproduces actual admitted input/fence loss,
checks missing tables/columns/views and unknown versions, verifies all recorded
legacy Store epochs and optional profiles, and kills an owned SQLite writer to
assert main/WAL hashes remain equal on refused startup. The focused existing
quiescence, service, lease, retention, presentation, managed and archive-projection
suites exercise normal restart and effect semantics. Source and installed archive
results are recorded separately; neither is live deployment acceptance.
