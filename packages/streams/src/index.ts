// Public surface for the neutral stream primitives (cinatra#344).
//
// Three vocabulary-free primitives the host injects its namespace/storage/config
// into: a durable per-id Redis-Streams event log, a resumable per-connection SSE
// wrapper, and a generalized short-lived opaque token broker. The package
// carries NO `cinatra:a2a:` literal, NO AG-UI/WayFlow vocabulary, NO host DB
// coupling, and NO `server-only` import — every host detail arrives as a
// parameter.
//
// STAGED (cinatra#344): no host surface is migrated onto this package yet — the
// A2A run stream, the widget relay, and the `cit_` widget broker stay byte-for-
// byte as they are. This package + its `cinatra.streams` manifest capability
// ship INERT (no extension declares `cinatra.streams` on day one).

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
