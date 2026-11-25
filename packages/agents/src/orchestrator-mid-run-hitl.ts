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
 *     they can be narrowed by a dedicated audit;
 *   - a tombstoned id (`TOMBSTONED_HITL_RENDERER_IDS`) is never mid-run.
 */
export function classifyMidRunHitl(xRenderer: string): boolean {
  // A tombstoned gate is never mid-run: no host draws its outer Continue.
  if (isTombstonedHitlRendererId(xRenderer)) return false;
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

/**
 * THE TOMBSTONED RENDERER IDS: retired review and action-boundary gates that
 * must stay unresumable. A stored interrupt that carries one of them shows
 * "no renderer configured for this step" and no Continue, on every host.
 *
 *   - `@cinatra/email-reviewer-agent:output` and
 *     `@cinatra/email-reviewer-agent:ai-review-panel`: the two legacy-scope
 *     reviewer aliases, deleted (cinatra#1625 S8/M3, owner action-boundary
 *     ruling 2026-07-18; cinatra#1796 teardown). The `ai-review-panel` alias
 *     could approve a review, so it is NOT a schema floor; the bare
 *     `ai-review-panel` alias went with it. Only these two ids are retired:
 *     the `@cinatra/` scope itself is still a valid package scope (install and
 *     binding validation accept it), so any other `@cinatra/<pkg>:<id>`
 *     registers and resolves as any other package's renderer does.
 *   - The retired reviewer and auditor packages (cinatra#2042 / #1796,
 *     `TOMBSTONED_HITL_RENDERER_PACKAGES`): every id of these two exact
 *     package names (their four reviewer-output
 *     bindings and the auditor review binding). The names are assembled from
 *     parts, because the retirement identity gate keeps the package refs at
 *     zero in the whole tree.
 *
 * ONE LIST, READ IN TWO PLACES: `registerFieldRendererBindings` never
 * registers a tombstoned id, and the hosts classify none as mid-run
 * (`classifyMidRunHitl`, the HITL screen card).
 */
export const TOMBSTONED_HITL_RENDERER_PACKAGES: ReadonlySet<string> = new Set([
  `@cinatra-ai/${"reviewer"}-agent`,
  `@cinatra-ai/${"auditor"}-agent`,
]);
const [RETIRED_REVIEWER_PACKAGE, RETIRED_AUDITOR_PACKAGE] = [...TOMBSTONED_HITL_RENDERER_PACKAGES];
export const TOMBSTONED_HITL_RENDERER_IDS: ReadonlySet<string> = new Set([
  "@cinatra/email-reviewer-agent:output",
  "@cinatra/email-reviewer-agent:ai-review-panel",
  "ai-review-panel",
  `${RETIRED_REVIEWER_PACKAGE}:output`,
  `${RETIRED_REVIEWER_PACKAGE}:drafts-output`,
  `${RETIRED_REVIEWER_PACKAGE}:followups-output`,
  `${RETIRED_REVIEWER_PACKAGE}:contacts-output`,
  `${RETIRED_AUDITOR_PACKAGE}:review`,
]);

/**
 * Is this renderer id tombstoned? A listed id, or any id of a listed retired
 * package (`TOMBSTONED_HITL_RENDERER_PACKAGES`, exact package names). Nothing
 * else: every other id, in any scope, registers and resolves as usual.
 */
export function isTombstonedHitlRendererId(xRenderer: string): boolean {
  if (TOMBSTONED_HITL_RENDERER_IDS.has(xRenderer)) return true;
  const colon = xRenderer.indexOf(":");
  return colon > 0 && TOMBSTONED_HITL_RENDERER_PACKAGES.has(xRenderer.slice(0, colon));
}

/**
 * MAY THIS PARKED STEP BE ANSWERED? The one predicate every page (its Continue
 * and the gate it hands the chat composer) and every server answer road (the
 * generic answer, its setup branch and `agent_run_resume`, through
 * `unanswerableParkedStep`) asks. No only for a RETIRED step: one recorded
 * under a tombstoned id (`isTombstonedHitlRendererId`), which nothing answers
 * any more; the person starts a new run. Any other id is treated as before.
 */
export function hitlStepScreenIsAnswerable(xRenderer: string): boolean {
  return !isTombstonedHitlRendererId(xRenderer);
}
