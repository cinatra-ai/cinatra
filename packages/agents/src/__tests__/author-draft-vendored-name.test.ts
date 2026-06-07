// Vendored package-name allowlist plus widened standard package-name regex.
//
// The widened isValidPackageName() must accept BOTH:
//   - Standard form @<scope>/<slug>-<kind> with kind in
//     (agent|skill|skills|connector|artifact) and any scope. Connector
//     scopes are vendor-neutral; non-connector kinds are first-party-scoped at
//     the package authoring boundary.
//   - The vendored-exact-name allowlist (today: @anthropics/skills).
// And it must reject:
//   - Names missing the -<kind> suffix that aren't on the allowlist.
//   - Bare names without a scope.
//   - Names with uppercase or other shape violations.

import { describe, it, expect } from "vitest";

import { isValidPackageName } from "../author-draft";

describe("isValidPackageName — widened regex + vendored allowlist", () => {
  it("accepts standard @cinatra-ai/<slug>-<kind> across all kinds", () => {
    expect(isValidPackageName("@cinatra-ai/example-agent")).toBe(true);
    expect(isValidPackageName("@cinatra-ai/example-connector")).toBe(true);
    expect(isValidPackageName("@cinatra-ai/example-artifact")).toBe(true);
    expect(isValidPackageName("@cinatra-ai/example-skill")).toBe(true);
    // Accept plural -skills directory-suffix variant too.
    expect(isValidPackageName("@cinatra-ai/example-skills")).toBe(true);
  });

  it("accepts non-cinatra-ai connector scopes under generic-vendor policy", () => {
    expect(isValidPackageName("@example-vendor/blog-connector")).toBe(true);
    expect(isValidPackageName("@acme/widget-connector")).toBe(true);
  });

  it("accepts the vendored exact-name allowlist", () => {
    expect(isValidPackageName("@anthropics/skills")).toBe(true);
  });

  it("rejects @<scope>/<slug> without a -<kind> suffix (non-vendored)", () => {
    expect(isValidPackageName("@cinatra-ai/example")).toBe(false);
    expect(isValidPackageName("@cinatra-ai/no-suffix")).toBe(false);
    expect(isValidPackageName("@otherscope/skills")).toBe(false);
  });

  it("rejects bare names without a scope", () => {
    expect(isValidPackageName("example-agent")).toBe(false);
    expect(isValidPackageName("@/example-agent")).toBe(false);
  });

  it("rejects shape violations the existing regex already caught (uppercase, dot)", () => {
    // The widened regex inherits the original shape constraints. A leading
    // dash in the slug is technically allowed by [a-z0-9-]+; the
    // dir-basename match catches mis-shaped names on disk.
    expect(isValidPackageName("@cinatra-ai/Example-agent")).toBe(false);
    expect(isValidPackageName("@cinatra-ai/example.agent")).toBe(false);
  });
});
