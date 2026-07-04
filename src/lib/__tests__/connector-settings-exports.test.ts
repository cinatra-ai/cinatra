// The legacy /configuration/llm surfaces resolve connector settings COMPONENTS
// through the generated settings-page loader map and pick named exports off the
// loaded module. This locks that export-name contract: if a connector renames
// the export (or drops its settings page), this fires at test time instead of
// a runtime blank modal.

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getConnectorSettingsPageLoader } from "@/lib/connector-setup-pages";

// apollo-connector (ApolloSettingsPage) and anthropic-connector
// (AnthropicSettingsContent) left this list at 0.1.4: both converted to the
// schema-config DSL and retired their React settings pages (no generated
// settings loader remains — the host renders from configSchema).
const CONSUMED_SETTINGS_EXPORTS: Array<[slug: string, exportName: string]> = [
  ["youtube-connector", "YouTubeSettingsPage"],
  ["linkedin-connector", "LinkedInSettingsPage"],
];

describe("generated settings-page loaders expose the exports the host consumes", () => {
  for (const [slug, exportName] of CONSUMED_SETTINGS_EXPORTS) {
    it(`${slug} settings module exports ${exportName}`, async () => {
      const loader = getConnectorSettingsPageLoader(slug);
      expect(loader, `generated settings loader for ${slug}`).toBeTypeOf("function");
      const mod = (await loader!()) as Record<string, unknown>;
      expect(typeof mod[exportName], `${slug} export ${exportName}`).toBe("function");
    });
  }
});
