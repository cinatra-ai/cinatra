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
// The skill-delivery ABI types are relocated to the sdk-extensions leaf
// (llm-providers S4.x — cinatra#1964) so a connector can `import type` them and
// implement a compliant adapter, exactly as `LlmProviderAdapter` was relocated
// for the request-translation channel (S4.0). Imported for local use (the
// in-core adapters `implements SkillDeliveryAdapter`) AND re-exported below so
// core keeps compiling byte-for-byte and existing importers are unchanged.
import type {
  SkillSelectionMode,
  SkillDeliveryResult,
  SkillDeliveryAdapter,
  SkillDeliveryFloor,
} from "@cinatra-ai/sdk-extensions/llm-provider-adapter-contract";
export type {
  SkillSelectionMode,
  SkillDeliveryResult,
  SkillDeliveryAdapter,
  SkillDeliveryFloor,
};
import { buildSkillTools, readSkillContent, resolveSkillSummaries } from "./skills";
// llm-providers S4.x (cinatra#1964): the connector-registered SKILL-DELIVERY
// adapter surface resolver (co-located with the request-translation resolver in
// llm-provider-surfaces so it adds no net-new route-reachable module). Absent
// for every provider in this first slice -> the in-core fallback below runs
// unchanged (zero behavior change); a trusted connector registration wins once
// it relocates, and a malformed/duplicate one fails closed (never silent
// fallback).
import { getLlmSkillDeliveryAdapterSurface } from "@/lib/llm-provider-surfaces";
import {
  getAnthropicSkillSyncMap,
  type AnthropicSyncedSkillRef,
} from "./anthropic-skill-sync-map";
import {
  AnthropicSkillNotSyncedError,
  AnthropicSkillCapError,
} from "../errors";

// Anthropic's hard per-request Custom Skills maximum. Inlined here (the
// `anthropic-skill-tools` leaf that once held it relocated into the anthropic
// connector — cinatra#1715; the connector keeps its own copy for the provider
// boundary). This is the value the core delivery floor uses to rank-and-cap the
// selected skill set before it reaches any provider.
const ANTHROPIC_MAX_SKILLS_PER_REQUEST = 8;

// `SkillSelectionMode`, `SkillDeliveryResult`, and `SkillDeliveryAdapter` are
// defined canonically in the sdk-extensions leaf
// (`@cinatra-ai/sdk-extensions/llm-provider-adapter-contract`) and imported +
// re-exported at the top of this module (llm-providers S4.x — cinatra#1964).
// The in-core adapters below `implements SkillDeliveryAdapter` unchanged.

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
 * The provider-NEUTRAL delivery floor CORE owns and supplies to a
 * connector-registered skill-delivery adapter through the registration
 * surface's factory (the core-owned dependency-injection seam — llm-providers
 * S4.x AC2, cinatra#1964). These three primitives (+ `@cinatra-ai/skills`) STAY
 * in core as the generic delivery floor #1715 AC2 keeps; a relocated connector
 * adapter consumes them here instead of importing core. ZERO
 * `@cinatra-ai/skills` relocation. Bound to the SAME `./skills` exports the
 * in-core adapters use, so a relocated adapter is byte-for-byte equivalent.
 *
 * Built LAZILY (only when a connector surface actually resolves) so this
 * module's import-time surface is unchanged — a caller that never registers a
 * skill-delivery surface never forces the floor primitives to be read.
 */
function coreSkillDeliveryFloor(): SkillDeliveryFloor {
  return { buildSkillTools, readSkillContent, resolveSkillSummaries };
}

/**
 * Resolve the skill-delivery adapter for a provider. This is the seam entry
 * point the orchestration arms use instead of inline provider branching; it
 * runs in core BEFORE `adapter.generate` to PRODUCE the provider's `skillTools`
 * + system-prompt fragment (provider-agnostic).
 *
 * llm-providers S4.x (cinatra#1964): prefer a CONNECTOR-registered
 * `llm-skill-delivery-adapter` surface — when a trusted connector has
 * registered one for this provider it OWNS resolution (the in-core adapter is
 * NOT consulted), and it consumes the core-owned neutral delivery floor via the
 * DI seam. When ABSENT (no connector has relocated this provider yet — the
 * transitional state of this slice) fall through to the in-core adapter (ZERO
 * behavior change). A registered-but-malformed / duplicate surface makes
 * `getLlmSkillDeliveryAdapterSurface` THROW (fail closed), so a broken adapter
 * can never silently downgrade to the legacy in-core path. Mirrors
 * `resolveProviderAdapter` (the request-translation channel).
 */
export function selectSkillDeliveryAdapter(
  provider: LlmProvider,
): SkillDeliveryAdapter {
  const surface = getLlmSkillDeliveryAdapterSurface(provider);
  if (surface) {
    return surface.createSkillDeliveryAdapter(coreSkillDeliveryFloor());
  }

  // ---- transitional in-core fallback (deleted per-provider as each connector
  // relocates its skill-delivery adapter under `llm-skill-delivery-adapter` —
  // S4.x AC2/branch (a) item 4) ----
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
