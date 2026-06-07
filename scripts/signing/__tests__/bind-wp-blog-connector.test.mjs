import { describe, it, expect } from "vitest";
import { bindBlogConnectorByHostSuffix } from "../lib/bind-wp-blog-connector.mjs";

// Vendor-agnostic example values (the live vendor invocation lives in the
// runbook, NOT in source/tests — keeps the de-hardcode grep zero).
const HOST_SUFFIX = ".example.com";
const CONNECTOR_ID = "example-connector";

function baseSettings() {
  return {
    loggingEnabled: true,
    instances: [
      // predate the blogConnectorId field (the live-site rows the migration repairs)
      { id: "a", siteUrl: "https://blog.example.com", name: "A" },
      { id: "b", siteUrl: "https://example.com", name: "B" }, // apex
      { id: "c", siteUrl: "https://other.test", blogConnectorId: "already", name: "C" },
      { id: "d", siteUrl: "https://notexample.com", name: "D" }, // bare-suffix false-positive guard
      { id: "e", siteUrl: "https://sub.notexample.com", name: "E" },
    ],
  };
}

describe("bindBlogConnectorByHostSuffix — generic one-shot WP blog-connector migration", () => {
  it("binds matching host-suffix rows (apex + subdomain) that have no blogConnectorId, leaving others untouched", () => {
    const { settings, changedInstanceIds } = bindBlogConnectorByHostSuffix(baseSettings(), {
      hostSuffix: HOST_SUFFIX,
      connectorId: CONNECTOR_ID,
    });
    expect(changedInstanceIds.sort()).toEqual(["a", "b"]);
    const byId = Object.fromEntries(settings.instances.map((i) => [i.id, i]));
    expect(byId.a.blogConnectorId).toBe(CONNECTOR_ID);
    expect(byId.b.blogConnectorId).toBe(CONNECTOR_ID);
    expect(byId.c.blogConnectorId).toBe("already"); // already bound — untouched (idempotent)
    expect(byId.d.blogConnectorId).toBeUndefined(); // "notexample.com" must NOT match ".example.com"
    expect(byId.e.blogConnectorId).toBeUndefined();
  });

  it("is a no-op on the row predating the field once already bound (the regression case)", () => {
    // A pre-blogConnectorId row gets bound on the first run; a second run is a no-op.
    const once = bindBlogConnectorByHostSuffix(baseSettings(), { hostSuffix: HOST_SUFFIX, connectorId: CONNECTOR_ID }).settings;
    const twice = bindBlogConnectorByHostSuffix(once, { hostSuffix: HOST_SUFFIX, connectorId: CONNECTOR_ID });
    expect(twice.changedInstanceIds).toEqual([]);
  });

  it("accepts a host-suffix without a leading dot and preserves unrelated settings/instance fields", () => {
    const { settings, changedInstanceIds } = bindBlogConnectorByHostSuffix(baseSettings(), {
      hostSuffix: "example.com",
      connectorId: CONNECTOR_ID,
    });
    expect(changedInstanceIds.sort()).toEqual(["a", "b"]);
    expect(settings.loggingEnabled).toBe(true);
    expect(settings.instances.find((i) => i.id === "a").name).toBe("A"); // other fields preserved
  });

  it("requires both hostSuffix and connectorId", () => {
    expect(() => bindBlogConnectorByHostSuffix(baseSettings(), { hostSuffix: "", connectorId: "x" })).toThrow(/hostSuffix/);
    expect(() => bindBlogConnectorByHostSuffix(baseSettings(), { hostSuffix: HOST_SUFFIX, connectorId: "  " })).toThrow(/connectorId/);
  });

  it("matches the host suffix even when the siteUrl carries a PORT (uses hostname, not host)", () => {
    const settings = {
      instances: [
        { id: "p", siteUrl: "https://blog.example.com:8443" }, // port must not defeat the match
        { id: "q", siteUrl: "https://example.com:443" },
      ],
    };
    const { changedInstanceIds } = bindBlogConnectorByHostSuffix(settings, { hostSuffix: ".example.com", connectorId: CONNECTOR_ID });
    expect(changedInstanceIds.sort()).toEqual(["p", "q"]);
  });

  it("skips unparseable siteUrl rows and tolerates a missing instances array", () => {
    const r1 = bindBlogConnectorByHostSuffix({ instances: [{ id: "z", siteUrl: "not a url" }] }, { hostSuffix: HOST_SUFFIX, connectorId: CONNECTOR_ID });
    expect(r1.changedInstanceIds).toEqual([]);
    const r2 = bindBlogConnectorByHostSuffix({}, { hostSuffix: HOST_SUFFIX, connectorId: CONNECTOR_ID });
    expect(r2.changedInstanceIds).toEqual([]);
    expect(r2.settings.instances).toEqual([]);
  });
});
