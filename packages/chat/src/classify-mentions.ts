/**
 * Two-phase mention CLASSIFICATION (cinatra#1875 W2, Epic #1873 — AC#1, phase 2).
 *
 * Phase 1 (sync, lexical): `tokenizeMentions` splits the message into typed
 * scoped/flat tokens (`./mention-tokenizer`).
 *
 * Phase 2 (ONE async, actor+audience-scoped): each token is resolved against the
 * assistant REGISTRY, filtered to the acting user's audience. The ordering rule
 * is the load-bearing invariant of the wave:
 *
 *   REGISTRY LOOKUP FIRST. A token naming a REGISTERED, IN-AUDIENCE assistant is
 *   an ASSISTANT MENTION, ALWAYS — a scoped `@vendor/slug` that resolves to an
 *   installed assistant is an assistant mention, never an `agent_run` dispatch.
 *   ONLY when the registry lookup misses is a scoped token eligible to fall
 *   through to explicit `agent_run` dispatch. A flat token that misses the
 *   registry is unresolved (the routing layer's broadcast/no-op fall-through).
 *
 * This module is the single decision the routers and the runtime seam consult
 * BEFORE directive generation / hard dispatch, so a package-claimed assistant can
 * never be shadowed by the dispatch path (and vice-versa). It is PURE given an
 * injected resolver (built server-side from the W1 registry reader), so it is
 * unit-testable without a DB.
 */

import { tokenizeMentions, type MentionToken } from "./mention-tokenizer";

/**
 * The actor+audience-scoped registry resolver the classifier depends on. Both
 * lookups return ONLY assistants the acting user may SEE (the W1 registry reader
 * is already audience-filtered), so a forged out-of-audience mention resolves to
 * `null` and never classifies as an assistant mention. Server wiring builds this
 * from `readAssistantRegistryForActor`; tests inject a fake.
 */
export type AudienceScopedAssistantResolver = {
  /** A scoped `@vendor/slug` package ref → an in-audience assistant, or null. */
  byPackageRef(
    packageRef: string,
  ): Promise<{ assistantUserId: string; handle: string; packageName: string } | null>;
  /** A flat `@handle` (or alias) → an in-audience assistant, or null. Returns the
   *  assistant's CANONICAL handle (the primary `assistant_handles` handle, which
   *  may differ from an alias token the user typed) so downstream selection /
   *  attribution keys on the principal's canonical handle, not the alias. */
  byHandle(
    handle: string,
  ): Promise<{ assistantUserId: string; handle: string; packageName: string | null } | null>;
};

/** The classification of a single mention token. */
export type MentionClassification =
  | {
      /** A registered, in-audience assistant — dispatch to it, ALWAYS. */
      kind: "assistant";
      token: MentionToken;
      assistantUserId: string;
      handle: string;
      packageName: string | null;
    }
  | {
      /** A scoped ref that is NOT an assistant — eligible for `agent_run` dispatch. */
      kind: "agent-dispatch";
      token: MentionToken;
      packageRef: string;
    }
  | {
      /** A flat handle that resolved to no in-audience assistant — routing
       *  falls through (broadcast/no-op), exactly as the legacy empty-resolve did. */
      kind: "unresolved";
      token: MentionToken;
    };

/**
 * Classify ONE token against the audience-scoped registry. Registry lookup wins:
 * a scoped ref that IS an in-audience assistant is `assistant`; otherwise it is
 * an `agent-dispatch` CANDIDATE. A flat handle that is an in-audience assistant
 * is `assistant`; otherwise `unresolved`.
 *
 * NOTE (audience isolation): `byPackageRef`/`byHandle` are audience-FILTERED, so
 * a scoped ref that is an assistant the caller cannot see resolves to `null` and
 * falls to `agent-dispatch` — exactly as the spec says ("only otherwise eligible
 * for agent_run explicit dispatch"). This is NOT an audience bypass: `agent-dispatch`
 * is a CANDIDATE, and the downstream `agent_run` path applies its own
 * audience/authz; moreover assistant templates are excluded from agent_run/A2A
 * publication (AC#7), so an assistant package is not agent_run-dispatchable at all
 * — a forged out-of-audience `@vendor/assistant` reaches neither the assistant
 * mention path nor a live agent dispatch.
 */
async function classifyToken(
  token: MentionToken,
  resolver: AudienceScopedAssistantResolver,
): Promise<MentionClassification> {
  if (token.kind === "scoped") {
    const packageRef = token.packageRef ?? token.raw.slice(1); // `@vendor/slug` → `vendor/slug` fallback
    const hit = await resolver.byPackageRef(token.packageRef ?? packageRef);
    if (hit) {
      return {
        kind: "assistant",
        token,
        assistantUserId: hit.assistantUserId,
        handle: hit.handle,
        packageName: hit.packageName,
      };
    }
    // Registry miss ⇒ eligible for explicit agent_run dispatch.
    return { kind: "agent-dispatch", token, packageRef: token.packageRef ?? packageRef };
  }
  // Flat token.
  const hit = await resolver.byHandle(token.handle);
  if (hit) {
    return {
      kind: "assistant",
      token,
      assistantUserId: hit.assistantUserId,
      // The CANONICAL handle from the registry (an alias token resolves to its
      // principal's primary handle) — so the unified endpoint selector and
      // attribution never key on a non-canonical alias.
      handle: hit.handle,
      packageName: hit.packageName,
    };
  }
  return { kind: "unresolved", token };
}

/**
 * Two-phase classify: lex (phase 1) then ONE audience-scoped async resolution
 * pass (phase 2, run in parallel across tokens). Result preserves source order.
 */
export async function classifyMentions(
  content: string,
  resolver: AudienceScopedAssistantResolver,
): Promise<MentionClassification[]> {
  const tokens = tokenizeMentions(content);
  if (tokens.length === 0) return [];
  return Promise.all(tokens.map((t) => classifyToken(t, resolver)));
}

/** The assistant mentions from a classification (the ones that DISPATCH). */
export function assistantMentions(
  classified: readonly MentionClassification[],
): Extract<MentionClassification, { kind: "assistant" }>[] {
  return classified.filter(
    (c): c is Extract<MentionClassification, { kind: "assistant" }> => c.kind === "assistant",
  );
}

/** The scoped refs eligible for `agent_run` explicit dispatch (registry misses). */
export function agentDispatchRefs(
  classified: readonly MentionClassification[],
): string[] {
  return classified
    .filter(
      (c): c is Extract<MentionClassification, { kind: "agent-dispatch" }> =>
        c.kind === "agent-dispatch",
    )
    .map((c) => c.packageRef);
}
