import { describe, expect, it } from "vitest";

import {
  checksumOf,
  loadDevContentManifest,
  validateDevContentManifest,
} from "../fixtures/lib/dev-content-manifest.mjs";

const base = () => loadDevContentManifest();

describe("external-instances dev-content manifest", () => {
  it("the checked-in manifest is structurally valid + generic", () => {
    expect(() => validateDevContentManifest(base())).not.toThrow();
  });

  it("ships content for all three instances incl. Twenty views", () => {
    const m = base();
    expect(m.drupal.nodes.length).toBeGreaterThan(0);
    expect(m.wordpress.posts.length).toBeGreaterThan(0);
    expect(m.twenty.companies.length).toBeGreaterThan(0);
    expect(m.twenty.people.length).toBeGreaterThan(0);
    expect(m.twenty.views.length).toBeGreaterThan(0);
  });

  it("declares a PRECISE one-shot OpenCloud cleanup (exact titles, not a bare-word prefix)", () => {
    const m = base();
    const prefixes = m.drupal.legacyCleanup.titlePrefixes;
    expect(m.drupal.legacyCleanup.sentinel).toBeTruthy();
    expect(prefixes.length).toBeGreaterThan(0);
    // Every prefix targets an OpenCloud node...
    expect(prefixes.every((t) => /opencloud/i.test(t))).toBe(true);
    // ...but NONE is the bare word (which would over-match unrelated user nodes).
    expect(prefixes.some((t) => t.trim().toLowerCase() === "opencloud")).toBe(false);
    expect(prefixes).toContain("OpenCloud auf der Rack & Stack 2026");
  });

  it("rejects a duplicate fixtureId", () => {
    const m = base();
    m.wordpress.posts[0].fixtureId = m.drupal.nodes[0].fixtureId;
    expect(() => validateDevContentManifest(m)).toThrow(/duplicate fixtureId/);
  });

  it("rejects a non-generic OpenCloud token", () => {
    const m = base();
    m.drupal.nodes[0].title = "OpenCloud launch event";
    expect(() => validateDevContentManifest(m)).toThrow(/OpenCloud/);
  });

  it("rejects a company domain that is not a reserved TLD", () => {
    const m = base();
    m.twenty.companies[0].domainName = "real-company.com";
    expect(() => validateDevContentManifest(m)).toThrow(/reserved TLD/);
  });

  it("rejects a person email that is not a reserved TLD", () => {
    const m = base();
    m.twenty.people[0].email = "someone@gmail.com";
    expect(() => validateDevContentManifest(m)).toThrow(/reserved TLD/);
  });

  it("rejects an unknown drupal node type", () => {
    const m = base();
    m.drupal.nodes[0].type = "landing_page";
    expect(() => validateDevContentManifest(m)).toThrow(/type must be one of/);
  });

  it("rejects an unknown twenty view objectType", () => {
    const m = base();
    m.twenty.views[0].objectType = "invoice";
    expect(() => validateDevContentManifest(m)).toThrow(/objectType must be one of/);
  });

  it("rejects a person referencing an unseeded company domain", () => {
    const m = base();
    m.twenty.people[0].companyDomainName = "nowhere.example";
    expect(() => validateDevContentManifest(m)).toThrow(/does not match any seeded company/);
  });
});

describe("checksumOf", () => {
  it("is stable and order-independent", () => {
    expect(checksumOf({ a: 1, b: 2 })).toBe(checksumOf({ b: 2, a: 1 }));
    expect(checksumOf({ a: 1 })).not.toBe(checksumOf({ a: 2 }));
  });
});
