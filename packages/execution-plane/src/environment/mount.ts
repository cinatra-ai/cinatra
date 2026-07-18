/**
 * L1 environment mount path (exec-plane S3, cinatra#1708; epic #1705).
 *
 * The WORKER's half of "mount the built L1 layer for a job": given a resolved
 * environment layer (the content-addressed layer the app-layer service
 * resolved for the run — a cache hit or a fresh build from the trusted
 * builder), re-verify its SIGNED provenance fail-closed and resolve the
 * immutable image identity the sandbox runs over.
 *
 * WHY RE-VERIFY AT THE MOUNT (cinatra#1708 AC4 "provenance recorded and
 * verified before mount"): the cache verifies provenance at lookup, but a
 * resolved mount may cross a queue/process boundary to a (possibly remote)
 * worker before it runs. The mount path therefore verifies INDEPENDENTLY and
 * trusts no unsigned field — the sandbox runs over the SIGNED
 * `provenance.imageDigest` (the immutable identity the builder signed), and
 * `imageRef` is a display / registry-pull alias the mount path never runs by.
 *
 * FAIL-CLOSED: an unverifiable layer (bad/absent signature, or no host
 * provenance key to verify it with) is REFUSED — the worker throws
 * `EnvironmentMountRefusedError` BEFORE any container starts; it never
 * silently falls back to the L0 base or to an unverified image. (At the app
 * layer an unverifiable cache row is "treated as absent → rebuild"; once past
 * resolution, at the mount, the only safe action is to refuse.)
 */

import {
  verifyEnvironmentProvenance,
  type SignedEnvironmentLayerProvenance,
} from "./provenance";

/**
 * The minimal, JSON-serializable projection of a resolved L1 layer that a
 * command carries to the worker (`SandboxCommandSpec.environment`). Every
 * field the worker ACTS ON is inside the signed `provenance`; `imageRef` is a
 * display / registry-pull alias only. Projected from an
 * `EnvironmentLayerCacheEntry` by the app-layer service that resolves a job's
 * declared environment into a mountable layer.
 */
export type ResolvedEnvironmentMount = {
  /** Content-addressed display / registry-pull alias (never the run target). */
  imageRef: string;
  /** Signed per-layer provenance — re-verified before every mount. */
  provenance: SignedEnvironmentLayerProvenance;
};

export type EnvironmentMountRefusalReason =
  | "no_provenance_key"
  | "unverifiable_provenance";

/**
 * Raised when a resolved environment mount cannot be trusted. Deliberately a
 * throw (not a `SandboxCommandResult`): the refusal happens BEFORE dispatch,
 * so there is no command outcome to report — the worker refuses to run and the
 * broker maps this to an audited `environment_untrusted` refusal.
 */
export class EnvironmentMountRefusedError extends Error {
  readonly reason: EnvironmentMountRefusalReason;
  constructor(reason: EnvironmentMountRefusalReason) {
    super(
      reason === "no_provenance_key"
        ? "Refusing to mount an L1 environment: no host provenance key is configured to verify it (fail-closed)."
        : "Refusing to mount an L1 environment whose signed provenance did not verify (fail-closed).",
    );
    this.name = "EnvironmentMountRefusedError";
    this.reason = reason;
  }
}

export type EnvironmentMountResolution =
  | { ok: true; imageDigest: string }
  | { ok: false; reason: EnvironmentMountRefusalReason };

/**
 * Re-verify a resolved environment mount and resolve the immutable image
 * identity to run over. Pure + fail-closed: a missing host key or an
 * unverifiable signature yields a refusal — never a throw here (the caller
 * decides how to surface it) and never a fallback to an unverified image. On
 * success the returned `imageDigest` is the SIGNED identity taken from the
 * verified provenance (the runtime mounts by it, not by `imageRef`).
 */
export function resolveEnvironmentMount(
  mount: ResolvedEnvironmentMount,
  provenanceKey: string | undefined,
): EnvironmentMountResolution {
  if (typeof provenanceKey !== "string" || provenanceKey.length === 0) {
    return { ok: false, reason: "no_provenance_key" };
  }
  if (!verifyEnvironmentProvenance(mount.provenance, provenanceKey)) {
    return { ok: false, reason: "unverifiable_provenance" };
  }
  return { ok: true, imageDigest: mount.provenance.imageDigest };
}
