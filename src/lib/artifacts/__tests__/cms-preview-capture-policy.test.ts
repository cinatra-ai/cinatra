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
  CMS_PREVIEW_PATH_PREFIX_DRUPAL,
  normalizeOrigin,
  parsePostId,
  resolveCaptureTarget,
} from "@/lib/artifacts/cms-preview-capture-policy";

const wp = (origin: string, siteId = "site-1") => ({ siteId, client: "wordpress", origin });
const drupal = (origin: string, siteId = "site-d") => ({ siteId, client: "drupal", origin });

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
    // The connector's SITE-SCOPED composition is what a real staged CMS write
    // carries (`cmsExternalId(instanceId, cmsResourceId)`) — accepted, with the
    // instance segment contributing nothing to the fetched URL. (Found by the
    // L-D live walk: without this every real capture degraded `invalid-post-id`.)
    expect(parsePostId("inst-1:42")).toBe(42);
    expect(parsePostId("f47ac10b-58cc-4372-a567-0e02b2c3d479:7")).toBe(7);
    for (const bad of [
      ":42",
      "inst-1:",
      "inst 1:42",
      "inst-1:42:9",
      "inst-1:4.2",
      "inst-1:0",
      "inst-1:42/../../wp-admin",
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
        registeredSites: [{ siteId: "s", client: "shopify", origin: "https://s.example.com" }],
        sourceUrl: "https://s.example.com/products/1",
        externalId: "1",
      }),
    ).toEqual({ ok: false, reason: "client-has-no-preview-adapter" });
  });

  // ---- cinatra#2046 (S7b) — the Drupal adapter is a peer, not a special case.

  it("addresses a DRUPAL site through the drupal module's own preview route", () => {
    const res = resolveCaptureTarget({
      registeredSites: [drupal("https://news.example.org")],
      sourceUrl: "https://news.example.org/node/7?foo=bar#frag",
      externalId: "7",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.url).toBe(`https://news.example.org${CMS_PREVIEW_PATH_PREFIX_DRUPAL}7`);
    expect(res.client).toBe("drupal");
    // ONE signing convention across CMSes: both adapters recompute the same
    // canonical content from the id in the requested path.
    expect(res.signedContent).toBe("preview.7");
  });

  it("uses the MATCHED site's route, so a wordpress path is never requested from a drupal origin", () => {
    const both = [wp("https://blog.example.com"), drupal("https://news.example.org")];
    const wpRes = resolveCaptureTarget({
      registeredSites: both,
      sourceUrl: "https://blog.example.com/x",
      externalId: "1",
    });
    const drRes = resolveCaptureTarget({
      registeredSites: both,
      sourceUrl: "https://news.example.org/x",
      externalId: "1",
    });
    expect(wpRes.ok && wpRes.url).toBe(`https://blog.example.com${CMS_PREVIEW_PATH_PREFIX}1`);
    expect(drRes.ok && drRes.url).toBe(`https://news.example.org${CMS_PREVIEW_PATH_PREFIX_DRUPAL}1`);
    expect(CMS_PREVIEW_PATH_PREFIX_DRUPAL).not.toBe(CMS_PREVIEW_PATH_PREFIX);
  });

  it("accepts the DRUPAL connector's site-scoped external id (`<instanceId>:<nid>`)", () => {
    // drupalNodeExternalId(instanceId, nodeId) — what a real staged Drupal write
    // carries on its pointer. Only the segment after the last colon addresses.
    const res = resolveCaptureTarget({
      registeredSites: [drupal("https://news.example.org")],
      sourceUrl: "https://news.example.org/node/7",
      externalId: "inst-abc:7",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.postId).toBe(7);
    expect(res.url).toBe(`https://news.example.org${CMS_PREVIEW_PATH_PREFIX_DRUPAL}7`);
  });

  it("refuses a drupal origin the org never registered, exactly like a wordpress one", () => {
    expect(
      resolveCaptureTarget({
        registeredSites: [drupal("https://news.example.org")],
        sourceUrl: "https://attacker.example.net/node/7",
        externalId: "7",
      }),
    ).toEqual({ ok: false, reason: "origin-not-registered" });
  });

  it("refuses a non-numeric drupal node id (no traversal into the module route)", () => {
    expect(
      resolveCaptureTarget({
        registeredSites: [drupal("https://news.example.org")],
        sourceUrl: "https://news.example.org/node/7",
        externalId: "7/../../admin",
      }),
    ).toEqual({ ok: false, reason: "invalid-post-id" });
  });


  // ---- convergence-round hardening (cinatra#2046).

  it("refuses an origin registered under MORE THAN ONE platform rather than guessing", () => {
    // The connect-site uniqueness index is (org, client, origin), so the same
    // address CAN carry both a wordpress and a drupal row. Picking the first
    // would fetch a WordPress route with a WordPress credential for a Drupal
    // pointer.
    expect(
      resolveCaptureTarget({
        registeredSites: [
          wp("https://cms.example.com", "site-w"),
          drupal("https://cms.example.com", "site-d"),
        ],
        sourceUrl: "https://cms.example.com/node/7",
        externalId: "7",
      }),
    ).toEqual({ ok: false, reason: "ambiguous-origin-registration" });
  });

  it("still resolves when the SAME platform is registered twice at one origin", () => {
    const res = resolveCaptureTarget({
      registeredSites: [drupal("https://news.example.org", "d1"), drupal("https://news.example.org", "d2")],
      sourceUrl: "https://news.example.org/node/7",
      externalId: "7",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.client).toBe("drupal");
  });

  it("bounds the resource id PER ADAPTER — drupal nids are unsigned, wordpress keeps its bound", () => {
    const aboveSigned32 = "3000000000";
    const dr = resolveCaptureTarget({
      registeredSites: [drupal("https://news.example.org")],
      sourceUrl: "https://news.example.org/node/x",
      externalId: aboveSigned32,
    });
    expect(dr.ok).toBe(true);
    if (dr.ok) expect(dr.postId).toBe(3000000000);

    expect(
      resolveCaptureTarget({
        registeredSites: [wp("https://blog.example.com")],
        sourceUrl: "https://blog.example.com/x",
        externalId: aboveSigned32,
      }),
    ).toEqual({ ok: false, reason: "invalid-post-id" });

    // Neither adapter accepts anything past the widest bound.
    expect(
      resolveCaptureTarget({
        registeredSites: [drupal("https://news.example.org")],
        sourceUrl: "https://news.example.org/x",
        externalId: "4294967296",
      }),
    ).toEqual({ ok: false, reason: "invalid-post-id" });
  });

  it("names every denial (an unnamed degrade would be a silent gap)", () => {
    expect(
      resolveCaptureTarget({ registeredSites: [], sourceUrl: "https://x.example", externalId: "1" }),
    ).toEqual({ ok: false, reason: "no-registered-site" });
  });
});
