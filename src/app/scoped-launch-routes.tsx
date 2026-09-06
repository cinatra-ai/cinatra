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
import { ScopeSurfaceSettingsShell } from "@/components/scope-surface-settings-shell";
import type { ScopeSurfaceRef } from "@/lib/scope-surfaces";
import { scopeSurfaceBase } from "@/lib/scope-surfaces";
import { readScopeSurfaceEntityName } from "@/lib/scope-surface-entity-name";

type SearchParams = Record<string, string | string[] | undefined>;

type AgentInstanceScreen = (props: {
  agentId: string;
  instanceId: string;
  scopeBase?: string | null;
  launchScope?: ScopeSurfaceRef | null;
  scopeTitle?: string | null;
  searchParams?: Promise<SearchParams> | undefined;
}) => Promise<React.ReactNode>;

/** `<scope-base>/agents/…` — the launcher, the settings shell, an instance. */
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
  const scopeTitle = await readScopeSurfaceEntityName(scope);

  if (route.kind === "settings") {
    // The SHELL only. This epic pins the settings HREF and proves it resolves;
    // the pane's contents and their end-to-end navigation acceptance belong to
    // the assignment epic, which fills it in place.
    return (
      <ScopeSurfaceSettingsShell
        scope={scope}
        scopeTitle={scopeTitle}
        subject={{ kind: "agent", packageName: `@${route.vendor}/${route.packageName}` }}
      />
    );
  }

  // The sub-routes of an instance (its schedule, its results, its review) are
  // still mounted on the bare tree alone. They are deliberately NOT forked
  // here: an instance reached at its canonical home addresses them from there,
  // and the slice that moves them moves them once, for all five bases.
  if (route.kind === "instance" && route.rest.length > 0) notFound();

  const instanceId = route.kind === "launch" ? AGENT_LAUNCH_SEGMENT : route.instanceId;
  const { resolveAgentScreensWithA2AFallback } = await import("@/app/plugins-registry");
  const screens = await resolveAgentScreensWithA2AFallback(route.agentId);
  if (!screens) notFound();
  if (!("instanceSetup" in screens) || !screens.instanceSetup) notFound();
  return (screens.instanceSetup as AgentInstanceScreen)({
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
    return (
      <ScopeSurfaceSettingsShell
        scope={scope}
        scopeTitle={await readScopeSurfaceEntityName(scope)}
        subject={{ kind: "assistant", packageName: route.assistantPackageName }}
      />
    );
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
    const name = await readScopeSurfaceEntityName(scope);
    return { title: name ? surface + " — " + name : surface };
  } catch {
    // A name is a convenience on this surface, never its subject.
    return { title: surface };
  }
}
