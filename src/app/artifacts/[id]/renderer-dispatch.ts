/**
 * Renderer dispatch by effective identity — the §III composition for the
 * consolidated `/artifacts` surface (cinatra#1431 spec design@4c6799db §III),
 * re-seated on the renderer dispatch SPINE (cinatra#1629, epic #1620 S2).
 *
 * Opening a row resolves ONE renderer in a strict precedence that is TOTAL over
 * every row ("there is always a renderer; the fallback is never a blank"):
 *
 *   1. Semantic-type renderer — the row's per-org effective-identity WINNER is
 *      an installed extension that ships a `detail` renderer for the row's type.
 *      If that renderer module is in THIS build → render it; if the claimant is
 *      runtime-installed but ABSENT from the build ("never built") → the generic
 *      renderer + a "requires rebuild" diagnostic (deterministic, never blank).
 *   2. Representation viewer — an org-effective representation PROVIDER (or the
 *      always-effective first-party host handler) for the row's representation.
 *      An extension provider absent from the build again degrades to
 *      requires-rebuild; a first-party default is a host MIME handler.
 *   3. Generic fallback — the read-only structured-data view. Always terminal.
 *
 * This module is PURE (no React / DB / server-only) so the dispatch table is
 * unit-testable. The `hasTypedRenderer` boolean of the pre-spine dispatch — true
 * for essentially every registered type (the bridge assigned host-generic
 * renderers to all) — is REPLACED by claimant-keyed resolution: the caller
 * resolves the semantic + representation inputs from the two arbitration
 * registries and the generated build map, then this leaf composes the precedence.
 * Read authorization is enforced by the caller BEFORE dispatch.
 */
import type { EffectiveIdentity } from "@cinatra-ai/objects/effective-identity";
import type { ArtifactUiSlot } from "@cinatra-ai/sdk-extensions/artifact-contract";

import { type HandlerKind } from "./pick-handler";

/** SEMANTIC detail renderer resolved from the per-org effective-identity winner
 * (via the semantic-type registry + the generated build map). `built` is false
 * when the winning claimant is runtime-installed but absent from THIS build. */
export interface SemanticRendererResolution {
  packageName: string;
  generatedKey: string;
  built: boolean;
}

/** REPRESENTATION viewer resolved from the org-scoped representation-provider
 * registry: an effective extension provider, or the always-effective first-party
 * host default. `null` means neither matched → generic fallback. */
export type RepresentationRendererResolution =
  | {
      tier: "extension";
      packageName: string;
      generatedKey: string;
      pattern: string;
      /** The slot this representation was resolved at (the detail page resolves at
       * `detail`, the neutral reuse seam at `preview`). Carried so a never-built
       * degrade diagnoses the ACTUAL slot, not a hardcoded one. */
      slot: ArtifactUiSlot;
      built: boolean;
    }
  | { tier: "first-party"; handler: Exclude<HandlerKind, "fallback"> };

export interface ArtifactRenderDispatchInput {
  /** The row's resolved effective identity. */
  identity: EffectiveIdentity;
  /** Semantic detail renderer for the org's winner, or null when the winner
   * ships none / the identity is not an extension. */
  semantic: SemanticRendererResolution | null;
  /** Representation viewer for the row's representation, or null when neither an
   * extension provider nor a first-party default matches. */
  representation: RepresentationRendererResolution | null;
}

export type ArtifactRenderDispatch =
  /** Render the extension-shipped semantic `detail` renderer. */
  | { kind: "semantic"; packageName: string; generatedKey: string }
  /** Render the extension-shipped representation viewer. */
  | { kind: "representation"; packageName: string; generatedKey: string; pattern: string }
  /** Render the first-party host MIME handler (the always-effective default). */
  | { kind: "mime"; handler: Exclude<HandlerKind, "fallback"> }
  /** A resolved claimant is installed at runtime but ABSENT from this build:
   * render the generic renderer + a "requires rebuild" diagnostic (never blank). */
  | { kind: "requires-rebuild"; packageName: string; slot: ArtifactUiSlot }
  /** Generic read-only structured-data view. Always terminal. */
  | { kind: "fallback" };

/**
 * Resolve the single renderer for a row. Total: every input lands on exactly one
 * dispatch — a semantic renderer, a representation viewer, a first-party MIME
 * handler, a requires-rebuild degrade, or the generic fallback. Never throws,
 * never returns "no renderer".
 */
export function pickArtifactRenderer(
  input: ArtifactRenderDispatchInput,
): ArtifactRenderDispatch {
  // 1. Semantic-type renderer — the per-org effective-identity winner ships a
  // detail renderer for this type. Gated on an extension identity AND on the
  // renderer's claimant BEING that winner (defensive winner-binding: even though
  // the registry resolves by (type, winner), the pure dispatch re-verifies so a
  // mismatched semantic resolution can never leak a losing claimant's renderer).
  if (
    input.identity.kind === "extension" &&
    input.semantic &&
    input.semantic.packageName === input.identity.extension
  ) {
    if (input.semantic.built) {
      return {
        kind: "semantic",
        packageName: input.semantic.packageName,
        generatedKey: input.semantic.generatedKey,
      };
    }
    // Never-built claimant: terminal generic + requires-rebuild (does NOT fall
    // through to the representation tier — the extension DECLARED a detail view;
    // the build merely lacks the module).
    return { kind: "requires-rebuild", packageName: input.semantic.packageName, slot: "detail" };
  }

  // 2. Representation viewer — an org-effective extension provider or the
  // always-effective first-party host default.
  if (input.representation) {
    if (input.representation.tier === "extension") {
      if (input.representation.built) {
        return {
          kind: "representation",
          packageName: input.representation.packageName,
          generatedKey: input.representation.generatedKey,
          pattern: input.representation.pattern,
        };
      }
      // Degrade at the slot the representation was ACTUALLY resolved at (the
      // detail page resolves at `detail`) — a hardcoded slot would mislabel the
      // user-facing "requires rebuild" notice (Codex convergence, cinatra#1630).
      return {
        kind: "requires-rebuild",
        packageName: input.representation.packageName,
        slot: input.representation.slot,
      };
    }
    return { kind: "mime", handler: input.representation.handler };
  }

  // 3. Generic fallback: read-only structured-data view. Always terminal.
  return { kind: "fallback" };
}

/**
 * The §III activation barrier for a row's selection affordance. RETIRED under
 * type-driven identity (epic #1785): identity is now a pure function of the
 * row's installed type — there is no pre-binding "catalog / browse-only"
 * intermediate state a row can sit in, so a row is never "preparing". Kept as a
 * constant-false predicate so the detail-page + library-row callers stay
 * structurally intact (the "Preparing" affordance can never render).
 */
export function isSelectionPreparing(_identity: EffectiveIdentity): boolean {
  return false;
}
