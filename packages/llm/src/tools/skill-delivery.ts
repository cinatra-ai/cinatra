/**
 * Provider-specific skill delivery is centralized behind `SkillDeliveryAdapter`.
 *
 * This module keeps one implementation per provider:
 *
 * - `OpenAiShellSkillDelivery`  — delegates verbatim to `buildSkillTools`
 *   (native `type:"shell"` reading SKILL.md off the on-disk `sourcePath`).
 * - `GeminiInlineSkillDelivery` — the existing inline-into-system-prompt
 *   behavior.
 * - `AnthropicContainerSkillDelivery` — references pre-synced Anthropic
 *   Custom Skills via a single `LlmContainerSkillsTool` (translated by the
 *   Anthropic provider into `container.skills` + `code_execution_20250825` +
 *   stacked betas, alongside the native MCP connector). **Never** function
 *   tools.
 *
 * The seam does not change *which* providers do what; it only centralizes
 * construction so the invariant is enforceable and testable. The hard
 * structural enforcement of "no Anthropic function-tool skills" lives at the
 * Anthropic provider boundary (`providers/anthropic.ts`) so it covers callers
 * that build skill tools outside the orchestration arms (chat runner,
 * agent-stream, llm-bridge).
 */

import type {
  LlmProvider,
  LlmTool,
  LlmContainerSkillsTool,
  SkillExposureEntry,
} from "../types";
import { buildSkillTools, readSkillContent, resolveSkillSummaries } from "./skills";
import {
  getAnthropicSkillSyncMap,
  type AnthropicSyncedSkillRef,
} from "./anthropic-skill-sync-map";
import {
  AnthropicSkillNotSyncedError,
  AnthropicSkillCapError,
} from "../errors";
import { ANTHROPIC_MAX_SKILLS_PER_REQUEST } from "../providers/anthropic-skill-tools";

/**
 * Skill-selection policy mode.
 *
 * - `"creation"` (and the **default when unset**): the pinned agent-creation
 *   path. A fixed, pre-synced per-agent allowlist (2-3 skills). Over Anthropic's
 *   hard 8-skill/request cap is a HARD fail (`AnthropicSkillCapError`) — a
 *   fixed allowlist must NEVER be silently truncated. Absence selects this
 *   mode.
 * - `"general"`: the broad selectable Anthropic path (any non-creation agent
 *   whose admin selected Anthropic; the recommendation agent may dynamically
 *   resolve MORE than 8). Over-cap ⇒ DETERMINISTIC rank-and-truncate-to-8 with
 *   visible (non-silent) `droppedSkillIds` reporting.
 */
export type SkillSelectionMode = "general" | "creation";

/**
 * What a provider's skill delivery contributes to an LLM call: extra tools to
 * merge into the request, plus an optional system-prompt fragment.
 */
export type SkillDeliveryResult = {
  /** Tools to merge into the request (shell for OpenAI, container_skills for Anthropic, none for Gemini). */
  tools: LlmTool[];
  /** System-prompt fragment (inline skill content for Gemini, an availability cue for Anthropic, "" for OpenAI). */
  systemContext: string;
  /**
   * Set ONLY when the general selectable Anthropic path
   * deterministically truncated an over-cap (>8) resolved skill set. Lists the
   * catalog skill ids that were dropped (deterministic, stable order) plus a
   * human-readable reason. Absent on every non-truncating call (creation path,
   * ≤8, OpenAI, Gemini) — surfaces the drop so it is never silent.
   */
  droppedSkillIds?: string[];
  /** Human + machine readable explanation of the truncation. */
  selectionReason?: string;
  /**
   * Every skill this adapter actually delivered to the model, with its mode +
   * invocation-attributability (S10 efficacy loop, cinatra#1368). Excludes
   * skills the adapter dropped (unmountable for OpenAI, empty-body for Gemini,
   * over-cap truncated for the general Anthropic path) — a dropped skill was
   * never exposed. Never includes the personal delta (injected separately by
   * the orchestration layer, which owns that skill's identity).
   */
  exposure: SkillExposureEntry[];
}

export interface SkillDeliveryAdapter {
  readonly provider: LlmProvider;
  deliver(input: {
    skillIds: string[];
    /** Absent ⇒ `"creation"` (hard cap). */
    selectionMode?: SkillSelectionMode;
    /**
     * Invoked once per attributable per-skill invocation observed DURING the
     * subsequent LLM call (OpenAI shell reads of a named `/skills/<slug>`
     * file). Non-attributable adapters (Gemini, Anthropic) never call it.
     */
    onSkillRead?: (skillId: string) => void;
  }): Promise<SkillDeliveryResult>;
}

// ---------------------------------------------------------------------------
// OpenAI — native shell, unchanged
// ---------------------------------------------------------------------------

/**
 * Delegates verbatim to `buildSkillTools`. Matches the prior `index.ts`
 * behavior exactly: tool-based shell delivery, and NO system-prompt skill
 * context for OpenAI (the old code skipped `buildSkillContext` for OpenAI
 * because gpt models read SKILL.md via the native shell and a read_skill cue
 * causes them to call the DB-backed read_skill instead).
 */
export class OpenAiShellSkillDelivery implements SkillDeliveryAdapter {
  readonly provider = "openai" as const;

  async deliver(input: {
    skillIds: string[];
    // `selectionMode` is intentionally ignored — OpenAI native shell delivery
    // has no per-request skill cap.
    selectionMode?: SkillSelectionMode;
    onSkillRead?: (skillId: string) => void;
  }): Promise<SkillDeliveryResult> {
    // Capture the skills actually MOUNTED as shell tools (some requested ids may
    // lack an on-disk sourcePath and are silently dropped by buildSkillTools).
    // Only mounted skills are exposed. `onSkillRead` fires later, when the model
    // reads a named `/skills/<slug>` file — an attributable invocation.
    let mountedSkillIds: string[] = [];
    const tools = await buildSkillTools({
      skillIds: input.skillIds,
      onMounted: (ids) => {
        mountedSkillIds = ids;
      },
      onSkillRead: input.onSkillRead,
    });
    return {
      tools,
      systemContext: "",
      exposure: mountedSkillIds.map((skillId) => ({
        skillId,
        deliveryMode: "openai_shell" as const,
        invocationAttributable: true,
      })),
    };
  }
}

// ---------------------------------------------------------------------------
// Gemini — inline into system prompt, unchanged
// ---------------------------------------------------------------------------

/**
 * Reproduces the exact prior `index.ts` Gemini branch: read each skill's
 * content via `readSkillContent`, filter empties, and join the valid bodies
 * into `"\n\nSkill instructions:\n" + … "\n\n---\n\n" …`. No tools.
 */
export class GeminiInlineSkillDelivery implements SkillDeliveryAdapter {
  readonly provider = "gemini" as const;

  async deliver(input: {
    skillIds: string[];
    // `selectionMode` is intentionally ignored — Gemini inlines skill bodies
    // into the system prompt; no per-request cap.
    selectionMode?: SkillSelectionMode;
    // Gemini inline delivery has no per-skill invocation signal — never called.
    onSkillRead?: (skillId: string) => void;
  }): Promise<SkillDeliveryResult> {
    const resolved = await Promise.all(
      input.skillIds.map(async (id) => ({ id, content: await readSkillContent(id) })),
    );
    // Only skills whose body actually resolved were inlined → only those are
    // exposed. Byte-identical systemContext to the prior filter(Boolean) join.
    const withContent = resolved.filter((r) => Boolean(r.content));
    const systemContext =
      withContent.length > 0
        ? "\n\nSkill instructions:\n" +
          withContent.map((r) => r.content).join("\n\n---\n\n")
        : "";
    return {
      tools: [],
      systemContext,
      exposure: withContent.map((r) => ({
        skillId: r.id,
        deliveryMode: "gemini_inline" as const,
        invocationAttributable: false,
      })),
    };
  }
}

// ---------------------------------------------------------------------------
// Anthropic — container.skills only, never function tools
// ---------------------------------------------------------------------------

/**
 * Resolves each catalog skill id to its pre-synced Anthropic Custom Skill
 * reference, dedupes, caps at 8, and emits ONE `LlmContainerSkillsTool`. Any
 * unsynced id fails loud (`AnthropicSkillNotSyncedError`) — never a
 * function-tool fallback. The system context names the available skills
 * WITHOUT mentioning `read_skill` (which does not exist on this path and is
 * forbidden).
 */
export class AnthropicContainerSkillDelivery implements SkillDeliveryAdapter {
  readonly provider = "anthropic" as const;

  async deliver(input: {
    skillIds: string[];
    selectionMode?: SkillSelectionMode;
    // Anthropic container skills run automatically — no per-skill invocation
    // signal at our boundary; never called.
    onSkillRead?: (skillId: string) => void;
  }): Promise<SkillDeliveryResult> {
    if (input.skillIds.length === 0) {
      return { tools: [], systemContext: "", exposure: [] };
    }

    // Absent ⇒ "creation" (hard cap). Only an EXPLICIT "general" engages
    // rank-and-truncate. Creation dispatch sites pin "creation" explicitly as
    // belt-and-suspenders against a future default flip.
    const mode: SkillSelectionMode = input.selectionMode ?? "creation";

    // Capture each catalog id's FIRST-SEEN position in the ORIGINAL input
    // (pre-dedupe). `input.skillIds` arrives already tier-ranked by
    // `getAssignedSkillIdsForAgent` (agent self-match → recommender-scored →
    // system → custom; dedup keeps earliest position). This index IS the
    // deterministic rank. Captured BEFORE any Set so iteration order can never
    // influence it.
    const firstSeenIndex = new Map<string, number>();
    input.skillIds.forEach((id, i) => {
      if (!firstSeenIndex.has(id)) firstSeenIndex.set(id, i);
    });

    const syncMap = getAnthropicSkillSyncMap();
    const refs: AnthropicSyncedSkillRef[] = [];
    const unsynced: string[] = [];

    for (const catalogSkillId of input.skillIds) {
      const ref = await syncMap.resolve(catalogSkillId);
      if (ref) {
        refs.push(ref);
      } else {
        unsynced.push(catalogSkillId);
      }
    }

    // Fail loud — never silently degrade to a function tool. This
    // runs BEFORE any truncation so an unsynced skill can never be silently
    // dropped by rank-and-truncate to hide it: it is ALWAYS a config error.
    if (unsynced.length > 0) {
      throw new AnthropicSkillNotSyncedError(unsynced);
    }

    // Dedupe by Anthropic skill id (a catalog set may map to the same
    // uploaded skill; the container must not list it twice). The retained
    // entry keeps the EARLIEST catalog-id input position via firstSeenIndex.
    const seen = new Set<string>();
    const deduped: AnthropicSyncedSkillRef[] = [];
    for (const ref of refs) {
      if (seen.has(ref.skillId)) continue;
      seen.add(ref.skillId);
      deduped.push(ref);
    }

    let selected = deduped;
    let droppedSkillIds: string[] | undefined;
    let selectionReason: string | undefined;

    if (deduped.length > ANTHROPIC_MAX_SKILLS_PER_REQUEST) {
      if (mode === "creation") {
        // Fixed pre-synced allowlist — NEVER silently truncate. Fail loud.
        // (Creation lanes resolve 2-3 skills; reaching here is a real
        // mis-configuration that must surface, not be papered over.)
        throw new AnthropicSkillCapError(
          deduped.length,
          deduped.map((r) => r.catalogSkillId),
        );
      }
      // General selectable path: DETERMINISTIC rank-and-truncate.
      // Primary key = first-seen input position (the tier ranking). Total-
      // order tiebreak = ascending catalogSkillId (lexicographic) — a pure
      // function of the input so identical input ⇒ identical selection. No
      // Date / RNG / Set-iteration dependence (firstSeenIndex was built from
      // the raw input array before any Set existed).
      const ranked = [...deduped].sort((a, b) => {
        const ai = firstSeenIndex.get(a.catalogSkillId) ?? Number.MAX_SAFE_INTEGER;
        const bi = firstSeenIndex.get(b.catalogSkillId) ?? Number.MAX_SAFE_INTEGER;
        if (ai !== bi) return ai - bi;
        return a.catalogSkillId < b.catalogSkillId
          ? -1
          : a.catalogSkillId > b.catalogSkillId
            ? 1
            : 0;
      });
      selected = ranked.slice(0, ANTHROPIC_MAX_SKILLS_PER_REQUEST);
      const dropped = ranked.slice(ANTHROPIC_MAX_SKILLS_PER_REQUEST);
      droppedSkillIds = dropped.map((r) => r.catalogSkillId);
      selectionReason =
        `Anthropic allows at most ${ANTHROPIC_MAX_SKILLS_PER_REQUEST} Custom ` +
        `Skills per request; ${deduped.length} were resolved for this general ` +
        `(non-creation) Anthropic request. Deterministically ranked by ` +
        `resolved-order tier (agent self-match → recommender-scored → system ` +
        `→ custom; stable tiebreak by skill id) and truncated to the top ` +
        `${ANTHROPIC_MAX_SKILLS_PER_REQUEST}. Kept: ` +
        `${selected.map((r) => r.catalogSkillId).join(", ")}. Dropped: ` +
        `${droppedSkillIds.join(", ")}.`;
      // Visible, never silent (the bridge ALSO returns this on the response).
      console.warn(
        `[anthropic-skill-delivery] general-path rank-and-truncate: ` +
          `kept=${selected.length} dropped=${droppedSkillIds.length} ` +
          `droppedSkillIds=[${droppedSkillIds.join(",")}]`,
      );
    }

    const containerTool: LlmContainerSkillsTool = {
      type: "container_skills",
      skills: selected.map((r) => ({
        skillId: r.skillId,
        version: r.version,
        catalogSkillId: r.catalogSkillId,
      })),
    };

    // Anthropic-specific availability cue. Lists ONLY the selected (post-
    // truncation) skills so the model is never told about a skill that is not
    // actually in `container.skills`. Deliberately does NOT say "use the
    // read_skill tool" (false here; read_skill is forbidden on this path).
    const selectedIds = new Set(selected.map((r) => r.catalogSkillId));
    const summaries = (await resolveSkillSummaries(input.skillIds)).filter((s) =>
      selectedIds.has(s.id),
    );
    const lines = summaries.length > 0
      ? summaries.map((s) => `- ${s.id}: ${s.description || s.name}`)
      : selected.map((r) => `- ${r.catalogSkillId}`);
    const systemContext = [
      "The following skills are loaded into your code-execution container " +
        "and applied automatically — follow their instructions:",
      ...lines,
    ].join("\n");

    // Exposure = the SELECTED (post-truncation) skills only; a rank-and-truncate
    // drop was never delivered. Container skills apply automatically → invocation
    // is NON-attributable at our boundary.
    const exposure: SkillExposureEntry[] = selected.map((r) => ({
      skillId: r.catalogSkillId,
      deliveryMode: "anthropic_container" as const,
      invocationAttributable: false,
    }));

    return { tools: [containerTool], systemContext, droppedSkillIds, selectionReason, exposure };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const openAiDelivery = new OpenAiShellSkillDelivery();
const geminiDelivery = new GeminiInlineSkillDelivery();
const anthropicDelivery = new AnthropicContainerSkillDelivery();

/**
 * Resolve the skill-delivery adapter for a provider. This is the seam entry
 * point the orchestration arms use instead of inline provider branching.
 */
export function selectSkillDeliveryAdapter(
  provider: LlmProvider,
): SkillDeliveryAdapter {
  switch (provider) {
    case "openai":
      return openAiDelivery;
    case "gemini":
      return geminiDelivery;
    case "anthropic":
      return anthropicDelivery;
    default: {
      // Exhaustiveness guard — a new provider must declare its delivery.
      const _exhaustive: never = provider;
      throw new Error(
        `No SkillDeliveryAdapter registered for provider "${String(_exhaustive)}"`,
      );
    }
  }
}
