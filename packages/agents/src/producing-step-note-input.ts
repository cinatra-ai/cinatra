// ---------------------------------------------------------------------------
// producing-step-note-input (cinatra#3080, acceptance item 4)
//
// THE ONE QUESTION REGENERATE ASKS of the run under review: which text input of
// the step that produced this work does the reviewer's Note fill? The decision
// of 2026-10-13 settles the answer's shape. A step may declare, optionally, the
// one text input that the Note fills (for a picture, its prompt). Regenerate
// re-runs that step with the Note in exactly that input. A review whose
// producing step declares no such input refuses Regenerate with a plain reason.
// Comment and Continue work as usual.
//
// THE READ IS THE NARROWEST HONEST ONE. The agent manifest's lifecycle block
// (`agentLifecycleDeclarationSchema` in `verdaccio/package-contract.ts`) is
// STRICT and has no step-level Note-input field yet. No step can therefore
// declare one, and this read finds none for every run. It does NOT fall back to
// the agent-level `repairCapable` boolean: that flag says the agent can answer
// a typed repair request. It does not name the input the Note goes into, and
// reading it as if it did is the proxy the decision rules out.
//
// When the contract gains the declaration field (with its migration), this is
// the one place that reads it. Until then every Regenerate is refused here.
// ---------------------------------------------------------------------------

/**
 * The name of the text input that the producing step of `producerRunId`
 * declares for the reviewer's Note, or null when it declares none.
 *
 * Always null today: the contract has no field that could hold such a
 * declaration, so there is nothing to read. Callers treat null as "Regenerate
 * is not available on this review".
 */
export async function readProducingStepNoteInput(
  producerRunId: string | null,
): Promise<string | null> {
  // No declaration field exists in the contract yet; the run is named so the
  // signature already carries what the real read will key on.
  void producerRunId;
  return null;
}
