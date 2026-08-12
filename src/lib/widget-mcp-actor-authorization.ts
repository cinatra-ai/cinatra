import "server-only";

import {
  verifyWidgetMcpActorToken,
  type WidgetMcpActor,
} from "@/lib/widget-mcp-actor-token";
import { readWidgetTokenParentLiveness } from "@/lib/widget-session-binding";
import { readAssistantTurnActivityByRunId } from "@/lib/assistant-thread-store";

// ---------------------------------------------------------------------------
// THE WIDGET OBO TOKEN'S AUTHORIZATION LAYER (cinatra#2687).
//
// WHAT WAS WRONG. `widget-mcp-actor-token.ts` called itself turn-bound and was
// not. It required a `jti` and returned it, and nothing anywhere compared that
// `jti` to anything — the module's own comment deferred "the transport records
// it against the active thread/turn" to a wave that never came. So the token
// authorized for the whole of its 120 seconds: after the turn it was minted for
// had finished, and after the person had signed out. It never reaches the
// browser (it is handed to the hosted MCP provider/relay, server-side), so the
// exposure was internal and bounded — but a token that says "this turn only"
// must mean it.
//
// WHAT THIS MODULE IS. The one place the widget OBO token is turned into an
// authorized actor. It runs the signature/claims verification first and then
// asks the two questions the signature cannot answer, because both are about
// state that changed AFTER the token was signed:
//
//   1. IS THE SIGN-IN STILL THERE — `readWidgetTokenParentLiveness(pjti)`, the
//      shared predicate from #2684. The same function the token verifier, the
//      capture probe and the chat resume route ask, so "the parent is dead" has
//      one definition and this path cannot hold a laxer copy of it.
//   2. IS THE TURN STILL RUNNING — `readAssistantTurnActivityByRunId(run)`,
//      against the `assistant_turns` row whose status the run's terminal COMMIT
//      writes (after the terminal frame is published, not at it — see the store
//      predicate's own note). This is the binding the `jti` only claimed to be.
//
// BOTH REFUSE ON ANYTHING BUT A POSITIVE ANSWER. `unknown` — a database that
// could not be reached, a table that is not there — refuses exactly like `dead`
// and `ended`: a store that cannot answer does not get to authorize. Refusing
// returns `null`, which is what a bad signature returns, so the caller's
// existing fall-through is unchanged: no widget actor is resolved, the request
// falls to the machine token, and the machine token is denied at the boundary.
//
// WHY NOT IN THE TOKEN MODULE. `widget-mcp-actor-token.ts` is a pure signing
// leaf — crypto and claim shapes, no database edge — and PR #2685 kept the
// resume token the same way, with its parent-liveness read in the route that
// verifies it. Keeping the seal's PARSING in the leaf and its CHECKING here
// keeps the token module unit-testable with no store at all, and gives this
// layer a store seam that a test can drive to a completed turn or a signed-out
// session without a database.
//
// WHY NOT INLINE AT THE TRANSPORT. `src/lib/mcp-server.ts` is a settings object
// assembled from most of the application; nothing can import it in a test. A
// check that only exists inside it is a check whose negative control cannot be
// written, and this issue's acceptance is specifically that removing the turn
// binding makes a test fail again. For the same reason the transport-shaped
// result — seals spent, `connectorInstancePin` normalized — is built HERE too
// (`resolveWidgetDelegatedActorForTransport`, codex round 1): the transport's
// widget branch is then one delegating line, so what the tests drive is the
// production expression rather than a re-implementation of it.
//
// ORDERING is deliberate: signature and claims first (cheap, no I/O, and it is
// what proves the `pjti`/`run` values are ours to trust), then the parent
// session, then the turn. A forged token never reaches the database.
//
// WHAT IS BOUND, EXACTLY (codex round 0, LOW 2 — stated because "turn-bound"
// invited the last overclaim). This decides ADMISSION: it runs when the bearer
// arrives at the MCP transport, before the request body is parsed. A call
// admitted while the turn was running completes even if the turn ends while it
// is in flight — the same revocation-at-next-use shape #2684 shipped, and the
// same one the issue's own wording describes. Sequential calls after the turn
// ends are refused.
//
// AND ITS ONE DEGRADED CASE (codex round 0, MEDIUM 2). The turn's terminal
// status is a database write. If the process dies or the store is unreachable
// between the provider finishing and that write, the row is left `running` and
// this predicate keeps saying `active`. The window that opens is bounded by the
// TOKEN's own remaining life — at most 120 seconds from its mint, which happens
// once per turn and is never refreshed — so a stale row degrades to EXACTLY the
// pre-#2687 bound and never past it, and the parent check is unaffected, so a
// signed-out user is still refused. A fence on the turn row's age would be
// STRICTER than this (a turn can sit at `running` far longer than a token
// lives), but it is not needed for the bound above and is not what this slice
// buys, so it is not here. Recorded rather than fixed.
// ---------------------------------------------------------------------------

/**
 * Verify a widget OBO token AND confirm it still authorizes: its parent sign-in
 * is live and the turn it was minted for is still running.
 *
 * Returns the resolved actor, or `null` on ANY failure — a bad signature, a
 * missing seal, a dead or unreadable parent session, a completed turn. There is
 * no partial answer and no reason code: the caller's only correct response to
 * every one of them is the same.
 */
export function verifyLiveWidgetMcpActor(input: {
  authHeader: string | null;
  request: Request;
  expectedAudience: string;
  expectedIssuer: string;
}): WidgetMcpActor | null {
  const actor = verifyWidgetMcpActorToken(input);
  if (!actor) return null;
  // #2684 — the sign-in behind the credential. Refuses on `unknown` as well as
  // `dead`; only the leaf that owns this predicate ever reaps a row.
  if (readWidgetTokenParentLiveness(actor.parentJti) !== "live") return null;
  // #2687 — the turn seal. Everything above this line was true of the token the
  // moment it was signed; this is the only check that can tell a live turn from
  // one that finished thirty seconds ago.
  if (readAssistantTurnActivityByRunId(actor.turnRunId) !== "active") return null;
  return actor;
}

/**
 * The actor the MCP TRANSPORT gets — the whole widget branch of
 * `verifyDelegatedActorToken`, so that seam is one delegating line and this
 * expression is what the tests drive (codex round 1).
 *
 * Two things happen on top of the authorization above:
 *
 *   · the widget token's native `inst`/`knd` are normalized into the unified
 *     `connectorInstancePin` shape (cinatra#2017 S2 / B1) — a widget turn is
 *     ALWAYS instance-pinned, so the governed invoker reads ONE field whatever
 *     the token type;
 *   · the two seals are DROPPED. They are verification inputs, not capabilities:
 *     they were spent deciding whether this call may proceed, the frame carries
 *     the identity and the pin, and putting them on it would only invite a
 *     downstream reader to treat a name as an authorization.
 */
export function resolveWidgetDelegatedActorForTransport(input: {
  authHeader: string | null;
  request: Request;
  expectedAudience: string;
  expectedIssuer: string;
}): (Omit<WidgetMcpActor, "parentJti" | "turnRunId"> & {
  connectorInstancePin: { connectorKey: string; instanceId: string };
}) | null {
  const widgetActor = verifyLiveWidgetMcpActor(input);
  if (!widgetActor) return null;
  const { parentJti: _parentJti, turnRunId: _turnRunId, ...transportActor } = widgetActor;
  return {
    ...transportActor,
    connectorInstancePin: {
      connectorKey: transportActor.kind,
      instanceId: transportActor.instanceId,
    },
  };
}
