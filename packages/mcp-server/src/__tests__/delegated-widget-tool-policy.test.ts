import { describe, expect, it } from "vitest";
import { isDelegatedWidgetMcpToolAllowed } from "../delegated-widget-tool-policy";

// S5-W1 §4.1 / §5 — the CLOSED, KIND-KEYED `public_site_widget` tool policy.
// Covers the T3 (blast radius) and T4 (kind binding / G9) negative contract.

describe("isDelegatedWidgetMcpToolAllowed — delegated-widget closed policy", () => {
  it("allows ONLY the bound kind's *_content_editor_run (positive)", () => {
    expect(isDelegatedWidgetMcpToolAllowed("wordpress", "wordpress_content_editor_run")).toBe(true);
    expect(isDelegatedWidgetMcpToolAllowed("drupal", "drupal_content_editor_run")).toBe(true);
  });

  it("is EXACT-MATCH (case-sensitive): a non-canonical casing is DENIED", () => {
    // A distinct tool registered with non-canonical casing is a DIFFERENT
    // primitive and must never be treated as the editor by a case-fold collision.
    expect(isDelegatedWidgetMcpToolAllowed("wordpress", "WordPress_Content_Editor_Run")).toBe(false);
    expect(isDelegatedWidgetMcpToolAllowed("wordpress", "WORDPRESS_CONTENT_EDITOR_RUN")).toBe(false);
  });

  // ---- T4: KIND BINDING (G9) — a token can never drive the OTHER kind -------
  it("T4: a wordpress token CANNOT drive drupal_content_editor_run", () => {
    expect(isDelegatedWidgetMcpToolAllowed("wordpress", "drupal_content_editor_run")).toBe(false);
  });

  it("T4: a drupal token CANNOT drive wordpress_content_editor_run", () => {
    expect(isDelegatedWidgetMcpToolAllowed("drupal", "wordpress_content_editor_run")).toBe(false);
  });

  // ---- T3: BLAST RADIUS — every non-editor primitive is denied for a widget
  //          delegation, EVEN ones the broad chat allowlist would permit -------
  it.each([
    // reads/dispatch the delegated-CHAT allowlist permits — all DENIED here.
    "agent_run",
    "agent_list",
    "objects_list",
    "objects_get",
    "wordpress_instances_list",
    "wordpress_posts_list",
    "drupal_instances_list",
    "artifact_authoring_emit",
    "dashboards_cube_load",
    "system_screen_lookup",
    // sibling connector write primitives — DENIED (only *_content_editor_run).
    "wordpress_post_update",
    "wordpress_post_create_draft",
    "wordpress_media_upload",
    "drupal_node_update",
  ])("T3: blast radius — '%s' is DENIED for a wordpress widget delegation", (tool) => {
    expect(isDelegatedWidgetMcpToolAllowed("wordpress", tool)).toBe(false);
  });

  it.each([
    "agent_run",
    "objects_list",
    "drupal_instances_list",
    "drupal_node_update",
    "wordpress_content_editor_run", // the other kind's editor — DENIED (T4).
  ])("T3: blast radius — '%s' is DENIED for a drupal widget delegation", (tool) => {
    expect(isDelegatedWidgetMcpToolAllowed("drupal", tool)).toBe(false);
  });

  it("fail-closed on an unknown kind — denies everything", () => {
    expect(
      // deliberately pass an unknown kind through the typed boundary
      isDelegatedWidgetMcpToolAllowed("mystery" as "wordpress", "wordpress_content_editor_run"),
    ).toBe(false);
  });
});
