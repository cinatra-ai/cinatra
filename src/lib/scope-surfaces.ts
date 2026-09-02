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
