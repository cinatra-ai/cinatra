/**
 * WHETHER A REGENERATE CAN BE DISPATCHED (cinatra#3080 on cinatra#4264).
 *
 * A Regenerate reruns the ONE step its artifact-scoped `regenerate` entry
 * names, with the reviewer's Note in that step's `noteInput`. The ordinary
 * repair drain (`dispatchPendingProducerRepairs`) cannot do that: it runs the
 * whole template with the findings in the template's root
 * `repairFindingsInput`, which is not that input. The road that reruns one step
 * is cinatra#4264's step road, which is not part of this code yet.
 *
 * So, at this head, no Regenerate can be dispatched. The canonical operation
 * (`recordChangesRequested`) therefore REFUSES a Regenerate before anything is
 * written, with the plain reason `REGENERATE_NO_STEP_ROAD`: the gate stays
 * pending, the run stays parked, Comment and Continue work as usual. Recording
 * it instead would settle the gate with nothing that ever answers it.
 *
 * The change that adds the step road to the drain returns `true` here, in the
 * same change. Nothing else may.
 */
export function regenerateStepRoadDispatches(): boolean {
  return false;
}
