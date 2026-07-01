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
// Capability matrix — THE single source of truth for "which provider(s) can
// satisfy which capability". Previously this lived inline in
// `src/app/api/llm-bridge/_llm-dispatch.ts`; it now lives here (the declared
// SoT) so the bridge dispatch resolver, the agent-run preflight, and any
// install-time capability check all consult ONE matrix and cannot drift.
//
// Kept PURE (provider + capability enums only). MUST NOT import
// `@cinatra-ai/llm` or any connector package — that would invert the package
// layering (orchestration → agents) and create a circular dependency.
//
//   - media_input    → gemini only (Gemini is the only adapter with a media
//                       ingestion path; see packages/llm/src/providers/gemini.ts).
//   - function_tools  → broad: every adapter has a non-null tools translator
//                       (Gemini emits FunctionDeclaration[] via translateTools()).
//   - native_mcp      → openai | anthropic. Provider-native MCP server tool;
//                       Gemini is excluded per the MCP Injection Rule
//                       (function-tool emulation does NOT qualify).
// ---------------------------------------------------------------------------

export function canProviderSatisfyCapability(
  provider: LlmProvider,
  capability: LlmCapability,
): boolean {
  switch (capability) {
    case "media_input":
      return provider === "gemini";
    case "function_tools":
      return provider === "openai" || provider === "anthropic" || provider === "gemini";
    case "native_mcp":
      return provider === "openai" || provider === "anthropic";
    default:
      // Defense-in-depth — the Zod schema rejects unknown capability values
      // before we get here. Keep an explicit `false` so any future enum
      // expansion fails closed.
      return false;
  }
}

/**
 * All providers that can satisfy `capability`, in `LLM_PROVIDERS` order.
 * The inverse view of `canProviderSatisfyCapability`, used by the run-time
 * preflight and the bridge's actionable error to enumerate the connectors a
 * user could install/configure to unblock a capability.
 */
export function providersForCapability(capability: LlmCapability): LlmProvider[] {
  return LLM_PROVIDERS.filter((p) => canProviderSatisfyCapability(p, capability));
}

// ---------------------------------------------------------------------------
// Build a human-readable, actionable sentence naming the capability and the
// PROVIDER(s) that can satisfy it. Deliberately names the generic provider id
// (a member of the LLM_PROVIDERS capability vocabulary), NOT a specific
// connector package — core must not hardcode an extension-instance name
// (true-IoC: capabilities come from the manifest/registry, enforced by the
// core→extension instance-coupling gate; pinning a connector package here
// would both fail that gate and re-introduce the topology coupling this issue
// is removing). Shared by the bridge 503 message and any future run-time
// preflight so the wording cannot drift between surfaces.
//
// Two phrasings, matching the two ways a capability goes unsatisfied:
//   - `incompatibleProvider` set (the preferred provider IS available but
//     cannot satisfy the capability) → name the mismatch and the alternatives.
//   - otherwise (no installed+configured provider satisfies the capability)
//     → tell the user to install/configure a connector for one of the
//       satisfying providers.
//
// Example:
//   describeCapabilityRequirement("media_input")
//   → 'This agent requires the "media_input" LLM capability, but no installed
//      and configured LLM provider supports it. Install and configure an LLM
//      connector for one of these providers: gemini.'
// ---------------------------------------------------------------------------

export function describeCapabilityRequirement(
  capability: LlmCapability,
  opts?: { incompatibleProvider?: LlmProvider },
): string {
  const providers = providersForCapability(capability);
  const options = providers.join(", ");
  if (opts?.incompatibleProvider) {
    return (
      `This agent requires the "${capability}" LLM capability, but the active ` +
      `provider "${opts.incompatibleProvider}" cannot satisfy it. Install and ` +
      `configure an LLM connector for one of these providers instead: ${options}.`
    );
  }
  return (
    `This agent requires the "${capability}" LLM capability, but no installed ` +
    `and configured LLM provider supports it. Install and configure an LLM ` +
    `connector for one of these providers: ${options}.`
  );
}

// ---------------------------------------------------------------------------
// Per-provider model allowlist. The first entry in each list is the adapter
// default (see provider files referenced in the JSDoc below). Every id here
// MUST be routable by the matching provider's adapter.generate path — do not
// add ids speculatively; they will surface at compile time only.
//
// Defaults pulled from each provider adapter file:
//   packages/llm/src/providers/openai.ts (DEFAULT_MODEL)  → "gpt-5.5"
//     (kept in lock-step with DEFAULT_OPENAI_MODEL_ID below; the adapter
//      duplicates the literal because @cinatra-ai/llm cannot import this
//      package without a circular dependency).
//   packages/llm/src/providers/anthropic.ts (DEFAULT_MODEL) → "claude-sonnet-4-6"
//   packages/llm/src/providers/gemini.ts (DEFAULT_MODEL)    → "gemini-2.5-flash"
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
