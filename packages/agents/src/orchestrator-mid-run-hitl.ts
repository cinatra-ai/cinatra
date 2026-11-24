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
  RENDERER_NAMESPACE_RE,
  type FieldRendererContext,
  type FieldRendererEntry,
} from "./field-renderer-registry";
import {
  ARTIFACT_REVIEW_REDIRECT_RENDERER_ID,
  SCHEMA_FIELD_FALLBACK_RENDERER_ID,
  TRIGGER_WAIT_STATUS_RENDERER_ID,
} from "./agent-builder-ids";
import { schemaFloorCanAnswer } from "./hitl-gate-submit";

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

/** Gate ids a host draws inline, never through a field renderer: no floor for them. */
const HOST_INLINE_GATE_IDS: ReadonlySet<string> = new Set([
  ARTIFACT_REVIEW_REDIRECT_RENDERER_ID,
  TRIGGER_WAIT_STATUS_RENDERER_ID,
]);

/**
 * THE TOMBSTONED RENDERER IDS: retired review and action-boundary gates that
 * must stay unresumable. A stored interrupt that carries one of them shows
 * "no renderer configured for this step" and no Continue, on every host.
 *
 *   - `@cinatra/...` is a RETIRED scope (never a real extension package). Its
 *     two reviewer aliases were deleted (cinatra#1625 S8/M3, owner
 *     action-boundary ruling 2026-07-18; cinatra#1796 teardown). The
 *     `ai-review-panel` alias could approve a review, so it is NOT a schema
 *     floor; the bare `ai-review-panel` alias went with it.
 *   - The retired reviewer and auditor packages (cinatra#2042 / #1796): their
 *     four reviewer-output bindings and the auditor review binding. These ids
 *     are assembled from parts, because the retirement identity gate keeps the
 *     package refs at zero in the whole tree.
 *
 * ONE LIST, READ IN TWO PLACES: `registerFieldRendererBindings` never
 * registers a tombstoned id, and `resolveHitlGateRenderer` never gives one
 * the schema floor.
 */
const RETIRED_SCOPE_PREFIX = "@cinatra/";
const RETIRED_PACKAGE_PREFIXES: readonly string[] = [
  `@cinatra-ai/${"reviewer"}-agent:`,
  `@cinatra-ai/${"auditor"}-agent:`,
];
export const TOMBSTONED_HITL_RENDERER_IDS: ReadonlySet<string> = new Set([
  "@cinatra/email-reviewer-agent:output",
  "@cinatra/email-reviewer-agent:ai-review-panel",
  "ai-review-panel",
  `${RETIRED_PACKAGE_PREFIXES[0]}output`,
  `${RETIRED_PACKAGE_PREFIXES[0]}drafts-output`,
  `${RETIRED_PACKAGE_PREFIXES[0]}followups-output`,
  `${RETIRED_PACKAGE_PREFIXES[0]}contacts-output`,
  `${RETIRED_PACKAGE_PREFIXES[1]}review`,
]);

/**
 * Is this renderer id tombstoned? A listed id, any id in the retired
 * `@cinatra/` scope, and any id of a retired reviewer or auditor package.
 */
export function isTombstonedHitlRendererId(xRenderer: string): boolean {
  return (
    TOMBSTONED_HITL_RENDERER_IDS.has(xRenderer) ||
    xRenderer.startsWith(RETIRED_SCOPE_PREFIX) ||
    RETIRED_PACKAGE_PREFIXES.some((prefix) => xRenderer.startsWith(prefix))
  );
}

/**
 * Does the id name a review or a mid-run kind? The floor's Continue only
 * approves, so it must never stand in for a review decision. The same suffixes
 * the hosts read to classify a gate (`classifyMidRunHitl`, the list step, the
 * grouped setup form) and any local name that says "review" are refused. A
 * refused id keeps no renderer: the gate stays unanswerable, never approved by
 * a form that was not its own. As a side effect, every id that does take the
 * floor is classified by those suffix rules exactly as the floor's own id is.
 */
function namesReviewOrMidRunKind(xRenderer: string): boolean {
  const local = xRenderer.slice(xRenderer.lastIndexOf(":") + 1);
  return (
    local.includes("review") ||
    local === "output" ||
    local.endsWith("-output") ||
    local === "list-picker" ||
    local === "setup-form"
  );
}

/**
 * The entry a LIVE HITL gate is drawn with. A gate whose `x-renderer` id no
 * entry claims (a package dropped the binding while a run was parked at that
 * step) falls to the schema floor, the entry registered under
 * `SCHEMA_FIELD_FALLBACK_RENDERER_ID`, so the person can still answer the
 * step from its stored schema and the run can resume. This is the floor a
 * not-in-build binding of a known kind already draws.
 *
 * Fail-safe: only a namespaced id gets the floor. An empty or bare id, an id
 * a host draws inline, a tombstoned id, an id of a review or mid-run kind and
 * a schema the floor cannot answer with a value of the right shape
 * (`schemaFloorCanAnswer`: a malformed object, an array of objects, numbers
 * or booleans, a `type` list or an unknown type) keep no renderer. The registry's own `resolve` is unchanged, so a field
 * inside a form never takes the floor's Continue.
 *
 * A host that draws a gate with the floor answers it with the floor's own
 * submit semantics (`gateDrawnBySchemaFloor`), never with those of the
 * original id.
 */
export function resolveHitlGateRenderer(
  fieldName: string,
  schema: Record<string, unknown>,
  context: FieldRendererContext,
): FieldRendererEntry | null {
  const entry = fieldRendererRegistry.resolve(fieldName, schema, context);
  if (entry !== null) return entry;
  const xRenderer = schema["x-renderer"];
  if (
    typeof xRenderer !== "string" ||
    !RENDERER_NAMESPACE_RE.test(xRenderer) ||
    HOST_INLINE_GATE_IDS.has(xRenderer) ||
    isTombstonedHitlRendererId(xRenderer) ||
    namesReviewOrMidRunKind(xRenderer) ||
    !schemaFloorCanAnswer(schema)
  ) {
    return null;
  }
  return fieldRendererRegistry.list().find((e) => e.id === SCHEMA_FIELD_FALLBACK_RENDERER_ID) ?? null;
}

/**
 * Is the gate drawn by the schema floor? True for the floor's own id and for an
 * unclaimed id that `resolveHitlGateRenderer` gave the floor. A host decides
 * the answer's shape from this, not from the gate's original `x-renderer` id.
 */
export function gateDrawnBySchemaFloor(
  xRenderer: string,
  entry: FieldRendererEntry | null | undefined,
): boolean {
  return xRenderer === SCHEMA_FIELD_FALLBACK_RENDERER_ID || entry?.id === SCHEMA_FIELD_FALLBACK_RENDERER_ID;
}
