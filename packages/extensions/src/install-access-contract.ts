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
import {
  connectorAccessDeclarationTier,
  isResolvedConnectorAccessDeclaration,
} from "./canonical-types";

// ---------------------------------------------------------------------------
// Per-kind install-time defaults.
//
// artifact / workflow default to "workspace" (every same-org member may use;
// the installer can tighten to "admin" at install). The agent / skill kinds
// keep an "owner"-scoped default — their existing install flows pass an
// explicit policy, this default is only the fail-safe.
//
// The CONNECTOR kind has NO static default (cinatra#955 closing wave — the
// legacy `connector → WORKSPACE_DEFAULT` entry is deleted): a connector's
// install-time access derives from its own shipped `cinatra/config.json`
// declaration, cached on the canonical registration row by the install
// pipeline / boot registration BEFORE this contract runs.
// ---------------------------------------------------------------------------

// Multi-scope W1: visibility fields are non-empty token arrays. Inner arrays
// frozen too — these are shared-by-reference defaults.
const WORKSPACE_DEFAULT: AgentAuthPolicy = Object.freeze({
  runListVisibility: Object.freeze(["workspace"]),
  runDataVisibility: Object.freeze(["workspace"]),
  runExecuteVisibility: Object.freeze(["workspace"]),
  allowRunSharing: false,
}) as unknown as AgentAuthPolicy;

const ADMIN_DEFAULT: AgentAuthPolicy = Object.freeze({
  runListVisibility: Object.freeze(["admin"]),
  runDataVisibility: Object.freeze(["admin"]),
  runExecuteVisibility: Object.freeze(["admin"]),
  allowRunSharing: false,
}) as unknown as AgentAuthPolicy;

const OWNER_DEFAULT: AgentAuthPolicy = Object.freeze({
  runListVisibility: Object.freeze(["owner"]),
  runDataVisibility: Object.freeze(["owner"]),
  runExecuteVisibility: Object.freeze(["owner"]),
  allowRunSharing: false,
}) as unknown as AgentAuthPolicy;

const KIND_DEFAULT_ACCESS_POLICY: Record<
  Exclude<ExtensionKind, "connector">,
  AgentAuthPolicy
> = {
  agent_run: OWNER_DEFAULT,
  agent_template: OWNER_DEFAULT,
  skill_package: OWNER_DEFAULT,
  skill: OWNER_DEFAULT,
  artifact: WORKSPACE_DEFAULT,
  workflow: WORKSPACE_DEFAULT,
  // A connection is owner-bound (cinatra#950): creating one NEVER auto-shares —
  // `default` in cinatra/config.json only pre-selects at connect time; the
  // grant row starts owner-scoped and widens only by an explicit owner share.
  connection: OWNER_DEFAULT,
};

export function defaultAccessPolicyForKind(kind: ExtensionKind): AgentAuthPolicy {
  if (kind === "connector") {
    // Fail-closed: there is no static connector default (cinatra#955). The
    // connector install default derives from the package's cached
    // cinatra/config.json declaration — setExtensionInstallAccess resolves it
    // from the canonical row; nothing else may invent a connector policy.
    throw new Error(
      "[install-access-contract] the connector kind has no static access default " +
        "(cinatra#955) — its install policy derives from the cinatra/config.json " +
        "declaration cached on the canonical registration row.",
    );
  }
  return KIND_DEFAULT_ACCESS_POLICY[kind];
}

/**
 * Resolve the connector install-time default policy from the canonical row's
 * cached `cinatra/config.json` declaration (cinatra#955): the declaration's
 * 2-tier projection (`admin` scope → admin-only; every other scope →
 * workspace). FAIL-CLOSED: a connector row without a structurally valid
 * cached declaration throws — the caller must not fall back to a static
 * default that no longer exists.
 */
async function connectorInstallPolicyFromDeclaration(
  resourceId: string,
): Promise<AgentAuthPolicy> {
  const { readInstalledExtensionById } = await import("./canonical-store");
  const row = await readInstalledExtensionById(resourceId);
  if (!row || row.kind !== "connector") {
    throw new Error(
      `[install-access-contract] no canonical connector row for resource ${resourceId} — ` +
        "cannot derive the install-time access policy (cinatra#955).",
    );
  }
  const declaration = row.accessDeclaration ?? null;
  if (declaration === null || !isResolvedConnectorAccessDeclaration(declaration)) {
    throw new Error(
      `[install-access-contract] connector ${row.packageName} has no valid cached ` +
        "access declaration on its registration row — cannot derive the install-time " +
        "access policy (cinatra#955; the install pipeline caches it before access setup).",
    );
  }
  return connectorAccessDeclarationTier(declaration) === "admin"
    ? ADMIN_DEFAULT
    : WORKSPACE_DEFAULT;
}

export type ExtensionInstallAccessInput = {
  kind: ExtensionKind;
  /** Canonical resource_id (installed_extension.id for connector/artifact/workflow). */
  resourceId: string;
  /** Explicit access policy. When omitted: connector derives from the cached
   *  cinatra/config.json declaration (cinatra#955); other kinds fall back to
   *  the per-kind default. */
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
  const requested =
    input.policy ??
    (input.kind === "connector"
      ? // cinatra#955: the connector default derives from the package's OWN
        // cinatra/config.json declaration (cached on the canonical row by the
        // install pipeline / boot registration before access setup runs).
        await connectorInstallPolicyFromDeclaration(input.resourceId)
      : defaultAccessPolicyForKind(input.kind));
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
