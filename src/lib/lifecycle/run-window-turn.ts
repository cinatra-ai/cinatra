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
  type RunWindowFill,
} from "@cinatra-ai/agents/run-window-conversation-store";
import {
  actorFromSession,
  buildActorContextFromPrimitive,
  type ActorRoleHints,
} from "@/lib/authz/build-actor-context";
import { getAuthSession, resolveUserContextForUserId } from "@/lib/auth-session";
// The person's LIVE standing — membership, org role, teams, project grants,
// platform tier — through W5a's own leaf rather than a second assembly. A
// window is typed in by people who hold their access through a TEAM or a
// PROJECT grant as often as by an owner, and hand-built hints would deny them.
import { resolveBoundTurnActor } from "./bound-turn-actor";
import { encodeScheduleFormRef, encodeScheduleRunRef } from "./lifecycle-card-ref";

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

/**
 * The lent action's tool name, SPELLED here rather than imported, and that is a
 * measurement rather than a style choice: `canRespondInRunWindow` below is
 * called by the SERVER COMPONENTS that draw five screens, and importing
 * `lent-action-mcp.ts` for one string would pull the MCP server's whole module
 * graph onto each of them. A test pins this literal equal to
 * `LENT_ACTION_PRIMITIVE`, so the two cannot drift.
 */
const LENT_ACTION_TOOL_NAME = "lifecycle_bound_card_decide";

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
  /**
   * The files attached beside this message (cinatra#2934, lifecycle-b W5c).
   *
   * Opaque refs the upload route minted. They are recorded with the person's own
   * row so they reach the waiting agent whether the person presses the screen's
   * button themselves or asks the assistant to press it — the plan's "the new
   * road must not swallow it into an ordinary chat message, and must not leave
   * it behind when the answer is finally sent".
   */
  attachments?: readonly Record<string, unknown>[];
};

/**
 * The fills ONE turn placed, selected by that turn's own identity
 * (cinatra#2934, convergence round 1, finding 1).
 *
 * PURE, and the whole of the rule. Every row a turn writes carries its
 * `messageId` — the person's message, the fills the assistant placed, the files
 * that travelled with it — so which fills are THIS turn's is a fact about the
 * rows, not an arithmetic about how many the run held before.
 *
 * WHY IT IS NOT A COUNT. The window applies "only a fill this turn placed", and
 * that used to be decided by comparing counts across a turn. A count is only as
 * good as its starting point, and the client's was wrong in four ways at once:
 * it began at zero on every mount, the load never seeded it (measured — a
 * reloaded screen's first turn re-applied an earlier message's values into three
 * fields it had not touched), a turn sent before the load returned would have
 * out-run any seeding, a load that failed soft reports nothing to seed from, and
 * a second tab filling in between moves the count under both. Naming the turn
 * answers all of them and needs no ordering at all.
 */
export function fillsPlacedByMessage(
  rows: readonly RunWindowMessage[],
  messageId: string,
): RunWindowFill[] {
  const out: RunWindowFill[] = [];
  for (const row of rows) {
    if (row.fill && row.messageId === messageId) out.push(row.fill);
  }
  return out;
}

export type RunWindowTurnResult = {
  entries: RunWindowMessage[];
  /**
   * The fills THIS turn placed, oldest first — never another message's, and
   * never the run's whole history. See {@link fillsPlacedByMessage}.
   */
  fills: RunWindowFill[];
  /** True when the turn ran on a model that could not use tools. */
  toolLess: boolean;
  /**
   * True when the turn actually PRESSED a control of the bound card — the lent
   * action ran and the platform's own path reported success.
   *
   * The plan: "After the action fires, the card re-reads its state from the
   * server and settles in place." A window that learns this re-reads its screen;
   * one that does not is an ordinary answer and moves nothing.
   */
  acted: boolean;
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

/**
 * WHICH CARD THE WINDOW'S OWN SURFACE IS SITTING UNDER (cinatra#2934, repaired
 * after the picture leg).
 *
 * THE DEFECT THIS REPAIRS, measured on the real screen: for a run waiting on its
 * trigger, the schedule screen's window bound the run's HITL GATE row — the
 * setup step's schema — while the surface in front of the person is the
 * SCHEDULER FORM, whose rows are not in that schema at all. The assistant
 * answered "This screen can't schedule the run. It only has these fields: title
 * / summary / outline", and nothing was filled.
 *
 * THE THREE READINGS, and each is the plan's own:
 *
 *   · the REVIEW page keeps its own claim — its card carries a ref on the client
 *     and the run behind it is parked at the review, not at a fillable screen;
 *   · the SCHEDULE screen binds the SCHEDULER FORM, whose ref this mints from
 *     the run the box sits under, server-side, exactly as a parked screen's is
 *     minted; it lends a fill and no press at all;
 *   · the ARMED-TRIGGER tab — and the run page's schedule STEP, which mounts the
 *     same window — binds the ARMED scheduler form, addressed by the RUN-SCOPED
 *     schedule ref its own card is already drawn from, so the box and the form
 *     it is about name one thing. It lends a fill AND the card's own Save
 *     changes, which is the second half of the plan's sentence
 *     (cinatra#2934, the armed-trigger tab — this pull request's Deviation 1,
 *     closed);
 *   · every other window sits under the run's own waiting screen and names the
 *     RUN, so the binder mints that screen's ref.
 *
 * PURE and exported so the reading is one readable line under test rather than a
 * condition buried in a turn.
 */
export function boundScreenClaimForSurface(
  surface: RunWindowSurface,
  runId: string,
  mintScheduleFormRef: (runId: string) => string | null = (id) =>
    encodeScheduleFormRef({ runId: id }),
  mintArmedScheduleRef: (runId: string) => string | null = (id) =>
    encodeScheduleRunRef({ runId: id }),
): { readonly screenRunIds: readonly string[]; readonly candidateRefs: readonly string[] } {
  if (surface === "review") return { screenRunIds: [], candidateRefs: [] };
  if (surface === "schedule") {
    const ref = mintScheduleFormRef(runId);
    return { screenRunIds: [], candidateRefs: ref ? [ref] : [] };
  }
  if (surface === "armed-trigger") {
    const ref = mintArmedScheduleRef(runId);
    return { screenRunIds: [], candidateRefs: ref ? [ref] : [] };
  }
  return { screenRunIds: [runId], candidateRefs: [] };
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
 * May THIS ACTOR answer this run's screen?
 *
 * The same rule `requireRunWindowAccess` applies, for a caller that already
 * holds the person's resolved standing rather than a cookie session — the fill
 * road, which runs on the tool server under the person's own live credential
 * (cinatra#2934, convergence round 1, finding 3). Reading a run and OPERATING
 * one are two different permissions: the bound-reference resolver authorizes a
 * screen on run READ, which is right for reading it and is NOT enough to place
 * values on it.
 *
 * Fail-CLOSED: any failure answers `false`.
 */
export async function canActorRespondToRun(
  runId: string,
  actor: Parameters<typeof enforceRunAccess>[1],
  roleHints: ActorRoleHints,
): Promise<boolean> {
  try {
    const run = await readAgentRunById(runId);
    if (!run) return false;
    const template = await readAgentTemplateById(run.templateId).catch(() => null);
    const coOwnerUserIds = (await readRunCoOwners(run.id).catch(() => [])).map(
      (r) => r.userId,
    );
    await enforceRunAccess(
      {
        ...run,
        effectivePolicy: resolveEffectivePolicy(run, template),
        coOwnerUserIds,
      },
      actor,
      "respondToHitl",
      roleHints,
    );
    return true;
  } catch {
    return false;
  }
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
  // ONE IDENTITY FOR THE TURN, minted before anything is written. The runtime
  // mints the lent-action grant against `turnIdentity.turnId`, so naming it here
  // is what lets the person's own row, the fills this turn places and the press
  // it may ask for all be the SAME message.
  const messageId = `run-window:${input.runId}:${Date.now()}:${Math.random()
    .toString(36)
    .slice(2, 10)}`;
  // THE WINDOW IS THE SCREEN'S (cinatra#2934, lifecycle-b W5c). The windows
  // outside the chat sit directly under the surface the person is looking at,
  // and that surface has no ref on any client — one is minted at gate emission
  // only for the marked review gate. So the page claims nothing here: the turn
  // names the RUN, and the server mints the surface's own ref and re-checks it
  // under this person's access, exactly as it re-checks a page's claim. Which
  // surface gets which is `boundScreenClaimForSurface` above.
  const surfaceBinding = boundScreenClaimForSurface(input.surface, input.runId);
  const screenRunIds = surfaceBinding.screenRunIds;
  const candidateRefs = [
    ...(claim?.candidateRefs ?? []),
    ...surfaceBinding.candidateRefs,
  ];

  // The person's message is committed BEFORE the model runs. A turn that dies
  // in the model still leaves what the person typed on the run.
  const userRow = await appendRunWindowMessage({
    runId: input.runId,
    role: "user",
    surface: input.surface,
    text: prompt,
    ...(input.attachments && input.attachments.length > 0
      ? { attachments: input.attachments }
      : {}),
    // THE TURN'S OWN IDENTITY, and it is the same string the grant is minted
    // against below — so the submit can read back THIS message's files rather
    // than whatever the run's newest ones happen to be (convergence round 1,
    // finding 5).
    messageId,
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
  //
  // WHAT IT CARRIES SINCE THE PICTURES: the run's OPEN ARTIFACT REVIEW GATES
  // too. The review page's window used to answer "Waiting on Nothing" with a
  // review gate pending on the run, because the frame was composed from the
  // paused HITL gate and the schedule alone and a review gate is neither.
  let runFrame = "";
  try {
    const { buildRunWindowFrame, renderRunWindowFrame } = await loadRunWindowFrame();
    runFrame = renderRunWindowFrame(
      await buildRunWindowFrame({
        run: run as never,
        template: template as never,
        surface: input.surface,
        // THE READER, so the frame's own reads happen as this person and not as
        // the platform. The gate list is the run's, behind the run door this
        // module just opened; a reviewed target is an artifact and carries its
        // own door, which this actor is what opens.
        viewer: {
          orgId: actor.orgId,
          actor: buildActorContextFromPrimitive(
            actor.actor,
            actor.orgId,
            actor.roleHints,
          ),
        },
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
  let acted = false;
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
        turnId: messageId,
        runId: `run-window:${input.runId}`,
      },
      // W5a's claim, bounded and then passed through. The runtime re-resolves
      // it under this person's access and mints the single-use grant, or does
      // not; nothing here concludes anything from it.
      ...(candidateRefs.length > 0 || screenRunIds.length > 0
        ? {
            boundCard: {
              candidateRefs,
              focusedRef: claim?.focusedRef ?? null,
              ...(screenRunIds.length > 0 ? { screenRunIds } : {}),
            },
          }
        : {}),
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
        } else if (event === "tool_result") {
          // DID THE CARD MOVE? Read off the turn's own relayed result rather
          // than inferred from the assistant's sentence — "where your sentence
          // and the card disagree, the card is right", so the sentence is not
          // the evidence. Only the lent ACTION counts: a fill presses nothing.
          if (d.name === LENT_ACTION_TOOL_NAME && didPress(d.result)) acted = true;
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
      messageId,
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
    const unstoredEntries = [
        ...(await readRunWindowMessages(input.runId)),
        {
          id: `unstored:${userRow.id}`,
          runId: input.runId,
          sequence: userRow.sequence + 0.5,
          role: "assistant" as const,
          surface: input.surface,
          text: answer,
          replyToSequence: userRow.sequence,
          fill: null,
          attachments: null,
          savedPlacement: null,
          messageId,
          placedBy: null,
          createdAt: new Date(),
        },
      ];
    return {
      acted,
      entries: unstoredEntries,
      fills: fillsPlacedByMessage(unstoredEntries, messageId),
      toolLess,
    };
  }

  const entries = await readRunWindowMessages(input.runId);
  return {
    entries,
    toolLess,
    acted,
    fills: fillsPlacedByMessage(entries, messageId),
  };
}

/**
 * Did the lent action's relayed result say a control was actually pressed?
 *
 * PURE and DEFENSIVE: the result reaches this module as the transport's own text
 * and may be truncated, absent or something else entirely. Anything that is not
 * an unambiguous `"ok":true` is read as "nothing moved" — a window that wrongly
 * believed the card had settled would re-read a screen that had not changed,
 * and a window that wrongly believed it had not is simply one reload behind.
 */
export function didPress(result: unknown): boolean {
  if (typeof result !== "string" || result.length === 0) return false;
  try {
    const parsed: unknown = JSON.parse(result);
    return (parsed as { ok?: unknown } | null)?.ok === true;
  } catch {
    return false;
  }
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
