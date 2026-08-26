import "server-only";

// THE ONE ROAD FOR A PROMPT WINDOW OUTSIDE THE CHAT (cinatra#2933, lifecycle-b W5b).
//
// The plan: "Outside the chat, the prompt window's exchange is stored with the
// run: it is there after a reload, readable beside the run, and answered by the
// conversation's assistant — fixtures on the run page, the step-by-step screen,
// the schedule screen, the armed-trigger tab and the review page." And: "Every
// window takes the run's access: a run owner who is not a platform administrator
// types and is answered; a person without respond access never sees the box."
//
// ONE ROAD, NOT A SECOND ONE. The turn is answered by `runAssistantTurn` — the
// same runtime the chat page and the site widget use — and a bound card rides
// the SAME `boundCard` claim W5a added to that runtime's arguments. This module
// mints no grant, resolves no reference and decides nothing: it hands the claim
// over and lets the runtime re-check it under the reader's own access, so no
// second decision path exists to disagree with the first.
//
// THE ACCESS RULE IS THE RUN'S. `enforceRunAccess(run, actor, "respondToHitl")`
// — the same right that decides who may answer the run's HITL screen — replaces
// the platform-administrator check the windows applied before. The windows used
// to disagree with themselves: three of them showed the box to everyone and
// refused anyone who was not a platform administrator, and the schedule screen
// hid the box from non-administrators. Both are repaired by asking the run.
//
// WRITTEN SERVER-SIDE, PER TURN. The person's message is appended BEFORE the
// model runs and the answer is appended after, each as its own row through the
// append-only store. The browser never sends a transcript, so the late-commit
// race of the client save chain (cinatra#2909) has no door here.

import {
  enforceRunAccess,
  resolveEffectivePolicy,
} from "@cinatra-ai/agents/auth-policy";
import {
  readAgentRunById,
  readAgentTemplateById,
  readRunCoOwners,
} from "@cinatra-ai/agents/store";
import {
  appendRunWindowMessage,
  readRunWindowMessages,
  type RunWindowMessage,
  type RunWindowSurface,
} from "@cinatra-ai/agents/run-window-conversation-store";
import { actorFromSession, type ActorRoleHints } from "@/lib/authz/build-actor-context";
import { getAuthSession, resolveUserContextForUserId } from "@/lib/auth-session";
// The person's LIVE standing — membership, org role, teams, project grants,
// platform tier — through W5a's own leaf rather than a second assembly. A
// window is typed in by people who hold their access through a TEAM or a
// PROJECT grant as often as by an owner, and hand-built hints would deny them.
import { resolveBoundTurnActor } from "./bound-turn-actor";

// THE ASSISTANT RUNTIME IS REACHED LAZILY, and that is load-bearing rather
// than a style choice. `canRespondInRunWindow` below is called by the SERVER
// COMPONENTS that draw the five screens, and a static import would pull the
// whole chat runtime — every tool surface, every dispatch table — into the
// module graph of every screen that only wants to know whether to draw a box.
// The runtime is imported at the one point that actually runs a turn.
async function loadAssistantRuntime() {
  const [{ runAssistantTurn }, { buildCinatraAssistantRuntimeConfig }] =
    await Promise.all([
      import("@/lib/assistant-runtime/runtime"),
      import("@/lib/assistant-runtime/cinatra-assistant-config"),
    ]);
  return { runAssistantTurn, buildCinatraAssistantRuntimeConfig };
}

// THE RUN FRAME IS REACHED THE SAME WAY, and for the same reason (cinatra#3016).
// Its two gate reads are the run's own — the paused HITL gate and the run's
// trigger — and neither belongs in the module graph of a screen that called
// `canRespondInRunWindow` only to decide whether to draw a box.
async function loadRunWindowFrame() {
  return import("./run-window-frame");
}

/**
 * The platform's OWN sentence when the conversation's model cannot operate
 * anything. The plan: "A conversation whose model cannot operate anything lends
 * nothing … The assistant says so plainly the moment it is asked to act, the
 * on-screen buttons keep working, and the window never pretends that typing will
 * do it — never a silent no-op."
 *
 * It is the PLATFORM's sentence, not the model's, for the same reason a refusal
 * is relayed rather than re-written: a model that cannot use tools also cannot
 * be relied on to say so. It is prepended to whatever the turn produced, so the
 * window never shows only an answer that implies an action was taken.
 */
export const RUN_WINDOW_TOOL_LESS_NOTICE =
  "This conversation's model cannot operate anything on this run — it can " +
  "answer, but it cannot fill a form, comment, or take a decision. Use the " +
  "buttons on this screen for that.";

/** The one answer this module gives to a caller it will not serve. */
export class RunWindowAccessDenied extends Error {
  constructor() {
    super("Run access denied.");
    this.name = "RunWindowAccessDenied";
  }
}

export type RunWindowTurnInput = {
  runId: string;
  surface: RunWindowSurface;
  prompt: string;
  /**
   * The card this window sits under, as a CLAIM (W5a's shape): the refs the
   * screen had on it and the one the reader picked, if any. Re-resolved by the
   * runtime under the reader's own access — this module passes it through and
   * concludes nothing from it.
   */
  boundCard?: { candidateRefs: string[]; focusedRef: string | null };
};

export type RunWindowTurnResult = {
  entries: RunWindowMessage[];
  /** True when the turn ran on a model that could not use tools. */
  toolLess: boolean;
};

/** The longest message a window accepts, matched to the chat composer's own bound. */
export const RUN_WINDOW_PROMPT_MAX = 4000;

/**
 * How many card references a window may offer with one message, and how long
 * each may be. The claim is BROWSER-SUPPLIED — a server action's payload is not
 * type-checked by anything — and the runtime re-resolves every ref under the
 * reader's own access, so an over-long list costs work rather than authority.
 * These bounds keep that cost from being the browser's to choose. A page has at
 * most a handful of cards on screen; a ref is an opaque server-minted token.
 */
const BOUND_CARD_MAX_REFS = 8;
const BOUND_CARD_REF_MAX_LENGTH = 512;

/** The claim, kept only where every part of it is within the bounds above. */
function boundedClaim(
  claim: RunWindowTurnInput["boundCard"],
): RunWindowTurnInput["boundCard"] | undefined {
  if (!claim) return undefined;
  const ok = (ref: unknown) =>
    typeof ref === "string" && ref.length > 0 && ref.length <= BOUND_CARD_REF_MAX_LENGTH;
  const refs = Array.isArray(claim.candidateRefs)
    ? claim.candidateRefs.filter(ok).slice(0, BOUND_CARD_MAX_REFS)
    : [];
  const focused = ok(claim.focusedRef) ? (claim.focusedRef as string) : null;
  // A focused ref the page did not also offer as a candidate is not a binding
  // the page can have seen; it is dropped rather than repaired.
  if (refs.length === 0) return undefined;
  return { candidateRefs: refs, focusedRef: refs.includes(focused ?? "") ? focused : null };
}

/** The rows the access check read, handed back rather than read a second time. */
type RunWindowAccess = {
  actor: ResolvedWindowActor;
  run: Awaited<ReturnType<typeof readAgentRunById>>;
  template: Awaited<ReturnType<typeof readAgentTemplateById>>;
};

type ResolvedWindowActor = {
  actor: ReturnType<typeof actorFromSession>;
  roleHints: ActorRoleHints;
  userId: string;
  orgId: string | null;
  platformRole: NonNullable<ActorRoleHints["platformRole"]>;
};

/**
 * Resolve the caller and enforce the RUN's access for `op`. Every entry point in
 * this module goes through it, so no window can be served on a looser rule than
 * another.
 */
async function requireRunWindowAccess(
  runId: string,
  op: "respondToHitl" | "read",
  /**
   * When the caller reaches the run through a template-scoped route, the run
   * MUST be that template's. Without this the two identifiers are independent:
   * a person could authorize with a run they may answer and operate on someone
   * else's template.
   */
  expectTemplateId?: string,
): Promise<RunWindowAccess> {
  const session = await getAuthSession();
  if (!session?.user?.id) throw new RunWindowAccessDenied();

  const orgId =
    (session.session as { activeOrganizationId?: string | null } | undefined)
      ?.activeOrganizationId ?? null;
  // The ACTOR is the cookie session's — this is a person typing in a browser,
  // and the provenance says so. The STANDING is resolved live by W5a's leaf, so
  // there is exactly one definition of what a person may do on a run.
  const actor = actorFromSession(session);
  const bound = await resolveBoundTurnActor({ userId: session.user.id, orgId });
  if (!bound) throw new RunWindowAccessDenied();
  const roleHints = bound.roleHints as ActorRoleHints;
  const platformRole = (roleHints.platformRole ??
    "member") as ResolvedWindowActor["platformRole"];

  const run = await readAgentRunById(runId).catch(() => null);
  if (!run) throw new RunWindowAccessDenied();
  if (expectTemplateId && run.templateId !== expectTemplateId) {
    throw new RunWindowAccessDenied();
  }
  const template = await readAgentTemplateById(run.templateId).catch(() => null);
  const coOwnerUserIds = (await readRunCoOwners(run.id).catch(() => [])).map(
    (r) => r.userId,
  );
  // The CONCRETE effective policy, exactly as the run's own actions resolve it:
  // a bare `?? null` would leave `enforceRunAccess` to skip the policy gate.
  const runForCheck = {
    ...run,
    effectivePolicy: resolveEffectivePolicy(run, template),
    coOwnerUserIds,
  };
  try {
    await enforceRunAccess(runForCheck, actor, op, roleHints);
  } catch {
    throw new RunWindowAccessDenied();
  }
  return {
    actor: {
      actor,
      roleHints,
      userId: session.user.id,
      orgId,
      platformRole,
    },
    // THE ROWS THIS CHECK CLEARED (cinatra#3016), so the frame below is built
    // from the very run the access answer was about — not from a second read
    // that could name a different one.
    run,
    template,
  };
}

/**
 * May this person type in this run's window? The windows ask this to decide
 * whether to SHOW the box at all — the plan's "no window shown to a person whose
 * message it would refuse".
 */
export async function canRespondInRunWindow(
  runId: string,
  /** Pin the run to the template a template-scoped caller named, when there is one. */
  expectTemplateId?: string,
): Promise<boolean> {
  try {
    await requireRunWindowAccess(runId, "respondToHitl", expectTemplateId);
    return true;
  } catch {
    return false;
  }
}

/**
 * The run's window conversation, for the first paint after a reload. Read access
 * is the run's `read`: a person who may see the run may read the exchange beside
 * it, which is what "readable beside the run" means.
 */
export async function readRunWindowConversation(
  runId: string,
): Promise<RunWindowMessage[]> {
  await requireRunWindowAccess(runId, "read");
  return readRunWindowMessages(runId);
}

/**
 * ONE turn of a prompt window outside the chat: access, the person's message,
 * the assistant's answer, both stored with the run.
 */
export async function runWindowTurn(
  input: RunWindowTurnInput,
): Promise<RunWindowTurnResult> {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("An empty message is not a turn.");
  if (prompt.length > RUN_WINDOW_PROMPT_MAX) {
    throw new Error("That message is too long for this window.");
  }

  const { actor, run, template } = await requireRunWindowAccess(
    input.runId,
    "respondToHitl",
  );
  const claim = boundedClaim(input.boundCard);

  // The person's message is committed BEFORE the model runs. A turn that dies
  // in the model still leaves what the person typed on the run.
  const userRow = await appendRunWindowMessage({
    runId: input.runId,
    role: "user",
    surface: input.surface,
    text: prompt,
  });

  // The history is read AFTER that row lands, and cut at it. Two turns sent at
  // once are serialized by the table, not by the caller, so "everything before
  // MY message" is the only prefix that is the same on every read — taking the
  // history first would hand two racing turns the same one and let the second
  // answer as though the first had not been said.
  const history = (await readRunWindowMessages(input.runId)).filter(
    (m) => m.sequence < userRow.sequence,
  );

  const userCtx = await resolveUserContextForUserId(actor.userId, {
    activeOrganizationId: actor.orgId,
    platformRole: actor.platformRole,
  });

  // THE RUN THIS WINDOW SITS UNDER, assembled for the assistant (cinatra#3016).
  //
  // The plan: the window is "the person's conversation with the assistant about
  // the run it sits under". Until this frame existed, four of the five windows
  // handed the model the typed words and nothing else, so the assistant asked
  // back for "the workflow/run ID" from inside a screen that is already mounted
  // under exactly one run. The frame is READ STATE — it is what a person can
  // already see above the box — and it lends nothing: no tool, no grant, no
  // control (W5c owns acting).
  //
  // FAIL-SOFT. A frame that cannot be built costs the answer its context, never
  // the answer: the turn runs without it, exactly as it did before.
  let runFrame = "";
  try {
    const { buildRunWindowFrame, renderRunWindowFrame } = await loadRunWindowFrame();
    runFrame = renderRunWindowFrame(
      await buildRunWindowFrame({
        run: run as never,
        template: template as never,
        surface: input.surface,
      }),
    );
  } catch (err) {
    console.error(
      `[run-window] the run frame for run ${input.runId} could not be built`,
      err,
    );
  }

  let text = "";
  let toolLess = false;
  let runtimeError: string | null = null;
  try {
    const { runAssistantTurn, buildCinatraAssistantRuntimeConfig } =
      await loadAssistantRuntime();
    await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), {
      messages: [
        ...history.map((m) => ({ role: m.role, content: m.text })),
        { role: "user" as const, content: prompt },
      ],
      actorContext: userCtx.actorContext,
      userId: actor.userId,
      platformRole: userCtx.platformRole,
      sessionOrgId: userCtx.sessionOrgId,
      turnIdentity: {
        turnId: `run-window:${input.runId}:${Date.now()}`,
        runId: `run-window:${input.runId}`,
      },
      // W5a's claim, bounded and then passed through. The runtime re-resolves
      // it under this person's access and mints the single-use grant, or does
      // not; nothing here concludes anything from it.
      ...(claim ? { boundCard: claim } : {}),
      // The run the window sits under (cinatra#3016). Read state only — the
      // runtime composes it into the turn's system context and grants nothing
      // for it.
      ...(runFrame ? { runFrame } : {}),
      send: (event, data) => {
        const d = (data ?? {}) as Record<string, unknown>;
        if (event === "text") {
          if (typeof d.content === "string") text += d.content;
        } else if (event === "turn_capability") {
          if (d.conversationOnly === true) toolLess = true;
        } else if (event === "error") {
          if (typeof d.message === "string" && d.message) runtimeError = d.message;
        }
      },
    });
  } catch {
    // The raw fault stays server-side; the window shows the platform's own line.
    runtimeError = runtimeError ?? "the assistant turn failed";
  }

  const answer = composeWindowAnswer({ text, toolLess, runtimeError });
  try {
    await appendRunWindowMessage({
      runId: input.runId,
      role: "assistant",
      surface: input.surface,
      text: answer,
      // Recorded, never inferred from adjacency: with two turns in flight the
      // rows can land interleaved, and an answer must say which message it
      // answered.
      replyToSequence: userRow.sequence,
    });
  } catch (err) {
    // The answer exists and the person is owed it. A store that refused the row
    // must not also swallow the reply — the turn returns it, unstored, and the
    // fault is left where an operator can see it.
    console.error(
      `[run-window] the answer for run ${input.runId} could not be stored`,
      err,
    );
    return {
      entries: [
        ...(await readRunWindowMessages(input.runId)),
        {
          id: `unstored:${userRow.id}`,
          runId: input.runId,
          sequence: userRow.sequence + 0.5,
          role: "assistant" as const,
          surface: input.surface,
          text: answer,
          replyToSequence: userRow.sequence,
          createdAt: new Date(),
        },
      ],
      toolLess,
    };
  }

  return { entries: await readRunWindowMessages(input.runId), toolLess };
}

/**
 * What the window shows for one turn. PURE, so the three cases are pinned by a
 * test rather than by reading a model's mind.
 */
export function composeWindowAnswer(args: {
  text: string;
  toolLess: boolean;
  runtimeError: string | null;
}): string {
  const body = args.text.trim();
  if (args.toolLess) {
    // The notice comes FIRST and is never replaced by the model's words: the
    // person asked for something to happen and must be told plainly that typing
    // will not do it here.
    return body ? `${RUN_WINDOW_TOOL_LESS_NOTICE}\n\n${body}` : RUN_WINDOW_TOOL_LESS_NOTICE;
  }
  if (body) return body;
  if (args.runtimeError) {
    return "The assistant could not answer just now — please try again.";
  }
  return "The assistant had nothing to add.";
}
