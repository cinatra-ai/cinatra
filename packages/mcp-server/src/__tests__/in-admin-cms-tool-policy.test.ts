import { describe, it, expect } from "vitest";
import {
  IN_ADMIN_CMS_MCP_ALLOWED_TOOLS,
  isInAdminCmsMcpToolAllowed,
  resolveAgentRunCinatraMcpAllowedTools,
} from "../in-admin-cms-tool-policy";
import { isCoreDelegatedChatAdmitted } from "../core-delegated-chat-surface";
import { isDelegatedWidgetMcpToolAllowed } from "../delegated-widget-tool-policy";

// #1214 boundary gap: the in-admin CMS content-editor agents must reach the CMS
// ONLY via the MCP integration. This policy pins their cinatra self-MCP access
// to the MCP-backed primitives. A false-allow re-opens the direct-REST reach
// (the exact violation #1214 closes); a false-deny breaks the ratified in-admin
// edit path. Pin both directions + fail-closed on unknowns.

describe("in-admin CMS tool policy — allowlist membership", () => {
  it("allows exactly the MCP-backed CMS primitives each content-editor agent uses", () => {
    // WordPress: the generic, governed connector-instance invoker primitives
    // (cinatra-ai/cinatra#2022 S7 deleted the old named per-operation tools —
    // wordpress_post_get/wordpress_post_update no longer exist in any form).
    // The WordPress site tool proxy is split in two (cinatra#3745): the
    // content editor reads through wordpress_site_tool_call and writes
    // through wordpress_site_tool_write, which declares outward.
    // Drupal: drupal-agent's full tool set, all via drupal/mcp_tools.
    const expected = [
      "wordpress_site_tool_call",
      "wordpress_site_tool_write",
      "wordpress_site_tools_list",
      "drupal_node_get",
      "drupal_node_create_draft_revision",
      "drupal_node_update",
      "drupal_node_publish",
    ];
    expect([...IN_ADMIN_CMS_MCP_ALLOWED_TOOLS].sort()).toEqual(
      [...expected].sort(),
    );
    for (const name of expected) {
      expect(isInAdminCmsMcpToolAllowed(name)).toBe(true);
    }
  });

  it("DENIES the deleted named WordPress tools (cinatra-ai/cinatra#2022 S7 — they no longer exist in any form)", () => {
    for (const name of [
      "wordpress_post_get",
      "wordpress_post_update",
      "wordpress_post_status",
      "wordpress_posts_list",
      "wordpress_pages_list",
      "wordpress_post_get_latest",
      "wordpress_post_delete",
      "wordpress_media_upload",
      "wordpress_post_create_draft",
      "wordpress_post_update_meta",
      "wordpress_status",
      "wordpress_instances_list",
    ]) {
      expect(isInAdminCmsMcpToolAllowed(name)).toBe(false);
    }
  });

  it("fails closed on unknown / new / unrelated tools (deny-by-default)", () => {
    for (const name of [
      "agent_run",
      "objects_list",
      "permissions_grant",
      "wordpress_site_tool_call_v2",
      "wordpress_site_tool_write_v2",
      "drupal_node_delete",
      "",
      "WORDPRESS_SITE_TOOL_CALL", // case-sensitive: not the registered tool name
    ]) {
      expect(isInAdminCmsMcpToolAllowed(name)).toBe(false);
    }
  });
});

// NOTE: WHICH agent packages are in-admin CMS content editors is resolved by
// the HOST from the generated `relayAgentPackage` bindings (core→extension
// instance-coupling ban — this policy module names no extension). That
// predicate + its data-driven binding are covered by
// src/lib/__tests__/widget-stream-agents-content-editor.test.ts. Here the
// resolver takes the already-decided boolean.
describe("resolveAgentRunCinatraMcpAllowedTools", () => {
  it("returns the explicit allowlist for a content-editor run, null otherwise", () => {
    expect(resolveAgentRunCinatraMcpAllowedTools(true)).toEqual([
      ...IN_ADMIN_CMS_MCP_ALLOWED_TOOLS,
    ]);
    // Unrestricted (unchanged) for every other agent run.
    expect(resolveAgentRunCinatraMcpAllowedTools(false)).toBeNull();
  });

  it("returns a fresh mutable copy each call (no shared-array aliasing)", () => {
    const a = resolveAgentRunCinatraMcpAllowedTools(true);
    const b = resolveAgentRunCinatraMcpAllowedTools(true);
    expect(a).not.toBe(b);
    a!.push("mutated");
    expect(resolveAgentRunCinatraMcpAllowedTools(true)).not.toContain("mutated");
  });
});

// cinatra#3745: the connector splits the proxy, and every ability other than a
// read moves to `wordpress_site_tool_write`. "write" is a denied verb token on
// the chat perimeter and the host declares no chat class for it, so the write
// tool stays off chat and off the widget perimeter. It reaches the in-admin
// content editor's agent run only, where its outward declaration holds it.
const WRITE = "wordpress_site_tool_write";

describe("the write tool of the split proxy stays off every delegated perimeter (cinatra#3745)", () => {
  it("delegated-chat perimeter denies it", () => {
    expect(isCoreDelegatedChatAdmitted(WRITE)).toBe(false);
  });

  it("delegated-widget perimeter (both kinds) denies it", () => {
    for (const kind of ["wordpress", "drupal"] as const) {
      expect(isDelegatedWidgetMcpToolAllowed(kind, WRITE), kind).toBe(false);
    }
  });
});
