import { describe, it, expect, vi } from "vitest";

// #1214 — the in-admin CMS content-editor agent set is DATA-DRIVEN from the
// generated `relayAgentPackage` bindings (core→extension instance-coupling
// ban: no extension package is named in host code). This proves the predicate
// resolves membership purely from the generated map: an in-admin CMS content
// editor IS the relay target of an in-admin content-editor widget; a
// widget-stream entry with NO relayAgentPackage contributes nothing.
vi.mock("@/lib/generated/extensions.server", () => ({
  GENERATED_WIDGET_STREAM_AGENTS: {
    "wordpress-content-editor": {
      load: async () => ({}),
      packageName: "@cinatra-ai/wordpress-mcp-connector",
      factory: "createWordPressWidgetChatTool",
      label: "WordPress",
      subjectNoun: "post",
      skillCapability: "widget-chat.wordpress-content-editor",
      relayAgentPackage: "@cinatra-ai/wordpress-agent",
      contextFields: [],
      auth: {},
    },
    "drupal-content-editor": {
      load: async () => ({}),
      packageName: "@cinatra-ai/drupal-mcp-connector",
      factory: "createDrupalWidgetChatTool",
      label: "Drupal",
      subjectNoun: "node",
      skillCapability: "widget-chat.drupal-content-editor",
      relayAgentPackage: "@cinatra-ai/drupal-agent",
      contextFields: [],
      auth: {},
    },
    // A widget-stream entry WITHOUT a relayAgentPackage — the host runs the
    // LLM itself (no relay agent), so it contributes no content-editor package.
    "acme-widget": {
      load: async () => ({}),
      packageName: "@cinatra-ai/acme-connector",
      factory: "createAcmeWidgetChatTool",
      label: "Acme",
      subjectNoun: "thing",
      skillCapability: "widget-chat.acme-widget",
      contextFields: [],
      auth: {},
    },
  },
}));

import {
  inAdminCmsContentEditorAgentPackages,
  isInAdminCmsContentEditorPackage,
} from "@/lib/widget-stream-agents.server";

describe("in-admin CMS content-editor package resolution (#1214)", () => {
  it("derives the content-editor set from the generated relayAgentPackage bindings", () => {
    const set = inAdminCmsContentEditorAgentPackages();
    expect([...set].sort()).toEqual([
      "@cinatra-ai/drupal-agent",
      "@cinatra-ai/wordpress-agent",
    ]);
    // The relay-less widget-stream entry contributes no content-editor package.
    expect(set.has("@cinatra-ai/acme-connector")).toBe(false);
  });

  it("recognises the relay-target agent packages as content editors", () => {
    expect(isInAdminCmsContentEditorPackage("@cinatra-ai/wordpress-agent")).toBe(
      true,
    );
    expect(isInAdminCmsContentEditorPackage("@cinatra-ai/drupal-agent")).toBe(
      true,
    );
  });

  it("fails closed for any other / absent / malformed package", () => {
    for (const pkg of [
      "@cinatra-ai/apollo-prospecting-agent",
      "@cinatra-ai/wordpress-mcp-connector", // the connector, not the relay agent
      "@cinatra-ai/acme-connector", // relay-less widget's connector
      "wordpress-agent", // unscoped — not the real package name
      "",
      null,
      undefined,
    ]) {
      expect(isInAdminCmsContentEditorPackage(pkg)).toBe(false);
    }
  });
});
