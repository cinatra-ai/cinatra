/**
 * MCP cap measurement test.
 *
 * Strategy: instantiate a stub McpRuntimeToolServer that records the names
 * passed to `registerTool(name, ...)`, register the dashboards module,
 * and assert exactly the expected set.
 *
 * The dashboards module registers 2 read tools: dashboards_list,
 * dashboards_get.
 * It also registers 4 write tools: dashboards_create, dashboards_update,
 * dashboards_publish, dashboards_archive. Total: 6.
 */
import { describe, expect, it } from "vitest";

import { createDashboardsModule } from "../integration/module";

type StubServer = {
  registerTool(name: string, meta: unknown, handler: unknown): void;
};

describe("MCP cap measurement", () => {
  it("dashboards module registers exactly the expected read + write tools", () => {
    const registered: string[] = [];
    const stub: StubServer = {
      registerTool(name: string) {
        registered.push(name);
      },
    };
    const module = createDashboardsModule();
    module.registerCapabilities(stub as never);

    expect(registered.sort()).toEqual([
      "dashboards_archive",
      "dashboards_create",
      "dashboards_get",
      "dashboards_list",
      "dashboards_publish",
      "dashboards_update",
    ]);
    expect(registered.length).toBe(6);
  });
});
