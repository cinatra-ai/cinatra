/**
 * `runAuthorAgent` dispatch helper.
 *
 * Wraps the `@cinatra-ai/author-agent` LLM dispatch + the strict
 * `extractAuthorDraftFromText` typed-artifact gate. The assistant NEVER
 * reinterprets prose into authoring actions — this helper's caller receives
 * a typed `AuthorDraft` or an `AuthorDraftExtractionError` sentinel.
 *
 * Standing invariants honoured:
 *   1. OpenAI is the default when the pin is INACTIVE.
 *   2. NO Anthropic function tools EVER — when the pin is ACTIVE on Anthropic,
 *      dispatch is forced through `runSkillAwareDeterministicLlmTask` AND a
 *      dispatch-site abort guard refuses to fire if `skillIds` is empty
 *      (closing the function-tool fallback at `anthropic.ts:466`).
 *   3. Skills only via the catalog (`resolveRequiredCreationSkillIds` strict
 *      resolver — catalog errors propagate, never swallowed into `[]`).
 *
 * NOTE: this helper dispatches DIRECTLY through the orchestration layer; the
 * author-agent's `cinatra_llm.preferredProvider`/`preferredModel` metadata in
 * its OAS is IGNORED here (those hints are honoured only by the WayFlow
 * ApiNode runtime when the agent runs via `agent_run`, not by this in-process
 * helper).
 */

import "server-only";

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  runDeterministicLlmTask,
  runSkillAwareDeterministicLlmTask,
} from "@cinatra-ai/llm";

import { buildActorContextFromPrimitive } from "./auth-policy";
import { resolveAgentInstallDir } from "./agent-install-path";
import {
  resolveAgentCreationDispatch,
  AgentCreationDispatchAbortError,
} from "./resolve-agent-creation-dispatch";
import { resolveRequiredCreationSkillIds } from "./resolve-required-creation-skill-ids";
import {
  extractAuthorDraftFromText,
  type AuthorDraft,
} from "./author-draft";
import { requireAgentRole, agentRoleDirSlug } from "./agent-roles";

// EXPORTED as the canonical author-lane identity: the chat-dispatch
// creation-flow set (creation-flow-packages.ts) derives from THIS constant
// instead of carrying its own copy of the package name. Role-resolved
// (cinatra#151 Stage 5b): the author agent advertises "agent-author" in its
// manifest; resolution is FAIL-LOUD (it is a cinatra.systemExtensions
// member, present in every universe by the required lock).
export const AUTHOR_AGENT_PACKAGE_NAME = requireAgentRole("agent-author");
const AUTHOR_AGENT_DIR_SLUG = agentRoleDirSlug("agent-author");
const AUTHOR_AGENT_LOG_LABEL = "run_author_agent";

const FALLBACK_AUTHOR_SYSTEM =
  `You are the ${AUTHOR_AGENT_PACKAGE_NAME}. Draft a new Cinatra agent extension ` +
  "package from the supplied creation spec. Emit ONLY the JSON envelope " +
  '`{"draft":{"package":{…},"oas":{…},"skills":[…]}}`. No prose, no code fences. ' +
  "Follow the kind-at-end naming convention (`@cinatra-ai/<slug>-(agent|skill|connector|artifact)`). " +
  "See the agent-authoring SKILL.md (delivered via the catalog).";

/**
 * Load the author-agent's `$referenced_components.author.data.system` prompt
 * from its on-disk OAS. Mirrors the `loadReviewerPrompt` lookup pattern in
 * `agent-creation-review.ts`. Falls back to `FALLBACK_AUTHOR_SYSTEM` if any
 * filesystem/JSON step fails (this is the system prompt — a fallback is
 * acceptable; the catalog skill is the source of truth for methodology).
 */
async function loadAuthorAgentSystemPrompt(): Promise<string> {
  const installRoot = resolveAgentInstallDir();
  const oasPath = join(installRoot, "cinatra-ai", AUTHOR_AGENT_DIR_SLUG, "cinatra", "oas.json");
  if (!existsSync(oasPath)) {
    return FALLBACK_AUTHOR_SYSTEM;
  }
  try {
    const raw = await readFile(oasPath, "utf8");
    const oas = JSON.parse(raw) as Record<string, unknown>;
    const refs = oas.$referenced_components;
    if (!refs || typeof refs !== "object") return FALLBACK_AUTHOR_SYSTEM;
    const authorNode = (refs as Record<string, unknown>).author as
      | Record<string, unknown>
      | undefined;
    if (!authorNode || authorNode.component_type !== "ApiNode") {
      return FALLBACK_AUTHOR_SYSTEM;
    }
    const data = authorNode.data as Record<string, unknown> | undefined;
    if (typeof data?.system === "string" && data.system.length > 0) {
      return data.system;
    }
  } catch {
    return FALLBACK_AUTHOR_SYSTEM;
  }
  return FALLBACK_AUTHOR_SYSTEM;
}

/** Build the user prompt with the documented envelope reminder. */
function buildAuthorAgentUserPrompt(input: { packageSlug: string; spec: string }): string {
  return [
    `packageSlug: ${input.packageSlug}`,
    "",
    "spec:",
    input.spec,
    "",
    'Emit ONLY the JSON envelope `{"draft":{"package":{…},"oas":{…},"skills":[…]}}` per the agent-authoring SKILL.md. No prose, no code fences.',
  ].join("\n");
}

export type RunAuthorAgentInput = {
  /** Target package slug. The author MUST emit a `draft.package.name` matching the kind-at-end shape. */
  packageSlug: string;
  /** Free-form creation request — what should the new agent do? */
  spec: string;
  /** ALS actor context (same pattern as the reviewer lanes). */
  actorContext: ReturnType<typeof buildActorContextFromPrimitive>;
};

/**
 * Dispatch the @cinatra-ai/author-agent and return a typed `AuthorDraft`.
 *
 * Throws:
 *   - `AgentCreationPinConfigError` when the pin is active but provider/model
 *     are unset or the stored provider isn't a known value.
 *   - `AgentCreationDispatchAbortError("anthropic_empty_skill_ids")` when the
 *     pin resolves to Anthropic AND the strict catalog resolver returned no
 *     skills (closes the function-tool fallback at `anthropic.ts:466`).
 *   - Any catalog error from `resolveRequiredCreationSkillIds` (rethrown — the
 *     resolver does NOT swallow into `[]`).
 *   - `AuthorDraftExtractionError` when the LLM emits prose / malformed JSON /
 *     a non-conforming envelope (this is the typed-artifact gate per spec §4.5).
 */
export async function runAuthorAgent(input: RunAuthorAgentInput): Promise<AuthorDraft> {
  const laneSkillSets = await resolveRequiredCreationSkillIds([AUTHOR_AGENT_PACKAGE_NAME]);
  const skillIds = laneSkillSets[0]?.skillIds ?? [];

  const dispatch = await resolveAgentCreationDispatch({ hasSkillIds: skillIds.length > 0 });

  // Belt-and-suspenders: Anthropic + empty skills must never reach the
  // orchestration entry (would trip the function-tool fallback). The chat
  // dispatcher's preflight should have caught this earlier; this is direct-caller
  // protection.
  if (dispatch.provider === "anthropic" && skillIds.length === 0) {
    throw new AgentCreationDispatchAbortError(
      "anthropic_empty_skill_ids",
      `runAuthorAgent: cannot dispatch ${AUTHOR_AGENT_PACKAGE_NAME} to Anthropic with zero skills (function-tool fallback risk at anthropic.ts:466).`,
    );
  }

  const system = await loadAuthorAgentSystemPrompt();
  const user = buildAuthorAgentUserPrompt({ packageSlug: input.packageSlug, spec: input.spec });

  const common = {
    provider: dispatch.provider,
    model: dispatch.model,
    system,
    user,
    reasoningEffort: "medium" as const,
    logLabel: AUTHOR_AGENT_LOG_LABEL,
    actorContext: input.actorContext,
  };
  const response = dispatch.useSkillAware
    ? await runSkillAwareDeterministicLlmTask({
        ...common,
        skillIds,
        // The author-agent creation lane is a FIXED
        // pre-synced allowlist. Pin "creation" so an over-cap is a HARD
        // AnthropicSkillCapError, never silently rank-and-truncated.
        skillSelectionMode: "creation" as const,
      })
    : await runDeterministicLlmTask(common);
  const text = response.text ?? "";

  // STRICT typed-artifact gate per spec §4.5 — throws AuthorDraftExtractionError
  // on prose / malformed / non-conforming output.
  return extractAuthorDraftFromText(text);
}
