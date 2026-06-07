/**
 * Mid-run HITL renderer classifier.
 *
 * Renderer classification lives outside orchestrator-stepper-panel.tsx
 * because suffix-based matches can false-positive on any future agent whose
 * renderer ID shared the same suffix. Keeping strict renderer IDs here means:
 *   - it can be unit-tested without the panel's client-side import chain;
 *   - new entries are added in one place;
 *   - the strict-equality slice is visible at the top of the file.
 *
 * New mid-run HITL renderers must add their full ID to
 * STRICT_MID_RUN_HITL_RENDERER_IDS.
 */

const STRICT_MID_RUN_HITL_RENDERER_IDS = new Set<string>([
  "@cinatra-ai/blog-linkedin-publish-agent:draft-review",
  "@cinatra-ai/blog-wordpress-publish-agent:draft-confirm",
  // Auditor review gate. Without this, `classifyMidRunHitl` returns
  // false and the outer-panel Continue button never shows; the e2e
  // harness's `advanceAuditorReview` then fails with "Continue button
  // not found". The renderer's auto-emit-when-prompts-empty path
  // (auditor-review-renderer.tsx) populates the onChange; the outer
  // Continue button submits the gate, consistent with the auditor
  // fixture that clicks Continue at the outer panel level.
  "@cinatra-ai/auditor-agent:review",
  // The ContextSelector HITL renderer needs strict-set classification
  // so the orchestrator-stepper buffers selections for an outer Continue
  // instead of firing approveReviewTask on every checkbox toggle.
  // Without this entry, accumulate-mode multi-pick collapses to single-
  // click-submits-immediately, which silently drops every selection
  // after the first.
  // Canonical context selection renderer ID; matching is intentionally
  // strict and no legacy alias is accepted here.
  "@cinatra-ai/context-selection-agent:context-selector",
]);

/**
 * Classify a renderer ID as a mid-run HITL gate.
 *
 * The current implementation is a hybrid:
 *   - strict renderer IDs use strict-equality matching
 *     (STRICT_MID_RUN_HITL_RENDERER_IDS) to close the namespace-collision
 *     hazard;
 *   - some renderer families still use the `endsWith(...)` fallback until
 *     they can be narrowed by a dedicated audit.
 */
export function classifyMidRunHitl(xRenderer: string): boolean {
  if (STRICT_MID_RUN_HITL_RENDERER_IDS.has(xRenderer)) return true;
  return (
    xRenderer.endsWith(":output") ||
    xRenderer.endsWith("-output") || // per-content IDs: :contacts-output, :drafts-output, :followups-output
    xRenderer.endsWith(":list-picker") || // list-based recipient selection
    xRenderer.endsWith(":scrape-schema-review") || // Gate 1 - list-curator
    xRenderer.endsWith(":final-list-review") || // Gate 2 - list-curator
    xRenderer.endsWith(":setup-form")
  );
}
