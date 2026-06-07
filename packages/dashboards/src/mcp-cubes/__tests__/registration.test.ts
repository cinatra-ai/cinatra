/**
 * Hermetic test asserting `createDashboardCubesMcpModule()` registers
 * exactly four tools — `dashboards_cube_discover`, `_validate`, `_load`,
 * `_chart` — via `server.registerTool`.
 *
 * Calls the module's `registerCapabilities` against a stub
 * `McpRuntimeToolServer` and records every `registerTool(name, ...)` call.
 * The cube-tools bridge is the same singleton used in production; the
 * test sets `SUPABASE_DB_URL` to a stub value so `getMcpCubeTools` can
 * build the bridge — drizzle-cube/server's `SemanticLayerCompiler` does
 * NOT actually open the pool until a query runs, so registration alone
 * never hits Postgres.
 *
 * This stays green under HMR / repeat invocations because the singleton
 * caches.
 */
import { afterEach, describe, expect, it } from "vitest";

import { createDashboardCubesMcpModule } from "../index";
import { __resetMcpCubeToolsForTests } from "../cubes-singleton";

afterEach(() => {
  __resetMcpCubeToolsForTests();
});

type StubServer = {
  registerTool(name: string, meta: unknown, handler: unknown): void;
  registerResource(
    name: string,
    uriOrTemplate: unknown,
    config: unknown,
    cb: unknown,
  ): void;
};

describe("createDashboardCubesMcpModule — registration shape", () => {
  it("registers exactly the 4 dashboards_cube_* tools + MCP App resources", async () => {
    // The cubes-singleton needs SUPABASE_DB_URL to build the bridge. In
    // the test environment we provide a stub value — drizzle-cube/server's
    // SemanticLayerCompiler doesn't actually open the pool until a query
    // runs, so registration alone won't hit Postgres.
    const prior = process.env.SUPABASE_DB_URL;
    process.env.SUPABASE_DB_URL = "postgres://stub/stub";
    try {
      const registered: Array<{ name: string; meta: unknown }> = [];
      const resources: Array<{ name: string; uri: unknown; config: unknown; cb: unknown }> = [];
      const stub: StubServer = {
        registerTool(name, meta) {
          registered.push({ name, meta });
        },
        registerResource(name, uriOrTemplate, config, cb) {
          resources.push({ name, uri: uriOrTemplate, config, cb });
        },
      };
      const module = createDashboardCubesMcpModule();
      module.registerCapabilities(stub as never);

      const names = registered.map((r) => r.name).sort();
      expect(names).toEqual([
        "dashboards_cube_chart",
        "dashboards_cube_discover",
        "dashboards_cube_load",
        "dashboards_cube_validate",
      ]);
      expect(names.length).toBe(4);

      // Each tool's meta must be the Cinatra-shaped envelope with `title`,
      // `description`, and a Zod-shaped `inputSchema`.
      for (const r of registered) {
        const meta = r.meta as { title?: string; description?: string; inputSchema?: unknown };
        expect(meta.title).toBe(r.name);
        expect(typeof meta.description).toBe("string");
        expect(meta.description!.length).toBeGreaterThan(0);
        expect(meta.inputSchema).toBeDefined();
      }

      // The chart tool MUST carry `_meta.ui.resourceUri` pointing at the
      // MCP App visualization resource — without it MCP-Apps-aware clients
      // (Claude Desktop / Claude.ai) can't mount the visualization inline.
      const chart = registered.find((r) => r.name === "dashboards_cube_chart");
      expect(chart).toBeDefined();
      const chartMeta = chart!.meta as { _meta?: { ui?: { resourceUri?: string } } };
      expect(chartMeta._meta).toBeDefined();
      expect(chartMeta._meta!.ui).toBeDefined();
      expect(typeof chartMeta._meta!.ui!.resourceUri).toBe("string");
      expect(chartMeta._meta!.ui!.resourceUri).toMatch(/^ui:\/\/drizzle-cube\//);

      // Drizzle-cube's static resources (quickstart, query-shapes,
      // visualization.html) must be registered on the MCP server. Without
      // the visualization HTML resource registration, the chart tool's
      // `_meta.ui.resourceUri` points at a URI the server doesn't serve.
      expect(resources.length).toBeGreaterThan(0);
      const vizResource = resources.find((r) =>
        typeof r.uri === "string" && (r.uri as string).startsWith("ui://drizzle-cube/"),
      );
      expect(vizResource).toBeDefined();
      const vizConfig = vizResource!.config as { mimeType?: string };
      expect(vizConfig.mimeType).toMatch(/^text\/html/);

      // Reading the resource via its callback returns the inline HTML
      // payload so MCP-Apps-aware clients can fetch via resources/read.
      const cb = vizResource!.cb as () => Promise<{ contents: Array<{ text?: string; uri?: string; mimeType?: string }> }>;
      const read = await cb();
      expect(read.contents).toHaveLength(1);
      expect(typeof read.contents[0].text).toBe("string");
      expect((read.contents[0].text as string).length).toBeGreaterThan(0);
      expect(read.contents[0].uri).toBe(vizResource!.uri);
    } finally {
      if (prior === undefined) delete process.env.SUPABASE_DB_URL;
      else process.env.SUPABASE_DB_URL = prior;
    }
  });
});
