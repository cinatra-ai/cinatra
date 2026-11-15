// cinatra#4387 — the REAL `getDevInstallConnectionOwner` (external-mcp-registry.ts),
// which the drupal-mcp dev members read to bind a dev-hook instance save. The
// publication suite replaces the registry module with a mock, so this file pins
// the getter itself: it maps each id to its own field, returns null without an
// owner, and returns a COPY (a caller cannot change the holder).

import { describe, it, expect, vi, beforeEach } from "vitest";

// `@/lib/database` resolves to the inert test stub via the root vitest alias; the
// registry's lowest-level effect is stubbed as in dev-attach-twenty-bearer.test.ts.
vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: () => [{ rows: [], rowCount: 0 }],
}));

const { getDevInstallConnectionOwner, setDevActorForExternalMcp } = await import("@/lib/external-mcp-registry");

beforeEach(() => {
  setDevActorForExternalMcp(null);
});

describe("getDevInstallConnectionOwner (cinatra#4387)", () => {
  it("returns null when the boot pushed no owner", () => {
    expect(getDevInstallConnectionOwner()).toBeNull();
  });

  it("returns the pushed owner with each id in its own field", () => {
    setDevActorForExternalMcp({ userId: "u-dev-1", organizationId: "o-dev-1" });
    expect(getDevInstallConnectionOwner()).toEqual({ userId: "u-dev-1", organizationId: "o-dev-1" });
    setDevActorForExternalMcp(null);
    expect(getDevInstallConnectionOwner()).toBeNull();
  });

  it("returns a copy: changing the result changes neither the holder nor the next read", () => {
    const pushed = { userId: "u-dev-1", organizationId: "o-dev-1" };
    setDevActorForExternalMcp(pushed);
    const first = getDevInstallConnectionOwner()!;
    expect(first).not.toBe(pushed);
    first.userId = "u-other";
    first.organizationId = "o-other";
    expect(getDevInstallConnectionOwner()).toEqual({ userId: "u-dev-1", organizationId: "o-dev-1" });
    expect(pushed).toEqual({ userId: "u-dev-1", organizationId: "o-dev-1" });
  });
});
