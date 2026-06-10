import "server-only";

/**
 * `agent_creation_review` MCP primitive.
 *
 * Deterministic orchestration boundary that replaces the broken
 * `@cinatra/agent-creation-finalizer` Flow. Runs the 4 reviewer lanes
 * (lint-policy + 3 LLM advisors) in-process and aggregates via the shared
 * merge helper.
 *
 * Why this replaces a Flow:
 *  - The rejected topology used `AgentNode` wrappers around `A2AAgent`
 *    children for internal sub-agent composition. wayflowcore's
 *    `AgentExecutionStep` explicitly rejects typed outputs on
 *    AgentNode→A2AAgent, so findings could never propagate to the
 *    parent flow, so the finalizer could not mount cleanly.
 *  - For "call N things and aggregate" with no HITL surface, a deterministic
 *    MCP primitive is strictly simpler than a Flow: no ParallelFlowNode
 *    ordering risk, no Verdaccio publish churn, no BullMQ queueing tax.
 *  - The reviewer lanes themselves remain independently runnable as the
 *    standalone agents `@cinatra-ai/lint-policy-agent`,
 *    `@cinatra-ai/security-reviewer-agent`, `@cinatra-ai/code-reviewer-agent`,
 *    `@cinatra-ai/planner-agent` — this primitive just orchestrates them.
 *
 * Trust boundaries preserved:
 *  - `OAS-RUNTIME-008` blocker still enforces "no A2A
 *    for internal composition" against any future agent.
 *  - `normalizeReviewFindings` still downgrades non-policy "blocker" claims
 *    from LLM lanes to "warning" — the lint-policy lane is the sole
 *    authoritative source of blockers (BLOCKER_AUTHORIZED_SOURCES).
 *  - Lane `source` identity is stamped by this primitive as it dispatches
 *    each lane — the LLMs can't spoof identity because the primitive
 *    overwrites the source field on every finding before merging.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  scanOasForLiteralSecrets,
  scanOasForUntrustedUrls,
  scanOasForLlmBridgeWiring,
  scanOasForLlmMetadata,
  scanOasForStartNodeInputsWithoutRequired,
  scanOasForPackageVersionSync,
  scanAgentForRequiredLicense,
} from "./validate-agent-json";
import { scanOasForRuntimeInvariantFindings } from "./validate-oas-runtime-invariants";
import { resolveAgentInstallDir } from "./agent-install-path";
import {
  mergeReviewLanes,
  restampLaneSource,
  type MergedReviewReport,
} from "./review-merge";
import type { ReviewFinding } from "./validate-agent-json";
// Static import for vitest interception (vi.mock intercepts hoisted static
// imports; the dynamic-import shape didn't always
// receive the mock when the mock was registered after agent-creation-review.ts
// already evaluated).
import {
  runDeterministicLlmTask,
  runSkillAwareDeterministicLlmTask,
} from "@cinatra-ai/llm";
// Native MCP path doesn't establish an actor frame for the LLM
// orchestration ALS. Without this, `runDeterministicLlmTask` throws
// `ACTOR_CONTEXT_MISSING`. We derive an ActorContext from `request.actor`
// using the same builder the other primitive handlers use.
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import { buildActorContextFromPrimitive } from "./auth-policy";
// Config-driven dispatch resolver + sentinel for "anthropic + empty skills"
// dispatch-abort. Replaces the hardcoded `provider:"openai", model:"gpt-5"`
// block.
import {
  resolveAgentCreationDispatch,
  AgentCreationDispatchAbortError,
  AgentCreationPinConfigError,
} from "./resolve-agent-creation-dispatch";
// Hard pre-enqueue preflight + strict catalog resolver.
import { preflightAgentCreation } from "./preflight-agent-creation";
import { resolveRequiredCreationSkillIds } from "./resolve-required-creation-skill-ids";
// Strict typed-artifact extractor sentinel (re-thrown
// from author-agent dispatch so the deterministic merge layer surfaces a
// blocker rather than a downgraded warning).
import { AuthorDraftExtractionError } from "./author-draft";
// Anthropic skill-delivery base error class.
// `dispatchLlmReviewer`'s catch rethrows any subclass (NotSynced, Cap,
// FunctionTool, Preflight) so config/sync errors become deterministic
// blockers, not downgraded warnings.
import { AnthropicSkillDeliveryError } from "@cinatra-ai/llm";
// Append-only creation-progress emit. Imported
// dynamically inside the helper so this primitive is still safely callable
// from environments that don't have a live notifications DB (e.g. vitest
// without the postgres-sync mock).
type AgentCreationProgressMilestone =
  | "queued"
  | "syncing_skills"
  | "planner_running"
  | "code_review_running"
  | "security_review_running"
  | "validating"
  | "writing_files"
  | "review_started"
  | "review_done";

async function emitMilestoneIfThreaded(
  progressContext: { runId: string } | undefined,
  actor: PrimitiveActorContext | undefined,
  packageName: string,
  milestone: AgentCreationProgressMilestone,
): Promise<void> {
  if (!progressContext?.runId) return;
  // Recipient is ALWAYS server-derived from the actor. Non-human / no-id
  // actors silently no-op (fanout-escalation guard).
  const userId = actor?.userId;
  if (!actor || actor.actorType !== "human" || !userId) return;
  try {
    const { safeEmitAgentCreationProgress } = await import(
      "@cinatra-ai/notifications/server"
    );
    await safeEmitAgentCreationProgress({
      recipient: { kind: "user", userId },
      runId: progressContext.runId,
      packageName,
      milestone,
    });
  } catch (err) {
    // safeEmit* already swallows; this catches the dynamic-import failure
    // (e.g. missing module in a vitest worker without the mock).
    console.warn(
      "[agent-creation-review] milestone emit dynamic-import failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

// The 3 reviewer agent packages whose per-agent methodology skills are
// required catalog entries for dispatch. The author-agent is NOT dispatched
// from this primitive; it's the typed-artifact emitter for the chat-side flow.
//
// EXPORTED as the canonical reviewer-lane definition: the write preflight
// (mcp/handlers.ts) and the chat-dispatch creation-flow set
// (creation-flow-packages.ts) derive from THIS constant instead of carrying
// their own copies of the package names.
export const REVIEWER_LANE_PACKAGES = [
  "@cinatra-ai/security-reviewer-agent",
  "@cinatra-ai/code-reviewer-agent",
  "@cinatra-ai/planner-agent",
];

export const AGENT_CREATION_REVIEW_PRIMITIVE_NAME = "agent_creation_review";

export type AgentCreationReviewInput = {
  /** Raw JSON-string OAS Flow body (matches what agent-creation-finalizer accepted). */
  oasJson?: string;
  /** Optional sibling package.json string (matches the prior finalizer signature). */
  packageJson?: string;
  /** Optional slug for context labelling (no FS access — purely informational). */
  packageSlug?: string;
  /** Optional reviewer context (free-form JSON-string from chat). */
  reviewContext?: string;
  /**
   * Append-only creation-progress emit context.
   *
   * Optional. When set together with a HumanUser actor on the primitive
   * request, the handler emits milestone notifications (`syncing_skills`,
   * `validating`, `review_started`, `*_running`, `review_done`) tagged
   * with this runId for the chat-side timeline.
   *
   * IMPORTANT: only `runId` is caller-supplied. The recipient is ALWAYS
   * server-derived from `request.actor.principalId` — callers MUST NOT
   * be able to fan notifications out to admins, teams, orgs, projects,
   * or other users via the MCP transport.
   *
   * Unset → all milestone emits are no-ops, preserving byte-for-byte
   * behaviour for every existing primitive caller.
   */
  progressContext?: { runId: string };
};

export type AgentCreationReviewResult = MergedReviewReport & {
  /** True when blockers.length === 0 — convenience flag for callers. */
  ok: boolean;
  /** Names of the LLM advisory lanes that actually ran (after the trivial-OAS
   *  + short-circuit guards). Mirror of the prior `handleAgentSourceReview`
   *  shape so chat consumers don't need to branch. */
  ranAdvisoryAgents: string[];
};

// ---------------------------------------------------------------------------
// Deterministic lint lane — direct scanner calls (no HTTP self-call).
// ---------------------------------------------------------------------------

/**
 * Run every deterministic scanner relevant for the publish gate. Mirrors
 * `runDeterministicReview` (handlers.ts) but ADDS:
 *   - the runtime-invariants scanner family (OAS-RUNTIME-001 …
 *     OAS-RUNTIME-008) — those weren't in `runDeterministicReview`
 *     historically and the agent-creation-finalizer's lint lane (via
 *     `/api/oas-lint/scan-all`) called them separately.
 *   - package-adjacent scanners (`scanOasForPackageVersionSync` +
 *     `scanAgentForRequiredLicense`) — only when `parsedPackageJson` is
 *     provided. Mirrors the package-aware path of `/api/oas-lint/scan-all`
 *     (route.ts:143). Without this, `agent_creation_review` would return
 *     ok=true on version drift or missing-required-license that the
 *     finalizer + scan-all pipeline would surface as blockers.
 *
 * Source stamping happens via `restampLaneSource` at the call site — every
 * finding here is authored as `source: "agent-lint-policy"` (or
 * `source: "deterministic"` from the runtime invariants — both forms are
 * trusted blocker sources per `BLOCKER_AUTHORIZED_SOURCES`).
 */
function runDeterministicLintLane(
  parsedOas: Record<string, unknown>,
  parsedPackageJson: Record<string, unknown> | null,
): ReviewFinding[] {
  const findings: ReviewFinding[] = [
    ...scanOasForLiteralSecrets(parsedOas),
    ...scanOasForUntrustedUrls(parsedOas),
    ...scanOasForLlmBridgeWiring(parsedOas),
    ...scanOasForLlmMetadata(parsedOas),
    ...scanOasForStartNodeInputsWithoutRequired(parsedOas),
    ...scanOasForRuntimeInvariantFindings(parsedOas),
  ];
  if (parsedPackageJson) {
    findings.push(...scanOasForPackageVersionSync(parsedOas, parsedPackageJson));
    findings.push(...scanAgentForRequiredLicense(parsedPackageJson));
  }
  return findings;
}

// ---------------------------------------------------------------------------
// LLM reviewer prompts — loaded from each reviewer agent's OAS at call time.
// ---------------------------------------------------------------------------

/**
 * Strict rule: "do not hardcode large static reviewer prompts into
 * TypeScript. Load/reuse the existing reviewer instructions from SKILL.md
 * or a shared prompt source." Implementation: read each reviewer agent's
 * `cinatra/oas.json`, locate the `review` (or `scan_all`) ApiNode component,
 * extract its `data.system` + `data.user` template.
 *
 * Falls back to a minimal inline prompt if the reviewer agent's OAS isn't
 * installed locally (e.g. a fresh dev environment). The fallback is
 * intentionally brief — the live OAS is the source of truth and any
 * meaningful prompt refinement must happen there.
 */
type ReviewerPromptTemplate = {
  system: string;
  /** Jinja-style user template — placeholders `{{ packageSlug }}`,
   *  `{{ reviewContext }}`, `{{ oasJson }}` are substituted at dispatch. */
  user: string;
  /** Methodology skill ids resolved at dispatch via
   *  the catalog (`skills_installed_resolve_for_agent`) — NEVER read from
   *  `oas.json` (the OAS stays skill-free per spec §2.3, enforced by
   *  `oas-skill-free.test.ts`). Empty array is a valid backwards-compat
   *  fallback when the catalog has no rows yet (dev-fresh-DB case): the lane
   *  then runs on the now-thin OAS `system` alone (no inline methodology
   *  fallback). */
  skillIds: string[];
};

/**
 * Map lane label → owning agent package name so
 * the catalog (`skills_installed_resolve_for_agent`) can locate the per-agent
 * methodology skills co-located inside each agent's extension package
 * under the thin-OAS package layout.
 */
const REVIEWER_LANE_TO_PACKAGE: Record<string, string> = {
  "agent-security-reviewer": "@cinatra-ai/security-reviewer-agent",
  "agent-code-reviewer": "@cinatra-ai/code-reviewer-agent",
  "agent-planner": "@cinatra-ai/planner-agent",
};

async function loadReviewerPrompt(
  slug: "agent-security-reviewer" | "agent-code-reviewer" | "agent-planner",
  fallbackSystem: string,
  actorContext: ReturnType<typeof buildActorContextFromPrimitive>,
  /** Pre-resolved per-lane skill ids from the strict
   *  catalog resolver run at the top of `handleAgentCreationReview`. When
   *  provided, the per-lane catalog `await import("@cinatra-ai/skills")`
   *  inside this helper is skipped (avoids per-lane re-resolution which can
   *  serialize concurrent dispatches on vitest's slow module loader).
   *  Undefined ⇒ legacy per-lane resolution (kept for tests that don't go
   *  through `handleAgentCreationReview`). */
  preResolvedSkillIds?: string[],
): Promise<ReviewerPromptTemplate> {
  // Resolve methodology skill ids via the CATALOG
  // (`skills_installed_resolve_for_agent`) — NEVER from `oas.json`. The OAS
  // is now skill-free per spec §2.3 (enforced by `oas-skill-free.test.ts`).
  // BACKWARDS-COMPAT: an empty array is a valid fallback (catalog unavailable
  // / dev-fresh DB) — the lane runs on the thin OAS `system` alone, NO inline
  // methodology fallback.
  let skillIds: string[] = preResolvedSkillIds ?? [];
  // When called from `handleAgentCreationReview`, the strict
  // catalog resolver already ran ONCE before the fanout — reuse its result
  // to avoid per-lane `await import("@cinatra-ai/skills")` (which serializes
  // concurrent dispatches on vitest's slow module loader and breaks the
  // "dispatches in PARALLEL" timing assertion). When called from a direct
  // test (or backwards-compat caller) without preResolvedSkillIds, fall back
  // to per-lane catalog resolution.
  if (preResolvedSkillIds === undefined) {
  try {
    const { createDeterministicSkillsClient } = await import(
      "@cinatra-ai/skills"
    );
    // Catalog resolution is workspace-scoped, not user-scoped — use a minimal system actor
    // exactly as `src/app/api/chat/runner.ts:259` does for `installed.get`.
    // The agent-side `actorContext` (RelocatedActorContext) is reserved for
    // the LLM orchestration ALS frame below.
    const skillsClient = createDeterministicSkillsClient({
      actor: { actorType: "system", source: "worker" },
    });
    const agentPackage = REVIEWER_LANE_TO_PACKAGE[slug];
    if (agentPackage) {
      const resolved = await skillsClient.installed.resolveForAgent({
        agentId: agentPackage,
      });
      if (resolved && Array.isArray(resolved.skillIds)) {
        skillIds = resolved.skillIds;
      }
    }
  } catch {
    skillIds = [];
  }
  } // end if preResolvedSkillIds === undefined
  const installRoot = resolveAgentInstallDir();
  // Lane labels are stable security-semantic identities (wired into
  // normalizeReviewFindings + spoof-downgrade + tests). The on-disk
  // package dirs were renamed kind-at-end; map label -> dir slug.
  const REVIEWER_PROMPT_DIR: Record<string, string> = {
    "agent-security-reviewer": "security-reviewer-agent",
    "agent-code-reviewer": "code-reviewer-agent",
    "agent-planner": "planner-agent",
  };
  const dirSlug = REVIEWER_PROMPT_DIR[slug] ?? slug;
  const oasPath = join(installRoot, "cinatra-ai", dirSlug, "cinatra", "oas.json");
  if (!existsSync(oasPath)) {
    return {
      system: fallbackSystem,
      user:
        "packageSlug: {{ packageSlug }}\n\nreviewContext: {{ reviewContext }}\n\noasJson:\n{{ oasJson }}",
      skillIds,
    };
  }
  try {
    const raw = await readFile(oasPath, "utf8");
    const oas = JSON.parse(raw) as Record<string, unknown>;
    const refs = oas.$referenced_components;
    if (!refs || typeof refs !== "object") {
      return { system: fallbackSystem, user: defaultUserTemplate(), skillIds };
    }
    // Reviewer agents use a `review` ApiNode (sec/code/planner). The
    // lint-policy agent uses `scan_all` instead and we don't dispatch it via
    // this loader — it's covered by the deterministic lint lane above.
    const reviewNode = (refs as Record<string, unknown>).review as
      | Record<string, unknown>
      | undefined;
    if (!reviewNode || reviewNode.component_type !== "ApiNode") {
      return { system: fallbackSystem, user: defaultUserTemplate(), skillIds };
    }
    const data = reviewNode.data as Record<string, unknown> | undefined;
    const system = typeof data?.system === "string" ? data.system : fallbackSystem;
    const user = typeof data?.user === "string" ? data.user : defaultUserTemplate();
    return { system, user, skillIds };
  } catch {
    return { system: fallbackSystem, user: defaultUserTemplate(), skillIds };
  }
}

function defaultUserTemplate(): string {
  return "packageSlug: {{ packageSlug }}\n\nreviewContext: {{ reviewContext }}\n\noasJson:\n{{ oasJson }}";
}

/**
 * Substitute the 3 documented placeholders in a reviewer's user template.
 * Intentionally narrow — does NOT support arbitrary `{{ key }}` lookups
 * (that's what the WayFlow ApiNode runtime does; for in-process we keep
 * the template scope deterministic).
 */
function substituteUserTemplate(
  template: string,
  vars: { packageSlug: string; reviewContext: string; oasJson: string },
): string {
  return template
    .replace(/\{\{\s*packageSlug\s*\}\}/g, vars.packageSlug)
    .replace(/\{\{\s*reviewContext\s*\}\}/g, vars.reviewContext)
    .replace(/\{\{\s*oasJson\s*\}\}/g, vars.oasJson);
}

// ---------------------------------------------------------------------------
// LLM reviewer dispatch
// ---------------------------------------------------------------------------

const FALLBACK_SECURITY_PROMPT =
  "You are a security-review agent for Cinatra OAS Flow 26.1.0 agents. Surface fuzzy security risks the deterministic lint cannot see. Output a JSON array of ReviewFinding objects with severity 'warning' or 'suggestion'. Return ONLY a JSON array.";
const FALLBACK_CODE_PROMPT =
  "You are a code-quality review agent for Cinatra OAS Flow 26.1.0 agents. Output a JSON array of ReviewFinding objects with severity 'suggestion' or 'warning'. Return ONLY a JSON array.";
const FALLBACK_PLANNER_PROMPT =
  "You are a design-review agent for Cinatra OAS Flow 26.1.0 agents. Output a JSON array of ReviewFinding objects with severity 'suggestion'. Return ONLY a JSON array.";

/**
 * Wrapper around `runDeterministicLlmTask` from `@cinatra-ai/llm`.
 * The orchestration entry point applies the actor frame + MCP-injection
 * rules; the primitive only needs to pass `actorContext` so the ALS frame
 * is established when called from the native MCP path (chat function-tool
 * path has its own outer frame).
 *
 * Returns the LLM's text body in a `content` field — the orchestration's
 * native `LlmResponse.text` may be null when the model returned no text
 * (e.g. tool-call-only turn); we coerce that to empty string so the
 * reviewer-response parser's "no JSON array" path triggers cleanly.
 *
 * Without `actorContext`, native MCP calls hit
 * `ACTOR_CONTEXT_MISSING` and every advisory lane becomes a
 * `review_dispatch_failed` warning.
 */
// ---------------------------------------------------------------------------
// Async creation-run contract + Opus 4.7 pin.
//
// Provider/model selection is resolved via `resolveAgentCreationDispatch` (see
// `resolve-agent-creation-dispatch.ts`):
//
//   - When `isAgentCreationPinActive()` returns false, the resolver returns
//     byte-for-byte openai/gpt-5 — backwards compat preserved, the existing
//     tests stay green.
//   - When ACTIVE, the resolver returns the admin-configured provider/model
//     (`agent_creation_llm_provider` + `agent_creation_model`). For Anthropic
//     the dispatch is ALWAYS routed via `runSkillAwareDeterministicLlmTask`
//     so methodology arrives through the SkillDeliveryAdapter seam
//     (native MCP connector + `container.skills`, NEVER function tools).
//
// Belt-and-suspenders: the Anthropic provider's function-tool fallback at
// `packages/llm/src/providers/anthropic.ts:466` fires when
// `container.skills` is empty AND native MCP failed. Even though the
// preflight refuses to enqueue when required skills are unsynced, this
// dispatch site ALSO throws `AgentCreationDispatchAbortError` when
// dispatch.provider === "anthropic" AND skillIds is empty — closing any race
// window between preflight and dispatch.
// ---------------------------------------------------------------------------
async function runLlmTask(input: {
  system: string;
  user: string;
  logLabel: string;
  actorContext: ReturnType<typeof buildActorContextFromPrimitive>;
  /** Per-agent methodology skills resolved from the
   *  catalog by `loadReviewerPrompt`. Empty ⇒ classic dispatch on the thin
   *  OAS `system` alone (BACKWARDS-COMPAT for dev-fresh DB). */
  skillIds: string[];
}): Promise<{ content: string }> {
  // Resolve provider/model + skill-aware routing via the config-driven
  // dispatch resolver. Pin plumbing is INERT until
  // `isAgentCreationPinActive()` returns true (gated on governance
  const dispatch = await resolveAgentCreationDispatch({
    hasSkillIds: input.skillIds.length > 0,
  });

  // Belt-and-suspenders dispatch-site guard: Anthropic + empty skill ids
  // must never reach the orchestration entry (would trip the function-tool
  // fallback at `anthropic.ts:466` when container.skills is empty AND
  // native MCP fails). The preflight is the first gate; this throws
  // an `AgentCreationDispatchAbortError` that `handleAgentCreationReview`
  // converts to a deterministic blocker.
  if (dispatch.provider === "anthropic" && input.skillIds.length === 0) {
    throw new AgentCreationDispatchAbortError(
      "anthropic_empty_skill_ids",
      `Cannot dispatch agent-creation lane to Anthropic with zero skills (function-tool fallback risk at anthropic.ts:466). logLabel="${input.logLabel}".`,
    );
  }

  const common = {
    provider: dispatch.provider,
    model: dispatch.model,
    system: input.system,
    user: input.user,
    reasoningEffort: "medium" as const,
    logLabel: input.logLabel,
    actorContext: input.actorContext,
  };
  const response = dispatch.useSkillAware
    ? await runSkillAwareDeterministicLlmTask({
        ...common,
        skillIds: input.skillIds,
        // Creation path guard: the creation path is a FIXED pre-synced
        // per-agent allowlist (2-3 skills). Pin "creation" explicitly so an
        // over-cap is a HARD AnthropicSkillCapError — a fixed allowlist must
        // NEVER be silently rank-and-truncated. Belt-and-suspenders: unset
        // already means hard-cap, but stating intent here means a future
        // default flip cannot silently truncate this allowlist.
        skillSelectionMode: "creation",
      })
    : await runDeterministicLlmTask(common);
  return { content: response.text ?? "" };
}

/**
 * Parse a reviewer LLM response into ReviewFinding[]. The system prompts all
 * say "Return ONLY a JSON array" but real LLMs sometimes wrap output in
 * code fences or prose. Extract the first top-level JSON array; if parsing
 * fails or the result isn't an array, return a single synthetic
 * `warning` finding so the merge still produces a usable surface.
 */
function parseReviewerResponse(
  raw: string,
  laneSource: "agent-security-reviewer" | "agent-code-reviewer" | "agent-planner",
): ReviewFinding[] {
  const trimmed = (raw ?? "").trim();
  // First, strip fenced code blocks. Greedy match on ``` ... ```.
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenceMatch ? fenceMatch[1].trim() : trimmed;
  // Then extract the first `[...]` block in case there's surrounding prose.
  const arrayMatch = candidate.match(/\[[\s\S]*\]/);
  if (!arrayMatch) {
    return [
      {
        code: "review_parse_no_array",
        severity: "warning",
        message: `Reviewer "${laneSource}" returned no JSON array; treating as empty.`,
        source: laneSource,
      },
    ];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(arrayMatch[0]);
  } catch {
    return [
      {
        code: "review_parse_error",
        severity: "warning",
        message: `Reviewer "${laneSource}" returned unparseable JSON; treating as empty.`,
        source: laneSource,
      },
    ];
  }
  if (!Array.isArray(parsed)) {
    return [
      {
        code: "review_parse_error",
        severity: "warning",
        message: `Reviewer "${laneSource}" returned non-array payload; treating as empty.`,
        source: laneSource,
      },
    ];
  }
  return (parsed as Array<Record<string, unknown>>).map((f) => ({
    code: typeof f.code === "string" ? f.code : "unknown",
    severity:
      f.severity === "blocker" || f.severity === "warning" || f.severity === "suggestion"
        ? f.severity
        : ("suggestion" as const),
    message: typeof f.message === "string" ? f.message : "",
    ...(typeof f.location === "string" ? { location: f.location } : {}),
    // Re-stamp lane source — helper agents can't spoof identity (the LLM
    // is downstream of this primitive's authority).
    source: laneSource,
  }));
}

async function dispatchLlmReviewer(
  slug: "agent-security-reviewer" | "agent-code-reviewer" | "agent-planner",
  fallbackSystem: string,
  vars: { packageSlug: string; reviewContext: string; oasJson: string },
  actorContext: ReturnType<typeof buildActorContextFromPrimitive>,
  /** Per-lane skill ids pre-resolved by `handleAgentCreationReview`'s
   *  strict catalog resolver. Passed through to `loadReviewerPrompt` so the
   *  per-lane `await import("@cinatra-ai/skills")` is skipped (preserves
   *  parallel dispatch timing). */
  preResolvedSkillIds?: string[],
): Promise<ReviewFinding[]> {
  const prompt = await loadReviewerPrompt(slug, fallbackSystem, actorContext, preResolvedSkillIds);
  const userPrompt = substituteUserTemplate(prompt.user, vars);
  try {
    const result = await runLlmTask({
      system: prompt.system,
      user: userPrompt,
      logLabel: `agent_creation_review:${slug}`,
      actorContext,
      // Methodology delivered via catalog-resolved
      // skills, NOT inline OAS prose.
      skillIds: prompt.skillIds,
    });
    return parseReviewerResponse(result.content, slug);
  } catch (err) {
    // Rethrow config/sync/typed-artifact
    // sentinels so `handleAgentCreationReview`'s top-level try/catch converts
    // them to deterministic blockers. Without this rethrow, a pin-config
    // error / sync error / function-tool-fallback error would silently
    // become a `review_dispatch_failed` WARNING — masking the real issue.
    // The `AnthropicSkillDeliveryError` base-class instanceof check covers
    // every current + future Anthropic skill-delivery subclass (NotSynced,
    // Cap, FunctionTool, Preflight).
    if (
      err instanceof AgentCreationDispatchAbortError ||
      err instanceof AgentCreationPinConfigError ||
      err instanceof AnthropicSkillDeliveryError ||
      err instanceof AuthorDraftExtractionError
    ) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    return [
      {
        code: "review_dispatch_failed",
        severity: "warning",
        message: `Reviewer "${slug}" dispatch failed: ${message}. Other lanes proceeded; the publish gate still runs the deterministic lint independently.`,
        source: slug,
      },
    ];
  }
}

// ---------------------------------------------------------------------------
// Trivial-OAS short-circuit. Skip the planner advisory dispatch for a trivial
// OAS — same gate as `handleAgentSourceReview` so chat behavior stays
// consistent. Logic is COPIED EXACTLY from `handlers.ts:isTrivialOas`:
// external MCPToolBox is
// non-trivial; AgentNode only counts as executable when it has an `agent`
// field (i.e. backed by an embedded Agent, not just an A2A wrapper which
// is rejected above as non-trivial anyway).
//
// Trivial iff ALL of:
//   - zero InputMessageNode entries (no HITL)
//   - zero FlowNode entries (no subflow)
//   - zero A2AAgent entries (no peer agent invocation)
//   - zero non-cinatra MCPToolBox entries (no external MCP)
//   - at most ONE executable step (AgentNode-with-agent OR ApiNode).
//     OutputMessageNode does NOT count toward this quota — structural.
// ---------------------------------------------------------------------------

function isTrivialOas(parsedOas: Record<string, unknown>): boolean {
  const refs = parsedOas["$referenced_components"];
  if (!refs || typeof refs !== "object") return true;
  let executableSteps = 0;
  for (const value of Object.values(refs as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    const type = entry["component_type"];
    if (typeof type !== "string") continue;
    if (type === "InputMessageNode") return false;
    if (type === "FlowNode") return false;
    if (type === "A2AAgent") return false;
    if (type === "MCPToolBox") {
      // External iff neither id nor name starts with "cinatra-". The internal
      // cinatra-mcp toolbox is the only one that is always-trivial.
      const id = typeof entry["id"] === "string" ? (entry["id"] as string) : "";
      const name =
        typeof entry["name"] === "string" ? (entry["name"] as string) : "";
      const isCinatraInternal =
        id.startsWith("cinatra-") || name.startsWith("cinatra-");
      if (!isCinatraInternal) return false;
    }
    if (type === "AgentNode") {
      // AgentNode is only executable when it has an embedded Agent —
      // count any AgentNode that carries an `agent` field.
      if (entry["agent"]) executableSteps += 1;
    }
    if (type === "ApiNode") {
      executableSteps += 1;
    }
  }
  return executableSteps <= 1;
}

// ---------------------------------------------------------------------------
// Public handler — used by the MCP registry loop.
// ---------------------------------------------------------------------------

export async function handleAgentCreationReview(
  request: { input: AgentCreationReviewInput; actor?: PrimitiveActorContext },
): Promise<AgentCreationReviewResult> {
  const { oasJson, packageJson, packageSlug, reviewContext, progressContext } =
    request.input ?? {};
  const progressPackageName = packageSlug ?? "agent_creation_review";

  // ---- Validate inputs. ---------------------------------------------------
  if (!oasJson || typeof oasJson !== "string") {
    return errorResult(
      "missing_input",
      "agent_creation_review: oasJson is required (raw JSON string of the OAS Flow being reviewed).",
    );
  }

  let parsedOas: Record<string, unknown>;
  try {
    parsedOas = JSON.parse(oasJson) as Record<string, unknown>;
  } catch (err) {
    const message = err instanceof Error ? err.message : "invalid JSON";
    return errorResult("invalid_json", `agent_creation_review: oasJson is not valid JSON: ${message}.`);
  }

  // Parse the optional packageJson — when present, package-adjacent scanners
  // (version drift, required-license) run as part of the lint lane. If the
  // caller passes malformed packageJson we surface it as a blocker rather
  // than silently skipping the scanners.
  let parsedPackageJson: Record<string, unknown> | null = null;
  if (typeof packageJson === "string" && packageJson.trim().length > 0) {
    try {
      parsedPackageJson = JSON.parse(packageJson) as Record<string, unknown>;
    } catch (err) {
      const message = err instanceof Error ? err.message : "invalid JSON";
      return errorResult(
        "invalid_package_json",
        `agent_creation_review: packageJson is not valid JSON: ${message}.`,
      );
    }
  }

  // ---- Hard pre-enqueue preflight. ---------------------------------------
  // Runs AFTER JSON validation but BEFORE the deterministic lint pass so a
  // preflight failure aggregates into the same blocker stream as a lint
  // blocker (both surface as `errorResult`-style `MergedReviewReport` with
  // severity:"blocker", source:"deterministic"). When `isAgentCreationPinActive()`
  // returns false, this is a no-op pass-through
  // and dispatch continues on openai/gpt-5 — the existing 26 tests stay green.
  //
  // Only run the STRICT resolver (which RETHROWS
  // catalog errors) when the pin is ACTIVE — that's where `catalog_unavailable`
  // IS a real config error. When pin is INACTIVE, run a TOLERANT pre-
  // resolution (catch + fall back to per-lane `[]`) so:
  //   - per-lane `loadReviewerPrompt` calls skip their own dynamic catalog
  //     import (preserves the "dispatches in PARALLEL" timing assertion); AND
  //   - catalog errors silently swallow in the tolerant mode (the existing
  //     tests stay green).
  const { isAgentCreationPinActive: pinActiveCheck } = await import("@/lib/database");
  const pinActive = pinActiveCheck();
  let laneSkillSets: Awaited<ReturnType<typeof resolveRequiredCreationSkillIds>>;
  if (pinActive) {
    try {
      laneSkillSets = await resolveRequiredCreationSkillIds(REVIEWER_LANE_PACKAGES);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResult(
        "catalog_unavailable",
        `agent_creation_review preflight could not resolve required catalog skills: ${message}.`,
      );
    }
    const requiredCatalogSkillIds = Array.from(
      new Set(laneSkillSets.flatMap((l) => l.skillIds)),
    );
    const preflight = await preflightAgentCreation({
      requiredCatalogSkillIds,
      laneSkillSets,
    });
    if (!preflight.ok) {
      // Compose a single deterministic-blocker MergedReviewReport per failure
      // so the merge layer surfaces every config error in one envelope.
      const findings: ReviewFinding[] = preflight.errors.map((e) => ({
        code: e.code,
        severity: "blocker" as const,
        message: e.message,
        source: "deterministic" as const,
      }));
      const merged = mergeReviewLanes({
        lintFindings: findings,
        securityFindings: [],
        codeFindings: [],
        plannerFindings: [],
      });
      return { ok: false, ...merged, ranAdvisoryAgents: [] };
    }
    // Preflight passed under an ACTIVE Anthropic pin —
    // emit syncing_skills milestone for the chat-side timeline.
    await emitMilestoneIfThreaded(progressContext, request.actor, progressPackageName, "syncing_skills");
  } else {
    // Pin INACTIVE — tolerant pre-resolution: catch any catalog error and
    // fall back to empty skillIds per lane (preserves tolerant
    // behaviour AND keeps `loadReviewerPrompt` from doing per-lane
    // resolution that would serialize the parallel dispatch).
    try {
      laneSkillSets = await resolveRequiredCreationSkillIds(REVIEWER_LANE_PACKAGES);
    } catch {
      laneSkillSets = REVIEWER_LANE_PACKAGES.map((agentPackageName) => ({
        agentPackageName,
        skillIds: [],
      }));
    }
  }

  // ---- Lane 1 — deterministic lint (direct scanner calls). ----------------
  // Validating milestone (always emitted when progressContext threaded).
  await emitMilestoneIfThreaded(progressContext, request.actor, progressPackageName, "validating");
  const lintFindings = restampLaneSource(
    runDeterministicLintLane(parsedOas, parsedPackageJson),
    "agent-lint-policy",
  );

  // Early-exit on lint blockers (matches handleAgentSourceReview behavior —
  // no point running LLM advisors when the OAS is structurally unfit).
  const lintBlockerCount = lintFindings.filter((f) => f.severity === "blocker").length;
  if (lintBlockerCount > 0) {
    const merged = mergeReviewLanes({
      lintFindings,
      securityFindings: [],
      codeFindings: [],
      plannerFindings: [],
    });
    return { ok: false, ...merged, ranAdvisoryAgents: [] };
  }

  // ---- Derive actor context for the LLM orchestration ALS frame. ---------
  // The native MCP path doesn't establish a frame; without this every LLM
  // dispatch hits `ACTOR_CONTEXT_MISSING`. The chat function-
  // tool path has its own outer frame already; passing actorContext there is
  // harmless (orchestration's `requireActorFrame` accepts either route).
  const llmActorContext = buildActorContextFromPrimitive(
    request.actor ?? { actorType: "model", source: "agent" } as PrimitiveActorContext,
  );

  // ---- Lanes 2-4 — LLM advisors in parallel. ------------------------------
  const slugForVars = packageSlug ?? "(unknown)";
  const contextForVars = reviewContext ?? "{}";
  const vars = { packageSlug: slugForVars, reviewContext: contextForVars, oasJson };

  const ranAdvisoryAgents: string[] = [
    "agent-security-reviewer",
    "agent-code-reviewer",
  ];
  const planneIsApplicable = !isTrivialOas(parsedOas);
  if (planneIsApplicable) ranAdvisoryAgents.push("agent-planner");

  // Pre-warm the dispatch resolver's dynamic-import cache BEFORE
  // the parallel fanout. Without this, all 3 lanes race to import `@/lib/database`
  // concurrently and serialize on first-cold-import (caught by the
  // "dispatches in PARALLEL" test).
  await resolveAgentCreationDispatch({ hasSkillIds: false });

  // Build per-lane skill-id lookup from the strict-resolver
  // result so `loadReviewerPrompt` skips its per-lane catalog import (same
  // parallel-dispatch reason as above; vitest's slow module loader makes
  // per-lane re-resolution serialize).
  //
  // When pin is INACTIVE the strict resolver did NOT run (laneSkillSets is
  // empty) — pass `undefined` to keep the legacy per-lane tolerant resolution
  // path for backwards-compat. When pin is ACTIVE, pass the pre-resolved
  // array (which may be empty for a lane — but the preflight already gated
  // that case as `anthropic_no_skills_resolved`).
  const skillsByLanePackage = new Map(
    laneSkillSets.map((l) => [l.agentPackageName, l.skillIds]),
  );
  const skillsForLane = (slug: "agent-security-reviewer" | "agent-code-reviewer" | "agent-planner") =>
    skillsByLanePackage.get(REVIEWER_LANE_TO_PACKAGE[slug] ?? "");

  // Sentinel rethrow catch. `dispatchLlmReviewer`
  // rethrows config/sync sentinels (AgentCreationDispatchAbortError,
  // AgentCreationPinConfigError, AnthropicSkillDeliveryError subclasses,
  // AuthorDraftExtractionError) instead of downgrading to a warning. Convert
  // them to deterministic blockers here so the same blocker stream surfaces.
  // review_started milestone + per-lane *_running emits. Per-lane
  // emits are fired BEFORE the dispatch promises are created so they happen
  // regardless of which lane resolves first (the dispatch itself is still
  // parallel).
  await emitMilestoneIfThreaded(progressContext, request.actor, progressPackageName, "review_started");
  // Emit the per-lane *_running milestones SEQUENTIALLY (not Promise.all).
  // Each emit does a dynamic `import("@cinatra-ai/notifications/server")`;
  // racing three concurrent dynamic imports serializes on vitest's slow
  // module loader and only the first-resolved emit's binding fires cleanly
  // (the others hit an unresolved-import error swallowed by the helper).
  // Sequential awaits stay cheap (recipient guard is sync) and the actual
  // LLM advisor dispatch below remains fully parallel.
  await emitMilestoneIfThreaded(progressContext, request.actor, progressPackageName, "security_review_running");
  await emitMilestoneIfThreaded(progressContext, request.actor, progressPackageName, "code_review_running");
  if (planneIsApplicable) {
    await emitMilestoneIfThreaded(progressContext, request.actor, progressPackageName, "planner_running");
  }

  let securityFindings: ReviewFinding[];
  let codeFindings: ReviewFinding[];
  let plannerFindings: ReviewFinding[];
  try {
    [securityFindings, codeFindings, plannerFindings] = await Promise.all([
      dispatchLlmReviewer("agent-security-reviewer", FALLBACK_SECURITY_PROMPT, vars, llmActorContext, skillsForLane("agent-security-reviewer")),
      dispatchLlmReviewer("agent-code-reviewer", FALLBACK_CODE_PROMPT, vars, llmActorContext, skillsForLane("agent-code-reviewer")),
      planneIsApplicable
        ? dispatchLlmReviewer("agent-planner", FALLBACK_PLANNER_PROMPT, vars, llmActorContext, skillsForLane("agent-planner"))
        : Promise.resolve<ReviewFinding[]>([]),
    ]);
  } catch (err) {
    // Sentinel rethrow path — config/sync/typed-artifact failure.
    if (
      err instanceof AgentCreationDispatchAbortError ||
      err instanceof AgentCreationPinConfigError ||
      err instanceof AnthropicSkillDeliveryError ||
      err instanceof AuthorDraftExtractionError
    ) {
      const code = (err as { code?: string }).code ?? err.name;
      return errorResult(code, err.message);
    }
    // Any other escaping error is unexpected — surface as a deterministic
    // blocker so the operator sees it (rather than swallow to a warning,
    // which would mask a real issue).
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(
      "advisory_fanout_unexpected_error",
      `agent_creation_review: unexpected error from advisory fanout: ${message}.`,
    );
  }

  // review_done milestone after all lanes resolve.
  await emitMilestoneIfThreaded(progressContext, request.actor, progressPackageName, "review_done");

  const merged = mergeReviewLanes({
    lintFindings,
    securityFindings,
    codeFindings,
    plannerFindings,
  });

  return {
    ok: merged.blockers.length === 0,
    ...merged,
    ranAdvisoryAgents,
  };
}

function errorResult(code: string, message: string): AgentCreationReviewResult {
  const finding: ReviewFinding = {
    code,
    severity: "blocker",
    message,
    source: "deterministic",
  };
  const merged = mergeReviewLanes({
    lintFindings: [finding],
    securityFindings: [],
    codeFindings: [],
    plannerFindings: [],
  });
  return { ok: false, ...merged, ranAdvisoryAgents: [] };
}

// ---------------------------------------------------------------------------
// Test-only exports (no `_test_` prefix on the const itself so consumers can
// `import { __test } from "@cinatra-ai/agents/agent-creation-review"`).
// ---------------------------------------------------------------------------

export const __testOnly = {
  runDeterministicLintLane,
  loadReviewerPrompt,
  substituteUserTemplate,
  parseReviewerResponse,
  isTrivialOas,
};
