// Pins the #179 regression at the CLI layer: npm-registry-fetch (pacote's
// HTTP layer) resolves credentials ONLY from registry-scoped
// '//<host>/:_authToken' option keys — a flat `token` option is silently
// ignored, so the agents-install pacote paths ran unauthenticated. The
// canonical TS helper (with the full nerf-dart contract tests + a live-wire
// 401/200 integration proof) lives in @cinatra-ai/registries; this pins the
// plain-JS mirror used by agents-install.mjs.

import { describe, expect, it } from "vitest";

import { __test } from "../agents-install.mjs";

const { registryScopedAuthOptions } = __test;

describe("agents-install registryScopedAuthOptions (#179)", () => {
  it("derives the nerf-dart '//<host>/:_authToken' key (port kept)", () => {
    expect(registryScopedAuthOptions("http://127.0.0.1:4873", "tok")).toEqual({
      "//127.0.0.1:4873/:_authToken": "tok",
    });
  });

  it("normalizes trailing slashes and keeps a path prefix", () => {
    expect(registryScopedAuthOptions("https://registry.example.test/", "tok")).toEqual({
      "//registry.example.test/:_authToken": "tok",
    });
    expect(registryScopedAuthOptions("https://host.example.test/npm", "tok")).toEqual({
      "//host.example.test/npm/:_authToken": "tok",
    });
  });

  it("returns {} when no token is configured (anonymous local registry)", () => {
    expect(registryScopedAuthOptions("http://127.0.0.1:4873", null)).toEqual({});
    expect(registryScopedAuthOptions("http://127.0.0.1:4873", undefined)).toEqual({});
    expect(registryScopedAuthOptions("http://127.0.0.1:4873", "")).toEqual({});
  });

  it("source no longer builds the flat pacote `token` option (the exact regression)", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(
      new URL("../agents-install.mjs", import.meta.url),
      "utf8",
    );
    // The pre-#179 shape was `pacoteOpts.token = token` — npm-registry-fetch
    // ignores it entirely (no Authorization header sent at all).
    expect(src).not.toMatch(/pacoteOpts\.token\s*=/);
    expect(src).not.toMatch(/^\s*token:\s*token,?\s*$/m);
  });
});
