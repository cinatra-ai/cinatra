import "server-only";

import type { EffectiveIdentity } from "@cinatra-ai/objects/effective-identity";
import {
  semanticRendererRegistry,
  representationProviderRegistry,
} from "@cinatra-ai/objects/artifact-renderer-registry";

import { GENERATED_ARTIFACT_RENDERERS } from "@/lib/generated/artifact-renderers";
import { PREVIEW_INLINE_MIME_ALLOWLIST_FOR_TESTS } from "@/lib/artifacts/artifact-read";
import { runtimeAssetRegistry } from "@/lib/artifacts/runtime-renderer-registry";
import {
  buildDigestPinnedUrl,
  type SerializedRuntimeRendererDescriptor,
} from "@/lib/artifacts/runtime-renderer-descriptor";

import { pickHandler } from "./pick-handler";
import type {
  ArtifactRenderDispatchInput,
  SemanticRendererResolution,
  RepresentationRendererResolution,
} from "./renderer-dispatch";

// ---------------------------------------------------------------------------
// The TWO-PATH predicate (epic #1620 M1 Slice A — cinatra#1630, plan §2.4):
//   loadable = inBuildMap OR inRuntimeAssetRegistry
// The build map is the SSR fast path (system/first-party bases). The runtime
// asset registry binds a marketplace-installed renderer's exact admitted tuple
// (main-realm dynamic `import()`). A claimant present in EITHER is `loadable`,
// so the pure dispatch leaf routes it to `semantic`/`representation` (not
// `requires-rebuild`); the CONSUMING route then distinguishes the SSR fast path
// (`isBuildMapKey`) from the dynamic client seam (a runtime descriptor).
// `renderer-dispatch.ts` (`pickArtifactRenderer`) + both arbitration registries
// stay BYTE-UNCHANGED — the field remains `built`, its MEANING widened.
// ---------------------------------------------------------------------------

/** The build-time SSR fast path: the resolved key is in the generated map. */
function isBuildMapKey(generatedKey: string): boolean {
  return generatedKey in GENERATED_ARTIFACT_RENDERERS;
}

/** The widened predicate: loadable via the build map OR the runtime registry. */
function isLoadableKey(generatedKey: string): boolean {
  return isBuildMapKey(generatedKey) || runtimeAssetRegistry.inRuntimeAssetRegistry(generatedKey);
}

// ---------------------------------------------------------------------------
// Host resolver seam for the artifact renderer dispatch spine (cinatra#1629,
// epic #1620 S2). Binds the two arbitration registries + the generated build
// map + the host representation allowlist into the pure dispatch inputs the
// route consumes. Server-only (reads the generated build map); the pure
// precedence composition lives in `./renderer-dispatch`.
//
// REPRESENTATION-viewer slot convention: the detail page renders the row's
// representation through the neutral `preview` capability (AC-6) — the same slot
// core reuse sites use — so a representation viewer resolves at slot `preview`.
// The SEMANTIC detail view resolves at slot `detail`.
// ---------------------------------------------------------------------------

// First-party defaults are the always-effective host handlers a provider must
// beat. Seeded once (idempotent replace-by-key on the singleton registry) from
// the host preview allowlist so the registry genuinely MODELS the host floor;
// the concrete HandlerKind is derived from `pickHandler` (the drift-proof source
// of truth), so the seed can never diverge from what the page actually renders.
let firstPartyDefaultsSeeded = false;
function ensureFirstPartyRepresentationDefaults(): void {
  if (firstPartyDefaultsSeeded) return;
  for (const mime of PREVIEW_INLINE_MIME_ALLOWLIST_FOR_TESTS) {
    const handler = pickHandler(mime);
    if (handler === "fallback") continue;
    representationProviderRegistry.registerFirstPartyDefault({
      pattern: mime,
      slot: "preview",
      ref: handler,
    });
  }
  firstPartyDefaultsSeeded = true;
}

/** Resolve the SEMANTIC detail renderer for a row via the per-org effective
 * identity winner (the semantic registry) + the generated build map. */
export function resolveSemanticDispatch(
  baseType: string,
  identity: EffectiveIdentity,
): SemanticRendererResolution | null {
  const desc = semanticRendererRegistry.resolve(baseType, identity);
  if (!desc) return null;
  return {
    packageName: desc.packageName,
    generatedKey: desc.generatedKey,
    // `built` MEANING widened to `loadable` (§2.4): build map OR runtime registry.
    built: isLoadableKey(desc.generatedKey),
  };
}

/** Resolve the REPRESENTATION viewer for a row via the org-scoped
 * representation-provider registry (extension provider or the always-effective
 * first-party host default) + the generated build map. */
export function resolveRepresentationDispatch(
  orgId: string,
  mime: string,
): RepresentationRendererResolution | null {
  ensureFirstPartyRepresentationDefaults();
  const res = representationProviderRegistry.resolve(orgId, mime, "preview");
  if (res?.tier === "extension") {
    return {
      tier: "extension",
      packageName: res.packageName,
      generatedKey: res.generatedKey,
      pattern: res.pattern,
      // `built` MEANING widened to `loadable` (§2.4): build map OR runtime registry.
      built: isLoadableKey(res.generatedKey),
    };
  }
  // First-party default (or no registry entry): the concrete host HandlerKind is
  // ALWAYS derived from the allowlist via `pickHandler` — never the registry's
  // opaque `ref` (which is untyped). This makes the dispatch handler provably a
  // valid non-fallback HandlerKind and guarantees the representation tier can
  // never regress below `pickHandler`, whatever the registry's seed/ref state.
  const handler = pickHandler(mime);
  return handler === "fallback" ? null : { tier: "first-party", handler };
}

/**
 * Resolve the full dispatch inputs for a row: the effective identity plus the
 * semantic + representation resolutions. The route feeds this to
 * `pickArtifactRenderer` (the pure precedence leaf).
 */
export function resolveArtifactDispatchInputs(args: {
  orgId: string;
  baseType: string;
  identity: EffectiveIdentity;
  mime: string;
}): ArtifactRenderDispatchInput {
  return {
    identity: args.identity,
    semantic: resolveSemanticDispatch(args.baseType, args.identity),
    representation: resolveRepresentationDispatch(args.orgId, args.mime),
  };
}

/**
 * The neutral PREVIEW seam (AC-6): resolve a representation preview for a core
 * reuse site, with a core fallback. Returns the representation resolution or
 * null (⇒ the caller uses its core fallback). Core never imports extension
 * pixels — the guarded import happens in the loader only. The reuse-site wiring
 * (portlet/preview-serving surfaces) lands with M1 (S4); this is the seam.
 */
export function resolveArtifactPreviewDispatch(args: {
  orgId: string;
  mime: string;
}): RepresentationRendererResolution | null {
  return resolveRepresentationDispatch(args.orgId, args.mime);
}

/**
 * Distinguish the two loadable paths for a resolved `generatedKey` (§2.4). The
 * pure dispatch leaf only knows "loadable" (`built`); the consuming route uses
 * this to pick the SSR build-map fast path vs the dynamic client seam:
 *  - `build-map`  → the existing server-only `ExtensionRendererSlot` (SSR).
 *  - `runtime`    → the main-realm dynamic client loader + serialized descriptor.
 *  - `none`       → neither (the caller floors as requires-rebuild).
 */
export function classifyLoadablePath(generatedKey: string): "build-map" | "runtime" | "none" {
  if (isBuildMapKey(generatedKey)) return "build-map";
  if (runtimeAssetRegistry.inRuntimeAssetRegistry(generatedKey)) return "runtime";
  return "none";
}

/**
 * Resolve + SERIALIZE the admitted runtime descriptor for a dynamic-path
 * `generatedKey` (Codex R1 constraint 2: a server process-global is not
 * browser-visible, so the client receives `{ digestPinnedUrl, tuple }` as
 * props, never by reading a server registry). Returns null when the key is not
 * a runtime binding (the caller uses the build-map path or floors). Any
 * pre-import floor `reason` is computed by the ROUTE (which has the live
 * signature/peer/ABI/lifecycle state) and threaded onto the descriptor there —
 * this leaf serializes the immutable URL + the exact tuple only.
 */
export function resolveRuntimeRendererDescriptor(
  generatedKey: string,
): SerializedRuntimeRendererDescriptor | null {
  const tuple = runtimeAssetRegistry.resolveActive(generatedKey);
  if (!tuple) return null;
  return { digestPinnedUrl: buildDigestPinnedUrl(tuple), tuple };
}

/** @internal test-only reset of the per-module seed guard. */
export function _resetFirstPartySeedForTests(): void {
  firstPartyDefaultsSeeded = false;
}
