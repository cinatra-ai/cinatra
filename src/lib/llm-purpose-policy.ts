/**
 * The LLM PURPOSE POLICY INVENTORY (cinatra#2093, epic #2086 S6).
 *
 * Before S6, "which provider runs this piece of work?" was answered
 * ACCIDENTALLY at ~a dozen call sites: each one called an implicit-default
 * resolver, each got whatever the fallthrough happened to produce, and nothing
 * recorded whether that was a considered decision or an oversight. Two of them
 * had grown ad-hoc special cases (the `allowAnthropicFallback` opt-in) precisely
 * because the implicit answer was wrong for them.
 *
 * With S6's EXACT BINDING that ambiguity becomes visible: an implicit default is
 * now the operator's ACTUAL stored choice, so every site that takes one is
 * making a claim about that choice. This module makes each claim explicit and
 * REVIEWABLE, and `__tests__/llm-purpose-policy-inventory.test.ts` turns it into
 * a GATE: it mechanically re-derives the set of implicit-default resolution
 * sites from the source tree and fails if any site is unregistered (a new
 * implicit default slipped in) or if any entry is stale (the site moved or the
 * call was removed). The inventory can therefore never quietly fall behind the
 * code it describes.
 *
 * NOT a runtime dispatcher: nothing reads this to CHOOSE a provider. The policy
 * a site is assigned is implemented AT that site (that is the point — the
 * choice lives where the work happens); this module records and gates it, and
 * `describeMatcherProviderConstraint` is the one place a recorded constraint is
 * also surfaced to the operator.
 */

import type { LlmProvider } from "@cinatra-ai/agents/llm-provider-policy";

/**
 * The four policies a purpose may be assigned. A purpose has EXACTLY one.
 */
export type LlmPurposePolicy =
  /**
   * Runs on the operator's stored `llm_default_provider`, exactly — no
   * per-purpose opinion, no failover of its own. The right answer for the
   * broad majority of work: the operator chose a provider and this purpose
   * honours it. Unavailability surfaces per the site's own error handling.
   */
  | "exact-default"
  /**
   * Names its provider explicitly and does NOT consult the stored default,
   * because the purpose has a hard capability or API dependency the stored
   * default may not satisfy. Every explicit-pin MUST carry a rationale naming
   * the dependency — "it has always been OpenAI" is not one.
   */
  | "explicit-pin"
  /**
   * Resolves through a DIFFERENT stored admin preference than
   * `llm_default_provider` (its own per-purpose default key), because the
   * capability is orthogonal to text generation.
   */
  | "separate-default"
  /**
   * Has no provider-independent implementation: when the required provider is
   * not configured the purpose is HONESTLY unavailable and says so, rather
   * than degrading onto a provider that cannot do the job.
   */
  | "unavailable-without-provider";

export interface LlmPurposeEntry {
  /** Stable identifier for the purpose (referenced from the site's comment). */
  purpose: string;
  /**
   * Repo-relative path of the file carrying the resolution site. The gate test
   * requires this file to still contain an implicit-default resolution (for
   * `exact-default` / `separate-default`) — so a moved call site turns it red.
   */
  file: string;
  /** Human summary of what the purpose does. */
  what: string;
  policy: LlmPurposePolicy;
  /** WHY this policy — the reviewable part. */
  rationale: string;
  /** For `explicit-pin`, the provider pinned. */
  pinnedProvider?: LlmProvider;
}

/**
 * The seeded assignments ratified in cinatra#2093.
 *
 * ORDERING NOTE for reviewers: entries are grouped by policy, not by file, so
 * the shape of the decision is readable at a glance — the overwhelming majority
 * are `exact-default` (honour the operator's choice), and every deviation has
 * to justify itself.
 */
export const LLM_PURPOSE_INVENTORY: readonly LlmPurposeEntry[] = Object.freeze([
  // ---- exact-default -----------------------------------------------------
  {
    purpose: "assistant-runtime",
    file: "src/lib/assistant-runtime/runtime.ts",
    what: "The cinatra assistant's own chat turns (no per-agent model preference).",
    policy: "exact-default",
    rationale:
      "The assistant IS the product surface the operator configured a provider for. S6 AC: it uses exactly the stored provider and unavailability is a visible error (resolveBoundDefaultAdapter), never a silent hop.",
  },
  {
    purpose: "llm-bridge-passthrough",
    file: "src/app/api/llm-bridge/route.ts",
    what: "Agent LLM calls through /api/llm-bridge that carry no metadata.cinatra.llm.preferredProvider.",
    policy: "exact-default",
    rationale:
      "An agent that states no preference is asking for 'the instance's provider'. An agent that DOES state one is the explicit-pin entry below.",
  },
  {
    purpose: "artifact-matching",
    file: "src/lib/artifacts/matcher-runtime.ts",
    what: "Semantic artifact identity matching.",
    policy: "exact-default",
    rationale:
      "Provider-neutral prompt+JSON work with no capability dependency. Already degrades cleanly (a null runtime skips the match and structural identity stands).",
  },
  {
    purpose: "chat-capture-classification",
    file: "src/lib/chat-capture/classifier.ts",
    what: "Classifies whether a chat turn carries a durable instruction worth capturing.",
    policy: "exact-default",
    rationale: "Provider-neutral classification; no capability dependency.",
  },
  {
    purpose: "object-classification",
    file: "packages/objects/src/classifier/index.ts",
    what:
      "LLM-types agent-emitted structured data into registered object types " +
      "(objects_save, the objects_classify dry-run, and the unbound run-output " +
      "multi-produces tiebreak).",
    policy: "exact-default",
    rationale:
      "Provider-neutral classification; no capability dependency. It uses the " +
      "resolved runtime's configured default model and passes NO per-purpose " +
      "override: the `objects_classification_model` admin setting (a bare " +
      "OpenAI model string, default `gpt-4o-mini`) was retired in cinatra#2335 " +
      "because forwarding it verbatim to a non-OpenAI adapter was a per-call " +
      "provider failure on an Anthropic-default instance.",
  },
  {
    purpose: "skill-prefill-generation",
    file: "packages/skills/src/prefill-generation.ts",
    what: "Generates the prefilled SKILL.md scaffold on skill creation.",
    policy: "exact-default",
    rationale:
      "Provider-neutral generation. The pre-S6 Anthropic-fallback special case is RETIRED: it existed only to reach an Anthropic-only install past the global Anthropic exclusion, which no longer exists.",
  },
  {
    purpose: "personal-skill-generation",
    file: "packages/skills/src/personal-skills.ts",
    what: "Generates/updates a personal skill (drawer action, autosave job, MCP primitive) and distils chat-capture instructions.",
    policy: "exact-default",
    rationale:
      "Same retirement as skill-prefill-generation: with Anthropic defaultCapable, an Anthropic-only install resolves Anthropic because it IS the stored default. No per-purpose escape hatch, and no risk of this purpose silently running off-default on a multi-provider install.",
  },
  {
    purpose: "trigger-duration-estimate",
    file: "packages/agents/src/trigger-duration-estimate.ts",
    what: "Estimates how long a scheduled agent run should take.",
    policy: "exact-default",
    rationale: "Small provider-neutral estimation prompt; no capability dependency.",
  },
  {
    purpose: "agent-creation-review",
    file: "packages/agents/src/agent-creation-review.ts",
    what: "The three LLM advisor lanes of the agent compiler's review primitive.",
    policy: "exact-default",
    rationale:
      "INVENTORY FINDING: no hard capability pin. The lanes are prompt+JSON review over agent source using the reviewer agents' own system prompts; nothing in them requires a provider-specific API. Assigned exact-default per the issue's 'unless the inventory proves a hard capability pin' clause.",
  },
  {
    purpose: "skill-llm-matching",
    file: "packages/skills/src/llm-matching/run-context.ts",
    what: "Skill auto-matching — capability-routed full-catalog runs (provider batch or synchronous fan-out; consumed by jobs.ts).",
    policy: "exact-default",
    rationale:
      "Setup-flow S6: the pipeline is provider-neutral. mintSkillMatchRunContext (the SOLE resolution site for the whole matcher) freezes one {provider, model, evaluatorVersion} context from the stored default at run creation; batch-capable adapters take the batch path, batch-less adapters run a chunked synchronous fan-out. The former hard OpenAI Batch-API pin is gone.",
  },
  {
    purpose: "skill-matching-pair-evaluation",
    file: "packages/skills/src/llm-matching/run-context.ts",
    what: "Single-pair evaluation + the drift sampler canary for the matcher (consumed by evaluate-pair.ts).",
    policy: "exact-default",
    rationale:
      "Setup-flow S6: every evaluation runs on the frozen per-run context minted (in run-context.ts) from the stored default — evaluate-pair.ts itself never resolves a provider — so the sampler canaries exactly the provider/model the pipeline it calibrates runs on: same context object, same run.",
  },
  {
    purpose: "author-agent-run",
    file: "packages/agents/src/run-author-agent.ts",
    what: "The built-in author agent's generation turns.",
    policy: "exact-default",
    rationale: "Provider-neutral generation; no capability dependency.",
  },

  // ---- explicit-pin ------------------------------------------------------
  {
    purpose: "agent-preferred-provider",
    file: "src/app/api/llm-bridge/_llm-dispatch.ts",
    what: "An agent whose metadata.cinatra.llm names a preferredProvider (and/or a capabilityRequired).",
    policy: "explicit-pin",
    rationale:
      "The agent author declared the provider as part of the agent's contract. Honoured verbatim; the resolver's exact-binding rules apply to the implicit path only.",
  },
  {
    purpose: "chat-hitl-prompt-drive",
    file: "packages/chat/src/actions.ts",
    what: "Builder HITL assistance — extracting gate answers from a chat prompt.",
    policy: "explicit-pin",
    pinnedProvider: "openai",
    rationale:
      "INVENTORY FINDING: pinned in code today via an explicit provider argument. Recorded as-is rather than silently widened — the extraction depends on strict structured-output schema adherence that has only been validated on OpenAI. Re-evaluating it is follow-up work, not a drive-by change inside the un-fencing.",
  },
  {
    purpose: "agent-run-input-extraction",
    file: "src/app/api/chat/explicit-dispatch-server.ts",
    what: "Extracting structured agent-run inputs from a chat prompt.",
    policy: "explicit-pin",
    pinnedProvider: "openai",
    rationale:
      "Same strict structured-output dependency and the same as-is recording as chat-hitl-prompt-drive.",
  },

  // ---- separate-default --------------------------------------------------
  {
    purpose: "image-generation",
    file: "src/lib/blog/gemini.ts",
    what: "Blog/campaign image materialization.",
    policy: "separate-default",
    rationale:
      "Image generation is orthogonal to text generation and already has its OWN stored admin preference (llm_default_image_provider, read by resolveDefaultImageAdapter). It deliberately does NOT follow llm_default_provider — an operator on a text provider with no image support must still be able to generate images.",
  },

  // ---- unavailable-without-provider --------------------------------------
  {
    purpose: "assistant-availability-gate",
    file: "src/app/api/assistants/chat/route.ts",
    what:
      "The pre-turn gate that refuses a turn when the bound LLM runtime is unavailable, NAMING the stored provider (cinatra#2094 F10).",
    policy: "unavailable-without-provider",
    rationale:
      "The honest answer when the stored provider is unavailable is 'this cannot run', surfaced to the caller — exactly the S6 no-silent-hop AC. Degrading onto another provider here would defeat the exact binding the rest of the change establishes.",
  },
]);

/** All purposes assigned `policy`. */
export function purposesWithPolicy(policy: LlmPurposePolicy): LlmPurposeEntry[] {
  return LLM_PURPOSE_INVENTORY.filter((e) => e.policy === policy);
}

/** The inventory entry for `purpose`, or undefined. */
export function findPurpose(purpose: string): LlmPurposeEntry | undefined {
  return LLM_PURPOSE_INVENTORY.find((e) => e.purpose === purpose);
}

/**
 * The provider an `explicit-pin` purpose requires, or null when the purpose is
 * not pinned. Used by the setup surface to state a constraint honestly.
 */
export function pinnedProviderForPurpose(purpose: string): LlmProvider | null {
  const entry = findPurpose(purpose);
  return entry?.policy === "explicit-pin" ? (entry.pinnedProvider ?? null) : null;
}

/**
 * REDUCED (setup-flow S6, deliberately not deleted): matching itself runs on
 * every provider — batch-capable adapters take the provider batch path,
 * batch-less adapters run the chunked synchronous fan-out — so there is no
 * per-provider matching constraint left to surface at setup time (the former
 * "requires OpenAI" copy and its readiness-saga twin are retired). What
 * remains true is a MODE note: exact-default can select a provider whose
 * adapter implements no batch surface, and only batch-capable adapters use
 * provider batch pricing/SLAs. The matching admin surface derives the actual
 * mode per run from the adapter capability probe; this static sentence exists
 * for surfaces that cannot probe.
 */
export function describeMatcherProviderConstraint(): string {
  return (
    "Batch-mode matching requires a batch-capable provider adapter; " +
    "providers without one run matching as a synchronous background fan-out."
  );
}
