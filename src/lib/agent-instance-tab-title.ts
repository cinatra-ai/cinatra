/**
 * THE TAB TITLE ON AN ID-BEARING AGENT ROUTE (cinatra#2934, fix leg 9).
 *
 * The ratified drawing binds the tab to the trail in one sentence: "The
 * browser-tab title mirrors the resolved trail under the same rules: an
 * id-bearing route never shows a raw id in the tab."
 *
 * Fix leg 8 derived that title in the SHELL, once, on mount. The shell loses:
 * every run surface polls by asking the router to re-render, and each
 * re-render re-applies the route file's own exported metadata to the document
 * title, while the shell effect — whose inputs did not change — never fires
 * again. So the trail read "Agents > Blog Pipeline Agent (1)" while the tab
 * still held the route file's static literal, which is the divergence the
 * drawing forbids.
 *
 * The title is therefore derived HERE, on the server, from the SAME trail
 * builder the crumb row draws with, and every id-bearing route under the shell
 * asks this one helper for its metadata. One reading, one source, so a
 * re-render cannot pull the two apart: what a re-render reapplies is already
 * the mirrored title.
 *
 * THE CONVENTION IS FIX LEG 8'S, UNCHANGED: the title is the trail's last
 * RESOLVED crumb, and the product-name suffix is appended by the root layout's
 * own title template. `documentTitleLabelFromTrail` — the same function the
 * shell used — owns the id guard, so an unresolved leaf never becomes a tab.
 */
import "server-only";

import type { Metadata } from "next";

import { buildBreadcrumbTrail, documentTitleLabelFromTrail } from "./breadcrumb-trail";

/**
 * What the tab says when the trail resolves nothing safe to say. It is the word
 * the trail itself falls back to for an unresolved run crumb (the refusal
 * panel's own header word), so the fallback still mirrors the trail rather than
 * inventing a second vocabulary — and it is never an identifier.
 */
export const AGENT_INSTANCE_GENERIC_TAB_TITLE = "Agent run";

export type AgentInstanceRouteParams = {
  vendor: string;
  packageName: string;
  instanceId: string;
  /** The sub-route segment, when this is a sub-route of the run. */
  subRoute?: string;
};

/** The run instance's own path — the crumb prefix a contribution targets. */
export function agentInstancePathname(params: AgentInstanceRouteParams): string {
  const base = [
    "agents",
    encodeURIComponent(params.vendor),
    encodeURIComponent(params.packageName),
    encodeURIComponent(params.instanceId),
  ].join("/");
  return params.subRoute
    ? "/" + base + "/" + encodeURIComponent(params.subRoute)
    : "/" + base;
}

/**
 * The tab title for an id-bearing agent route, derived from the trail that same
 * route draws. `resolvedInstanceLabel` is the run identity the page publishes
 * for its own crumb (the run's title, else the template name); absent, or still
 * identifying, the trail names the KIND instead and the tab follows it.
 */
export function agentInstanceTabTitle(
  params: AgentInstanceRouteParams & { resolvedInstanceLabel?: string | null },
): string {
  const label = params.resolvedInstanceLabel?.trim();
  const trail = buildBreadcrumbTrail(agentInstancePathname(params), {
    contributions: label
      ? [{ prefix: agentInstancePathname({ ...params, subRoute: undefined }), label }]
      : [],
  });
  return documentTitleLabelFromTrail(trail) ?? AGENT_INSTANCE_GENERIC_TAB_TITLE;
}

/**
 * Gate-repeating metadata (the pattern the project detail page already uses):
 * the tab repeats the page's own read gate before it discloses the run's
 * identity, and ANY failure yields the generic title rather than a leak or a
 * broken render.
 *
 * The run identity is read ONLY for the run's own page. On a sub-route the
 * trail's leaf is the sub-route's own word ("Schedule", "Results", "Review"),
 * so the run's name is not part of the answer and no run data is read for it.
 */
export async function resolveAgentInstanceMetadata(
  params: AgentInstanceRouteParams,
): Promise<Metadata> {
  const resolvedInstanceLabel = params.subRoute
    ? null
    : await readAgentInstanceCrumbLabel(params);
  return { title: agentInstanceTabTitle({ ...params, resolvedInstanceLabel }) };
}

/**
 * The run's identity, read behind the run's own access gate — the same pair of
 * reads the run screen performs (the template by slug for this actor, then the
 * run with the actor and their role hints so the run-visibility policy
 * applies). `null` on anything at all: no session, no template, a refusal, a
 * store that fell over. It never throws; a metadata read must not decide
 * whether a page renders.
 */
async function readAgentInstanceCrumbLabel(
  params: AgentInstanceRouteParams,
): Promise<string | null> {
  // `/agents/<vendor>/<package>/new` creates a run and redirects; there is no
  // instance to name yet.
  if (params.instanceId === "new") return null;
  try {
    const { getAuthSession, isPlatformAdmin, resolveOrgRoleForSession } = await import(
      "@/lib/auth-session"
    );
    const session = await getAuthSession();
    if (!session) return null;
    const actorUserId = session.user?.id ?? null;
    const { readAgentTemplateBySlug, readAgentRunById } = await import(
      "@cinatra-ai/agents/store"
    );
    const template = await readAgentTemplateBySlug(
      params.vendor + "/" + params.packageName,
      { actorUserId, includeNonPublished: true },
    );
    if (!template) return null;
    const run = await readAgentRunById(
      params.instanceId,
      { actorType: "human", source: "ui", userId: actorUserId ?? undefined },
      {
        platformRole: isPlatformAdmin(session) ? "platform_admin" : "member",
        orgRole: await resolveOrgRoleForSession({
          user: { id: session.user.id },
          session: session.session,
        }),
        actorOrganizationId: session.session?.activeOrganizationId ?? undefined,
      },
    );
    if (!run) return null;
    // The screen's own precedence, MINUS its write. The run screen auto-names a
    // started run as it renders, and that naming PERSISTS. A metadata read runs
    // on every request - including one whose page then answers not-found, and
    // concurrently with the very render that does the naming - so repeating the
    // call here would let a tab read consume a numbered slot for a page nobody
    // saw, and would put two writers on one run's name. The tab reads what is
    // already persisted (the run's editable title, else the template name); the
    // run screen stays the one place a run is named, and the shell's own trail
    // effect carries the numbered name into the tab the moment the screen
    // publishes it.
    return run.title?.trim() || template.name || null;
  } catch {
    return null;
  }
}
