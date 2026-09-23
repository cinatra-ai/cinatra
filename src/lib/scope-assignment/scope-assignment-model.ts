// ---------------------------------------------------------------------------
// THE PER-SCOPE ASSIGNMENT PAGE'S PURE MODEL (cinatra#2814, per-scope
// assignment S2, epic #2812).
//
// The page at `<scope-base>/agents/<vendor>/<packageName>/settings` (and the
// assistants analog) assigns skills and context artifacts to ONE package at ONE
// scope. Everything the page and its write actions decide WITHOUT I/O lives
// here, so the page, the actions and their fixtures read one answer:
//
//   - which pane the address opens (`?tab=skills|artifacts`, Skills by default,
//     assistants Skills only);
//   - which assignment scope tuple the route IMPLIES (no picker: the scope
//     comes from the address);
//   - whether a write control renders, and on which road a write travels.
//
// THE WRITE DECISION IS S1's, NOT OURS. `decideScopeAssignmentWrite` calls the
// shared exact-scope resolver (`resolveAssignmentWriteAuthority`) and returns
// its answer unchanged. It adds exactly one thing, and S1 names it: a platform
// admin holds no direct grant anywhere and writes only through the audited
// bypass (`workspace_configuration` for the workspace tier,
// `scope_configuration` for an organization, team or project). This module
// holds no role table of its own, so the page can never draw a control the
// resolver would refuse, nor hide one it would allow.
//
// Pure: no I/O and no `server-only`, so the fixtures drive it directly and a
// client component may import its words.
// ---------------------------------------------------------------------------

import {
  platformAdminBypassReasonForScope,
  resolveAssignmentWriteAuthority,
  type AssignmentAuthorityRefusal,
  type AssignmentAuthorityVia,
} from "@/lib/authz/assignment-authority";
import type { ActorContext } from "@/lib/authz/actor-context";
import {
  WORKSPACE_SCOPE_SENTINEL,
  evaluateAssignmentScope,
  type AssignmentScope,
} from "@/lib/assignment-scope";
import type { ScopeSurfaceRef } from "@/lib/scope-surfaces";
import type { WorkspaceVantage } from "@/lib/scope-surface-vantage";

/** The named assignment-content root the page renders. */
export const SCOPE_ASSIGNMENT_ROOT_TEST_ID = "scope-assignment-page";

/** Which tree the page belongs to. */
export type ScopeAssignmentSurface = "agent" | "assistant";

/** The two panes, in the order the strip draws them. */
export const SCOPE_ASSIGNMENT_TABS = ["skills", "artifacts"] as const;
export type ScopeAssignmentTab = (typeof SCOPE_ASSIGNMENT_TABS)[number];

/** The skill limits the Skills pane states (epic #2812: "5 per (agent
 *  package, exact scope) and at most 5 distinct effective skills per run"). */
export const SCOPE_ASSIGNMENT_SKILLS_PER_SCOPE = 5;
export const SCOPE_ASSIGNMENT_EFFECTIVE_SKILLS_PER_RUN = 5;

/**
 * The pane the address opens.
 *
 * Skills is the default. An agent opens Artifacts only when the address says
 * exactly `tab=artifacts`. An assistant takes skills only, so every value,
 * `artifacts` included, normalizes to Skills.
 */
export function normalizeScopeAssignmentTab(
  surface: ScopeAssignmentSurface,
  raw: string | readonly string[] | null | undefined,
): ScopeAssignmentTab {
  if (surface === "assistant") return "skills";
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === "artifacts" ? "artifacts" : "skills";
}

/**
 * The assignment scope tuple the route implies.
 *
 * The personal scope is the signed-in person's own: its id is the session's
 * user id, never a value the address or a form could name. `null` for a scope
 * that cannot be a tuple (no user, an empty id, the storage sentinel as an id).
 */
export function assignmentScopeForSurfaceScope(
  scope: ScopeSurfaceRef,
  actorUserId: string,
): AssignmentScope | null {
  let candidate: { scopeKind: string; scopeId: string };
  switch (scope.kind) {
    case "workspace":
      candidate = { scopeKind: "workspace", scopeId: WORKSPACE_SCOPE_SENTINEL };
      break;
    case "personal":
      candidate = { scopeKind: "user", scopeId: actorUserId };
      break;
    default:
      candidate = { scopeKind: scope.kind, scopeId: scope.id };
  }
  const verdict = evaluateAssignmentScope(candidate);
  return verdict.ok ? verdict.scope : null;
}

/** The write decision a control renders from and an action enforces. */
export type ScopeAssignmentWriteDecision =
  | { allowed: true; road: "grant"; via: AssignmentAuthorityVia }
  | {
      allowed: true;
      road: "audited-bypass";
      reason: "workspace_configuration" | "scope_configuration";
    }
  | { allowed: false; reason: AssignmentAuthorityRefusal };

/**
 * May this actor write at exactly this scope, and on which road?
 *
 * The grant road is S1's resolver, verbatim. When it refuses, a platform admin
 * is offered the audited bypass S1 names for the scope, except for a personal
 * row: personal is self, and no bypass reason covers another person's own
 * assignments. Everyone else keeps the resolver's refusal.
 */
export function decideScopeAssignmentWrite(
  actor: ActorContext,
  scope: AssignmentScope,
): ScopeAssignmentWriteDecision {
  const decision = resolveAssignmentWriteAuthority(actor, scope);
  if (decision.allowed) return { allowed: true, road: "grant", via: decision.via };
  if (decision.reason === "invalid-scope") return decision;
  if (actor.platformRole === "platform_admin" && scope.scopeKind !== "user") {
    const reason = platformAdminBypassReasonForScope(scope);
    if (reason) return { allowed: true, road: "audited-bypass", reason };
  }
  return { allowed: false, reason: decision.reason };
}

/** Why a scope's assignments are read-only for this reader, in words. */
export function scopeAssignmentRefusalText(reason: AssignmentAuthorityRefusal): string {
  switch (reason) {
    case "workspace-requires-audited-bypass":
      return "Only a platform admin can change the workspace assignments.";
    case "scope-outside-actor-organization":
    case "not-an-organization-admin":
      return "Only an admin of this organization can change these assignments.";
    case "not-a-team-admin":
      return "Only an admin of this team can change these assignments.";
    case "not-a-project-admin":
      return "Only an admin or owner of this project can change these assignments.";
    case "not-self":
      return "Only the person these assignments belong to can change them.";
    default:
      return "These assignments can't be changed from this page.";
  }
}

/** One scope the workspace cross-scope editor shows, with the organization
 *  its authority is read in (`null` for the workspace tier and the personal
 *  scope, which are read against the session itself). */
export type WorkspaceEditorScope = {
  scope: ScopeSurfaceRef;
  orgId: string | null;
};

/**
 * The scopes the workspace page's per-agent editor shows: the true workspace
 * tier, the actor's own personal scope, then every organization of the
 * normative `WorkspaceVantage` with the teams and projects the vantage carries
 * for it, in the vantage's own order. Nothing outside the vantage appears.
 */
export function buildWorkspaceEditorScopes(vantage: WorkspaceVantage): WorkspaceEditorScope[] {
  const out: WorkspaceEditorScope[] = [
    { scope: { kind: "workspace" }, orgId: null },
    { scope: { kind: "personal" }, orgId: null },
  ];
  for (const org of vantage.organizations) {
    out.push({ scope: { kind: "organization", id: org.orgId }, orgId: org.orgId });
    for (const teamId of org.teamIds) {
      out.push({ scope: { kind: "team", id: teamId }, orgId: org.orgId });
    }
    for (const projectId of org.projectIds) {
      out.push({ scope: { kind: "project", id: projectId }, orgId: org.orgId });
    }
  }
  return out;
}

/** Two scope refs name the same scope. */
export function sameSurfaceScope(a: ScopeSurfaceRef, b: ScopeSurfaceRef): boolean {
  if (a.kind !== b.kind) return false;
  return !("id" in a) || a.id === (b as { id: string }).id;
}

// ---------------------------------------------------------------------------
// The context slot group's words (the drawing's Artifacts pane).
// ---------------------------------------------------------------------------

/** A slot's heading, from its manifest id: `brand-voice` → `Brand voice`. */
export function contextSlotTitle(slotId: string): string {
  const words = slotId
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_\-.]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  if (words.length === 0) return slotId;
  const [first, ...rest] = words;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(" ");
}

function withArticle(label: string): string {
  const lower = label.trim().toLowerCase();
  return `${/^[aeiou]/.test(lower) ? "an" : "a"} ${lower}`;
}

/** What a slot takes and its bounds: `Takes a brand kit · 1 required, at most 2`. */
export function contextSlotTakesText(
  kindLabels: readonly string[],
  minItems: number | undefined,
  maxItems: number | undefined,
): string {
  const kinds = kindLabels.length > 0 ? kindLabels.map(withArticle).join(" or ") : "an artifact";
  const min = typeof minItems === "number" && minItems > 0 ? `${minItems} required` : "optional";
  const bounds = typeof maxItems === "number" ? `${min}, at most ${maxItems}` : min;
  return `Takes ${kinds} · ${bounds}`;
}

/** The typeahead's placeholder for a slot: `Search brand kits…`. */
export function contextSlotSearchPlaceholder(kindLabels: readonly string[]): string {
  if (kindLabels.length !== 1) return "Search artifacts…";
  const lower = kindLabels[0].trim().toLowerCase();
  return `Search ${lower.endsWith("s") ? lower : `${lower}s`}…`;
}

/** The hint a slot at its upper bound shows; `null` below the bound. */
export function contextSlotBoundHint(count: number, maxItems: number | undefined): string | null {
  if (typeof maxItems !== "number" || count < maxItems) return null;
  return `${count} of ${maxItems} artifacts chosen. Remove one to choose another.`;
}

// ---------------------------------------------------------------------------
// The shapes the page and its actions exchange with the browser. Plain data:
// every field is re-derived on the server, and nothing here is trusted back.
// ---------------------------------------------------------------------------

/** What a write names. The server re-resolves every part of it. */
export type ScopeAssignmentActionTarget = {
  surface: ScopeAssignmentSurface;
  /** The scope the page is mounted under. */
  scope: ScopeSurfaceRef;
  vendor: string;
  name: string;
  /** The scope the write is for. On the workspace page one of its sections;
   *  elsewhere the page's own scope (or omitted). */
  section?: ScopeSurfaceRef | null;
};

/** Why a write or a search was refused. */
export type ScopeAssignmentActionRefusal =
  | "not-found"
  | "scope-not-on-this-page"
  | AssignmentAuthorityRefusal
  | "not-an-agent"
  | "eligibility-unreadable"
  | "assistants-take-skills-only"
  | "unknown-skill"
  | "not-assignable"
  | "cap-exceeded"
  | "unknown-slot"
  | "artifact-not-visible"
  | "incompatible-artifact"
  | "validation-unreadable"
  | "stale-order"
  | "audit-failed"
  | "network";

export type ScopeAssignmentActionResult = { ok: true } | { ok: false; reason: ScopeAssignmentActionRefusal };

export type ScopeAssignmentSearchResult<T> =
  | { ok: true; results: T[]; hasMore: boolean }
  | { ok: false; reason: ScopeAssignmentActionRefusal };

/** The condition of a chosen skill. */
export type ScopeAssignmentSkillStatus = "ok" | "archived" | "role-changed" | "missing" | "unavailable";

/** One chosen skill, as the Skills pane lists it. */
export type ScopeAssignmentSkillRow = {
  skillId: string;
  skillName: string;
  displayName: string;
  vendorName: string | null;
  status: ScopeAssignmentSkillStatus;
};

/** One skill the chooser offers. */
export type ScopeAssignmentSkillCandidate = {
  skillId: string;
  skillName: string;
  displayName: string;
  vendorName: string | null;
  status: "active" | "locked";
};

/** The condition of a chosen context artifact. */
export type ScopeAssignmentArtifactStatus = "ok" | "incompatible" | "deleted" | "not-visible";

/** One chosen context artifact. A row the reader may not see carries no title. */
export type ScopeAssignmentArtifactRow = {
  artifactId: string;
  title: string | null;
  kindLabel: string | null;
  status: ScopeAssignmentArtifactStatus;
};

/** One artifact a slot's chooser offers. */
export type ScopeAssignmentArtifactCandidate = {
  artifactId: string;
  title: string;
  kindLabel: string;
};

/** One declared slot, with what this scope assigned to it. */
export type ScopeAssignmentSlotGroup = {
  slotId: string;
  title: string;
  takesText: string;
  placeholder: string;
  maxItems: number | null;
  rows: ScopeAssignmentArtifactRow[];
};

/** Why a refused write is refused, in words that say what happened. */
export function scopeAssignmentActionRefusalText(reason: ScopeAssignmentActionRefusal): string {
  switch (reason) {
    case "not-found":
      return "this package is no longer available at this scope";
    case "scope-not-on-this-page":
      return "that scope is not part of this page";
    case "not-an-agent":
      return "this package can't be given assignments";
    case "eligibility-unreadable":
      // The gate reads an install row and a directory, never the registry
      // address; see `admissionMessage` in scope-assignment-page.server.ts.
      return "this package's install record couldn't be read";
    case "assistants-take-skills-only":
      return "assistants take skills only";
    case "unknown-skill":
    case "not-assignable":
      return "that skill is no longer available";
    case "cap-exceeded":
      return `the limit of ${SCOPE_ASSIGNMENT_SKILLS_PER_SCOPE} is already reached`;
    case "unknown-slot":
      return "the agent no longer declares that slot";
    case "artifact-not-visible":
      return "you can't see that artifact here";
    case "incompatible-artifact":
      return "that artifact is not the kind this slot takes";
    case "validation-unreadable":
      return "the agent's manifest or the artifact couldn't be read";
    case "stale-order":
      return "the list changed since this page loaded; reload it and try again";
    case "audit-failed":
      return "the audit record couldn't be written";
    case "network":
      return "the change couldn't be saved";
    default:
      return scopeAssignmentRefusalText(reason).replace(/\.$/, "").replace(/^Only/, "only");
  }
}
