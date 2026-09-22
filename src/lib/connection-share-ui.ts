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
//   • `default:<scope>` on the UNTOUCHED owner-only seed → the picker opens
//     PRE-SELECTED to the recommended scope, and the recommendation line sits
//     under it in the words of section II of the connectors drawing ("This
//     connector recommends sharing with your organization ... Currently: only
//     you."). The pre-selection shares nothing: the grant is written only when
//     the owner presses Save, and the owner may first take the recommended row
//     back to Only me. The first explicit save clears the seed marker, so a
//     stored owner choice is never overridden (codex round-0 finding 1). A
//     recommendation the write gate would refuse (a workspace or organization
//     scope on a connection of no organization) is not stated, and a seed that
//     already shares is never narrowed by one (cinatra#3408).
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
      /**
       * The value the picker opens on: the recommended scope while the
       * recommendation applies, otherwise the STORED grant.
       */
      value: string;
      /** Present when the connector recommends a scope the stored grant is not. */
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

/**
 * How the recommendation line names each recommended scope. A workspace grant
 * on a connection reaches exactly the connection's own organization: the use
 * gate denies every actor of another organization, and the write gate refuses
 * a workspace grant on a connection of no organization. So the line names it
 * as section II of the connectors drawing does, "your organization"
 * (cinatra#3408).
 */
const RECOMMENDED_SCOPE_LABEL: Record<ResolvedConnectorAccessDeclaration["scope"], string> = {
  ...SCOPE_LABEL,
  workspace: "your organization",
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

  // Multi-scope W1: runListVisibility is a token array; read the first token
  // for the single-select share surface (W3 renders the multi-scope summary).
  const stored: AgentAuthPolicyVisibility =
    storedPolicy?.runListVisibility?.[0] ?? "owner";

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

  // default / null-declaration semantics: grants govern. The RECOMMENDATION
  // applies only while the stored policy is the untouched connect seed AND
  // that seed is owner-only: the line ends "Currently: only you.", and a seed
  // that already shares (an app-scope row's workspace seed) is never narrowed
  // by a proposal.
  if (
    declaration?.mode === "default" &&
    isUntouchedSeed(storedPolicy) &&
    (storedPolicy?.runListVisibility ?? []).every((v) => v === "owner")
  ) {
    const scope = declaration.scope;
    // EXPLICIT EXCEPTION to acceptance item 1 of cinatra#3408. A connection of
    // NO organization (a legacy row stored before cinatra#3397 stamped the
    // organization, or the row of a person of no organization) gets no
    // recommendation line and no pre-selection, although its seed is
    // untouched. The reason is the save path: the connection kind's write gate
    // refuses a workspace or organization grant on such a row ("invalid_locus",
    // `validatePolicyWrite` in packages/extensions/src/permissions-kind-hooks.ts).
    // A pre-selected scope that Save always refuses is worse than no proposal,
    // and "your organization" would name nothing. So the picker stays on the
    // stored owner scope, which the gate accepts. Pinned by
    // src/lib/__tests__/connection-share-ui-no-organization-exception.test.ts.
    const recommended =
      scope === "user"
        ? "owner"
        : scope === "workspace" && identity.organizationId
          ? "workspace"
          : scope === "admin"
            ? "admin"
            : scope === "organization" &&
                identity.organizationId &&
                scopes.orgs.some((o) => o.id === identity.organizationId)
              ? `org:${identity.organizationId}`
              : "owner"; // id-less team/project, or no organization → keep owner
    const differs = recommended !== stored;
    return {
      surface: "editable",
      // The picker opens PRE-SELECTED to the recommended scope; the line
      // under it says nothing is shared until Save and that the stored grant
      // is still only the owner (cinatra#3408).
      value: recommended,
      recommendationNote: differs
        ? `This connector recommends sharing with ${RECOMMENDED_SCOPE_LABEL[scope]} \u2014 nothing is shared until you save. Currently: only you.`
        : scope === "team" || scope === "project"
          ? `This connector recommends sharing with ${SCOPE_LABEL[scope]} of your choice — nothing is shared until you save.`
          : undefined,
    };
  }

  return { surface: "editable", value: stored };
}
