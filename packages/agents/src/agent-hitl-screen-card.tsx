"use client";

// ---------------------------------------------------------------------------
// `AgentHitlScreenCard` — THE renderer of `agent_hitl_screen`
// (cinatra#2930, lifecycle-b W3). Design: the pause screen in
// `specs/app-components.html`, inside the base page's section-I card chrome
// (`specs/app-artifact-review.html`), which is the chrome every lifecycle card
// in a conversation is drawn in.
//
// WHAT THIS FINISHES. W2a (cinatra#2928) registered the fifth kind so a run
// could STATE that it is paused asking a person for input, and drew nothing.
// W3 (cinatra#2991) gave the kind its substrate: canonical carriage
// `run_state`, the coordinator feeding the outbox when the moment opens, and
// the delivery record. What was left — and what this file is — is the CARD:
// the kind's own identity root, on the three hosts the parity ratchet owes.
//
// IT DRAWS THE SCREEN THAT ALREADY EXISTS. The pause screen is not invented
// here. It is fields and a Continue, and that is what the run panel has
// rendered for as long as a run could pause: the field renderer the gate's
// `x-renderer` selects out of the SHIPPED registry, and the Continue that
// submits the gate's answer through the SHIPPED review-task action. This card
// composes those two, exactly as `ReviewGateCard` composes the shipped
// `ReviewDecisionBar` and `RecommendationHoldCard` composes the shipped
// `RunRecommendationChipRow`. No second renderer, no second submit path.
//
// AND A HOST MAY HAND IN ITS OWN SCREEN. `screen` is how the run page keeps the
// pause screen it already draws, unchanged and with every adjunct that belongs
// to that surface — the skill chips, the field-assist panel, the attachment
// envelope. The run panel passes its own block and this card frames it; a
// conversation passes nothing and this card composes the same two shipped
// pieces. Either way there is ONE card root per host, carrying the kind, the
// host and the state, so a capture reads the same identity on all four.
//
// A HOST-SUPPLIED SCREEN IS HOST-GATED, and that is a rule rather than a
// shortcut. The host that hands in a screen has ALREADY decided the run is
// paused asking — the run panel renders this card only inside its own
// `isPendingApproval && xRenderer` branch — so making the card's own read a
// SECOND gate would let a card withhold a screen its host is drawing. A run
// that pauses without the coordinator having stated the moment (a setup-loop
// gate, or a run that started before the moment was recorded) would then lose
// the screen it has always shown. So `screen` short-circuits the read
// entirely: the card is the identity around a drawing the host owns, and it
// asks the server nothing on that path. Where NO screen is handed in — the
// conversation hosts, which have only a run id — the read is the gate, and a
// run that states no HITL moment draws nothing.
//
// THE THREE RULES IT INHERITS FROM `lifecycle-card-runtime`, restated because
// this card resolves through a server ACTION rather than the `/resolve` route
// (it is an INTERRUPT kind — it has no `DATA_PART` ref envelope to POST):
//
//  1. FAIL-CLOSED SURFACE GATING. A host opts IN via
//     `LifecycleCardSurfaceProvider`. No provider ⇒ no host ⇒ no DOM.
//  2. NOTHING WITHOUT AN AUTHORIZED READ. The read runs the run access door and
//     answers from the run's OWN stated moment. Until it answers this renders
//     nothing — not a skeleton. A transport failure keeps the last authorized
//     answer rather than inventing one.
//  3. NO TIMER. The card re-reads on exactly the events that can change the
//     answer: mount, a change in the run's wire ref, window focus, and its own
//     submit landing.
//
// THE ONE CONTAINMENT, STATED. The Continue submits through the cookie-bound
// review-task action, so on a credential-declaring host — the site widget,
// whose frame is same-origin to the app — it is drawn and DISABLED rather than
// riding whatever ambient Cinatra cookie that browser happens to hold. That is
// the same containment the widget's run panel already carries on main, and it
// is recorded rather than smoothed over: the card is present, the question is
// readable, and the answer is taken where the reader's own credential can carry
// it. A broker submit is the work that lifts it.
// ---------------------------------------------------------------------------

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { ArrowRight } from "lucide-react";

import { Button } from "@/components/ui/button";

import {
  LIFECYCLE_HITL_SCREEN_PATH,
  useCookieSessionSurface,
  useLifecycleCardAuth,
  useLifecycleCardHost,
  type LifecycleCardAuth,
} from "./lifecycle-card-runtime";
import {
  AGENT_HITL_SCREEN_NONE,
  parseAgentHitlScreenState,
  type AgentHitlScreenGate,
  type AgentHitlScreenState,
} from "./agent-hitl-screen";
import { getAgentHitlScreenStateAction } from "./agent-hitl-screen-actions";
import { fieldRendererRegistry, type FieldRendererContext } from "./field-renderer-registry";
import { hasMidRunHitlBinding } from "./orchestrator-mid-run-hitl";
import { DispatchRenderer, type PresentationHint } from "./result-renderers";
import { approveReviewTask } from "./hitl-actions";
import {
  applyAttachmentEnvelopeUserResponseOnly,
  hitlRendererFieldName,
  isAlreadyResolvedError,
  isGroupedSetupRenderer,
  isSetupGateTaskId,
  setupFieldRendererValue,
  withContextSelectorEnvelope,
  wrapPrimitiveSetupPayload,
} from "./hitl-gate-submit";
import { HITL_PLACEHOLDER_FIELD_NAME } from "./humanize-field-name";
import type { LifecycleCardHost } from "@cinatra-ai/agent-ui-protocol/renderable-views";

/**
 * The per-host FRAME (§IX: "presence is not layout"), a total map so a new host
 * cannot be added to the epic without deciding its frame here.
 *
 * The bordered plate is the card treatment for a CONVERSATION, where the screen
 * has to separate itself from the turns around it; on the run's own page the
 * same content sits inside the panel's section and is not boxed a second time.
 */
const HOST_FRAME: Record<LifecycleCardHost, string> = {
  chat_thread:
    "my-3 flex w-full min-w-0 flex-col gap-3 rounded-card border border-line bg-surface-strong p-3.5",
  site_widget:
    "my-3 flex w-full min-w-0 flex-col gap-3 rounded-card border border-line bg-surface-strong p-3.5",
  run_card: "flex w-full min-w-0 flex-col gap-3",
  page_gate_region: "flex w-full min-w-0 flex-col gap-3",
};

/** One shared empty buffer, so "nothing typed yet" is one identity rather than
 *  a fresh object every render. */
const EMPTY_BUFFER: Record<string, unknown> = Object.freeze({});

/** The BROKER read, for a host that proves itself with its own credential. */
async function readHitlScreenThroughBroker(
  runId: string,
  auth: LifecycleCardAuth,
): Promise<AgentHitlScreenState | null> {
  try {
    const response = await fetch(LIFECYCLE_HITL_SCREEN_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth.headers() },
      body: JSON.stringify({ runId }),
      credentials: auth.credentials,
    });
    // A REFUSAL IS AN ANSWER, NOT A FAILURE (convergence finding). The read
    // caches the last authorized answer so a transient 5xx does not blank a
    // question mid-edit — but a credential that was revoked or replaced while
    // the card stayed mounted comes back 401/403, and treating THAT as a
    // failure would leave the old question, and its current values, on screen
    // for a reader who may no longer see them. So an authorization refusal
    // collapses to the same silence a run that was never parked produces, and
    // the card goes away.
    if (response.status === 401 || response.status === 403) {
      return AGENT_HITL_SCREEN_NONE;
    }
    if (!response.ok) return null;
    return parseAgentHitlScreenState((await response.json()) as unknown);
  } catch {
    return null;
  }
}

/**
 * The authorized state for one run, re-read on the four events that can change
 * it and on nothing else.
 *
 * `null` until the first read completes — the caller draws nothing while it is
 * null. A failed read is never turned into a state.
 */
export function useAgentHitlScreenState(params: {
  runId: string;
  wireRef: string | null;
  reloadToken: number;
  auth: LifecycleCardAuth | null;
}): AgentHitlScreenState | null {
  const { runId, wireRef, reloadToken, auth } = params;
  const [resolved, setResolved] = useState<{ runId: string; state: AgentHitlScreenState } | null>(
    null,
  );
  const [focusToken, setFocusToken] = useState(0);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onFocus = () => setFocusToken((n) => n + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  useEffect(() => {
    if (!runId) return;
    let live = true;
    void (async () => {
      const state = auth
        ? await readHitlScreenThroughBroker(runId, auth)
        : await getAgentHitlScreenStateAction({ runId }).catch(() => null);
      // A read that could not be completed is a FAILURE, not a state: the last
      // authorized answer stands, and an unread card stays silent.
      if (!live || state === null) return;
      setResolved({ runId, state });
    })();
    return () => {
      live = false;
    };
  }, [runId, wireRef, reloadToken, focusToken, auth]);

  // An answer that belongs to a DIFFERENT run is not this card's answer.
  return resolved && resolved.runId === runId ? resolved.state : null;
}

/**
 * THE FIELDS — the shipped renderer the gate's own `x-renderer` selects.
 *
 * The resolution is the run panel's, not a second one: the same registry, the
 * same placeholder key for SELECTION, the same real field identity for the
 * rendered label, and the same `x-renderer` strip before the schema reaches the
 * renderer (so a renderer that re-resolves internally cannot recurse).
 */
/**
 * WHICH KIND OF GATE THIS IS — the run panel's own classification, read from the
 * same shipped helpers rather than guessed here (convergence finding).
 *
 * A first version branched on the VALUE the renderer handed back — an object
 * buffered, a primitive submitted — and that is not the rule the panel applies.
 * The panel decides by the gate's RENDERER: a mid-run gate (an `:output`
 * renderer, or one whose manifest declares `midRunHitl`) buffers into the outer
 * Continue, and everything else takes the setup-loop path, where the value is
 * wrapped under the gate's own field name and submitted. An OBJECT-typed setup
 * field is exactly where the two disagree: the panel submits it as
 * `{ [fieldName]: object }` with the field name beside it, and a card that
 * spread it into its buffer would submit top-level keys with no field name —
 * merging into the wrong inputs, or leaving the setup loop paused for ever.
 */
function classifyHitlGate(gate: AgentHitlScreenGate): {
  isMidRun: boolean;
  isGroupedSetup: boolean;
} {
  return {
    isMidRun: gate.xRenderer.endsWith(":output") || hasMidRunHitlBinding(gate.xRenderer),
    isGroupedSetup: isGroupedSetupRenderer(gate.xRenderer),
  };
}

/**
 * The PRESENTATION HINT a mid-run gate may embed in its current values — the
 * same guard the panel applies, and the same short-circuit through the generic
 * dispatch renderer when one is present.
 */
function presentationHintOf(gate: AgentHitlScreenGate): PresentationHint | null {
  const candidate = (gate.currentValues as { presentation?: unknown }).presentation;
  if (
    candidate !== null &&
    typeof candidate === "object" &&
    !Array.isArray(candidate) &&
    typeof (candidate as { type?: unknown }).type === "string"
  ) {
    return candidate as PresentationHint;
  }
  return null;
}

export function AgentHitlScreenFields({
  runId,
  gate,
  buffered,
  onBuffer,
  onSubmitField,
  onSubmitBuffer,
}: {
  runId: string;
  gate: AgentHitlScreenGate;
  buffered: Record<string, unknown>;
  onBuffer: (next: Record<string, unknown>) => void;
  onSubmitField: (payload: unknown, payloadFieldName: string | undefined) => Promise<void>;
  /** The grouped-setup form owns its own submit — this is what it lands on. */
  onSubmitBuffer: (next: Record<string, unknown>) => Promise<void>;
}): ReactElement {
  const { isMidRun, isGroupedSetup } = classifyHitlGate(gate);
  const hint = presentationHintOf(gate);
  const fieldSchema: Record<string, unknown> = {
    ...gate.inputSchema,
    "x-renderer": gate.xRenderer,
  };
  const context: FieldRendererContext = {
    runId,
    allFieldValues: { ...gate.currentValues, ...buffered },
    xRenderer: gate.xRenderer,
  } as FieldRendererContext;
  const entry = hint
    ? null
    : fieldRendererRegistry.resolve(HITL_PLACEHOLDER_FIELD_NAME, fieldSchema, context);
  const { "x-renderer": _xr, ...renderSchema } = fieldSchema;
  void _xr;
  const Renderer = entry?.renderer ?? null;

  return (
    <div
      className="soft-panel rounded-panel p-4 bg-surface-muted flex flex-col gap-4"
      data-conformance-id="hitl-screen-fields"
    >
      {hint !== null ? (
        // Presentation-first, exactly as the panel reads it: a gate that
        // embedded a hint is drawn through the generic dispatch renderer rather
        // than through a per-renderer resolution.
        <DispatchRenderer hint={hint} mode="edit" />
      ) : Renderer === null ? (
        <p className="text-sm text-muted-foreground">
          Waiting for input — no renderer configured for this step.
        </p>
      ) : (
        <Renderer
          key={`${gate.xRenderer}::${gate.fieldName ?? ""}`}
          fieldName={hitlRendererFieldName(gate.fieldName ?? undefined)}
          schema={renderSchema}
          value={setupFieldRendererValue(
            { ...gate.currentValues, ...buffered },
            gate.fieldName ?? undefined,
            renderSchema,
          )}
          onChange={
            isMidRun
              ? async (next: unknown) => {
                  // MID-RUN: buffer into the outer Continue. A grouped-setup
                  // form owns its own submit, so it approves immediately and
                  // the reader only ever sees one Continue.
                  let nextBuffered = buffered;
                  if (next && typeof next === "object" && !Array.isArray(next)) {
                    nextBuffered = { ...buffered, ...(next as Record<string, unknown>) };
                    onBuffer(nextBuffered);
                  }
                  if (isGroupedSetup) await onSubmitBuffer(nextBuffered);
                }
              : async (next: unknown) => {
                  // SETUP-LOOP: the value belongs UNDER the gate's own field
                  // name — including an object-typed one — because the server
                  // merge keys off `fieldName` to know which input slot to
                  // fill, and a raw value with no field name silently no-ops
                  // and re-emits the same gate for ever.
                  const { payload, payloadFieldName } = wrapPrimitiveSetupPayload(
                    gate.fieldName ?? undefined,
                    next,
                    {
                      objectTypedField:
                        (renderSchema as { type?: string } | undefined)?.type === "object",
                    },
                  );
                  await onSubmitField(payload, payloadFieldName);
                }
          }
          context={context}
          mode="edit"
        />
      )}
    </div>
  );
}

/**
 * THE CONTINUE — the one control the screen offers, and the same answer the run
 * panel submits: `{…buffered, approved, approvedAt}`, the context-selector
 * envelope filled only when the renderer wrote none, and the attachment
 * envelope applied for every gate that is not a setup gate.
 */
export function AgentHitlScreenContinue({
  gate,
  buffered,
  submitting,
  blocked,
  onContinue,
}: {
  gate: AgentHitlScreenGate;
  buffered: Record<string, unknown>;
  submitting: boolean;
  /** The host cannot carry this reader's own credential to a decision. */
  blocked: boolean;
  onContinue: (payload: Record<string, unknown>) => Promise<void>;
}): ReactElement {
  return (
    <div className="flex justify-end items-center gap-2 pt-2 border-t border-line">
      <Button
        size="sm"
        className="gap-1.5"
        data-action="submit-hitl-screen"
        disabled={submitting || blocked}
        {...(blocked
          ? {
              title:
                "Continue this run where you are signed in to Cinatra — this surface cannot carry your own credential to the decision yet.",
            }
          : {})}
        onClick={async () => {
          let payload: Record<string, unknown> = {
            ...buffered,
            approved: true,
            approvedAt: new Date().toISOString(),
          };
          if (!isSetupGateTaskId(gate.reviewTaskId)) {
            payload = applyAttachmentEnvelopeUserResponseOnly(payload, []);
          }
          payload = withContextSelectorEnvelope(gate.xRenderer, gate.currentValues, payload);
          await onContinue(payload);
        }}
      >
        {submitting ? "Continuing…" : "Continue"}
        <ArrowRight className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

/**
 * THE HITL SCREEN CARD. `runId` is the run the host's transcript or panel
 * already names; every fact drawn below comes from the authorized read, and the
 * card renders nothing at all until one lands.
 */
export function AgentHitlScreenCard({
  runId,
  wireRef,
  screen,
}: {
  runId: string;
  /**
   * The run's own wire ref for this moment, when the host has a stream. A pure
   * CHANGE SIGNAL: nothing is read out of it, and a forged one buys nothing,
   * because the read below re-authorizes from scratch.
   */
  wireRef?: string | null;
  /**
   * The pause screen this host already draws. Given, it is framed as-is — which
   * is how the run page keeps its screen and every adjunct that belongs to that
   * surface. Absent, the card composes the shipped fields and Continue itself.
   */
  screen?: ReactNode;
}): ReactElement | null {
  const host = useLifecycleCardHost();
  const auth = useLifecycleCardAuth();
  const cookieSession = useCookieSessionSurface();
  const present = host !== null;

  const [reloadToken, setReloadToken] = useState(0);
  const [buffered, setBuffered] = useState<Record<string, unknown>>(EMPTY_BUFFER);
  const [submitting, setSubmitting] = useState(false);

  // THE HOST OWNS THE GATE WHEN IT OWNS THE DRAWING. See the header: a host that
  // hands in a screen has already decided the run is asking, so the card asks
  // the server nothing on that path and can never withhold what its host draws.
  const hostSuppliesScreen = screen !== undefined;

  // Hooks run unconditionally (rules of hooks); a surface with no declared host —
  // or one that supplies its own screen — asks for nothing, because the empty
  // run id short-circuits the read.
  const state = useAgentHitlScreenState({
    runId: present && !hostSuppliesScreen ? runId : "",
    wireRef: wireRef ?? null,
    reloadToken,
    auth,
  });

  const onBuffer = useCallback((next: Record<string, unknown>) => setBuffered(next), []);

  const gate = state !== null && state.state === "asking" ? state.gate : null;

  // THE BUFFER BELONGS TO ONE GATE, AND ONLY TO IT.
  //
  // What the reader typed is held here until the Continue submits it, and the
  // buffer used to be cleared on this card's OWN successful submit alone. That
  // is not the only way a gate ends: the same run can be advanced from the
  // composer, from the run page, or from another tab, and the next read then
  // replaces `gate` while the previous gate's half-typed values are still in
  // hand — and the next submit would merge them into a question that never
  // asked for them. So the buffer is KEYED by the gate it was typed into: a
  // buffer whose key does not match the gate on screen is not this gate's
  // answer and is not read, and the effect below drops it.
  const gateKey =
    gate === null ? null : `${gate.reviewTaskId}::${gate.xRenderer}::${gate.fieldName ?? ""}`;
  const bufferedGateRef = useRef<string | null>(null);
  useEffect(() => {
    if (bufferedGateRef.current === gateKey) return;
    bufferedGateRef.current = gateKey;
    setBuffered(EMPTY_BUFFER);
  }, [gateKey]);
  // Read in the SAME render the key changed in, so a submit that lands before
  // the effect runs cannot carry the previous gate's values either.
  const activeBuffered = bufferedGateRef.current === gateKey ? buffered : EMPTY_BUFFER;
  // ASKING, on both paths: the host's own gate, or the authorized read's answer.
  const asking = hostSuppliesScreen || gate !== null;

  const submit = useCallback(
    async (payload: unknown, payloadFieldName: string | undefined) => {
      if (!gate) return;
      setSubmitting(true);
      try {
        await approveReviewTask(gate.reviewTaskId, payload, payloadFieldName);
      } catch (error) {
        // "already resolved" is the expected race (a double press, the same
        // gate answered on another surface). Every other failure leaves the
        // screen exactly as it was, with the answer still in hand.
        if (!isAlreadyResolvedError(error instanceof Error ? error.message : String(error))) {
          setSubmitting(false);
          return;
        }
      }
      setSubmitting(false);
      setBuffered(EMPTY_BUFFER);
      setReloadToken((n) => n + 1);
    },
    [gate],
  );

  const onContinue = useCallback(
    async (payload: Record<string, unknown>) => {
      await submit(payload, undefined);
    },
    [submit],
  );

  // The grouped-setup form's own submit lands here: the SAME approved envelope
  // the Continue builds, from the buffer the form just wrote.
  const onSubmitBuffer = useCallback(
    async (next: Record<string, unknown>) => {
      await submit({ ...next, approved: true, approvedAt: new Date().toISOString() }, undefined);
    },
    [submit],
  );

  const body = useMemo<ReactNode>(() => {
    if (hostSuppliesScreen) return screen;
    if (!gate) return null;
    // THE CONTINUE IS DRAWN WHERE THE PANEL DRAWS IT: on a mid-run gate that is
    // not a grouped-setup form. A grouped-setup form carries its own submit, and
    // a setup-loop field submits on change — a second Continue on either would
    // be a control the run page does not offer.
    const { isMidRun, isGroupedSetup } = classifyHitlGate(gate);
    return (
      <>
        <AgentHitlScreenFields
          runId={runId}
          gate={gate}
          buffered={activeBuffered}
          onBuffer={onBuffer}
          onSubmitField={submit}
          onSubmitBuffer={onSubmitBuffer}
        />
        {isMidRun && !isGroupedSetup ? (
          <AgentHitlScreenContinue
            gate={gate}
            buffered={activeBuffered}
            submitting={submitting}
            blocked={!cookieSession}
            onContinue={onContinue}
          />
        ) : null}
      </>
    );
  }, [
    hostSuppliesScreen,
    screen,
    gate,
    runId,
    activeBuffered,
    onBuffer,
    submit,
    submitting,
    cookieSession,
    onContinue,
    onSubmitBuffer,
  ]);

  // Nothing before an authorized read, and NO DOM AT ALL for `none` — the
  // collapse of every denial, exactly as the audit card's `absent` is. A
  // host-supplied screen is past both: its host already decided.
  if (!present || !asking) return null;

  return (
    <div
      className={HOST_FRAME[host]}
      data-lifecycle-card="agent_hitl_screen"
      data-lifecycle-card-state="asking"
      data-lifecycle-card-host={host}
      data-conformance-id="agent-hitl-screen-card"
    >
      {body}
    </div>
  );
}

export { AGENT_HITL_SCREEN_NONE };
export type { AgentHitlScreenState };
