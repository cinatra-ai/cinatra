/**
 * WHETHER A REGENERATE CAN BE DISPATCHED (cinatra#3080 on cinatra#4264).
 *
 * A Regenerate reruns the ONE step its artifact-scoped `regenerate` entry
 * names, with the reviewer's Note in that step's `noteInput`. The ordinary
 * repair road of the drain (`dispatchPendingProducerRepairs`) cannot do that:
 * it runs the whole template with the findings in the template's root
 * `repairFindingsInput`, which is not that input. The road that reruns one
 * step is cinatra#4264's step road: the drain plans every Regenerate intent
 * through `planSegmentDispatch` (`./regenerate-segment`), which starts the
 * segment run or refuses it, and a refused one is escalated to a person.
 *
 * The step road is part of the drain, so this answers `true`: the canonical
 * operation (`recordChangesRequested`) records a declared Regenerate, and the
 * drain dispatches it on the step road. When this answers `false`, the
 * canonical operation refuses a Regenerate before anything is written, with
 * the plain reason `REGENERATE_NO_STEP_ROAD` (the gate stays pending, the run
 * stays parked, Comment and Continue work as usual), and the drain escalates
 * any row that names one; recording it would otherwise settle the gate with
 * nothing that ever answers it.
 */
export function regenerateStepRoadDispatches(): boolean {
  return true;
}
