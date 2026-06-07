import "server-only";

// ---------------------------------------------------------------------------
// Uniform install-time access contract.
//
// ONE typed entry the install / import flow calls for ANY extension kind to
// set "who can access/use this extension" at install time. Wraps the
// polymorphic writes (access policy + installer pointer + co-owner seeding)
// behind a single call so every kind configures access the same way.
//
// This is the API the live runtime extension installer MUST call
// instead of per-kind defaults. See https://docs.cinatra.ai/references/platform/extension-access-contract/.
// ---------------------------------------------------------------------------

import type { AgentAuthPolicy } from "@cinatra-ai/agents/auth-policy";

import type { ExtensionKind } from "./permissions-kind-hooks";
import { writeExtensionInstallAccessAtomic } from "./permissions-store";

// ---------------------------------------------------------------------------
// Per-kind install-time defaults.
//
// connector / artifact / workflow default to "workspace" (every same-org
// member may use; the installer can tighten to "admin" at install). The
// agent / skill kinds keep an "owner"-scoped default — their existing install
// flows pass an explicit policy, this default is only the fail-safe.
// ---------------------------------------------------------------------------

const WORKSPACE_DEFAULT: AgentAuthPolicy = Object.freeze({
  runListVisibility: "workspace",
  runDataVisibility: "workspace",
  runExecuteVisibility: "workspace",
  allowRunSharing: false,
}) as AgentAuthPolicy;

const OWNER_DEFAULT: AgentAuthPolicy = Object.freeze({
  runListVisibility: "owner",
  runDataVisibility: "owner",
  runExecuteVisibility: "owner",
  allowRunSharing: false,
}) as AgentAuthPolicy;

const KIND_DEFAULT_ACCESS_POLICY: Record<ExtensionKind, AgentAuthPolicy> = {
  agent_run: OWNER_DEFAULT,
  agent_template: OWNER_DEFAULT,
  skill_package: OWNER_DEFAULT,
  skill: OWNER_DEFAULT,
  connector: WORKSPACE_DEFAULT,
  artifact: WORKSPACE_DEFAULT,
  workflow: WORKSPACE_DEFAULT,
};

export function defaultAccessPolicyForKind(kind: ExtensionKind): AgentAuthPolicy {
  return KIND_DEFAULT_ACCESS_POLICY[kind];
}

export type ExtensionInstallAccessInput = {
  kind: ExtensionKind;
  /** Canonical resource_id (installed_extension.id for connector/artifact/workflow). */
  resourceId: string;
  /** Explicit access policy; falls back to the per-kind default when omitted. */
  policy?: AgentAuthPolicy;
  /** Additional co-owner user ids to seed at install. */
  coOwnerUserIds?: string[];
  /** The installer / primary owner. */
  installedByUserId: string | null;
  /** Audit attribution for co-owner grants; defaults to the installer. */
  grantedBy?: string | null;
};

/**
 * Set install-time access for an extension. The sanctioned write path for the
 * connector / artifact / workflow kinds; a thin convenience for the others
 * (whose existing install flows pass an explicit policy). Best-effort legacy
 * projection hooks fire after the canonical write so kind-specific readers
 * stay in sync — hook failures are logged, never thrown (the canonical write
 * is authoritative).
 *
 * The supplied policy is zod-validated BEFORE any write (a malformed visibility
 * string would otherwise persist and be denied at read time — defense in
 * depth). The canonical writes (access policy + installer pointer + seed
 * co-owners) run in ONE transaction via writeExtensionInstallAccessAtomic, so a
 * mid-write failure leaves NO partially-configured access. Legacy projection
 * hooks (afterPolicyWrite / afterInstallerSet / afterCoOwnerAdd) run AFTER the
 * atomic canonical write and are best-effort (logged, never thrown) — they are
 * compatibility mirrors, not part of the authoritative unit, and are no-ops for
 * the connector/artifact/workflow kinds.
 */
export async function setExtensionInstallAccess(
  input: ExtensionInstallAccessInput,
): Promise<void> {
  const requested = input.policy ?? defaultAccessPolicyForKind(input.kind);
  // Validate up front — reject a malformed policy rather than persisting an
  // unknown visibility value that enforceExtensionAccess would later deny.
  const { AgentAuthPolicySchema } = await import("@cinatra-ai/agents/auth-policy");
  const policy = AgentAuthPolicySchema.parse(requested);

  const grantedBy = input.grantedBy ?? input.installedByUserId;
  const coOwners = (input.coOwnerUserIds ?? [])
    .filter((userId) => userId && userId !== input.installedByUserId)
    .map((userId) => ({ userId, grantedBy: grantedBy ?? userId }));

  // Atomic canonical write — policy + installer + co-owners in one transaction.
  await writeExtensionInstallAccessAtomic({
    resourceKind: input.kind,
    resourceId: input.resourceId,
    policy,
    installedByUserId: input.installedByUserId,
    coOwners,
  });

  // Best-effort legacy projections (lazy-import the hook chain so callers
  // needing only defaultAccessPolicyForKind don't pull skill/agent store deps).
  const { getExtensionKindHooks } = await import("./permissions-kind-hooks");
  const hooks = await getExtensionKindHooks(input.kind);
  const warn = (which: string, err: unknown) =>
    // eslint-disable-next-line no-console
    console.warn(
      `[install-access-contract] ${which} hook failed for ${input.kind}:${input.resourceId}:`,
      err instanceof Error ? err.message : String(err),
    );
  if (hooks.afterPolicyWrite) {
    try {
      await hooks.afterPolicyWrite(input.resourceId, policy);
    } catch (err) {
      warn("afterPolicyWrite", err);
    }
  }
  if (hooks.afterInstallerSet) {
    try {
      await hooks.afterInstallerSet(input.resourceId, input.installedByUserId);
    } catch (err) {
      warn("afterInstallerSet", err);
    }
  }
  for (const co of coOwners) {
    if (hooks.afterCoOwnerAdd) {
      try {
        await hooks.afterCoOwnerAdd(input.resourceId, co.userId, co.grantedBy);
      } catch (err) {
        warn("afterCoOwnerAdd", err);
      }
    }
  }
}
