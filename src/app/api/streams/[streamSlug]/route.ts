import { sseResponse, serializeSseFrame } from "@cinatra-ai/streams";
import {
  resolveStream,
  buildStreamHandler,
} from "@/lib/stream-registry.server";
import { ExtensionModuleAbsentError } from "@/lib/extension-load-guard";

// Host-owned GENERIC stream route (cinatra#344).
//
//   GET /api/streams/<streamSlug>
//
// One route for EVERY stream-bearing connector. It imports NO connector package
// and never branches on slug — it resolves the declared stream from the
// generated registry (GENERATED_STREAM_DECLARATIONS), builds the connector's
// neutral stream handler, and serves the handler's SSE frames via the
// @cinatra-ai/streams SSE primitive.
//
// STAGED + INERT (cinatra#344): no extension declares cinatra.streams yet, so the
// registry is empty and every request 404s at the resolve step (the
// empty-registry path is first-class and crash-free). This route proves the
// wiring; the real relay / run-stream migration onto @cinatra-ai/streams is the
// STAGED follow-on, NOT this issue.

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ streamSlug: string }> },
): Promise<Response> {
  const { streamSlug } = await params;

  const entry = resolveStream(streamSlug);
  if (!entry) {
    // Undeclared slug — clean 404 (the INERT day-one verdict for every request).
    return new Response("Not Found", { status: 404 });
  }

  let handler;
  try {
    handler = await buildStreamHandler(streamSlug, entry);
  } catch (err) {
    if (err instanceof ExtensionModuleAbsentError) {
      // An optional stream module is absent post-build — defined degraded
      // status rather than a generic 500.
      return new Response("Stream Unavailable", { status: 503 });
    }
    throw err;
  }

  const streamId = `${streamSlug}:${crypto.randomUUID()}`;
  const source = await handler({ request, streamId });

  // Serialize the handler's frames onto the SSE wire. (The resumable-SSE path —
  // Last-Event-ID resume backed by injected ioredis connections — is opted into
  // per declaration via `entry.resume` by the STAGED follow-on; the minimal
  // host route here streams the handler's frames directly.)
  const iterator = source[Symbol.asyncIterator]();
  const body = new ReadableStream<string>({
    async pull(controller) {
      try {
        const { value, done } = await iterator.next();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(serializeSseFrame(value));
      } catch (e) {
        controller.error(e);
      }
    },
    async cancel(reason) {
      await iterator.return?.(reason);
    },
  });

  return sseResponse(body);
}
