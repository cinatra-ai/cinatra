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
import { declaresListPicker, isMidRunListStepGate } from "./hitl-gate-submit";

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
 *
 * The list picker is never classified here: whether a list step is mid-run
 * is the pause's to say, not the renderer's (`classifyMidRunGate`).
 */
export function classifyMidRunHitl(xRenderer: string): boolean {
  if (declaresListPicker(xRenderer)) return false;
  if (hasMidRunHitlBinding(xRenderer)) return true;
  return (
    xRenderer.endsWith(":output") ||
    xRenderer.endsWith("-output") || // per-content IDs: :contacts-output, :drafts-output, :followups-output
    xRenderer.endsWith(":scrape-schema-review") || // Gate 1 - list-curator
    xRenderer.endsWith(":final-list-review") || // Gate 2 - list-curator
    xRenderer.endsWith(":setup-form")
  );
}

/**
 * Classify one PAUSE as a mid-run HITL gate: the stepper's reading.
 *
 * THE LIST STEP (cinatra#3562) asks two questions, never one: is the renderer
 * the list picker (`declaresListPicker`, by the declared renderer only), and
 * is this pause a mid-run step (by the pause itself: its review task id).
 * `isMidRunListStepGate` asks both, so a list picker on a `setup-*` step stays
 * on the setup road, where its answer is sent under the field's name. Every
 * other renderer is classified by `classifyMidRunHitl`.
 */
export function classifyMidRunGate(xRenderer: string, reviewTaskId: string): boolean {
  if (declaresListPicker(xRenderer)) return isMidRunListStepGate(xRenderer, reviewTaskId);
  return classifyMidRunHitl(xRenderer);
}
