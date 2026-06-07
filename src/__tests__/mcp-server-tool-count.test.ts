/**
 * Guard the OpenAI 128 function-tool ceiling.
 *
 * The OpenAI Responses API silently truncates the tool array beyond index
 * 127, so any new MCP module that pushes us past the cap would lose tools
 * with zero failure signal in chat flows. This test guards against accidental
 * regression of the media-feed primitives specifically, and against unbounded
 * growth of the registered tool set overall.
 *
 * The most accurate approach would be runtime: import
 * `registerAllCapabilities` and run it against a stub server. But the
 * production MCP server eagerly imports the entire workspace module graph
 * at module-load time (~24 packages, several of which aren't resolvable in
 * the root vitest sandbox without large alias-surface expansion). We
 * approximate via static source-scan instead:
 *
 *   1. Read src/lib/mcp-server.ts and extract the `modules` array.
 *   2. For each module, read its mcp/handlers.ts and union the snake_case
 *      keys that look like a primitive handler ("name": (req)=> form).
 *   3. Assert the deduped union stays below a soft ceiling (200), so
 *      anyone adding ~5+ new tools sees a failure they can investigate.
 *
 * The scan is approximate (different modules use different declaration
 * styles; a small handful of keys may be false positives like internal
 * helpers). If a cleaner runtime hook becomes available, swap this
 * implementation; the assertions below should still hold.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");
const MCP_SERVER_PATH = path.join(ROOT, "src/lib/mcp-server.ts");

const MODULE_TO_HANDLERS: Record<string, string> = {
  createArtifactsModule: "src/lib/artifacts/mcp.ts",
  createContextModule: "src/lib/artifacts/context-mcp.ts",
  createObjectsModule: "packages/objects/src/mcp/handlers.ts",
  createProjectsModule: "packages/projects/src/mcp/handlers.ts",
  createBlogContentModule: "src/lib/blog/mcp/handlers.ts",
  // Connector handler paths live under extension packages. Keep these mapped
  // to the extension-side handlers, plus the email module entry, so the
  // 128-tool ceiling guard counts the registered surface accurately.
  createGmailModule: "extensions/cinatra-ai/gmail-connector/src/mcp/handlers.ts",
  createGoogleCalendarModule: "extensions/cinatra-ai/google-calendar-connector/src/mcp/handlers.ts",
  createApolloModule: "extensions/cinatra-ai/apollo-connector/src/mcp/handlers.ts",
  createWordPressModule: "extensions/cinatra-ai/wordpress-mcp-connector/src/mcp/handlers.ts",
  createDrupalModule: "extensions/cinatra-ai/drupal-mcp-connector/src/mcp/handlers.ts",
  createLinkedInModule: "extensions/cinatra-ai/linkedin-connector/src/mcp/handlers.ts",
  // email-connector uses server.registerTool directly (scan counts 0);
  // mapping to module.ts keeps the guard's per-module loop from throwing.
  createEmailModule: "extensions/cinatra-ai/email-connector/src/mcp/module.ts",
  // social-media-connector facade uses server.registerTool
  // directly (no key:async() handlers pattern), so the static scan counts 0
  // tools from its module.ts and the file path below is the closest analog
  // (module.ts, not handlers.ts). The single primitive (`social_media_publish`)
  // is added to the soft-ceiling total separately via the modulesToCheck path
  // below if/when this test is refactored to runtime mode.
  createSocialMediaModule: "extensions/cinatra-ai/social-media-connector/src/mcp/module.ts",
  // Same server.registerTool-direct pattern as
  // social-media-connector; static-scan counts 0 from its module.ts.
  createBlogModule: "extensions/cinatra-ai/blog-connector/src/mcp/module.ts",
  // Both use server.registerTool directly inside module.ts.
  // The static scan counts 0 tools from these (no key:async() pattern); the
  // 17 primitives (15 crm_* + 2 twenty_*) are counted via the authz
  // inventory check instead.
  createCrmModule: "extensions/cinatra-ai/crm-connector/src/mcp/module.ts",
  createTwentyConnectorModule: "extensions/cinatra-ai/twenty-connector/src/mcp/module.ts",
  createMediaFeedsModule: "extensions/cinatra-ai/media-feeds-connector/src/mcp/handlers.ts",
  createPermissionsModule: "packages/permissions/src/mcp/handlers.ts",
  createSkillsModule: "packages/skills/src/mcp/handlers.ts",
  createMetricsCostModule: "packages/metric-cost-api/src/mcp/handlers.ts",
  createMetricCostMcpModule: "packages/metric-cost-api/src/mcp/handlers.ts",
  createMetricUsageMcpModule: "packages/metric-usage-api/src/mcp/handlers.ts",
  createAgentsModule: "packages/agents/src/mcp/handlers.ts",
  createExtensionsModule: "packages/extensions/src/mcp/handlers.ts",
  createChatModule: "packages/chat/src/mcp/handlers.ts",
  createTriggerModule: "packages/trigger/src/mcp/handlers.ts",
  createDashboardsModule: "packages/dashboards/src/mcp/handlers.ts",
  // drizzle-cube/mcp tools mounted under /api/mcp.
  // The cube module's handlers.ts exports 3 snake_case keys
  // (dashboards_cube_discover/validate/load) so the regex-based scanner
  // can count them like the other modules.
  createDashboardCubesMcpModule: "packages/dashboards/src/mcp-cubes/handlers.ts",
};

// Reserved keys that look like snake_case identifiers but are not tool
// names — pre-filtered to keep the static count honest. Add new entries
// here when the regex picks up additional false positives.
const FALSE_POSITIVE_KEYS = new Set([
  "now",
  "send",
  "source",
  "type",
  "request",
  "input",
  "context",
  "actor",
  "result",
]);

function extractRegisteredModuleNames(src: string): string[] {
  const match = src.match(/const\s+modules\s*=\s*\[([\s\S]*?)\];/);
  if (!match) throw new Error("Could not locate `modules` array in src/lib/mcp-server.ts");
  return Array.from(match[1].matchAll(/(\w+)\(\)/g)).map((m) => m[1]);
}

function countToolNamesInHandlers(filePath: string): { count: number; toolNames: string[] } {
  if (!existsSync(filePath)) {
    throw new Error(`Handlers file not found: ${filePath}`);
  }
  const text = readFileSync(filePath, "utf8");
  // Matches both "tool_name": ... and tool_name: ... when followed by `:`
  // and either `async` or `(`. Restricts to snake_case to avoid catching
  // generic property keys.
  const matches = Array.from(
    text.matchAll(/(?:^|[\{,])\s*"?([a-z][a-z0-9_]*)"?\s*:\s*(?:async\s+)?\(/gm),
  );
  const names = Array.from(new Set(matches.map((m) => m[1])))
    .filter((n) => !FALSE_POSITIVE_KEYS.has(n));
  return { count: names.length, toolNames: names };
}

describe("MCP tool registry — function-tool cap headroom", () => {
  it("aggregated tool count is below the soft growth ceiling", () => {
    const src = readFileSync(MCP_SERVER_PATH, "utf8");
    const moduleNames = extractRegisteredModuleNames(src);
    const all = new Set<string>();
    const perModule: Array<{ name: string; count: number }> = [];
    for (const name of moduleNames) {
      const handlersRel = MODULE_TO_HANDLERS[name];
      if (!handlersRel) {
        throw new Error(
          `MODULE_TO_HANDLERS is missing an entry for "${name}" — when adding a new MCP module to src/lib/mcp-server.ts, also map it here so this guard test continues to count tools accurately.`,
        );
      }
      const { count, toolNames } = countToolNamesInHandlers(
        path.join(ROOT, handlersRel),
      );
      perModule.push({ name, count });
      for (const n of toolNames) all.add(n);
    }
    const total = all.size;
    // Soft ceiling: with the current static-scan approach we count ~180
    // tools (including some inter-module duplicates between metric-cost
    // sub-modules). The 200 ceiling gives ~10% room for normal additions
    // and forces a code review when growth is unusual. The TRUE OpenAI
    // function-tool cap is 128 per `declaredToolboxIds` injection
    // window, so chat-callable tools must still be curated separately —
    // this test is a coarse early-warning, not the hard guarantee.
    if (total >= 200) {
      const summary = perModule.map((m) => `  ${m.name}: ${m.count}`).join("\n");
      // eslint-disable-next-line no-console
      console.error(
        `Static MCP tool count = ${total} (soft ceiling 200). Per-module:\n${summary}`,
      );
    }
    expect(total).toBeLessThan(200);
  });

  it("media-feeds primitives are present in the registry", () => {
    const src = readFileSync(MCP_SERVER_PATH, "utf8");
    const moduleNames = extractRegisteredModuleNames(src);
    expect(moduleNames).toContain("createMediaFeedsModule");

    const handlersPath = path.join(
      ROOT,
      MODULE_TO_HANDLERS["createMediaFeedsModule"],
    );
    const { toolNames } = countToolNamesInHandlers(handlersPath);
    expect(toolNames).toContain("media_feed_youtube_list");
    expect(toolNames).toContain("media_feed_podcast_list");
  });

  it("blog-publish primitives are present (regression guard)", () => {
    const handlersPath = path.join(
      ROOT,
      MODULE_TO_HANDLERS["createBlogContentModule"],
    );
    const { toolNames } = countToolNamesInHandlers(handlersPath);
    expect(toolNames).toContain("blog_post_publish_linkedin_start");
    expect(toolNames).toContain("blog_post_publish_linkedin_update");
    expect(toolNames).toContain("blog_post_publish_wordpress_start");
    expect(toolNames).toContain("blog_post_publish_wordpress_delete");
  });

  // The connector-facade MCP modules
  // (createSocialMediaModule / createBlogModule) use `server.registerTool`
  // DIRECTLY (not the key:async() handlers shape the static scanner
  // counts), so they are invisible to the aggregate scan above. This
  // focused guard reads each module.ts and asserts it registers EXACTLY
  // its one expected primitive. This prevents 1:1 re-registration of the
  // ~24 blog_* primitives; 2 direct-registered tools against a 128 ceiling
  // is unconditionally safe.
  it("connector-facade modules add exactly 2 direct-registered tools (128-ceiling headroom)", () => {
    const socialModule = readFileSync(
      path.join(ROOT, "extensions/cinatra-ai/social-media-connector/src/mcp/module.ts"),
      "utf8",
    );
    const blogModule = readFileSync(
      path.join(ROOT, "extensions/cinatra-ai/blog-connector/src/mcp/module.ts"),
      "utf8",
    );
    const registerToolCalls = (src: string) =>
      Array.from(src.matchAll(/server\.registerTool\(\s*["']([a-z_]+)["']/g)).map(
        (m) => m[1],
      );
    const socialTools = registerToolCalls(socialModule);
    const blogTools = registerToolCalls(blogModule);
    expect(socialTools).toEqual(["social_media_publish"]);
    expect(blogTools).toEqual(["blog_connector_list"]);
    // +2 total. The OpenAI Responses API truncates beyond index 127; two
    // additional tools cannot approach that bound.
    expect(socialTools.length + blogTools.length).toBe(2);
  });
});
