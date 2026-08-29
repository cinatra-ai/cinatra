// ---------------------------------------------------------------------------
// THE FILL, AS ONE SELF-MCP PRIMITIVE (cinatra#2934, lifecycle-b W5c).
//
// The plan's fill road (see `bound-screen-fill.ts` for the sentences it is built
// to) reaches the assistant the only way anything about the lifecycle reaches
// it: one more primitive on the platform's own tool server. It is NOT the lent
// action. It presses nothing, decides nothing and consumes no grant — the name
// carries no deciding verb because there is no decision here to carry one.
//
// WHAT IT DOES: places values in the fields of the screen THIS MESSAGE was bound
// to, and records them with the run so the screen can write them into its own
// fields and the person can press the button themselves.
//
// WHY IT STILL READS THE TURN'S GRANT. The grant is the only server-checked
// fact that says "the person sent this message with that screen bound". Reading
// it — without spending it, and without matching its control — is what keeps a
// model reached by text out of the run's own content from placing values in a
// screen nobody bound. Not spending it is what lets one message fill AND, when
// the person asks in so many words, submit: the plan requires both in the same
// message, and a consumed grant would make the second impossible.
//
// IT MUST STILL BE UNSPENT, THOUGH (convergence round 1, finding 6). A model
// that pressed first and filled afterwards would otherwise record values the
// press never sent, against a screen the run has already moved past — the
// durable row a screen ref resolves through outlives the moment it names. So the
// ledger is CLAIMED — atomically, and without spending anything — at the last
// moment before the row is written (convergence round 2): a no-op write under
// the spend's own predicate, which takes the row's lock, so a concurrent press
// either commits first and this matches nothing, or waits.
// ---------------------------------------------------------------------------

import "server-only";

import { z } from "zod";
import type { McpRuntimeToolServer } from "@cinatra-ai/mcp-server";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";
import { LIFECYCLE_REF_MAX_LENGTH } from "@/lib/assistant-runtime/lifecycle-view-envelope";
import { resolveBoundTurnActor } from "@/lib/lifecycle/bound-turn-actor";
import {
  matchLentActionGrantCard,
  verifyLentActionGrant,
} from "@/lib/lifecycle/lent-action-grant";
import { lentActionGrantIsSpendable } from "@/lib/lifecycle/lent-action-grant-store";
import { recordBoundScreenFill } from "@/lib/lifecycle/bound-screen-fill";

/** The primitive's name. Exported so the policy and the carve-out name one string. */
export const BOUND_SCREEN_FILL_PRIMITIVE = "lifecycle_bound_screen_fill";

/**
 * The refusal when this message is not allowed to fill that screen.
 *
 * ONE SENTENCE FOR EVERY CASE — no grant, a grant that does not verify, a grant
 * for another card, a card that is not a screen, a screen this person may not
 * see. They are deliberately indistinguishable, for the same reason the lent
 * action's are: a caller learning WHICH would learn about a card they cannot see.
 */
export const BOUND_SCREEN_FILL_UNAVAILABLE =
  "There is no form bound to this message that you can fill. Nothing was changed.";

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

function refuse(): McpToolResult {
  return say({ ok: false, message: BOUND_SCREEN_FILL_UNAVAILABLE });
}

const inputSchema = z
  .object({
    /** The bound screen's opaque ref — the one the turn was told about. */
    ref: z.string().min(1).max(LIFECYCLE_REF_MAX_LENGTH),
    /**
     * The values to place, keyed by the form's own field names. Only fields the
     * form declares survive; anything else is dropped at the boundary.
     */
    values: z.record(z.string(), z.unknown()),
  })
  .strict();

export const BOUND_SCREEN_FILL_TOOL_DESCRIPTION =
  "Fill the fields of the ONE agent screen this message is bound to, with the values the person asked for. " +
  "This SUBMITS NOTHING and RESUMES NOTHING: the values appear in the fields in front of the person and they press the screen's own button. " +
  "Only fields the form declares are placed; anything else is dropped. " +
  "Use it whenever the person describes what the form should say. " +
  "If they ALSO ask in so many words for it to be submitted, fill first and then press the screen's own control with the lent-action tool. " +
  "Report what was placed and add nothing to it.";

/** The verified frame, as this module reads it. */
type FrameGrant = { readonly grant: string; readonly userId: string; readonly orgId: string };

function readFrameGrant(): FrameGrant | null {
  const ctx = mcpRequestContextStorage.getStore();
  if (!ctx) return null;
  // NEVER a tool argument: an argument is something a model can invent.
  const grant = ctx.lentActionGrant;
  if (typeof grant !== "string" || grant.length === 0) return null;
  const userId = ctx.a2aActorContext?.userId ?? ctx.userId ?? null;
  const orgId = (ctx.a2aActorContext ? ctx.a2aActorContext.orgId : ctx.orgId) ?? null;
  if (!userId || !orgId) return null;
  return { grant, userId, orgId };
}

export async function handleBoundScreenFill(
  input: unknown,
  deps: {
    readonly resolveActor?: typeof resolveBoundTurnActor;
    readonly record?: typeof recordBoundScreenFill;
    readonly isSpendable?: typeof lentActionGrantIsSpendable;
    readonly now?: () => Date;
  } = {},
): Promise<McpToolResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return refuse();

  // GATE 1 — this message was sent with a card bound, and it is THIS card.
  // Verified and matched; NEVER spent, and never matched on its control.
  const frame = readFrameGrant();
  if (!frame) return refuse();
  const claims = verifyLentActionGrant(frame.grant, { now: deps.now });
  if (!claims) return refuse();
  if (
    !matchLentActionGrantCard(claims, {
      userId: frame.userId,
      orgId: frame.orgId,
      cardRef: parsed.data.ref,
    })
  ) {
    return refuse();
  }

  // GATE 2 — the person's own credential, resolved live.
  const resolveActor = deps.resolveActor ?? resolveBoundTurnActor;
  const actorCtx = await resolveActor({ userId: frame.userId, orgId: frame.orgId });
  if (!actorCtx) return refuse();

  // GATES 3-5 — the card, the closed field set, the record. All in the core.
  const record = deps.record ?? recordBoundScreenFill;
  const outcome = await record({
    ref: parsed.data.ref,
    values: parsed.data.values,
    actorCtx,
    // THE GRANT'S OWN MESSAGE. It is what ties this fill to the turn that placed
    // it, so a submit sends this person's values and no one else's.
    messageId: claims.messageId,
    // GATE 5 — the grant is STILL UNSPENT, asked ATOMICALLY at the last moment
    // before the row is written. Never spent: filling presses nothing, but a
    // grant that has already pressed something is finished.
    claimGrant: async () =>
      (deps.isSpendable ?? lentActionGrantIsSpendable)({
        jti: claims.jti,
        userId: frame.userId,
        orgId: frame.orgId,
        cardRefFingerprint: claims.cardRefFingerprint,
      }),
  });
  if (outcome.kind === "unavailable") return refuse();
  if (outcome.kind === "not-editable") {
    // NOT a refusal either, and for the same reason `no-fields` is not: every
    // gate passed and the person is looking at this form. The platform's own
    // sentence is relayed word for word (cinatra#2996), so what they read is why
    // their schedule did not move — not a line that could mean anything.
    return say({ ok: false, placed: [], message: outcome.message });
  }
  if (outcome.kind === "no-fields") {
    // NOT a refusal: the screen is there and the person may fill it — nothing
    // asked for was one of its fields. Saying which fields it HAS is what lets
    // the assistant "ask you about what it cannot work out, in the conversation".
    //
    // ADDRESSED TO THE PERSON, like every message on this road. The platform's
    // own outcome is relayed into the window word for word (cinatra#2996), so a
    // sentence written to the model — "ask the person…" — is a sentence the
    // person reads about themselves in the third person. It is written to them.
    return say({
      ok: false,
      placed: [],
      fields: outcome.fields,
      message:
        "None of those are fields on this screen. Its own fields are listed here — tell me which of them you want set.",
    });
  }
  return say({
    ok: true,
    placed: outcome.applied,
    message:
      "Placed in the fields on your screen. Nothing was submitted — press the button when you are ready.",
  });
}

export function registerBoundScreenFillPrimitive(server: McpRuntimeToolServer): void {
  // REGISTERED UNDER ITS LITERAL NAME, not the constant above: the authz
  // inventory is built by machine-scanning `server.registerTool("…")` string
  // arguments, and a constant here would keep this primitive out of that record.
  // The constant and this literal are pinned equal by the rule test.
  server.registerTool(
    "lifecycle_bound_screen_fill",
    {
      title: BOUND_SCREEN_FILL_PRIMITIVE,
      description: BOUND_SCREEN_FILL_TOOL_DESCRIPTION,
      inputSchema,
    },
    (async (input: unknown) => handleBoundScreenFill(input)) as never,
  );
}

export function createBoundScreenFillMcpModule() {
  return { registerCapabilities: registerBoundScreenFillPrimitive };
}
