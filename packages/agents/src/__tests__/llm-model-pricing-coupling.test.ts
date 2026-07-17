/**
 * llm-providers S1 (#1712, AC7) — model-catalog ↔ pricing coupling.
 *
 * The declared per-provider model allowlist lives in
 * `@cinatra-ai/agents/llm-provider-policy` (S1a: derived from the build-known
 * declaration catalog; a later slice generates it from the connector
 * manifests). Pricing lives in `@cinatra-ai/metric-cost-api` and MUST stay
 * coupled to the catalog: adding a routable model without a pricing row is a
 * silent cost gap (usage records NULL `cost_usd` — cf. #271).
 *
 * REALITY (S1b): the hardcoded `LLM_PRICING` fallback in metric-cost-api is a
 * DELIBERATELY PARTIAL safety net — the authoritative per-model prices are
 * synced into the DB from LiteLLM at runtime (`runLiteLlmPricingSyncJob`), and
 * `computeLlmCostUsd` prefers the DB row, using `LLM_PRICING` only as a
 * fallback for a few critical ids. So a declared model without a hardcoded row
 * is not automatically a bug — it may be DB-priced. This test therefore
 * enforces the coupling as a SHRINK-ONLY RATCHET:
 *
 *   - Every declared model id EITHER has a hardcoded `LLM_PRICING` fallback OR
 *     is enumerated in `KNOWN_DB_PRICED_MODELS` (documented as DB-priced, no
 *     hardcoded fallback). A NEW catalog model added with neither FAILS —
 *     forcing the catalog author to add pricing or an explicit acknowledgement.
 *   - The allowlist cannot rot: every `KNOWN_DB_PRICED_MODELS` entry must still
 *     be a declared model AND must still be absent from `LLM_PRICING` (once a
 *     hardcoded row is added, its allowlist entry must be removed in the same
 *     change). Together these pin the allowlist to EXACTLY (catalog \ priced).
 *
 * When S3 reconciles the catalog + pricing (the Gemini 3.5-only train and the
 * full price sweep), `KNOWN_DB_PRICED_MODELS` shrinks toward empty.
 */
import { describe, it, expect } from "vitest";
import {
  ALLOWED_MODEL_IDS,
  LLM_PROVIDERS,
  BUILD_KNOWN_LLM_PROVIDER_DECLARATIONS,
} from "../llm-provider-policy";
import { LLM_PRICING } from "@cinatra-ai/metric-cost-api/pricing";

// Declared model ids that currently have NO hardcoded `LLM_PRICING` fallback
// and are priced from the DB (LiteLLM sync) at runtime. Reconciled by S3.
// Keep this in sync with the catalog: adding a hardcoded row → remove the
// entry; adding a model → add pricing or an entry.
const KNOWN_DB_PRICED_MODELS: ReadonlySet<string> = new Set<string>([
  // OpenAI — GA models not in the critical hardcoded set.
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5-mini",
  "gpt-4.1",
  "gpt-4.1-mini",
  // Anthropic — the hardcoded fallback carries older/aliased ids; the declared
  // catalog ids are DB-priced pending the S3 sweep.
  "claude-sonnet-4-6",
  "claude-opus-4-7",
  "claude-3-7-sonnet-latest",
  "claude-3-5-haiku-latest",
  // Gemini — the 2.5/1.5 tail removed by the S3 Gemini 3.5-only train.
  "gemini-2.5-flash-lite",
  "gemini-1.5-pro",
]);

function allDeclaredModelIds(): string[] {
  const ids = new Set<string>();
  for (const provider of LLM_PROVIDERS) {
    for (const id of ALLOWED_MODEL_IDS[provider]) ids.add(id);
  }
  return [...ids];
}

describe("llm model-catalog ↔ pricing coupling (#1712 AC7)", () => {
  it("every declared model id has a hardcoded pricing row OR is a documented DB-priced model", () => {
    const uncovered = allDeclaredModelIds().filter(
      (id) => LLM_PRICING[id] === undefined && !KNOWN_DB_PRICED_MODELS.has(id),
    );
    // A failure here means a NEW routable model reached the catalog without a
    // pricing row and without an explicit DB-priced acknowledgement — it would
    // silently record NULL cost_usd. Add a hardcoded LLM_PRICING row, or (if it
    // is DB-priced via LiteLLM sync) add it to KNOWN_DB_PRICED_MODELS.
    expect(uncovered).toEqual([]);
  });

  it("the DB-priced allowlist cannot rot — every entry is still declared and still un-hardcoded", () => {
    const declared = new Set(allDeclaredModelIds());
    const stale: string[] = [];
    for (const id of KNOWN_DB_PRICED_MODELS) {
      // (a) removed from the catalog → drop the entry.
      if (!declared.has(id)) stale.push(`${id} (no longer a declared model)`);
      // (b) a hardcoded fallback was added → drop the entry so the coupling is
      //     enforced strictly for it going forward.
      if (LLM_PRICING[id] !== undefined) {
        stale.push(`${id} (now has a hardcoded LLM_PRICING row — remove it here)`);
      }
    }
    expect(stale).toEqual([]);
  });

  it("every declared provider default is itself a declared, routable model id", () => {
    // Guards the schema refinement at the coupling layer too: a default that
    // dropped out of its allowlist would route an unpriced/unknown model.
    for (const provider of LLM_PROVIDERS) {
      const declaration = BUILD_KNOWN_LLM_PROVIDER_DECLARATIONS[provider];
      const allowed = ALLOWED_MODEL_IDS[provider];
      expect(allowed.length).toBeGreaterThan(0);
      // The default MUST be a member of its own allowlist — a drift would route
      // a model the catalog does not declare (and pricing does not cover).
      expect(allowed).toContain(declaration.models.default);
    }
  });
});
