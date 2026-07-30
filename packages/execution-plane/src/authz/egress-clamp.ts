/**
 * Deployment egress CLAMP (exec-plane, epic #1705 D3).
 *
 * The voucher's egress policy is signed, so a client cannot forge one. That is
 * not the same as the client being allowed to CHOOSE it: the mint site resolves
 * the policy from tenant settings, and tenant settings must not be able to
 * exceed what the deployment the broker runs in permits. So the broker clamps
 * the signed policy against its own scoped-env maximum on ALL THREE axes —
 * a clamp on one axis must never leave another axis unclamped:
 *
 *   1. MODE      — tier order `none` < `allowlist` < `default_internet`; the
 *                  effective mode is the NARROWER of signed and maximum. A
 *                  deployment maximum that carries a host allowlist is
 *                  declaring a host ceiling, which `default_internet` ("any
 *                  host") cannot satisfy — so the mode also clamps down to
 *                  `allowlist` in that case.
 *   2. ALLOWLIST — set INTERSECTION under the same exact-or-dot-suffix host
 *                  grammar the gateway enforces, not a preference for one list.
 *   3. MAX BYTES — `min(signed, cap)`, where absent/0 means "no ceiling" on
 *                  either side.
 *
 * Every clamp is reported so the broker can AUDIT it: a tenant whose configured
 * tier is silently narrowed needs that visible in the audit trail, or the next
 * "why did egress fail" investigation has no evidence.
 *
 * Pure (no I/O) so it is exercised directly and shares nothing with the
 * gateway's own runtime path.
 */

import { hostMatchesAllowlist } from "../egress";
import type { EgressMode, EgressPolicy } from "../types";

/**
 * The maximum this DEPLOYMENT permits, independent of tenant settings. Sourced
 * from the broker's scoped environment (never from a tenant-editable store) —
 * that separation is the whole point of the clamp.
 */
export type EgressDeploymentMaximum = {
  /** Widest tier permitted here. */
  mode: EgressMode;
  /**
   * Deployment host ceiling. Present + non-empty ⇒ a hard host bound: the
   * effective mode can be at most `allowlist`, whatever the tier says.
   */
  allowlist?: string[];
  /** Hard per-job byte ceiling; absent/0 ⇒ no deployment ceiling. */
  maxBytesPerJob?: number;
};

/** Which axes were narrowed. Empty ⇒ the signed policy passed through intact. */
export type EgressClampAxis = "mode" | "allowlist" | "max_bytes";

export type EgressClampResult = {
  /** The policy the command actually runs under. */
  policy: EgressPolicy;
  clamped: EgressClampAxis[];
};

/** Narrow-to-wide tier order. */
const MODE_RANK: Record<EgressMode, number> = {
  none: 0,
  allowlist: 1,
  default_internet: 2,
};

function normalizeHosts(hosts: readonly string[] | undefined): string[] {
  if (!hosts) return [];
  const cleaned = hosts
    // The deployment maximum arrives from the broker's environment rather than a
    // validated wire payload, so a non-string entry is possible at runtime even
    // though the type says otherwise. DROP it instead of throwing at `.trim()`:
    // a clamp must narrow, never crash the command path (Codex round 1, finding 6).
    .filter((h): h is string => typeof h === "string")
    .map((h) => h.trim().toLowerCase().replace(/^\*\./, "").replace(/\.$/, ""))
    .filter((h) => h.length > 0);
  return [...new Set(cleaned)].sort();
}

/**
 * Normalize a byte ceiling to an integral value that MEANS what it says.
 *
 * `0`/absent means "no ceiling" everywhere downstream (`registerJobEgress` and
 * `gatewayEnvironment` both send `maxBytesPerJob ?? 0`, and the gateway reads 0
 * as uncapped). So flooring a positive fractional ceiling — `0.5` → `0` — would
 * turn the tightest possible ceiling into NO ceiling: a widening at exactly the
 * axis this function exists to bound (Codex round 1, finding 4). Any positive
 * value therefore floors to at least `1`, the smallest ceiling that is still a
 * ceiling; a non-finite or non-positive value is "no ceiling on this side".
 */
function normalizeByteCap(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.max(1, Math.floor(value));
}

/**
 * Intersect two host allowlists under the gateway's exact-or-dot-suffix
 * grammar. `undefined` means "no bound on this side" (the `default_internet`
 * case), so it intersects to the other side unchanged.
 *
 * An entry belongs in the intersection iff the OTHER list also permits it —
 * `hostMatchesAllowlist(entry, other)` is exactly "entry is equal to, or a
 * subdomain of, something the other list permits". Taking that from both
 * directions yields the exact intersection of the two permitted host SETS:
 * with `A=["pypi.org"]` and `D=["files.pypi.org"]` the result is
 * `["files.pypi.org"]` — the only hosts both sides allow — never `pypi.org`,
 * which would widen past the deployment ceiling.
 */
export function intersectAllowlists(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): string[] {
  const left = a === undefined ? undefined : normalizeHosts(a);
  const right = b === undefined ? undefined : normalizeHosts(b);
  if (left === undefined) return right === undefined ? [] : right;
  if (right === undefined) return left;
  const kept = new Set<string>();
  for (const host of left) {
    if (hostMatchesAllowlist(host, right as string[])) kept.add(host);
  }
  for (const host of right) {
    if (hostMatchesAllowlist(host, left as string[])) kept.add(host);
  }
  return [...kept].sort();
}

/**
 * Clamp a signed policy against the deployment maximum. `maximum` absent ⇒ the
 * signed policy passes through unchanged (a deployment that declares no ceiling
 * imposes none), and `clamped` is empty.
 */
export function clampEgressPolicy(
  signed: EgressPolicy,
  maximum?: EgressDeploymentMaximum,
): EgressClampResult {
  if (!maximum) return { policy: signed, clamped: [] };
  const clamped: EgressClampAxis[] = [];

  // --- axis 1: mode -------------------------------------------------------
  const maxHosts = normalizeHosts(maximum.allowlist);
  let mode: EgressMode =
    MODE_RANK[signed.mode] <= MODE_RANK[maximum.mode] ? signed.mode : maximum.mode;
  if (mode === "default_internet" && maxHosts.length > 0) {
    // A deployment host ceiling is incompatible with "any host".
    mode = "allowlist";
  }
  if (mode !== signed.mode) clamped.push("mode");

  const policy: EgressPolicy = { mode };

  // --- axis 2: allowlist --------------------------------------------------
  if (mode === "allowlist") {
    // `undefined` on a side means that side imposes no host bound: a signed
    // `default_internet` that was clamped down to `allowlist` contributes no
    // list of its own, so the deployment ceiling stands alone.
    const signedHosts = signed.mode === "allowlist" ? normalizeHosts(signed.allowlist) : undefined;
    const maximumHosts = maxHosts.length > 0 ? maxHosts : undefined;
    const effective = intersectAllowlists(signedHosts, maximumHosts);
    policy.allowlist = effective;
    // A signed policy with NO host bound (`default_internet` clamped down to
    // `allowlist`) always narrows on this axis: an unbounded host set became a
    // finite list — including the empty list, which denies every host.
    const narrowed =
      signedHosts === undefined ||
      effective.length !== signedHosts.length ||
      effective.some((host, i) => host !== signedHosts[i]);
    if (narrowed) clamped.push("allowlist");
  } else if (mode === "default_internet" && signed.allowlist && signed.allowlist.length > 0) {
    // Not reachable through the mode clamp above (a signed allowlist can only
    // stay `allowlist` or narrow to `none`), but keep the projection honest:
    // `default_internet` carries no host list.
    clamped.push("allowlist");
  }

  // --- axis 3: max bytes per job -----------------------------------------
  const signedCap = normalizeByteCap(signed.maxBytesPerJob);
  const deploymentCap = normalizeByteCap(maximum.maxBytesPerJob);
  const effectiveCap =
    signedCap === undefined
      ? deploymentCap
      : deploymentCap === undefined
        ? signedCap
        : Math.min(signedCap, deploymentCap);
  if (effectiveCap !== undefined) policy.maxBytesPerJob = effectiveCap;
  if (effectiveCap !== signedCap) clamped.push("max_bytes");

  return { policy, clamped };
}
