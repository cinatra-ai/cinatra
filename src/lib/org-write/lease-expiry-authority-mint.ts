import "server-only";
/**
 * cinatra#1940 P4 — the lease-expiry finalizer's SOLE minting module.
 *
 * Kept OUT of `agent-run-authority-mint.ts` (design review): the
 * finalizer's `"lease-expiry-finalizer"` purpose is deliberately narrowed to
 * `["run.lease-expire"]` alone (authority.ts), and its audit domain must stay
 * disjoint from normal run dispatch/execution — a shared mint module would
 * blur that boundary even though both ultimately call
 * `mintSystemWriteAuthority`. This is the ONE R2-allowlisted site (see
 * `scripts/audit/org-write-boundary-gate.mjs`'s `SYSTEM_MINT_ALLOWLIST`) that
 * exposes `mintLeaseExpiryFinalizerAuthority`.
 */
import type { OrgWriteAuthority } from "@cinatra-ai/org-write-kernel";
import { mintSystemWriteAuthority } from "./authority";

/** The lease-expiry finalizer (`packages/agents/src/lease-expiry-finalizer.ts`)
 *  settling an EXPIRED archive lease to terminal state under the exclusive
 *  fence. No session, no run identity — a purpose-scoped system authority
 *  holding ONLY `run.lease-expire` (least privilege; the S2 placeholder grant
 *  was never exercisable and is narrowed by cinatra#1940 P2). */
export function mintLeaseExpiryFinalizerAuthority(orgId: string): OrgWriteAuthority {
  return mintSystemWriteAuthority("lease-expiry-finalizer", orgId);
}
