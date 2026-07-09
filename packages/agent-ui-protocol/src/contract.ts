// ---------------------------------------------------------------------------
// The unified assistant-stream contract (cinatra#1217, epic #1216 S1).
//
// This module is the single, versioned source of truth for THE one AG-UI wire
// that carries every assistant conversation — first-party `/chat` and every
// embedded assistant (the generic Cinatra-served conversation view and each
// CMS iframe) alike. It defines the contract version, the surfaces that speak
// it, and the durable/resumable transport semantics.
//
// Tier-neutral: types + plain constants + pure functions only. NO
// `import "server-only"`, NO zod, NO cross-package value dependency — safe to
// import on the client renderer and on the server producer.
//
// SCOPE (the named boundary with #1037 P2): this contract owns the resumable
// UI-transport semantics and the event vocabulary over the durable AG-UI log.
// It does NOT own thread persistence, attribution, or the turn<->run linkage —
// those belong to #1037 P2 (the assistant runtime), which *produces* events
// into the log this contract streams. See CONTRACT.md for the full boundary.
// ---------------------------------------------------------------------------

/**
 * The unified assistant-stream contract version. Semver-shaped and negotiated
 * via the capability handshake (see `./handshake`); it is the successor to the
 * retired per-surface `contractVersion` (`v1`/`v2`) negotiation of the bespoke
 * `/capabilities` endpoint. Independent of the npm package version — this
 * tracks the WIRE contract, not the package release.
 */
export const ASSISTANT_STREAM_CONTRACT_VERSION = "1.0.0" as const;

export type AssistantStreamContractVersion =
  typeof ASSISTANT_STREAM_CONTRACT_VERSION;

/**
 * The rendering surfaces that speak this one contract. Every surface is an
 * AG-UI client of one assistant endpoint; only auth parameterization differs
 * (see `AssistantStreamAuthMode` in `./handshake`).
 *
 *  - `chat`          — first-party `/chat`.
 *  - `embedded-view` — the generic Cinatra-served conversation view (iframe).
 *  - `cms-iframe`    — a CMS-hosted embed of that view (WordPress / Drupal).
 */
export const ASSISTANT_STREAM_SURFACES = [
  "chat",
  "embedded-view",
  "cms-iframe",
] as const;

export type AssistantStreamSurface = (typeof ASSISTANT_STREAM_SURFACES)[number];

/**
 * The event types that MAY terminate a run's stream. After a terminal event
 * the server closes the stream; a durable transport error is NOT terminal (the
 * client reconnects and resumes from its last cursor — see `RESUME_HEADER`).
 */
export const TERMINAL_EVENT_TYPES = ["RUN_FINISHED", "RUN_ERROR"] as const;

export type TerminalEventType = (typeof TERMINAL_EVENT_TYPES)[number];

/**
 * The HTTP header a reconnecting client sends to resume mid-stream. This is the
 * standard WHATWG Server-Sent-Events header the browser `EventSource` sets
 * automatically from the last `id:` frame it saw.
 */
export const RESUME_HEADER = "Last-Event-ID";

/**
 * The Redis-Streams sentinel cursor meaning "replay from the very start of the
 * durable log". A fresh subscriber that needs the full history (e.g. a run
 * already `pending_approval` on first connect) resumes from this cursor.
 */
export const REPLAY_FROM_START_CURSOR = "0-0";

/**
 * Canonical transport descriptor for the contract. The wire is Server-Sent
 * Events over the durable Redis-Streams AG-UI log; every event frame carries an
 * `id:` (the Redis-Streams entry ID) so a reconnect with `Last-Event-ID`
 * resumes exactly from the un-replayed suffix — no events lost across a drop.
 */
export const ASSISTANT_STREAM_TRANSPORT = {
  kind: "sse",
  contractVersion: ASSISTANT_STREAM_CONTRACT_VERSION,
  resumeHeader: RESUME_HEADER,
  replayFromStartCursor: REPLAY_FROM_START_CURSOR,
  terminalEventTypes: TERMINAL_EVENT_TYPES,
} as const;

// ---------------------------------------------------------------------------
// Resume cursor (Last-Event-ID) — the single source of truth for cursor
// parsing, generalized from the run-stream route's hand-rolled `/^\d+-\d+$/`
// guard so every surface validates a resume cursor identically.
// ---------------------------------------------------------------------------

/**
 * A durable-log resume cursor. Always a Redis-Streams entry ID of the shape
 * `<unix-ms>-<seq>` — never contains U+0000/U+000A/U+000D, so it is always safe
 * to emit as an SSE `id:` field per the WHATWG SSE spec.
 */
export type StreamCursor = string;

/** Matches a Redis-Streams entry ID: `<digits>-<digits>`. */
export const STREAM_CURSOR_PATTERN = /^\d+-\d+$/;

/** True when `value` is a well-formed durable-log resume cursor. */
export function isValidStreamCursor(value: unknown): value is StreamCursor {
  return typeof value === "string" && STREAM_CURSOR_PATTERN.test(value);
}

/**
 * Normalize a raw `Last-Event-ID` header value into a resume cursor. Malformed
 * or absent values are treated as "no cursor" (defense-in-depth — the cursor is
 * passed verbatim to XRANGE and must be `<digits>-<digits>`); the caller then
 * decides whether to replay from the start of the log or tail from now.
 */
export function normalizeResumeCursor(
  lastEventId: string | null | undefined,
): StreamCursor | undefined {
  return lastEventId && isValidStreamCursor(lastEventId)
    ? lastEventId
    : undefined;
}
