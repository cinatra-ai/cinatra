/**
 * THE TOMBSTONED RENDERER IDS (cinatra#3471): the retired review gates whose
 * aliases were deleted (register-default-renderers.ts). A step parked under
 * one is RETIRED: no page draws a Continue for it, and no server road sends an
 * answer to it. Pages and server ask the same predicate, `isRetiredHitlStep`.
 * A leaf module, so the server roads read it without the renderer graph.
 */
export const TOMBSTONED_HITL_RENDERER_IDS: ReadonlySet<string> = new Set([
  "@cinatra/email-reviewer-agent:output",
  "@cinatra/email-reviewer-agent:ai-review-panel",
  "ai-review-panel",
]);

/** Is a step parked under this renderer id retired (tombstoned)? */
export function isRetiredHitlStep(xRenderer: string | null | undefined): boolean {
  return typeof xRenderer === "string" && TOMBSTONED_HITL_RENDERER_IDS.has(xRenderer);
}

/** The fixed answer every server road gives to an answer for a retired step. */
export const RETIRED_HITL_STEP_REFUSAL =
  "This step was retired and can no longer be answered; nothing was sent. Start a new run.";
