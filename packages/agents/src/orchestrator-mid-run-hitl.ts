/**
 * Mid-run HITL renderer classifier.
 *
 * Renderer classification lives outside orchestrator-stepper-panel.tsx
 * because suffix-based matches can false-positive on any future agent whose
 * renderer ID shared the same suffix. The STRICT slice is no longer a
 * hand-maintained ID list (cinatra#151 Stage 5): it consults the live
 * field-renderer registry, whose entries carry the manifest-declared
 * `midRunHitl: true` classification (each agent's `cinatra.fieldRenderers`
 * declaration — build-time generated bindings AND runtime-installed packages
 * both flow through the same registration path). A new mid-run HITL renderer
 * declares `midRunHitl: true` in its owning agent's manifest; this module
 * needs no edit.
 */

import { fieldRendererRegistry } from "./field-renderer-registry";

/**
 * Manifest-declared strict classification: does a registered binding flag
 * this exact renderer ID as a mid-run HITL gate? Strict ID equality only —
 * the bare/alias forms are deliberately NOT consulted here (matching the
 * retired strict-ID-set semantics).
 */
export function hasMidRunHitlBinding(xRenderer: string): boolean {
  return fieldRendererRegistry
    .list()
    .some((e) => e.midRunHitl === true && e.id === xRenderer);
}

/**
 * Classify a renderer ID as a mid-run HITL gate.
 *
 * The current implementation is a hybrid:
 *   - manifest-flagged renderer IDs use strict-equality matching via the
 *     registry (hasMidRunHitlBinding) to close the namespace-collision
 *     hazard;
 *   - some renderer families still use the `endsWith(...)` fallback until
 *     they can be narrowed by a dedicated audit.
 */
export function classifyMidRunHitl(xRenderer: string): boolean {
  if (hasMidRunHitlBinding(xRenderer)) return true;
  return (
    xRenderer.endsWith(":output") ||
    xRenderer.endsWith("-output") || // per-content IDs: :contacts-output, :drafts-output, :followups-output
    xRenderer.endsWith(":list-picker") || // list-based recipient selection
    xRenderer.endsWith(":scrape-schema-review") || // Gate 1 - list-curator
    xRenderer.endsWith(":final-list-review") || // Gate 2 - list-curator
    xRenderer.endsWith(":setup-form")
  );
}
