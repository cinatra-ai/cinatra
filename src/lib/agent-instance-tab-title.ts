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

import {
  PAGE_NOT_FOUND_CRUMB_LABEL,
  agentInstanceSubRouteCrumbLabel,
  buildBreadcrumbTrail,
  documentTitleLabelFromTrail,
} from "./breadcrumb-trail";

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
  /**
   * The plugin screen THIS route dispatches — the one its body requires before
   * it renders anything, and the one whose absence makes it answer not-found.
   * Given, the metadata repeats that determination (see below); omitted, it is
   * not made at all and the route keeps the naming behaviour it had.
   */
  screenSlot?: string;
  /**
   * THIS ROUTE'S SCREEN ANSWERS NOT-FOUND FOR A RUN THAT IS NOT THERE
   * (cinatra#2934, fix leg 11 convergence round).
   *
   * Given, the metadata repeats the screen's OWN run guard as well as its
   * screens-dispatch guard: `if (!template) notFound(); ... if (!run)
   * notFound();`, with a refusal that hid the run's existence (404) counted as
   * not-found and a refusal that left the page standing (403) counted as
   * nothing at all. Set ONLY on the routes whose screen provably guards this
   * way — the run's own page (Setup), /trigger (Schedule) and /permissions.
   * The data route redirects rather than answering not-found, so it does not
   * set it, and a route whose screen this module cannot read does not either.
   */
  notFoundWhenRunMissing?: boolean;
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
 * The run identity is read for every route whose trail ENDS on the run. On a
 * sub-route that draws a crumb of its own the trail's leaf is that sub-route's
 * word ("Schedule"), so the run's name is not part of the answer and no run
 * data is read for it. A sub-route that draws NO crumb — the review, which is
 * read under its run's trail (cinatra#2934, fix leg 10) — leaves the RUN as the
 * leaf, so the tab mirrors the run's own name, exactly as the trail does.
 */
export async function resolveAgentInstanceMetadata(
  params: AgentInstanceRouteParams,
): Promise<Metadata> {
  // A PAGE THAT IS NOT FOUND HAS NO NAME TO PUT IN ITS TAB (cinatra#2934, fix
  // leg 11). The ratified drawing: "If a page is not found, then that page has
  // no hierarchy - and so no trail to draw. Its breadcrumb reads 'Page not
  // found' and nothing else", and the tab "mirrors the resolved trail under the
  // same rules". Nothing here could obey that: `notFound()` is thrown by the
  // page BODY, and metadata has already resolved by then, so what the tab held
  // was a name for a page the reader never reached. The determination is made
  // HERE too, from the same screens dispatch the body guards on, and before any
  // identity is read - a page nobody reached is not a run to name.
  if (
    params.screenSlot &&
    (await agentInstanceRouteAnswersNotFound(params.vendor, params.packageName, params.screenSlot))
  ) {
    return { title: PAGE_NOT_FOUND_CRUMB_LABEL };
  }
  const subRouteDrawsItsOwnCrumb =
    params.subRoute != null &&
    agentInstanceSubRouteCrumbLabel(params.subRoute) !== null;
  // THE RUN'S OWN ABSENCE IS ALSO A NOT-FOUND READING (fix leg 11 convergence
  // round). The screens-dispatch guard above catches only an agent whose
  // screens do not resolve; the address the proof round typed reached a real
  // agent and named a run that is not there, and the SCREEN answers not-found
  // for that - so the tab that ships with the first byte still read a run's
  // kind above a page that renders "Page not found". The same read this module
  // already performs for the crumb now reports WHICH answer it got, and on a
  // route that guards the run it decides the title before any name is used.
  // A sub-route that draws its own crumb still takes no name from the read.
  let resolvedInstanceLabel: string | null = null;
  if (params.notFoundWhenRunMissing || !subRouteDrawsItsOwnCrumb) {
    const reading = await readAgentInstanceIdentity(params);
    if (params.notFoundWhenRunMissing && reading.kind === "not-found") {
      return { title: PAGE_NOT_FOUND_CRUMB_LABEL };
    }
    if (!subRouteDrawsItsOwnCrumb && reading.kind === "named") {
      resolvedInstanceLabel = reading.label;
    }
  }
  return { title: agentInstanceTabTitle({ ...params, resolvedInstanceLabel }) };
}

/**
 * THE ROUTE'S OWN NOT-FOUND DETERMINATION, REPEATED (cinatra#2934, fix leg 11).
 *
 * Every route under the run dispatches ONE plugin screen and guards it the same
 * way: `if (!screens) notFound(); if (!screens.<slot>) notFound();`. This is
 * that pair of lines and nothing more, so the tab and the page can only ever
 * agree. It never throws: a registry that fell over is not a not-found reading,
 * and a metadata read must not decide whether a page renders.
 */
async function agentInstanceRouteAnswersNotFound(
  vendor: string,
  packageName: string,
  screenSlot: string,
): Promise<boolean> {
  try {
    const { resolveAgentScreensWithA2AFallback } = await import("@/app/plugins-registry");
    const screens = (await resolveAgentScreensWithA2AFallback(
      vendor + "/" + packageName,
    )) as Record<string, unknown> | null | undefined;
    if (!screens) return true;
    return !(screenSlot in screens) || !screens[screenSlot];
  } catch {
    return false;
  }
}

/**
 * The run's identity, read behind the run's own access gate - the same pair of
 * reads the run screen performs (the template by slug for this actor, then the
 * run with the actor and their role hints so the run-visibility policy
 * applies), and now reporting WHICH answer it got rather than only a name:
 *
 *   `not-found`  what the screen itself answers not-found for: no template for
 *                this actor, no run, or a refusal that HID the run's existence.
 *   `unknown`    nothing was determined: no session, a store that fell over, or
 *                a refusal that left the page standing (403, the not-authorized
 *                panel). The caller names the kind, exactly as before.
 *   `named`      the run resolved; `label` is its title, else the template's.
 *
 * It never throws; a metadata read must not decide whether a page renders.
 */
type AgentInstanceIdentityReading =
  | { kind: "unknown" }
  | { kind: "not-found" }
  | { kind: "named"; label: string | null };

async function readAgentInstanceIdentity(
  params: AgentInstanceRouteParams,
): Promise<AgentInstanceIdentityReading> {
  // `/agents/<vendor>/<package>/new` creates a run and redirects; there is no
  // instance to name yet, and no absent run to read as not-found either.
  if (params.instanceId === "new") return { kind: "named", label: null };
  try {
    const { getAuthSession, isPlatformAdmin, resolveOrgRoleForSession } = await import(
      "@/lib/auth-session"
    );
    const session = await getAuthSession();
    if (!session) return { kind: "unknown" };
    const actorUserId = session.user?.id ?? null;
    const { readAgentTemplateBySlug, readAgentRunById } = await import(
      "@cinatra-ai/agents/store"
    );
    const template = await readAgentTemplateBySlug(
      params.vendor + "/" + params.packageName,
      { actorUserId, includeNonPublished: true },
    );
    if (!template) return { kind: "not-found" };
    let run;
    try {
      run = await readAgentRunById(
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
    } catch (err) {
      return runReadHidTheRun(err) ? { kind: "not-found" } : { kind: "unknown" };
    }
    if (!run) return { kind: "not-found" };
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
    return { kind: "named", label: run.title?.trim() || template.name || null };
  } catch {
    return { kind: "unknown" };
  }
}

/**
 * The screens' own refusal mapping, read structurally so that this module does
 * not pull the screen bundle into a metadata read: a refusal carrying 404 HID
 * the run's existence and the screen answers not-found; 403 leaves the page
 * standing and is not a not-found reading; anything without that code is not a
 * permission answer at all.
 */
function runReadHidTheRun(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { statusCode?: unknown }).statusCode === 404
  );
}
