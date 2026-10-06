# Optional captured-turn steering and mounted support

AHP 0.9 standard steering remains unchanged: an unbound `chat/pendingMessageSet` with `kind: steering` targets the current turn at Host admission, or can wait for the next turn while idle.

The Host advertises `_meta["amplifier.dev/host"].boundSteering` in initialize and root metadata as `{version: 1, messageMetaKey: "amplifier.dev/steering", turnIdField: "activeTurnId"}`. An opted-in message carries `message._meta["amplifier.dev/steering"].activeTurnId`, captured by the client before submission. Whenever that namespace exists, the Host requires a nonempty string of at most 128 characters and an exact match to both its active Native turn and public active chat turn under the selected-session mutex. A stale or malformed input is refused before persistence, replacement or consumption. Namespace and sibling metadata survive projection and retained pending recovery.

Session metadata `_meta["amplifier.dev/host"].activeSteering` is published through standard `session/metaChanged`, with `{version: 1, supported: boolean, activeTurnId?, generationId?, mode?, cancellable?}`. Only an actual matching `generation.started` event with a supported version-1 request-boundary report makes support true. A handshake alone does not. The current turn and generation identify this evidence; end, mount loss and restart clear it. Web clients must require the advertised binding descriptor and a current matching support report, preserving their original captured turn during retries.

The extension adds no endpoint, schema or journal. Native still owns generation preflight and steering disposition. Public standard clients retain their unbound semantics.

## Attachment and quoted corrections

The additive `boundSteering.contentVersion:1` marker identifies Host support for
rich corrections. Both the Native handshake and current mounted steering report
must also include `content:{version:1,attachments:true,quotedReplies:true}`.
Mounted public-original preservation must support `steer.submit` and resources.
Static advertisement alone cannot enable this path. Older runtimes retain plain
steering and their explicit queue route.

Rich steering uses the ordinary message attachment resolver and canonical reply
reference, with no client-supplied quote excerpt. The Host rechecks the captured
turn and generation after resolution. If they end, the original correction stays
pending for inspection and cannot move to a later turn. Before Native dispatch,
the original message is stored in the existing durable steering admission and
response-part projection. Native receives `prompt` and optional `reply`, plus the
separate public-original envelope. Canonical refresh replaces the live copy only
when text, file cards and quote identity all match; otherwise it retains the
whole original turn. Neither restart nor refresh executes the correction again.
