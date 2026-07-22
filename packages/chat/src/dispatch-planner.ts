/**
 * Declaration-driven DISPATCH PLANNER (cinatra#1875 W2, Epic #1873 — AC#2).
 *
 * The single decision that turns a set of audience-checked assistant mentions
 * (from `./classify-mentions`) into a per-assistant DISPATCH PLAN, driven by each
 * assistant's DECLARED delivery channel (the persisted
 * `installed_extension.assistant_declaration.block.delivery.kind`, projected by
 * the W1 registry reader). This RETIRES the hardcoded `chatgpt`/`gemini` routing
 * that lived in `actions.ts` / the MCP handlers: there is no literal-handle
 * comparison here — an assistant dispatches because it is a REGISTERED,
 * IN-AUDIENCE assistant with a DECLARED delivery, never because its handle is a
 * known built-in.
 *
 * Ruling (Epic #1873 plan-of-record, 2026-07-21, M1/M2/M5): there is no built-in
 * assistant class and no `@chatgpt` token — every assistant ships via an
 * extension (Cinatra included). The planner routes `@openai`/`@gemini`/`@claude`
 * (once their W6 packages install) to their CONNECTOR-BACKED runtime; the
 * CONNECTOR selects API-vs-local-CLI transport from its own config. The planner
 * NEVER branches on transport — its only axis is the declared delivery CHANNEL:
 *
 *   - `host-runtime` → the reply STREAMS in-band over the unified AG-UI producer
 *     endpoint ({@link HOST_RUNTIME_ENDPOINT}); the turn is attributed to the
 *     assistant's own principal.
 *   - `webhook` / `mcp-poll` → the mention is persisted `pending`; the connector
 *     delivers OUT of band (a signed outbound webhook push, or the assistant's
 *     own `chat_mentions_poll`). The planner emits NO endpoint for these.
 *
 * PURE given the classification + a delivery lookup (built server-side from the
 * W1 reader entries) — unit-testable without a DB or the network.
 */

import type { MentionClassification } from "./classify-mentions";
import { assistantMentions } from "./classify-mentions";

/**
 * The declared delivery channel of an assistant's turns. A LOCAL mirror of the
 * single source (`@cinatra-ai/sdk-extensions/assistant-declaration`
 * `ASSISTANT_DELIVERY_KINDS`) so this pure package module — and its unit test —
 * never pull the app's DB-layer registry reader into their import graph.
 */
export type AssistantDeliveryKind = "host-runtime" | "webhook" | "mcp-poll";

/** The unified AG-UI producer endpoint a `host-runtime` assistant streams over —
 *  the connector-backed runtime path. The connector, not the planner, then picks
 *  API-vs-local-CLI transport. (Replaces the retired per-built-in endpoints.) */
export const HOST_RUNTIME_ENDPOINT = "/api/assistants/chat";

/**
 * The delivery lookup the planner consults for a classified assistant — built
 * server-side from the audience-filtered W1 registry entries. Returns the
 * assistant's declared delivery, or `undefined` when the entry cannot be
 * resolved (a registry drift the planner treats as the host-runtime default,
 * never an external push — fail SAFE).
 */
export type AssistantDeliveryLookup = (ref: {
  assistantUserId: string;
  packageName: string | null;
  handle: string;
}) => AssistantDeliveryKind | undefined;

/** One resolved dispatch directive for a single mentioned assistant. */
export type DispatchDirective = {
  assistantUserId: string;
  handle: string;
  packageName: string | null;
  delivery: AssistantDeliveryKind;
  /** Set ONLY for `host-runtime` (the in-band AG-UI stream endpoint). `webhook`
   *  / `mcp-poll` carry no endpoint — the mention is persisted `pending` and the
   *  connector delivers out of band. */
  endpoint?: string;
};

/** The plan the routing layer consumes: the audience-checked assistant mentions,
 *  partitioned by how they are dispatched. */
export type DispatchPlan = {
  /** Assistants whose reply STREAMS in-band (the connector-backed host runtime).
   *  Source order preserved; deduped by principal. */
  hostRuntime: DispatchDirective[];
  /** Assistants delivered OUT of band (webhook push / mcp poll) — persisted as a
   *  `pending` mention. Source order preserved; deduped by principal. */
  push: DispatchDirective[];
  /** Every directive, source order preserved (host-runtime + push interleaved as
   *  mentioned). */
  directives: DispatchDirective[];
};

/**
 * Plan the dispatch for a message's classification. Consumes ONLY the
 * `kind:"assistant"` mentions (already registered + in-audience — the classifier
 * enforced audience; `agent-dispatch` / `unresolved` are the routing layer's
 * concern, NOT the planner's). Each surviving assistant is mapped to its declared
 * delivery via {@link AssistantDeliveryLookup} and partitioned:
 *   - `host-runtime` → an in-band stream directive (endpoint set);
 *   - `webhook` / `mcp-poll` → an out-of-band push directive (no endpoint).
 * Deduped by `assistantUserId` (a message that names the same assistant twice —
 * e.g. flat handle + scoped ref — dispatches to it ONCE, first mention wins).
 * Pure; source order preserved.
 */
export function planAssistantDispatch(
  classified: readonly MentionClassification[],
  deliveryFor: AssistantDeliveryLookup,
): DispatchPlan {
  const directives: DispatchDirective[] = [];
  const seen = new Set<string>();

  for (const m of assistantMentions(classified)) {
    if (seen.has(m.assistantUserId)) continue;
    seen.add(m.assistantUserId);

    const delivery =
      deliveryFor({
        assistantUserId: m.assistantUserId,
        packageName: m.packageName,
        handle: m.handle,
      }) ?? "host-runtime"; // fail SAFE to the local host runtime, never a push.

    directives.push({
      assistantUserId: m.assistantUserId,
      handle: m.handle,
      packageName: m.packageName,
      delivery,
      ...(delivery === "host-runtime" ? { endpoint: HOST_RUNTIME_ENDPOINT } : {}),
    });
  }

  return {
    directives,
    hostRuntime: directives.filter((d) => d.delivery === "host-runtime"),
    push: directives.filter((d) => d.delivery !== "host-runtime"),
  };
}
