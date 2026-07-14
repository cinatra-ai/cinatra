/**
 * Renderer dispatch by effective identity — the §III composition for the
 * consolidated `/artifacts` surface (cinatra#1431, spec design@4c6799db §III).
 *
 * Opening a row resolves ONE renderer from the row's effective identity, in a
 * strict precedence that is total over every row ("there is always a renderer;
 * the fallback is never a blank"):
 *
 *   1. Typed-data artifact — when the effective identity is an installed
 *      extension AND the row's base object type carries a registered detail
 *      renderer, render through that type renderer (the claiming extension's
 *      renderer). A catalog (browse-only) identity still renders read-only
 *      through the type renderer; the activation barrier gates SELECTION, not
 *      rendering.
 *   2. File-form representation — otherwise, when the representation's MIME has
 *      a viewer handler (the existing `pickHandler` allowlist), render through
 *      that MIME handler.
 *   3. Generic fallback — anything else (a plain default-artifact row, or a
 *      claimed row whose extension ships no renderer for this representation,
 *      and no MIME handler) falls back to the read-only structured-data view.
 *
 * This module is PURE (no React / DB / server-only) so the dispatch table is
 * unit-testable. The caller resolves the two DB/registry-derived inputs
 * (`hasTypedRenderer` from the object-type registry, `mime` from the resolved
 * representation) and enforces read-authorization BEFORE dispatch — a row the
 * viewer may not read never reaches a renderer.
 */
import type { EffectiveIdentity } from "@cinatra-ai/objects/effective-identity";

import { pickHandler, type HandlerKind } from "./pick-handler";

export type ArtifactRenderDispatch =
  | { kind: "typed"; extension: string }
  | { kind: "mime"; handler: Exclude<HandlerKind, "fallback"> }
  | { kind: "fallback" };

export interface ArtifactRenderDispatchInput {
  /** The row's resolved effective identity (from the effective-identity
   * service — a binding/classic extension, the default-artifact floor, or a
   * plain object). */
  identity: EffectiveIdentity;
  /** Whether the row's BASE object type has a registered `detail` renderer in
   * the object-type registry (the claiming extension's type renderer). */
  hasTypedRenderer: boolean;
  /** The MIME of the representation to serve (empty string when none). */
  mime: string;
}

/**
 * Resolve the single renderer for a row. Total: every (identity, renderer,
 * mime) combination lands on exactly one dispatch — typed, a concrete MIME
 * handler, or the generic fallback. Never throws, never returns "no renderer".
 */
export function pickArtifactRenderer(
  input: ArtifactRenderDispatchInput,
): ArtifactRenderDispatch {
  // 1. Typed-data artifact: an INSTALLED extension identity (binding, classic,
  // or catalog browse-only — all three name an installed extension) whose base
  // type has a registered detail renderer.
  if (input.identity.kind === "extension" && input.hasTypedRenderer) {
    return { kind: "typed", extension: input.identity.extension };
  }

  // 2. File-form representation: a MIME viewer handler exists for this
  // representation.
  const handler = pickHandler(input.mime);
  if (handler !== "fallback") {
    return { kind: "mime", handler };
  }

  // 3. Generic fallback: read-only structured-data view. Always terminal.
  return { kind: "fallback" };
}

/**
 * The §III activation barrier for a row's selection affordance: SELECTION
 * (pin / add-to-context) requires a settled binding. A catalog-derived
 * identity (claim active, binding not yet written) is browsable and openable
 * but not yet selectable — its Pin / Add-to-context control is replaced by a
 * muted "Preparing" label. Mirrors `selectableAssertionId` from the pure leaf:
 * selection ever operates only on a settled, selectable identity.
 */
export function isSelectionPreparing(identity: EffectiveIdentity): boolean {
  return (
    identity.kind === "extension" &&
    identity.basis === "catalog" &&
    identity.selectable === false
  );
}
