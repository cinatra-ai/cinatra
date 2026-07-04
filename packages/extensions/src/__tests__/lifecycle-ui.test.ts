// Lifecycle discovery UX logic tests.
import { describe, expect, it } from "vitest";

import type { ExtensionSource, InstalledExtension } from "../canonical-types";
import {
  disabledActionReason,
  lifecycleBadgesFor,
  matchesLifecycleFilter,
  pickLifecycleBadgeStatus,
} from "../lifecycle-ui";

function ext(
  over: Partial<InstalledExtension> & { source?: ExtensionSource } = {},
): InstalledExtension {
  return {
    id: "id",
    packageName: "@cinatra-ai/foo-agent",
    ownerLevel: "platform",
    ownerId: null,
    organizationId: null,
    kind: "agent",
    status: "active",
    source: { type: "verdaccio", registryUrl: "x", packageName: "@cinatra-ai/foo-agent", version: "1.2.3", integrity: "sha" },
    requiredInProd: false,
    dependencies: [],
    manifestHash: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

describe("lifecycle badges", () => {
  it("active verdaccio shows source + version", () => {
    const badges = lifecycleBadgesFor(ext());
    const keys = badges.map((b) => b.key);
    expect(keys).toContain("source");
    expect(keys).toContain("version");
    expect(badges.find((b) => b.key === "version")?.label).toBe("v1.2.3");
  });

  it("locked + required shows Locked + Required badges", () => {
    const badges = lifecycleBadgesFor(ext({ status: "locked", requiredInProd: true }));
    const keys = badges.map((b) => b.key);
    expect(keys).toContain("locked");
    expect(keys).toContain("required");
    expect(badges.find((b) => b.key === "locked")?.variant).toBe("warning");
  });

  it("github source shows GitHub badge + ref version", () => {
    const badges = lifecycleBadgesFor(
      ext({ source: { type: "github", repo: "o/r", ref: "v2", resolvedSha: "abc" } }),
    );
    expect(badges.find((b) => b.key === "source")?.label).toBe("GitHub");
    expect(badges.find((b) => b.key === "version")?.label).toBe("v2");
  });
});

describe("disabled-action reasons", () => {
  it("locked+required archive shows 'Cannot archive — required-in-prod'", () => {
    expect(disabledActionReason(ext({ status: "locked", requiredInProd: true }), "archive")).toBe(
      "Cannot archive — required-in-prod",
    );
  });

  it("locked uninstall shows 'Cannot uninstall — locked; archive instead'", () => {
    expect(disabledActionReason(ext({ status: "locked" }), "uninstall")).toBe(
      "Cannot uninstall — locked; archive instead",
    );
  });

  it("active archive is permitted (null)", () => {
    expect(disabledActionReason(ext({ status: "active" }), "archive")).toBeNull();
  });

  it("already-archived archive returns reason", () => {
    expect(disabledActionReason(ext({ status: "archived" }), "archive")).toBe("Already archived");
  });
});

describe("filter/search", () => {
  it("filters by kind + status + source type", () => {
    const a = ext({ kind: "agent", status: "active" });
    expect(matchesLifecycleFilter(a, { kind: "agent" })).toBe(true);
    expect(matchesLifecycleFilter(a, { kind: "skill" })).toBe(false);
    expect(matchesLifecycleFilter(a, { status: "archived" })).toBe(false);
    expect(matchesLifecycleFilter(a, { sourceType: "verdaccio" })).toBe(true);
    expect(matchesLifecycleFilter(a, { sourceType: "github" })).toBe(false);
  });

  it("filters by locked + required flags", () => {
    const locked = ext({ status: "locked", requiredInProd: true });
    expect(matchesLifecycleFilter(locked, { locked: true })).toBe(true);
    expect(matchesLifecycleFilter(locked, { locked: false })).toBe(false);
    expect(matchesLifecycleFilter(locked, { requiredInProd: true })).toBe(true);
  });

  it("free-text search matches package name + provenance", () => {
    const gh = ext({ source: { type: "github", repo: "cinatra-ai/foo", ref: "v1", resolvedSha: "abc" } });
    expect(matchesLifecycleFilter(gh, { search: "github" })).toBe(true);
    expect(matchesLifecycleFilter(gh, { search: "cinatra-ai/foo" })).toBe(true);
    expect(matchesLifecycleFilter(gh, { search: "nonsense" })).toBe(false);
  });
});

describe("pickLifecycleBadgeStatus (cinatra#957 — per-row lifecycle badge)", () => {
  it("locked wins over everything — a locked system extension is never shown as plain Active", () => {
    expect(pickLifecycleBadgeStatus([{ status: "locked" }])).toBe("locked");
    expect(
      pickLifecycleBadgeStatus([{ status: "active" }, { status: "locked" }]),
    ).toBe("locked");
    expect(
      pickLifecycleBadgeStatus([{ status: "archived" }, { status: "locked" }]),
    ).toBe("locked");
  });

  it("live-wins: any active row makes the badge Active even with archived siblings", () => {
    expect(pickLifecycleBadgeStatus([{ status: "active" }])).toBe("active");
    expect(
      pickLifecycleBadgeStatus([{ status: "archived" }, { status: "active" }]),
    ).toBe("active");
  });

  it("all-archived rows read as Archived", () => {
    expect(pickLifecycleBadgeStatus([{ status: "archived" }])).toBe("archived");
    expect(
      pickLifecycleBadgeStatus([{ status: "archived" }, { status: "archived" }]),
    ).toBe("archived");
  });

  it("fail-lives to Active for no rows / undefined / unknown statuses (row already passed the active gate)", () => {
    expect(pickLifecycleBadgeStatus([])).toBe("active");
    expect(pickLifecycleBadgeStatus(undefined)).toBe("active");
    expect(pickLifecycleBadgeStatus([{ status: "bogus" }])).toBe("active");
  });

  it("returns only canonical lifecycle statuses", () => {
    const combos: Array<Array<{ status: string }>> = [
      [],
      [{ status: "active" }],
      [{ status: "archived" }],
      [{ status: "locked" }],
      [{ status: "active" }, { status: "archived" }, { status: "locked" }],
    ];
    for (const rows of combos) {
      expect(["active", "archived", "locked"]).toContain(
        pickLifecycleBadgeStatus(rows),
      );
    }
  });
});
