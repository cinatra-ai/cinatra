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

/** Gate ids a host draws inline, never through a field renderer: no floor for them. */
const HOST_INLINE_GATE_IDS: ReadonlySet<string> = new Set([
  ARTIFACT_REVIEW_REDIRECT_RENDERER_ID,
  TRIGGER_WAIT_STATUS_RENDERER_ID,
]);

/**
 * The entry a LIVE HITL gate is drawn with. A gate whose `x-renderer` id no
 * entry claims (a package dropped the binding while a run was parked at that
 * step) falls to the schema floor, the entry registered under
 * `SCHEMA_FIELD_FALLBACK_RENDERER_ID`, so the person can still answer the
 * step from its stored schema and the run can resume. This is the floor a
 * not-in-build binding of a known kind already draws.
 *
 * Fail-safe: only a namespaced id gets the floor; an empty or bare id, and an
 * id a host draws inline, keep no renderer. The registry's own `resolve` is
 * unchanged, so a field inside a form never takes the floor's Continue.
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
    HOST_INLINE_GATE_IDS.has(xRenderer)
  ) {
    return null;
  }
  return fieldRendererRegistry.list().find((e) => e.id === SCHEMA_FIELD_FALLBACK_RENDERER_ID) ?? null;
}
