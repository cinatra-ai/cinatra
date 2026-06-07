import { describe, it, expect, beforeEach, afterEach } from "vitest";

// Host-wiring contract test (split-brain guard). Proves the
// teardown → host-removal path end-to-end with the REAL host
// `removeExtensionMcpToolsForPackage`: wiring it as the capability teardown hook
// (exactly as `src/lib/extensions.ts` does) and firing the package-side
// `fireExtensionCapabilityTeardown` removes a registered extension MCP tool from
// the real registry + authz effective-set.
//
// NOTE: this deliberately does NOT `import "@/lib/extensions"` — that side-effect
// module transitively loads every connector handler (gmail/wordpress/…) and is
// too heavy for the unit-test env. It tests the same one-line wiring contract
// `setExtensionCapabilityTeardownHook(removeExtensionMcpToolsForPackage)`.
import type { HostMcpToolRegistration } from "@cinatra-ai/sdk-extensions";
import {
  setExtensionCapabilityTeardownHook,
  fireExtensionCapabilityTeardown,
} from "@cinatra-ai/extensions";
import {
  registerExtensionMcpTool,
  listExtensionMcpTools,
  removeExtensionMcpToolsForPackage,
  _resetExtensionMcpForTests,
} from "@/lib/extension-mcp-registry";

const PKG = "@cinatra-ai/teardown-wiring-test-ext";
const tool = {
  name: "teardown_wiring_test_tool",
  config: { title: "t", description: "d", inputSchema: {} },
  handler: async () => ({ content: [] }),
} as unknown as HostMcpToolRegistration;

describe("capability teardown hook → host removeExtensionMcpToolsForPackage contract", () => {
  beforeEach(() => {
    _resetExtensionMcpForTests();
    // The exact wiring src/lib/extensions.ts installs at boot.
    setExtensionCapabilityTeardownHook((pkg) => removeExtensionMcpToolsForPackage(pkg));
  });
  afterEach(() => setExtensionCapabilityTeardownHook(null));

  it("firing teardown removes the package's registered MCP tools (real host removal)", () => {
    registerExtensionMcpTool(PKG, tool);
    expect(listExtensionMcpTools().some((t) => t.name === tool.name)).toBe(true);

    fireExtensionCapabilityTeardown(PKG);

    expect(listExtensionMcpTools().some((t) => t.name === tool.name)).toBe(false);
  });

  it("teardown of an unrelated package leaves the tool registered", () => {
    registerExtensionMcpTool(PKG, tool);
    fireExtensionCapabilityTeardown("@cinatra-ai/some-other-ext");
    expect(listExtensionMcpTools().some((t) => t.name === tool.name)).toBe(true);
  });
});
