import { describe, it, expect } from "vitest";

// cinatra#1927 — the generic, KIND-AGNOSTIC `protected` declaration domain.
// Four things are pinned here:
//   1. the flag's own SCHEMA validation (absent / true / false / non-boolean),
//   2. that BOTH file-level parsers of `cinatra/config.json` accept the key
//      structurally (an assistant AND a connector may declare protection),
//   3. that the fail-closed unknown-top-level-key contract is UNCHANGED (adding
//      one known domain must not open the file schema up), and
//   4. that the domain is generic — nothing here is assistant-specific.

import {
  EXTENSION_PROTECTION_KEY,
  ExtensionProtectionDeclarationError,
  safeParseDeclaredProtection,
  parseDeclaredProtection,
  hasProtectionDeclaration,
} from "../extension-protection";
import { safeParseAssistantDeclaration } from "../assistant-declaration";
import { parseConnectorAccessConfig, ConnectorAccessConfigError } from "../access-config";

const PKG = "@acme/example-extension";

const ASSISTANT_BLOCK = {
  abiVersion: 1,
  displayName: "Example",
  preferredTag: "example",
  persona: "You are an example assistant.",
  skillBundle: ["chat-assistant-core"],
  launch: { kind: "local" },
  delivery: { kind: "host-runtime" },
};

describe("extension-protection — the flag's schema validation", () => {
  it("resolves FALSE when the key is absent (today's state of every package)", () => {
    expect(safeParseDeclaredProtection({ formatVersion: 1 }, { packageName: PKG })).toEqual({
      ok: true,
      protected: false,
    });
    expect(parseDeclaredProtection({ formatVersion: 1 }, { packageName: PKG })).toBe(false);
  });

  it("resolves the declared boolean for true AND false", () => {
    expect(parseDeclaredProtection({ formatVersion: 1, protected: true }, { packageName: PKG })).toBe(true);
    expect(parseDeclaredProtection({ formatVersion: 1, protected: false }, { packageName: PKG })).toBe(false);
  });

  it("treats an explicit `undefined` as absent", () => {
    expect(
      parseDeclaredProtection({ formatVersion: 1, protected: undefined }, { packageName: PKG }),
    ).toBe(false);
  });

  it.each([
    ["a truthy STRING", "true"],
    ["a truthy NUMBER", 1],
    ["a falsy NUMBER", 0],
    ["an object", { value: true }],
    ["an array", [true]],
    ["null", null],
  ])("FAILS CLOSED on %s — never coerced", (_label, value) => {
    const result = safeParseDeclaredProtection(
      { formatVersion: 1, [EXTENSION_PROTECTION_KEY]: value },
      { packageName: PKG },
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("must be a boolean");
    expect(() =>
      parseDeclaredProtection({ formatVersion: 1, protected: value }, { packageName: PKG }),
    ).toThrow(ExtensionProtectionDeclarationError);
  });

  it("never owns the top-level shape — a non-object declares nothing", () => {
    for (const raw of [null, undefined, 42, "x", [1, 2]]) {
      expect(safeParseDeclaredProtection(raw, { packageName: PKG })).toEqual({
        ok: true,
        protected: false,
      });
    }
  });

  it("hasProtectionDeclaration is a presence probe, not a validator", () => {
    expect(hasProtectionDeclaration({ protected: "not-a-boolean" })).toBe(true);
    expect(hasProtectionDeclaration({ protected: undefined })).toBe(false);
    expect(hasProtectionDeclaration({})).toBe(false);
    expect(hasProtectionDeclaration(null)).toBe(false);
  });
});

describe("extension-protection — accepted by BOTH file-level parsers (generic domain)", () => {
  it("an ASSISTANT declaration carrying `protected: true` still parses", () => {
    const raw = { formatVersion: 1, protected: true, assistant: ASSISTANT_BLOCK };
    const result = safeParseAssistantDeclaration(raw, { packageName: PKG });
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.declaration?.block.displayName).toBe("Example");
    // …and the generic domain parser reads the flag off the SAME file.
    expect(parseDeclaredProtection(raw, { packageName: PKG })).toBe(true);
  });

  it("a CONNECTOR access config carrying `protected: true` still parses (kind-agnostic)", () => {
    const raw = { formatVersion: 1, protected: true, access: { scope: { default: "user" } } };
    expect(() => parseConnectorAccessConfig(raw, { packageName: "@acme/example-connector" })).not.toThrow();
    expect(parseDeclaredProtection(raw, { packageName: "@acme/example-connector" })).toBe(true);
  });

  it("a package with NO assistant block may still declare protection", () => {
    const raw = { formatVersion: 1, protected: true };
    const result = safeParseAssistantDeclaration(raw, { packageName: PKG });
    expect(result).toEqual({ ok: true, declaration: null });
    expect(parseDeclaredProtection(raw, { packageName: PKG })).toBe(true);
  });
});

describe("extension-protection — the fail-closed file contract is UNCHANGED", () => {
  it("an unknown top-level key still hard-fails in the assistant parser", () => {
    const result = safeParseAssistantDeclaration(
      { formatVersion: 1, protectedd: true, assistant: ASSISTANT_BLOCK },
      { packageName: PKG },
    );
    expect(result.ok).toBe(false);
  });

  it("an unknown top-level key still hard-fails in the connector parser", () => {
    expect(() =>
      parseConnectorAccessConfig(
        { formatVersion: 1, protectd: true, access: { scope: { default: "user" } } },
        { packageName: "@acme/example-connector" },
      ),
    ).toThrow(ConnectorAccessConfigError);
  });

  it("a NON-boolean `protected` is accepted structurally by neither file parser", () => {
    // Both file schemas share the SAME boolean schema by reference, so a
    // malformed flag is refused at the file level too — not only by the domain
    // parser. (Fail-closed at every surface.)
    expect(
      safeParseAssistantDeclaration(
        { formatVersion: 1, protected: "true", assistant: ASSISTANT_BLOCK },
        { packageName: PKG },
      ).ok,
    ).toBe(false);
    expect(() =>
      parseConnectorAccessConfig(
        { formatVersion: 1, protected: "true", access: { scope: { default: "user" } } },
        { packageName: "@acme/example-connector" },
      ),
    ).toThrow(ConnectorAccessConfigError);
  });
});
