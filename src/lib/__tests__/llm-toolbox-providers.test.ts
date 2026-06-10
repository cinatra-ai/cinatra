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
