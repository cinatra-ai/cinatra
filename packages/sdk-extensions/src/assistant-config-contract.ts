// The `assistant_config` sidecar SHAPE — the single source of truth for the
// typed assistant sidecar (persona, skill bundle, allowed tools/agents, model
// prefs, MCP target policy).
//
// RELOCATED here from the app's `src/lib/assistant-config.ts` (cinatra#1874,
// Epic #1873 W1) so the SHARED assistant-declaration parser in this package can
// validate its projection against the SAME schema the app writes with. The app
// re-exports these symbols from `@/lib/assistant-config`, so every existing
// importer keeps working unchanged and there is exactly ONE schema definition
// (no drift between the package parser and the app store validator).
//
// Pure, framework-free, zod-only (the same optional peerDependency precedent as
// `access-config.ts` / `objects-contract.ts`) — importable from server code,
// the store layer, this package's parser, and unit tests alike.

import { z } from "zod";

/** Model routing preferences for an assistant run. All optional — an absent
 *  field defers to the platform default resolution (provider gating,
 *  DB/Nango-sourced keys). Not a secret carrier. */
export const modelPrefsSchema = z.object({
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  temperature: z.number().min(0).max(2).optional(),
});
export type ModelPrefs = z.infer<typeof modelPrefsSchema>;

/**
 * Assistant-level MCP target policy (cinatra#1037 P5.5) — whether and to whom
 * this assistant is ADDRESSABLE as a target of the generalized assistant MCP
 * surface (`assistant_send`). Evaluated INPUT-TIME by `authorizeAssistantMcpTurn`
 * (src/lib/assistant-mcp.ts) — it does not gate the assistant's own outbound
 * tool use, only who may open a turn WITH it over MCP.
 *
 *   enabled      — false removes the assistant from the MCP surface entirely
 *                  (a send 404-hides, indistinguishable from an unknown handle).
 *   restriction  — "org-members" (default): any transport-authenticated member
 *                  of an organization may target it; "platform-admins": only
 *                  platform admins may.
 *
 * OPTIONAL on the sidecar: an absent block means the platform default
 * (enabled, org-members) so every persisted pre-P5.5 config keeps its meaning
 * and byte shape unchanged.
 */
export const assistantMcpPolicySchema = z.object({
  enabled: z.boolean().default(true),
  restriction: z.enum(["org-members", "platform-admins"]).default("org-members"),
});
export type AssistantMcpPolicy = z.infer<typeof assistantMcpPolicySchema>;

/** The platform-default target policy applied when a sidecar carries no `mcp`
 *  block (and by the built-in Cinatra reference config). */
export const DEFAULT_ASSISTANT_MCP_POLICY: AssistantMcpPolicy = {
  enabled: true,
  restriction: "org-members",
};

/** Resolve the effective MCP target policy from a parsed sidecar. Pure. */
export function resolveAssistantMcpPolicy(config: Pick<AssistantConfig, "mcp">): AssistantMcpPolicy {
  return config.mcp ?? DEFAULT_ASSISTANT_MCP_POLICY;
}

/**
 * The typed assistant sidecar. Unknown keys are stripped (zod default) so the
 * shape can grow forward-compatibly. `persona` and `skillBundle` are the two
 * required load-bearing fields — an assistant is defined by its identity
 * (persona) and the skills it always loads (the Cinatra assistant references
 * the `chat-assistant-core` bundle). Allow-lists default to empty, which the
 * runtime reads as "no explicit restriction beyond platform policy".
 */
export const assistantConfigSchema = z.object({
  /** System persona / conversational identity of the assistant. */
  persona: z.string().min(1),
  /** Skill slugs the assistant always mounts (its reference skill bundle). */
  skillBundle: z.array(z.string().min(1)),
  /** Tool ids/labels this assistant may call. Empty = platform-policy only. */
  allowedTools: z.array(z.string().min(1)).default([]),
  /** Agent package names this assistant may dispatch to. Empty = policy only. */
  allowedAgents: z.array(z.string().min(1)).default([]),
  /** Model routing preferences. */
  modelPrefs: modelPrefsSchema.default({}),
  /** MCP target policy (cinatra#1037 P5.5). OPTIONAL — absent = the platform
   *  default (enabled, org-members); see {@link assistantMcpPolicySchema}. */
  mcp: assistantMcpPolicySchema.optional(),
});
export type AssistantConfig = z.infer<typeof assistantConfigSchema>;
