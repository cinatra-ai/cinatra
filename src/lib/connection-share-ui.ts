import "server-only";

// ---------------------------------------------------------------------------
// Share-surface decision helpers for per-connection grants (cinatra#953 W3).
//
// The host's ConnectionSharingSection resolves each connection's declared
// access ceiling (W1 cache, via the use-gate's resolution) and this module
// folds it — PURELY — into what the six-scope picker renders:
//
//   • `only:"user"` (or an unreadable ceiling)  → NO sharing surface at all.
//   • `only:<scope>`                            → picker LOCKED at the
//     only-value: every option outside the ceiling is disabled (the UI
//     affordance); the write path re-rejects with the typed
//     `scope_locked_by_connector` (the enforcement).
//   • `default:<scope>` on the UNTOUCHED seed   → the recommendation is
//     PRE-SELECTED (never auto-shares — nothing changes until the owner
//     explicitly saves; the first explicit save clears the seed marker, so a
//     stored owner choice is never overridden — codex round-0 finding 1).
//
// The option-value vocabulary is the picker's: "owner" | "workspace" |
// "admin" | `org:<id>` | `team:<id>` | `project:<id>` — the same enforced
// tokens `evaluateExtensionAccess` evaluates, sourced from the actor's REAL
// memberships (AvailableScopes).
// ---------------------------------------------------------------------------

import type { AgentAuthPolicy, AgentAuthPolicyVisibility } from "@cinatra-ai/agents/auth-policy";
import type { NangoConnectionIdentity } from "@cinatra-ai/extensions/connection-identity-store";
import type { ResolvedConnectorAccessDeclaration } from "@cinatra-ai/sdk-extensions/access-config";
import type { AvailableScopes } from "@/components/access-scope";
import { visibilityWithinCeiling } from "@/lib/connection-use-gate";

/** Every concrete option value the hierarchical picker offers for `scopes`. */
export function allPickerValues(scopes: AvailableScopes): string[] {
  return [
    "owner",
    ...scopes.projects.map((p) => `project:${p.id}`),
    ...scopes.orgs.flatMap((o) => o.teams.map((t) => `team:${t.id}`)),
    ...scopes.orgs.map((o) => `org:${o.id}`),
    "workspace",
    "admin",
  ];
}

export type ConnectionShareSurface =
  | { surface: "hidden" }
  | {
      surface: "locked";
      /** The value the locked picker renders. */
      value: string;
      disabledScopes: string[];
      disabledReasons: Record<string, string>;
      note: string;
    }
  | {
      surface: "editable";
      /** The value the picker opens on (stored, or the seed recommendation). */
      value: string;
      /** Present when the seed recommendation pre-selects a broader value. */
      recommendationNote?: string;
    };

const SCOPE_LABEL: Record<ResolvedConnectorAccessDeclaration["scope"], string> = {
  user: "only you",
  project: "a project",
  team: "a team",
  organization: "your organization",
  workspace: "the whole workspace",
  admin: "workspace admins",
};

/** Marker written by the connect-time grant seed; stripped (zod) by the first
 * explicit save. Read defensively — the column is jsonb. */
function isUntouchedSeed(policy: AgentAuthPolicy | null): boolean {
  return policy !== null && (policy as { seededDefault?: unknown }).seededDefault === true;
}

/**
 * Decide the share surface for one connection.
 *
 * `declaration` is the resolved W1 cache value (null = pre-reader row →
 * default semantics); pass `unresolved: true` when the package row could not
 * be resolved at all — the surface hides (the gate would fail closed anyway).
 */
export function decideConnectionShareSurface(input: {
  identity: Pick<NangoConnectionIdentity, "organizationId">;
  declaration: ResolvedConnectorAccessDeclaration | null;
  unresolved?: boolean;
  storedPolicy: AgentAuthPolicy | null;
  scopes: AvailableScopes;
}): ConnectionShareSurface {
  const { identity, declaration, unresolved, storedPolicy, scopes } = input;
  if (unresolved) return { surface: "hidden" };

  const stored: AgentAuthPolicyVisibility =
    storedPolicy?.runListVisibility ?? "owner";

  if (declaration?.mode === "only") {
    if (declaration.scope === "user") return { surface: "hidden" };
    const scope = declaration.scope;
    const values = allPickerValues(scopes);
    const disabledScopes = values.filter(
      (v) =>
        !visibilityWithinCeiling(
          v as AgentAuthPolicyVisibility,
          scope,
          identity.organizationId,
        ),
    );
    const note = `Locked by this connector: access is limited to ${SCOPE_LABEL[scope]} (only:"${scope}").`;
    const disabledReasons = Object.fromEntries(disabledScopes.map((v) => [v, note]));
    // Render the stored grant when it is within the ceiling; otherwise the
    // canonical only-value (admin → "admin", organization → the owning org,
    // workspace → "workspace"; team/project have no single canonical id →
    // "owner", with the in-ceiling rows left enabled to pick a concrete one).
    const storedWithin = visibilityWithinCeiling(stored, scope, identity.organizationId);
    const canonical =
      scope === "admin"
        ? "admin"
        : scope === "workspace"
          ? "workspace"
          : scope === "organization" && identity.organizationId
            ? `org:${identity.organizationId}`
            : "owner";
    return {
      surface: "locked",
      value: storedWithin ? stored : canonical,
      disabledScopes,
      disabledReasons,
      note,
    };
  }

  // default / null-declaration semantics: grants govern; the RECOMMENDATION
  // pre-selects only while the stored policy is the untouched connect seed.
  if (declaration?.mode === "default" && isUntouchedSeed(storedPolicy)) {
    const scope = declaration.scope;
    const recommended =
      scope === "user"
        ? "owner"
        : scope === "workspace"
          ? "workspace"
          : scope === "admin"
            ? "admin"
            : scope === "organization" &&
                identity.organizationId &&
                scopes.orgs.some((o) => o.id === identity.organizationId)
              ? `org:${identity.organizationId}`
              : "owner"; // id-less team/project recommendation → keep owner
    const differs = recommended !== stored;
    return {
      surface: "editable",
      value: differs ? recommended : stored,
      recommendationNote: differs
        ? `This connector recommends sharing with ${SCOPE_LABEL[scope]} — nothing is shared until you save. Currently: only you.`
        : scope === "team" || scope === "project"
          ? `This connector recommends sharing with ${SCOPE_LABEL[scope]} of your choice — nothing is shared until you save.`
          : undefined,
    };
  }

  return { surface: "editable", value: stored };
}
