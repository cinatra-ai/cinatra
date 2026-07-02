import { describe, it, expect } from "vitest";
import {
  isHostedMcpToolListError,
  extractMcpServerUrl,
  buildMcpUnreachableMessage,
} from "./openai-mcp-error";

describe("isHostedMcpToolListError (#500)", () => {
  it("flags the raw OpenAI hosted-MCP 424 (status + MCP marker)", () => {
    expect(
      isHostedMcpToolListError(
        new Error(
          "Error retrieving tool list from MCP server: 'cinatra'. Http status code: 424 (Failed Dependency)",
        ),
      ),
    ).toBe(true);
  });

  it("accepts a non-Error value (caught unknown) and stringifies it", () => {
    expect(isHostedMcpToolListError("424 Failed Dependency from the MCP server")).toBe(true);
  });

  it("recognizes our own typed replacement message (so the UI detector agrees)", () => {
    expect(isHostedMcpToolListError(new Error(buildMcpUnreachableMessage()))).toBe(true);
  });

  it("does NOT fire on an unrelated 424 with no MCP marker", () => {
    expect(isHostedMcpToolListError(new Error("424 Failed Dependency uploading file"))).toBe(false);
  });

  it("does NOT fire on an MCP-mentioning error that is not a 424", () => {
    expect(isHostedMcpToolListError(new Error("MCP server returned 500 Internal Server Error"))).toBe(
      false,
    );
  });

  it("does not match '424' embedded in a larger number (word boundary)", () => {
    expect(isHostedMcpToolListError(new Error("request id 142420 to the mcp server failed"))).toBe(
      false,
    );
  });
});

describe("extractMcpServerUrl (#500)", () => {
  it("returns the server_url of the mcp tool entry", () => {
    const tools = [
      { type: "function", name: "x" },
      { type: "mcp", server_label: "cinatra", server_url: "https://inst.example.com/api/mcp" },
    ];
    expect(extractMcpServerUrl(tools)).toBe("https://inst.example.com/api/mcp");
  });

  it("returns undefined when there is no mcp tool", () => {
    expect(extractMcpServerUrl([{ type: "function", name: "x" }])).toBeUndefined();
  });

  it("returns undefined when the mcp tool carries no server_url", () => {
    expect(extractMcpServerUrl([{ type: "mcp", server_label: "cinatra" }])).toBeUndefined();
  });

  it("returns undefined for a non-array tools payload", () => {
    expect(extractMcpServerUrl(undefined)).toBeUndefined();
    expect(extractMcpServerUrl({})).toBeUndefined();
  });
});

describe("buildMcpUnreachableMessage (#500)", () => {
  it("names the unreachable URL when provided and stays detectable (424 + MCP)", () => {
    const msg = buildMcpUnreachableMessage("https://inst.example.com/api/mcp");
    expect(msg).toContain("https://inst.example.com/api/mcp");
    expect(isHostedMcpToolListError(msg)).toBe(true);
  });

  it("omits the URL clause when none is known, still detectable", () => {
    const msg = buildMcpUnreachableMessage();
    expect(msg).not.toContain(" at ");
    expect(isHostedMcpToolListError(msg)).toBe(true);
  });
});
