/**
 * Pure leaf helpers for the WayFlow user_envelope wrap.
 *
 * Lives in its OWN module (no React, no client-only deps, no transitive
 * imports of the host-app's `src/lib/logging.ts`) so the precedence rules
 * can be unit-tested without dragging the full orchestrator-stepper
 * panel into the vitest module graph.
 *
 * Two responsibilities:
 *
 *   1. `pickLegacyResumeText` — mirror the server-side precedence in
 *      `review-task-actions.ts:255` (userResponse → approvalNote →
 *      default). Several renderer-inline paths write `approvalNote` as
 *      the WayFlow resume text; preserving only `userResponse` would
 *      silently clobber those by injecting the default into a field of
 *      higher server precedence.
 *
 *   2. `applyAttachmentEnvelope` — apply the WayFlow user_envelope
 *      to a record payload when one or more attachments are pending.
 *      Caller is responsible for the no-attachments / setup-gate /
 *      non-object gates (those policy decisions stay in the in-component
 *      helper that wraps this transform).
 */
import type { LlmAttachmentRef } from "@cinatra-ai/llm";
import { wrapUserResponseWithAttachments } from "./wayflow-user-response-envelope";

export function pickLegacyResumeText(payload: Record<string, unknown>): string {
  const ur = typeof payload.userResponse === "string" ? payload.userResponse : "";
  if (ur.trim().length > 0) return ur;
  const an = typeof payload.approvalNote === "string" ? payload.approvalNote : "";
  if (an.trim().length > 0) return an.trim();
  return "[Approved by operator]";
}

export function applyAttachmentEnvelope(
  payload: Record<string, unknown>,
  attachments: ReadonlyArray<LlmAttachmentRef>,
): Record<string, unknown> {
  if (attachments.length === 0) return payload;
  const existing = pickLegacyResumeText(payload);
  const wrapped = wrapUserResponseWithAttachments(existing, attachments);
  return { ...payload, userResponse: wrapped.userResponse };
}
