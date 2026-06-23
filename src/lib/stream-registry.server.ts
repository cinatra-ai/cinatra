import "server-only";

// Host-side stream registry (cinatra#344).
//
// Manifest-driven discovery of neutral stream handlers, exactly the posture of
// src/lib/webhook-registry.server.ts / src/lib/widget-stream-agents.server.ts:
// the generated map (GENERATED_STREAM_DECLARATIONS, keyed by streamSlug) carries
// a literal dynamic import of the connector's stream handler module + the
// factory export name, so the host's generic /api/streams/<slug> route serves
// any stream-bearing extension WITHOUT importing a connector package or
// branching on slug.
//
// STAGED + INERT (cinatra#344): no extension declares cinatra.streams yet, so the
// generated map is {} and `resolveStream` is a clean miss for everything (the
// route 404s). The empty-registry path is first-class and crash-free. The real
// relay / run-stream migration onto @cinatra-ai/streams is the STAGED follow-on,
// NOT this issue.
//
// FAIL LOUDLY: an entry whose loader cannot be imported or whose recorded
// factory is missing/not a function throws — exactly like the static import it
// replaces (mirrors buildWebhookHandler / buildWidgetChatTool).

import type { SseFrame } from "@cinatra-ai/streams";
import {
  GENERATED_STREAM_DECLARATIONS,
  type GeneratedStreamEntry,
} from "@/lib/generated/streams.server";
import {
  ExtensionModuleAbsentError,
  isDegradedExtensionLoad,
} from "@/lib/extension-load-guard";

export type RegisteredStreamEntry = GeneratedStreamEntry;

/**
 * The neutral stream handler a connector factory returns: given the inbound
 * request (and a resolved logical stream id), produce an async source of SSE
 * frames. The host route serializes those frames onto the wire (optionally
 * resumable when the declaration sets `resume: true`). Vocabulary-free — what a
 * frame means is the handler's business.
 */
export type StreamHandler = (ctx: {
  request: Request;
  streamId: string;
}) => AsyncIterable<SseFrame> | Promise<AsyncIterable<SseFrame>>;

export type StreamHandlerFactory = () => StreamHandler;

/**
 * Resolve a declared stream by slug; null = undeclared (the route returns a
 * clean 404). The returned entry carries the loader, the factory name, and
 * declared metadata (`resume` when present).
 */
export function resolveStream(streamSlug: string): RegisteredStreamEntry | null {
  // Own-property guard: GENERATED_STREAM_DECLARATIONS is a plain object literal,
  // so a slug like `__proto__` / `constructor` / `toString` would otherwise
  // resolve a truthy prototype value and crash `buildStreamHandler` (a 500
  // instead of the documented clean 404). `Object.hasOwn` keeps the empty /
  // undeclared path a first-class 404 for EVERY request.
  return Object.hasOwn(GENERATED_STREAM_DECLARATIONS, streamSlug)
    ? GENERATED_STREAM_DECLARATIONS[streamSlug]
    : null;
}

/**
 * Import the entry's handler module and build the handler from the recorded
 * factory. FAIL-LOUD: an absent optional module throws the typed absent error
 * (the route maps it to a defined degraded status, not a generic 500); a
 * missing/non-function factory, or a factory that does not return a function,
 * throws.
 */
export async function buildStreamHandler(
  streamSlug: string,
  entry: RegisteredStreamEntry,
): Promise<StreamHandler> {
  const loaded = await entry.load();
  if (isDegradedExtensionLoad(loaded)) {
    throw new ExtensionModuleAbsentError(loaded.specifier, loaded.reason);
  }
  const ns = loaded as Record<string, unknown>;
  const factory = ns[entry.factory];
  if (typeof factory !== "function") {
    throw new Error(
      `[stream:${streamSlug}] manifest factory "${entry.factory}" is not an exported function of the handler module`,
    );
  }
  const handler = (factory as StreamHandlerFactory)();
  if (typeof handler !== "function") {
    throw new Error(
      `[stream:${streamSlug}] factory "${entry.factory}" did not return a handler function`,
    );
  }
  return handler;
}
