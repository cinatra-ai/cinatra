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
// ONE ANSWER, TWO DOORS — AND THE WIDGET'S CONTINUE ACTS.
//
// The Continue submits the SAME input on every host: the buffered values with
// `approved`, the context-selector envelope filled only when the renderer wrote
// none, the attachment envelope for every gate that is not a setup gate, and
// the setup-loop wrap under the gate's own field name. What differs is only how
// the reader's identity reaches the server.
//
//   · A COOKIE HOST keeps the shipped server action, byte-for-byte unchanged.
//   · A CREDENTIAL-DECLARING HOST — the site widget, whose frame is same-origin
//     to the app — posts to the broker submit route with its OWN `cwu_` and
//     `credentials: "omit"`, so no ambient Cinatra cookie can ride along and
//     answer as whoever else is signed in on that browser. The server hands
//     that answer to the SAME approval core the action calls, under the run's
//     OWN access rules (`run.execute` then `run.approveHitl`) — the in-app
//     checks, no looser — and the run resumes. The card then re-reads and
//     settles, exactly as it does on the run page.
//
// So the widget's Continue is enabled exactly when the in-app one is. Two
// things are still refused, and both fail closed:
//
//   · A HOST THAT DECLARES NEITHER DOOR — a mis-wired provider, a credential
//     the provider rejected. There is no identity to answer with, so the
//     control is drawn and inert and no request is issued.
//   · A GATE WHOSE FIELD RENDERER IS NOT DECLARED SAFE WITHOUT A SESSION. The
//     card's read and submit carry the reader's own credential; a renderer
//     mounted INSIDE the card does not. One that calls its own `"use server"`
//     action, or that resolves further renderers out of the registry, reaches
//     the server on whatever ambient Cinatra session that browser holds — which
//     can belong to a different person. So where there is no cookie session the
//     card mounts ONLY a renderer whose registry entry declares
//     `credentialSafe`; anything else draws no renderer and withholds the
//     Continue, and the card and its fields region are still drawn so the
//     identity a capture is graded on is intact.
//
//     THE ANSWER IS READ OFF THE RESOLVED ENTRY, never off the gate's
//     `x-renderer` string (convergence). A wire id does not determine which
//     component is mounted: a manifest binding maps an arbitrary id onto a host
//     kind, and an extension binding loads a component this repository has never
//     read. Absent means unsafe, so a grouped-setup form — which resolves its
//     own children — and every extension binding are withheld too, without
//     needing to be named. Giving those renderers the host's credential is
//     their own work, not this slice's.
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
  LIFECYCLE_HITL_SCREEN_SUBMIT_PATH,
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
import { getFieldRendererContextForAgentBuilderAction } from "./server-actions";
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

/**
 * §I INPUT HIERARCHY — WHICH TREATMENT THE CARD'S FIELDS TAKE, PER HOST.
 *
 * The ratified drawing at the contract's pin, §I, under "The rule, wherever a
 * card meets a chat box", verbatim:
 *
 *   "Exactly one primary input is drawn per conversation, and it is the chat
 *    box. Any field a card carries is drawn subordinate to it. Where there is
 *    no chat box to be subordinate to — the run page and the review page — the
 *    card's field is the only input there is and takes the primary treatment
 *    instead. The hierarchy is between the two inputs, not a fixed look for
 *    either one."
 *
 * A TOTAL MAP, so a host cannot be added to the epic without deciding which
 * side of that rule it is on. The two conversation hosts have a chat box below
 * them; the run page and the review page do not.
 */
const FIELD_PRESENTATION: Record<LifecycleCardHost, HitlFieldPresentation> = {
  chat_thread: "subordinate",
  site_widget: "subordinate",
  run_card: "primary",
  page_gate_region: "primary",
};

export type HitlFieldPresentation = "subordinate" | "primary";

/**
 * THE ONE PLACE THE TREATMENT IS APPLIED — the card's FIELDS REGION, which is
 * the single element every field renderer this card can mount is drawn inside.
 *
 * WHY HERE AND NOT PER RENDERER. The card mounts whatever the gate's renderer
 * resolves to: a host-internal kind, a manifest binding onto a host kind, an
 * extension binding loading a component this repository has never read, the
 * grouped-setup form that resolves its own children, or the generic dispatch
 * renderer a presentation hint short-circuits to. A rule that each of those had
 * to opt into would reach the ones that were edited and silently miss the rest,
 * and could not reach an extension component at all. A scope on the REGION
 * reaches every one of them by containment, so a renderer that has never heard
 * of §I is still drawn subordinate inside a conversation.
 *
 * WHAT IT CANNOT REACH, stated rather than implied: anything a renderer draws
 * OUTSIDE this subtree — a popover or dialog portalled to `document.body`, or a
 * field inside a nested browsing context or a shadow root. Nothing shipped in
 * this repository draws a HITL field that way; an extension could, and that
 * would be its own work.
 *
 * The subordinate rules themselves live in the app stylesheet beside the other
 * cross-package card chrome (`src/app/globals.css`,
 * `.lifecycle-fields-subordinate`) — the same place `soft-panel` is defined,
 * which this region has always used.
 */
export const HITL_FIELDS_REGION_CLASS: Record<HitlFieldPresentation, string> = {
  // PRIMARY — byte-for-byte what the run page and the review page draw today.
  // §I asks for the primary treatment there and they already carry it, so
  // nothing moves: the region keeps its own box, its ground and its inset.
  primary: "soft-panel rounded-panel p-4 bg-surface-muted flex flex-col gap-4",
  // SUBORDINATE — the region gives up the box and the fill (the class carries
  // the same give-ups down to every field inside it), and the card's own frame
  // around it is unchanged: §I takes the weight off the FIELD, not off the card.
  subordinate: "lifecycle-fields-subordinate flex w-full min-w-0 flex-col gap-4",
};

/**
 * The §I treatment this host's fields take. Exported so the run panel's own
 * host-supplied screen declares the SAME answer for the host it draws on rather
 * than a second opinion about it.
 */
export function hitlFieldPresentationFor(host: LifecycleCardHost): HitlFieldPresentation {
  return FIELD_PRESENTATION[host];
}

/** A setup gate's answer, as the renderer handed it out and the core takes it. */
type SetupAnswer = { payload: unknown; fieldName: string | undefined };

/**
 * The identity of the question on screen — the review task, the renderer and the
 * field it names. What is typed into one gate, and what a renderer offers to
 * hand back, belong to that gate and to no other.
 *
 * INJECTIVE, and it has to be. A separator-joined key is not: a review task id
 * ending in the separator and a renderer id beginning with it produce the same
 * string as a different pair, and this key is what decides whether a staged
 * answer or a registered flush still belongs to the gate on screen. Two gates
 * that collide would let one question be answered with the other's field. All
 * three parts are unconstrained strings that arrive from a run's own row, so the
 * encoding carries the boundaries rather than a chosen separator.
 */
export function hitlGateKey(gate: AgentHitlScreenGate): string {
  return JSON.stringify([gate.reviewTaskId, gate.xRenderer, gate.fieldName ?? null]);
}

/**
 * §I "NO SEND" — WHOSE CONTROL THE SEND IS, ON A GATE IN A CONVERSATION.
 *
 * The same clause that decides the treatment decides this, because it is one
 * sentence: where the field is drawn SUBORDINATE it gives up "the enclosing
 * box, the raised ground and the send affordance", and §I's own example draws
 * that field with no button at all. A send drawn INSIDE the subordinate field
 * is the second primary input the rule exists to forbid — it does not stop
 * being one because the component that drew it is a field renderer.
 *
 * So on a conversation host the send is the CARD'S, on both gate shapes it can
 * answer: the card draws its own Continue outside the region, and the renderer's
 * own submit is not drawn inside it.
 *
 * THE MID-RUN HALF IS cinatra#3051, FIX LEG 9, and the hole it closes was named
 * here before it was closed: the setup arm below used to be the whole rule, and
 * a mid-run gate was left with the card's Continue OUTSIDE the region and the
 * renderer's own send INSIDE it — two sends in one card, the second of them
 * drawn over the chat box it is supposed to be subordinate to. The ninth proof
 * round answered a mid-run selection step inside the widget, which is exactly
 * that screen. Nothing about the mid-run ANSWER moves: the renderer still
 * buffers into the card's own Continue on change, and the Continue asks the
 * renderer for its value through the shared flush first, which is the same call
 * the button it no longer draws would have made.
 *
 * ONE SHAPE IS DELIBERATELY LEFT ALONE, and it is stated rather than hidden: a
 * GROUPED-SETUP form owns ONE submit for the whole form and resolves its own
 * children, so the card draws no Continue for it on any host and cannot take the
 * form's over. Giving the card that form's send means the form handing its whole
 * validated value out on demand, which is its own work.
 *
 * On the run page and the review page the field is the primary input, the
 * renderer keeps its own control, and nothing here reaches them.
 */
export function cardOwnsTheSend(
  host: LifecycleCardHost,
  gate: AgentHitlScreenGate,
): boolean {
  if (hitlFieldPresentationFor(host) !== "subordinate") return false;
  const { isGroupedSetup } = classifyHitlGate(gate);
  return !isGroupedSetup;
}

/**
 * The SETUP half of that rule — the arm that also moves WHERE THE ANSWER GOES.
 *
 * A setup-loop gate submits ON CHANGE, so taking its renderer's button away also
 * means the change must STAGE rather than submit and the card's own Continue
 * must send what was staged. A mid-run gate already buffers into the card's
 * Continue, so its arm moves the BUTTON and nothing else. Two predicates because
 * they answer two different questions about the same rule.
 */
export function cardOwnsTheSetupSend(
  host: LifecycleCardHost,
  gate: AgentHitlScreenGate,
): boolean {
  if (!cardOwnsTheSend(host, gate)) return false;
  return !classifyHitlGate(gate).isMidRun;
}

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
 * THE BROKER SUBMIT, for a host that proves itself with its own credential.
 *
 * The SAME answer the cookie door sends, addressed by the run as well as the
 * gate: a credential-declaring surface names its card by a run id off the
 * transcript, so the server re-derives that run's own gate and refuses an id
 * that is not it. Nothing here is trusted — the route re-authorizes from
 * scratch and runs the run's own access rules.
 *
 * Returns whether the answer LANDED. A refusal is not a landing: the screen
 * stays exactly as it was with the answer still in hand, which is what the
 * cookie door does when the action throws.
 */
async function submitHitlScreenThroughBroker(input: {
  runId: string;
  reviewTaskId: string;
  values: unknown;
  fieldName: string | undefined;
  auth: LifecycleCardAuth;
}): Promise<boolean> {
  try {
    const response = await fetch(LIFECYCLE_HITL_SCREEN_SUBMIT_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...input.auth.headers() },
      body: JSON.stringify({
        runId: input.runId,
        reviewTaskId: input.reviewTaskId,
        ...(input.values !== undefined ? { values: input.values } : {}),
        ...(input.fieldName !== undefined ? { fieldName: input.fieldName } : {}),
      }),
      credentials: input.auth.credentials,
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { outcome?: { ok?: unknown } };
    return body?.outcome?.ok === true;
  } catch {
    return false;
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

/**
 * "Nothing is connected" — the honest starting point, and the whole answer on a
 * surface that cannot ask. Frozen so it is one identity rather than a new
 * object per render.
 */
const NO_CONNECTED_APPS: FieldRendererContext = Object.freeze({ connectedApps: [] });

/**
 * THE READER'S CONNECTED SENDING ACCOUNTS, on a host that can ask for them.
 *
 * WHY THE CARD HAS TO LOAD THIS. Some shipped renderer conditions are gated on
 * connectivity — the Gmail sender picker matches only when `connectedApps`
 * names gmail AND the reader has aliases — and inside a conversation the run
 * panel now STANDS DOWN in favour of this card. The panel loads this context
 * for its own screen; without the card loading it too, a signed-in reader with
 * Gmail connected would reach a sender gate in `/chat` and be handed the plain
 * schema fallback instead of their alias picker. That is a regression on a
 * COOKIE host, caused by moving the drawing, and it is fixed by moving the
 * context with it — through the SAME shipped action the panel calls, so the two
 * surfaces cannot resolve a different context for the same reader.
 *
 * ONLY WHERE THERE IS A SESSION TO ASK WITH. The action is cookie-bound. On a
 * credential-declaring host it is never called — that is the ambient-cookie
 * hazard this card's containment exists for — and the context stays "nothing is
 * connected", which is not a guess: it is the truthful statement that this
 * surface cannot see the reader's connections, and it makes a connectivity-gated
 * renderer decline to match rather than draw against connectivity it cannot
 * prove.
 */
function useFieldRendererContext(runId: string, cookieSession: boolean): FieldRendererContext {
  const [loaded, setLoaded] = useState<{
    connectedApps: string[];
    gmailAliases?: { sendAsEmail: string; displayName?: string }[];
  } | null>(null);
  useEffect(() => {
    if (!cookieSession) return;
    let live = true;
    void getFieldRendererContextForAgentBuilderAction()
      .then((data) => {
        if (live) setLoaded({ connectedApps: data.connectedApps, gmailAliases: data.gmailAliases });
      })
      .catch(() => {
        // A context that could not be read is not a context: the card keeps the
        // empty one, which declines connectivity-gated renderers rather than
        // matching them on a guess.
      });
    return () => {
      live = false;
    };
  }, [cookieSession]);
  return useMemo<FieldRendererContext>(() => {
    if (!cookieSession || loaded === null) return NO_CONNECTED_APPS;
    return {
      connectedApps: loaded.connectedApps,
      ...(loaded.gmailAliases ? { gmailAliases: loaded.gmailAliases } : {}),
      runId,
    };
  }, [cookieSession, loaded, runId]);
}

/**
 * The registry entry a gate resolves to, and whether it may be mounted without
 * a cookie session.
 *
 * Resolved the way `AgentHitlScreenFields` resolves it — the same registry, the
 * same placeholder key, the same schema with the gate's `x-renderer` on it — so
 * the card's decision and the region's rendering can never disagree about which
 * component is in question.
 *
 * A PRESENTATION HINT short-circuits to `true`: that path draws the card's OWN
 * `DispatchRenderer` and reaches no registry entry at all.
 */
function gateRendererIsSessionFree(runId: string, gate: AgentHitlScreenGate): boolean {
  if (presentationHintOf(gate) !== null) return true;
  // ABSENT MEANS UNSAFE — including "no entry at all", which draws nothing
  // anyway and must not be reported as a mountable renderer.
  return resolveHitlGateEntry(runId, gate)?.credentialSafe === true;
}

/**
 * CAN THE CARD ACTUALLY ANSWER FOR THIS GATE? — the other half of the takeover,
 * because taking a send away without being able to deliver one strands the
 * reader, which is the regression `agentic-run-panel.tsx` records from the last
 * time a surface hid the submit.
 *
 * The card answers through the renderer's `onChange`, which is the SAME channel
 * the renderer's own button uses — that button has no other way to submit
 * either. So the takeover holds exactly where the region mounts a renderer this
 * card hands `onChange` to: a resolved registry entry, and no presentation hint
 * (that path draws the card's own `DispatchRenderer`, which is given neither
 * `onChange` nor a flush).
 *
 * WHAT IT STILL CANNOT SEE, stated rather than claimed away: a renderer that
 * HONOURS `hideSubmit`, registers no flush, and calls `onChange` only from the
 * button it has just been told not to draw. That renderer has opted into being
 * driven by its host while offering the host no way to drive it. One that
 * ignores `hideSubmit` keeps its own control and keeps working.
 */
function gateMountsAnAnsweringRenderer(runId: string, gate: AgentHitlScreenGate): boolean {
  if (presentationHintOf(gate) !== null) return false;
  return resolveHitlGateEntry(runId, gate) !== null;
}

/** The registry entry this gate resolves to, or null — resolved the way
 *  `AgentHitlScreenFields` resolves it, so the card's decisions and the region's
 *  rendering can never disagree about which component is in question. */
function resolveHitlGateEntry(runId: string, gate: AgentHitlScreenGate) {
  const fieldSchema: Record<string, unknown> = {
    ...gate.inputSchema,
    "x-renderer": gate.xRenderer,
  };
  const context: FieldRendererContext = {
    // REQUIRED, AND THE ASSERTION THAT HID IT IS GONE (convergence). The
    // registry evaluates every entry's condition by priority, and a shipped
    // condition reads `context.connectedApps` before anything narrows to its
    // own renderer — so an omitted field is not a missing hint, it is a throw
    // on the way to an unrelated gate's renderer. The empty list is the type's
    // own documented default and it is the TRUTH here: this card knows nothing
    // about which apps the reader has connected, and a condition gated on one
    // must therefore not match.
    connectedApps: [],
    runId,
    allFieldValues: gate.currentValues,
    xRenderer: gate.xRenderer,
  };
  return (
    fieldRendererRegistry.resolve(HITL_PLACEHOLDER_FIELD_NAME, fieldSchema, context) ?? null
  );
}

export function AgentHitlScreenFields({
  runId,
  host,
  gate,
  buffered,
  onBuffer,
  onSubmitField,
  onSubmitBuffer,
  withholdRenderer,
  rendererContext,
  hideRendererSubmit,
  registerFlush,
  gateKey,
}: {
  runId: string;
  /** THE HOST THIS REGION IS DRAWN ON — §I's hierarchy is a fact about the
   *  surface, not about the field, so the card hands its host to the field it
   *  mounts and the region decides the treatment once, for every renderer. */
  host: LifecycleCardHost;
  gate: AgentHitlScreenGate;
  buffered: Record<string, unknown>;
  onBuffer: (next: Record<string, unknown>) => void;
  onSubmitField: (payload: unknown, payloadFieldName: string | undefined) => Promise<void>;
  /** The grouped-setup form owns its own submit — this is what it lands on. */
  onSubmitBuffer: (next: Record<string, unknown>) => Promise<void>;
  /** This renderer talks to the server on its OWN cookie and this host has no
   *  session — see the header. The region is drawn; the renderer is not. */
  withholdRenderer?: boolean;
  /** The reader's connected sending accounts, where the host could ask for
   *  them. Empty on a host that cannot — see `useFieldRendererContext`. */
  rendererContext?: FieldRendererContext;
  /** §I "no send" — the CARD owns the send on this host, so the renderer's own
   *  submit is not drawn inside the field. Carried through the SHARED renderer
   *  props contract (`hideSubmit`, which every field renderer receives and
   *  which says in as many words that a renderer drawing its own Continue must
   *  skip it), never through a per-renderer flag, so it reaches a component
   *  this repository has never read. The stylesheet scope below it is the
   *  containment backstop for one that ignores the contract. */
  hideRendererSubmit?: boolean;
  /** How the card asks the renderer for what is in it. The shipped renderers
   *  hold the reader's text locally and hand it out through this — which is the
   *  SAME call their own Continue makes — so the card's Continue submits
   *  exactly what that button submitted. Tagged with the gate the region drew,
   *  so a registration cannot outlive the question it belongs to. */
  registerFlush?: (key: string, fn: () => Promise<void>) => void;
  /** The gate identity a registration is tagged with. */
  gateKey?: string;
}): ReactElement {
  const { isMidRun, isGroupedSetup } = classifyHitlGate(gate);
  const hint = presentationHintOf(gate);
  const fieldSchema: Record<string, unknown> = {
    ...gate.inputSchema,
    "x-renderer": gate.xRenderer,
  };
  const context: FieldRendererContext = {
    // The HOST'S context — the reader's connected sending accounts where the
    // host could ask for them, and the honest empty list where it could not.
    // `connectedApps` is REQUIRED and the assertion that hid its absence is
    // gone: the registry evaluates every condition by priority, and a shipped
    // one reads it before anything narrows to its own renderer.
    ...(rendererContext ?? NO_CONNECTED_APPS),
    runId,
    allFieldValues: { ...gate.currentValues, ...buffered },
    xRenderer: gate.xRenderer,
  };
  const entry =
    hint || withholdRenderer === true
      ? null
      : fieldRendererRegistry.resolve(HITL_PLACEHOLDER_FIELD_NAME, fieldSchema, context);
  const { "x-renderer": _xr, ...renderSchema } = fieldSchema;
  void _xr;
  const Renderer = entry?.renderer ?? null;

  const presentation = hitlFieldPresentationFor(host);
  const flushKey = gateKey ?? hitlGateKey(gate);
  const registerRendererFlush = registerFlush
    ? (fn: () => Promise<void>) => registerFlush(flushKey, fn)
    : undefined;

  return (
    <div
      className={HITL_FIELDS_REGION_CLASS[presentation]}
      data-conformance-id="hitl-screen-fields"
      // §I, READABLE OFF THE DOM. A capture is graded on what the picture shows,
      // so the region says which side of the hierarchy it is on rather than
      // leaving a reader to infer it from a class list.
      data-field-presentation={presentation}
      // §I "no send", READABLE OFF THE DOM and the hook the stylesheet's own
      // backstop hangs on: the region says the card owns the send rather than
      // leaving a reader to infer it from the absence of a button.
      {...(hideRendererSubmit === true ? { "data-send-affordance": "card" } : {})}
    >
      {withholdRenderer === true ? (
        // WITHHELD, not broken: the region is the anchor a capture is graded
        // on, so it is drawn — empty — rather than the card losing its shape.
        // The Continue beside it is withheld for the same reason.
        null
      ) : hint !== null ? (
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
          hideSubmit={hideRendererSubmit === true}
          registerFlush={registerRendererFlush}
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
function HitlContinueControl({
  submitting,
  blocked,
  onPress,
}: {
  submitting: boolean;
  blocked: boolean;
  onPress: () => Promise<void>;
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
                "Continue this run where you are signed in to Cinatra — this surface carries no credential for the decision.",
            }
          : {})}
        onClick={() => void onPress()}
      >
        {submitting ? "Continuing…" : "Continue"}
        <ArrowRight className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

export function AgentHitlScreenContinue({
  gate,
  buffered,
  readBuffered,
  submitting,
  blocked,
  onContinue,
}: {
  gate: AgentHitlScreenGate;
  buffered: Record<string, unknown>;
  /**
   * WHERE THE CARD OWNS THE SEND (cinatra#3051, fix leg 9), what the reader
   * typed is asked for at the PRESS rather than read off the last render: the
   * card asks the renderer for its value through the shared props contract's own
   * flush — the same call the button the renderer no longer draws would have
   * made — and hands back the buffer that flush wrote. Absent everywhere the
   * renderer kept its own control, and the press is then byte-identical to what
   * it was before this parameter existed.
   */
  readBuffered?: () => Promise<Record<string, unknown>>;
  submitting: boolean;
  /** This host has NO identity to answer with — neither a cookie session nor a
   *  declared credential. The control is drawn and inert rather than firing a
   *  request the server would have to guess the caller of. */
  blocked: boolean;
  onContinue: (payload: Record<string, unknown>) => Promise<void>;
}): ReactElement {
  return (
    <HitlContinueControl
      submitting={submitting}
      blocked={blocked}
      onPress={async () => {
        const answered = readBuffered ? await readBuffered() : buffered;
        let payload: Record<string, unknown> = {
          ...answered,
          approved: true,
          approvedAt: new Date().toISOString(),
        };
        if (!isSetupGateTaskId(gate.reviewTaskId)) {
          payload = applyAttachmentEnvelopeUserResponseOnly(payload, []);
        }
        payload = withContextSelectorEnvelope(gate.xRenderer, gate.currentValues, payload);
        await onContinue(payload);
      }}
    />
  );
}

/**
 * THE CARD'S CONTINUE ON A SETUP GATE — the same control, the same anchor, and
 * the SAME submit the renderer's own button made.
 *
 * A setup-loop gate submits ON CHANGE: the renderer's button calls `onChange`
 * with what the reader typed, the card wraps it under the gate's own field name
 * with the shipped `wrapPrimitiveSetupPayload`, and hands it to the one submit
 * core. This control changes NOTHING about that path. It asks the renderer for
 * its value through the shared props contract's own flush — which is the same
 * call the renderer's button makes — and then submits what came back, wrapped
 * by the same helper, through the same core.
 *
 * WHY IT EXISTS. §I forbids a send inside the subordinate field, and on a
 * conversation host that button was the only way forward. Taking it away
 * without putting the card's own control in its place would strand the reader —
 * which is exactly the regression `agentic-run-panel.tsx` records from the last
 * time a surface hid it. So the send MOVES rather than disappearing: out of the
 * field, onto the card, where §I says the card's own control belongs.
 */
export function AgentHitlScreenSetupContinue({
  submitting,
  blocked,
  onContinue,
}: {
  submitting: boolean;
  blocked: boolean;
  onContinue: () => Promise<void>;
}): ReactElement {
  return <HitlContinueControl submitting={submitting} blocked={blocked} onPress={onContinue} />;
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
  const rendererContext = useFieldRendererContext(runId, cookieSession);
  const present = host !== null;

  const [reloadToken, setReloadToken] = useState(0);
  const [buffered, setBuffered] = useState<Record<string, unknown>>(EMPTY_BUFFER);
  const [submitting, setSubmitting] = useState(false);

  // THE SETUP GATE'S ANSWER, HELD BETWEEN THE FIELD AND THE CARD'S CONTINUE.
  //
  // A setup-loop gate has always submitted ON CHANGE, because the renderer's own
  // button was the send. On a conversation host §I moves that send onto the card
  // (`cardOwnsTheSetupSend`), so the same `onChange` now STAGES what it would have
  // submitted — byte for byte, the same `wrapPrimitiveSetupPayload` output under
  // the same field name — and the card's Continue submits it through the same
  // core. A ref rather than state on purpose: the flush below calls `onChange`
  // synchronously, and a state write would not be readable in the same turn.
  const setupAnswerRef = useRef<SetupAnswer | null>(null);
  // How the card asks the field for what is in it, through the shared renderer
  // props contract. The shipped renderers hold the reader's text locally and
  // hand it out here — the SAME call their own Continue makes.
  //
  // KEYED BY THE GATE, and for the same reason the buffer is: a renderer that
  // has been replaced can still be holding the previous question's text, and a
  // flush called on it would answer the NEW question with the OLD field. It
  // cannot be CLEARED on a gate change instead, because a child's effect runs
  // before its parent's — the renderer registers for the new gate first and the
  // parent would then throw that registration away.
  const flushRef = useRef<null | { key: string; fn: () => Promise<void> }>(null);
  const registerRendererFlush = useCallback((key: string, fn: () => Promise<void>) => {
    flushRef.current = { key, fn };
  }, []);

  // THE HOST OWNS THE GATE WHEN IT OWNS THE DRAWING. See the header: a host that
  // hands in a screen has already decided the run is asking, so the card asks
  // the server nothing on that path and can never withhold what its host draws.
  //
  // AND ONLY WHERE THERE IS A SESSION TO DRAW IT WITH (convergence). The
  // production topology already only supplies a screen from the run panel,
  // which declares a cookie host — but the invariant belongs on the card's own
  // boundary rather than on a fact about today's callers, because a screen
  // handed in from a credential-declaring host would be exactly the unaudited
  // subtree this card's containment exists to keep off that surface. Where it
  // does not hold the card composes its own body instead, under the rules
  // above, rather than drawing nothing.
  const hostSuppliesScreen = screen !== undefined && cookieSession;

  // Hooks run unconditionally (rules of hooks); a surface with no declared host —
  // or one that supplies its own screen — asks for nothing, because the empty
  // run id short-circuits the read.
  const state = useAgentHitlScreenState({
    runId: present && !hostSuppliesScreen ? runId : "",
    wireRef: wireRef ?? null,
    reloadToken,
    auth,
  });

  // THE BUFFER, ALSO READABLE IN THE PRESS THAT FLUSHED IT (cinatra#3051, fix
  // leg 9). A flush calls the renderer's `onChange` synchronously, and the state
  // write it makes is not readable in the same turn — the same reason the staged
  // setup answer is a ref. So the mid-run buffer is mirrored here and the card's
  // Continue reads the mirror, never the render's own snapshot.
  const bufferedRef = useRef<Record<string, unknown>>(EMPTY_BUFFER);
  const onBuffer = useCallback((next: Record<string, unknown>) => {
    bufferedRef.current = next;
    setBuffered(next);
  }, []);

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
  const gateKey = gate === null ? null : hitlGateKey(gate);
  const bufferedGateRef = useRef<string | null>(null);
  useEffect(() => {
    if (bufferedGateRef.current === gateKey) return;
    bufferedGateRef.current = gateKey;
    setBuffered(EMPTY_BUFFER);
    bufferedRef.current = EMPTY_BUFFER;
    // THE STAGED SETUP ANSWER BELONGS TO ONE GATE TOO, for exactly the reason
    // the buffer does, and so does the flush that produced it: the renderer is
    // keyed by the gate and re-registers on the new one, and a flush left over
    // from the previous gate would answer the next question with the last one's
    // field.
    setupAnswerRef.current = null;
  }, [gateKey]);
  // Read in the SAME render the key changed in, so a submit that lands before
  // the effect runs cannot carry the previous gate's values either.
  const activeBuffered = bufferedGateRef.current === gateKey ? buffered : EMPTY_BUFFER;
  // ASKING, on both paths: the host's own gate, or the authorized read's answer.
  const asking = hostSuppliesScreen || gate !== null;

  const submit = useCallback(
    async (payload: unknown, payloadFieldName: string | undefined) => {
      if (!gate) return;
      // NO IDENTITY, NO REQUEST. A host that declares neither a cookie session
      // nor a credential has nothing to answer with, and firing either door
      // from it would be asking the server to guess who is calling. This is the
      // same silence the Continue's `blocked` state draws.
      if (!auth && !cookieSession) return;
      setSubmitting(true);
      let landed: boolean;
      if (auth) {
        // THE BROKER DOOR. The reader's own credential, and never the ambient
        // cookie of a frame that is same-origin to the app.
        landed = await submitHitlScreenThroughBroker({
          runId,
          reviewTaskId: gate.reviewTaskId,
          values: payload,
          fieldName: payloadFieldName,
          auth,
        });
      } else {
        // THE COOKIE DOOR, unchanged.
        landed = true;
        try {
          await approveReviewTask(gate.reviewTaskId, payload, payloadFieldName);
        } catch (error) {
          // "already resolved" is the expected race (a double press, the same
          // gate answered on another surface). Every other failure leaves the
          // screen exactly as it was, with the answer still in hand.
          landed = isAlreadyResolvedError(
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      setSubmitting(false);
      // WHAT WAS TYPED SURVIVES A REFUSAL and is cleared by a landing. A
      // refusal leaves the screen exactly as it was, with the answer in hand.
      // THE MIRROR IS CLEARED WITH THE BUFFER IT MIRRORS. The card's own
      // Continue reads `bufferedRef`, not this render's snapshot, so leaving
      // the ref behind on a landing would let a second press on a gate whose
      // key has not yet changed re-send what was just answered, over a field
      // the reader can see is empty.
      if (landed) {
        setBuffered(EMPTY_BUFFER);
        bufferedRef.current = EMPTY_BUFFER;
      }
      // THE CARD RE-READS EITHER WAY (convergence). A landing is
      // obviously a moment the answer changed — but so is a REFUSAL: the most
      // common reason a submit is refused is that the gate was already answered
      // somewhere else, and re-deriving found the run no longer asking. Not
      // re-reading there left the stale question on screen until the next focus
      // or remount, which on the review-page mount (no wire ref, so no change
      // signal) could be a long time. Re-reading is authorized and cheap, and
      // it is what makes the card settle on the truth rather than on the
      // outcome of one request.
      setReloadToken((n) => n + 1);
    },
    [gate, auth, cookieSession, runId],
  );

  const onContinue = useCallback(
    async (payload: Record<string, unknown>) => {
      await submit(payload, undefined);
    },
    [submit],
  );

  // WHERE THE CARD OWNS THE SEND, the setup field's own change STAGES instead of
  // submitting. Nothing about the payload changes — it is the same wrap under
  // the same field name — only who presses.
  const stageSetupAnswer = useCallback(
    async (payload: unknown, fieldName: string | undefined) => {
      setupAnswerRef.current = { payload, fieldName };
    },
    [],
  );

  /**
   * THE CARD'S CONTINUE ON A MID-RUN GATE, where the card now owns the send.
   * Ask the renderer for its value the way the button it no longer draws would
   * have asked, then answer with the buffer that flush wrote. A renderer that
   * registers no flush has already buffered on change, and the mirror below is
   * exactly what it wrote.
   */
  const readMidRunBuffer = useCallback(async (): Promise<Record<string, unknown>> => {
    const flush = flushRef.current;
    if (flush !== null && flush.key === gateKey) await flush.fn();
    return bufferedGateRef.current === gateKey ? bufferedRef.current : EMPTY_BUFFER;
  }, [gateKey]);

  /** Take what is staged, and leave nothing behind for the next press. */
  const takeSetupAnswer = useCallback((): SetupAnswer | null => {
    const staged = setupAnswerRef.current;
    setupAnswerRef.current = null;
    return staged;
  }, []);

  /** ONE PRESS AT A TIME — see `onContinueSetup`. */
  const setupPressRef = useRef(false);

  // THE CARD'S CONTINUE ON A SETUP GATE. Ask the field for its value the way the
  // field's own button asks it, then submit exactly that through the one core.
  // A renderer that hands nothing back (a required box left empty says so
  // itself, in its own words, inside the field) leaves the screen as it was.
  const onContinueSetup = useCallback(async () => {
    // ONE PRESS AT A TIME, guarded on a ref rather than on the rendered
    // `disabled` alone: the flush below is asynchronous and `submitting` is
    // React state, so two presses in the same tick would both get past the
    // button and both reach the submit core with the same answer.
    if (setupPressRef.current) return;
    setupPressRef.current = true;
    setSubmitting(true);
    try {
      // ASK THE FIELD FOR ITS VALUE, the way the field's own button asks it.
      //
      // WHAT IS ALREADY STAGED IS NOT THROWN AWAY FIRST. A renderer that emits
      // `onChange` as the reader types and registers no flush has ALREADY handed
      // its answer over — that is exactly what its own button would have
      // submitted — and clearing the stage before asking again would leave that
      // renderer with no way to answer at all. Where a flush IS registered it
      // simply overwrites the stage with the same renderer's current value.
      const flush = flushRef.current;
      if (flush !== null && flush.key === gateKey) await flush.fn();
      const staged = takeSetupAnswer();
      // Nothing to submit: a required box the renderer refused to hand over says
      // so itself, in its own words, inside the field. The screen is left
      // exactly as it was and nothing is sent.
      if (staged === null) return;
      await submit(staged.payload, staged.fieldName);
    } finally {
      setSubmitting(false);
      setupPressRef.current = false;
    }
  }, [submit, gateKey, takeSetupAnswer]);

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
    // No declared host, no fields region: the treatment §I asks for is a fact
    // about the surface, and there is no surface to read it off.
    if (host === null || !gate) return null;
    // THE CONTINUE IS DRAWN WHERE THE PANEL DRAWS IT: on a mid-run gate that is
    // not a grouped-setup form. A grouped-setup form carries its own submit, and
    // a setup-loop field submits on change — a second Continue on either would
    // be a control the run page does not offer.
    const { isMidRun, isGroupedSetup } = classifyHitlGate(gate);
    // A renderer that is not declared safe without a session is withheld
    // wherever there is no session — see the header. The condition is the
    // ABSENCE of a session rather than the presence of a credential, so a host
    // that declares neither is covered by it too.
    const withholdRenderer = !cookieSession && !gateRendererIsSessionFree(runId, gate);
    // §I "NO SEND" — see `cardOwnsTheSetupSend` and
    // `gateMountsAnAnsweringRenderer`. On a conversation host the SETUP gate's
    // send is the CARD'S: the card draws its own Continue outside the region and
    // the renderer's own submit is not drawn inside it. BOTH HALVES RIDE ONE
    // CONDITION, so a send is never taken away from a screen the card cannot
    // answer for — a withheld renderer, a presentation hint, or a gate that
    // resolves to no renderer at all keeps whatever control it has, and the card
    // draws none of its own there.
    //
    // AND THE MID-RUN GATE RIDES THE SAME ONE (cinatra#3051, fix leg 9): its
    // renderer's own send is withheld too, and the card's Continue — which that
    // screen already draws — asks the renderer for its value first.
    const cardOwnsSend =
      cardOwnsTheSend(host, gate) &&
      !withholdRenderer &&
      gateMountsAnAnsweringRenderer(runId, gate);
    const cardOwnsSetupSend = cardOwnsSend && cardOwnsTheSetupSend(host, gate);
    return (
      <>
        <AgentHitlScreenFields
          runId={runId}
          host={host}
          gate={gate}
          buffered={activeBuffered}
          onBuffer={onBuffer}
          onSubmitField={cardOwnsSetupSend ? stageSetupAnswer : submit}
          onSubmitBuffer={onSubmitBuffer}
          withholdRenderer={withholdRenderer}
          rendererContext={rendererContext}
          hideRendererSubmit={cardOwnsSend}
          registerFlush={cardOwnsSend ? registerRendererFlush : undefined}
          gateKey={gateKey ?? ""}
        />
        {isMidRun && !isGroupedSetup ? (
          <AgentHitlScreenContinue
            gate={gate}
            buffered={activeBuffered}
            {...(cardOwnsSend ? { readBuffered: readMidRunBuffer } : {})}
            submitting={submitting}
            blocked={(!cookieSession && auth === null) || withholdRenderer}
            onContinue={onContinue}
          />
        ) : cardOwnsSetupSend ? (
          <AgentHitlScreenSetupContinue
            submitting={submitting}
            blocked={!cookieSession && auth === null}
            onContinue={onContinueSetup}
          />
        ) : null}
      </>
    );
  }, [
    hostSuppliesScreen,
    screen,
    gate,
    runId,
    host,
    activeBuffered,
    onBuffer,
    submit,
    submitting,
    cookieSession,
    rendererContext,
    auth,
    onContinue,
    onContinueSetup,
    onSubmitBuffer,
    registerRendererFlush,
    stageSetupAnswer,
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
