// ---------------------------------------------------------------------------
// THE LENT ACTION — one self-MCP primitive (cinatra#2932, lifecycle-b W5a).
//
// From the plan (PLAN: Agents Lifecycle (B), §4):
//
//   "The card lends the assistant its own controls, once. ... While a card is
//    bound, and only then, the assistant holds one action that operates that
//    card and no other. Its choices are exactly what the card's own buttons
//    offer ... A card that offers no decision lends none. The grant is consumed
//    by its first use; a second attempt in the same message is refused, and the
//    assistant says so."
//
//   "The lent control is therefore new, and it is one more tool on that same
//    server — the only place the assistant can reach anything about the
//    lifecycle. It can be used only with a grant the server mints when a message
//    is sent with a bound card ... A card reference by itself grants nothing, and
//    a tool being visible to the model is not permission to use it."
//
//   "Using the action is pressing the button. Same identity, same permissions,
//    same recorded decision, same one-time effect."
//
// THE NAME IS HONEST, AND THAT IS DELIBERATE. `lifecycle_bound_card_decide`
// carries the `decide` token, so the delegated policies' decision-verb backstop
// DENIES it by construction. Reaching chat therefore costs an explicit,
// disclosed override entry plus its typed `CarveOut` twin — which is exactly the
// visibility this one exception is supposed to have. A name chosen to slip past
// the backstop (`lifecycle_bound_card_operate`) would have hidden the class the
// primitive belongs to, and the epic's own note about `schedule_proposal_render`
// says why that matters: the name is load-bearing for the guarantee.
//
// SIX GATES, IN THIS ORDER, EVERY ONE FAIL-CLOSED:
//
//   1. A GRANT ON THE FRAME. No grant, no action — a visible tool is not
//      permission. The grant arrives on the request frame, put there by the
//      transport from the header the hosted self-MCP reference carried; it is
//      never a tool argument, because an argument is something a model can
//      invent.
//   2. THE GRANT VERIFIES. Signature, shape and life. A forged, rotated-out or
//      expired grant is one observable.
//   3. THE GRANT MATCHES THE CALL. Person, organization, card and the ONE
//      control. A grant minted for another card, another person or another
//      button is refused here.
//   4. THE PERSON'S OWN CREDENTIAL. Resolved LIVE from the store — never the
//      delegated chat token, whose whole point is that it is weaker. This is the
//      plan's bound-turn actor branch.
//   5. THE CARD IS STILL THERE, AND STILL LENDS THAT CONTROL. The bound-reference
//      resolver runs under that credential; a card that offers no decision lends
//      none, and a control the card does not offer is refused even with a valid
//      grant.
//   6. THE GRANT IS SPENT. One atomic delete, BEFORE the effect. Two concurrent
//      calls of one grant cannot both press the button, and a call whose effect
//      then fails does not get a second attempt — a retry is a new message with
//      a new grant, which is what "single use" has to mean if it is to mean
//      anything.
//
// WHAT THE SIX GATES DO NOT CLOSE, said plainly (convergence round 1, findings 1-3).
// A grant is a BEARER authority for its two minutes: it pins who may spend it,
// what it may press and that it is spent once, and it does NOT pin which turn of
// that person spends it — a party already holding a valid delegated token for
// the same person and organization could present a captured unspent grant on
// another of their turns. That is one press of one card the person had bound,
// added to authority such a party already holds. And nothing here decides
// whether the person's message was ASKING for the press: the model chooses to
// call, so text reaching the model — reviewed content, a form value, the
// conversation — can induce a call. Two things bound that: what lands is the
// PERSON'S OWN WORDS, read out of the spent row rather than supplied by the
// model, and the only control a send mints today is `comment`, whose effect is
// exactly what the review page's own box does with a typed sentence now.
// Deciding whether a sentence asks for a decision at all is the typed actions
// per card kind (cinatra#2853), which builds on this substrate.
//
// THEN, AND ONLY THEN, THE CARD'S OWN PATH RUNS. `submitReviewDecisionAction`
// for the review card's three buttons; `approveReviewTaskInternal` for the HITL
// screen's Continue. Neither is re-implemented and neither is relaxed: the same
// order, the same CAS, the same audit row a press produces. The platform's own
// outcome is relayed back word for word — "the assistant's line reports what came
// back and adds nothing".
// ---------------------------------------------------------------------------

import "server-only";

import { z } from "zod";
import type { McpRuntimeToolServer } from "@cinatra-ai/mcp-server";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";
// THE CARD'S OWN PATHS ARE IMPORTED LAZILY, AND THAT IS A MEASUREMENT, NOT A
// STYLE CHOICE. This module is registered on the MCP server, which is reachable
// from `/api/mcp`, `/api/a2a`, `/api/llm-bridge` and `/chat` — four routes
// carrying LOCKED first-party-graph budgets (the route-graph ratchet). Pulling
// the review page's decision action and the gate's resume entry in statically
// put 38 modules onto each of those four routes for code that runs ONLY when a
// person's bound message actually presses a control. Deferring them to the call
// keeps all four budgets flat, which is the same reason
// `widget-lifecycle-frame-actor.ts` exists as its own leaf.
//
// The specifiers are LITERAL, so nothing about this is a variable-URL import,
// and the modules are the SAME ones the review page and the decide route call —
// nothing is re-implemented and nothing is relaxed. Both are injectable through
// `deps` so a test never pays the import at all.
type SubmitReviewDecisionAction = typeof import(
  "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/actions"
)["submitReviewDecisionAction"];
type ApproveReviewTaskInternal = typeof import(
  "@cinatra-ai/agents/review-task-actions"
)["approveReviewTaskInternal"];

async function loadSubmitReviewDecision(): Promise<SubmitReviewDecisionAction> {
  const mod = await import(
    "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/actions"
  );
  return mod.submitReviewDecisionAction;
}

async function loadApproveScreen(): Promise<ApproveReviewTaskInternal> {
  const mod = await import("@cinatra-ai/agents/review-task-actions");
  return mod.approveReviewTaskInternal;
}
import { LIFECYCLE_REF_MAX_LENGTH } from "@/lib/assistant-runtime/lifecycle-view-envelope";
import { resolveBoundTurnActor } from "@/lib/lifecycle/bound-turn-actor";
import type { ReviewFloorAction } from "@/lib/artifacts/review-surface-model";
import {
  controlsLentBy,
  resolveBoundReference,
} from "@/lib/lifecycle/bound-reference-resolver";
import {
  LENT_ACTION_CONTROLS,
  matchLentActionGrant,
  verifyLentActionGrant,
  type LentActionControl,
} from "@/lib/lifecycle/lent-action-grant";
import { consumeLentActionGrant } from "@/lib/lifecycle/lent-action-grant-store";

/** The primitive's name. Exported so the policy, the carve-out and the rule's
 *  own test all name the same string rather than three literals that can drift. */
export const LENT_ACTION_PRIMITIVE = "lifecycle_bound_card_decide";

/**
 * The refusal when this turn holds no authority to press that control.
 *
 * ONE SENTENCE FOR FOUR CASES — no grant, a grant that does not verify, a grant
 * for another card or another button, and a grant already spent. They are
 * deliberately indistinguishable: a caller learning WHICH would learn about an
 * authority they do not hold. It is about the CALLER'S OWN turn, so it discloses
 * nothing about any row.
 */
export const LENT_ACTION_NO_AUTHORITY =
  "This message is not allowed to operate that control. Nothing was done.";

/** The refusal when the card itself is not available to this person. Mirrors the
 *  pull primitives' one fixed sentence, and for the same reason. */
export const LENT_ACTION_CARD_UNAVAILABLE =
  "That card is not available to you. Nothing was done.";

type McpToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
};

function say(payload: Record<string, unknown>): McpToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function refuseNoAuthority(): McpToolResult {
  return say({ ok: false, message: LENT_ACTION_NO_AUTHORITY });
}

function refuseCardUnavailable(): McpToolResult {
  return say({ ok: false, message: LENT_ACTION_CARD_UNAVAILABLE });
}

const inputSchema = z
  .object({
    /** The bound card's opaque ref — the one the turn was told about. */
    ref: z.string().min(1).max(LIFECYCLE_REF_MAX_LENGTH),
    /** The ONE control to press. The grant names it too; both must agree. */
    control: z.enum(LENT_ACTION_CONTROLS),
  })
  .strict();

export const LENT_ACTION_TOOL_DESCRIPTION =
  "Press ONE control of the ONE lifecycle card this message is bound to, as the person who typed it, with their permissions. " +
  "Usable ONLY when this turn was given the matching single-use grant; without it the call does nothing and says so. " +
  "The control must be one your grant names AND one the card actually offers; a grant naming anything else is refused. " +
  "You do NOT supply the text: what lands on the card is the person's own message, held on the server with the grant. " +
  "It fires at most once per message. Report the answer that comes back and add nothing to it.";

/** The verified grant, as this module reads it off the request frame. */
type FrameGrant = { readonly grant: string; readonly userId: string; readonly orgId: string };

function readFrameGrant(): FrameGrant | null {
  const ctx = mcpRequestContextStorage.getStore();
  if (!ctx) return null;
  // NEVER a tool argument. The grant is transport state, put on the frame by the
  // boundary from the header the hosted reference carried.
  const grant = ctx.lentActionGrant;
  if (typeof grant !== "string" || grant.length === 0) return null;
  // The acting person is the FRAME's, never the grant's own claim: the grant is
  // matched against this identity, so a stolen grant presented on somebody
  // else's frame fails gate 3 rather than acting as its own subject.
  const userId = ctx.a2aActorContext?.userId ?? ctx.userId ?? null;
  const orgId = (ctx.a2aActorContext ? ctx.a2aActorContext.orgId : ctx.orgId) ?? null;
  if (!userId || !orgId) return null;
  return { grant, userId, orgId };
}

/**
 * The lent action.
 *
 * Every early return is one of the two fixed sentences. The only place a richer
 * message appears is the platform's OWN outcome, relayed verbatim once the
 * card's path has run.
 */
export async function handleLentAction(
  input: unknown,
  deps: {
    readonly resolve?: typeof resolveBoundReference;
    readonly consume?: typeof consumeLentActionGrant;
    readonly resolveActor?: typeof resolveBoundTurnActor;
    readonly submitReviewDecision?: SubmitReviewDecisionAction;
    readonly approveScreen?: ApproveReviewTaskInternal;
    readonly now?: () => Date;
  } = {},
): Promise<McpToolResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return refuseNoAuthority();

  // GATE 1 — a grant on the frame.
  const frame = readFrameGrant();
  if (!frame) return refuseNoAuthority();

  // GATE 2 — the grant verifies.
  const claims = verifyLentActionGrant(frame.grant, { now: deps.now });
  if (!claims) return refuseNoAuthority();

  // GATE 3 — the grant matches THIS call.
  const matches = matchLentActionGrant(claims, {
    userId: frame.userId,
    orgId: frame.orgId,
    cardRef: parsed.data.ref,
    control: parsed.data.control,
  });
  if (!matches) return refuseNoAuthority();

  // GATE 4 — the person's own credential, resolved live.
  const resolveActor = deps.resolveActor ?? resolveBoundTurnActor;
  const actorCtx = await resolveActor({ userId: frame.userId, orgId: frame.orgId });
  if (!actorCtx) return refuseCardUnavailable();

  // GATE 5 — the card is still there and still lends this control.
  const resolve = deps.resolve ?? resolveBoundReference;
  const bound = await resolve({ ref: parsed.data.ref, actorCtx });
  if (bound.kind === "absent") return refuseCardUnavailable();
  const lent = controlsLentBy(bound);
  if (!lent.includes(parsed.data.control)) return refuseCardUnavailable();

  // GATE 6 — spend the grant. Before the effect, atomically, once.
  //
  // THE SPEND IS ALSO WHERE THE PERSON'S WORDS COME FROM (convergence round 1,
  // finding 2). The row carries the message they typed, captured at mint time;
  // the model supplies no text at all, so "your words, word for word" is a
  // property of the mechanism rather than an instruction a prompt-injected model
  // could ignore. A row with no text lands an empty comment, never an invented
  // one.
  const consume = deps.consume ?? consumeLentActionGrant;
  const spend = await consume({
    jti: claims.jti,
    userId: frame.userId,
    orgId: frame.orgId,
    cardRefFingerprint: claims.cardRefFingerprint,
    control: parsed.data.control,
  });
  if (spend.outcome !== "consumed") return refuseNoAuthority();

  const text = spend.messageText;

  // THE CARD'S OWN PATH.
  if (bound.kind === "review") {
    const submit = deps.submitReviewDecision ?? (await loadSubmitReviewDecision());
    const action = reviewFloorAction(parsed.data.control);
    if (!action) return refuseCardUnavailable();
    const outcome = await submit(
      bound.runId,
      bound.reviewTaskId,
      action,
      text,
      // ONE actor context for the resolve above and the decision-op check
      // inside — the decision route's own rule, for the same reason.
      actorCtx,
      null,
    );
    return say({ ok: outcome.kind === "decided" || outcome.kind === "annotated" || outcome.kind === "changes-requested", outcome });
  }

  // The HITL screen's Continue. `approveReviewTaskInternal` is the gate's own
  // actor-checked resume entry — the door the plan says the submit side already
  // has — and it enforces run execute + approveHitl against the run it resolves
  // before any write. No values are passed: pressing Continue submits the form
  // as it stands, and FILLING the form by asking is the plan's separate road
  // (cinatra#2934).
  const approve = deps.approveScreen ?? (await loadApproveScreen());
  try {
    await approve(
      bound.screenRef,
      actorCtx.actor.userId ?? frame.userId,
      undefined,
      bound.form.fieldName,
      null,
      actorCtx.actor,
      actorCtx.roleHints,
    );
    return say({ ok: true, outcome: { kind: "submitted" } });
  } catch {
    // The gate's own refusal shape is not a message this surface may invent, and
    // the grant is already spent, so the honest answer is that nothing landed.
    return say({ ok: false, outcome: { kind: "error" }, message: LENT_ACTION_CARD_UNAVAILABLE });
  }
}

/**
 * The review card's three buttons, as the ONE decision entry names them
 * (cinatra#3080): Comment, Regenerate, Continue.
 *
 * The grant's control vocabulary and the floor are now the SAME three words, so
 * this is a narrowing rather than a translation — `submit` (the waiting screen's
 * button) is the only control a review can be handed that it does not draw, and
 * it is refused. The retired `approve` / `reject` cannot arrive here at all: the
 * grant vocabulary no longer contains them, and a person who TYPES either is
 * resolved (or answered) at the mint, in `typedControlFor`.
 */
function reviewFloorAction(control: LentActionControl): ReviewFloorAction | null {
  return control === "submit" ? null : control;
}

export function registerLentActionPrimitive(server: McpRuntimeToolServer): void {
  // REGISTERED UNDER ITS LITERAL NAME, not the constant above, and that is not
  // a style choice: `scripts/build-authz-inventory.mjs` machine-scans
  // `server.registerTool("…")` string arguments to build the authz inventory,
  // and the structural rule test (lifecycle-no-decide-primitives) reads THAT
  // inventory. A constant here would keep the one decision primitive in the
  // tree OUT of the machine-scanned record — the exact opposite of naming the
  // exception where it is enforced. The constant and this literal are pinned
  // equal by the rule test, which asserts the inventory contains it.
  server.registerTool(
    "lifecycle_bound_card_decide",
    {
      title: LENT_ACTION_PRIMITIVE,
      description: LENT_ACTION_TOOL_DESCRIPTION,
      inputSchema,
    },
    (async (input: unknown) => handleLentAction(input)) as never,
  );
}

export function createLentActionMcpModule() {
  return { registerCapabilities: registerLentActionPrimitive };
}
