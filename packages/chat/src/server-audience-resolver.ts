import "server-only";

/**
 * Server-side AUDIENCE ROUTING CONTEXT builder (cinatra#1875 W2, Epic #1873 —
 * AC#2). The glue that binds the PURE `/chat` routing seams
 * (`./classify-mentions`, `./dispatch-planner`, `./route-decision`) to the W1
 * audience-filtered registry reader. It resolves, ONCE per routing call and
 * scoped to the acting user's audience:
 *
 *   - the {@link AudienceScopedAssistantResolver} the classifier consults
 *     (`byHandle` / `byPackageRef`, both audience-filtered — a forged
 *     out-of-audience mention resolves to null and never classifies as an
 *     assistant);
 *   - the {@link AssistantDeliveryLookup} the planner consults (each visible
 *     assistant's DECLARED delivery channel, projected by the reader from
 *     `installed_extension.assistant_declaration`);
 *   - the Cinatra host principal id (host-reply attribution).
 *
 * There is ONE audience truth — this reuses `readAssistantRegistryForActor`
 * verbatim, so the `/chat` routing decision sees exactly the set the dual selector
 * and the MCP audience closure (AC#3/AC#6) see. Fail-safe: no session ⇒ only the
 * always-visible builtin Cinatra descriptor resolves (so `@cinatra` and the
 * no-mention default keep working), every other handle is unresolved.
 */

import { getAuthSession, isPlatformAdmin } from "@/lib/auth-session";
import {
  resolveAssistantAudienceContext,
  readAssistantRegistryForActor,
  type AssistantRegistryEntry,
} from "@/lib/assistant-registry-reader";
import { normalizeAssistantHandle } from "@/lib/better-auth-db";
import type { AudienceScopedAssistantResolver } from "./classify-mentions";
import type { AssistantDeliveryKind, AssistantDeliveryLookup } from "./dispatch-planner";
import { resolveBuiltInCinatraAssistantUserId } from "./mentions";

export type AudienceRoutingContext = {
  resolver: AudienceScopedAssistantResolver;
  deliveryFor: AssistantDeliveryLookup;
  /** The Cinatra host principal (host-reply attribution), or null pre-seed. */
  cinatraHostId: string | null;
};

/** Read the actor's audience-visible registry entries (builtin-only when there is
 *  no session — fail-toward-less-visibility). */
async function readVisibleEntries(): Promise<AssistantRegistryEntry[]> {
  const session = await getAuthSession();
  if (!session) {
    // No session context (should not happen on the authenticated /chat action):
    // resolve ONLY the always-visible builtin so @cinatra + the default still
    // route, and every other handle is unresolved (honest no-responder). Filter
    // to `isBuiltin` explicitly — an empty actor context still matches
    // `workspace` grants unconditionally, so this MUST NOT leak workspace-visible
    // installed assistants to an unauthenticated caller (a probe of principal ids
    // / routing metadata). Fail-toward-less-visibility.
    const entries = await readAssistantRegistryForActor({
      userId: "",
      isPlatformAdmin: false,
      orgIds: new Set(),
      teamIds: new Set(),
      projectIds: new Set(),
    });
    return entries.filter((e) => e.isBuiltin);
  }
  const userId = session.user.id;
  const activeOrgId =
    (session.session as { activeOrganizationId?: string | null } | undefined)
      ?.activeOrganizationId ?? null;
  const ctx = await resolveAssistantAudienceContext({
    userId,
    activeOrgId,
    isPlatformAdmin: isPlatformAdmin(session),
  });
  return readAssistantRegistryForActor(ctx);
}

/**
 * Build the audience routing context for the current request's actor. See the
 * module header. `byHandle` matches the primary handle AND every claimed alias
 * (both normalized); `byPackageRef` matches the full `@vendor/slug` package name;
 * `deliveryFor` keys on the assistant principal. First registry entry wins a
 * handle/alias collision (the reader already sorts + dedupes by package).
 */
export async function buildAudienceRoutingContext(): Promise<AudienceRoutingContext> {
  const entries = await readVisibleEntries();

  const byHandle = new Map<string, AssistantRegistryEntry>();
  const byPackage = new Map<string, AssistantRegistryEntry>();
  const deliveryById = new Map<string, AssistantDeliveryKind>();

  for (const e of entries) {
    const h = normalizeAssistantHandle(e.handle);
    if (h && !byHandle.has(h)) byHandle.set(h, e);
    for (const alias of e.aliases) {
      const na = normalizeAssistantHandle(alias);
      if (na && !byHandle.has(na)) byHandle.set(na, e);
    }
    byPackage.set(e.packageName.toLowerCase(), e);
    if (e.assistantUserId) deliveryById.set(e.assistantUserId, e.delivery);
  }

  const resolver: AudienceScopedAssistantResolver = {
    async byPackageRef(packageRef) {
      const e = byPackage.get(packageRef.toLowerCase());
      return e && e.assistantUserId
        ? { assistantUserId: e.assistantUserId, handle: e.handle, packageName: e.packageName }
        : null;
    },
    async byHandle(handle) {
      const key = normalizeAssistantHandle(handle);
      const e = key ? byHandle.get(key) : undefined;
      // Return the CANONICAL handle (`e.handle`), NOT the alias the caller typed,
      // so the unified endpoint selector + attribution key on the principal's
      // primary handle (a mention by alias never 404s at the selector).
      return e && e.assistantUserId
        ? { assistantUserId: e.assistantUserId, handle: e.handle, packageName: e.packageName }
        : null;
    },
  };

  const deliveryFor: AssistantDeliveryLookup = (ref) => deliveryById.get(ref.assistantUserId);

  const cinatraHostId =
    entries.find((e) => e.isBuiltin)?.assistantUserId ||
    (await resolveBuiltInCinatraAssistantUserId());

  return { resolver, deliveryFor, cinatraHostId: cinatraHostId || null };
}
