import "server-only";

import { randomUUID } from "node:crypto";
import { publishRunEvent } from "./streaming-bridge";
import type { A2AStreamEventData } from "./external-client";

// ---------------------------------------------------------------------------
// External A2A SSE -> Redis proxy.
//
// Bridges an external A2A server's SSE stream into the local Redis
// `cinatra:a2a:run:{runId}` channel by mapping each A2A event `kind` to the
// `RunStreamEvent` shape consumed by `subscribeToRunEvents` (which feeds
// `useAgUiRunStream` in the workspace UI). Fire-and-forget from the caller:
// this function always RESOLVES (never rejects).
//
// Terminal-event contract:
//
//   - normal completion    -> { type: "done" }
//   - iteration throws     -> { type: "error", reason, detail? } then { type: "done" }
//   - 5-min timeout        -> { type: "error", reason: "timeout" } then { type: "done" }
//
// Exactly ONE { type: "done" } per invocation, guaranteed by the
// `doneEmitted` flag. An AbortController tears down the upstream iteration
// when the max duration (default 5 minutes; overridable via options for
// tests) elapses.
//
// Event mapping (per @a2a-js/sdk 0.3.x discriminator 'kind'):
//   - 'status-update'    -> { type: "status", state: event.status.state ?? "unknown" }
//   - 'artifact-update'  -> { type: "artifact", artifact: {...} }
//   - 'message'          -> skipped (not bridged)
//   - 'task'             -> skipped (not bridged)
//   - unknown / missing  -> console.warn + skipped (never crashes iteration)
//   - malformed          -> console.warn + skipped
//
// Accepting a pre-started stream prevents creating a second remote task. The
// proxy must not call client.streamTask(message), because that creates a new
// task on the remote server and can double-execute work when the caller has
// already called sendTask.
// ---------------------------------------------------------------------------

export interface StartExternalSseProxyOptions {
  /** Override the default 5-minute max stream duration. Tests use a small value. */
  maxDurationMs?: number;
  /**
   * Optional AG-UI event sink. When provided, the proxy emits RUN_STARTED,
   * TEXT_MESSAGE_START/CONTENT/END per artifact text part, and RUN_FINISHED /
   * RUN_ERROR — making the run visible in the AG-UI workspace panel.
   *
   * Typed as a plain record to avoid importing @cinatra-ai/agent-ui-protocol
   * (which imports @cinatra-ai/a2a, creating a circular dep).
   */
  publishAgUiEvent?: (event: Record<string, unknown>) => void | Promise<void>;
  /**
   * Invoked EXACTLY ONCE, on CLEAN completion only, with the full accumulated
   * text of all artifact text parts. NOT called on timeout or generator error.
   * Callers persist to agent_runs.streamed_text via
   * updateAgentRunStreamedText(runId, text). Called BEFORE emitAgUiFinished /
   * emitDone.
   */
  persistStreamedText?: (text: string) => void | Promise<void>;
}

const DEFAULT_MAX_DURATION_MS = 5 * 60 * 1000;

/**
 * Bridge a pre-started A2A SSE stream to the local Redis run event channel.
 *
 * The caller is responsible for creating exactly one task on the remote server
 * (via `client.streamTask`) before passing the resulting AsyncGenerator here.
 * This function never calls `streamTask` itself — it only consumes the provided
 * iterator, preventing the double-task-creation bug.
 *
 * @param stream     Pre-started AsyncGenerator from `client.streamTask()`
 * @param initialStatus  Initial task status string to publish immediately (e.g. "submitted")
 * @param runId      Local agent_runs row ID — Redis channel key
 * @param options    Optional overrides (maxDurationMs for tests; publishAgUiEvent for UI output)
 */
export async function startExternalSseProxyFromStream(
  stream: AsyncGenerator<A2AStreamEventData, void, undefined>,
  initialStatus: string,
  runId: string,
  options?: StartExternalSseProxyOptions,
): Promise<void> {
  const agUi = options?.publishAgUiEvent;
  const persist = options?.persistStreamedText;
  const now = () => Date.now();

  let doneEmitted = false;
  let agUiFinished = false;
  // Local accumulator mirroring the hook's TEXT_MESSAGE_CONTENT concatenation
  // and blank-line separator between TEXT_MESSAGE_START sequences. Persisted
  // to the DB only on clean completion.
  let accumulatedText = "";

  const emitDone = async (): Promise<void> => {
    if (doneEmitted) return;
    doneEmitted = true;
    await publishRunEvent(runId, { type: "done" }).catch(() => undefined);
  };
  const emitError = async (reason: string, detail?: string): Promise<void> => {
    await publishRunEvent(runId, { type: "error", reason, detail }).catch(
      () => undefined,
    );
  };
  const emitAgUiError = async (message: string): Promise<void> => {
    if (!agUi || agUiFinished) return;
    agUiFinished = true;
    await Promise.resolve(agUi({ type: "RUN_ERROR", threadId: runId, runId, message, timestamp: now() })).catch(() => undefined);
  };
  const emitAgUiFinished = async (): Promise<void> => {
    if (!agUi || agUiFinished) return;
    agUiFinished = true;
    await Promise.resolve(agUi({ type: "RUN_FINISHED", threadId: runId, runId, status: "completed", timestamp: now() })).catch(() => undefined);
  };

  const maxDurationMs = options?.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
  const abort = new AbortController();
  const timeoutHandle = setTimeout(() => {
    abort.abort(new Error("proxy-max-duration"));
  }, maxDurationMs);

  try {
    // Publish initial status so the UI leaves the "queued" phase immediately.
    await publishRunEvent(runId, { type: "status", state: initialStatus });

    // AG-UI: signal run start so the workspace panel activates.
    if (agUi) {
      await Promise.resolve(agUi({ type: "RUN_STARTED", threadId: runId, runId, timestamp: now() })).catch(() => undefined);
    }

    for await (const event of stream) {
      if (abort.signal.aborted) break;
      if (!event || typeof event !== "object") {
        console.warn("[external-sse-proxy] malformed event (non-object), skipping");
        continue;
      }
      const kind = (event as { kind?: string }).kind;
      if (kind === "status-update") {
        const statusEvent = event as { status?: { state?: string } };
        await publishRunEvent(runId, {
          type: "status",
          state: statusEvent.status?.state ?? "unknown",
        });
      } else if (kind === "artifact-update") {
        const artifactEvent = event as {
          artifact: {
            name?: string;
            parts: Array<
              | { kind: "text"; text: string }
              | { kind: "data"; data: Record<string, unknown> }
            >;
          };
        };
        await publishRunEvent(runId, {
          type: "artifact",
          artifact: {
            name: artifactEvent.artifact.name,
            parts: artifactEvent.artifact.parts as Array<{ kind: "text"; text: string }>,
          },
        });
        // Accumulate text parts for persistence. Must run outside the agUi gate so
        // callers that provide persistStreamedText without publishAgUiEvent still get
        // their text persisted. Separator rule: prepend "\n\n" between
        // TEXT_MESSAGE_START sequences (mirrors use-ag-ui-run-stream.ts:167).
        const textParts = artifactEvent.artifact.parts.filter(
          (p): p is { kind: "text"; text: string } =>
            p.kind === "text" && typeof p.text === "string" && p.text.length > 0,
        );
        if ((agUi || persist) && textParts.length > 0) {
          if (accumulatedText.length > 0) {
            accumulatedText += "\n\n";
          }
          for (const part of textParts) {
            accumulatedText += part.text!;
          }
        }
        // AG-UI: emit text parts as message chunks so the workspace panel shows output.
        if (agUi) {
          if (textParts.length > 0) {
            const messageId = randomUUID();
            await Promise.resolve(agUi({ type: "TEXT_MESSAGE_START", messageId, timestamp: now() })).catch(() => undefined);
            for (const part of textParts) {
              await Promise.resolve(agUi({ type: "TEXT_MESSAGE_CONTENT", messageId, delta: part.text!, timestamp: now() })).catch(() => undefined);
            }
            await Promise.resolve(agUi({ type: "TEXT_MESSAGE_END", messageId, timestamp: now() })).catch(() => undefined);
          }
          // Emit DATA_PART events for each artifact part with `kind: "data"`.
          // JSON.stringify inside publishAgUiEvent may throw on exotic payloads
          // (BigInt, circular refs, Date) — catch per-emission and drop silently
          // so the whole run does not fail on one bad frame.
          const dataParts = artifactEvent.artifact.parts.filter(
            (p): p is { kind: "data"; data: Record<string, unknown> } =>
              p.kind === "data" &&
              !!p.data &&
              typeof p.data === "object" &&
              !Array.isArray(p.data),
          );
          for (let i = 0; i < dataParts.length; i++) {
            await Promise.resolve(
              agUi({
                type: "DATA_PART",
                data: dataParts[i].data,
                partIndex: i,
                timestamp: now(),
              }),
            ).catch((err) => {
              console.warn("[external-sse-proxy] DATA_PART emit failed:", err);
            });
          }
        }
      } else if (kind === "message" || kind === "task") {
        // Intentionally skipped; these events are not bridged into local run output.
      } else {
        console.warn(
          `[external-sse-proxy] unsupported event kind "${kind ?? "<missing>"}", skipping`,
        );
      }
    }
    if (abort.signal.aborted) {
      console.warn("[external-sse-proxy] stream aborted due to max-duration timeout (loop break)");
      await emitError("timeout");
      await emitAgUiError("timeout");
    } else {
      // Persist the accumulated streamed text on clean completion only.
      // Do NOT persist on timeout (above branch) or in the catch block below.
      if (persist && accumulatedText.length > 0) {
        await Promise.resolve(persist(accumulatedText)).catch((err) => {
          console.error("[external-sse-proxy] persistStreamedText failed:", err);
        });
      }
      await emitAgUiFinished();
    }
    await emitDone();
  } catch (err) {
    if (abort.signal.aborted) {
      console.warn("[external-sse-proxy] stream aborted due to max-duration timeout");
      await emitError("timeout");
      await emitAgUiError("timeout");
    } else {
      console.error("[external-sse-proxy] stream terminated with error:", err);
      const reason = err instanceof Error ? err.name || "stream_error" : "stream_error";
      const detail = err instanceof Error ? err.message : String(err);
      await emitError(reason, detail);
      await emitAgUiError(detail);
    }
    await emitDone();
  } finally {
    clearTimeout(timeoutHandle);
  }
}
