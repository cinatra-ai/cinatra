import "server-only";

/**
 * Single source of truth for LLM provider / model / capability rules referenced
 * by the OAS validator, OAS compiler, and the `/api/llm-bridge` route.
 *
 * Imported by:
 *   - packages/agents/src/validate-agent-json.ts  — rejects mismatches in
 *     `metadata.cinatra.llm`.
 *   - packages/agents/src/oas-compiler.ts          — wires the same Zod schema
 *     into the canonical Flow metadata.cinatra block.
 *   - src/app/api/llm-bridge/route.ts              — selects the provider/model
 *     when fulfilling a bridge call.
 *
 * Do NOT import from `@cinatra-ai/llm` here — the orchestration
 * package depends on `@cinatra-ai/agents`, so the reverse direction would create
 * a circular dependency (cf. agents → orchestration is forbidden per the
 * package layering rule).
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Provider + capability enums (the closed sets that the platform supports
// today). Anything outside these enums is rejected at validate-time with a
// stable OAS-LLM-001 finding.
// ---------------------------------------------------------------------------

export const LLM_PROVIDERS = ["openai", "anthropic", "gemini"] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export const LLM_CAPABILITIES = ["media_input", "function_tools", "native_mcp"] as const;
export type LlmCapability = (typeof LLM_CAPABILITIES)[number];

// ---------------------------------------------------------------------------
// Per-provider model allowlist. The first entry in each list is the adapter
// default (see provider files referenced in the JSDoc below). Every id here
// MUST be routable by the matching provider's adapter.generate path — do not
// add ids speculatively; they will surface at compile time only.
//
// Defaults pulled from each provider adapter file:
//   packages/llm/src/providers/openai.ts:32      → "gpt-5"
//   packages/llm/src/providers/anthropic.ts:42   → "claude-sonnet-4-6"
//   packages/llm/src/providers/gemini.ts:21      → "gemini-2.5-flash"
// ---------------------------------------------------------------------------

export const ALLOWED_MODEL_IDS: Record<LlmProvider, readonly string[]> = {
  openai: [
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5",
    "gpt-5-mini",
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4o",
    "gpt-4o-mini",
  ] as const,
  anthropic: [
    "claude-sonnet-4-6",
    "claude-opus-4-7",
    "claude-3-7-sonnet-latest",
    "claude-3-5-haiku-latest",
  ] as const,
  gemini: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite", "gemini-1.5-pro"] as const,
};

// ---------------------------------------------------------------------------
// Default OpenAI model for a connection without a saved `defaultModel`. Shared
// by every default source — the /setup/ai and /configuration/llm default-model
// pickers plus src/lib/openai-connection-store.ts — so the fallbacks cannot
// drift apart. A saved, still-selectable `connection.defaultModel` always wins
// over this fallback. MUST stay a member of ALLOWED_MODEL_IDS.openai above.
// ---------------------------------------------------------------------------

export const DEFAULT_OPENAI_MODEL_ID = "gpt-5.5";

// ---------------------------------------------------------------------------
// Reusable Zod schema for the optional `metadata.cinatra.llm` block. The same
// schema is shared by validate-agent-json.ts and the canonical Flow
// `metadataSchema` so the two layers cannot drift.
//
// The schema itself only enforces shape (unknown provider / unknown
// capability / `.strict()` unknown-key rejection). Cross-field rules
// (preferredModel ∈ ALLOWED_MODEL_IDS[preferredProvider], media_input only on
// gemini) are enforced by the validator post-parse using ALLOWED_MODEL_IDS
// directly.
// ---------------------------------------------------------------------------

export const OasCinatraLlmSchema = z
  .object({
    preferredProvider: z.enum(LLM_PROVIDERS).optional(),
    preferredModel: z.string().min(1).optional(),
    capabilityRequired: z.enum(LLM_CAPABILITIES).optional(),
  })
  .strict()
  .optional();

export type OasCinatraLlm = z.infer<typeof OasCinatraLlmSchema>;
