import { describe, it, expect } from "vitest";
import {
  IN_ADMIN_CMS_MCP_ALLOWED_TOOLS,
  isInAdminCmsMcpToolAllowed,
  resolveAgentRunCinatraMcpAllowedTools,
} from "../in-admin-cms-tool-policy";

// #1214 boundary gap: the in-admin CMS content-editor agents must reach the CMS
// ONLY via the MCP integration. This policy pins their cinatra self-MCP access
// to the MCP-backed primitives. A false-allow re-opens the direct-REST reach
// (the exact violation #1214 closes); a false-deny breaks the ratified in-admin
// edit path. Pin both directions + fail-closed on unknowns.

describe("in-admin CMS tool policy — allowlist membership", () => {
  it("allows exactly the MCP-backed CMS primitives the SKILL.md uses", () => {
    // WordPress: wordpress-agent SKILL.md STEP 1/2 (the only two it calls;
    // every other WP primitive is a NEVER rule there), rerouted onto the plugin
    // MCP content server. Drupal: drupal-agent SKILL.md full tool set, all via
    // drupal/mcp_tools.
    const expected = [
      "wordpress_post_get",
      "wordpress_post_update",
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

  it("DENIES the neighbouring WordPress primitives that remain direct-REST-backed", () => {
    // The residual #1214 violation surface — still egress via direct REST, so
    // the in-admin assistant must not be able to reach them until they are
    // rerouted onto plugin MCP abilities (the follow-up issue).
    for (const name of [
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
      "wordpress_post_get_v2",
      "drupal_node_delete",
      "",
      "WORDPRESS_POST_GET", // case-sensitive: not the registered tool name
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
