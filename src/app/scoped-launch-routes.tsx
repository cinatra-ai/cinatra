// ---------------------------------------------------------------------------
// THE SCOPED LAUNCH ROUTE SHELLS (cinatra#2809, per-scope surfaces S3).
//
// Under every scope base the same two trees answer — the agents tree and the
// assistants tree — and they answer with the SAME renderers the bare global
// routes use. One catch-all per base delegates here; the grammar is resolved by
// the pure `src/lib/scoped-launch-route.ts` and the render is the existing one.
//
// WHY DELEGATION AND NOT A COPY. Five copies of a route tree is five places for
// the grammar to drift, and the grammar is the href contract #2808's Run, Chat
// and Settings buttons compose on. A copy would also fork the authorization:
// each screen already owns its own access door, and delegation keeps exactly
// one of them.
//
// THE SCOPE BASE IS PASSED DOWN, not re-derived: the screens use it to send a
// freshly created run to this scope's address, and to decide — after their own
// access check — whether the reader is at the instance's canonical home.
//
// This file is the sibling of `src/app/plugins-routes.tsx`, which already does
// the same job for the plugin trees.
// ---------------------------------------------------------------------------

import type React from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import {
  resolveScopedAgentRoute,
  resolveScopedAssistantRoute,
} from "@/lib/scoped-launch-route";
import { AGENT_LAUNCH_SEGMENT } from "@/lib/agent-url";
import type { ScopeSurfaceSettingsSubject } from "@/components/scope-surface-settings-shell";
import type { ScopeSurfaceRef } from "@/lib/scope-surfaces";
import { scopeSurfaceBase } from "@/lib/scope-surfaces";

type SearchParams = Record<string, string | string[] | undefined>;

// ---------------------------------------------------------------------------
// WHAT THE BUILD MUST NOT BE MADE TO CARRY (cinatra#2809 fix leg 3).
//
// `next build` collects page data by LOADING each route entry and evaluating
// its eager module graph. Ten entries mount this shell, so every module reached
// eagerly from here is paid for ten times over in the collector — and the
// production build of this branch was reclaimed by the constrained runner
// inside exactly that step, three times, while the base branch passed.
//
// Neither of the two modules below is needed to LOAD a scoped route; both are
// needed only once a request has picked a shape:
//
//   - the settings shell is a client-component tree that only the `settings`
//     shape ever renders, and
//   - the per-scope NAME READ is a `server-only` module that pulls the Drizzle
//     stores and the organization/team/project read gates behind it.
//
// So they travel the same way the plugins registry and the chat mount already
// travel here — behind `await import(...)`, in a chunk the collector never
// evaluates. The measured effect on each of the ten entries is a build graph of
// 158 modules falling to 142, against a `requireAuthSession` floor of 151 that
// every authenticated route in the repository already pays.
//
// `src/lib/__tests__/scoped-launch-build-graph-2809.test.ts` holds the ceiling.
// ---------------------------------------------------------------------------

/** The gated per-scope name, read at request time. */
async function readScopeName(scope: ScopeSurfaceRef): Promise<string | null> {
  const { readScopeSurfaceEntityName } = await import(
    "@/lib/scope-surface-entity-name"
  );
  return readScopeSurfaceEntityName(scope);
}

/**
 * The settings route's page, rendered at request time: the per-scope
 * assignment page (cinatra#2814) inside the #2809 shell.
 *
 * The page model is resolved HERE, on the server, from the route alone: the
 * package pair is re-resolved against the rows this scope's tab lists for the
 * reader, the scope is the route's, and the reader's authority is re-read in
 * the scope's own organization. A pair the reader does not reach at this scope
 * (forged, uninstalled, out of scope, or an assistant addressed through the
 * agents tree) is not found. Both modules travel behind `await import(...)`
 * for the reason the header above gives.
 */
async function renderScopeSurfaceSettingsShell(props: {
  scope: ScopeSurfaceRef;
  scopeTitle?: string | null;
  subject: ScopeSurfaceSettingsSubject;
  pair: { vendor: string; name: string };
  searchParams?: Promise<SearchParams>;
}): Promise<React.ReactNode> {
  const [{ loadScopeAssignmentPage }, { ScopeSurfaceSettingsShell }] = await Promise.all([
    import("@/lib/scope-assignment/scope-assignment-page.server"),
    import("@/components/scope-surface-settings-shell"),
  ]);
  const query = (await props.searchParams) ?? {};
  const page = await loadScopeAssignmentPage({
    surface: props.subject.kind,
    scope: props.scope,
    vendor: props.pair.vendor,
    name: props.pair.name,
    tab: query.tab,
  });
  if (!page) notFound();
  return (
    <ScopeSurfaceSettingsShell
      scope={props.scope}
      scopeTitle={props.scopeTitle}
      subject={props.subject}
      page={page}
    />
  );
}

type AgentInstanceScreen = (props: {
  agentId: string;
  instanceId: string;
  scopeBase?: string | null;
  launchScope?: ScopeSurfaceRef | null;
  scopeTitle?: string | null;
  searchParams?: Promise<SearchParams> | undefined;
}) => Promise<React.ReactNode>;

/**
 * The registry screen an instance SUB-ROUTE names (cinatra#3693), or null for
 * a shape with no page under a scope. Results and optimization have no screen
 * in the registry, and the skills page is a page of its own with no scope, so
 * they stay not-found here.
 */
function instanceSubScreenKey(rest: readonly string[]): string | null {
  if (rest.length !== 1) return null;
  switch (rest[0]) {
    case "trigger":
      return "instanceTrigger";
    case "permissions":
      return "instancePermissions";
    case "data":
      return "instanceData";
    default:
      return null;
  }
}

/** `<scope-base>/agents/…` — the launcher, the settings shell, an instance and
 *  its sub-routes. */
export async function ScopedAgentsRoute({
  scope,
  segments,
  searchParams,
}: {
  scope: ScopeSurfaceRef;
  segments: string[] | undefined;
  searchParams?: Promise<SearchParams>;
}): Promise<React.ReactNode> {
  const route = resolveScopedAgentRoute(segments);
  if (route.kind === "not-found") notFound();
  const scopeBase = scopeSurfaceBase(scope);
  // THE SCOPE'S NAME, READ ONCE, HERE (cinatra#2809 fix leg 2). This is the one
  // place that knows the scope before any surface below it draws, and the read
  // repeats that scope's own gate — so every page under this base publishes the
  // SAME name the scope's landing publishes, and a reader who may not be told
  // it gets the id abbreviation on all of them alike.
  const scopeTitle = await readScopeName(scope);

  if (route.kind === "settings") {
    // #2809's shell, filled with the per-scope assignment page (cinatra#2814).
    return renderScopeSurfaceSettingsShell({
      scope,
      scopeTitle,
      subject: { kind: "agent", packageName: `@${route.vendor}/${route.packageName}` },
      pair: { vendor: route.vendor, name: route.packageName },
      searchParams,
    });
  }

  // THE SUB-ROUTES OF AN INSTANCE (cinatra#3693) — its schedule, its
  // permissions and its review — moved here once, for all five bases. Each is
  // handed the same scope, vantage and name as the run page, because each runs
  // the same home check after its own access door: an instance reached under a
  // scope that is not its home is sent there, sub-path and all.
  if (route.kind === "instance" && route.rest[0] === "review") {
    if (route.rest.length !== 2) notFound();
    // A page of its own on the bare tree, reached the way the chat mount is:
    // behind `await import(...)`, so no entry's build graph carries it.
    const { default: AgentRunReviewPage } = await import(
      "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/page"
    );
    return AgentRunReviewPage({
      params: Promise.resolve({
        vendor: route.vendor,
        packageName: route.packageName,
        instanceId: route.instanceId,
        reviewTaskId: route.rest[1],
      }),
      searchParams,
      scopeBase,
      launchScope: scope,
      scopeTitle,
    });
  }
  const screenKey =
    route.kind === "instance" && route.rest.length > 0
      ? instanceSubScreenKey(route.rest)
      : "instanceSetup";
  if (!screenKey) notFound();

  const instanceId = route.kind === "launch" ? AGENT_LAUNCH_SEGMENT : route.instanceId;
  const { resolveAgentScreensWithA2AFallback } = await import("@/app/plugins-registry");
  const screens = await resolveAgentScreensWithA2AFallback(route.agentId);
  if (!screens) notFound();
  const screen = (screens as Record<string, unknown>)[screenKey];
  if (!screen) notFound();
  return (screen as AgentInstanceScreen)({
    agentId: route.agentId,
    instanceId,
    scopeBase,
    // The vantage itself, not just its route: the launcher stamps the run with
    // it, and the personal scope resolves to the originating human there.
    launchScope: scope,
    // The resolved name travels WITH the vantage: the run page owns the one
    // crumb publish on its route, so it publishes the scope's crumb itself
    // rather than a second island racing it.
    scopeTitle,
    searchParams,
  });
}

/** `<scope-base>/assistants/…` — the settings shell, or the SAME chat renderer
 *  the bare `/chat` mount uses, with the scope base already split off. */
export async function ScopedAssistantsRoute({
  scope,
  segments,
  searchParams,
}: {
  scope: ScopeSurfaceRef;
  segments: string[] | undefined;
  searchParams?: Promise<SearchParams>;
}): Promise<React.ReactNode> {
  const route = resolveScopedAssistantRoute(segments);
  if (route.kind === "not-found") notFound();

  if (route.kind === "settings") {
    // Skills only: the assistant page normalizes every `?tab=` to Skills.
    return renderScopeSurfaceSettingsShell({
      scope,
      scopeTitle: await readScopeName(scope),
      subject: { kind: "assistant", packageName: route.assistantPackageName },
      pair: { vendor: route.vendor, name: route.slug },
      searchParams,
    });
  }

  // THE SAME RENDERER, mounted under this base. The mount takes the trailing
  // segments the codec has always parsed, so nothing about the chat grammar,
  // its authorization or its four legal shapes changes by being addressed from
  // a scope.
  const { default: ChatPageMount } = await import("@/app/chat/[[...slug]]/page");
  return ChatPageMount({
    params: Promise.resolve({ slug: route.slug }),
    searchParams,
  });
}


// THE TAB TITLE OF A SCOPED SURFACE (cinatra#2809 fix leg 2). The ratified
// drawing, Components/Breadcrumb: "The browser-tab title mirrors the resolved
// trail under the same rules: an id-bearing route never shows a raw id in the
// tab." Every scoped launch route is id-bearing, and on an id-bearing route
// the shell writes no title of its own until the trail resolves — so this is
// what the tab reads meanwhile, and a static noun would mirror nothing.
//
// The read is THE gated one every other scoped surface uses, so this title can
// never disclose a name the page beneath it may not disclose; a withheld or
// genuinely unavailable name falls back to the surface's own noun, never to
// the id in any form.
export async function scopedSurfaceMetadata(
  scope: ScopeSurfaceRef,
  surface: "Agents" | "Assistants",
): Promise<Metadata> {
  try {
    const name = await readScopeName(scope);
    return { title: name ? surface + " — " + name : surface };
  } catch {
    // A name is a convenience on this surface, never its subject.
    return { title: surface };
  }
}
