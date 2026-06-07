// App-layer governance wrapper fail-closed invariants.
//
// The pure decision gate is exhaustively tested in the llm
// package (anthropic-skill-upload-gate.test.ts). THIS test isolates the app
// wrapper's sole responsibility: read the default-OFF global opt-in and, on
// ANY read error, fail closed (treat as OFF) before delegating. The root
// vitest aliases @cinatra-ai/llm to a narrow actor-context stub
// (not the full index), so we mock the pure gate to assert exactly what
// globalEnabled the wrapper passes it.

import { afterEach, describe, expect, it, vi } from "vitest";

const readGlobal = vi.fn<(...args: never[]) => boolean>();
const pureGate = vi.fn<(skill: unknown, globalEnabled: unknown) => boolean>();

// The wrapper imports `@/lib/database` (the path alias). Root vitest rewrites
// that alias to a no-op stub lacking our symbol, so we mock the alias
// specifier itself to control the global opt-in read.
vi.mock("@/lib/database", () => ({
  readAnthropicSkillSyncEnabledFromDatabase: () => readGlobal(),
}));

vi.mock("@cinatra-ai/llm", () => ({
  isAnthropicSkillUploadAllowed: (skill: unknown, globalEnabled: unknown) =>
    pureGate(skill, globalEnabled),
}));

// Imported after the mocks are registered.
const { isAnthropicSkillUploadAllowedFromConfig } = await import(
  "../anthropic-skill-upload-governance"
);

afterEach(() => {
  readGlobal.mockReset();
  pureGate.mockReset();
});

describe("wrapper resolves default-OFF global opt-in", () => {
  it("DB read true → delegates with globalEnabled=true", () => {
    readGlobal.mockReturnValue(true);
    pureGate.mockReturnValue(true);
    const result = isAnthropicSkillUploadAllowedFromConfig({ allowAnthropicUpload: true });
    expect(result).toBe(true);
    expect(pureGate).toHaveBeenCalledWith({ allowAnthropicUpload: true }, true);
  });

  it("DB read false → delegates with globalEnabled=false (default OFF)", () => {
    readGlobal.mockReturnValue(false);
    pureGate.mockReturnValue(false);
    const result = isAnthropicSkillUploadAllowedFromConfig({ allowAnthropicUpload: true });
    expect(result).toBe(false);
    expect(pureGate).toHaveBeenCalledWith({ allowAnthropicUpload: true }, false);
  });

  it("DB read non-true value → coerced to globalEnabled=false (fail-closed)", () => {
    // The wrapper does `=== true`; a stubbed non-boolean still resolves OFF.
    readGlobal.mockReturnValue("true" as unknown as boolean);
    pureGate.mockReturnValue(false);
    isAnthropicSkillUploadAllowedFromConfig({ allowAnthropicUpload: true });
    expect(pureGate).toHaveBeenCalledWith({ allowAnthropicUpload: true }, false);
  });
});

describe("wrapper fails closed on DB read error", () => {
  it("DB reader throws → globalEnabled=false, no exception escapes", () => {
    readGlobal.mockImplementation(() => {
      throw new Error("postgres unavailable");
    });
    pureGate.mockReturnValue(false);
    let result: boolean | undefined;
    expect(() => {
      result = isAnthropicSkillUploadAllowedFromConfig({ allowAnthropicUpload: true });
    }).not.toThrow();
    expect(result).toBe(false);
    expect(pureGate).toHaveBeenCalledWith({ allowAnthropicUpload: true }, false);
  });
});
