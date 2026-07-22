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

  // The `./anthropic-log-directory` and `./anthropic-logging-state` subpaths
  // were removed with the anthropic adapter+telemetry relocation (cinatra#1715);
  // the anthropic log directory + logging-enabled flag are now connector-owned
  // (surface `logDirectory` / persisted `anthropic-logging` config authority).

  it("resolves @cinatra-ai/llm/openai-model-capabilities subpath", async () => {
    const mod = await import("@cinatra-ai/llm/openai-model-capabilities");
    expect(typeof mod.openAiModelSupportsShell).toBe("function");
    expect(mod.OPENAI_SHELL_INCOMPATIBLE_MODEL_IDS.has("gpt-5")).toBe(true);
  });
});
