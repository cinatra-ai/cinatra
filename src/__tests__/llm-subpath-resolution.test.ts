// Subpath continuity smoke for the @cinatra-ai/llm package. Confirms each
// declared subpath resolves at runtime and exports a non-undefined leaf.
//
// Plain `pnpm typecheck` does not prove module-resolution at runtime; this
// suite forces an `await import()` per subpath so a broken `exports` map or
// missing shim file would fail immediately under `pnpm vitest`.

import { describe, it, expect } from "vitest";

describe("llm subpath resolution", () => {
  it("resolves @cinatra-ai/llm/actor-context subpath", async () => {
    const mod = await import("@cinatra-ai/llm/actor-context");
    expect(typeof mod.withActorContext).toBe("function");
    expect(typeof mod.getActorContext).toBe("function");
  });

  it("resolves @cinatra-ai/llm/anthropic-log-directory subpath", async () => {
    const mod = await import("@cinatra-ai/llm/anthropic-log-directory");
    expect(mod).toBeTruthy();
  });

  it("resolves @cinatra-ai/llm/anthropic-logging-state subpath", async () => {
    const mod = await import("@cinatra-ai/llm/anthropic-logging-state");
    expect(mod).toBeTruthy();
  });

  it("resolves @cinatra-ai/llm/openai-model-capabilities subpath", async () => {
    const mod = await import("@cinatra-ai/llm/openai-model-capabilities");
    expect(typeof mod.openAiModelSupportsShell).toBe("function");
    expect(mod.OPENAI_SHELL_INCOMPATIBLE_MODEL_IDS.has("gpt-5")).toBe(true);
  });
});
