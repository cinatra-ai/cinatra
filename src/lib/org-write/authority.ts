import "server-only";
/**
 * Org-write authority resolvers — cinatra#1938 (archive epic S2).
 *
 * The host-side half of the kernel seam: everything that mints an
 * `OrgWriteAuthority` for `guardOrgMutation` / guarded batches lives here.
 * Three sources, verified independently of the kernel's lifecycle table
 * (BOTH must pass — actor authorization is not lifecycle capability):
 *
 *   - session: org membership + the authz permission map;
 *   - verified run: the agent_runs row itself, admitted ONLY under the
 *     kernel's shared live-attempt predicate with the caller's claimed
 *     attempt id matching the row's CURRENT one (a stale worker from a
 *     previous attempt is refused — design review);
 *   - system: purpose-scoped minting for the dispatcher's own writes. The
 *     restricted-importer discipline is enforced by the S2 boundary gate;
 *     S4 wires and audits per-job use.
 *
 * VerifiedRunRef unforgeability follows the kernel permit pattern: a
 * module-private WeakSet, not a type brand.
 */
import {
  isLiveAttempt,
  type OrgWriteAuthority,
  type OrgWriteCapability,
} from "@cinatra-ai/org-write-kernel";
import { roleHasPermission, type Role } from "@/lib/authz/policies";
import type { Permission } from "@/lib/authz/permissions";
import { resolveOrgRoleForUser } from "@/lib/auth-session";

/** Session capability rules: membership-only capabilities need any org role;
 *  management capabilities need the mapped authz permission. */
const SESSION_PERMISSION_FOR: Record<OrgWriteCapability, Permission | "member"> = {
  "content.write": "member",
  "run.execute": "member",
  "run.complete": "member",
  "membership.write": "organization.manageMembers",
  "org.settings": "organization.update",
  "org.lifecycle": "organization.archive",
};

export class OrgWriteAuthorityError extends Error {
  constructor(reason: string) {
    super(`org-write-authority: ${reason}`);
    this.name = "OrgWriteAuthorityError";
  }
}

/** Membership-grounded session authority. Fail-closed: no role, no authority. */
export async function verifySessionAuthority(
  userId: string,
  orgId: string,
): Promise<OrgWriteAuthority> {
  const role = await resolveOrgRoleForUser(orgId, userId);
  if (role === undefined) {
    throw new OrgWriteAuthorityError(`user ${userId} is not a member of ${orgId}`);
  }
  return sessionAuthorityFromResolvedRole(orgId, role);
}

/**
 * Sync session-mint for call sites that ALREADY resolved the membership role
 * for the SAME (userId, orgId) pair they stamp on the surrounding frame — the
 * MCP transport resolves it once at context-build (cinatra#1939 S3) and must
 * not pay a second membership read per request. The resolved role's existence
 * IS the membership proof; capability rules are byte-identical to
 * `verifySessionAuthority` (this is its extracted body).
 */
export function sessionAuthorityFromResolvedRole(
  orgId: string,
  role: Role,
): OrgWriteAuthority {
  return {
    orgId,
    can: (capability) => {
      const rule = SESSION_PERMISSION_FOR[capability];
      if (rule === "member") return true;
      return roleHasPermission(role, rule);
    },
  };
}

// ---------------------------------------------------------------------------
// Verified run authority
// ---------------------------------------------------------------------------

export interface VerifiedRunRef extends OrgWriteAuthority {
  readonly runId: string;
  readonly executionAttemptId: string;
}

const VERIFIED_RUN_REFS = new WeakSet<object>();

/** Runtime check mirroring the kernel permit discipline: a cast cannot forge
 *  a VerifiedRunRef — only verifyRunAuthority mints WeakSet members. */
export function isVerifiedRunRef(value: unknown): value is VerifiedRunRef {
  return typeof value === "object" && value !== null && VERIFIED_RUN_REFS.has(value);
}

/** Narrow row projection the verifier needs (DI seam for tests). The policy
 *  columns ride along so the capability ceiling can consult them. */
export interface RunRowForAuthority {
  readonly orgId: string;
  readonly status: string;
  readonly executionAttemptId: string | null;
  readonly executionDeadlineAt: Date | string | null;
  readonly humanWaitAttemptId: string | null;
  /** agent_runs.authPolicy / oboCeiling snapshots (opaque here; evaluated by
   *  the ceiling hook — S4 supplies the real evaluator). */
  readonly authPolicy?: unknown;
  readonly oboCeiling?: unknown;
}

export interface VerifyRunAuthorityDeps {
  readRunRow(runId: string): Promise<RunRowForAuthority | null>;
  nowMs(): number;
  /**
   * The run-capability CEILING: consulted IN ADDITION to
   * the structural floor below — it can only restrict, never widen. S4 (the
   * system-authority slice) wires the real authPolicy/oboCeiling evaluator;
   * until a caller supplies one, the conservative default DENIES nothing
   * beyond the floor but is an explicit, visible seam rather than an implicit
   * grant. S2 has no production callers either way (dark slice).
   */
  evaluateRunCapabilityCeiling?(
    row: RunRowForAuthority,
    capability: OrgWriteCapability,
  ): boolean;
}

/** Run capabilities: a verified live run may write content and land its own
 *  outputs; it holds NO management or lifecycle capability, ever. */
const RUN_CAPABILITIES: ReadonlySet<OrgWriteCapability> = new Set([
  "content.write",
  "run.complete",
]);

export async function verifyRunAuthority(
  input: { runId: string; orgId: string; claimedAttemptId: string },
  deps: VerifyRunAuthorityDeps,
): Promise<VerifiedRunRef> {
  const row = await deps.readRunRow(input.runId);
  if (row === null) {
    throw new OrgWriteAuthorityError(`run ${input.runId} not found`);
  }
  if (row.orgId !== input.orgId) {
    throw new OrgWriteAuthorityError("run belongs to a different organization");
  }
  if (
    row.executionAttemptId === null ||
    row.executionAttemptId !== input.claimedAttemptId
  ) {
    throw new OrgWriteAuthorityError(
      "claimed attempt id does not match the run's current attempt",
    );
  }
  if (!isLiveAttempt(row, { nowMs: deps.nowMs() })) {
    throw new OrgWriteAuthorityError(
      "run is not inside a live attempt (parked, pre-dispatch, expired, or terminal)",
    );
  }
  const ceiling = deps.evaluateRunCapabilityCeiling ?? (() => true);
  const ref: VerifiedRunRef = Object.freeze({
    orgId: input.orgId,
    runId: input.runId,
    executionAttemptId: row.executionAttemptId,
    // Floor AND ceiling: the structural run floor (content + own completion)
    // intersected with the policy ceiling — the hook can only restrict.
    can: (capability: OrgWriteCapability) =>
      RUN_CAPABILITIES.has(capability) && ceiling(row, capability),
  });
  VERIFIED_RUN_REFS.add(ref);
  return ref;
}

// ---------------------------------------------------------------------------
// System authority (dispatcher-only minting primitive)
// ---------------------------------------------------------------------------

/** Purpose → capability grants. Deliberately narrow; S4 (system authority)
 *  wires per-job use and audits it. Extending this map is a design event,
 *  not a convenience. */
const SYSTEM_PURPOSE_CAPABILITIES: Record<string, readonly OrgWriteCapability[]> = {
  /** The S6 archive/unarchive transaction itself. */
  "org-lifecycle-transition": ["org.lifecycle"],
  /** The S3/S4 lease-expiry finalizer landing terminal transitions. */
  "lease-expiry-finalizer": ["run.execute", "run.complete"],
  /** The committed extension archive/restore transition's dashboard hook
   *  (cinatra#1939 wave 1): archives/restores that org's extension-shipped
   *  dashboards AFTER install/uninstall authz gated the transition upstream.
   *  Content-only — the hook can never touch membership/settings/lifecycle.
   *  Sole minting site: src/lib/dashboards/extension-dashboard-lifecycle.ts
   *  (R2-allowlisted in the boundary gate). */
  "extension-dashboard-lifecycle": ["content.write"],
};

export type SystemWritePurpose = keyof typeof SYSTEM_PURPOSE_CAPABILITIES;

/**
 * DISPATCHER-ONLY. Importing this from anywhere outside the allow-listed
 * dispatcher/finalizer modules is a boundary-gate violation (S2 gate; the
 * allowlist is part of the gate script, not this module). The returned
 * authority is purpose-scoped and org-bound.
 */
export function mintSystemWriteAuthority(
  purpose: SystemWritePurpose,
  orgId: string,
): OrgWriteAuthority {
  const grants = SYSTEM_PURPOSE_CAPABILITIES[purpose];
  if (!grants) {
    throw new OrgWriteAuthorityError(`unknown system write purpose ${String(purpose)}`);
  }
  return {
    orgId,
    can: (capability) => grants.includes(capability),
  };
}

// NOTE (dark-slice discipline): S2 ships NO production `VerifyRunAuthorityDeps`
// wiring — the slice has zero product callers by design. The first perimeter
// caller (S3) supplies the pooled-db run-row reader; tests use the DI seam.
