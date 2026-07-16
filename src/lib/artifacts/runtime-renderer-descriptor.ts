// The serialized runtime-renderer descriptor + the pre-import admission checks
// (React-peer / ABI), the fail-closed freshness PREFLIGHT, and the never-blank
// FLOOR reason taxonomy for the main-realm dynamic loader (epic #1620 M1 Slice A
// — cinatra#1630, plan §2.5–§2.6).
//
// A server-side process-global registry is NOT browser-visible, so the server
// RESOLVES an admitted binding and SERIALIZES a descriptor
// `{ digestPinnedUrl, tuple, reason? }` down to the client loader as props
// (Codex R1 constraint 2). This module owns that descriptor shape, the immutable
// digest-pinned URL builder, the pre-import checks the host runs BEFORE
// `import()`, and the reason a floor renders on every failure state.
//
// PURE (no React / DB / server-only) so every check + the preflight verdict are
// unit-testable. The React/DOM PEER and SDK-ABI range checks reuse the SDK's
// `isSdkAbiRangeSatisfied` (a general host-version-vs-range semver-satisfies).

import {
  isSdkAbiRangeSatisfied,
  SDK_EXTENSIONS_ABI_VERSION,
} from "@cinatra-ai/sdk-extensions/register";
import type { AdmittedClientBundleTuple } from "@cinatra-ai/sdk-extensions/artifact-client-bundle";

// ---------------------------------------------------------------------------
// The never-blank FLOOR reason taxonomy (plan §2.6 / AC-5).
// ---------------------------------------------------------------------------

/**
 * The specific reason the never-blank floor renders in place of a dynamic
 * renderer. Carried as resolution SIDE DATA (never widening the pure dispatch
 * leaf's `requires-rebuild` vocabulary — plan §2.6), so `pickArtifactRenderer`
 * stays byte-unchanged while the floor shows a precise sanitized diagnostic.
 *
 * `archived` is the revocation reason (owner ruling 8: the extension
 * delete/archive lifecycle IS the revocation path — a descriptor whose exact
 * admitted digest is no longer the active installed one degrades here). There is
 * deliberately NO separate "revoked" reason / kill-switch state.
 */
export type RuntimeRendererFloorReason =
  | "react-peer-incompatible"
  | "abi-incompatible"
  | "signature-unverified"
  | "archived"
  | "quarantined"
  | "materializing"
  | "import-timeout"
  | "invalid-export"
  | "render-failure";

/** All floor reasons — for exhaustive test coverage of AC-5. */
export const RUNTIME_RENDERER_FLOOR_REASONS: readonly RuntimeRendererFloorReason[] =
  Object.freeze([
    "react-peer-incompatible",
    "abi-incompatible",
    "signature-unverified",
    "archived",
    "quarantined",
    "materializing",
    "import-timeout",
    "invalid-export",
    "render-failure",
  ]);

/** A sanitized, telemetry-safe floor diagnostic — package + slot + reason ONLY,
 * never a raw error message or a manifest value (mirrors the build-map loader's
 * `artifactRendererDiagnostic`). */
export function runtimeRendererFloorDiagnostic(
  packageName: string,
  slot: string,
  reason: RuntimeRendererFloorReason,
): string {
  return `dynamic artifact renderer unavailable — package "${packageName}", slot "${slot}", reason "${reason}"`;
}

// ---------------------------------------------------------------------------
// The serialized descriptor + the immutable digest-pinned URL (plan §5.1.2).
// ---------------------------------------------------------------------------

/** The route base the digest-pinned immutable serving route is mounted at. */
export const RENDERER_ASSET_ROUTE_BASE = "/api/artifact-renderer-assets";

/**
 * The descriptor the server serializes to the client loader. `reason` is set
 * when the server ALREADY knows the renderer must floor (e.g. a pre-import
 * peer/ABI/archived verdict) — the client then renders the floor without ever
 * calling `import()`. `null` reason ⇒ the loader runs the freshness preflight
 * and, if green, imports `digestPinnedUrl`.
 */
export interface SerializedRuntimeRendererDescriptor {
  digestPinnedUrl: string;
  tuple: AdmittedClientBundleTuple;
  reason?: RuntimeRendererFloorReason;
}

/**
 * The IMMUTABLE, content-addressed URL for an admitted bundle. Digest-first so
 * the URL is a pure function of the content — two activations of different bytes
 * never collide, and the serving route can set `immutable` long-cache headers.
 * Every path segment is URL-encoded; `entry` is a store-relative path (never a
 * host FS path), split + re-encoded segment-wise so a `..` can never survive
 * into a path-derived filesystem read (the route additionally refuses it).
 */
export function buildDigestPinnedUrl(tuple: AdmittedClientBundleTuple): string {
  const entrySegments = tuple.entry
    .replace(/^\.?\//, "")
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");
  return [
    RENDERER_ASSET_ROUTE_BASE,
    encodeURIComponent(tuple.digest),
    encodeURIComponent(tuple.slot),
    encodeURIComponent(tuple.packageName),
    entrySegments,
  ].join("/");
}

// ---------------------------------------------------------------------------
// Pre-import compatibility checks (plan §2.7 / AC-9–10): run BEFORE `import()`.
// ---------------------------------------------------------------------------

/** The host's live React + ReactDOM versions (the single shared in-realm
 * instances the module-registry shim exposes). */
export interface HostReactRuntime {
  reactVersion: string;
  reactDomVersion: string;
}

/**
 * React-peer compatibility: the host's React AND ReactDOM must satisfy the
 * renderer's declared peer ranges. An incompatible renderer degrades to a
 * DISTINCT `react-peer-incompatible` floor BEFORE `import()` — never a
 * misleading `requires-rebuild` (plan §2.7). Fail-closed on a malformed range.
 */
export function checkReactPeer(
  tuple: AdmittedClientBundleTuple,
  host: HostReactRuntime,
): boolean {
  return (
    isSdkAbiRangeSatisfied(host.reactVersion, tuple.reactPeerRange) &&
    isSdkAbiRangeSatisfied(host.reactDomVersion, tuple.reactDomPeerRange)
  );
}

/**
 * SDK-ABI + props-contract compatibility: the host SDK ABI must satisfy the
 * renderer's `sdkAbiRange` AND the renderer's `propsApiVersion` must equal the
 * host snapshot's expected version. Both are known from the tuple — a
 * deterministic pre-import check (no module executed).
 */
export function checkAbi(
  tuple: AdmittedClientBundleTuple,
  host: { hostSdkAbi?: string; expectedPropsApiVersion: number },
): boolean {
  const abi = host.hostSdkAbi ?? SDK_EXTENSIONS_ABI_VERSION;
  return (
    isSdkAbiRangeSatisfied(abi, tuple.sdkAbiRange) &&
    tuple.propsApiVersion === host.expectedPropsApiVersion
  );
}

/**
 * The complete PRE-IMPORT verdict the host computes at resolution: quarantine →
 * archived (lifecycle) → signature → ABI → React-peer, first failure wins.
 * Returns the floor reason to serialize, or null when the renderer may be
 * imported. This runs SERVER-SIDE at resolution; the client preflight
 * (`evaluateFreshnessPreflight`) re-checks the racy subset just before import.
 */
export function preImportFloorReason(input: {
  tuple: AdmittedClientBundleTuple;
  digestQuarantined: boolean;
  installedActive: boolean;
  currentActiveDigest: string | null;
  signatureVerified: boolean;
  host: HostReactRuntime & { hostSdkAbi?: string; expectedPropsApiVersion: number };
}): RuntimeRendererFloorReason | null {
  if (input.digestQuarantined) return "quarantined";
  if (!input.installedActive) return "archived";
  if (input.currentActiveDigest !== input.tuple.digest) return "archived";
  if (!input.signatureVerified) return "signature-unverified";
  if (!checkAbi(input.tuple, input.host)) return "abi-incompatible";
  if (!checkReactPeer(input.tuple, input.host)) return "react-peer-incompatible";
  return null;
}

// ---------------------------------------------------------------------------
// The fail-closed freshness PREFLIGHT (plan §2.5, owner ruling 8).
// ---------------------------------------------------------------------------

/** The current admission state the freshness preflight checks the descriptor
 * against — the racy subset that can change between server serialization and the
 * cached client `import()`. */
export interface FreshnessAuthorityState {
  /** Is the owning extension STILL installed + active (not archived/deleted)?
   * Ruling 8: this is the revocation signal — the lifecycle IS the kill-switch. */
  installedActive: boolean;
  /** The DB-authoritative ACTIVE digest for this (package, slot) right now, or
   * null when nothing is active. A mismatch ⇒ the serialized descriptor is
   * stale/superseded (or the extension was archived). */
  currentActiveDigest: string | null;
  /** The re-evaluated signature verdict at load (re-checked every load, not only
   * at install — plan §3.1). */
  signatureVerified: boolean;
  /** Is this exact digest quarantined (best-effort 3-strike containment)? */
  digestQuarantined: boolean;
}

export type FreshnessPreflightVerdict =
  | { ok: true }
  | { ok: false; reason: RuntimeRendererFloorReason };

/**
 * The fail-closed admission PREFLIGHT the client loader runs BEFORE mounting a
 * (possibly browser-cached) bundle (plan §2.5). It re-checks that the serialized
 * descriptor is STILL admitted: not quarantined, the extension still
 * installed/active, this exact digest still the active admitted one, and the
 * signature still verifies. Only a green verdict permits `import()`.
 *
 * HONEST TOCTOU LIMIT (Codex R4, plan §2.5): this REJECTS a stale or
 * already-archived descriptor, but cannot fully close the final window — an
 * archive landing AFTER a green preflight and immediately before the cached
 * `import()` is an unavoidable residual. The guarantee is instead: a generation
 * change UNMOUNTS the live mount and telemetry records the late load;
 * already-executed top-level effects are NOT reversible (this function does not
 * claim otherwise).
 *
 * Ruling 8: "still admitted" is checked against the EXISTING delete/archive
 * lifecycle (`installedActive` + the active-digest match), NOT a separate
 * revocation/kill-switch registry.
 */
export function evaluateFreshnessPreflight(
  tuple: AdmittedClientBundleTuple,
  state: FreshnessAuthorityState,
): FreshnessPreflightVerdict {
  if (state.digestQuarantined) return { ok: false, reason: "quarantined" };
  if (!state.installedActive) return { ok: false, reason: "archived" };
  if (state.currentActiveDigest !== tuple.digest) return { ok: false, reason: "archived" };
  if (!state.signatureVerified) return { ok: false, reason: "signature-unverified" };
  return { ok: true };
}

/** Map a client-side dynamic-import failure to its floor reason (plan §2.5:
 * import rejection, invalid export, timeout are each explicitly floor-covered). */
export function classifyImportFailure(
  kind: "timeout" | "import-rejected" | "invalid-export" | "render-failure",
): RuntimeRendererFloorReason {
  switch (kind) {
    case "timeout":
      return "import-timeout";
    case "import-rejected":
      // A rejected import of a materializing/absent asset floors as materializing
      // (transient) — the descriptor was admitted but the bytes aren't servable.
      return "materializing";
    case "invalid-export":
      return "invalid-export";
    case "render-failure":
      return "render-failure";
  }
}
