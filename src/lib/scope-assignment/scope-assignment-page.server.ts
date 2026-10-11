import "server-only";

// ---------------------------------------------------------------------------
// THE PER-SCOPE ASSIGNMENT PAGE'S MODEL (cinatra#2814, per-scope assignment
// S2).
//
// What the settings route renders at `<scope-base>/agents/<vendor>/<package>/
// settings` and `<scope-base>/assistants/<vendor>/<slug>/settings`: the
// resolved package, the pane the address asks for, and one section per scope
// the page shows (the route's own scope, or on the workspace page every scope
// of the reader's `WorkspaceVantage`). Each section carries what that exact
// scope assigned and S1's write decision for it, so the page renders a write
// control exactly where the resolver would accept the write.
//
// `null` means the reader reaches no such package at this scope, and the route
// answers not found. A forged pair, an uninstalled package, an assistant
// addressed through the agents tree and a scope outside the reader's
// memberships all end there.
// ---------------------------------------------------------------------------

import { SCOPE_SURFACE_ENTITY_FALLBACK, SCOPE_SURFACE_KIND_LABEL, type ScopeSurfaceRef } from "@/lib/scope-surfaces";
import {
  normalizeScopeAssignmentTab,
  scopeAssignmentRefusalText,
  type ScopeAssignmentActionTarget,
  type ScopeAssignmentSkillRow,
  type ScopeAssignmentSlotGroup,
  type ScopeAssignmentSurface,
  type ScopeAssignmentTab,
} from "./scope-assignment-model";
import {
  defaultScopeAssignmentReadDeps,
  readScopeSkillRows,
  readScopeSlotGroups,
  type ScopeAssignmentReadDeps,
} from "./scope-assignment-reads.server";
import {
  defaultScopeAssignmentTargetDeps,
  resolveScopeAssignmentTarget,
  scopeNameKey,
  type ScopeAssignmentTargetDeps,
} from "./scope-assignment-target.server";
import { readTrustedContextSlots, type TrustedContextSlots } from "./context-slot-manifest.server";

/** A section's write state, as the page renders it. */
export type ScopeAssignmentSectionWrite =
  | { allowed: true; road: "grant" | "audited-bypass" }
  | { allowed: false; message: string };

export type ScopeAssignmentSectionModel = {
  key: string;
  scope: ScopeSurfaceRef;
  /** `Team · Growth`, `Workspace`, `Personal`. */
  label: string;
  write: ScopeAssignmentSectionWrite;
  /** The chosen skills (the Skills pane). */
  skills: ScopeAssignmentSkillRow[] | null;
  /** The declared slots with their chosen artifacts (the Artifacts pane). */
  slots: ScopeAssignmentSlotGroup[] | null;
};

export type ScopeAssignmentPageModel = {
  surface: ScopeAssignmentSurface;
  tab: ScopeAssignmentTab;
  routeScope: ScopeSurfaceRef;
  /** The resolved extension package, `@vendor/name`. */
  packageName: string;
  displayName: string;
  /** The header's kicker: the scope being configured. */
  scopeLabel: string;
  /** Whether this is the workspace page's cross-scope editor. */
  crossScope: boolean;
  /** What every write on this page names; the server re-resolves it. */
  target: ScopeAssignmentActionTarget;
  /** S1's assignment-target admission, in words when it refuses. */
  admission: { ok: true } | { ok: false; message: string };
  /** The trusted manifest's state (agents on the Artifacts pane only). */
  manifest: "ok" | "no-slots" | "unreadable" | null;
  sections: ScopeAssignmentSectionModel[];
};

export type ScopeAssignmentPageInput = {
  surface: ScopeAssignmentSurface;
  scope: ScopeSurfaceRef;
  vendor: string;
  name: string;
  tab: string | readonly string[] | null | undefined;
};

export type ScopeAssignmentPageDeps = {
  target: ScopeAssignmentTargetDeps;
  reads: ScopeAssignmentReadDeps;
  readSlots: (packageName: string) => Promise<TrustedContextSlots>;
};

export const defaultScopeAssignmentPageDeps: ScopeAssignmentPageDeps = {
  target: defaultScopeAssignmentTargetDeps,
  reads: defaultScopeAssignmentReadDeps,
  readSlots: (packageName) => readTrustedContextSlots(packageName),
};

/** A scope's label: the drawing's `Team · Growth`; the id's first eight
 *  characters plus an ellipsis while the name is unavailable. */
export function scopeAssignmentScopeLabel(
  scope: ScopeSurfaceRef,
  names: Readonly<Record<string, string>>,
): string {
  if (!("id" in scope)) return SCOPE_SURFACE_ENTITY_FALLBACK[scope.kind];
  const name = names[scopeNameKey(scope)] ?? `${scope.id.slice(0, 8)}…`;
  return `${SCOPE_SURFACE_KIND_LABEL[scope.kind]} · ${name}`;
}

function admissionMessage(reason: "not-an-agent" | "eligibility-unreadable"): string {
  // The refusal names what the gate actually read. It reads the package's
  // canonical install row and the extension directory on disk; the registry
  // ADDRESS takes no part in it, so the sentence must not point a reader there.
  return reason === "not-an-agent"
    ? "This package can't be given assignments."
    : "This package's install record couldn't be read, so these assignments can't be changed right now.";
}

export async function loadScopeAssignmentPage(
  input: ScopeAssignmentPageInput,
  deps: ScopeAssignmentPageDeps = defaultScopeAssignmentPageDeps,
): Promise<ScopeAssignmentPageModel | null> {
  const target = await resolveScopeAssignmentTarget(
    { surface: input.surface, scope: input.scope, vendor: input.vendor, name: input.name },
    deps.target,
  );
  if (!target) return null;
  const tab = normalizeScopeAssignmentTab(target.surface, input.tab);

  let manifest: ScopeAssignmentPageModel["manifest"] = null;
  let slots: Extract<TrustedContextSlots, { ok: true }>["slots"] = [];
  if (tab === "artifacts") {
    const read = await deps.readSlots(target.packageName);
    if (!read.ok) manifest = "unreadable";
    else if (read.slots.length === 0) manifest = "no-slots";
    else {
      manifest = "ok";
      slots = read.slots;
    }
  }

  const sections: ScopeAssignmentSectionModel[] = [];
  for (const section of target.sections) {
    const write: ScopeAssignmentSectionWrite = section.write.allowed
      ? { allowed: true, road: section.write.road }
      : { allowed: false, message: scopeAssignmentRefusalText(section.write.reason) };
    sections.push({
      key: scopeNameKey(section.scope),
      scope: section.scope,
      label: scopeAssignmentScopeLabel(section.scope, target.scopeNames),
      write,
      skills:
        tab === "skills"
          ? await readScopeSkillRows(target.packageName, section.assignmentScope, deps.reads)
          : null,
      slots:
        manifest === "ok"
          ? await readScopeSlotGroups(
              target.packageName,
              slots,
              section.assignmentScope,
              {
                orgId: section.orgId ?? target.activeOrgId,
                actor: section.actor,
                projectId: section.scope.kind === "project" ? section.scope.id : null,
              },
              deps.reads,
            )
          : null,
    });
  }

  return {
    surface: target.surface,
    tab,
    routeScope: target.routeScope,
    packageName: target.packageName,
    displayName: target.displayName,
    scopeLabel: scopeAssignmentScopeLabel(target.routeScope, target.scopeNames),
    crossScope: target.routeScope.kind === "workspace",
    target: {
      surface: target.surface,
      scope: target.routeScope,
      vendor: input.vendor,
      name: input.name,
    },
    admission: target.admission.ok
      ? { ok: true }
      : { ok: false, message: admissionMessage(target.admission.reason) },
    manifest,
    sections,
  };
}
