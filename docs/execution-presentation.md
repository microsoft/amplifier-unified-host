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
