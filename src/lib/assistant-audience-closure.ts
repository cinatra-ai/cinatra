import "server-only";

// Assistant AUDIENCE CLOSURE for the MCP entry/continuation paths (cinatra#1875
// W2, Epic #1873 — AC#6).
//
// W1 landed the registry reader as the audience gate for the BROWSER surfaces.
// This module extends the SAME decision to the MCP surfaces the reader does not
// pass through — `assistant_send` (the structured assistant-MCP entry), and, on
// whatever survives #1037's legacy-MCP teardown, `chat_thread_send` and the
// `chat_mentions_poll` reply continuation. The rule: a caller may only address an
// assistant they are IN THE AUDIENCE of. A forged out-of-audience mention/target
// resolves to "not visible" and 404-hides, exactly like the browser reader.
//
// It reuses the W1 primitives verbatim — `resolveAssistantAudienceContext` builds
// the caller's audience footprint, `readAssistantRegistryForActor` returns the
// audience-FILTERED visible set (installed assistants whose audience the caller
// satisfies, plus the always-visible builtin) — so there is ONE audience truth,
// not a second re-implementation. Membership in the visible set IS visibility.
//
// REVOCATION SEMANTICS (AC#6): the check is evaluated ACTOR-SIDE at turn/mention
// CREATION. Because every new turn re-runs it, a shrunk audience denies the NEXT
// turn while any already-queued delivery (a turn already driving) completes — the
// gate never reaches back into in-flight work.

import {
  resolveAssistantAudienceContext,
  readAssistantRegistryForActor,
  type AssistantAudienceContext,
  type AssistantRegistryEntry,
} from "@/lib/assistant-registry-reader";

/** The verified caller identity the MCP surfaces resolve fail-closed. */
export type AudienceCaller = {
  userId: string;
  orgId: string;
  platformRole: "platform_admin" | "member";
};

/** Injectable seams (default to the W1 reader primitives; tests supply fakes). */
export type AudienceClosureDeps = {
  resolveContext(caller: AudienceCaller): Promise<AssistantAudienceContext>;
  readVisibleRegistry(ctx: AssistantAudienceContext): Promise<AssistantRegistryEntry[]>;
};

export const DEFAULT_AUDIENCE_CLOSURE_DEPS: AudienceClosureDeps = {
  resolveContext: (caller) =>
    resolveAssistantAudienceContext({
      userId: caller.userId,
      activeOrgId: caller.orgId,
      isPlatformAdmin: caller.platformRole === "platform_admin",
    }),
  readVisibleRegistry: (ctx) => readAssistantRegistryForActor(ctx),
};

/**
 * Is the target assistant principal WITHIN the caller's audience? True iff the
 * principal is in the audience-filtered visible registry for the caller (which
 * already unions the always-visible builtin and applies the four membership
 * seams). A principal the caller cannot see returns false → the caller 404-hides
 * it. Resolving the context/registry ONCE per turn is the actor-side evaluation
 * the revocation contract requires.
 */
export async function isAssistantInCallerAudience(
  assistantUserId: string,
  caller: AudienceCaller,
  deps: AudienceClosureDeps = DEFAULT_AUDIENCE_CLOSURE_DEPS,
): Promise<boolean> {
  if (!assistantUserId) return false;
  const ctx = await deps.resolveContext(caller);
  const visible = await deps.readVisibleRegistry(ctx);
  return visible.some((e) => e.assistantUserId === assistantUserId);
}

/**
 * Partition a set of target principals into the ones the caller may address and
 * the ones that are out-of-audience. Used by the broadcast/mention continuation
 * paths (chat_thread_send / poll) so an out-of-audience mention is dropped from
 * dispatch rather than delivered. ONE registry read for the whole set.
 */
export async function partitionByCallerAudience(
  assistantUserIds: readonly string[],
  caller: AudienceCaller,
  deps: AudienceClosureDeps = DEFAULT_AUDIENCE_CLOSURE_DEPS,
): Promise<{ inAudience: string[]; outOfAudience: string[] }> {
  const unique = [...new Set(assistantUserIds.filter((id) => !!id))];
  if (unique.length === 0) return { inAudience: [], outOfAudience: [] };
  const ctx = await deps.resolveContext(caller);
  const visible = await deps.readVisibleRegistry(ctx);
  const visibleIds = new Set(visible.map((e) => e.assistantUserId));
  const inAudience: string[] = [];
  const outOfAudience: string[] = [];
  for (const id of unique) {
    (visibleIds.has(id) ? inAudience : outOfAudience).push(id);
  }
  return { inAudience, outOfAudience };
}
