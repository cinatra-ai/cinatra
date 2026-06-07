/**
 * Upsert wrapper that enforces:
 *   - stale-write guard (incoming jobStartedAt < existing -> SKIPPED)
 *   - manual-row protection (manual rows never overwritten by rule/llm)
 *   - error_message redaction to <=1024 bytes BEFORE write
 *   - injected `now()` and `jobStartedAt` (no Date.now() in this module)
 */

import { redactRawResponse } from "./response-parser";
import { SKILL_MATCH_ERROR_MESSAGE_MAX_BYTES } from "./constants";
import type { SkillMatchRow } from "./types";
import * as defaultStore from "./skill-matches-store";

export type UpsertDeps = {
  /** Time provider (injected so tests can vi.setSystemTime). */
  now: () => Date;
  /** When this job started — drives the stale-write guard. */
  jobStartedAt: Date;
  /** Test override for the store module. Production callers omit this. */
  storeOverride?: typeof defaultStore;
};

export type UpsertResult = { skipped: false } | { skipped: true; reason: string };

/**
 * First redact to 1 KiB, then enforce the DB column 4 KiB cap as a
 * defense-in-depth ceiling. The 1 KiB pass already adds the truncation marker,
 * so the 4 KiB pass is a no-op in practice.
 */
export function redactErrorMessage(message: string): string {
  const onePass = redactRawResponse(message);
  const buffer = Buffer.from(onePass, "utf-8");
  if (buffer.byteLength <= SKILL_MATCH_ERROR_MESSAGE_MAX_BYTES) return onePass;
  return buffer.subarray(0, SKILL_MATCH_ERROR_MESSAGE_MAX_BYTES).toString("utf-8");
}

export async function upsertMatchRow(
  row: Omit<SkillMatchRow, "evaluatedAt" | "jobStartedAt">,
  deps: UpsertDeps,
): Promise<UpsertResult> {
  const store = deps.storeOverride ?? defaultStore;
  const existing = await store.readSkillMatch(row.agentId, row.skillId);

  // Manual rows are NEVER overwritten by rule/llm.
  if (existing && existing.source === "manual" && row.source !== "manual") {
    return { skipped: true, reason: "manual_protected" };
  }

  // Rule-row precedence under stale-write races.
  //
  // The stale-write guard rejects strictly-older incoming writes. But there's a
  // real race where a rule row was written AFTER the batch was submitted: T0 =
  // batch-submit anchor (handleBatchSubmit's submitJobStartedAt), T1 > T0 =
  // inline-for-skill install hook writes source="rule", T2 > T1 = batch poll
  // completes and lands the source="llm" result for the same pair. The batch's
  // payload still carries jobStartedAt = T0, so the stale-write guard correctly
  // rejects it (T0 < T1). But there's an adjacent symmetric race: when the
  // inline rule write happens BEFORE the batch is submitted (T0 < T1), the
  // batch's later jobStartedAt = T1 passes the stale-write guard, overwriting
  // the deterministic source="rule" row with a probabilistic source="llm" row.
  //
  // Rule rows are deterministic — they're the result of match_when YAML
  // evaluating to true on a fixed input. An LLM batch result for the same
  // pair is, by definition, less authoritative than the rule. So when an
  // existing source="rule" row is newer than the incoming source="llm"
  // write's jobStartedAt, we reject the LLM write the same way we reject
  // a manual overwrite. The mirror case (`existing.source === "llm"` and
  // incoming `row.source === "rule"`) is the expected install-hook flow
  // upgrading an old LLM row to a fresh deterministic rule row — we let
  // that through.
  if (
    existing &&
    existing.source === "rule" &&
    row.source === "llm" &&
    deps.jobStartedAt < existing.evaluatedAt
  ) {
    return { skipped: true, reason: "rule_protected" };
  }

  // Strictly older jobStartedAt is rejected. Equal jobStartedAt is
  // last-writer-wins.
  if (existing && deps.jobStartedAt < existing.jobStartedAt) {
    return { skipped: true, reason: "stale_job_started_at" };
  }

  const finalRow: SkillMatchRow = {
    ...row,
    errorMessage: row.errorMessage ? redactErrorMessage(row.errorMessage) : null,
    evaluatedAt: deps.now(),
    jobStartedAt: deps.jobStartedAt,
  };
  await store.upsertSkillMatch(finalRow);
  return { skipped: false };
}
