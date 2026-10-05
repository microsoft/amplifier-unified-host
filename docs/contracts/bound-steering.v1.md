# Optional captured-turn steering and mounted support

AHP 0.9 standard steering remains unchanged: an unbound `chat/pendingMessageSet` with `kind: steering` targets the current turn at Host admission, or can wait for the next turn while idle.

The Host advertises `_meta["amplifier.dev/host"].boundSteering` in initialize and root metadata as `{version: 1, messageMetaKey: "amplifier.dev/steering", turnIdField: "activeTurnId"}`. An opted-in message carries `message._meta["amplifier.dev/steering"].activeTurnId`, captured by the client before submission. Whenever that namespace exists, the Host requires a nonempty string of at most 128 characters and an exact match to both its active Native turn and public active chat turn under the selected-session mutex. A stale or malformed input is refused before persistence, replacement or consumption. Namespace and sibling metadata survive projection and retained pending recovery.

Session metadata `_meta["amplifier.dev/host"].activeSteering` is published through standard `session/metaChanged`, with `{version: 1, supported: boolean, activeTurnId?, generationId?, mode?, cancellable?}`. Only an actual matching `generation.started` event with a supported version-1 request-boundary report makes support true. A handshake alone does not. The current turn and generation identify this evidence; end, mount loss and restart clear it. Web clients must require the advertised binding descriptor and a current matching support report, preserving their original captured turn during retries.

The extension adds no endpoint, schema or journal. Native still owns generation preflight and steering disposition. Public standard clients retain their unbound semantics.
