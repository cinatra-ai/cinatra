// The Drupal assistant's validated `assistant_config` (cinatra-ai/cinatra#1823,
// epic #1037 P4.1 — CMS assistant agents).
//
// A sibling of the Cinatra reference config (`cinatra-assistant-config.ts`), this
// is a THIRD, DISTINCT built-in assistant instance: it carries its OWN persona
// and its OWN CMS-authoring skill bundle — it deliberately does NOT reuse
// `cinatraAssistantConfig` (the chat-assistant-core bundle). The registration
// bootstrap seeds it through the ONE principal-minting path (I3,
// `registerAssistantAgent`) exactly like @cinatra, and the generalized assistant
// runtime resolves this config from the persisted `assistant_config` sidecar via
// the principal's `assistant_user_id` link — never the hardcoded Cinatra
// fallback.
//
// The sidecar shape is validated against the P1 schema at module load, so it can
// never drift from the persisted contract (and a re-run of the boot registration
// converges on the same persisted config).

import { assistantConfigSchema, type AssistantConfig } from "@/lib/assistant-config";
import {
  buildAssistantRuntimeConfig,
  type AssistantRuntimeConfig,
} from "./ports";

// The Drupal authoring skill bundle. skillBundle[0] is by contract the
// always-loaded system skill — a Drupal-specific authoring core, NOT
// `chat-assistant-core`. The remaining slugs are the concern-specific authoring
// sub-skills mounted on demand. Order is load-bearing (skillBundle[0] supplies
// the system prompt; when its body is unresolvable the runtime falls back to the
// persona below).
export const DRUPAL_ASSISTANT_SKILL_BUNDLE = [
  "drupal-authoring-core",
  "drupal-node-authoring",
  "drupal-taxonomy-and-media",
  "blog-content",
  "chat-create-artifact",
  "chat-run-polling",
] as const;

// The Drupal assistant's persona / conversational identity — distinct from
// @cinatra's. Used as the system prompt whenever the `drupal-authoring-core`
// SKILL.md body is unresolvable from both the catalog and disk.
export const DRUPAL_ASSISTANT_PERSONA = [
  "You are the Cinatra Drupal authoring assistant.",
  "You help users draft, structure, and publish Drupal content — nodes, content types, fields, taxonomy terms, and media — against their connected Drupal site.",
  "Prefer the Drupal authoring skills and the site's own content model. Be concise. Lead with the draft or the action. Never repeat what the user said.",
].join("\n");

/**
 * The Drupal assistant's validated sidecar. Parsed through the P1 schema so it
 * can never drift from the persisted contract, and asserts at module load that
 * the config is a VALID assistant sidecar. Distinct from `cinatraAssistantConfig`
 * (different persona AND different skillBundle).
 */
export const drupalAssistantConfig: AssistantConfig = assistantConfigSchema.parse({
  persona: DRUPAL_ASSISTANT_PERSONA,
  skillBundle: [...DRUPAL_ASSISTANT_SKILL_BUNDLE],
  allowedTools: [],
  allowedAgents: [],
  modelPrefs: {},
});

/**
 * The runtime config the generalized assistant runtime consumes for the Drupal
 * assistant. Built from the same sidecar the registration persists, so the
 * in-code build and the persisted-config resolution (via `assistant_user_id`)
 * agree.
 */
export function buildDrupalAssistantRuntimeConfig(): AssistantRuntimeConfig {
  return buildAssistantRuntimeConfig(drupalAssistantConfig);
}
