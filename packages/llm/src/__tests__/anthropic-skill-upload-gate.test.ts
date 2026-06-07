// Fail-closed governance gate regression locks.
//
// The single allow path is: global opt-in === true AND per-skill
// allowAnthropicUpload === true (both strict primitives). EVERY other input —
// global OFF, per-skill unset/false/truthy-but-not-true, malformed skill,
// non-true globalEnabled — MUST deny, and the gate MUST NEVER throw. This
// proves the decision core is fail-closed before any upload path can use it.

import { describe, expect, it } from "vitest";

import {
  isAnthropicSkillUploadAllowed,
  defaultAnthropicSkillUploadGate,
} from "../tools/anthropic-skill-upload-gate";

describe("Global opt-in default OFF gates everything", () => {
  it("global OFF + per-skill flag true → DENY", () => {
    expect(isAnthropicSkillUploadAllowed({ allowAnthropicUpload: true }, false)).toBe(false);
  });

  it("global OFF + per-skill flag absent → DENY", () => {
    expect(isAnthropicSkillUploadAllowed({}, false)).toBe(false);
  });

  it("non-true globalEnabled values all DENY (fail-closed, default OFF)", () => {
    for (const g of [undefined, null, 0, 1, "true", "on", {}, []]) {
      expect(
        isAnthropicSkillUploadAllowed({ allowAnthropicUpload: true }, g as unknown),
      ).toBe(false);
    }
  });
});

describe("Per-skill flag honored even when global ON", () => {
  it("global ON + per-skill flag absent/undefined/null/false → DENY", () => {
    expect(isAnthropicSkillUploadAllowed({}, true)).toBe(false);
    expect(isAnthropicSkillUploadAllowed({ allowAnthropicUpload: undefined }, true)).toBe(false);
    expect(
      isAnthropicSkillUploadAllowed({ allowAnthropicUpload: null as unknown as boolean }, true),
    ).toBe(false);
    expect(isAnthropicSkillUploadAllowed({ allowAnthropicUpload: false }, true)).toBe(false);
  });

  it("global ON + per-skill truthy-but-not-true → DENY (strict primitive)", () => {
    for (const v of ["true", 1, "1", {}, [], "yes"]) {
      expect(
        isAnthropicSkillUploadAllowed({ allowAnthropicUpload: v as unknown as boolean }, true),
      ).toBe(false);
    }
  });

  it("global ON + per-skill allowAnthropicUpload === true → ALLOW (the ONLY allow path)", () => {
    expect(isAnthropicSkillUploadAllowed({ allowAnthropicUpload: true }, true)).toBe(true);
    expect(
      isAnthropicSkillUploadAllowed(
        { allowAnthropicUpload: true, catalogSkillId: "skill_x" } as unknown,
        true,
      ),
    ).toBe(true);
  });
});

describe("Malformed input denies, never throws", () => {
  it("malformed skill arg → DENY without throwing", () => {
    for (const s of [undefined, null, "x", 42, true, Symbol("s") as unknown]) {
      expect(() => isAnthropicSkillUploadAllowed(s as unknown, true)).not.toThrow();
      expect(isAnthropicSkillUploadAllowed(s as unknown, true)).toBe(false);
    }
  });

  it("hostile object with a throwing getter → DENY without throwing", () => {
    const hostile = {};
    Object.defineProperty(hostile, "allowAnthropicUpload", {
      get() {
        throw new Error("malicious getter");
      },
      enumerable: true,
    });
    expect(() => isAnthropicSkillUploadAllowed(hostile, true)).not.toThrow();
    expect(isAnthropicSkillUploadAllowed(hostile, true)).toBe(false);
  });

  it("Proxy with a throwing get trap → DENY without throwing", () => {
    const trapped = new Proxy(
      {},
      {
        get() {
          throw new Error("trap");
        },
      },
    );
    expect(() => isAnthropicSkillUploadAllowed(trapped, true)).not.toThrow();
    expect(isAnthropicSkillUploadAllowed(trapped, true)).toBe(false);
  });

  it("no arguments at all → DENY without throwing", () => {
    // @ts-expect-error — intentionally calling with no args to prove fail-closed.
    expect(() => isAnthropicSkillUploadAllowed()).not.toThrow();
    // @ts-expect-error — intentionally calling with no args to prove fail-closed.
    expect(isAnthropicSkillUploadAllowed()).toBe(false);
  });
});

describe("Default gate instance delegates identically", () => {
  it("defaultAnthropicSkillUploadGate.isUploadAllowed matches the pure fn", () => {
    expect(
      defaultAnthropicSkillUploadGate.isUploadAllowed({ allowAnthropicUpload: true }, true),
    ).toBe(true);
    expect(
      defaultAnthropicSkillUploadGate.isUploadAllowed({ allowAnthropicUpload: true }, false),
    ).toBe(false);
    expect(
      defaultAnthropicSkillUploadGate.isUploadAllowed({ allowAnthropicUpload: false }, true),
    ).toBe(false);
    expect(defaultAnthropicSkillUploadGate.isUploadAllowed(null, true)).toBe(false);
  });
});
