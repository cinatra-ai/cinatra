import "server-only";

// A FIXED STEP ENDS ITS RUN AS FAILED WITH A STATED SENTENCE (cinatra#4890, item D).
//
// `run_fail` is one extension-scoped tool on the passthrough that always
// refuses. The refusal is the passthrough's ordinary 403, so the calling step
// fails and the run ends failed, as for every other refused call: there is no
// second way to fail a run. When the call is admitted, the refusal's text is
// the caller's sentence and nothing else, so the run's error is that sentence.
// Nothing is written: a second call answers the same refusal.
//
// Admitted only for a proven step of the run's bound flow that names this tool
// in its own fixed data; a model step reaches no passthrough tool. The sentence
// is one plain line within the bounds a module's refusal sentence keeps
// (`moduleRefusalSentenceIssue`), with no control character. A sentence outside
// them is refused with its own message, and the sentence is not repeated.

import { moduleRefusalSentenceIssue } from "@/lib/extension-tool-dispatch";

export const RUN_FAIL_TOOL = "run_fail";
/** The code the stated refusal carries, so a reader can tell it from the tool's other refusals. */
export const RUN_FAIL_CODE = "run_fail_stated";

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

export type RunFailOutcome = { ok: false; status: 403; error: string; code?: string };

const refuse = (reason: string): RunFailOutcome => ({ ok: false, status: 403, error: `run_fail: ${reason}` });

/** The answer to one `run_fail` call. Never throws for a bad input; every answer is a refusal. */
export async function runFailOutcome(input: unknown, verifiedStepId: unknown): Promise<RunFailOutcome> {
  if (typeof verifiedStepId !== "string" || verifiedStepId === "") {
    return refuse("the calling step is not proven, so the run is not ended by it");
  }
  const { readProvenStepPassthroughTool } = await import("@/lib/extension-host-context");
  if ((await readProvenStepPassthroughTool()) !== RUN_FAIL_TOOL) {
    return refuse("the calling step does not call this tool, so the run is not ended by it");
  }
  const fields = typeof input === "object" && input !== null && !Array.isArray(input) ? Object.keys(input) : [];
  if (fields.length !== 1 || fields[0] !== "sentence") return refuse("the input takes one field, `sentence`");
  const sentence: unknown = (input as { sentence: unknown }).sentence;
  const issue =
    moduleRefusalSentenceIssue(sentence) ??
    (CONTROL_CHARACTER.test((sentence as string).trim()) ? "the sentence holds a control character" : null);
  if (issue !== null) return refuse(`the sentence is refused (${issue})`);
  return { ok: false, status: 403, error: (sentence as string).trim(), code: RUN_FAIL_CODE };
}
