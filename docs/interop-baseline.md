# Independent ACP baseline

This small fixture uses the installed upstream ACP SDK and synthetic state. It
requires no native runtime, sibling repository, provider account or credentials.
It complements the existing native-extension fixtures rather than claiming their
features. Node 22.16 or newer is required.

From a source checkout:

```sh
npm ci
npm run check:interop
```

For a packaged host, run `node --test fixtures/interop/*.test.mjs` from the
installed package directory. This checks the built public host export, official
AHP client and independent ACP process. It does not import host source files.
`node fixtures/interop/acp-peer.mjs` starts the standalone ACP stdio peer.

The peer advertises ACP 1, text prompts and cancellation. Each new session has a
distinct execution identity. It has no history, resume/load, MCP, permission,
filesystem, terminal or native extensions. Unadvertised methods fail explicitly.
The fixture bounds its lifetime to 16 sessions and each prompt to 64 KiB.
Its optional `--behavior wait-for-cancel` mode holds a prompt for cancellation;
`--behavior lose-reply` exits after receiving a prompt. `--log PATH` records
synthetic test observations, not production receipts or an authority store.

The executable checks cover:

- Initialization, distinct session identities, ordered streaming and text-only limits.
- Standard cancellation and an agent process that remains usable afterward.
- Missing load/resume/extensions and invalid session identity.
- Host work continuing with no viewer, duplicate/conflicting command rejection,
  lost ACP reply remaining unknown, and no duplicate dispatch after host restart.
- A fixture-local experience with one person and two agents, plus one agent in a
  second conversation. Shared authorship, bounded authorized retrieval and agent
  disconnection are distinct from private ACP execution identities.

The conversation demonstration implements the responsibility split in family
[HP7][hp7] and [AP3][ap3] using in-memory test records. It adds no product schema,
route, history store, supervision or retry authority. Its connectors choose one
ACP execution per conversation; this is a fixture choice, not a requirement for
agent memory or context. Both peers are copies of the deterministic fixture.
Native/other-vendor interoperability and durable multi-participant behavior need
separate qualification. The retained host still has one engine/native binding
per hosted conversation; these tests do not claim it implements HP7.

Probe an independently installed agent through the same SDK client:

```sh
node fixtures/interop/probe.mjs --cwd /synthetic/workspace --timeout 60 -- /installed/bin/agent-acp --config /synthetic/agent.json
```

The probe reports only negotiated identity/capabilities and new/prompt results.
It cancels permission requests because this fixture supplies no authorization
policy. Run only in an owned test environment with synthetic input. A deadline
or lost transport leaves effects unknown and never authorizes replay. The probe
closes its owned child when finished; it is not a production lifecycle manager.

[hp7]: https://github.com/microsoft/amplifier-unified/blob/main/contracts/host-protocol.v1.md
[ap3]: https://github.com/microsoft/amplifier-unified/blob/main/contracts/agent-protocol.v1.md
