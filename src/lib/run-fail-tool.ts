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
// is one plain line (`readRunFailSentence`, the rule the run time checks again
// in docker/wayflow/agent_loader.py `_read_run_fail_sentence`; both run the
// cases of docker/wayflow/tests/fixtures/run_fail_parity.json), and here also
// holds no source position, path or secret shape. A sentence outside the rule
// is refused with its own message, and the sentence is not repeated.

import { refusalSentenceShapeIssue } from "@/lib/extension-tool-dispatch";

export const RUN_FAIL_TOOL = "run_fail";
/** The code the stated refusal carries, so a reader can tell it from the tool's other refusals. */
export const RUN_FAIL_CODE = "run_fail_stated";

/** The longest stated sentence, in code points (the run time counts the same). */
export const RUN_FAIL_SENTENCE_MAX = 400;

// THE RULE'S CHARACTER CLASSES, the one place for them on this side. With the
// `u` flag a surrogate range matches only an unpaired surrogate. Zero-width
// joiner and non-joiner are kept: scripts and emoji sequences need them.
const NOT_WELL_FORMED = /[\uD800-\uDFFF]/u;
const LINE_BREAK = /[\n\r\u0085\u2028\u2029]/u;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const DIRECTION_CONTROL = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const INVISIBLE = /[\u200b\u2060\ufeff]/u;

/**
 * A stated sentence: one plain line of well-formed text, spaces at either end
 * left out, at most RUN_FAIL_SENTENCE_MAX code points; or why it is refused.
 */
export function readRunFailSentence(value: unknown): { sentence: string } | { issue: string } {
  if (typeof value !== "string") return { issue: "the sentence is not a string" };
  if (NOT_WELL_FORMED.test(value)) return { issue: "the sentence is not well-formed text" };
  if (LINE_BREAK.test(value)) return { issue: "the sentence holds a line break" };
  if (CONTROL.test(value)) return { issue: "the sentence holds a control character" };
  if (DIRECTION_CONTROL.test(value)) return { issue: "the sentence holds a direction control" };
  if (INVISIBLE.test(value)) return { issue: "the sentence holds an invisible character" };
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === " ") start += 1;
  while (end > start && value[end - 1] === " ") end -= 1;
  const sentence = value.slice(start, end);
  if (sentence === "") return { issue: "the sentence is empty" };
  if ([...sentence].length > RUN_FAIL_SENTENCE_MAX) {
    return { issue: `the sentence is longer than ${RUN_FAIL_SENTENCE_MAX} characters` };
  }
  return { sentence };
}

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
  const read = readRunFailSentence((input as { sentence: unknown }).sentence);
  const issue = "issue" in read ? read.issue : refusalSentenceShapeIssue(read.sentence);
  if (issue !== null) return refuse(`the sentence is refused (${issue})`);
  return { ok: false, status: 403, error: (read as { sentence: string }).sentence, code: RUN_FAIL_CODE };
}
