/**
 * Signed per-layer provenance (exec-plane S3, cinatra#1708).
 *
 * Every built L1 layer carries a provenance record binding the layer's image
 * digest to the FULL effective build recipe and the builder identity, signed
 * (HMAC-SHA256) with a host-held provenance key. The worker/mount path
 * verifies the signature BEFORE mounting a cached layer (cinatra#1708 AC4:
 * "provenance recorded and verified before mount") — a cache row whose
 * provenance does not verify is treated as absent (rebuild), never mounted.
 *
 * The signing key is HOST infrastructure (loop-provisioned internal secret):
 * it is never injected into any build or run container — package lifecycle
 * scripts therefore cannot forge provenance any more than they can write the
 * cache (lifecycle-script isolation, cinatra#1708).
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import {
  canonicalRecipeJson,
  computeEnvironmentRecipeKey,
  type EnvironmentBuildRecipe,
} from "./recipe";

export type EnvironmentLayerProvenance = {
  /** Content address of the FULL effective build recipe. */
  recipeKey: string;
  /** The full recipe (auditable; canonicalized for signing). */
  recipe: EnvironmentBuildRecipe;
  /** Immutable image identity of the built layer (image ID / digest). */
  imageDigest: string;
  /**
   * The cache partition the layer was built FOR (`"instance"` /
   * `"org:<id>"`). SIGNED (codex S3-r0 finding 1): a store row cannot be
   * re-partitioned — e.g. a private org layer flipped to instance-shared —
   * without breaking the signature.
   */
  partition: string;
  /** Builder identity string (ENVIRONMENT_BUILDER_VERSION at build time). */
  builderIdentity: string;
  /** Build wall-clock (ms epoch). Informational; NOT part of the recipe key. */
  builtAtMs: number;
};

export type SignedEnvironmentLayerProvenance = EnvironmentLayerProvenance & {
  /** HMAC-SHA256 (hex) over the canonical provenance payload. */
  signature: string;
};

function provenancePayload(prov: EnvironmentLayerProvenance): string {
  // Canonical, field-ordered payload — object key order can never change the
  // signature. builtAtMs is signed too (a replayed record keeps its original
  // timestamp; freshness policy is the cache's concern, integrity is ours).
  return JSON.stringify({
    builderIdentity: prov.builderIdentity,
    builtAtMs: prov.builtAtMs,
    imageDigest: prov.imageDigest,
    partition: prov.partition,
    recipe: JSON.parse(canonicalRecipeJson(prov.recipe)) as unknown,
    recipeKey: prov.recipeKey,
  });
}

export function signEnvironmentProvenance(
  prov: EnvironmentLayerProvenance,
  signingKey: string,
): SignedEnvironmentLayerProvenance {
  const signature = createHmac("sha256", signingKey)
    .update(provenancePayload(prov))
    .digest("hex");
  return { ...prov, signature };
}

/**
 * Verify a signed provenance record. Fail-closed on ANY mismatch — including
 * a recipeKey that does not match the embedded recipe (a signed record must
 * be internally consistent, not just untampered).
 */
export function verifyEnvironmentProvenance(
  signed: SignedEnvironmentLayerProvenance,
  signingKey: string,
): boolean {
  // EXCEPTION-SAFE fail-closed (codex S3-r0 finding 10): a malformed /
  // corrupted store row must verify FALSE, never throw into the request path.
  try {
    const { signature, ...prov } = signed;
    if (typeof signature !== "string" || signature.length === 0) return false;
    // Internal consistency BEFORE the MAC: the claimed content address must be
    // the recipe's actual content address.
    if (computeEnvironmentRecipeKey(prov.recipe) !== prov.recipeKey) return false;
    const expected = createHmac("sha256", signingKey)
      .update(provenancePayload(prov))
      .digest("hex");
    const a = Buffer.from(signature, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
