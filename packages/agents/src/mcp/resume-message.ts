// agent_run_resume's WayFlow resume message: EXTRACTED from handlers.ts
// (file-size ratchet: keep the primitive hub under its ceiling).
//
// Precedence, kept identical to approveReviewTaskInternal (review-task-actions.ts)
// so UI and MCP paths stay in lockstep:
//   1. userResponse (string, non-empty after trim)  — structured-form path,
//      passed through UNCHANGED to preserve JSON formatting.
//   2. approvalNote (string, non-empty after trim) — legacy bare-approval, trimmed.
//   3. fallback "[Approved by operator]"           — bare click-to-approve.
// userResponse wins over approvalNote when both are present; renderers needing
// the approval note delivered to WayFlow must embed it inside the JSON payload.
//
// Payload extraction: the MCP input has no structured `valuesObj`, so on a parse
// failure (or a JSON value that is no object) submittedValues stays null. The
// values are read as the UI approve reads them (`readWayflowSubmittedValues`,
// cinatra#3470): an answer sent inside the attachment envelope is recorded as
// that inner answer (its files under `attachments`), never as the envelope.
import { readWayflowSubmittedValues } from "../hitl-gate-submit";

export function resumeMessageFromInput(
  userResponse: unknown,
  approvalNote: unknown,
): { resumeText: string; trimmedNote: string; submittedValues: Record<string, unknown> | null } {
  const trimmedNote = typeof approvalNote === "string" ? approvalNote.trim() : "";
  let resumeText: string;
  if (typeof userResponse === "string" && userResponse.trim().length > 0) {
    resumeText = userResponse;
  } else if (trimmedNote.length > 0) {
    resumeText = trimmedNote;
  } else {
    resumeText = "[Approved by operator]";
  }
  const submittedValues =
    typeof userResponse === "string" && userResponse.trim().length > 0
      ? readWayflowSubmittedValues({ userResponse })
      : null;
  return { resumeText, trimmedNote, submittedValues };
}
