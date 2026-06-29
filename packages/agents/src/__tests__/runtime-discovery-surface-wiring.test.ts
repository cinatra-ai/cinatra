// cinatra#659 — wiring guards: every AGENT consumer DISCOVERY/EXECUTION surface
// must route through the shared runtime-lifecycle gate (`resolveRunnableAgentPackageNames`
// / `isAgentRuntimeRunnable`) so a disabled/uninstalled agent disappears + refuses
// without a rebuild. The behavioral semantics are proven in
// `runtime-install-gate.test.ts` (the pure gate) and
// `release-workflow-agent-executor.test.ts` (the workflow agent_task executor).
// These SOURCE assertions (same convention as `pages.test.tsx`) catch a future
// refactor silently dropping the gate from a surface — a regression the
// `discovery-dispatcher-bypass-ban` audit gate does not cover (it bans direct
// native-reader use; it does not require the lifecycle intersect).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

describe("agent_run (MCP execution) routes through the runtime-lifecycle gate", () => {
  const handlers = read("mcp/handlers.ts");

  it("handleAgentBuilderRun intersects the resolved template against resolveRunnableAgentPackageNames", () => {
    // Gate present, sourced from the shared pure module.
    expect(handlers).toMatch(/resolveRunnableAgentPackageNames/);
    expect(handlers).toMatch(/runtime-install-gate/);
  });

  it("refuses execution when the agent is not runnable (fail-closed return)", () => {
    expect(handlers).toMatch(/Agent is not installed \(disabled or uninstalled\)/);
  });
});

describe("agent_list (MCP discovery) filters by the runtime-lifecycle gate", () => {
  const handlers = read("mcp/handlers.ts");

  it("post-filters the listed items by the runnable set (gate referenced twice: run + list)", () => {
    // Both agent_run and agent_list import the gate → at least two references.
    expect((handlers.match(/resolveRunnableAgentPackageNames/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("keeps null-packageName + CG-1 no-row items (the bundled floor) in the list", () => {
    expect(handlers).toMatch(/t\.packageName == null \|\| runnable\.has\(t\.packageName\)/);
  });
});

describe("NewAgentPage (the /agents/run picker) intersects against the runtime-lifecycle gate", () => {
  const pages = read("pages.tsx");

  it("calls resolveRunnableAgentPackageNames over the local (non-external) templates", () => {
    expect(pages).toMatch(/resolveRunnableAgentPackageNames/);
    expect(pages).toMatch(/sourceType !== "external"/);
  });

  it("keeps external A2A templates + null-package + CG-1 no-row templates", () => {
    expect(pages).toMatch(/t\.sourceType === "external"/);
    expect(pages).toMatch(/t\.packageName == null \|\|\s*\n?\s*runnable\.has\(t\.packageName\)/);
  });
});
