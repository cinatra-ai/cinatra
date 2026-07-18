// Transport-registration cutover: the LLM declared-toolbox resolution is registration-driven — a
// connector registers an `llm-toolbox` capability provider; the host resolves
// declared ids through these providers (no hardcoded connector-id branch).

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  registerCapabilityProvider,
  __resetCapabilityRegistry,
} from "@/lib/extension-capabilities-registry";
import {
  buildToolboxProviderTools,
  buildAllToolboxProviderTools,
} from "@/lib/llm-toolbox-providers";

const TOOL = {
  type: "mcp",
  serverLabel: "apify-connector",
  serverUrl: "https://mcp.example.com",
  headers: { Authorization: "Bearer x" },
};

beforeEach(() => {
  __resetCapabilityRegistry();
});

describe("buildToolboxProviderTools", () => {
  it("returns null when no provider serves the declared id (caller falls through to the external registry)", async () => {
    expect(await buildToolboxProviderTools("apify-connector", "openai")).toBeNull();
  });

  it("builds tools through the registered provider for a matching declared id", async () => {
    const build = vi.fn(async () => [TOOL]);
    registerCapabilityProvider("llm-toolbox", {
      packageName: "@v/apify-connector",
      impl: { toolboxId: "apify-connector", build },
    });
    const tools = await buildToolboxProviderTools("apify-connector", "openai");
    expect(tools).toEqual([TOOL]);
    expect(build).toHaveBeenCalledWith("openai");
  });

  it("filters structurally-invalid built tools", async () => {
    registerCapabilityProvider("llm-toolbox", {
      packageName: "@v/apify-connector",
      impl: { toolboxId: "apify-connector", build: async () => [TOOL, { nope: true }, null] },
    });
    expect(await buildToolboxProviderTools("apify-connector", "openai")).toEqual([TOOL]);
  });

  it("a throwing builder degrades to an empty injection (never throws into the LLM call)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerCapabilityProvider("llm-toolbox", {
      packageName: "@v/apify-connector",
      impl: {
        toolboxId: "apify-connector",
        build: async () => {
          throw new Error("boom");
        },
      },
    });
    expect(await buildToolboxProviderTools("apify-connector", "openai")).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("ignores malformed llm-toolbox impls (structural guard)", async () => {
    registerCapabilityProvider("llm-toolbox", {
      packageName: "@v/bad",
      impl: { not: "a toolbox provider" },
    });
    expect(await buildToolboxProviderTools("apify-connector", "openai")).toBeNull();
  });

  // Approval-vocabulary boundary (llm-providers S2, #1713 AC2): the
  // registration-driven provider path shares the ONE enforcement module with
  // the manifest-driven toolbox loader — legacy/garbage approval intent must
  // never slip through THIS boundary either.
  describe("approval-vocabulary boundary", () => {
    const register = (built: unknown[]) => {
      registerCapabilityProvider("llm-toolbox", {
        packageName: "@v/apify-connector",
        impl: { toolboxId: "apify-connector", build: async () => built },
      });
    };

    it("passes auto_execute / approval_required / absent through unchanged", async () => {
      register([
        TOOL,
        { ...TOOL, serverLabel: "auto", approval: "auto_execute" },
        { ...TOOL, serverLabel: "guarded", approval: "approval_required" },
      ]);
      expect(await buildToolboxProviderTools("apify-connector", "openai")).toEqual([
        TOOL,
        { ...TOOL, serverLabel: "auto", approval: "auto_execute" },
        { ...TOOL, serverLabel: "guarded", approval: "approval_required" },
      ]);
    });

    it("DROPS a tool carrying an unknown approval value (fail closed)", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        register([{ ...TOOL, approval: "always" }, { ...TOOL, serverLabel: "ok" }]);
        expect(await buildToolboxProviderTools("apify-connector", "openai")).toEqual([
          { ...TOOL, serverLabel: "ok" },
        ]);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("unknown approval value"));
      } finally {
        warn.mockRestore();
      }
    });

    it('STRIPS a legacy requireApproval: "never" (identical semantics to the default) and keeps the tool', async () => {
      register([{ ...TOOL, requireApproval: "never" }]);
      const tools = await buildToolboxProviderTools("apify-connector", "openai");
      expect(tools).toEqual([TOOL]);
      expect(tools?.[0]).not.toHaveProperty("requireApproval");
    });

    it('DROPS legacy requireApproval approval intent ("always" / "read-only") instead of auto-executing it', async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        register([
          { ...TOOL, requireApproval: "always" },
          { ...TOOL, serverLabel: "ro", requireApproval: "read-only" },
          { ...TOOL, serverLabel: "ok" },
        ]);
        expect(await buildToolboxProviderTools("apify-connector", "openai")).toEqual([
          { ...TOOL, serverLabel: "ok" },
        ]);
        expect(warn).toHaveBeenCalledTimes(2);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("retired requireApproval"));
      } finally {
        warn.mockRestore();
      }
    });
  });
});

describe("buildAllToolboxProviderTools", () => {
  it("merges tools across every registered toolbox provider (legacy always-inject set)", async () => {
    registerCapabilityProvider("llm-toolbox", {
      packageName: "@v/apify-connector",
      impl: { toolboxId: "apify-connector", build: async () => [TOOL] },
    });
    const other = { ...TOOL, serverLabel: "other" };
    registerCapabilityProvider("llm-toolbox", {
      packageName: "@v/other-connector",
      impl: { toolboxId: "other", build: async () => [other] },
    });
    const tools = await buildAllToolboxProviderTools("anthropic");
    expect(tools.map((t) => t.serverLabel).sort()).toEqual(["apify-connector", "other"]);
  });
});
