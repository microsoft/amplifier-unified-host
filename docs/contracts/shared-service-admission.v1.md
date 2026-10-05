# Shared local service admission v1

Approved source lane: reuse the existing QuiescenceGate, Host work counters,
command/fence and service-release tables. No new owner registry, activity store,
per-facade service journal, process discovery or full release workflow.

The trusted launcher supplies the exact installation, data scope, owner, actual
runtime instance and signed release digest. `closeServiceIntake(ServiceStopRequest)`
persists a `service-stop` fence before yielding. `admitted:true,phase:'closed'`
means only intake closure; `evidence.activeWork` is a measured nonnegative count
or `unknown`. `admitServiceStop` reuses that exact fence/command/identity, waits on
actual work-change notifications, and returns `phase:'held',activeWork:0` only at
local zero. Observation timeout keeps the fence unknown and closed. It neither
signals processes nor settles a business outcome. A drain-only timeout can be
observed again; restart/platform uncertainty needs authenticated reconciliation.

New chat/configuration/resource/capability/scheduled starts use ordinary shared
admission and stay closed. Exact pending client+chat+turn+tool results, current
Active+turn+permission decisions and active-turn cancellation are counted
continuations. Sequence, authority, payload and selected-session lock checks
remain. Stale or unrelated completion cannot gain a general admission.

ACP filesystem/terminal effects require the same current Active object and an
admitted startup, turn or dispatched control lifetime. Idle cached processes and
maintenance retirement depth are not execution authority. Native callback scope
expires when its awaited work settles. Nested capability/client-tool completion
must bind that scope's exact originating session and Native identity.
`withAdmittedNativeContinuation` may reserve a counted child completion only
within that scope; it cannot be called by an unrelated trusted caller or browser.
Selected title completion uses its existing CAS/lock and canonical Native read.

Drained work includes actual starts, turns/finishing, controls, update/result
queues, approvals/client tools, terminal jobs, continuations and settled/stopped
callbacks. Cached residents, passive reads, durable waiting intents and saved
unknown business receipts do not count. Queued intentions are preserved and not
promoted while closed. Existing per-session unknown checks still protect a new
turn. Process exit never proves an uncertain external effect succeeded.

Ordinary service admission does not acquire 22 facade leases or require their
service markers. Existing maintenance/retention/recovery and physical writer
locks remain. Retained legacy service holds cannot be reclassified as this new
shared model. The historical participant-fence fixture suite tests their retained
release/reconciliation path separately, not ordinary shared admission.

Replacement B restores A's real fence from the same Host DB and starts closed.
`releaseServiceStop` authenticates exact A, B, stop/resume, confirmed unit exit and
readiness. Installation/data scope/owner remain constant and B's instance differs.
For a changed digest the supervisor proof must additionally contain
`activation:{schema:'distribution-service-activation-v1',target:{id,version,revision,digest}}`
matching B's configured qualified signed target. Caller assertions do not qualify
it. Exact release request/proof/result retries use the existing immutable receipt.

This slice does not implement pristine closed initial startup or claim that every
owner's detached external job is covered. Trusted composition can hold
`withExternalMutation` across a real job lifetime without a facade lease, but
actual adoption requires separate evidence. Root reserves exact admitted naming
completion and joins existing passive coordination refresh before Host stores
close. The controlled source fixtures qualify these exercised paths only; actual
Linux signed A-to-B lifecycle, real providers, browser and deployment remain
separate gates. Initial startup will be a distinct follow-up using the genuine
provisioning claim, never a synthetic stopped-A proof.
