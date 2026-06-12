// Pins the #179 regression at the options-shape level: npm-registry-fetch
// (pacote's HTTP layer) resolves credentials ONLY from registry-scoped
// '//<host>/:_authToken' keys (or forceAuth) — a flat `token` option is
// silently ignored and produces requests with NO Authorization header.
// Live-wire 401/200 proof lives in registry-auth.integration.test.ts.

import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("pacote", () => ({
  packument: vi.fn(),
  extract: vi.fn(),
  tarball: vi.fn(),
}));

import * as pacote from "pacote";
import { registryScopedAuthOptions } from "../src/verdaccio/registry-auth";
import { getPublishedExtensionSummary } from "../src/verdaccio/client";
import type { VerdaccioConfig } from "../src/types";

const CONFIG: VerdaccioConfig = {
  registryUrl: "https://registry.example.test",
  packageScope: "@cinatra-ai",
  token: "tok-123",
  uiUrl: null,
};

const packumentMock = vi.mocked(pacote.packument);

beforeEach(() => packumentMock.mockReset());

describe("registryScopedAuthOptions", () => {
  it("derives the nerf-dart '//<host>/:_authToken' key from a host-root URL", () => {
    expect(registryScopedAuthOptions("https://registry.example.test", "tok")).toEqual({
      "//registry.example.test/:_authToken": "tok",
    });
  });

  it("normalizes a trailing-slash URL to the same key", () => {
    expect(registryScopedAuthOptions("https://registry.example.test/", "tok")).toEqual({
      "//registry.example.test/:_authToken": "tok",
    });
  });

  it("keeps the port in the key (local registries)", () => {
    expect(registryScopedAuthOptions("http://127.0.0.1:4873", "tok")).toEqual({
      "//127.0.0.1:4873/:_authToken": "tok",
    });
  });

  it("keeps a registry path prefix in the key", () => {
    expect(registryScopedAuthOptions("https://host.example.test/npm", "tok")).toEqual({
      "//host.example.test/npm/:_authToken": "tok",
    });
  });

  it("returns {} for a null/undefined/empty token (anonymous access)", () => {
    expect(registryScopedAuthOptions("https://registry.example.test", null)).toEqual({});
    expect(registryScopedAuthOptions("https://registry.example.test", undefined)).toEqual({});
    expect(registryScopedAuthOptions("https://registry.example.test", "")).toEqual({});
  });

  it("throws on a malformed registry URL (fail fast, no silently-wrong key)", () => {
    expect(() => registryScopedAuthOptions("not a url", "tok")).toThrow();
  });
});

describe("pacote options shape (the #179 regression)", () => {
  it("passes the scoped _authToken key and NEVER a flat `token` option", async () => {
    packumentMock.mockResolvedValue({
      versions: { "1.0.0": { name: "@cinatra-ai/x", version: "1.0.0" } },
      "dist-tags": { latest: "1.0.0" },
    } as never);

    await getPublishedExtensionSummary({ packageName: "@cinatra-ai/x" }, CONFIG);

    expect(packumentMock).toHaveBeenCalledTimes(1);
    const opts = packumentMock.mock.calls[0][1] as Record<string, unknown>;
    // The ONLY credential shape npm-registry-fetch honors:
    expect(opts["//registry.example.test/:_authToken"]).toBe("tok-123");
    // The exact regression: a flat `token` is ignored by npm-registry-fetch,
    // so it must never be the credential carrier again.
    expect(opts).not.toHaveProperty("token");
    expect(opts.registry).toBe("https://registry.example.test/");
  });

  it("emits no credential keys at all when the config has no token", async () => {
    packumentMock.mockResolvedValue({
      versions: { "1.0.0": { name: "@cinatra-ai/x", version: "1.0.0" } },
      "dist-tags": { latest: "1.0.0" },
    } as never);

    await getPublishedExtensionSummary(
      { packageName: "@cinatra-ai/x" },
      { ...CONFIG, token: null },
    );

    const opts = packumentMock.mock.calls[0][1] as Record<string, unknown>;
    expect(opts).not.toHaveProperty("token");
    expect(Object.keys(opts).filter((k) => k.includes(":_authToken"))).toEqual([]);
  });
});
