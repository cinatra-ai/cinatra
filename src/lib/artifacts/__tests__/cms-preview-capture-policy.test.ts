/**
 * cinatra#2044 S6 (L-B): the registered-origin policy of the page capture.
 *
 * The page capture matches a registered origin exactly. These tests say that
 * the origin form is one comparable shape and that a userinfo prefix or a
 * non-http(s) scheme can never pass as an origin. (The signed preview target
 * these tests also covered left with cinatra#3862 leg 8, unit l8a2.)
 */
import { describe, expect, it } from "vitest";

import { captureDenialCopy, normalizeOrigin } from "@/lib/artifacts/cms-preview-capture-policy";

describe("cinatra#2044 L-B: registered-origin policy", () => {
  it("refuses userinfo-bearing and non-http(s) origins", () => {
    // Assembled from parts rather than written as a literal so the repo carries
    // no credential-shaped URI for a secret scanner to flag.
    const withUserinfo = `https://${"decoy"}:${"decoy"}@blog.example.com`;
    expect(normalizeOrigin(withUserinfo)).toBeNull();
    expect(normalizeOrigin("ftp://blog.example.com")).toBeNull();
    expect(normalizeOrigin("file:///etc/passwd")).toBeNull();
    for (const bad of ["", "not a url", "/relative/only"]) {
      expect(normalizeOrigin(bad)).toBeNull();
    }
  });

  it("compares origins exactly — host case and trailing dot normalize, port does not", () => {
    expect(normalizeOrigin("https://Blog.Example.com./2026/07/hello/?preview=1#top")).toBe(
      "https://blog.example.com",
    );
    expect(normalizeOrigin("https://blog.example.com:443/x")).toBe("https://blog.example.com");
    expect(normalizeOrigin("http://blog.example.com:80/x")).toBe("http://blog.example.com");
    // A different port is a different origin.
    expect(normalizeOrigin("https://blog.example.com:8443/post")).toBe("https://blog.example.com:8443");
    // A subdomain/suffix trick is a different host, not a prefix match.
    expect(normalizeOrigin("https://blog.example.com.evil.net/post")).toBe(
      "https://blog.example.com.evil.net",
    );
  });

  it("names every denial (an unnamed degrade would be a silent gap)", () => {
    for (const reason of [
      "no-registered-site",
      "unusable-source-url",
      "origin-not-registered",
      "invalid-post-id",
      "ambiguous-origin-registration",
      "client-has-no-preview-adapter",
    ] as const) {
      expect(captureDenialCopy(reason)).toMatch(/\S/);
    }
  });
});
