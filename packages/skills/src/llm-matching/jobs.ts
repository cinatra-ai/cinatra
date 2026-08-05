import "server-only";

/**
 * BullMQ job handlers wiring the evaluator core into inline + run transports.
 *
 *   - handleInlineForSkill — fan out one skill across all matchable agents.
 *   - handleInlineForAgent — fan out one agent across all matchable skills.
 *   - handleBatchSubmit    — mint the FROZEN run context, then capability-route:
 *                            providers with a batch surface get a neutral
 *                            batch-v2 submission; batch-less providers get a
 *                            chunked synchronous full-catalog fan-out. Both
 *                            persist ONE `skill_match_batch_runs` row carrying
 *                            the run context + the per-request submission
 *                            manifest.
 *   - handleBatchPoll      — drive an in-flight run to completion. For provider
 *                            batches: retrieve neutral state, map it onto the
 *                            persisted status vocabulary, and on `ended`
 *                            download BOTH result streams and upsert rows
 *                            through the submission manifest. For synchronous
 *                            runs: process the next manifest chunk (progress +
 *                            cancel semantics between chunks).
 *
 * --- Frozen run context (setup-flow S6) ------------------------------------
 *
 * `{provider, model, evaluatorVersion}` is minted ONCE at run creation from the
 * committed default provider at that instant, persisted on the batch-run
 * record, and threaded through every stage — submit, poll, download, cancel,
 * inline continuations. No stage re-resolves the live default mid-run, so an
 * admin default change mid-run cannot cross providers, and a deploy that bumps
 * the evaluator version cannot orphan or mislabel in-flight results.
 *
 * --- Submission manifest ----------------------------------------------------
 *
 * Poll-side result mapping goes THROUGH the durable per-request manifest
 * written at submit time (keyed by customId, carrying submit-time input
 * hashes) — never through reconstruction from the live catalog. A result whose
 * pair was edited or deleted mid-batch is DISCARDED (the staleness sweep /
 * install hooks re-evaluate it against current content).
 *
 * `pairCustomId` uses a NULL-byte separator. Space cannot be used because
 * skill IDs may contain spaces; the null byte cannot appear in a valid id or
 * version string.
 *
 * Batch request construction calls the SAME `buildPromptForPair()` used by the
 * inline path (loaded from prompt.md at module init). NO inline system-prompt
 * string anywhere in this file. The structured-output schema is passed RAW —
 * per-provider sanitization happens once at the core→adapter seam inside
 * `orchestrateSubmitBatchV2`.
 *
 * Every write to `skill_match_batch_runs.error_message` MUST wrap the value
 * with `redactErrorMessage()` (cell <= 1024 bytes).
 */

import { createHash, randomUUID } from "node:crypto";
import {
  probeBatchCapability as defaultProbeBatchCapability,
  orchestrateSubmitBatchV2 as defaultSubmitBatchV2,
  orchestrateRetrieveBatchV2 as defaultRetrieveBatchV2,
  orchestrateDownloadBatchOutcomesV2 as defaultDownloadBatchOutcomesV2,
  orchestrateCancelBatchV2 as defaultCancelBatchV2,
  type LlmProvider,
  type LlmBatchV2Outcome,
  type LlmBatchV2Request,
} from "@cinatra-ai/llm";
import type { ActorContext } from "@/lib/authz/actor-context";
import { enqueueBackgroundJob, BACKGROUND_JOB_NAMES } from "@/lib/background-jobs";
// `readAgentsCatalog` (host-side) and `getInstalledSkillById` /
// `listInstalledSkills` (registry-side, but transitively coupled to
// `@/lib/agents-store`) used to be imported here. They were the root of the
// Skills ⇄ Agents circular dependency: this file is in `@cinatra-ai/skills`,
// but it imported `@/lib/agents-store`, which in turn imports
// `@cinatra-ai/skills` for `readSkillsCatalog`, `skillMatchesStore` etc. The
// cycle is broken by injecting a `CatalogProvider` seam at the dispatch site
// (`src/lib/background-jobs.ts`).
import {
  evaluatePair,
  upsertMatchRow,
  buildPromptForPair,
  parseLlmResponse,
  computeInputHashes,
  redactErrorMessage,
  evaluateRuleShortCircuit,
  adaptAgentForMatching,
  adaptSkillForMatching,
  SKILL_MATCH_MAX_PAIRS_PER_INLINE_EVENT,
  SKILL_MATCH_MAX_OUTPUT_TOKENS_PER_PAIR,
  // Single source of truth for the persisted batch-run status vocabulary.
  BATCH_STATUS_TERMINAL,
} from "./index";
import {
  LLM_MATCHER_VERSION,
  SKILL_MATCH_INLINE_JOB_ATTEMPTS,
  SKILL_MATCH_JOB_BACKOFF_MS,
  SKILL_MATCH_POLL_JOB_ATTEMPTS,
  SKILL_MATCH_SYNC_CHUNK_JOB_ATTEMPTS,
  SKILL_MATCH_SYNC_RUN_CHUNK_SIZE,
  SKILL_MATCH_SYNC_RUN_PREFIX,
  mapBatchV2StatusToPersisted,
} from "./constants";
import {
  checkRationaleGrounding,
  UNGROUNDED_RATIONALE_FALLBACK,
} from "./rationale-grounding";
import { mintSkillMatchRunContext, coerceRunContext, type MintRunContext } from "./run-context";
import type {
  AgentForMatching,
  CatalogAgent,
  CatalogProvider,
  CatalogSkill,
  SkillForMatching,
  SkillMatchRow,
  SkillMatchRunContext,
  SkillMatchSubmissionManifestEntry,
} from "./types";
import {
  insertBatchRun,
  updateBatchRun,
  readBatchRun,
  type SkillMatchBatchRun,
} from "./batch-runs-store";

// ---------------------------------------------------------------------------
// Injectable seams
// ---------------------------------------------------------------------------

/**
 * Batch orchestration seams, injectable so unit tests drive the handlers
 * without mocking the whole `@cinatra-ai/llm` barrel. Production dispatch
 * omits them (defaults reach the real orchestration layer).
 */
export type BatchOrchestrationSeams = {
  probeBatchCapability?: typeof defaultProbeBatchCapability;
  submitBatchV2?: typeof defaultSubmitBatchV2;
  retrieveBatchV2?: typeof defaultRetrieveBatchV2;
  downloadBatchOutcomesV2?: typeof defaultDownloadBatchOutcomesV2;
  cancelBatchV2?: typeof defaultCancelBatchV2;
};

export type SkillMatchJobDeps = {
  catalog: CatalogProvider;
  /**
   * Explicit actor source (setup-flow S6): production deterministic LLM calls
   * fail closed without an actor frame, and the background handlers mint no
   * ambient one. Threaded verbatim into `evaluatePair`.
   */
  actorContext?: ActorContext;
  /** Run-context mint seam (defaults to the real resolver). */
  mintRunContext?: MintRunContext;
  batch?: BatchOrchestrationSeams;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Pair custom_id (batch custom_id; both providers cap at 64 chars).
 *
 * sha256(`${agentId}\0${skillId}\0${evaluatorVersion}`) sliced to 32
 * hex chars. NULL byte separator chosen because skill IDs may contain spaces
 * (e.g. local skills with display names) — null byte cannot appear in valid
 * input (Postgres text columns reject 0x00), so collisions are impossible
 * via separator ambiguity.
 *
 * The 32-hex-char truncation is intentional and safe at current scale
 * (128 bits of entropy; birthday-collision ~1e-9 at 10^5 pairs). Since the
 * submission manifest (not id reconstruction) maps results back to pairs, a
 * future widening is a single-call-site change with no migration concern.
 */
function pairCustomId(
  agentId: string,
  skillId: string,
  evaluatorVersion: string,
): string {
  const NUL = String.fromCharCode(0);
  return createHash("sha256")
    .update(`${agentId}${NUL}${skillId}${NUL}${evaluatorVersion}`, "utf-8")
    .digest("hex")
    .slice(0, 32);
}

/**
 * sha256(id) prefix, used to build continuation jobIds (mirrors the helper in
 * event-hooks.ts). Ids may contain `:` / `@` / `/` / spaces; a hash makes the
 * jobId contract explicit and BullMQ-safe.
 */
function hashId(s: string): string {
  return createHash("sha256").update(s, "utf-8").digest("hex").slice(0, 16);
}

/** DOMException-convention AbortError check (matches evaluate-pair's throw). */
function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/**
 * Cross-realm-safe check for the orchestration layer's BatchNotSupportedError
 * (name + stable `code` are set by its constructor; `instanceof` alone can
 * fail across duplicated module instances in test/bundle realms).
 */
function isBatchNotSupportedError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "BatchNotSupportedError" ||
      (err as { code?: unknown }).code === "batch_not_supported")
  );
}

// The per-file `adaptAgent` / `adaptSkill` / `extractMatchWhenRaw` helpers
// used to live here; they're now sourced from the shared `./adapters` module
// so the inline, batch, and admin re-evaluate transports all compute the same
// SkillForMatching shape (same matchWhenRaw, same skillInputHash).
const adaptAgent: (a: CatalogAgent) => AgentForMatching = adaptAgentForMatching;
function adaptSkill(s: CatalogSkill): SkillForMatching {
  return adaptSkillForMatching({
    id: s.id,
    name: s.name,
    level: s.level,
    content: s.content ?? "",
    agentId: undefined,
  });
}

/**
 * Failure-taxonomy wrapper for one pair inside a windowed job:
 *
 *   - `AbortError` escapes immediately (cancellation, never retried).
 *   - Any other throw is an invocation/resolution failure: logged with the
 *     pair identity, then RETHROWN so BullMQ retries the (idempotent) window
 *     with the bounded attempts/backoff set at the enqueue site. Malformed
 *     LLM responses never throw — they land as terminal `status=error` rows
 *     inside `evaluatePair`.
 *
 * Returns the number of pairs skipped because no LLM runtime is configured
 * (0 or 1) so callers can aggregate a job-level count.
 */
async function evaluatePairCounted(
  label: string,
  pair: { agent: AgentForMatching; skill: SkillForMatching },
  deps: Parameters<typeof evaluatePair>[1],
): Promise<number> {
  try {
    const result = await evaluatePair(pair, deps);
    return result.skipped && result.reason === "no_llm_runtime" ? 1 : 0;
  } catch (err) {
    if (isAbortError(err)) throw err;
    console.warn(
      `[skill-match] ${label} failed for ${pair.agent.packageId} × ${pair.skill.skillId}:`,
      err,
    );
    throw err;
  }
}

function logSkippedPairs(jobLabel: string, skippedPairs: number): void {
  if (skippedPairs === 0) return;
  // Log-only by design (failure taxonomy): no runtime ⇒ clean skip retaining
  // last-good rows; the count makes the skip measurable without a new column.
  console.info(
    JSON.stringify({
      event: "skill_match_pairs_skipped_no_runtime",
      job: jobLabel,
      skippedPairs,
    }),
  );
}

// ---------------------------------------------------------------------------
// Job: SKILL_MATCH_INLINE_FOR_SKILL — one skill × all matchable agents
// ---------------------------------------------------------------------------

export async function handleInlineForSkill(
  data: {
    skillId: string;
    jobStartedAt: string;
    /** Continuation cursor into `candidateIds` (default 0). */
    offset?: number;
    /**
     * Frozen, deterministically-ordered agent packageId list captured on the
     * first invocation and threaded through continuations. Freezing the SET
     * makes chunked fan-out immune to catalog churn mid-run (no skip, no
     * duplicate); each window still re-resolves CURRENT agent content by id.
     */
    candidateIds?: string[];
    /**
     * Unique per-run nonce minted on the first invocation and threaded through
     * continuations. Distinguishes two concurrent fan-outs of the same skill in
     * the continuation jobId (a wall-clock ms anchor could collide for runs
     * starting in the same millisecond).
     */
    runNonce?: string;
    /**
     * FROZEN run context, minted on the first invocation and threaded through
     * continuations verbatim (never re-resolved mid-run). `null` is a real
     * value: "no runtime at run creation" stays true for the whole run.
     */
    runContext?: SkillMatchRunContext | null;
  },
  deps: SkillMatchJobDeps,
): Promise<void> {
  const jobStartedAt = new Date(data.jobStartedAt);
  const runNonce = data.runNonce ?? randomUUID();
  const skill = await deps.catalog.getSkillById(data.skillId);
  if (!skill) return; // skill uninstalled while job pending — drop silently.

  // SEED handoff: the externally-enqueued job carries no runContext key. It
  // mints the frozen context + candidate set and hands off to a fully-frozen
  // eval job WITHOUT evaluating anything itself. This keeps the mint
  // retryable (a resolver failure fails the seed, BullMQ retries it) while
  // making a BullMQ retry incapable of splitting one logical fan-out across
  // two contexts: every job that EVALUATES carries the frozen payload, and a
  // re-minted seed retry has, by construction, evaluated nothing yet.
  if (data.runContext === undefined) {
    const runContext = await (deps.mintRunContext ?? mintSkillMatchRunContext)();
    const agents = await deps.catalog.readAgents();
    // Freeze the ordered candidate set (de-duplicated so a pair is never
    // evaluated twice and the window math stays exact); eval jobs reuse the
    // frozen list rather than re-deriving it from a possibly-mutated catalog.
    const candidateIds = [...new Set(agents.map((a) => a.packageId))].sort((x, y) =>
      x.localeCompare(y),
    );
    if (candidateIds.length === 0) return;
    await enqueueBackgroundJob(
      BACKGROUND_JOB_NAMES.SKILL_MATCH_INLINE_FOR_SKILL,
      {
        skillId: data.skillId,
        jobStartedAt: data.jobStartedAt,
        offset: 0,
        candidateIds,
        runNonce,
        runContext,
      },
      {
        jobId: `skill-match-inline-for-skill-${hashId(data.skillId)}-${LLM_MATCHER_VERSION}-${runNonce}-off0`,
        attempts: SKILL_MATCH_INLINE_JOB_ATTEMPTS,
        backoff: { type: "exponential", delay: SKILL_MATCH_JOB_BACKOFF_MS },
        inheritActorContext: false,
      },
    );
    return;
  }

  const runContext = coerceRunContext(data.runContext);
  const adaptedSkill = adaptSkill(skill);

  const agents = await deps.catalog.readAgents();
  const agentByPackageId = new Map(agents.map((a) => [a.packageId, a]));

  const candidateIds = data.candidateIds ?? [];
  const offset = data.offset ?? 0;
  const window = candidateIds.slice(offset, offset + SKILL_MATCH_MAX_PAIRS_PER_INLINE_EVENT);

  let skippedPairs = 0;
  for (const packageId of window) {
    const agent = agentByPackageId.get(packageId);
    if (!agent) continue; // uninstalled since the snapshot — skip (self-heals).
    const adapted = adaptAgent(agent);
    skippedPairs += await evaluatePairCounted(
      "inline-for-skill",
      { agent: adapted, skill: adaptedSkill },
      {
        now: () => new Date(),
        jobStartedAt,
        runContext,
        actorContext: deps.actorContext,
      },
    );
  }
  logSkippedPairs("inline-for-skill", skippedPairs);

  const nextOffset = offset + SKILL_MATCH_MAX_PAIRS_PER_INLINE_EVENT;
  if (nextOffset < candidateIds.length) {
    // Chunk the remainder via a continuation instead of silently dropping it.
    // SAME jobStartedAt anchors the whole fan-out under the stale-write guard;
    // SAME frozen runContext keeps a mid-run default change out of the run.
    await enqueueBackgroundJob(
      BACKGROUND_JOB_NAMES.SKILL_MATCH_INLINE_FOR_SKILL,
      {
        skillId: data.skillId,
        jobStartedAt: data.jobStartedAt,
        offset: nextOffset,
        candidateIds,
        runNonce,
        runContext,
      },
      {
        jobId: `skill-match-inline-for-skill-${hashId(data.skillId)}-${LLM_MATCHER_VERSION}-${runNonce}-off${nextOffset}`,
        attempts: SKILL_MATCH_INLINE_JOB_ATTEMPTS,
        backoff: { type: "exponential", delay: SKILL_MATCH_JOB_BACKOFF_MS },
        inheritActorContext: false,
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Job: SKILL_MATCH_INLINE_FOR_AGENT — one agent × all matchable skills
// ---------------------------------------------------------------------------

export async function handleInlineForAgent(
  data: {
    agentId: string;
    jobStartedAt: string;
    /** Continuation cursor into `candidateIds` (default 0). */
    offset?: number;
    /** Frozen, deterministically-ordered candidate skill-id list (see for-skill). */
    candidateIds?: string[];
    /** Unique per-run nonce threaded through continuations (see for-skill). */
    runNonce?: string;
    /** Frozen run context threaded through continuations (see for-skill). */
    runContext?: SkillMatchRunContext | null;
  },
  deps: SkillMatchJobDeps,
): Promise<void> {
  const jobStartedAt = new Date(data.jobStartedAt);
  const runNonce = data.runNonce ?? randomUUID();
  const agents = await deps.catalog.readAgents();
  const agent = agents.find((a) => a.packageId === data.agentId);
  if (!agent) return; // agent deleted while job pending — drop.

  // SEED handoff — see handleInlineForSkill. Skip level=agent (self-match)
  // and level=system (global inject) when deriving the frozen candidate set.
  if (data.runContext === undefined) {
    const runContext = await (deps.mintRunContext ?? mintSkillMatchRunContext)();
    const seedSkills = await deps.catalog.listSkills();
    const candidateIds = [
      ...new Set(
        seedSkills
          .filter((s) => s.level !== "agent" && s.level !== "system")
          .map((s) => s.id),
      ),
    ].sort((x, y) => x.localeCompare(y));
    if (candidateIds.length === 0) return;
    await enqueueBackgroundJob(
      BACKGROUND_JOB_NAMES.SKILL_MATCH_INLINE_FOR_AGENT,
      {
        agentId: data.agentId,
        jobStartedAt: data.jobStartedAt,
        offset: 0,
        candidateIds,
        runNonce,
        runContext,
      },
      {
        jobId: `skill-match-inline-for-agent-${hashId(data.agentId)}-${LLM_MATCHER_VERSION}-${runNonce}-off0`,
        attempts: SKILL_MATCH_INLINE_JOB_ATTEMPTS,
        backoff: { type: "exponential", delay: SKILL_MATCH_JOB_BACKOFF_MS },
        inheritActorContext: false,
      },
    );
    return;
  }

  const runContext = coerceRunContext(data.runContext);
  const adaptedAgent = adaptAgent(agent);

  const skills = await deps.catalog.listSkills();
  const skillById = new Map(skills.map((s) => [s.id, s]));

  const candidateIds = data.candidateIds ?? [];
  const offset = data.offset ?? 0;
  const window = candidateIds.slice(offset, offset + SKILL_MATCH_MAX_PAIRS_PER_INLINE_EVENT);

  let skippedPairs = 0;
  for (const skillId of window) {
    const skill = skillById.get(skillId);
    if (!skill) continue; // uninstalled since the snapshot — skip.
    // Defensive: a skill re-levelled to agent/system since the snapshot is not
    // a cross-agent match candidate.
    if (skill.level === "agent" || skill.level === "system") continue;
    skippedPairs += await evaluatePairCounted(
      "inline-for-agent",
      { agent: adaptedAgent, skill: adaptSkill(skill) },
      {
        now: () => new Date(),
        jobStartedAt,
        runContext,
        actorContext: deps.actorContext,
      },
    );
  }
  logSkippedPairs("inline-for-agent", skippedPairs);

  const nextOffset = offset + SKILL_MATCH_MAX_PAIRS_PER_INLINE_EVENT;
  if (nextOffset < candidateIds.length) {
    await enqueueBackgroundJob(
      BACKGROUND_JOB_NAMES.SKILL_MATCH_INLINE_FOR_AGENT,
      {
        agentId: data.agentId,
        jobStartedAt: data.jobStartedAt,
        offset: nextOffset,
        candidateIds,
        runNonce,
        runContext,
      },
      {
        jobId: `skill-match-inline-for-agent-${hashId(data.agentId)}-${LLM_MATCHER_VERSION}-${runNonce}-off${nextOffset}`,
        attempts: SKILL_MATCH_INLINE_JOB_ATTEMPTS,
        backoff: { type: "exponential", delay: SKILL_MATCH_JOB_BACKOFF_MS },
        inheritActorContext: false,
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Job: SKILL_MATCH_BATCH_SUBMIT — capability-routed full-catalog run
// ---------------------------------------------------------------------------

const STRUCTURED_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    matched: { type: "boolean" },
    // Strict bounds in structured-output schema. Passed RAW: per-provider
    // keyword sanitization happens ONCE at the core→adapter seam inside
    // orchestrateSubmitBatchV2 (providers that reject numeric bounds get a
    // sanitized copy; nothing downstream re-sanitizes).
    score: { type: "number", minimum: 0, maximum: 1 },
    rationale: { type: "string", maxLength: 500 },
  },
  required: ["matched", "score", "rationale"],
  additionalProperties: false,
} as const;

export async function handleBatchSubmit(
  data: { submittedBy: string },
  deps: SkillMatchJobDeps,
): Promise<void> {
  // Capture the submit-time anchor BEFORE any catalog/skill reads. If we
  // captured it after the reads, an inline write that landed between the
  // catalog read and this line would have a `jobStartedAt` newer than the
  // batch's submitJobStartedAt — but the batch poll's payload would still
  // carry submitJobStartedAt → the inline write could be overwritten by a
  // stale batch result via the stale-write guard. Anchoring first serializes
  // the submit window before any input snapshot.
  const submitJobStartedAt = new Date();

  // Mint the FROZEN run context — once, here, at run creation.
  const runContext = await (deps.mintRunContext ?? mintSkillMatchRunContext)();

  const agents = (await deps.catalog.readAgents()).map(adaptAgent);
  const skills = (await deps.catalog.listSkills())
    .filter((s) => s.level !== "agent" && s.level !== "system")
    .map(adaptSkill);

  const llmPairs: Array<{ agent: AgentForMatching; skill: SkillForMatching }> = [];
  let ruleShortCircuited = 0;
  for (const agent of agents) {
    for (const skill of skills) {
      // Apply the SAME rule short-circuit as the inline transport BEFORE the
      // pair reaches the LLM leg. Rule rows are deterministic and free — and
      // need no LLM runtime at all.
      const ruleRow = evaluateRuleShortCircuit(agent, skill);
      if (ruleRow !== null) {
        await upsertMatchRow(ruleRow, {
          now: () => new Date(),
          jobStartedAt: submitJobStartedAt,
        });
        ruleShortCircuited += 1;
        continue;
      }
      llmPairs.push({ agent, skill });
    }
  }

  if (ruleShortCircuited > 0) {
    console.info(
      JSON.stringify({
        event: "skill_match_batch_rule_short_circuit",
        ruleShortCircuited,
        llmPairs: llmPairs.length,
      }),
    );
  }

  if (llmPairs.length === 0) return;

  // No configured runtime ⇒ clean skip: rule rows above were still written,
  // last-good LLM rows are retained, and the skip is measurable via the
  // job-level count. No run row is created (there is no run to track).
  if (runContext === null) {
    logSkippedPairs("batch-submit", llmPairs.length);
    return;
  }

  // Build the durable per-request submission manifest — customId → pair
  // identity + SUBMIT-TIME input hashes. Poll-side mapping goes through this
  // manifest only.
  const manifest: SkillMatchSubmissionManifestEntry[] = [];
  const requests: LlmBatchV2Request[] = [];
  for (const { agent, skill } of llmPairs) {
    const { agentInputHash, skillInputHash } = computeInputHashes(agent, skill);
    const customId = pairCustomId(
      agent.packageId,
      skill.skillId,
      runContext.evaluatorVersion,
    );
    manifest.push({
      customId,
      agentId: agent.packageId,
      skillId: skill.skillId,
      agentInputHash,
      skillInputHash,
    });
    // Call the SAME buildPromptForPair() used by the inline path.
    // Returns { system, user } both rendered from prompt.md (split at the
    // first H1). There are NO inline classifier-prose literals anywhere in
    // this file or any other *.ts file in this directory.
    const { system, user } = buildPromptForPair(agent, skill);
    requests.push({
      customId,
      model: runContext.model,
      system,
      messages: [{ role: "user", content: user }],
      maxTokens: SKILL_MATCH_MAX_OUTPUT_TOKENS_PER_PAIR,
      outputSchema: STRUCTURED_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    });
  }

  // Capability routing: the adapter's declared batch surface decides the path.
  const probe = deps.batch?.probeBatchCapability ?? defaultProbeBatchCapability;
  const support = await probe(runContext.provider as LlmProvider);

  const jobStartedAt = submitJobStartedAt.toISOString();

  if (support.batchVersion !== null) {
    // ---- Provider batch path (neutral batch-v2; v1 bridged inside) --------
    const submitBatch = deps.batch?.submitBatchV2 ?? defaultSubmitBatchV2;
    const submit = await submitBatch({
      provider: runContext.provider as LlmProvider,
      requests,
      metadata: {
        evaluatorVersion: runContext.evaluatorVersion,
        submittedBy: data.submittedBy,
      },
    });

    // INVARIANT: a run with an outstanding manifest is never persisted
    // terminal. A batch that already reports "ended" at submit time still has
    // undrained outcomes — persist the in-flight "finalizing" literal so the
    // poll chain drains it (the poll's ended branch applies the outcomes and
    // only then writes "completed"). A batch-level "failed" at submit never
    // acquires outcomes, so it is honestly terminal and sheds the manifest.
    const submitStatus = mapBatchV2StatusToPersisted(submit.status);
    const failedAtSubmit = submitStatus === "failed";
    await insertBatchRun({
      batchId: submit.batchId,
      submittedBy: data.submittedBy,
      submittedAt: new Date(),
      pairCount: requests.length,
      inputFileId: null,
      outputFileId: null,
      errorFileId: null,
      status: submitStatus === "completed" ? "finalizing" : submitStatus,
      lastPolledAt: null,
      completedAt: failedAtSubmit ? new Date() : null,
      errorMessage: null,
      evaluatorVersion: runContext.evaluatorVersion,
      provider: runContext.provider,
      model: runContext.model,
      manifest: failedAtSubmit ? null : manifest,
      processedPairCount: 0,
    });
    if (failedAtSubmit) return;

    // Schedule first poll in 30s. Timestamped jobId so each poll is distinct
    // (no BullMQ HSETNX coalescing across rescheduled polls). Use the captured
    // submitJobStartedAt so the poll's jobStartedAt matches the rule-row
    // upserts written above.
    await enqueueBackgroundJob(
      BACKGROUND_JOB_NAMES.SKILL_MATCH_BATCH_POLL,
      { batchId: submit.batchId, jobStartedAt },
      {
        jobId: `skill-match-batch-poll-${submit.batchId}-${Date.now()}`,
        delay: 30_000,
        attempts: SKILL_MATCH_POLL_JOB_ATTEMPTS,
        backoff: { type: "exponential", delay: SKILL_MATCH_JOB_BACKOFF_MS },
        // SYSTEM_JOB worker-internal enqueue; avoid inheriting HumanUser
        // attribution. See docs/developer/notifications.md.
        inheritActorContext: false,
      },
    );
    return;
  }

  // ---- Synchronous fan-out path (batch-less provider) ---------------------
  const syncBatchId = `${SKILL_MATCH_SYNC_RUN_PREFIX}${randomUUID()}`;
  await insertBatchRun({
    batchId: syncBatchId,
    submittedBy: data.submittedBy,
    submittedAt: new Date(),
    pairCount: manifest.length,
    inputFileId: null,
    outputFileId: null,
    errorFileId: null,
    status: "in_progress",
    lastPolledAt: null,
    completedAt: null,
    errorMessage: null,
    evaluatorVersion: runContext.evaluatorVersion,
    provider: runContext.provider,
    model: runContext.model,
    manifest,
    processedPairCount: 0,
  });

  console.info(
    JSON.stringify({
      event: "skill_match_sync_run_started",
      batchId: syncBatchId,
      provider: runContext.provider,
      model: runContext.model,
      pairCount: manifest.length,
    }),
  );

  await enqueueBackgroundJob(
    BACKGROUND_JOB_NAMES.SKILL_MATCH_BATCH_POLL,
    { batchId: syncBatchId, jobStartedAt },
    {
      jobId: `skill-match-batch-poll-${syncBatchId}-${Date.now()}`,
      attempts: SKILL_MATCH_SYNC_CHUNK_JOB_ATTEMPTS,
      backoff: { type: "exponential", delay: SKILL_MATCH_JOB_BACKOFF_MS },
      inheritActorContext: false,
    },
  );
}

// ---------------------------------------------------------------------------
// Job: SKILL_MATCH_BATCH_POLL — drive an in-flight run (both paths)
// ---------------------------------------------------------------------------

// Alias the centralized set so the call sites below stay readable.
const TERMINAL_STATUSES = BATCH_STATUS_TERMINAL;

export async function handleBatchPoll(
  data: {
    batchId: string;
    jobStartedAt: string;
  },
  deps: SkillMatchJobDeps,
): Promise<void> {
  const jobStartedAt = new Date(data.jobStartedAt);
  const existing = await readBatchRun(data.batchId);
  if (!existing) return; // unknown batch — drop.
  if (TERMINAL_STATUSES.has(existing.status)) return;

  if (existing.batchId.startsWith(SKILL_MATCH_SYNC_RUN_PREFIX)) {
    await processSyncRunChunk(existing, jobStartedAt, data.jobStartedAt, deps);
    return;
  }

  // ---- Provider batch path ------------------------------------------------
  // Stale-poll guard.
  if (existing.lastPolledAt && Date.now() - existing.lastPolledAt.getTime() < 25_000) {
    // Re-enqueue the next poll at the normal 30s cadence so the polling chain
    // survives a stale-poll race (BullMQ retry, restart-triggered replay,
    // clock skew). Without this, an early-return here silently terminates the
    // entire chain — the batch row stays in-flight forever and results are
    // never written.
    await enqueueBackgroundJob(
      BACKGROUND_JOB_NAMES.SKILL_MATCH_BATCH_POLL,
      { batchId: data.batchId, jobStartedAt: data.jobStartedAt },
      {
        jobId: `skill-match-batch-poll-${data.batchId}-${Date.now()}`,
        delay: 30_000,
        attempts: SKILL_MATCH_POLL_JOB_ATTEMPTS,
        backoff: { type: "exponential", delay: SKILL_MATCH_JOB_BACKOFF_MS },
        inheritActorContext: false,
      },
    );
    return;
  }

  // The FROZEN provider from the run record — NEVER the live default. A run
  // persisted before provenance existed can only have been an OpenAI v1 batch
  // (the pipeline was OpenAI-hardwired), so that is the honest fallback.
  const provider = (existing.provider ?? "openai") as LlmProvider;
  const retrieve = deps.batch?.retrieveBatchV2 ?? defaultRetrieveBatchV2;
  const state = await retrieve({ provider, batchId: data.batchId });
  const persistedStatus = mapBatchV2StatusToPersisted(state.status);
  // Redact provider error to <= 1024 bytes BEFORE writing.
  const errorMessage = state.errorMessage ? redactErrorMessage(state.errorMessage) : null;
  const completedAt = state.endedAt ? new Date(state.endedAt) : null;

  if (state.status === "ended") {
    // Stay NON-terminal until the outcomes are durably applied. Writing
    // "completed" first would make a processBatchResults failure (download,
    // catalog read) permanent: the terminal-status guard above turns every
    // later poll into a no-op while the results were never written.
    await updateBatchRun(data.batchId, { lastPolledAt: new Date(), errorMessage });
    try {
      await processBatchResults(existing, jobStartedAt, deps);
    } catch (err) {
      // Keep the chain alive (the ended batch still holds undrained
      // outcomes), then rethrow so the job-level failure stays visible and
      // BullMQ's bounded per-poll attempts apply.
      await enqueueBackgroundJob(
        BACKGROUND_JOB_NAMES.SKILL_MATCH_BATCH_POLL,
        { batchId: data.batchId, jobStartedAt: data.jobStartedAt },
        {
          jobId: `skill-match-batch-poll-${data.batchId}-${Date.now()}`,
          delay: 30_000,
          attempts: SKILL_MATCH_POLL_JOB_ATTEMPTS,
          backoff: { type: "exponential", delay: SKILL_MATCH_JOB_BACKOFF_MS },
          inheritActorContext: false,
        },
      );
      throw err;
    }
    await updateBatchRun(data.batchId, { status: persistedStatus, completedAt });
    return;
  }

  if (state.status === "failed") {
    // Batch-level failure: per-request outcomes never existed, so the run is
    // honestly terminal now — and the manifest bulk is shed with it.
    await updateBatchRun(data.batchId, {
      status: persistedStatus,
      lastPolledAt: new Date(),
      completedAt,
      errorMessage,
      manifest: null,
    });
    return;
  }

  await updateBatchRun(data.batchId, {
    status: persistedStatus,
    lastPolledAt: new Date(),
    completedAt,
    errorMessage,
  });

  // Re-enqueue another poll in 30s — distinct jobId per poll.
  await enqueueBackgroundJob(
    BACKGROUND_JOB_NAMES.SKILL_MATCH_BATCH_POLL,
    { batchId: data.batchId, jobStartedAt: data.jobStartedAt },
    {
      jobId: `skill-match-batch-poll-${data.batchId}-${Date.now()}`,
      delay: 30_000,
      attempts: SKILL_MATCH_POLL_JOB_ATTEMPTS,
      backoff: { type: "exponential", delay: SKILL_MATCH_JOB_BACKOFF_MS },
      inheritActorContext: false,
    },
  );
}

// ---------------------------------------------------------------------------
// Synchronous fan-out chunk processing (batch-less providers)
// ---------------------------------------------------------------------------

async function processSyncRunChunk(
  run: SkillMatchBatchRun,
  jobStartedAt: Date,
  jobStartedAtIso: string,
  deps: SkillMatchJobDeps,
): Promise<void> {
  // Cancel semantics: an admin cancel sets status="cancelling"; the chunk
  // boundary is the cancellation point (the in-flight chunk also aborts pairs
  // via the signal seam when the worker is being drained).
  if (run.status === "cancelling") {
    await updateBatchRun(run.batchId, {
      status: "cancelled",
      completedAt: new Date(),
      manifest: null,
    });
    console.info(
      JSON.stringify({
        event: "skill_match_sync_run_cancelled",
        batchId: run.batchId,
        processedPairCount: run.processedPairCount,
        pairCount: run.pairCount,
      }),
    );
    return;
  }

  const runContext = coerceRunContext({
    provider: run.provider,
    model: run.model,
    evaluatorVersion: run.evaluatorVersion,
  });
  if (!run.manifest || !runContext) {
    await updateBatchRun(run.batchId, {
      status: "failed",
      completedAt: new Date(),
      errorMessage: redactErrorMessage(
        "Synchronous run is missing its submission manifest or run context.",
      ),
      manifest: null,
    });
    return;
  }

  const offset = run.processedPairCount;
  const window = run.manifest.slice(offset, offset + SKILL_MATCH_SYNC_RUN_CHUNK_SIZE);

  const agents = await deps.catalog.readAgents();
  const agentByPackageId = new Map(agents.map((a) => [a.packageId, a]));

  let skippedAbsent = 0;
  for (const entry of window) {
    const agent = agentByPackageId.get(entry.agentId);
    const skill = agent ? await deps.catalog.getSkillById(entry.skillId) : null;
    if (!agent || !skill) {
      // Entity deleted mid-run — the frozen SET keeps window math exact; the
      // absent pair is simply not evaluated (orphan GC owns any stale row).
      skippedAbsent += 1;
      continue;
    }
    // The synchronous path evaluates CURRENT content (the answer is computed
    // now, unlike a provider batch whose answer was computed against the
    // submit-time snapshot), so rows carry current hashes by construction.
    await evaluatePairCounted(
      "sync-run-chunk",
      { agent: adaptAgent(agent), skill: adaptSkill(skill) },
      {
        now: () => new Date(),
        jobStartedAt,
        runContext,
        actorContext: deps.actorContext,
      },
    );
  }

  const processed = Math.min(offset + window.length, run.manifest.length);
  const done = processed >= run.manifest.length;

  if (done) {
    await updateBatchRun(run.batchId, {
      status: "completed",
      completedAt: new Date(),
      lastPolledAt: new Date(),
      processedPairCount: processed,
      manifest: null,
    });
    console.info(
      JSON.stringify({
        event: "skill_match_sync_run_completed",
        batchId: run.batchId,
        pairCount: run.pairCount,
        skippedAbsentLastChunk: skippedAbsent,
      }),
    );
    return;
  }

  await updateBatchRun(run.batchId, {
    processedPairCount: processed,
    lastPolledAt: new Date(),
  });
  await enqueueBackgroundJob(
    BACKGROUND_JOB_NAMES.SKILL_MATCH_BATCH_POLL,
    { batchId: run.batchId, jobStartedAt: jobStartedAtIso },
    {
      jobId: `skill-match-batch-poll-${run.batchId}-off${processed}-${Date.now()}`,
      attempts: SKILL_MATCH_SYNC_CHUNK_JOB_ATTEMPTS,
      backoff: { type: "exponential", delay: SKILL_MATCH_JOB_BACKOFF_MS },
      inheritActorContext: false,
    },
  );
}

// ---------------------------------------------------------------------------
// Cancel (both paths)
// ---------------------------------------------------------------------------

export type CancelBatchRunResult =
  | { ok: true; status: string }
  | { ok: false; reason: "not_found" | "already_terminal" | "cancel_unsupported" };

/**
 * Cancel an in-flight run.
 *
 *  - Synchronous runs: mark `cancelling`; the next chunk boundary observes it
 *    and finalizes as `cancelled` (already-written rows are kept — they are
 *    real, current evaluations).
 *  - Provider batches: request cancellation through the frozen run context's
 *    provider. Providers without cancel support report `cancel_unsupported`.
 */
export async function cancelBatchRun(
  batchId: string,
  deps?: { batch?: BatchOrchestrationSeams },
): Promise<CancelBatchRunResult> {
  const run = await readBatchRun(batchId);
  if (!run) return { ok: false, reason: "not_found" };
  if (TERMINAL_STATUSES.has(run.status)) return { ok: false, reason: "already_terminal" };

  if (run.batchId.startsWith(SKILL_MATCH_SYNC_RUN_PREFIX)) {
    await updateBatchRun(batchId, { status: "cancelling" });
    return { ok: true, status: "cancelling" };
  }

  const provider = (run.provider ?? "openai") as LlmProvider;
  const cancel = deps?.batch?.cancelBatchV2 ?? defaultCancelBatchV2;
  let state;
  try {
    state = await cancel({ provider, batchId });
  } catch (err) {
    if (isBatchNotSupportedError(err)) {
      // A cancel-less batch surface — report honestly.
      console.warn(`[skill-match] cancel unsupported for ${provider}:`, err);
      return { ok: false, reason: "cancel_unsupported" };
    }
    // Network / provider / credential failures are NOT "unsupported" — rethrow
    // so the caller sees a retryable failure instead of a false capability
    // verdict.
    throw err;
  }

  if (state.status === "ended") {
    // The batch ended (possibly before the cancel took effect) and its
    // per-request outcomes — including canceled ones — are still undrained.
    // Persisting "completed" here would trip the poll's terminal guard and
    // strand the outcomes; keep the run pollable as "cancelling" and let the
    // live poll chain drain it (its ended branch applies outcomes, then
    // finalizes). lastPolledAt is deliberately NOT stamped — cancel is not a
    // poll, and stamping it would stale-guard-delay the drain.
    await updateBatchRun(batchId, { status: "cancelling" });
    return { ok: true, status: "cancelling" };
  }

  const persistedStatus = mapBatchV2StatusToPersisted(state.status);
  if (state.status === "failed") {
    // Batch-level failure: no outcomes will ever exist — terminal, manifest shed.
    await updateBatchRun(batchId, {
      status: persistedStatus,
      completedAt: state.endedAt ? new Date(state.endedAt) : new Date(),
      errorMessage: state.errorMessage ? redactErrorMessage(state.errorMessage) : null,
      manifest: null,
    });
    return { ok: true, status: persistedStatus };
  }

  await updateBatchRun(batchId, {
    status: persistedStatus,
    errorMessage: state.errorMessage ? redactErrorMessage(state.errorMessage) : null,
  });
  return { ok: true, status: persistedStatus };
}

// ---------------------------------------------------------------------------
// Poll-attempt exhaustion (dispatch-site hook)
// ---------------------------------------------------------------------------

/**
 * Called by the SKILL_MATCH_BATCH_POLL dispatch site when a poll job's FINAL
 * BullMQ attempt failed (the queue is about to drop it, so no retry and no
 * chain re-enqueue would ever run again).
 *
 *  - Synchronous runs: the chunk processor IS the run; with its attempts
 *    exhausted the run can never progress, so it transitions to a truthful
 *    terminal `failed` (redacted error, manifest shed). Without this the row
 *    stays `in_progress` forever and the status panel polls indefinitely.
 *  - Provider batches: the batch itself may be fine — only OUR polling
 *    failed. Marking it failed would be a lie; instead a fresh poll is
 *    enqueued so the chain survives the exhausted job (each fresh poll again
 *    carries bounded attempts).
 */
export async function handleBatchPollExhausted(
  data: { batchId: string; jobStartedAt: string },
  err: unknown,
): Promise<void> {
  const run = await readBatchRun(data.batchId);
  if (!run || TERMINAL_STATUSES.has(run.status)) return;

  if (run.batchId.startsWith(SKILL_MATCH_SYNC_RUN_PREFIX)) {
    const message = err instanceof Error ? err.message : String(err);
    await updateBatchRun(data.batchId, {
      status: "failed",
      completedAt: new Date(),
      errorMessage: redactErrorMessage(
        `Synchronous run chunk failed after all retry attempts: ${message}`,
      ),
      manifest: null,
    });
    console.warn(
      JSON.stringify({
        event: "skill_match_sync_run_failed_attempts_exhausted",
        batchId: data.batchId,
        processedPairCount: run.processedPairCount,
        pairCount: run.pairCount,
      }),
    );
    return;
  }

  await enqueueBackgroundJob(
    BACKGROUND_JOB_NAMES.SKILL_MATCH_BATCH_POLL,
    { batchId: data.batchId, jobStartedAt: data.jobStartedAt },
    {
      jobId: `skill-match-batch-poll-${data.batchId}-${Date.now()}`,
      delay: 30_000,
      attempts: SKILL_MATCH_POLL_JOB_ATTEMPTS,
      backoff: { type: "exponential", delay: SKILL_MATCH_JOB_BACKOFF_MS },
      inheritActorContext: false,
    },
  );
}

// ---------------------------------------------------------------------------
// Process ended batch — map outcomes through the submission manifest
// ---------------------------------------------------------------------------

async function processBatchResults(
  run: SkillMatchBatchRun,
  jobStartedAt: Date,
  deps: SkillMatchJobDeps,
): Promise<void> {
  const provider = (run.provider ?? "openai") as LlmProvider;
  const rowProvider = run.provider;
  const rowModel = run.model;

  if (!run.manifest) {
    // A run persisted without a manifest (pre-S6 in-flight at deploy time, or
    // a corrupted cell) cannot be mapped honestly — reconstruction from the
    // live catalog is exactly the integrity bug this pipeline removed.
    console.warn(
      `[skill-match] batch ${run.batchId} has no submission manifest; results are unmappable.`,
    );
    await updateBatchRun(run.batchId, {
      errorMessage: redactErrorMessage(
        "Batch ended but its submission manifest is missing; results were not applied. Re-run matching to refresh rows.",
      ),
    });
    return;
  }

  const manifestByCustomId = new Map(run.manifest.map((e) => [e.customId, e]));

  // Download BOTH result streams (v2 merges the success and error transports;
  // per-request canceled/expired arrive as outcomes, not as silence).
  const download = deps.batch?.downloadBatchOutcomesV2 ?? defaultDownloadBatchOutcomesV2;
  const outcomes: LlmBatchV2Outcome[] = await download({ provider, batchId: run.batchId });

  // Live-catalog snapshot for the CURRENT-hash revalidation. Results are
  // mapped through the manifest; the live catalog is consulted ONLY to decide
  // whether the submit-time inputs are still current.
  const agents = (await deps.catalog.readAgents()).map(adaptAgent);
  const skills = (await deps.catalog.listSkills())
    .filter((s) => s.level !== "agent" && s.level !== "system")
    .map(adaptSkill);
  const agentById = new Map(agents.map((a) => [a.packageId, a]));
  const skillById = new Map(skills.map((s) => [s.skillId, s]));

  const counts = {
    ok: 0,
    errored: 0,
    canceled: 0,
    expired: 0,
    discardedStale: 0,
    unknownCustomId: 0,
  };

  for (const outcome of outcomes) {
    const entry = manifestByCustomId.get(outcome.customId);
    if (!entry) {
      counts.unknownCustomId += 1;
      console.warn(`[skill-match] batch result missing manifest entry: ${outcome.customId}`);
      continue;
    }

    // Snapshot-currency gate: discard any result whose pair was edited or
    // deleted mid-batch. The answer was computed against the SUBMIT-TIME
    // inputs; writing it against changed inputs would mark a stale answer
    // current. The staleness sweep / install hooks re-evaluate such pairs
    // against live content.
    const agent = agentById.get(entry.agentId);
    const skill = skillById.get(entry.skillId);
    if (!agent || !skill) {
      counts.discardedStale += 1;
      continue;
    }
    const current = computeInputHashes(agent, skill);
    if (
      current.agentInputHash !== entry.agentInputHash ||
      current.skillInputHash !== entry.skillInputHash
    ) {
      counts.discardedStale += 1;
      continue;
    }

    const base = {
      agentId: entry.agentId,
      skillId: entry.skillId,
      source: "llm" as const,
      evaluatorVersion: run.evaluatorVersion,
      provider: rowProvider,
      model: rowModel,
      agentInputHash: entry.agentInputHash,
      skillInputHash: entry.skillInputHash,
    };

    let row: Omit<SkillMatchRow, "evaluatedAt" | "jobStartedAt">;
    if (outcome.status === "succeeded") {
      const parsed = parseLlmResponse(outcome.text ?? "");
      if (parsed.ok) {
        // Rationale grounding guard — SAME policy as the synchronous
        // evaluator (write parity across both paths). Only matched=true
        // rationales are checked; an ungrounded one is downgraded to the
        // conservative fallback while the decision is preserved.
        let finalRationale = parsed.value.rationale;
        if (parsed.value.matched) {
          const grounding = checkRationaleGrounding(parsed.value.rationale, agent, skill);
          if (!grounding.grounded) finalRationale = UNGROUNDED_RATIONALE_FALLBACK;
        }
        counts.ok += 1;
        row = {
          ...base,
          matched: parsed.value.matched,
          score: parsed.value.score,
          rationale: finalRationale,
          status: "ok",
          errorCode: null,
          errorMessage: null,
        };
      } else {
        counts.errored += 1;
        row = {
          ...base,
          matched: false,
          score: 0,
          rationale: null,
          status: "error",
          errorCode: parsed.errorCode,
          // parsed.rawRedacted is already <=1024 bytes; no double-wrap needed.
          errorMessage: parsed.rawRedacted,
        };
      }
    } else if (outcome.status === "errored") {
      counts.errored += 1;
      row = {
        ...base,
        matched: false,
        score: 0,
        rationale: null,
        status: "error",
        // Stable normalized vocabulary from the batch-v2 contract
        // ("rate_limit", "invalid_request", …); the provider's own words go
        // into error_message (redacted).
        errorCode: outcome.error.code,
        errorMessage: redactErrorMessage(outcome.error.message),
      };
    } else if (outcome.status === "canceled") {
      counts.canceled += 1;
      row = {
        ...base,
        matched: false,
        score: 0,
        rationale: null,
        status: "error",
        errorCode: "request_canceled",
        errorMessage: "Request canceled before completion.",
      };
    } else {
      counts.expired += 1;
      row = {
        ...base,
        matched: false,
        score: 0,
        rationale: null,
        status: "error",
        errorCode: "request_expired",
        errorMessage: "Request expired before completion.",
      };
    }
    await upsertMatchRow(row, { now: () => new Date(), jobStartedAt });
  }

  console.info(
    JSON.stringify({
      event: "skill_match_batch_results",
      batchId: run.batchId,
      provider: rowProvider,
      model: rowModel,
      ...counts,
    }),
  );

  // Shed the manifest bulk once the run is terminal and processed.
  await updateBatchRun(run.batchId, { manifest: null });
}
