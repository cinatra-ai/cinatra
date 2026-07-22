// Remote-assistant destination resolver (cinatra#1878 W3, AC#4/#5). Pure — the
// destination is built from the instance record's own siteUrl by a first-party
// resolver, never a manifest URL; validates http(s) + guarantees same-origin.
import { describe, expect, it } from "vitest";
import {
  buildRemoteChatHref,
  remoteConnectorKindForProvider,
  resolveRemoteChatDestination,
} from "../assistant-remote-target";

describe("remoteConnectorKindForProvider", () => {
  it("maps the first-party providers, case/space-insensitive", () => {
    expect(remoteConnectorKindForProvider("wordpress")).toBe("wordpress");
    expect(remoteConnectorKindForProvider("  Drupal ")).toBe("drupal");
  });
  it("rejects unknown / absent providers (fail-closed)", () => {
    expect(remoteConnectorKindForProvider("evil")).toBeNull();
    expect(remoteConnectorKindForProvider(null)).toBeNull();
    expect(remoteConnectorKindForProvider(undefined)).toBeNull();
    expect(remoteConnectorKindForProvider("")).toBeNull();
  });
});

describe("buildRemoteChatHref", () => {
  it("WordPress → {siteUrl}/wp-admin/", () => {
    expect(buildRemoteChatHref("wordpress", { id: "i", siteUrl: "https://example.com" })).toBe(
      "https://example.com/wp-admin/",
    );
    // subdirectory install preserved
    expect(
      buildRemoteChatHref("wordpress", { id: "i", siteUrl: "https://example.com/blog/" }),
    ).toBe("https://example.com/blog/wp-admin/");
  });
  it("Drupal → the site front page", () => {
    expect(buildRemoteChatHref("drupal", { id: "i", siteUrl: "https://drup.example" })).toBe(
      "https://drup.example/",
    );
  });
  it("rejects a non-http(s) siteUrl (no javascript:/file:/ftp:)", () => {
    for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "ftp://x", "not a url"]) {
      expect(buildRemoteChatHref("wordpress", { id: "i", siteUrl: bad })).toBeNull();
      expect(buildRemoteChatHref("drupal", { id: "i", siteUrl: bad })).toBeNull();
    }
  });
  it("the built href is same-origin with the instance record", () => {
    const href = buildRemoteChatHref("wordpress", { id: "i", siteUrl: "https://example.com:8443" });
    expect(new URL(href!).origin).toBe("https://example.com:8443");
  });
});

describe("resolveRemoteChatDestination", () => {
  it("resolves provider + instance into { kind, href }", () => {
    expect(
      resolveRemoteChatDestination("wordpress", { id: "i", siteUrl: "https://wp.example" }),
    ).toEqual({ kind: "wordpress", href: "https://wp.example/wp-admin/" });
  });
  it("returns null for an unknown provider or invalid siteUrl", () => {
    expect(resolveRemoteChatDestination("evil", { id: "i", siteUrl: "https://x" })).toBeNull();
    expect(resolveRemoteChatDestination("drupal", { id: "i", siteUrl: "bad" })).toBeNull();
  });
});
