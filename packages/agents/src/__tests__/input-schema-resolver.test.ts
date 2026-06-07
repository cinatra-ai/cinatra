/**
 * input-schema-resolver tests.
 *
 * Covers: DB-wins-when-populated, OAS-fallback-when-empty, third-party
 * scope rejection, memoization, malformed-input fail-soft.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

const agentInstallDirMock = vi.hoisted(() => ({
  resolveAgentInstallDir: vi.fn(),
}));
vi.mock("../agent-install-path", () => agentInstallDirMock);

const fsMock = vi.hoisted(() => ({
  readFile: vi.fn(),
}));
vi.mock("node:fs/promises", () => fsMock);

const existsSyncMock = vi.hoisted(() => ({
  existsSync: vi.fn(),
}));
vi.mock("node:fs", () => existsSyncMock);

import {
  resolveTemplateInputSchema,
  __resetInputSchemaResolverCache,
  __testOnly,
} from "../input-schema-resolver";

const SAMPLE_OAS = {
  component_type: "Flow",
  start_node: { $component_ref: "start" },
  $referenced_components: {
    start: {
      component_type: "StartNode",
      inputs: [
        { title: "url", type: "string", format: "uri" },
        { title: "agent_run_id", type: "string", default: "" },
      ],
      metadata: {
        cinatra: { required: ["url"], hidden: ["agent_run_id"] },
      },
    },
  },
};

beforeEach(() => {
  __resetInputSchemaResolverCache();
  // Reset call history so each test sees a clean fsMock.readFile invocation
  // count (the "not called" assertions otherwise pick up prior tests' calls).
  fsMock.readFile.mockReset();
  existsSyncMock.existsSync.mockReset();
  agentInstallDirMock.resolveAgentInstallDir.mockReset();
  agentInstallDirMock.resolveAgentInstallDir.mockReturnValue("/repo/agents");
  existsSyncMock.existsSync.mockReturnValue(true);
  fsMock.readFile.mockResolvedValue(JSON.stringify(SAMPLE_OAS));
});

describe("resolveTemplateInputSchema", () => {
  it("returns the DB inputSchema when non-empty", async () => {
    const result = await resolveTemplateInputSchema({
      packageName: "@cinatra-ai/email-test-delivery-agent",
      packageVersion: "0.1.1",
      inputSchema: {
        type: "object",
        required: ["X"],
        properties: { X: { type: "string" } },
      },
    });
    expect(result.required).toEqual(["X"]);
    expect(fsMock.readFile).not.toHaveBeenCalled();
  });

  it("falls back to disk OAS when DB schema is empty {}", async () => {
    const result = await resolveTemplateInputSchema({
      packageName: "@cinatra-ai/email-test-delivery-agent",
      packageVersion: "0.1.1",
      inputSchema: {},
    });
    expect(result.required).toEqual(["url"]);
    expect(result.properties.url).toEqual({ type: "string", format: "uri" });
    expect(result.hidden).toEqual(["agent_run_id"]);
    expect(fsMock.readFile).toHaveBeenCalledTimes(1);
  });

  it("falls back when DB schema has empty required AND empty properties", async () => {
    const result = await resolveTemplateInputSchema({
      packageName: "@cinatra-ai/email-test-delivery-agent",
      packageVersion: "0.1.1",
      inputSchema: { type: "object", required: [], properties: {} },
    });
    expect(result.required).toEqual(["url"]);
  });

  it("does NOT fall back for non-cinatra packages (third-party scope)", async () => {
    const result = await resolveTemplateInputSchema({
      packageName: "@somevendor/some-agent",
      packageVersion: "1.0.0",
      inputSchema: {},
    });
    expect(result.required).toEqual([]);
    expect(result.properties).toEqual({});
    expect(fsMock.readFile).not.toHaveBeenCalled();
  });

  it("memoizes by packageName@packageVersion", async () => {
    const tmpl = {
      packageName: "@cinatra-ai/email-test-delivery-agent",
      packageVersion: "0.1.1",
      inputSchema: {},
    };
    await resolveTemplateInputSchema(tmpl);
    await resolveTemplateInputSchema(tmpl);
    await resolveTemplateInputSchema(tmpl);
    expect(fsMock.readFile).toHaveBeenCalledTimes(1);
  });

  it("re-reads when packageVersion changes (cache key includes version)", async () => {
    await resolveTemplateInputSchema({
      packageName: "@cinatra-ai/email-test-delivery-agent",
      packageVersion: "0.1.1",
      inputSchema: {},
    });
    await resolveTemplateInputSchema({
      packageName: "@cinatra-ai/email-test-delivery-agent",
      packageVersion: "0.1.2",
      inputSchema: {},
    });
    expect(fsMock.readFile).toHaveBeenCalledTimes(2);
  });

  it("returns empty schema when OAS file is missing (fail-soft)", async () => {
    existsSyncMock.existsSync.mockReturnValue(false);
    const result = await resolveTemplateInputSchema({
      packageName: "@cinatra-ai/email-test-delivery-agent",
      packageVersion: "0.1.1",
      inputSchema: {},
    });
    expect(result.required).toEqual([]);
    expect(result.properties).toEqual({});
  });

  it("returns empty schema when OAS JSON is malformed (fail-soft)", async () => {
    fsMock.readFile.mockResolvedValue("not valid json");
    const result = await resolveTemplateInputSchema({
      packageName: "@cinatra-ai/email-test-delivery-agent",
      packageVersion: "0.1.1",
      inputSchema: {},
    });
    expect(result.required).toEqual([]);
  });

  it("returns empty schema when packageName is null", async () => {
    const result = await resolveTemplateInputSchema({
      packageName: null,
      packageVersion: "0.1.1",
      inputSchema: {},
    });
    expect(result.required).toEqual([]);
    expect(fsMock.readFile).not.toHaveBeenCalled();
  });
});

describe("__testOnly.isCinatraInRepoSlug", () => {
  it("matches @cinatra/<slug> shape strictly", () => {
    expect(__testOnly.isCinatraInRepoSlug("@cinatra-ai/email-test-delivery-agent")).toBe(
      "email-test-delivery-agent",
    );
    expect(__testOnly.isCinatraInRepoSlug("@cinatra/")).toBeNull();
    expect(__testOnly.isCinatraInRepoSlug("@somevendor/foo")).toBeNull();
    expect(__testOnly.isCinatraInRepoSlug("plain-name")).toBeNull();
    expect(__testOnly.isCinatraInRepoSlug(null)).toBeNull();
    expect(__testOnly.isCinatraInRepoSlug(undefined)).toBeNull();
  });
});

describe("__testOnly.inputSchemaIsEmpty", () => {
  it("returns true for null/undefined/non-object", () => {
    expect(__testOnly.inputSchemaIsEmpty(null)).toBe(true);
    expect(__testOnly.inputSchemaIsEmpty(undefined)).toBe(true);
    expect(__testOnly.inputSchemaIsEmpty("string")).toBe(true);
  });
  it("returns true for {} and { required:[], properties:{} }", () => {
    expect(__testOnly.inputSchemaIsEmpty({})).toBe(true);
    expect(__testOnly.inputSchemaIsEmpty({ required: [], properties: {} })).toBe(true);
  });
  it("returns false when required has entries", () => {
    expect(__testOnly.inputSchemaIsEmpty({ required: ["url"] })).toBe(false);
  });
  it("returns false when properties has keys", () => {
    expect(__testOnly.inputSchemaIsEmpty({ properties: { url: { type: "string" } } })).toBe(false);
  });
});
