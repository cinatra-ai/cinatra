import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compileOasAgentJson } from "../../../packages/agents/src/oas-compiler";

describe("private screenshot execution fixture", () => {
  it("compiles with the host and preserves the producer declaration used after execution", async () => {
    const root = path.resolve("tests/fixtures/screenshot-producer-agent/codex-widget-proof/screenshot-proof");
    const source = path.join(root, "cinatra/oas.json");
    const result = await compileOasAgentJson({
      packageName: "@codex-widget-proof/screenshot-proof", oasSourcePath: source,
    });
    expect(result.ok, result.ok ? undefined : result.error).toBe(true);
    if (!result.ok) return;
    expect(result.value.inputSchema).toMatchObject({ properties: { capture_url: { type: "string" } } });
    expect(result.value.artifactBindings).toMatchObject({
      producesRefs: [{ extension: "@cinatra-ai/screenshot-artifact" }],
    });
    const marker = JSON.parse(await readFile(path.join(root, ".cinatra-published.json"), "utf8"));
    expect(marker.oasSha256).toBe(createHash("sha256").update(await readFile(source)).digest("hex"));
  });
});
