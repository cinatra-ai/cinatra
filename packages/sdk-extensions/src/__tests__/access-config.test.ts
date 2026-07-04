import { describe, it, expect } from "vitest";

import {
  CONNECTOR_ACCESS_SCOPES,
  ConnectorAccessConfigError,
  connectorAccessSlugFromPackageName,
  parseConnectorAccessConfig,
  resolveAbsentConnectorAccessConfig,
  isResolvedConnectorAccessDeclaration,
} from "../access-config";

const PKG = { packageName: "@cinatra-ai/github-connector" };
const wrap = (scope: Record<string, unknown>) => ({
  formatVersion: 1,
  access: { scope },
});

describe("connectorAccessSlugFromPackageName — canonical normalizer", () => {
  it("normalizes every accepted shape to the bare slug", () => {
    expect(connectorAccessSlugFromPackageName("@cinatra-ai/openai-connector")).toBe("openai");
    expect(connectorAccessSlugFromPackageName("openai-connector")).toBe("openai");
    expect(connectorAccessSlugFromPackageName("openai")).toBe("openai");
    expect(connectorAccessSlugFromPackageName("@acme/acme-crm-connector")).toBe("acme-crm");
  });
});

describe("parseConnectorAccessConfig — declared files", () => {
  it("accepts every vocabulary token for default", () => {
    for (const scope of CONNECTOR_ACCESS_SCOPES) {
      const out = parseConnectorAccessConfig(wrap({ default: scope }), PKG);
      expect(out).toEqual({ formatVersion: 1, mode: "default", scope, source: "declared" });
    }
  });

  it("accepts every vocabulary token for only", () => {
    for (const scope of CONNECTOR_ACCESS_SCOPES) {
      const out = parseConnectorAccessConfig(wrap({ only: scope }), PKG);
      expect(out).toEqual({ formatVersion: 1, mode: "only", scope, source: "declared" });
    }
  });

  it("throws on non-object top level", () => {
    for (const raw of [null, [], "x", 42, undefined]) {
      expect(() => parseConnectorAccessConfig(raw, PKG)).toThrow(ConnectorAccessConfigError);
    }
  });

  it("throws on missing / wrong / non-1 formatVersion (unknown future version fails closed)", () => {
    expect(() => parseConnectorAccessConfig({ access: { scope: { default: "user" } } }, PKG)).toThrow(
      ConnectorAccessConfigError,
    );
    expect(() =>
      parseConnectorAccessConfig({ formatVersion: 2, access: { scope: { default: "user" } } }, PKG),
    ).toThrow(ConnectorAccessConfigError);
    expect(() =>
      parseConnectorAccessConfig({ formatVersion: "1", access: { scope: { default: "user" } } }, PKG),
    ).toThrow(ConnectorAccessConfigError);
  });

  it("hard-fails an unknown TOP-LEVEL domain (fail-closed)", () => {
    expect(() =>
      parseConnectorAccessConfig(
        { formatVersion: 1, access: { scope: { default: "user" } }, telemetry: {} },
        PKG,
      ),
    ).toThrow(ConnectorAccessConfigError);
  });

  it("hard-fails unknown keys INSIDE known domains (the misspelled-nested-key case)", () => {
    // misspelled `scpoe` inside access — must NEVER silently fall back
    expect(() =>
      parseConnectorAccessConfig({ formatVersion: 1, access: { scpoe: { default: "user" } } }, PKG),
    ).toThrow(ConnectorAccessConfigError);
    // misspelled `defualt` inside access.scope
    expect(() => parseConnectorAccessConfig(wrap({ defualt: "user" }), PKG)).toThrow(
      ConnectorAccessConfigError,
    );
    // an extra sibling key next to a valid one
    expect(() => parseConnectorAccessConfig(wrap({ default: "user", extra: 1 }), PKG)).toThrow(
      ConnectorAccessConfigError,
    );
  });

  it("hard-fails both default AND only present (XOR)", () => {
    expect(() => parseConnectorAccessConfig(wrap({ default: "user", only: "admin" }), PKG)).toThrow(
      /EXACTLY ONE/,
    );
  });

  it("hard-fails neither default nor only present (XOR)", () => {
    expect(() => parseConnectorAccessConfig(wrap({}), PKG)).toThrow(/EXACTLY ONE/);
  });

  it("hard-fails a non-vocabulary scope token", () => {
    expect(() => parseConnectorAccessConfig(wrap({ default: "app" }), PKG)).toThrow(
      ConnectorAccessConfigError,
    );
    expect(() => parseConnectorAccessConfig(wrap({ only: "everyone" }), PKG)).toThrow(
      ConnectorAccessConfigError,
    );
  });

  it("resolves a valid file with absent access / absent access.scope to default:admin", () => {
    expect(parseConnectorAccessConfig({ formatVersion: 1 }, PKG)).toEqual({
      formatVersion: 1,
      mode: "default",
      scope: "admin",
      source: "declared",
    });
    expect(parseConnectorAccessConfig({ formatVersion: 1, access: {} }, PKG)).toEqual({
      formatVersion: 1,
      mode: "default",
      scope: "admin",
      source: "declared",
    });
  });
});

describe("parseConnectorAccessConfig — protected slugs (validator-forced)", () => {
  const protectedPkgs = [
    "@cinatra-ai/openai-connector",
    "@cinatra-ai/anthropic-connector",
    "@cinatra-ai/gemini-connector",
  ];

  it("accepts exactly only:admin for each protected slug", () => {
    for (const packageName of protectedPkgs) {
      const out = parseConnectorAccessConfig(wrap({ only: "admin" }), { packageName });
      expect(out).toMatchObject({ mode: "only", scope: "admin", source: "declared" });
    }
  });

  it("hard-fails a protected slug declaring anything else (incl. default:admin)", () => {
    for (const packageName of protectedPkgs) {
      expect(() => parseConnectorAccessConfig(wrap({ default: "admin" }), { packageName })).toThrow(
        /protected slug/,
      );
      expect(() => parseConnectorAccessConfig(wrap({ only: "workspace" }), { packageName })).toThrow(
        /protected slug/,
      );
      expect(() => parseConnectorAccessConfig(wrap({ default: "user" }), { packageName })).toThrow(
        /protected slug/,
      );
    }
  });

  it("hard-fails a protected slug shipping a scope-less (yet valid) file", () => {
    expect(() =>
      parseConnectorAccessConfig({ formatVersion: 1 }, { packageName: "@cinatra-ai/openai-connector" }),
    ).toThrow(/protected slug/);
  });

  it("does NOT force gmail in W1 (default:user is the W4 fleet-final, not validator-forced)", () => {
    const out = parseConnectorAccessConfig(wrap({ default: "admin" }), {
      packageName: "@cinatra-ai/gmail-connector",
    });
    expect(out).toMatchObject({ mode: "default", scope: "admin" });
  });
});

describe("resolveAbsentConnectorAccessConfig — absence rule per surface", () => {
  it("resolves default:admin for a non-protected slug at both surfaces", () => {
    for (const surface of ["submit", "install"] as const) {
      expect(resolveAbsentConnectorAccessConfig({ packageName: PKG.packageName, surface })).toEqual({
        formatVersion: 1,
        mode: "default",
        scope: "admin",
        source: "absent",
      });
    }
  });

  it("hard-fails a protected slug at SUBMIT (the file is required)", () => {
    expect(() =>
      resolveAbsentConnectorAccessConfig({
        packageName: "@cinatra-ai/anthropic-connector",
        surface: "submit",
      }),
    ).toThrow(/absence is not accepted at submit/);
  });

  it("resolves the FORCED only:admin (never looser) for a protected slug at INSTALL", () => {
    expect(
      resolveAbsentConnectorAccessConfig({
        packageName: "@cinatra-ai/anthropic-connector",
        surface: "install",
      }),
    ).toEqual({ formatVersion: 1, mode: "only", scope: "admin", source: "absent" });
  });
});

describe("isResolvedConnectorAccessDeclaration — persisted-value guard", () => {
  it("accepts a well-formed resolved declaration", () => {
    expect(
      isResolvedConnectorAccessDeclaration({
        formatVersion: 1,
        mode: "only",
        scope: "admin",
        source: "absent",
      }),
    ).toBe(true);
  });

  it("rejects malformed persisted values (wrong mode/scope/source/extra keys)", () => {
    expect(isResolvedConnectorAccessDeclaration(null)).toBe(false);
    expect(isResolvedConnectorAccessDeclaration([])).toBe(false);
    expect(
      isResolvedConnectorAccessDeclaration({ formatVersion: 1, mode: "x", scope: "admin", source: "absent" }),
    ).toBe(false);
    expect(
      isResolvedConnectorAccessDeclaration({ formatVersion: 1, mode: "only", scope: "app", source: "absent" }),
    ).toBe(false);
    expect(
      isResolvedConnectorAccessDeclaration({ formatVersion: 1, mode: "only", scope: "admin", source: "later" }),
    ).toBe(false);
    expect(
      isResolvedConnectorAccessDeclaration({
        formatVersion: 1,
        mode: "only",
        scope: "admin",
        source: "absent",
        extra: 1,
      }),
    ).toBe(false);
    expect(
      isResolvedConnectorAccessDeclaration({ formatVersion: 2, mode: "only", scope: "admin", source: "absent" }),
    ).toBe(false);
  });
});
