import "server-only";

import type { EffectiveIdentity } from "@cinatra-ai/objects/effective-identity";
import {
  semanticRendererRegistry,
  representationProviderRegistry,
} from "@cinatra-ai/objects/artifact-renderer-registry";

import { GENERATED_ARTIFACT_RENDERERS } from "@/lib/generated/artifact-renderers";
import { PREVIEW_INLINE_MIME_ALLOWLIST_FOR_TESTS } from "@/lib/artifacts/artifact-read";

import { pickHandler } from "./pick-handler";
import type {
  ArtifactRenderDispatchInput,
  SemanticRendererResolution,
  RepresentationRendererResolution,
} from "./renderer-dispatch";

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
    built: desc.generatedKey in GENERATED_ARTIFACT_RENDERERS,
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
      built: res.generatedKey in GENERATED_ARTIFACT_RENDERERS,
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

/** @internal test-only reset of the per-module seed guard. */
export function _resetFirstPartySeedForTests(): void {
  firstPartyDefaultsSeeded = false;
}
