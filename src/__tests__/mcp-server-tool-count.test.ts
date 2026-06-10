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
 *
 * Connector MCP modules are no longer listed in mcp-server.ts — they resolve
 * from the generated manifest (GENERATED_CONNECTOR_MCP_MODULES). The guard
 * therefore counts BOTH surfaces: the platform `modules` array AND every
 * manifest-discovered connector module (slug → extension mcp sources).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");
const MCP_SERVER_PATH = path.join(ROOT, "src/lib/mcp-server.ts");
const GENERATED_MANIFEST_PATH = path.join(ROOT, "src/lib/generated/extensions.server.ts");

const MODULE_TO_HANDLERS: Record<string, string> = {
  createArtifactsModule: "src/lib/artifacts/mcp.ts",
  createContextModule: "src/lib/artifacts/context-mcp.ts",
  createObjectsModule: "packages/objects/src/mcp/handlers.ts",
  createProjectsModule: "packages/projects/src/mcp/handlers.ts",
  createBlogContentModule: "src/lib/blog/mcp/handlers.ts",
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

/**
 * Slugs of the connector MCP modules carried by the generated manifest. The
 * tool sources live under `extensions/cinatra-ai/<slug>/src/mcp/` — handlers.ts
 * when the connector ships the key:async() handler map the scanner can count,
 * else module.ts (facade connectors registerTool directly; the static scan
 * counts 0 from those and the focused facade test below pins their surface).
 */
function extractGeneratedConnectorModuleSlugs(): string[] {
  const src = readFileSync(GENERATED_MANIFEST_PATH, "utf8");
  const match = src.match(
    /export const GENERATED_CONNECTOR_MCP_MODULES[^=]*=\s*\{([\s\S]*?)\n\};/,
  );
  if (!match) {
    throw new Error(
      "Could not locate GENERATED_CONNECTOR_MCP_MODULES in src/lib/generated/extensions.server.ts",
    );
  }
  return Array.from(match[1].matchAll(/^\s*"([^"]+)":/gm)).map((m) => m[1]);
}

function connectorMcpSourcePath(slug: string): string {
  const handlers = path.join(ROOT, `extensions/cinatra-ai/${slug}/src/mcp/handlers.ts`);
  if (existsSync(handlers)) return handlers;
  return path.join(ROOT, `extensions/cinatra-ai/${slug}/src/mcp/module.ts`);
}

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
  const arrays = Array.from(
    src.matchAll(/const\s+(?:pre|post)ConnectorPlatformModules\s*=\s*\[([\s\S]*?)\];/g),
  );
  if (arrays.length !== 2) {
    throw new Error(
      "Could not locate the pre/postConnectorPlatformModules arrays in src/lib/mcp-server.ts",
    );
  }
  return arrays.flatMap((m) => Array.from(m[1].matchAll(/(\w+)\(\)/g)).map((mm) => mm[1]));
}

/**
 * Tool names a connector source registers DIRECTLY via
 * `server.registerTool(<literal name>, ...)` (facade-style modules / registry
 * files) — invisible to the key:async() scan above, so counted separately.
 */
function directRegisterToolNames(filePath: string): string[] {
  if (!existsSync(filePath)) return [];
  const text = readFileSync(filePath, "utf8");
  return Array.from(text.matchAll(/\bserver\.registerTool\(\s*["']([a-z0-9_]+)["']/g)).map(
    (m) => m[1],
  );
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
    // Manifest-discovered connector MCP modules (the registration path that
    // replaced the static connector imports) — count their tool surfaces too:
    // the key:async() handler maps PLUS the names facade-style modules and
    // registry files register directly via server.registerTool(<literal name>)
    // (email/social/blog/crm/twenty surfaces the old scan was blind to).
    const slugs = extractGeneratedConnectorModuleSlugs();
    expect(slugs.length).toBeGreaterThan(0);
    for (const slug of slugs) {
      const { count, toolNames } = countToolNamesInHandlers(connectorMcpSourcePath(slug));
      const names = new Set(toolNames);
      for (const f of ["module.ts", "registry.ts"]) {
        for (const n of directRegisterToolNames(
          path.join(ROOT, `extensions/cinatra-ai/${slug}/src/mcp/${f}`),
        )) {
          names.add(n);
        }
      }
      perModule.push({ name: slug, count: Math.max(count, names.size) });
      for (const n of names) all.add(n);
    }
    const total = all.size;
    // Soft ceiling: with the static scan now ALSO counting direct
    // server.registerTool registrations we count ~206 tools (including some
    // inter-module duplicates between metric-cost sub-modules). The 225
    // ceiling gives ~10% room for normal additions and forces a code review
    // when growth is unusual. The TRUE OpenAI function-tool cap is 128 per
    // `declaredToolboxIds` injection window, so chat-callable tools must
    // still be curated separately — this test is a coarse early-warning, not
    // the hard guarantee.
    if (total >= 225) {
      const summary = perModule.map((m) => `  ${m.name}: ${m.count}`).join("\n");
      // eslint-disable-next-line no-console
      console.error(
        `Static MCP tool count = ${total} (soft ceiling 225). Per-module:\n${summary}`,
      );
    }
    expect(total).toBeLessThan(225);
  });

  it("media-feeds primitives are present in the registry", () => {
    const slugs = extractGeneratedConnectorModuleSlugs();
    expect(slugs).toContain("media-feeds-connector");

    const { toolNames } = countToolNamesInHandlers(
      connectorMcpSourcePath("media-feeds-connector"),
    );
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
