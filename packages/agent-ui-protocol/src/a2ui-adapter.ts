import "server-only";
import { Redis } from "ioredis";
import { xaddRunEvent } from "@cinatra-ai/a2a";
import type { AgentUIAdapter } from "./adapter";
import type { A2UiMessage } from "./a2ui-messages";
import type { MidRunTranslator } from "./a2ui-translator";
import {
  translateHintToA2UiMessages,
  translateSetupGroupToA2UiMessages,
  translateRecipientsOutputToA2Ui,
  translateDraftsOutputToA2Ui,
  translateFollowupsOutputToA2Ui,
  translateSendOutputToA2Ui,
} from "./a2ui-translator";

// ---------------------------------------------------------------------------
// grouped-setup-form HITL emission constants.
// Strict-equality match only: no prefix / substring / regex.
// ---------------------------------------------------------------------------

const GROUPED_SETUP_FORM_RENDERER_ID = "@cinatra-ai/agent-builder:grouped-setup-form";
const HITL_SURFACE_PREFIX = ":hitl:";

// ---------------------------------------------------------------------------
// Mid-run xRenderer translator KINDS (cinatra#151 Stage 5).
// This package owns the neutral translator primitives, keyed by kind name —
// it names NO agent. WHICH xRenderer ID dispatches to which kind is
// extension-owned data (each agent's `cinatra.fieldRenderers` declaration
// carries an `a2uiTranslator` kind); the CALLER builds an id -> translator
// resolver from those bindings and INJECTS it into the A2UiAdapter
// constructor (packages/agents/src/field-renderer-bindings.server.ts).
// Each translator produces 3 A2UI messages
// (createSurface + updateComponents + updateDataModel).
// ---------------------------------------------------------------------------

export const A2UI_MID_RUN_TRANSLATOR_KINDS: Readonly<Record<string, MidRunTranslator>> = {
  "recipients-output": translateRecipientsOutputToA2Ui,
  "drafts-output": translateDraftsOutputToA2Ui,
  "followups-output": translateFollowupsOutputToA2Ui,
  "send-output": translateSendOutputToA2Ui,
};

/** Resolver the host injects: full xRenderer ID -> mid-run translator. */
export type MidRunTranslatorResolver = (
  xRenderer: string,
) => MidRunTranslator | undefined;

// ---------------------------------------------------------------------------
// Redis publisher — lazy-init singleton (same pattern as ag-ui-adapter.ts)
// sharedA2UiPublisher avoids naming conflict if both adapters are imported
// in the same server process.
// ---------------------------------------------------------------------------

function resolveRedisUrl(): string {
  return process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
}

let sharedA2UiPublisher: Redis | null = null;

function getA2UiPublisher(): Redis {
  if (!sharedA2UiPublisher) {
    sharedA2UiPublisher = new Redis(resolveRedisUrl(), {
      lazyConnect: false,
      maxRetriesPerRequest: 3,
    });
  }
  return sharedA2UiPublisher;
}

/**
 * Publish a single A2UI v0.9 message to the Redis channel for `runId`.
 *
 * Dual-write: durably appends to the unified Redis Streams event log
 * (channel: "a2ui") AND publishes to the A2UI pub/sub channel for
 * live delivery.
 *
 * XADD is best-effort (non-fatal). Redis pub/sub still runs regardless.
 */
export async function publishA2UiEvent(
  runId: string,
  message: A2UiMessage,
): Promise<void> {
  await xaddRunEvent(runId, {
    ...(message as unknown as Record<string, unknown>),
    channel: "a2ui",   // always last — cannot be overwritten by message fields
  }).catch((err) => {
    console.error("[a2ui-adapter] XADD failed for run %s: %o", runId, err);
  });

  const publisher = getA2UiPublisher();
  await publisher.publish(`cinatra:a2ui:run:${runId}`, JSON.stringify(message));
}

/**
 * Release the shared publisher connection.
 * Tests call this in afterAll() to avoid leaking handles past test end.
 */
export async function __disconnectSharedA2UiPublisher(): Promise<void> {
  if (sharedA2UiPublisher) {
    const pub = sharedA2UiPublisher;
    sharedA2UiPublisher = null;
    await pub.quit().catch(() => { /* swallow — best-effort teardown */ });
  }
}

// ---------------------------------------------------------------------------
// A2UiAdapter — implements AgentUIAdapter for A2UI v0.9 protocol.
//
// Only onRunStarted, onRunFinished, and onStateSnapshot do real work.
// All other lifecycle methods are no-ops — A2UI is declarative, not
// execution-trace streaming. HITL (onInterrupt/onResume) stays in AG-UI.
//
// CRITICAL: every `void this.publish(...)` call MUST have `.catch(() => {})`
// to prevent unhandled promise rejections when Redis is unavailable.
// ---------------------------------------------------------------------------

export class A2UiAdapter implements AgentUIAdapter {
  constructor(
    private readonly runId: string,
    private readonly threadId: string,
    private readonly publish: (message: A2UiMessage) => Promise<void>,
    /**
     * Injected mid-run translator resolution (cinatra#151 Stage 5): maps a
     * gate's full xRenderer ID to a translator KIND via the manifest-declared
     * bindings. Absent (tests/legacy constructions) => no mid-run translator
     * dispatch, identical to an ID that had no MID_RUN_TRANSLATORS entry.
     */
    private readonly resolveMidRunTranslator?: MidRunTranslatorResolver,
  ) {}

  onRunStarted(): void {
    void this.publish({
      version: "v0.9",
      createSurface: {
        surfaceId: this.runId,
        // catalogId is required per A2UI v0.9 spec.
        catalogId: "cinatra-default",
        sendDataModel: true,
      },
    }).catch(() => {});
  }

  onRunFinished(_status: "completed" | "failed" | "stopped", _error?: string): void {
    void this.publish({
      version: "v0.9",
      deleteSurface: { surfaceId: this.runId },
    }).catch(() => {});
  }

  onStateSnapshot(snapshot: unknown): void {
    if (!snapshot || typeof snapshot !== "object") return;
    const messages = translateHintToA2UiMessages(this.runId, snapshot);
    for (const msg of messages) {
      void this.publish(msg).catch(() => {});
    }
  }

  // No-op methods — A2UI is declarative; no equivalent for streaming text or tool events.
  // Prefix unused params with _ per TypeScript strict-mode convention.
  onTextDelta(_messageId: string, _delta: string): void {}
  onToolCallStart(_toolCallId: string, _toolName: string, _args: unknown): void {}
  onToolCallEnd(_toolCallId: string, _toolName: string, _result: unknown): void {}
  onInterrupt(
    schema: Record<string, unknown>,
    xRenderer: string,
    values: Record<string, unknown>,
    reviewTaskId: string,
  ): void {
    // The translator emits `createSurface` on every invocation. If this adapter
    // is asked to emit for the same (runId, reviewTaskId) pair twice (resume
    // paths, retries), downstream A2UI consumers MUST dedupe by surfaceId — see
    // the idempotency contract in translateSetupGroupToA2UiMessages docstring.
    // The adapter itself does not dedupe: fire-and-forget is intentional.
    const surfaceId = `${this.runId}${HITL_SURFACE_PREFIX}${reviewTaskId}`;

    // ---------------------------------------------------------------------------
    // Presentation-first dispatch.
    // When the gate embedded a PresentationHint in values.presentation (see
    // packages/langgraph-agents/graphs/orchestrator_v1.py hitl_gate), use the
    // generic translateHintToA2UiMessages and skip the per-xRenderer
    // injected mid-run translator entirely. Fallback to the injected resolver when
    // presentation is absent or malformed (defensive: null/non-object/array/
    // object-without-type all fall through).
    //
    // translateHintToA2UiMessages emits 2 messages (updateComponents +
    // updateDataModel). We prepend createSurface here so downstream consumers
    // see the same 3-message shape that mid-run translators produce.
    // Missing createSurface would trigger "updateDataModel without matching
    // createSurface" in the A2UI harness.
    //
    // ORDERING GUARANTEE: three back-to-back `void this.publish(...).catch(() => {})`
    // calls do NOT guarantee arrival order at the transport boundary — `publish`
    // returns a Promise and may be internally buffered by the Redis client. To
    // guarantee consumers see createSurface FIRST, we await it inside an async
    // IIFE before publishing the translator messages. The IIFE itself is
    // fire-and-forget (the outer onInterrupt signature remains synchronous).
    //
    // TYPE GUARD: the check rejects null, non-objects, arrays
    // (typeof [] === "object"), and objects missing a string `type`
    // discriminator. This is tighter than a naive `typeof === "object"` check;
    // arrays and shape-less objects fall through to the injected resolver instead
    // of entering the generic dispatcher with invalid input.
    // ---------------------------------------------------------------------------
    const presentation = (values as { presentation?: unknown }).presentation;
    if (
      presentation !== null &&
      typeof presentation === "object" &&
      !Array.isArray(presentation) &&
      typeof (presentation as { type?: unknown }).type === "string"
    ) {
      // Async IIFE: await createSurface, then publish the two translator
      // messages. The outer .catch(() => {}) preserves the fire-and-forget
      // discipline at the onInterrupt boundary; ordering is enforced inside.
      void (async () => {
        await this.publish({
          version: "v0.9",
          createSurface: {
            surfaceId,
            catalogId: "cinatra-default",
            sendDataModel: true,
          },
        });
        for (const msg of translateHintToA2UiMessages(surfaceId, presentation)) {
          await this.publish(msg);
        }
      })().catch((err) => {
        console.error("[a2ui-adapter] presentation-hint publish failed", err instanceof Error ? err.message : String(err));
      });
      return;
    }

    // Mid-run xRenderers dispatch through the INJECTED resolver (built from
    // the manifest-declared bindings by the host caller).
    const midRunTranslator = this.resolveMidRunTranslator?.(xRenderer);
    if (midRunTranslator) {
      const messages = midRunTranslator(surfaceId, schema, values, reviewTaskId);
      for (const msg of messages) {
        void this.publish(msg).catch(() => {});
      }
      return;
    }

    // Setup-phase renderer — intentionally separate from mid-run dispatch.
    // grouped-setup-form fires before the LangGraph run starts (TS execution layer),
    // while mid-run translator bindings handle mid-run gates from LangGraph interrupts.
    // Keeping them separate preserves the setup/mid-run distinction at the dispatch site.
    if (xRenderer !== GROUPED_SETUP_FORM_RENDERER_ID) return;

    const messages = translateSetupGroupToA2UiMessages(
      surfaceId,
      schema,
      values,
      reviewTaskId,
    );
    for (const msg of messages) {
      void this.publish(msg).catch(() => {});
    }
  }
  onResume(): void {}
}
