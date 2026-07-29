// The Cinatra assistant's reference `assistant_config` (cinatra-ai/cinatra#1037
// P2a). This is the FIRST assistant instance and the runtime-parity reference:
// the extracted `runAssistantTurn`, given the runtime config built here, must
// behave byte-for-byte like the pre-extraction `runChatTurn` on every covered
// path (see cinatra-parity.test.ts).
//
// The sidecar values below are exactly the former hardcoded runner constants,
// re-expressed as an `AssistantConfig` (validated against the P1 schema):
//   - skillBundle       == the former CHAT_SKILL_SLUGS (order preserved;
//                          chat-assistant-core is skillBundle[0] → the system skill)
//   - persona           == the former inline 3-line system-prompt fallback
//   - allowedTools/Agents== [] (no restriction beyond platform policy — parity)
//   - modelPrefs        == {} (platform default adapter resolution — parity)
//
// The chat-assistant-core bundle stays the Cinatra assistant's reference
// `assistant_config` per the epic (#1037). When P1's "register Cinatra as the
// first assistant agent" bootstrap persists a real `agent_templates` row, this
// object is the config it seeds; until then it is the runtime's in-code default.

import { assistantConfigSchema, type AssistantConfig } from "@/lib/assistant-config";
import {
  buildAssistantRuntimeConfig,
  type AssistantRuntimeConfig,
} from "./ports";

// The chat guidance is delivered as five consolidated router bundles (the
// assistant-skills S3 fold, cinatra#2090): each slug below is the single
// router SKILL.md of one successor `kind:"skill"` extension, and the absorbed
// sub-skill bodies ride as `references/*.md` beside the router, read on demand
// via the shell tool (one hop). The core skill (`chat-assistant-core`, first)
// is the always-loaded system prompt. Order is load-bearing: skillBundle[0]
// is the system skill. This IS the former `CHAT_SKILL_SLUGS`.
//
// SIZE CONTRACT (#2188 merge-safety): keep this bundle at 5 slugs — at most 7.
// The typed injection contract caps the resolved set at 8 INCLUDING the
// personal delta, so 5 + delta = 6 ≤ 8 never truncates; a bundle larger than
// 7 would let the cap silently drop assistant skills again. Pinned by
// cinatra-assistant-config.test.ts.
export const CINATRA_ASSISTANT_SKILL_BUNDLE = [
  "chat-assistant-core",
  "chat-extension-authoring",
  "chat-automation-authoring",
  "company-research",
  "blog-content",
] as const;

// The Cinatra assistant's persona / conversational identity. Byte-identical to
// the former inline fallback in `loadSystemPrompt` — used only when the
// `chat-assistant-core` SKILL.md body is unresolvable from both the catalog and
// disk. The normal path still loads the live skill body verbatim.
export const CINATRA_ASSISTANT_PERSONA = [
  "You are the Cinatra AI assistant.",
  "You help users orchestrate agents, workflows, data, and content across an open source enterprise intelligence platform.",
  "Be concise. Lead with answers. Use tables for data. Never repeat what the user said.",
].join("\n");

// The skill-id namespace for the Cinatra chat sub-skills (an auth-policy
// boundary). Was the literal `@cinatra-ai/chat:` prefix in the runner.
export const CINATRA_ASSISTANT_SKILL_NAMESPACE = "@cinatra-ai/chat";

/**
 * The Cinatra assistant's validated sidecar. Parsed through the P1 schema so it
 * can never drift from the persisted contract (applies the same defaults a
 * stored row would get). Freezing it through the schema also asserts, at module
 * load, that the reference config is a VALID assistant sidecar.
 */
export const cinatraAssistantConfig: AssistantConfig = assistantConfigSchema.parse({
  persona: CINATRA_ASSISTANT_PERSONA,
  skillBundle: [...CINATRA_ASSISTANT_SKILL_BUNDLE],
  allowedTools: [],
  allowedAgents: [],
  modelPrefs: {},
});

/**
 * The runtime config the extracted runtime consumes for the Cinatra assistant —
 * the parity reference. `maxToolRounds: 24` and the `@cinatra-ai/chat` namespace
 * reproduce the former `MAX_TOOL_ROUNDS` / `CHAT_SKILL_IDS` / `CHAT_SYSTEM_SKILL_ID`
 * constants exactly.
 */
export function buildCinatraAssistantRuntimeConfig(): AssistantRuntimeConfig {
  return buildAssistantRuntimeConfig(cinatraAssistantConfig, {
    skillIdNamespace: CINATRA_ASSISTANT_SKILL_NAMESPACE,
    maxToolRounds: 24,
  });
}
