# Delegate execution presentation

Native ACP tools may carry `_meta["amplifier.dev/execution"]` version 1.
The Host retains a bounded display header with the child session, parent node,
timestamps, and delegate name/model/routing. It never treats this header as a
worker-control grant. The delegate session must match the tool session; unknown
versions, headers larger than 8 KiB, report bodies and arbitrary fields are
discarded. Text fields are limited to 512 characters.

This accompanies ordinary ACP tool-call updates and ordinary AHP tool parts.
The persisted header survives a Host restart and paged chat reads. It lets a
client group child calls independently on either side of a progress message
without loading the entire execution family. Clients calculate each displayed
group's usage from that group's model calls, not the worker's lifetime total.

The tool details integration test checks restart fidelity and no execution
replay; execution metadata tests check size, version, ownership and field bounds.

Negotiated Native worker events also project a version 1
`amplifier.dev/delegate` observation into the ordered saved turn. It is an empty
system-notification part for work details, never an extra assistant reply.
Only the current admitted input may append one. Reports are capped at 12,000
characters; above 4 KiB the Host saves immutable Markdown content and a bounded
preview. Public snapshots carry the reference rather than the full report.

ACP text/tool updates and execution observations reserve the same bounded queue
synchronously. A settled prompt joins that queue before completing, including
asynchronous report writes. It does not wait for asynchronous duplex Native
control callbacks, which can need the prompt's completion themselves. Canonical
history refresh retains observed reports when message/tool boundaries agree;
conflicting boundaries preserve the original turn pending reconciliation.

The independent wire-peer test sends a large final report and prompt completion
in one burst, verifies saved content after restart and canonical refresh, rejects
a foreign input report, and checks that no prompt runs again.
