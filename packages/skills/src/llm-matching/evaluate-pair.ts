/**
 * Shared inner step for evaluating one agent/skill pair.
 *
 * Both the inline transport and the batch transport call this function to
 * convert a single (agent, skill) pair into a SkillMatchRow. Identical row
 * shape across both paths is required so downstream readers can treat inline
 * and batch evaluations the same way.
 *
 * The matcher prompt is rendered entirely from prompt.md via
 * buildPromptForPair. There is no inline classifier-prose system literal in
 * this file; the orchestration call passes a single-word system slot and lets
 * the user prompt (rendered from prompt.md) carry the entire template.
 *
 * When match_when explicitly resolves to true (rule short-circuit), this
 * function performs zero LLM calls and writes a `source: "rule"` row.
 *
 * When match_when YAML is malformed, the raw text flows into the LLM prompt as
 * the {{matchWhenHint}} substitution; there is no match-all fallback.
 */

import { createHash } from "node:crypto";
import { generate as defaultGenerate } from "@cinatra-ai/llm";
import {
  SKILL_MATCH_MODEL,
  SKILL_MATCH_MAX_OUTPUT_TOKENS_PER_PAIR,
  SKILL_MATCH_RETRY_ON_SCHEMA_VIOLATION,
  LLM_MATCHER_VERSION,
} from "./constants";
import { buildPromptForPair } from "./prompt-builder";
import { computeInputHashes } from "./hashes";
import { parseLlmResponse } from "./response-parser";
import {
  checkRationaleGrounding,
  UNGROUNDED_RATIONALE_FALLBACK,
} from "./rationale-grounding";
import { upsertMatchRow, type UpsertDeps, type UpsertResult } from "./upsert";
import { evaluateRuleShortCircuit } from "./rule-short-circuit";
import { parseMatchWhen } from "./match-when-parser";
import type {
  AgentForMatching,
  SkillForMatching,
  SkillMatchRow,
} from "./types";

export type EvaluatePairInput = {
  agent: AgentForMatching;
  skill: SkillForMatching;
};

export type EvaluatePairDeps = UpsertDeps & {
  /** Test override for the LLM gateway. */
  generate?: typeof defaultGenerate;
  /**
   * Cancellation signal forwarded to the orchestration `generate()` call and
   * checked before/after the LLM round-trip. When BullMQ cancels a job
   * mid-flight (admin stops a stuck batch, queue is drained for shutdown), the
   * in-flight OpenAI call can otherwise keep going and eventually land a row in
   * the DB. Passing a `signal` lets the caller short-circuit before the LLM
   * call and on parse completion.
   */
  signal?: AbortSignal;
};

export type EvaluatePairResult = UpsertResult & {
  row?: Omit<SkillMatchRow, "evaluatedAt" | "jobStartedAt">;
};

const STRUCTURED_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    matched: { type: "boolean" },
    score: { type: "number", minimum: 0, maximum: 1 },
    rationale: { type: "string", maxLength: 500 },
  },
  required: ["matched", "score", "rationale"],
  additionalProperties: false,
} as const;

/**
 * Throws DOMException("aborted", "AbortError") when the signal has been
 * aborted. Kept inline (not a shared util) because the matcher core
 * deliberately has zero cross-package dependencies beyond
 * `@cinatra-ai/llm`. The thrown error matches the convention used
 * by `fetch` and Node's `AbortController.signal.throwIfAborted()` so upstream
 * `catch` blocks (BullMQ retry policy, structured-log emitters) recognize it
 * as a cancellation, not a bug.
 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    // Prefer the platform helper when available so the thrown reason is
    // preserved verbatim (allows `signal.reason` to carry caller context).
    if (typeof signal.throwIfAborted === "function") {
      signal.throwIfAborted();
      return;
    }
    throw new DOMException("aborted", "AbortError");
  }
}

export async function evaluatePair(
  input: EvaluatePairInput,
  deps: EvaluatePairDeps,
): Promise<EvaluatePairResult> {
  const generate = deps.generate ?? defaultGenerate;
  const { agent, skill } = input;

  // Short-circuit before doing any work if the signal is already aborted
  // (cancelled queue, admin-stop, shutdown).
  throwIfAborted(deps.signal);

  // Rule short-circuit before any LLM call.
  const ruleRow = evaluateRuleShortCircuit(agent, skill);
  if (ruleRow !== null) {
    const result = await upsertMatchRow(ruleRow, deps);
    return { ...result, row: ruleRow };
  }

  // Malformed match_when: keep raw text and pass it to the LLM as the hint
  // slot. parseMatchWhen also emits a structured warning via console.warn.
  const parsed = parseMatchWhen(skill.matchWhenRaw, skill.skillId);
  const skillForPrompt: SkillForMatching =
    parsed.kind === "malformed" ? { ...skill, matchWhenRaw: parsed.raw } : skill;

  const { agentInputHash, skillInputHash } = computeInputHashes(agent, skill);
  const { system, user } = buildPromptForPair(agent, skillForPrompt);

  // Single in-call retry when the first LLM response fails strict-schema parse.
  // `gpt-4o-mini` occasionally emits malformed JSON on long prompts; a single
  // retry recovers transient flakes without persisting a permanent
  // `status=error` row that admins must clear via "Re-evaluate". The retry uses
  // the same prompt because the structured-output schema is the contract; a
  // free-form addendum such as "the previous output was malformed" is unsafe
  // with strict json_schema enforcement because it could nudge the model to
  // drift the schema. When both attempts fail we tag the error_message with
  // `[after-retry]` so the retry frequency is observable in DB scans without
  // adding a new column.
  let response = await generate({
    provider: "openai",
    model: SKILL_MATCH_MODEL,
    // Both `system` and `prompt` derive from prompt.md via
    // buildPromptForPair() — there are zero inline classifier-prose literals
    // in any *.ts file in this directory. The split point is the first H1 in
    // prompt.md (everything above → system; everything from H1 → user).
    system,
    prompt: user,
    outputSchema: STRUCTURED_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: SKILL_MATCH_MAX_OUTPUT_TOKENS_PER_PAIR,
    // The matcher prompt explicitly forbids tool calls ("Return ONLY a JSON
    // object matching the structured-output schema. ... Do not include any tool
    // calls."). Passing declaredToolboxIds: [] short-circuits the
    // orchestration-layer injectMcpTools step so the Cinatra self-MCP tool is
    // not added to the request. Without this, undefined declaredToolboxIds
    // triggers the legacy always-inject path, causing the prompt to forbid what
    // orchestration silently enables. This is a cross-feature interaction we
    // close at the call site.
    declaredToolboxIds: [],
    // Tag matcher traffic in usage_events so it can be sliced separately from
    // chat / agent / orchestrator calls. Required for eval drift monitoring and
    // cost rollups by call site.
    logLabel: "skill-match",
    // Forward cancellation signal so a cancelled BullMQ job short-circuits the
    // OpenAI call rather than running to completion and writing a row.
    signal: deps.signal,
  });

  // Re-check after the LLM round-trip in case the signal aborted while we were
  // awaiting OpenAI. Throwing here means no DB write happens for the cancelled
  // run.
  throwIfAborted(deps.signal);

  let parsedDecision = parseLlmResponse(response.text ?? "");
  let retryAttempted = false;
  for (
    let attempt = 0;
    !parsedDecision.ok && attempt < SKILL_MATCH_RETRY_ON_SCHEMA_VIOLATION;
    attempt += 1
  ) {
    retryAttempted = true;
    response = await generate({
      provider: "openai",
      model: SKILL_MATCH_MODEL,
      system,
      prompt: user,
      outputSchema: STRUCTURED_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: SKILL_MATCH_MAX_OUTPUT_TOKENS_PER_PAIR,
      declaredToolboxIds: [],
      logLabel: "skill-match",
      signal: deps.signal,
    });
    // Re-check after the retry round-trip too.
    throwIfAborted(deps.signal);
    parsedDecision = parseLlmResponse(response.text ?? "");
  }

  let row: Omit<SkillMatchRow, "evaluatedAt" | "jobStartedAt">;
  if (parsedDecision.ok) {
    // Rationale grounding guard. Only runs on matched=true: a matched=false
    // rationale legitimately discusses why the skill is not useful and may not
    // quote skill content. A matched=true rationale should ground the
    // recommendation in concrete skill/agent specifics; if it doesn't, the
    // model is fabricating. Downgrade the rationale to a conservative fallback
    // and emit a structured warning. The classifier decision (matched + score)
    // is preserved — only the user-visible rationale text changes.
    let finalRationale = parsedDecision.value.rationale;
    if (parsedDecision.value.matched) {
      const grounding = checkRationaleGrounding(
        parsedDecision.value.rationale,
        agent,
        skill,
      );
      if (!grounding.grounded) {
        // Never log the original rationale verbatim. Rationales can echo
        // user-authored personal/team/org skill content or agent descriptions,
        // so emitting them to logs is a PII risk. Log a sha256 hash + length +
        // diagnostic metrics (overlapRatio, rationaleTokenCount, sharedTokens)
        // instead. The hash is stable enough to correlate occurrences across
        // log lines without exposing the text.
        const originalRationaleHash = createHash("sha256")
          .update(parsedDecision.value.rationale, "utf-8")
          .digest("hex")
          .slice(0, 16);
        console.warn(
          JSON.stringify({
            event: "skill-match-ungrounded-rationale",
            agentId: agent.packageId,
            skillId: skill.skillId,
            originalRationaleHash,
            originalRationaleLength: parsedDecision.value.rationale.length,
            overlapRatio: grounding.overlapRatio,
            rationaleTokenCount: grounding.rationaleTokenCount,
            sharedTokens: grounding.sharedTokens,
            evaluatorVersion: LLM_MATCHER_VERSION,
          }),
        );
        finalRationale = UNGROUNDED_RATIONALE_FALLBACK;
      }
    }
    row = {
      agentId: agent.packageId,
      skillId: skill.skillId,
      source: "llm",
      matched: parsedDecision.value.matched,
      score: parsedDecision.value.score,
      rationale: finalRationale,
      evaluatorVersion: LLM_MATCHER_VERSION,
      agentInputHash,
      skillInputHash,
      status: "ok",
      errorCode: null,
      errorMessage: null,
    };
  } else {
    // Prefix `[after-retry] ` when the retry path also failed so operators can
    // grep `cinatra.skill_matches.error_message` for retry frequency without
    // needing a new column. `redactErrorMessage` runs downstream in
    // `upsertMatchRow` and re-trims to <=1024 bytes; the prefix is small (~14
    // bytes) and safely survives the redact pass.
    const errorMessage = retryAttempted
      ? `[after-retry] ${parsedDecision.rawRedacted}`
      : parsedDecision.rawRedacted;
    row = {
      agentId: agent.packageId,
      skillId: skill.skillId,
      source: "llm",
      matched: false,
      score: 0,
      rationale: null,
      evaluatorVersion: LLM_MATCHER_VERSION,
      agentInputHash,
      skillInputHash,
      status: "error",
      errorCode: parsedDecision.errorCode,
      errorMessage,
    };
  }

  const result = await upsertMatchRow(row, deps);
  return { ...result, row };
}
