// ---------------------------------------------------------------------------
// Install-time access target → policy mapping (cinatra#805).
//
// PURE module (no IO, no server-only) so the mapping is directly
// unit-testable. Used by installExtensionPackageFormAction to translate the
// pre-install access selection (org / team / project — the same target rows
// the agent InstallScopeDialog offers) into the AgentAuthPolicy shape the
// sanctioned install-time access contract (setExtensionInstallAccess)
// persists.
//
// Semantics (deliberate — see issue #805):
//  - The canonical `installed_extension` row for connector/artifact/workflow
//    stays ORG-ANCHORED (ownerLevel "organization") — the row identity is a
//    lookup key (resolveConnectorResource hard-codes it) and there is no
//    "project" owner level. The chosen audience is carried by the ACCESS
//    POLICY visibility tiers, which enforceExtensionAccess already evaluates
//    ("team:<id>" / "project:<id>" / workspace).
//  - organization target → per-kind default policy (workspace for these
//    kinds): return undefined so setExtensionInstallAccess applies
//    defaultAccessPolicyForKind — the one-click parity default.
//  - team / project target → all three visibility fields scoped to the
//    target; sharing disabled (matches the per-kind defaults).
// ---------------------------------------------------------------------------

import { z } from "zod";
import type { AgentAuthPolicy } from "@cinatra-ai/agents/auth-policy-types";

/** The kinds whose marketplace install offers the pre-install access selector. */
export const INSTALL_ACCESS_TARGET_KINDS = [
  "connector",
  "artifact",
  "workflow",
] as const;

export type InstallAccessTargetKind = (typeof INSTALL_ACCESS_TARGET_KINDS)[number];

export function isInstallAccessTargetKind(
  value: unknown,
): value is InstallAccessTargetKind {
  return (INSTALL_ACCESS_TARGET_KINDS as readonly string[]).includes(
    String(value),
  );
}

export type InstallAccessTarget = {
  level: "organization" | "team" | "project";
  id: string;
};

/**
 * Zod schema for the optional accessTarget the marketplace install action
 * accepts. `level` INTENTIONALLY omits "user" and "workspace" — they are not
 * selectable install targets (parity with the agent-at-scope schema).
 */
export const InstallAccessTargetSchema: z.ZodType<InstallAccessTarget> =
  z.object({
    level: z.enum(["organization", "team", "project"]),
    id: z.string().min(1),
  });

/**
 * Map the validated target to the install-time access policy.
 * Returns undefined for the organization target so the caller lets
 * setExtensionInstallAccess apply the per-kind default (workspace).
 */
export function accessTargetToInstallPolicy(
  target: InstallAccessTarget,
): AgentAuthPolicy | undefined {
  if (target.level === "organization") return undefined;
  const visibility =
    target.level === "team"
      ? (`team:${target.id}` as const)
      : (`project:${target.id}` as const);
  return {
    runListVisibility: visibility,
    runDataVisibility: visibility,
    runExecuteVisibility: visibility,
    allowRunSharing: false,
  };
}
