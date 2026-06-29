import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Regression guard for cinatra#647 — the registry CTA on the marketplace
// browse screen.
//
// The ExtensionsMarketplaceScreen is a React Server Component wired to auth +
// DB reads; the package's vitest config runs in a `node` environment with no
// jsdom/RTL, and a real render would drag the full server graph (drizzle,
// better-auth, the marketplace MCP SDK) into the sandbox. So instead of a DOM
// render we assert the two #647-critical invariants directly against the
// source of the screen:
//
//   1. The registry-settings CTA uses a ROOT-RELATIVE href
//      (/configuration/environment?tab=registries) so it resolves to the
//      instance's own origin — never a hardcoded base URL.
//   2. The browse screen never embeds an absolute http(s) URL (the original
//      bug hardcoded http://localhost:3000/...).
// ---------------------------------------------------------------------------

const screenSource = readFileSync(
  path.join(__dirname, "..", "extensions-marketplace-screen.tsx"),
  "utf8",
);

describe("ExtensionsMarketplaceScreen registry CTA (cinatra#647)", () => {
  it("links to the registries tab with a root-relative href (resolves to the instance origin)", () => {
    expect(screenSource).toContain('href="/configuration/environment?tab=registries"');
  });

  it("never hardcodes an absolute http(s) base URL for the registry link", () => {
    // No absolute scheme-prefixed URL anywhere in the screen — the original
    // #647 bug hardcoded http://localhost:3000/configuration/environment?...
    expect(screenSource).not.toMatch(/https?:\/\//);
    expect(screenSource.toLowerCase()).not.toContain("localhost");
  });

  it("scopes the registry to install, not browse (wording distinguishes marketplace from registry)", () => {
    // Browse is explicitly described as setup-free / storefront-sourced; the
    // package registry is named only as the install dependency.
    expect(screenSource).toContain("Browsing the marketplace catalog works without any setup");
    expect(screenSource).toContain("Installing an extension is what needs the package");
  });
});
