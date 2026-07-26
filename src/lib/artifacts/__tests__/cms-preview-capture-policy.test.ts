/**
 * cinatra#2044 S6 (L-B) — the SSRF boundary of the capture pipeline.
 *
 * The capture step makes an authenticated, SIGNED request from the host to a
 * remote site. These are the tests that say the destination can never be chosen
 * by whoever triggered the staged write.
 */
import { describe, expect, it } from "vitest";

import {
  CMS_PREVIEW_PATH_PREFIX,
  normalizeOrigin,
  parsePostId,
  resolveCaptureTarget,
} from "@/lib/artifacts/cms-preview-capture-policy";

const wp = (origin: string, siteId = "site-1") => ({ siteId, client: "wordpress", origin });

describe("cinatra#2044 L-B — capture target policy (SSRF boundary)", () => {
  it("builds the preview URL from the REGISTERED origin, never from the adapter's url", () => {
    const res = resolveCaptureTarget({
      registeredSites: [wp("https://blog.example.com")],
      // The adapter's url carries a path, a query and a fragment. None of it may
      // survive into what the host fetches.
      sourceUrl: "https://blog.example.com/2026/07/hello/?preview=1#top",
      externalId: "42",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.url).toBe(`https://blog.example.com${CMS_PREVIEW_PATH_PREFIX}42`);
    expect(res.origin).toBe("https://blog.example.com");
    expect(res.signedContent).toBe("preview.42");
  });

  it("refuses an origin the org never registered (the core SSRF denial)", () => {
    const res = resolveCaptureTarget({
      registeredSites: [wp("https://blog.example.com")],
      sourceUrl: "https://attacker.example.net/anything",
      externalId: "42",
    });
    expect(res).toEqual({ ok: false, reason: "origin-not-registered" });
  });

  it("refuses an internal address even when it is offered as the source url", () => {
    for (const hostile of [
      "http://169.254.169.254/latest/meta-data/",
      "http://127.0.0.1:8080/wp",
      "http://10.0.0.5/wp",
      "file:///etc/passwd",
      "gopher://internal/",
    ]) {
      const res = resolveCaptureTarget({
        registeredSites: [wp("https://blog.example.com")],
        sourceUrl: hostile,
        externalId: "42",
      });
      expect(res.ok).toBe(false);
    }
  });

  it("refuses userinfo-bearing and non-http(s) origins on BOTH sides", () => {
    // Assembled from parts rather than written as a literal so the repo carries
    // no credential-shaped URI for a secret scanner to flag.
    const withUserinfo = `https://${"decoy"}:${"decoy"}@blog.example.com`;
    expect(normalizeOrigin(withUserinfo)).toBeNull();
    expect(normalizeOrigin("ftp://blog.example.com")).toBeNull();
    const res = resolveCaptureTarget({
      registeredSites: [wp(withUserinfo)],
      sourceUrl: "https://blog.example.com/post",
      externalId: "1",
    });
    // The malformed registration is dropped, leaving nothing registered.
    expect(res).toEqual({ ok: false, reason: "no-registered-site" });
  });

  it("compares origins exactly — host case and trailing dot normalize, port does not", () => {
    expect(
      resolveCaptureTarget({
        registeredSites: [wp("https://Blog.Example.com.")],
        sourceUrl: "https://blog.example.com/post",
        externalId: "7",
      }).ok,
    ).toBe(true);
    // A different port is a different origin.
    expect(
      resolveCaptureTarget({
        registeredSites: [wp("https://blog.example.com")],
        sourceUrl: "https://blog.example.com:8443/post",
        externalId: "7",
      }),
    ).toEqual({ ok: false, reason: "origin-not-registered" });
    // A subdomain/suffix trick is not a prefix match.
    expect(
      resolveCaptureTarget({
        registeredSites: [wp("https://blog.example.com")],
        sourceUrl: "https://blog.example.com.evil.net/post",
        externalId: "7",
      }),
    ).toEqual({ ok: false, reason: "origin-not-registered" });
  });

  it("never falls back to 'the only registered site' when the selector is missing", () => {
    for (const bad of [null, undefined, "", "not a url", "/relative/only"]) {
      expect(
        resolveCaptureTarget({
          registeredSites: [wp("https://blog.example.com")],
          sourceUrl: bad,
          externalId: "42",
        }),
      ).toEqual({ ok: false, reason: "unusable-source-url" });
    }
  });

  it("accepts only a strict, in-range decimal post id (no traversal, no smuggling)", () => {
    expect(parsePostId("42")).toBe(42);
    for (const bad of [
      "0",
      "-1",
      "+1",
      " 42",
      "42 ",
      "4.2",
      "1e3",
      "0x2a",
      "42/../../wp-admin",
      "42?x=1",
      "99999999999",
      "",
      null,
    ]) {
      expect(parsePostId(bad)).toBeNull();
    }
    expect(
      resolveCaptureTarget({
        registeredSites: [wp("https://blog.example.com")],
        sourceUrl: "https://blog.example.com/post",
        externalId: "42/../../wp-admin",
      }),
    ).toEqual({ ok: false, reason: "invalid-post-id" });
  });

  it("refuses a registered site whose platform has no preview adapter", () => {
    expect(
      resolveCaptureTarget({
        registeredSites: [{ siteId: "s", client: "drupal", origin: "https://d.example.com" }],
        sourceUrl: "https://d.example.com/node/1",
        externalId: "1",
      }),
    ).toEqual({ ok: false, reason: "client-has-no-preview-adapter" });
  });

  it("names every denial (an unnamed degrade would be a silent gap)", () => {
    expect(
      resolveCaptureTarget({ registeredSites: [], sourceUrl: "https://x.example", externalId: "1" }),
    ).toEqual({ ok: false, reason: "no-registered-site" });
  });
});
