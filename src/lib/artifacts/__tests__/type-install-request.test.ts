import { describe, expect, it } from "vitest";

import {
  TYPE_INSTALL_REQUEST_CATEGORY,
  TYPE_INSTALL_REQUEST_DEDUPE_PREFIX,
  buildTypeInstallMarketplaceHref,
  buildTypeInstallRequestNotificationInput,
  typeInstallRequestDedupeKey,
} from "../type-install-request";

// epic #1883 slice A4, spec design@16efd8d2 §VII — the non-admin one-click
// Request install (ruling 4): an occurrence-deduped admin notification.

describe("type-install request: marketplace deep link", () => {
  it("points at the marketplace filtered to the URL-encoded package", () => {
    expect(buildTypeInstallMarketplaceHref("@acme/legal-artifact")).toBe(
      "/configuration/marketplace?q=%40acme%2Flegal-artifact",
    );
  });
  it("bounds a pathological package name before encoding", () => {
    const href = buildTypeInstallMarketplaceHref("x".repeat(500));
    expect(href.startsWith("/configuration/marketplace?q=")).toBe(true);
    expect(href.length).toBeLessThan(320);
  });
});

describe("type-install request: occurrence dedupe key", () => {
  it("coalesces one requester's repeat clicks for one pack in one org (same key)", () => {
    expect(typeInstallRequestDedupeKey("org-1", "user-1", "@acme/legal-artifact")).toBe(
      typeInstallRequestDedupeKey("org-1", "user-1", "@acme/legal-artifact"),
    );
  });
  it("a DIFFERENT org is a distinct occurrence (different key) — installs are tenant-scoped", () => {
    expect(typeInstallRequestDedupeKey("org-1", "user-1", "@acme/legal-artifact")).not.toBe(
      typeInstallRequestDedupeKey("org-2", "user-1", "@acme/legal-artifact"),
    );
  });
  it("a DIFFERENT requester is a distinct occurrence (different key)", () => {
    expect(typeInstallRequestDedupeKey("org-1", "user-1", "@acme/legal-artifact")).not.toBe(
      typeInstallRequestDedupeKey("org-1", "user-2", "@acme/legal-artifact"),
    );
  });
  it("a DIFFERENT pack is a distinct occurrence (different key)", () => {
    expect(typeInstallRequestDedupeKey("org-1", "user-1", "@acme/legal-artifact")).not.toBe(
      typeInstallRequestDedupeKey("org-1", "user-1", "@acme/sales-artifact"),
    );
  });
  it("carries the stable family prefix", () => {
    expect(typeInstallRequestDedupeKey("o", "u", "p").startsWith(TYPE_INSTALL_REQUEST_DEDUPE_PREFIX)).toBe(true);
  });
});

describe("type-install request: notification composition", () => {
  it("is an info advisory carrying the pack, requester, org, deep link and dedupe key", () => {
    const input = buildTypeInstallRequestNotificationInput({
      orgId: "org-1",
      requesterId: "user-1",
      packageName: "@acme/legal-artifact",
      displayName: "Contract",
      requesterLabel: "Dana",
    });
    expect(input.kind).toBe("info");
    expect(input.title).toMatch(/Install requested/i);
    expect(input.body).toContain("Contract");
    expect(input.body).toContain("@acme/legal-artifact");
    expect(input.body).toContain("Dana");
    expect(input.href).toBe("/configuration/marketplace?q=%40acme%2Flegal-artifact");
    expect(input.dedupeKey).toBe(
      typeInstallRequestDedupeKey("org-1", "user-1", "@acme/legal-artifact"),
    );
    expect(input.metadata).toMatchObject({
      category: TYPE_INSTALL_REQUEST_CATEGORY,
      packageName: "@acme/legal-artifact",
      orgId: "org-1",
      requesterId: "user-1",
      displayName: "Contract",
    });
  });

  it("falls back to the package name when no display name is given", () => {
    const input = buildTypeInstallRequestNotificationInput({
      orgId: "org-1",
      requesterId: "user-1",
      packageName: "@acme/legal-artifact",
    });
    expect(input.body).toContain("@acme/legal-artifact");
    expect(input.metadata).not.toHaveProperty("displayName");
  });
});
