// ---------------------------------------------------------------------------
// THE HITL SCREEN'S SHAPE — what the card is told, and nothing that tells it
// (cinatra#2930, lifecycle-b W3).
//
// PURE ON PURPOSE. The card runs in a browser bundle and the reader runs on a
// server, and the two need the same vocabulary: the state, the gate, and the
// parse that turns a transport answer back into either. Keeping that here — no
// store, no `"use server"`, no React — is what lets the transcript's leaf import
// the shape without dragging the server graph into every consumer that mounts
// the conversation column. The reader itself lives next door in
// `agent-hitl-screen-core.ts`.
// ---------------------------------------------------------------------------

import {
  LIFECYCLE_MOMENT_CARD_KIND,
  type LifecycleCardKind,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";

/** The moment this card is the card OF, and the kind that moment mounts. */
export const AGENT_HITL_MOMENT = "hitl" as const;
export const AGENT_HITL_CARD_KIND: LifecycleCardKind =
  LIFECYCLE_MOMENT_CARD_KIND[AGENT_HITL_MOMENT];

/**
 * The gate the screen asks on — the four fields a renderer needs and nothing
 * else. Deliberately a projection of the run's derived HITL context rather than
 * the whole of it: `childRunId` is an execution detail no drawing reads, and a
 * card should not carry a field it cannot use.
 */
export type AgentHitlScreenGate = {
  /** The review-task identity the answer is submitted against. */
  reviewTaskId: string;
  /** Which renderer draws the fields. Empty ⇒ there is no screen to draw. */
  xRenderer: string;
  /** The schema the renderer draws from. */
  inputSchema: Record<string, unknown>;
  /** What is already filled in. */
  currentValues: Record<string, unknown>;
  /** The setup-loop field identity, or `null` for a mid-run gate. */
  fieldName: string | null;
};

/**
 * The binding that DECLARES the gate's screen (cinatra#3470), when the gate's
 * renderer is one an installed agent package declares with a `screen`. The
 * run page fetches the installed bindings itself; a conversation host has
 * only the run id, so the authorized read hands it the one binding its gate
 * names. Public renderer metadata: the client validates the screen again when
 * it registers it, and a refused one registers nothing.
 */
export type AgentHitlDeclaredScreenBinding = {
  id: string;
  kind: string;
  priority: number;
  midRunHitl?: boolean;
  /** The binding's declared params, handed to its renderer as
   *  `bindingParams` exactly as the run page's registration hands them. */
  params?: Record<string, unknown>;
  screen: Record<string, unknown>;
};

/**
 * What this run's HITL screen is, including "there is none".
 *
 * Two states and only two, on the audit card's precedent: `asking` draws the
 * screen, `none` draws NO DOM AT ALL and is the collapse of every denial.
 */
export type AgentHitlScreenState =
  | { state: "none" }
  | {
      state: "asking";
      runId: string;
      /** The server-checked reference the run recorded for the screen. */
      screenRef: string | null;
      gate: AgentHitlScreenGate;
      /** The declared screen of the gate's renderer, when one is declared. */
      declaredScreen?: AgentHitlDeclaredScreenBinding;
    };

export const AGENT_HITL_SCREEN_NONE: AgentHitlScreenState = Object.freeze({
  state: "none",
});

/**
 * Does the run STATE that it is at the HITL moment?
 *
 * Both halves are required. The moment says which moment the run is at; the
 * card kind says which card that moment mounts. A row carrying one without the
 * other is a half-written record, and a half-written record is not a moment.
 */
export function runStatesHitlMoment(run: {
  lifecycleMoment?: string | null;
  lifecycleCardKind?: string | null;
}): boolean {
  return (
    run.lifecycleMoment === AGENT_HITL_MOMENT &&
    run.lifecycleCardKind === AGENT_HITL_CARD_KIND
  );
}

/**
 * Parse a transport answer back into the state, or `null` for anything this
 * build cannot read.
 *
 * `null` is a FAILURE, never a state: the card keeps its last authorized answer
 * (or none at all) rather than settling on a shape it did not understand.
 */
export function parseAgentHitlScreenState(data: unknown): AgentHitlScreenState | null {
  if (data === null || typeof data !== "object") return null;
  const state = (data as { state?: unknown }).state;
  if (state === "none") return AGENT_HITL_SCREEN_NONE;
  if (state !== "asking") return null;
  const runId = (data as { runId?: unknown }).runId;
  const gate = (data as { gate?: unknown }).gate;
  if (typeof runId !== "string" || runId.length === 0) return null;
  if (gate === null || typeof gate !== "object") return null;
  const reviewTaskId = (gate as { reviewTaskId?: unknown }).reviewTaskId;
  const xRenderer = (gate as { xRenderer?: unknown }).xRenderer;
  if (typeof reviewTaskId !== "string" || reviewTaskId.length === 0) return null;
  if (typeof xRenderer !== "string" || xRenderer.length === 0) return null;
  const screenRef = (data as { screenRef?: unknown }).screenRef;
  const fieldName = (gate as { fieldName?: unknown }).fieldName;
  const asRecord = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const declaredScreen = parseDeclaredScreenBinding(
    (data as { declaredScreen?: unknown }).declaredScreen,
    xRenderer,
  );
  return {
    state: "asking",
    runId,
    screenRef: typeof screenRef === "string" ? screenRef : null,
    ...(declaredScreen ? { declaredScreen } : {}),
    gate: {
      reviewTaskId,
      xRenderer,
      inputSchema: asRecord((gate as { inputSchema?: unknown }).inputSchema),
      currentValues: asRecord((gate as { currentValues?: unknown }).currentValues),
      fieldName: typeof fieldName === "string" ? fieldName : null,
    },
  };
}

/**
 * The declared screen binding of a transport answer, kept only when it is the
 * binding of THIS gate's renderer and has the binding's plain shape. The
 * screen itself is validated again at registration.
 */
export function parseDeclaredScreenBinding(
  data: unknown,
  xRenderer: string,
): AgentHitlDeclaredScreenBinding | null {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  const b = data as Record<string, unknown>;
  if (b.id !== xRenderer || typeof b.kind !== "string" || b.kind.length === 0) return null;
  if (typeof b.priority !== "number" || !Number.isFinite(b.priority)) return null;
  const screen = b.screen;
  if (screen === null || typeof screen !== "object" || Array.isArray(screen)) return null;
  // Params travel with the binding (cinatra#3470): a "kind" layout's component
  // reads them, and the registration this answer drives replaces the run
  // page's. Params that are present but not a plain object refuse the binding.
  const params = b.params;
  if (params !== undefined && (params === null || typeof params !== "object" || Array.isArray(params))) {
    return null;
  }
  return {
    id: xRenderer,
    kind: b.kind,
    priority: b.priority,
    ...(b.midRunHitl === true ? { midRunHitl: true } : {}),
    ...(params !== undefined ? { params: params as Record<string, unknown> } : {}),
    screen: screen as Record<string, unknown>,
  };
}
