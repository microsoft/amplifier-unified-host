# Closed initial service startup

This follow-up uses `serviceLifecycle.initialStart: {commandId, identity}`, purpose
`initial-start`, `releaseServiceStart`, and `verifyInitialStart`. These are trusted
launcher/control APIs; no browser or AHP caller can supply authenticated proof.

The launcher supplies the actual generation already persisted by the existing
ServiceStore `start` operation before consuming InitialProvisioningPort.claim.
QuiescenceGate reserves a closed fence and command during construction, before
Host listeners become available. Initialization and passive reads remain available;
fresh execution and maintenance stay closed. No participant acquisition, Native
retirement, provisioning retry, or spawn occurs in this Host seam.

The verifier returns exactly:

```
{kind:'service-initial-start', verified:true, fenceId, commandId,
 expected, observed, instanceId, dataScope,
 claimReceiptId, readyReceiptId, receiptId,
 target:{id,version,revision,digest}}
```

Expected and observed identities both equal the configured original installation,
data scope, owner, instance and release digest. The full qualified target binds that
digest. The platform verifier authenticates consumed claim, runtime custody and
durable closed readiness against the existing start operation. Claim, readiness,
and settlement receipt IDs may all reference that same durable operation after its
phases have been validated. Host does not infer authentication from caller evidence.

Reopening an unresolved initial fence retains its command, fence and generation,
marks observation unknown, and requires the same authenticated reconciliation.
Completed startup reopens by observing its retained exact release, without another
claim or closure. Exact release retries revalidate the same request and proof and
return the retained receipt; changed arguments or proof are refused. Generic
quiescence and service-stop APIs cannot release this fence. A real retained stop-A
fence cannot be overwritten by an initial-start configuration.

All durable state uses existing host_quiescence_fence, host_quiescence_commands and
host_service_releases tables. No new journal, registry, schema or owner fanout is
introduced. Native histories and session command outcomes retain their authority.

Source tests establish Host startup closure, proof binding, preserved unknown/native
bytes, reopen and exact retry behavior. They do not qualify signed Linux runtime
custody, consumed real provisioning claims, or supervisor startup acceptance. Those
are separate Updates/Root qualification requirements. The sealed ordinary A→B
candidate remains independent of this follow-up.
