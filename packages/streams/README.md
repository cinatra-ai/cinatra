# @cinatra-ai/streams

Neutral, vocabulary-free **stream primitives** the host injects its namespace,
storage, and config into (cinatra#344). The package carries no AG-UI / A2A /
WayFlow vocabulary, no host DB coupling, and no `server-only` import — every host
detail arrives as a parameter, so the same primitives back any streaming surface.

## What it provides

- **A durable per-id event log** — `createDurableEventLog` over Redis Streams,
  with `StreamReadOptions` for resuming a reader from a known offset. Exposes the
  `DurableEventLog` / `DurableEventLogEntry` types.
- **A resumable per-connection SSE wrapper** — `createResumableSseContext`,
  `serializeSseFrame`, `sseResponse`, and `SSE_RESPONSE_HEADERS`, plus
  `assertSseSafeId` to reject unsafe stream ids. A reconnecting client resumes
  from its last-seen frame.
- **A generalized short-lived opaque token broker** — `createTokenBroker` mints
  and consumes single-use opaque tokens (`MintInput`/`MintResult`,
  `ConsumeInput`/`ConsumeResult` with a typed `ConsumeRejectReason`), backed by a
  host-supplied `TokenBrokerStore`. Helpers `normalizeOriginStrict` and
  `sha256Hex` support strict same-origin and hashed-token storage.

## Boundary

The host supplies the key namespace, the storage/config accessors, and (for the
token broker) the persistence store; this package owns only the protocol
mechanics. Extensions opt in by declaring the `cinatra.streams` capability in
their manifest.

See the platform reference [Extension webhooks and streams](https://docs.cinatra.ai/references/platform/extension-webhooks-and-streams/)
for how the host composes these primitives.
