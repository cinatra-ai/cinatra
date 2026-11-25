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

import {
  fieldRendererRegistry,
  type FieldRendererContext,
  type FieldRendererEntry,
} from "./field-renderer-registry";
import { SCHEMA_FIELD_FALLBACK_RENDERER_ID } from "./agent-builder-ids";

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
 * The entry a LIVE HITL gate is drawn with: the entry the registry resolves for
 * the gate's recorded `x-renderer` id, and nothing else.
 *
 * THE PLAIN FORM IS NEVER A STAND-IN FOR A SCREEN THE HOST CANNOT NAME. A
 * parked step's durable record (`agent_run_hitl_gates`: the renderer id, the
 * schema, the values and the field name; the event log's interrupt frame
 * holds the same four) records no kind and no `midRunHitl` flag. When a
 * package stops declaring a screen, the host loses everything it knew about
 * that id: the generated bindings, the kind and the `midRunHitl` flag go with
 * the declaration. Such an id cannot be told apart from an id the host has
 * never seen, and the schema does not tell a confirmation from a decision (a
 * screen can draw its choices from the values with a bare object schema, and
 * a picker can ask for one text field). So:
 *
 *   - a step recorded under the plain form's own id
 *     (`SCHEMA_FIELD_FALLBACK_RENDERER_ID`, the id the flow compiler gives a
 *     step that declares no screen) is drawn by the plain form, as before;
 *   - a step whose id a registered entry claims is drawn by that entry;
 *   - a step whose id no entry claims is REFUSED: no renderer, so the hosts
 *     show "no renderer configured for this step" and no Continue, the run
 *     stays parked and nothing is sent. A former decision or picker step is
 *     never answered through a free-text form.
 *
 * Closed against ids the host has never seen: the floor is reached only by
 * the floor's own id or by an id a registered entry claims, and an id a
 * package can write into a step without a registered binding claims nothing.
 * The registry's own `resolve` is the whole answer, so a field inside a form
 * and a live gate resolve alike.
 */
export function resolveHitlGateRenderer(
  fieldName: string,
  schema: Record<string, unknown>,
  context: FieldRendererContext,
): FieldRendererEntry | null {
  return fieldRendererRegistry.resolve(fieldName, schema, context);
}

/**
 * Is the gate drawn by the schema floor? True for the floor's own id and for a
 * gate the resolved entry is the floor for. A host decides the answer's shape
 * from this.
 */
export function gateDrawnBySchemaFloor(
  xRenderer: string,
  entry: FieldRendererEntry | null | undefined,
): boolean {
  return xRenderer === SCHEMA_FIELD_FALLBACK_RENDERER_ID || entry?.id === SCHEMA_FIELD_FALLBACK_RENDERER_ID;
}
