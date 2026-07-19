// The WordPress + Drupal assistant configs (cinatra#1823, epic #1037 P4.1) are
// VALID assistant sidecars, DISTINCT from @cinatra's, and build CMS-specific
// runtimes (a CMS-authoring system skill + CMS persona — NOT the
// chat-assistant-core bundle).

import { describe, expect, it } from "vitest";
import { assistantConfigSchema } from "@/lib/assistant-config";
import { cinatraAssistantConfig } from "../cinatra-assistant-config";
import {
  wordpressAssistantConfig,
  buildWordpressAssistantRuntimeConfig,
  WORDPRESS_ASSISTANT_SKILL_BUNDLE,
  drupalAssistantConfig,
  buildDrupalAssistantRuntimeConfig,
  DRUPAL_ASSISTANT_SKILL_BUNDLE,
} from "../cms-assistant-config";

describe("CMS assistant configs — validity + distinctness (cinatra#1823)", () => {
  it("both parse against the P1 assistant_config schema", () => {
    expect(assistantConfigSchema.safeParse(wordpressAssistantConfig).success).toBe(true);
    expect(assistantConfigSchema.safeParse(drupalAssistantConfig).success).toBe(true);
  });

  it("neither reuses cinatraAssistantConfig verbatim (persona AND skillBundle differ)", () => {
    for (const cfg of [wordpressAssistantConfig, drupalAssistantConfig]) {
      expect(cfg).not.toEqual(cinatraAssistantConfig);
      expect(cfg.persona).not.toBe(cinatraAssistantConfig.persona);
      expect(cfg.skillBundle).not.toEqual(cinatraAssistantConfig.skillBundle);
      // The CMS bundles are the authoring skills, NOT the chat-assistant-core bundle.
      expect(cfg.skillBundle[0]).not.toBe("chat-assistant-core");
    }
    // WordPress and Drupal are themselves distinct from each other.
    expect(wordpressAssistantConfig).not.toEqual(drupalAssistantConfig);
    expect(wordpressAssistantConfig.persona).not.toBe(drupalAssistantConfig.persona);
  });

  it("each builds a runtime whose system skill is the CMS authoring core + persona is the CMS persona", () => {
    const wp = buildWordpressAssistantRuntimeConfig();
    expect(wp.systemSkillId).toContain(WORDPRESS_ASSISTANT_SKILL_BUNDLE[0]);
    expect(wp.systemSkillId).not.toContain("chat-assistant-core");
    expect(wp.fallbackPersona).toBe(wordpressAssistantConfig.persona);

    const dr = buildDrupalAssistantRuntimeConfig();
    expect(dr.systemSkillId).toContain(DRUPAL_ASSISTANT_SKILL_BUNDLE[0]);
    expect(dr.systemSkillId).not.toContain("chat-assistant-core");
    expect(dr.fallbackPersona).toBe(drupalAssistantConfig.persona);
  });
});
