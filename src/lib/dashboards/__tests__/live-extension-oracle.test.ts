// App-side liveness oracle for the dashboards reader gate (cinatra#1628, S11a).
// Pins: only active/locked installs are live; org-scoping (org-match or system
// org-null); and the FAIL-CLOSED / transient-loader-failure contract (a store
// failure yields a deny-all predicate, never a throw).
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

const listInstalledExtensions = vi.fn();
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  listInstalledExtensions: (...args: unknown[]) => listInstalledExtensions(...args),
}));

import { resolveLiveExtensionPredicate } from "../live-extension-oracle";

const row = (packageName: string, status: string, organizationId: string | null) => ({
  packageName,
  status,
  organizationId,
});

beforeEach(() => {
  listInstalledExtensions.mockReset();
});

describe("live-extension-oracle — liveness set", () => {
  it("treats active AND locked installs as live; archived is NOT live", async () => {
    listInstalledExtensions.mockResolvedValue([
      row("@cinatra-ai/active-agent", "active", "org-1"),
      row("@cinatra-ai/locked-sys", "locked", null),
      row("@cinatra-ai/archived-agent", "archived", "org-1"),
    ]);
    const isLive = await resolveLiveExtensionPredicate("org-1");
    expect(isLive("@cinatra-ai/active-agent")).toBe(true);
    expect(isLive("@cinatra-ai/locked-sys")).toBe(true); // system org-null row
    expect(isLive("@cinatra-ai/archived-agent")).toBe(false);
    expect(isLive("@cinatra-ai/never-installed")).toBe(false);
  });

  it("is org-scoped: a sibling org's active install is NOT live for this org", async () => {
    listInstalledExtensions.mockResolvedValue([
      row("@cinatra-ai/other-org-agent", "active", "org-2"),
    ]);
    const isLive = await resolveLiveExtensionPredicate("org-1");
    expect(isLive("@cinatra-ai/other-org-agent")).toBe(false);
  });

  it("the retired workflow package is never live (recovery-floor guarantee)", async () => {
    listInstalledExtensions.mockResolvedValue([]);
    const isLive = await resolveLiveExtensionPredicate("org-1");
    expect(isLive("@cinatra-ai/blog-content-workflow")).toBe(false);
  });
});

describe("live-extension-oracle — fail-closed", () => {
  it("a store failure yields a deny-all predicate (hide-at-read) and never throws", async () => {
    listInstalledExtensions.mockRejectedValue(new Error("transient DB outage"));
    const isLive = await resolveLiveExtensionPredicate("org-1");
    expect(isLive("@cinatra-ai/anything")).toBe(false);
  });

  it("a null org still resolves (deny-all when no matching install)", async () => {
    listInstalledExtensions.mockResolvedValue([row("@cinatra-ai/sys", "locked", null)]);
    const isLive = await resolveLiveExtensionPredicate(null);
    expect(isLive("@cinatra-ai/sys")).toBe(true); // org-null system row matches a null org too
  });
});
