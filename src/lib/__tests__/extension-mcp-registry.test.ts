import { describe, it, expect, afterEach } from "vitest";
import {
  extensionMcpRegistry,
  registerExtensionMcpTool,
  listExtensionMcpTools,
  removeExtensionMcpToolsForPackage,
  markEffectiveExtensionMcpTools,
  getEffectiveExtensionMcpTool,
  _resetExtensionMcpForTests,
} from "@/lib/extension-mcp-registry";

afterEach(() => _resetExtensionMcpForTests());

describe("extension MCP registry", () => {
  it("is EMPTY by default — the no-op-replay safety property", () => {
    expect(listExtensionMcpTools()).toHaveLength(0);
  });

  it("records a registered tool tagged with its packageName + handler", () => {
    registerExtensionMcpTool("@cinatra-ai/x", { name: "x_selfcheck", handler: () => ({ ok: true }) });
    const tools = listExtensionMcpTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: "x_selfcheck", packageName: "@cinatra-ai/x" });
    expect(typeof tools[0].handler).toBe("function");
  });

  it("the tool DISAPPEARS when the registration is removed (closes the false-positive proof gap)", () => {
    registerExtensionMcpTool("@cinatra-ai/x", { name: "x_selfcheck", handler: () => ({}) });
    expect(listExtensionMcpTools().some((t) => t.name === "x_selfcheck")).toBe(true);
    extensionMcpRegistry._clearForTests();
    expect(listExtensionMcpTools().some((t) => t.name === "x_selfcheck")).toBe(false);
  });

  it("rejects a tool with no name or no handler (fail-loud)", () => {
    expect(() => registerExtensionMcpTool("@cinatra-ai/x", { name: "", handler: () => ({}) })).toThrow(/no name/);
    // @ts-expect-error — intentionally missing handler
    expect(() => registerExtensionMcpTool("@cinatra-ai/x", { name: "t" })).toThrow(/no handler/);
  });

  // True-IoC uninstall teardown — closes the "no remove" split-brain gap.
  it("removeByPackage drops ONLY the named package's tools and returns them", () => {
    registerExtensionMcpTool("@cinatra-ai/a", { name: "a_one", handler: () => ({}) });
    registerExtensionMcpTool("@cinatra-ai/a", { name: "a_two", handler: () => ({}) });
    registerExtensionMcpTool("@cinatra-ai/b", { name: "b_one", handler: () => ({}) });
    const removed = extensionMcpRegistry.removeByPackage("@cinatra-ai/a");
    expect(removed.sort()).toEqual(["a_one", "a_two"]);
    expect(listExtensionMcpTools().map((t) => t.name)).toEqual(["b_one"]);
  });

  it("removeExtensionMcpToolsForPackage clears the registry AND the authz effective-set (no stale shadow-allow)", () => {
    registerExtensionMcpTool("@cinatra-ai/a", { name: "a_tool", handler: () => ({}) });
    registerExtensionMcpTool("@cinatra-ai/b", { name: "b_tool", handler: () => ({}) });
    // both were effectively registered into a server build
    markEffectiveExtensionMcpTools([
      { name: "a_tool", packageName: "@cinatra-ai/a" },
      { name: "b_tool", packageName: "@cinatra-ai/b" },
    ]);
    expect(getEffectiveExtensionMcpTool("a_tool")).toEqual({ packageName: "@cinatra-ai/a" });

    const removed = removeExtensionMcpToolsForPackage("@cinatra-ai/a");
    expect(removed).toEqual(["a_tool"]);
    // gone from the registry...
    expect(listExtensionMcpTools().some((t) => t.name === "a_tool")).toBe(false);
    // ...and no longer shadow-allowed by the authz boundary
    expect(getEffectiveExtensionMcpTool("a_tool")).toBeUndefined();
    // the OTHER package's tool is untouched
    expect(getEffectiveExtensionMcpTool("b_tool")).toEqual({ packageName: "@cinatra-ai/b" });
    expect(listExtensionMcpTools().some((t) => t.name === "b_tool")).toBe(true);
  });

  it("removeExtensionMcpToolsForPackage is a safe no-op for a package that registered nothing", () => {
    expect(removeExtensionMcpToolsForPackage("@cinatra-ai/never")).toEqual([]);
  });
});

// cinatra#1392 S8 round-1 (codex #4) — merge semantics + collision unmark.
describe("effective set — merge + collision unmark (S8)", () => {
  it("markEffective UPSERTS (concurrent per-caller builds never erase each other)", async () => {
    const { markEffectiveExtensionMcpTools, getEffectiveExtensionMcpTool, _resetExtensionMcpForTests } =
      await import("@/lib/extension-mcp-registry");
    _resetExtensionMcpForTests();
    markEffectiveExtensionMcpTools([{ name: "a_tool", packageName: "@x/a" }]);
    markEffectiveExtensionMcpTools([{ name: "b_tool", packageName: "@x/b" }]); // a second build
    expect(getEffectiveExtensionMcpTool("a_tool")).toEqual({ packageName: "@x/a" });
    expect(getEffectiveExtensionMcpTool("b_tool")).toEqual({ packageName: "@x/b" });
  });

  it("unmark removes a collision-skipped name ONLY while it still attributes to that package", async () => {
    const {
      markEffectiveExtensionMcpTools,
      unmarkEffectiveExtensionMcpToolCollisions,
      getEffectiveExtensionMcpTool,
      _resetExtensionMcpForTests,
    } = await import("@/lib/extension-mcp-registry");
    _resetExtensionMcpForTests();
    markEffectiveExtensionMcpTools([{ name: "x_tool", packageName: "@x/old" }]);
    // A later build skips @x/old's x_tool (a host name now claims it) → entry drops.
    unmarkEffectiveExtensionMcpToolCollisions([{ name: "x_tool", packageName: "@x/old" }]);
    expect(getEffectiveExtensionMcpTool("x_tool")).toBeUndefined();
    // But an entry now owned by ANOTHER package survives a stale skip report.
    markEffectiveExtensionMcpTools([{ name: "x_tool", packageName: "@x/new" }]);
    unmarkEffectiveExtensionMcpToolCollisions([{ name: "x_tool", packageName: "@x/old" }]);
    expect(getEffectiveExtensionMcpTool("x_tool")).toEqual({ packageName: "@x/new" });
  });
});
