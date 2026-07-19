import { describe, it, expect } from "vitest";

import {
  resolveAssistantWidgetBinding,
  listAssistantWidgetBindings,
} from "@/lib/assistant-widget-handles";
import { GENERATED_WIDGET_STREAM_AGENTS } from "@/lib/generated/extensions.server";

// OQ2 (S5 design §7) — the CLOSED handle↔widget-stream binding table must be a
// fixed literal and must AGREE with the generated cinatra.widgetStream
// declarations (a drift would let the route consume tokens against the wrong
// agentSlug / instancesConfigKey).

describe("assistant-widget-handles — the OQ2 closed table", () => {
  it("resolves only the two public-site widget handles", () => {
    expect(resolveAssistantWidgetBinding("wordpress")?.agentSlug).toBe("wordpress-content-editor");
    expect(resolveAssistantWidgetBinding("drupal")?.agentSlug).toBe("drupal-content-editor");
  });

  it("fails CLOSED for the built-in cinatra handle and any unknown/forged value", () => {
    expect(resolveAssistantWidgetBinding("cinatra")).toBeNull();
    expect(resolveAssistantWidgetBinding("")).toBeNull();
    expect(resolveAssistantWidgetBinding("wordpress-content-editor")).toBeNull();
    expect(resolveAssistantWidgetBinding("WORDPRESS")).toBeNull(); // case-exact
  });

  it("every binding's agentSlug + instancesConfigKey match the generated widgetStream declaration", () => {
    for (const binding of listAssistantWidgetBindings()) {
      const generated = (GENERATED_WIDGET_STREAM_AGENTS as Record<string, { auth: { instancesConfigKey: string } }>)[
        binding.agentSlug
      ];
      expect(generated, `missing generated agent ${binding.agentSlug}`).toBeTruthy();
      expect(generated.auth.instancesConfigKey).toBe(binding.instancesConfigKey);
      // The handle IS the instances-config key IS the connector kind for these.
      expect(binding.handle).toBe(binding.instancesConfigKey);
    }
  });
});
