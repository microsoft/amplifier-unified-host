# Event-driven service drain transition inventory

Audited against predecessor 32502b3172f09760c7ff46204cd1de4c9baaeac5.
`quiescenceWork(true)` measures local execution. The service gate augments it
with admissions, continuations, and maintenance. A wake prompts a fresh count;
it never changes a business receipt, clears an unknown fence, or authorizes replay.

| Count | Starts / completes | Completion wake and coverage |
| --- | --- | --- |
| shuttingDown | Host close sets closing; never returns to zero in this lifetime | `hostClosing()` immediately ends a closed service observation as unknown. Host close/restart tests cover this. |
| startingAgents | `ensureAgent` inserts startup promise; finally removes it on success/failure | Entire startup is inside `intake.run`; outer admission finally wakes after startup settles. Startup and shared admission tests cover runtime starts and closure refusal. |
| activeTurns | `admitTurn` sets busy; run finalization clears busy | `finishing` remains true until full finalization; its finalizer wakes. Shared admission tests cover real client-tool, approval and cancellation turns. |
| finishingTurns | run finally sets finishing; finalizer clears it after authoritative settlement and projection | Direct `workChanged()` after finalization. Callback/drain tests cover delayed settlement. |
| activeControls | `withAgentUse`, selected lifecycle retirement, idle retirement, generic quiescence retirement increment depth | Every decrement now directly wakes. Autonomous idle retirement was outside admission and omitted the wake. Unchanged independent driver covers successful and unknown retirement. Lifecycle and generic retirement already have gate/fence protection; their direct wakes make the depth contract uniform. |
| nativeUpdates | ACP queue acceptance / queued update finally; native observation acceptance / observation finally | Both accepted queues wake directly after decrement. Queue capacity refusal now checks prospective counts BEFORE increment: it has no completion callback and must not own queued work. Real ACP capacity test demonstrates predecessor leak and corrected stop settlement. Native update/observation suites cover accepted work. |
| permissions | permission promise insertion / exact confirmation, cancellation, or turn cleanup | Confirmation dispatch is inside `intake.continuation`; cancellation is inside active completion and `withAgentUse`; turn cleanup stays counted by finishing. Each covering scope wakes after actual completion. Shared approval/cancellation tests cover these paths. |
| clientTools | admitted client invocation inserts pending result / client response, disconnect, or timeout deletes and resolves | `invokeClientTool` awaits the result inside `selectedCompletion` (`run` or `continuation`); scope finally wakes. Deletion alone cannot prove the calling operation finished. Shared client-tool test covers real result delivery after closure; existing client-tools suite covers failure/disconnect paths. |
| settledCallbacks | insertion before callback execution / callback promise finally removes | Direct wake on success or failure. Service observation tests hold callback beyond ten seconds and verify original-command settlement and unknown preservation. |
| stoppedCallbacks | insertion before owner stop callback / callback promise finally removes | Direct wake on success or failure. Retirement depth remains counted until callback completes; retirement finalizer must ALSO wake afterward. Independent idle success driver covers real stop/removal; capacity test covers peer death callback. |
| steeringDispositions | dispatch installs timer / `settleSteering` clears timer on event, deadline or process stop | Direct wake after disposition settlement. Existing steering suite covers outcomes. Waiting/unknown durable intent is retained, separately from active timer work. |
| terminalJobs | terminal creation persists running / actual exit reducer persists exited | Exit emits updated terminal state then directly wakes. Existing quiescence terminal test covers jobs outliving prompts. Recovered stale terminal records are marked exited during construction, before any waiter exists. |
| admissions (gate) | outer `run` increments / finally decrements on success or failure | `maybeIdle()` directly wakes. Nested inherited admission does not increment; its enclosing outer admission stays counted. Shared drain and delayed external job tests cover this. |
| continuations (gate) | continuation scope increments / finally decrements | `maybeIdle()` directly wakes. Exact result delivery remains allowed after intake closure; shared client-tool/approval/cancellation tests exercise it. |
| maintenance (gate) | held generic fence maintenance increments / finally decrements | Cannot coexist with a closed service waiter: maintenance rejects service-stop/initial-start fences; `closeServiceIntake` rejects any other existing fence/changing transition; release/reconciliation rejects pending maintenance. No missing reachable service wake. Existing maintenance tests cover fence enforcement. |

## Resident removal and exclusions

Startup failure, closed-agent replacement, explicit retirement reconciliation, and
relocation remove residents inside admission scopes. Selected lifecycle retirement
and generic quiescence retirement now directly notify after their depth finalizers;
autonomous retirement also notifies after successful removal or retained unknown
retirement. Host shutdown ends observations as unknown before clearing residents.
Removing a resident does not certify its durable retirement business outcome.

Passive reads, cached idle agents, selected mutexes, use ordering, resource locks,
waiting queue/steering intents, retained unknown business receipts and retirement
fences are deliberately excluded from service execution counts. They retain their
existing ownership and reconciliation rules. Generic quiescence still counts
pending intents and unsupported retirement gaps; service drain still uses its
existing narrower execution definition.

## Contract and evidence boundary

The service loop reads counts then installs its wake synchronously, with no await
between those operations. Wake delivery reruns the same command/fence inspection.
The repair adds no polling, timer, timeout, API, store or gate-state transition.
The existing idle timer is unchanged. Host closing, invalid counts and gaps remain
fail-closed. A held local drain is not a successful platform stop, a native
retirement success, release activation, or browser/account acceptance.

The inventory records coverage from existing suites and the two added causal
controls; it does not claim a separate service-closure test for every terminal,
steering, observation, startup-failure or maintenance variant. Both independent
idle outcomes and a capacity-refused real ACP frame are directly exercised at this
successor. The original independent driver and fixture are copied byte-for-byte.
