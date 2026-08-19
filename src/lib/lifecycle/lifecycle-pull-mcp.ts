import "server-only";

// ---------------------------------------------------------------------------
// The CONVERSATIONAL PULL — read-only lifecycle primitives (cinatra#2567,
// epic #2564 S3). Design: design@6c20871b4108176c1d0193f19ecd2947f6c6355f
// `specs/app-lifecycle-cards.html` at that commit (§IV states, §VII
// verification, §IX presence).
//
// S1 (#2565) built the wire: a reserved envelope on a tool result becomes a
// `DATA_PART` carrying an opaque ref, accepted ONLY from the (cinatra self-MCP,
// allowlisted tool) tuple, and the card resolves its authoritative state
// server-side from that ref. Nothing minted, because the minting tools are
// these three. This module is the PULL side and nothing else:
//
//   artifact_review_gates_list   — the refs of the open review gates the caller
//                                  may READ. Refs, never rows.
//   artifact_review_gate_render  — mint ONE `artifact_review_gate` card for a ref.
//   verification_record_render   — mint ONE `verification_summary` card for a ref.
//
// THE NAMES ARE THE CONTRACT. All three are already in S1's
// `LIFECYCLE_PRODUCER_TOOLS` allowlist verbatim; renaming one here without
// moving that allowlist in the same commit stops cards minting SILENTLY (the
// recognizer just returns null and the turn carries prose). They are pinned by
// a test in this slice for exactly that reason.
//
// EVERYTHING HERE IS READ-ONLY, AND STRUCTURALLY SO. There is no decide, no
// resume, no comment, no schedule: the LLM may SHOW a lifecycle interaction and
// may never resolve one. The absence is enforced by the delegated tool policies
// (deny-by-default allowlist + the decision-verb backstop) and pinned by
// `__tests__/lifecycle-no-decide-primitives.test.ts` across BOTH delegated
// perimeters.
//
// THREE PROPERTIES CARRY THE SLICE:
//
//   1. REFS, NEVER CONTENT. A successful result is either a bare list of opaque
//      refs or the S1 envelope — no gate id, no run id, no title, no artifact.
//      Tool results persist in `assistant_turns.content` and are re-fed to the
//      model, so anything richer would put an unauthorized projection of a gate
//      into a durable, LLM-visible transcript.
//
//   2. IDENTIFIER-FREE REFUSAL. Every denial that could depend on a ROW —
//      a ref that does not decode, a gate the caller may not read, one that
//      never existed, a store that threw, a caller with no principal or org —
//      returns the ONE fixed `LIFECYCLE_REFUSAL_RESULT` sentence and mints no
//      DATA_PART. Those are indistinguishable by construction, so the surface
//      cannot be used to probe what exists.
//
//      The honest boundary: two refusals happen BEFORE a handler runs and do
//      not look like that sentence — the MCP SDK rejecting arguments that do
//      not match the declared input schema, and the tool-boundary guard
//      rejecting a caller who is not a member of the org. Neither reads any
//      lifecycle row: the first describes the CALLER'S OWN arguments and the
//      second the CALLER'S OWN standing, so neither can distinguish a gate that
//      exists from one that does not. The handlers still refuse both cases
//      identically if they are ever reached, so the transport is defence in
//      depth here rather than the contract.
//
//   3. RUN ACCESS BEFORE GATE EXISTENCE. Both render primitives authorize
//      through `resolveLifecycleCardState` — the S1 ladder — rather than
//      re-deriving one: run READ first, then the gate's own state, then the
//      decision axis. Reversing the first two would leak gate existence to
//      anyone holding a ref. The LIST is the one place that ordering cannot
//      hold — a listing has to find candidate rows before it can authorize
//      them — so it guarantees the reachable property instead: authorization
//      before DISCLOSURE, with the candidate query returning ids only and no
//      gate content at all.
//
// THE HANDLERS ARE COMMON, AND S8d (cinatra#2577) TOOK THEM AT THEIR WORD. The
// widget policy now reaches these same three primitives — the same code, the
// same ladder, the same one refusal sentence. Exactly ONE thing is branched, in
// `resolveLifecycleCaller`: WHERE the reading principal comes from. A chat frame
// carries its own identity and the transport's role hints; a widget frame
// carries a signed grant and is resolved through S8a's actor module, which
// resolves the reader's live standing instead of assuming a floor. Everything
// downstream of the principal — which rows exist, which the reader may see, what
// a denial looks like — is untouched and shared, which is the point: the widget
// reader is the same person under the same checks, never a wider one.
// ---------------------------------------------------------------------------

import { z } from "zod";
import type { McpRuntimeToolServer } from "@cinatra-ai/mcp-server";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
// The NARROW candidate listing: one indexed, LIMITed select for (runId,
// reviewTaskId) pairs and nothing else. Deliberately NOT the `/agents/reviews`
// volume reader, which scans up to two thousand gates, joins every linked
// produced event and computes rollups to answer the admin console's question.
// A model can call this primitive repeatedly, so its cost has to be
// proportional to what it returns. Same table, same org predicate, same
// oldest-first order — so the pull and the page still agree about which gates
// are waiting longest.
import { listOpenReviewGateCandidates } from "@cinatra-ai/agents/lifecycle-policy-store";
import { enforceReviewRunAccess } from "@cinatra-ai/agents/artifact-review-gate-store";

// The producer's own constants, NOT the protocol registry's. Deliberate, and
// for S1's stated reason: `@cinatra-ai/agent-ui-protocol/renderable-views`
// resolves the full zod schema registry, and this module is reachable from
// every route that touches auth (the app's auth plugins mount the MCP server),
// each of which carries a locked first-party-graph budget. `LIFECYCLE_REF_MAX_LENGTH`
// is the producer-side mirror of `LIFECYCLE_VIEW_REF_MAX_LENGTH`, pinned equal
// by S1's drift test — so the bound this input schema enforces is the wire's.
import {
  LIFECYCLE_REFUSAL_RESULT,
  LIFECYCLE_REF_MAX_LENGTH,
  buildLifecycleViewEnvelope,
  type LifecycleViewType,
} from "@/lib/assistant-runtime/lifecycle-view-envelope";
import {
  encodeLifecycleGateRef,
  resolveLifecycleCardState,
} from "@/lib/lifecycle/lifecycle-card-refetch";
// The S8a widget actor's LIVE-STANDING LEAF — the one place a widget lifecycle
// reader's standing is resolved, shared with the refetch endpoint's token door
// (cinatra#2577). The LEAF rather than the door on purpose: the door consumes a
// `cwu_`, which this path never holds, and importing it would pull the widget
// token store onto four route-locked first-party graphs for code a widget frame
// never runs.
import { resolveWidgetLifecycleActorForFrame } from "@/lib/lifecycle/widget-lifecycle-frame-actor";
import type { ActorRoleHints } from "@/lib/authz/build-actor-context";
// Type-only (erased at build): the reviewing-principal shape every lifecycle
// port already threads. Importing the TYPE keeps this module off the review
// route's module graph.
import type { ReviewActorContext } from "@/app/artifacts/[id]/review-gate-ports";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * How many refs one pull may return. Small on purpose: this is the BACKLOG
 * HEAD a person can act on in a conversation, not an export. `/agents/reviews`
 * remains the place to see the whole queue.
 */
const LIST_LIMIT_DEFAULT = 5;
const LIST_LIMIT_MAX = 10;

/**
 * How many of the org's oldest open gates are read and ACCESS-CHECKED to fill
 * that page. Bounds BOTH the SQL limit and the per-row access work, because
 * each check reads a run.
 *
 * So the pull is honestly "the oldest readable gates within the org's oldest
 * 25", not a complete enumeration of everything the caller could reach — a
 * caller who needs the whole queue has a page for it. The same 25 the reviews
 * page lists, for the same reason.
 */
const LIST_SCAN_WINDOW = 25;

// ---------------------------------------------------------------------------
// Results — the two shapes this surface can ever produce
// ---------------------------------------------------------------------------

type McpToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
};

/**
 * The ONE refusal. Fixed sentence, no ids, no counts, no reason — see the
 * generic-refusal contract in `lifecycle-view-envelope.ts`. Not an envelope, so
 * the sink mints no DATA_PART for it.
 */
function refusal(): McpToolResult {
  return {
    content: [{ type: "text", text: LIFECYCLE_REFUSAL_RESULT }],
    structuredContent: { result: LIFECYCLE_REFUSAL_RESULT },
  };
}

/**
 * A plain (non-minting) result. The text is what the provider hands back as
 * `mcp_call.output`, i.e. what the sink and the model both see.
 */
function plain(payload: Record<string, unknown>): McpToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

/**
 * A card-minting result: the tool-result TEXT is EXACTLY the S1 envelope, byte
 * for byte, because that string is what `recognizeLifecycleViewEnvelope` parses
 * on the way through the sink. `structuredContent` mirrors it for MCP clients
 * that read the structured channel; it is never the minting path.
 *
 * Returns the refusal when the envelope cannot be built inside its bounds — a
 * producer that cannot express its ref must refuse rather than emit something
 * the sink would (correctly) drop, which would otherwise read to the user as a
 * silent nothing.
 */
function minted(viewType: LifecycleViewType, ref: string): McpToolResult {
  const envelope = buildLifecycleViewEnvelope({ viewType, ref });
  if (!envelope) return refusal();
  return {
    content: [{ type: "text", text: envelope }],
    structuredContent: JSON.parse(envelope) as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// The caller
// ---------------------------------------------------------------------------

/**
 * Resolve the reviewing principal from the MCP request CONTEXT — never from
 * tool input. Mirrors the house pattern (`src/lib/artifacts/mcp.ts`
 * `resolveScope`), including A2A precedence: when an A2A identity is present
 * its org MUST come from the A2A context, so an A2A identity is never mixed
 * with the transport's org scope.
 *
 * Returns `null` (→ refusal) rather than throwing when there is no attributable
 * principal or no active org. A throw would surface as an MCP error, which is a
 * different observable from a refusal and therefore an oracle.
 *
 * ROLE HINTS ARE THE TRANSPORT'S, NOT THE SESSION'S. An MCP frame carries
 * `platformRole` and `orgRole`; it carries no team/project grants (only an A2A
 * frame does). That is strictly NARROWER than the review page's session-derived
 * hints, so a gate reachable only through a team or project grant is simply not
 * pulled here. Fail-closed by construction — run access additionally derives the
 * caller's org role from the run's org when the caller declared the same active
 * org, so ordinary org-role access is unaffected.
 */
async function resolveLifecycleCaller(): Promise<ReviewActorContext | null> {
  const ctx = mcpRequestContextStorage.getStore();
  if (!ctx) return null;
  // THE WIDGET BRANCH (cinatra#2577, epic #2564 S8d). A `public_site_widget`
  // delegation is resolved somewhere else entirely, and deliberately: the hints
  // this function assembles below are the TRANSPORT's (org role and platform
  // role, no teams, no projects), which is fail-closed-narrow for a chat frame
  // and simply WRONG for a widget one — a reader entitled to a review through a
  // team or a project would be shown nothing and would reasonably conclude it
  // does not exist. So the widget frame goes through the S8a actor module, which
  // resolves those axes live, and this function never sees it.
  if (ctx.delegatedActor?.delegation === "public_site_widget") {
    return resolveWidgetLifecycleCaller(ctx.delegatedActor);
  }
  const a2a = ctx.a2aActorContext;
  const userId = a2a?.userId ?? ctx.userId ?? null;
  const orgId = (a2a ? a2a.orgId : ctx.orgId) ?? null;
  // A lifecycle read is always ON BEHALF OF a person: without an attributable
  // user there is no one to authorize the gate for.
  if (!userId || !orgId) return null;
  const platformRole = ctx.platformRole;
  const actor = {
    actorType: a2a ? "a2a" : platformRole ? "human" : "model",
    source: a2a ? "a2a" : "agent",
    userId,
    ...(a2a?.tokenScopes ? { tokenScopes: a2a.tokenScopes } : {}),
  } as PrimitiveActorContext;
  const roleHints: ActorRoleHints = {
    ...(platformRole ? { platformRole } : {}),
    // Transport-resolved org role — NON-A2A ONLY: it was resolved for the
    // transport identity, and the A2A branch's identity may be another user.
    ...(!a2a && ctx.orgRole ? { orgRole: ctx.orgRole } : {}),
    ...(a2a?.teamIds ? { teamIds: a2a.teamIds } : {}),
    ...(a2a?.projectGrants ? { projectGrants: a2a.projectGrants } : {}),
    actorOrganizationId: orgId,
  };
  return { actor, orgId, roleHints };
}

/**
 * The reviewing principal for a PUBLIC-SITE WIDGET frame (cinatra#2577, epic
 * #2564 S8d).
 *
 * TWO GATES, IN THIS ORDER, BOTH FAIL-CLOSED:
 *
 *   1. THE GRANT. The frame must carry `lifecycleRead` — the signed `lcr` claim
 *      the route minted onto the widget OBO token from the `cwu_` it consumed.
 *      A widget session that signed in before the grant existed carries none, so
 *      it gets `null` here and the caller answers the ONE fixed refusal: no
 *      DATA_PART, no ids, nothing that distinguishes "you may not" from "there
 *      is nothing". The tool stays VISIBLE to that turn — the policy is a
 *      surface, not a consent record — and calling it simply achieves nothing.
 *
 *   2. THE LIVE STANDING. Resolved by the S8a module, in the org the TOKEN is
 *      bound to: membership now, org role now, teams and project grants now,
 *      with platform standing floored. A membership revoked after the turn
 *      started does not serve one more row.
 *
 * What this function does NOT do is decide which rows the reader may see. That
 * is unchanged and shared: `enforceReviewRunAccess` on the listing,
 * `resolveLifecycleCardState`'s ladder on each render. The widget reader is the
 * SAME person against the SAME checks as in the app — never a wider one.
 */
async function resolveWidgetLifecycleCaller(actor: {
  userId: string;
  orgId: string;
  kind: string;
  lifecycleRead?: boolean;
}): Promise<ReviewActorContext | null> {
  if (actor.lifecycleRead !== true) return null;
  const resolved = await resolveWidgetLifecycleActorForFrame({
    userId: actor.userId,
    orgId: actor.orgId,
    kind: actor.kind,
  });
  return resolved.ok ? resolved.actorCtx : null;
}

// ---------------------------------------------------------------------------
// The primitives
// ---------------------------------------------------------------------------

const listSchema = z
  .object({
    limit: z.number().int().min(1).max(LIST_LIMIT_MAX).optional(),
  })
  .strict();

const refSchema = z
  .object({
    ref: z.string().min(1).max(LIFECYCLE_REF_MAX_LENGTH),
  })
  .strict();

const TOOL_META = {
  artifact_review_gates_list: {
    description:
      "List the artifact review gates currently waiting that the caller may read, as OPAQUE refs (oldest first, at most a handful). Returns refs only — no ids, titles or artifact content — because the card behind each ref resolves its own state server-side. Pass each ref to `artifact_review_gate_render` to show it in the conversation. Read-only: this cannot approve, reject, comment on or otherwise change a review.",
    inputSchema: listSchema,
  },
  artifact_review_gate_render: {
    description:
      "Show ONE artifact review gate in the conversation as its lifecycle card, given an opaque ref from `artifact_review_gates_list`. The card fetches the authoritative state itself and re-checks access on every render, so the result carries nothing about the gate. Read-only: rendering a review never decides it. Answers a fixed 'not available to you' when the caller may not read it.",
    inputSchema: refSchema,
  },
  verification_record_render: {
    description:
      "Show the verification reading for ONE reviewed artifact in the conversation as its lifecycle card, given an opaque ref from `artifact_review_gates_list`. Advisory only — the card asks nothing and offers no decision. Answers a fixed 'not available to you' when the caller may not read it or there is no reading yet.",
    inputSchema: refSchema,
  },
} as const;

/**
 * The refs of the open review gates this caller may READ.
 *
 * Candidates come from the narrow org-scoped listing (ids only, never gate
 * content); every one is then checked with `enforceReviewRunAccess(…, "read")`
 * — the same gate the reviews page applies for the same reason: run EXISTENCE
 * is protected, so filtering only at the deep link would already have disclosed
 * it. A row whose check throws is dropped, never disclosed.
 *
 * ORDERING, HONESTLY. The render ladder decides run READ before it touches a
 * gate, because there the caller supplies the ref and the ordering is
 * observable. A LISTING cannot: it has to find candidate rows before it can
 * authorize them. What it guarantees instead is that authorization happens
 * before DISCLOSURE — an unauthorized row contributes no ref, and the same
 * empty answer covers "nothing open" and "nothing you may see".
 *
 * An empty result is NOT a refusal: "nothing is waiting for you" is a true,
 * non-enumerating answer about the caller's own queue. A caller with no
 * principal or no org gets the refusal instead — and so does a caller any of
 * whose readable rows could not be expressed as a ref (a missing signing key,
 * ids too long for the wire bound), because reporting a short list as if it
 * were the whole queue is a comfortable lie about work that is genuinely
 * waiting.
 */
async function handleReviewGatesList(input: unknown): Promise<McpToolResult> {
  const parsed = listSchema.safeParse(input ?? {});
  if (!parsed.success) return refusal();
  const limit = parsed.data.limit ?? LIST_LIMIT_DEFAULT;

  const caller = await resolveLifecycleCaller();
  if (!caller) return refusal();

  try {
    const rows = await listOpenReviewGateCandidates({
      orgId: caller.orgId,
      limit: LIST_SCAN_WINDOW,
    });
    const verdicts = await Promise.all(
      rows.map(async (row) => {
        try {
          const access = await enforceReviewRunAccess(
            row.runId,
            caller.actor,
            "read",
            caller.roleHints,
          );
          return access.ok;
        } catch {
          return false;
        }
      }),
    );
    const readable = rows.filter((_row, i) => verdicts[i]).slice(0, limit);
    const refs = readable
      .map((row) =>
        encodeLifecycleGateRef({ runId: row.runId, reviewTaskId: row.reviewTaskId }),
      )
      .filter((ref): ref is string => typeof ref === "string");
    // Fail CLOSED on ANY minting failure rather than reporting a queue that is
    // quietly short. A silently dropped row is worse than a refusal: the caller
    // reads "that is everything" and stops looking, so a partial answer here
    // would hide work that is genuinely waiting just as effectively as a false
    // empty one.
    if (refs.length !== readable.length) return refusal();
    return plain({ refs });
  } catch {
    // A store/transport failure must not become an existence signal either.
    return refusal();
  }
}

/**
 * Mint one lifecycle card for a ref, or refuse.
 *
 * The authorization is `resolveLifecycleCardState` — the S1 ladder, called
 * rather than re-implemented, so the ordering (run READ → gate state → decision
 * axis) has exactly one definition. `absent` is the ladder's collapse of every
 * denial, so it maps to the refusal here; anything else is a state the caller
 * is entitled to see drawn.
 */
async function renderLifecycleCard(
  viewType: LifecycleViewType,
  input: unknown,
): Promise<McpToolResult> {
  const parsed = refSchema.safeParse(input);
  if (!parsed.success) return refusal();
  const caller = await resolveLifecycleCaller();
  if (!caller) return refusal();
  const resolved = await resolveLifecycleCardState({
    // The two render primitives address a gate-scoped row; the trigger proposal
    // viewType has no producer until S5 (#2569) owns its token and store.
    viewType,
    ref: parsed.data.ref,
    actorCtx: caller,
  });
  // The ladder answers a per-kind envelope now; the AUTHORIZATION is still its
  // state, and the body it carries is for a card to draw, never for this
  // primitive to mint. What travels to the model is what always travelled: a
  // viewType and the ref the caller already held.
  if (resolved.state.state === "absent") return refusal();
  return minted(viewType, parsed.data.ref);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerLifecyclePullPrimitives(server: McpRuntimeToolServer): void {
  server.registerTool(
    "artifact_review_gates_list",
    {
      title: "artifact_review_gates_list",
      ...TOOL_META.artifact_review_gates_list,
    },
    (async (input: unknown) => handleReviewGatesList(input)) as never,
  );
  server.registerTool(
    "artifact_review_gate_render",
    {
      title: "artifact_review_gate_render",
      ...TOOL_META.artifact_review_gate_render,
    },
    (async (input: unknown) =>
      renderLifecycleCard("artifact_review_gate", input)) as never,
  );
  server.registerTool(
    "verification_record_render",
    {
      title: "verification_record_render",
      ...TOOL_META.verification_record_render,
    },
    (async (input: unknown) =>
      renderLifecycleCard("verification_summary", input)) as never,
  );
}

export function createLifecyclePullMcpModule() {
  return { registerCapabilities: registerLifecyclePullPrimitives };
}
