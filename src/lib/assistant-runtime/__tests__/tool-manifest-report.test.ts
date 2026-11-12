// The pure half of the tool-manifest report (packages/agent-ui-protocol/
// CONTRACT.md section 5.2): the tool reference, the projection of each tool
// kind, and the keyed hashes over their canonical JSON. The route and the
// extracted tool assembly come in a later change; this file pins what they
// will hash and return.

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { LlmTool } from "@cinatra-ai/llm";
import { canonicalizeJson } from "../canonical-json";
import {
  TOOL_MANIFEST_VERSION,
  ToolManifestError,
  buildToolManifestReport,
  createToolManifestHashKey,
  projectToolForManifest,
  toolReferenceOf,
} from "../tool-manifest-report";

const KEY = Buffer.alloc(32, 7);

function hmac(text: string, key: Buffer = KEY): string {
  return `hmac-sha256:${createHmac("sha256", key).update(text, "utf8").digest("hex")}`;
}

const neverCalled = () => {
  throw new Error("an executable member of a tool was called");
};

const functionTool = {
  name: "list_runs",
  description: "List the runs.",
  parameters: { type: "object", properties: { limit: { type: "number" } }, required: [] },
  execute: neverCalled,
} as unknown as LlmTool;

const mcpTool: LlmTool = {
  type: "mcp",
  serverLabel: "cinatra",
  serverUrl: "https://instance.example/api/mcp",
  headers: { Authorization: "Bearer secret-token" },
  authorization: "secret-oauth",
};

const shellTool = {
  type: "shell",
  skills: [{ name: "pdf", description: "Read PDFs.", path: "/skills/pdf" }],
  stagedSkills: [
    { skillId: "s1", slug: "pdf", description: "Read PDFs.", resolveFiles: neverCalled, onRead: neverCalled },
  ],
  execute: neverCalled,
} as unknown as LlmTool;

const containerTool: LlmTool = {
  type: "container_skills",
  skills: [
    { skillId: "skill_a", version: "1", catalogSkillId: "cat-a" },
    { skillId: "skill_b", version: "latest" },
  ],
};

const sandboxTool = {
  type: "sandbox_execution",
  toolName: "sandbox_execute",
  description: "Run commands.",
  execute: neverCalled,
} as unknown as LlmTool;

const webSearch: LlmTool = { type: "web_search" };

describe("toolReferenceOf", () => {
  it("returns the caller-owned identity of each kind and nothing else", () => {
    expect(toolReferenceOf(functionTool)).toEqual({ type: "function", name: "list_runs" });
    expect(toolReferenceOf({ ...(functionTool as object), type: "function" } as unknown as LlmTool)).toEqual({
      type: "function",
      name: "list_runs",
    });
    expect(toolReferenceOf(mcpTool)).toEqual({ type: "mcp", serverLabel: "cinatra" });
    expect(toolReferenceOf(shellTool)).toEqual({ type: "shell" });
    expect(toolReferenceOf(containerTool)).toEqual({ type: "container_skills" });
    expect(toolReferenceOf(sandboxTool)).toEqual({ type: "sandbox_execution" });
    expect(toolReferenceOf(webSearch)).toEqual({ type: "web_search" });
  });

  it("refuses an unknown tool kind as assembly_failed", () => {
    expect(() => toolReferenceOf({ type: "computer_use" } as unknown as LlmTool)).toThrow(
      expect.objectContaining({ code: "assembly_failed" }),
    );
  });
});

describe("projectToolForManifest", () => {
  it("projects a function tool to type, name, description and parameters", () => {
    expect(projectToolForManifest(functionTool)).toEqual({
      type: "function",
      name: "list_runs",
      description: "List the runs.",
      parameters: { type: "object", properties: { limit: { type: "number" } }, required: [] },
    });
  });

  it("projects an mcp tool with the named defaults and never the headers or authorization", () => {
    const projected = projectToolForManifest(mcpTool);
    expect(projected).toEqual({
      type: "mcp",
      serverLabel: "cinatra",
      serverUrl: "https://instance.example/api/mcp",
      serverDescription: null,
      allowedTools: null,
      approval: "auto_execute",
      transport: "unknown",
    });
    const text = JSON.stringify(projected);
    expect(text).not.toContain("secret-token");
    expect(text).not.toContain("secret-oauth");
  });

  it("keeps the given mcp approval, transport and allowed tools", () => {
    expect(
      projectToolForManifest({
        ...(mcpTool as object),
        serverDescription: "The instance.",
        allowedTools: ["a", "b"],
        approval: "approval_required",
        transport: "streamable-http",
      } as unknown as LlmTool),
    ).toMatchObject({
      serverDescription: "The instance.",
      allowedTools: ["a", "b"],
      approval: "approval_required",
      transport: "streamable-http",
    });
  });

  it("projects a shell tool's skills and staged skills, in order, without their functions", () => {
    expect(projectToolForManifest(shellTool)).toEqual({
      type: "shell",
      skills: [{ name: "pdf", description: "Read PDFs.", path: "/skills/pdf" }],
      stagedSkills: [{ skillId: "s1", slug: "pdf", description: "Read PDFs." }],
    });
  });

  it("writes an absent stagedSkills as null", () => {
    expect(projectToolForManifest(sandboxTool)).toEqual({
      type: "sandbox_execution",
      toolName: "sandbox_execute",
      description: "Run commands.",
      stagedSkills: null,
    });
  });

  it("projects container skills with an absent catalogSkillId as null", () => {
    expect(projectToolForManifest(containerTool)).toEqual({
      type: "container_skills",
      skills: [
        { skillId: "skill_a", version: "1", catalogSkillId: "cat-a" },
        { skillId: "skill_b", version: "latest", catalogSkillId: null },
      ],
    });
  });

  it("projects web_search to its type", () => {
    expect(projectToolForManifest(webSearch)).toEqual({ type: "web_search" });
  });

  it("never calls an executable member", () => {
    for (const tool of [functionTool, shellTool, sandboxTool]) {
      expect(() => projectToolForManifest(tool)).not.toThrow();
    }
  });

  it("refuses an unknown tool kind as assembly_failed", () => {
    expect(() => projectToolForManifest({ type: "computer_use" } as unknown as LlmTool)).toThrow(
      expect.objectContaining({ code: "assembly_failed" }),
    );
  });
});

describe("buildToolManifestReport", () => {
  it("returns one entry per tool, in order, with the HMAC of the canonical projection", () => {
    const tools = [mcpTool, webSearch, functionTool];
    const report = buildToolManifestReport({ conversationOnly: false, tools, key: KEY });
    expect(report.conversationOnly).toBe(false);
    expect(report.tools.map((t) => t.ref)).toEqual([
      { type: "mcp", serverLabel: "cinatra" },
      { type: "web_search" },
      { type: "function", name: "list_runs" },
    ]);
    report.tools.forEach((entry, i) => {
      expect(Object.keys(entry).sort()).toEqual(["ref", "schemaHash"]);
      expect(entry.schemaHash).toBe(hmac(canonicalizeJson(projectToolForManifest(tools[i]!))));
      expect(entry.schemaHash).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
    });
    expect(report.manifestHash).toBe(
      hmac(canonicalizeJson({ conversationOnly: false, tools: report.tools })),
    );
  });

  it("gives equal hashes for equal tool lists and different ones for a changed schema", () => {
    const a = buildToolManifestReport({ conversationOnly: false, tools: [functionTool], key: KEY });
    const b = buildToolManifestReport({ conversationOnly: false, tools: [functionTool], key: KEY });
    expect(b).toEqual(a);
    const changed = {
      ...(functionTool as object),
      parameters: { type: "object", properties: { limit: { type: "string" } }, required: [] },
    } as unknown as LlmTool;
    const c = buildToolManifestReport({ conversationOnly: false, tools: [changed], key: KEY });
    expect(c.tools[0]!.schemaHash).not.toBe(a.tools[0]!.schemaHash);
    expect(c.manifestHash).not.toBe(a.manifestHash);
  });

  it("does not depend on the key order of a schema", () => {
    const reordered = {
      ...(functionTool as object),
      parameters: { required: [], properties: { limit: { type: "number" } }, type: "object" },
    } as unknown as LlmTool;
    const a = buildToolManifestReport({ conversationOnly: false, tools: [functionTool], key: KEY });
    const b = buildToolManifestReport({ conversationOnly: false, tools: [reordered], key: KEY });
    expect(b.manifestHash).toBe(a.manifestHash);
  });

  it("depends on the tool order", () => {
    const a = buildToolManifestReport({ conversationOnly: false, tools: [mcpTool, webSearch], key: KEY });
    const b = buildToolManifestReport({ conversationOnly: false, tools: [webSearch, mcpTool], key: KEY });
    expect(b.manifestHash).not.toBe(a.manifestHash);
  });

  it("does not hash the mcp headers: a changed bearer gives the same report", () => {
    const other = { ...(mcpTool as object), headers: { Authorization: "Bearer other" } } as unknown as LlmTool;
    const a = buildToolManifestReport({ conversationOnly: false, tools: [mcpTool], key: KEY });
    const b = buildToolManifestReport({ conversationOnly: false, tools: [other], key: KEY });
    expect(b).toEqual(a);
  });

  it("returns no tools for a conversation-only provider", () => {
    const report = buildToolManifestReport({ conversationOnly: true, tools: [webSearch], key: KEY });
    expect(report.tools).toEqual([]);
    expect(report.manifestHash).toBe(hmac(canonicalizeJson({ conversationOnly: true, tools: [] })));
  });

  it("hashes with the given key only: another key gives other hashes", () => {
    const a = buildToolManifestReport({ conversationOnly: false, tools: [webSearch], key: KEY });
    const b = buildToolManifestReport({
      conversationOnly: false,
      tools: [webSearch],
      key: Buffer.alloc(32, 9),
    });
    expect(b.manifestHash).not.toBe(a.manifestHash);
  });

  it("refuses a key that is not 32 bytes", () => {
    expect(() =>
      buildToolManifestReport({ conversationOnly: false, tools: [], key: Buffer.alloc(16) }),
    ).toThrow(expect.objectContaining({ code: "assembly_failed" }));
  });

  it("maps an unserializable schema to tool_unserializable", () => {
    const bad = {
      ...(functionTool as object),
      parameters: { type: "object", properties: { n: { default: Number.NaN } } },
    } as unknown as LlmTool;
    expect(() =>
      buildToolManifestReport({ conversationOnly: false, tools: [bad], key: KEY }),
    ).toThrow(expect.objectContaining({ code: "tool_unserializable" }));
  });

  it("throws a ToolManifestError for an unknown kind", () => {
    expect(() =>
      buildToolManifestReport({
        conversationOnly: false,
        tools: [{ type: "computer_use" } as unknown as LlmTool],
        key: KEY,
      }),
    ).toThrow(ToolManifestError);
  });
});

describe("createToolManifestHashKey", () => {
  it("makes 32 random bytes per call", () => {
    const a = createToolManifestHashKey();
    const b = createToolManifestHashKey();
    expect(a).toHaveLength(32);
    expect(b).toHaveLength(32);
    expect(a.equals(b)).toBe(false);
  });
});

it("pins the manifest version", () => {
  expect(TOOL_MANIFEST_VERSION).toBe(1);
});
