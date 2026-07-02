// Public surface for the neutral stream primitives (cinatra#344).
//
// Three vocabulary-free primitives the host injects its namespace/storage/config
// into: a durable per-id Redis-Streams event log, a resumable per-connection SSE
// wrapper, and a generalized short-lived opaque token broker. The package
// carries NO `cinatra:a2a:` literal, NO AG-UI/WayFlow vocabulary, NO host DB
// coupling, and NO `server-only` import — every host detail arrives as a
// parameter.
//
// LIVE since #343: this package and its `cinatra.streams` manifest capability
// are wired and serving via the generic `/api/streams/<slug>` route. An
// extension opts a surface in by declaring `cinatra.streams`; until one does the
// generated stream registry is empty and the route 404s safely.

export {
  createDurableEventLog,
} from "./event-log";
export type {
  DurableEventLog,
  DurableEventLogOptions,
  DurableEventLogEntry,
  StreamReadOptions,
} from "./event-log";

export {
  createResumableSseContext,
  serializeSseFrame,
  assertSseSafeId,
  sseResponse,
  SSE_RESPONSE_HEADERS,
} from "./sse";
export type {
  SseFrame,
  ResumableSseContext,
  ResumableSseContextOptions,
} from "./sse";

export {
  createTokenBroker,
  normalizeOriginStrict,
  sha256Hex,
} from "./token-broker";
export type {
  TokenBroker,
  TokenBrokerOptions,
  TokenBrokerStore,
  TokenBrokerConfig,
  TokenRow,
  StoredTokenRow,
  MintInput,
  MintResult,
  ConsumeInput,
  ConsumeResult,
  ConsumeRejectReason,
} from "./token-broker";
