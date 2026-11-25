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
import {
  ARTIFACT_REVIEW_REDIRECT_RENDERER_ID,
  SCHEMA_FIELD_FALLBACK_RENDERER_ID,
} from "./agent-builder-ids";
import { gateCarriesPresentationHint } from "./hitl-gate-submit";

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
 * DOES A SCREEN STILL DRAW THIS PARKED STEP? The ONE predicate for "this step
 * can be answered", read by every page (`parkedHitlStepIsAnswerable`) and by
 * the server's answer roads (`unanswerableParkedStep`, run-resume-under-claim.ts),
 * so a step a page hides is a step the server refuses. Yes when, and only when:
 *   - the step is recorded with no renderer id (a tool-call approval, answered
 *     by the host's own Approve);
 *   - it is recorded under the plain form's own id
 *     (`SCHEMA_FIELD_FALLBACK_RENDERER_ID`);
 *   - `declared(id)` holds for its recorded renderer id; or
 *   - its values carry a presentation hint (drawn by the host's generic
 *     renderer without a registry entry).
 * Never for a tombstoned id (`isTombstonedHitlRendererId`). Anything else (a
 * pack screen its package no longer ships, such as a pack's own confirmation
 * in place of the host's publish approval, cinatra#4150, or an id the host has
 * never seen) is answered by nothing; the person starts a new run.
 *
 * `declared(id)` reads the sources a page's registry is filled from: on a page,
 * an entry of its registry claims the id; on the server, the host's own scope,
 * a binding of this build or of a package installed at run time names it (or,
 * for a bare compat id, names it as its kind). So a step stays answerable in a
 * workspace whose installed package still declares the screen, whatever the
 * order in which packages change.
 */
export function hitlStepScreenIsAnswerable(
  xRenderer: string,
  values: unknown,
  declared: (id: string) => boolean,
): boolean {
  if (xRenderer === "") return true;
  if (isTombstonedHitlRendererId(xRenderer)) return false;
  if (xRenderer === SCHEMA_FIELD_FALLBACK_RENDERER_ID) return true;
  if (declared(xRenderer)) return true;
  return gateCarriesPresentationHint(values);
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
 * MAY THIS PARKED STEP BE ANSWERED HERE? The one answer every page surface
 * asks before it offers a control for a parked step: the run page's stepper
 * (its Continue), the run panel (its Continue and the gate it hands the chat
 * composer) and the HITL screen card (its Continue). It is
 * `hitlStepScreenIsAnswerable` with the page's registry as the declaration
 * (`claim`: the entry `resolveHitlGateRenderer` resolves), and never for the
 * display-only artifact-review redirect. A step that no screen draws shows "no
 * renderer configured for this step" and no control on the page.
 *
 * The mid-run classification by name (`classifyMidRunHitl`) decides how a
 * drawn step buffers its answer and where its Continue sits; it never makes a
 * step answerable on its own.
 */
export function parkedHitlStepIsAnswerable(
  xRenderer: string,
  claim: { readonly id: string } | null | undefined,
  values?: unknown,
): boolean {
  // The artifact-review redirect is display-only on a page: it goes on only by
  // the review's own decision, whatever its values carry.
  if (xRenderer === ARTIFACT_REVIEW_REDIRECT_RENDERER_ID) return false;
  return hitlStepScreenIsAnswerable(xRenderer, values, () => claim != null);
}
