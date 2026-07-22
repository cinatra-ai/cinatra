/**
 * Transaction-bound write permits — cinatra#1938 (archive epic S2).
 *
 * Unforgeability is RUNTIME, not type-level (codex-converged r0): every permit
 * the kernel mints is registered in a module-private WeakSet, and
 * `assertPermitUsable` checks membership before anything else — a value cast
 * with `as any as OrgWritePermit` is not in the set and fails. The phantom
 * brand below is compile-time ergonomics only; the WeakSet carries the claim.
 *
 * A permit is valid only (a) inside the guard callback that minted it (the
 * kernel revokes it in `finally` when the callback exits) and (b) for the
 * exact {txIdentity, orgId, capability, archiveEpoch} it was minted with.
 */
import type { OrgWriteCapability } from "./capabilities";

declare const ORG_WRITE_PERMIT_BRAND: unique symbol;

export interface OrgWritePermit {
  readonly [ORG_WRITE_PERMIT_BRAND]: true;
  readonly txIdentity: object;
  readonly orgId: string;
  readonly capability: OrgWriteCapability;
  readonly archiveEpoch: number;
}

const MINTED = new WeakSet<object>();
const LIVE = new WeakSet<object>();

/** Kernel-internal: mint a live permit. NOT exported from the package index —
 *  only the guard adapters call this. */
export function mintPermit(fields: {
  txIdentity: object;
  orgId: string;
  capability: OrgWriteCapability;
  archiveEpoch: number;
}): OrgWritePermit {
  const permit = Object.freeze({
    txIdentity: fields.txIdentity,
    orgId: fields.orgId,
    capability: fields.capability,
    archiveEpoch: fields.archiveEpoch,
  }) as unknown as OrgWritePermit;
  MINTED.add(permit);
  LIVE.add(permit);
  return permit;
}

/** Kernel-internal: revoke on guard-callback exit (commit OR throw). */
export function revokePermit(permit: OrgWritePermit): void {
  LIVE.delete(permit);
}

export class OrgWritePermitError extends Error {
  constructor(reason: string) {
    super(`org-write-kernel: permit unusable — ${reason}`);
    this.name = "OrgWritePermitError";
  }
}

/**
 * The assertion every raw writer makes before touching org data. Throws unless
 * the permit was minted by this kernel, is still inside its guard callback,
 * and matches the caller's transaction identity, org, capability and epoch.
 */
export function assertPermitUsable(
  permit: OrgWritePermit,
  expected: {
    txIdentity: object;
    orgId: string;
    capability: OrgWriteCapability;
    archiveEpoch: number;
  },
): void {
  if (!MINTED.has(permit)) {
    throw new OrgWritePermitError("not minted by the kernel (forged value)");
  }
  if (!LIVE.has(permit)) {
    throw new OrgWritePermitError("guard callback already exited");
  }
  if (permit.txIdentity !== expected.txIdentity) {
    throw new OrgWritePermitError("different transaction");
  }
  if (permit.orgId !== expected.orgId) {
    throw new OrgWritePermitError("different organization");
  }
  if (permit.capability !== expected.capability) {
    throw new OrgWritePermitError("different capability");
  }
  if (permit.archiveEpoch !== expected.archiveEpoch) {
    throw new OrgWritePermitError("archive epoch changed");
  }
}
