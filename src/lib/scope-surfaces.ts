/**
 * The per-scope surface vocabulary (cinatra#2807, per-scope surfaces S1).
 *
 * Every scope in the product — the workspace, a user's personal scope, a
 * project, a team, an organization — carries the SAME tab strip, so the tab
 * routes are derived from ONE place: the scope reference. A scope base is the
 * scope's own landing route, and each tab hangs directly off it, which is also
 * what the scoped launch routes will prefix later.
 *
 * This module is deliberately free of React and of any read: it maps a scope
 * reference to routes and labels, nothing else.
 */

/** The four tabs #2807 adds beside the existing Dashboards tab. */
export const SCOPE_SURFACE_TABS = [
  "assistants",
  "agents",
  "artifacts",
  "skills",
] as const;

export type ScopeSurfaceTab = (typeof SCOPE_SURFACE_TABS)[number];

/**
 * A scope, named the way its route names it. `workspace` is the scope ABOVE
 * every organization and has no id; `personal` is actor-relative and has none
 * either.
 */
export type ScopeSurfaceRef =
  | { kind: "workspace" }
  | { kind: "personal" }
  | { kind: "organization"; id: string }
  | { kind: "team"; id: string }
  | { kind: "project"; id: string };

export type ScopeSurfaceKind = ScopeSurfaceRef["kind"];

/** The scope's own landing route — the base every tab route hangs off. */
export function scopeSurfaceBase(scope: ScopeSurfaceRef): string {
  switch (scope.kind) {
    case "workspace":
      return "/workspace";
    case "personal":
      return "/personal";
    case "organization":
      return `/organizations/${encodeURIComponent(scope.id)}`;
    case "team":
      return `/teams/${encodeURIComponent(scope.id)}`;
    case "project":
      return `/projects/${encodeURIComponent(scope.id)}`;
  }
}

/**
 * The scope's Settings route, or `null` where the scope has no settings pane:
 * personal (#1904) and the workspace, whose settings are the instance's own
 * administration surface rather than a scope pane.
 */
export function scopeSurfaceSettingsHref(scope: ScopeSurfaceRef): string | null {
  if (scope.kind === "workspace" || scope.kind === "personal") return null;
  return `${scopeSurfaceBase(scope)}/settings`;
}

/** The five tab hrefs of a scope, keyed exactly as `EntityScopeTabs` takes them. */
export function scopeSurfaceTabHrefs(scope: ScopeSurfaceRef): {
  dashboardsHref: string;
  assistantsHref: string;
  agentsHref: string;
  artifactsHref: string;
  skillsHref: string;
} {
  const base = scopeSurfaceBase(scope);
  return {
    dashboardsHref: base,
    assistantsHref: `${base}/assistants`,
    agentsHref: `${base}/agents`,
    artifactsHref: `${base}/artifacts`,
    skillsHref: `${base}/skills`,
  };
}

// ---------------------------------------------------------------------------
// THE LAUNCH AND SETTINGS HREF CONTRACT (cinatra#2809, per-scope surfaces S3).
//
// A card on a scope's Agents or Assistants tab carries a Run button, a Chat
// button and a Settings button, and every one of them must land INSIDE the
// scope the reader is looking at — a launch made from a team belongs to that
// team. #2808 draws those cards; this module answers what they point at, so
// the two slices cannot disagree about an address.
//
// The grammar is the path builders' (`src/lib/agent-url.ts` for agents, the
// chat codec's mount for assistants), with the scope's own landing route in
// front. It is composed here rather than imported: this module is deliberately
// dependency-free — it is reached from the app shell, which the chat mount's
// module graph is measured through — and the agreement with both builders is
// pinned by a unit test instead of by an import.
// ---------------------------------------------------------------------------

/** The launcher segment below the vendor/package pair — a fresh run. */
export const SCOPE_SURFACE_LAUNCH_SEGMENT = "new";

/** The settings segment below the vendor/package pair. */
export const SCOPE_SURFACE_SETTINGS_SEGMENT = "settings";

/** The segment the scoped assistants mount answers on. */
export const SCOPE_SURFACE_ASSISTANTS_SEGMENT = "assistants";

/** A path segment is valid when non-empty and slash/whitespace-free — the same
 *  rule the chat codec applies, so an address minted here can be parsed back. */
function assertSegment(seg: string): string {
  if (typeof seg !== "string" || seg.length === 0 || /[\s/]/.test(seg)) {
    throw new Error(`scope-surfaces: invalid path segment ${JSON.stringify(seg)}`);
  }
  return seg;
}

/** A segment that addresses a PERSISTED thing, so it may not occupy one of the
 *  reserved words below the vendor/package pair. */
function assertUnreservedSegment(seg: string): string {
  assertSegment(seg);
  if (seg === SCOPE_SURFACE_LAUNCH_SEGMENT || seg === SCOPE_SURFACE_SETTINGS_SEGMENT) {
    throw new Error(`scope-surfaces: reserved path segment ${JSON.stringify(seg)}`);
  }
  return seg;
}

/** `@vendor/name` → `vendor/name`; an unscoped name stays as it is. */
function agentPackageSegments(agentPackageName: string): string {
  const match = agentPackageName.match(/^@([^/]+)\/(.+)$/);
  return match ? `${match[1]}/${match[2]}` : agentPackageName;
}

/** The agent's package base at this scope — `<base>/agents/<vendor>/<package>`. */
export function scopeSurfaceAgentBaseHref(
  scope: ScopeSurfaceRef,
  agentPackageName: string,
): string {
  return `${scopeSurfaceBase(scope)}/agents/${agentPackageSegments(agentPackageName)}`;
}

/** The Run button's target: a FRESH run of this agent, at this scope. */
export function scopeSurfaceAgentLaunchHref(
  scope: ScopeSurfaceRef,
  agentPackageName: string,
): string {
  return `${scopeSurfaceAgentBaseHref(scope, agentPackageName)}/${SCOPE_SURFACE_LAUNCH_SEGMENT}`;
}

/** The Settings button's target — the contract #2808's cards compose on. */
export function scopeSurfaceAgentSettingsHref(
  scope: ScopeSurfaceRef,
  agentPackageName: string,
): string {
  return `${scopeSurfaceAgentBaseHref(scope, agentPackageName)}/${SCOPE_SURFACE_SETTINGS_SEGMENT}`;
}

/** A PERSISTED run's address at this scope.
 *
 *  The reserved words are refused HERE too, not only in `buildAgentInstancePath`
 *  (convergence finding on this lane): the two are the same contract seen from
 *  two sides, and where they disagreed they disagreed precisely on the
 *  collision — an instance link minted for a run whose id is `new` or
 *  `settings` would have resolved to the LAUNCHER or to the settings shell. */
export function scopeSurfaceAgentInstanceHref(
  scope: ScopeSurfaceRef,
  agentPackageName: string,
  instanceId: string,
): string {
  assertUnreservedSegment(instanceId);
  return `${scopeSurfaceAgentBaseHref(scope, agentPackageName)}/${instanceId}`;
}

/** The assistant's mount at this scope — `<base>/assistants/<vendor>/<slug>`. */
export function scopeSurfaceAssistantBaseHref(
  scope: ScopeSurfaceRef,
  assistant: { vendor: string; slug: string },
): string {
  return `${scopeSurfaceBase(scope)}/${SCOPE_SURFACE_ASSISTANTS_SEGMENT}/${assertSegment(
    assistant.vendor,
  )}/${assertSegment(assistant.slug)}`;
}

/** The Chat button's target. A remote-capable assistant's launch is scoped to
 *  one connected site, which is the optional third segment. */
export function scopeSurfaceAssistantLaunchHref(
  scope: ScopeSurfaceRef,
  assistant: { vendor: string; slug: string; instance?: string },
): string {
  const base = scopeSurfaceAssistantBaseHref(scope, assistant);
  // The connected site is a persisted thing addressed below the pair, so it
  // takes the reserved-word rule with it: `…/<vendor>/<slug>/settings` is the
  // settings shell's own address and must not be mintable as a conversation.
  return assistant.instance == null
    ? base
    : `${base}/${assertUnreservedSegment(assistant.instance)}`;
}

/** The assistant analog of the agent Settings href. */
export function scopeSurfaceAssistantSettingsHref(
  scope: ScopeSurfaceRef,
  assistant: { vendor: string; slug: string },
): string {
  return `${scopeSurfaceAssistantBaseHref(scope, assistant)}/${SCOPE_SURFACE_SETTINGS_SEGMENT}`;
}

/** The kicker above the page title — the scope KIND, never the entity name. */
export const SCOPE_SURFACE_KIND_LABEL: Record<ScopeSurfaceKind, string> = {
  workspace: "Workspace",
  personal: "Your scope",
  organization: "Organization",
  team: "Team",
  project: "Project",
};

/**
 * The name a scope's page header falls back to when the entity's own name is
 * not available to this reader.
 *
 * The ratified drawing makes the heading the ENTITY's: "The page's heading
 * reads Workspace, and the page is an entity page". The workspace and the
 * personal scope ARE named by the drawing, so they need no read at all; the
 * three id-bearing scopes fall back to their kind noun, never to a raw or
 * title-cased id, and never to the name of the active tab.
 */
export const SCOPE_SURFACE_ENTITY_FALLBACK: Record<ScopeSurfaceKind, string> = {
  workspace: "Workspace",
  personal: "Personal",
  organization: "Organization",
  team: "Team",
  project: "Project",
};

/** Tab labels, exactly as the strip renders them. */
export const SCOPE_SURFACE_TAB_LABEL: Record<ScopeSurfaceTab | "dashboards", string> = {
  dashboards: "Dashboards",
  assistants: "Assistants",
  agents: "Agents",
  artifacts: "Artifacts",
  skills: "Skills",
};

/** The named empty-state surface of a tab. */
export function scopeSurfaceEmptyTestId(tab: ScopeSurfaceTab | "dashboards"): string {
  return `scope-${tab}-empty`;
}

/**
 * The ONE primary action each tab's empty state carries.
 *
 * The system's Empty state pattern rules that an empty surface always includes
 * a single primary action button and never just empty text. None of the five
 * corresponding top-level surfaces carries an embedded empty-state action of
 * its own today (their add affordances live in a page toolbar or a dialog), so
 * each tab takes the pattern's neutral action instead of an invented one: the
 * existing top-level surface that lists that domain today, named and addressed
 * exactly as the sidebar already names and addresses it.
 *
 * The FOUR scoped tabs only. The drawing binds this pattern to them by name -
 * "While one of the four scoped tabs - Assistants, Agents, Artifacts, Skills -
 * holds nothing to list, it reads as the Empty state of Components" - and gives
 * the Dashboards tab its own body and its own empty reading instead.
 */
export const SCOPE_SURFACE_TAB_ACTION: Record<
  ScopeSurfaceTab,
  { label: string; href: string }
> = {
  assistants: { label: "Go to Assistants", href: "/assistants" },
  agents: { label: "Go to Agents", href: "/agents" },
  artifacts: { label: "Go to Artifacts", href: "/artifacts" },
  skills: { label: "Go to Skills", href: "/skills" },
};

/**
 * The crumb labels a scope surface RESOLVES and publishes (the Breadcrumb
 * pattern: "A crumb that stands for an entity id shows that entity's display
 * name — at every position, not only the last. Names come from the owning page's
 * server render, strictly after its access checks").
 *
 *   - the ENTITY crumb carries the resolved name, or — while the name is
 *     genuinely unavailable to this reader — the id's first eight characters
 *     plus an ellipsis, never a title-cased raw id;
 *   - the LEAF crumb of a scoped tab carries the TAB's own name. Without it the
 *     shell's leaf-crumb rule takes the page heading, which on an entity page is
 *     the entity — so /workspace/assistants read "Workspace > Workspace" and an
 *     organization tab repeated the org's name after its own truncated id.
 */
export function scopeSurfaceCrumbEntries(
  scope: ScopeSurfaceRef,
  tab: ScopeSurfaceTab | "dashboards",
  title?: string,
): { prefix: string; label: string }[] {
  const base = scopeSurfaceBase(scope);
  const entityLabel =
    title ??
    ("id" in scope
      ? `${scope.id.slice(0, 8)}\u2026`
      : SCOPE_SURFACE_ENTITY_FALLBACK[scope.kind]);
  const entries = [{ prefix: base, label: entityLabel }];
  if (tab !== "dashboards") {
    entries.push({ prefix: `${base}/${tab}`, label: SCOPE_SURFACE_TAB_LABEL[tab] });
  }
  return entries;
}
