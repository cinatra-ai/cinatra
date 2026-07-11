import { describe, it, expect, vi } from "vitest";
import {
  buildSideBySideGrantCapsule,
  parseSideBySideGrantCapsule,
  reconcileSideBySideOwnershipOnTeardown,
} from "@/lib/extension-side-by-side-install";

describe("buildSideBySideGrantCapsule", () => {
  it("sorts + de-duplicates declared keys and stamps v:1", () => {
    expect(buildSideBySideGrantCapsule(["b_widget_auth", "a_widget_auth", "b_widget_auth"])).toEqual({
      v: 1,
      declaredTokenKeys: ["a_widget_auth", "b_widget_auth"],
    });
  });
  it("returns null when no keys are declared (nothing to reconcile → no capsule)", () => {
    expect(buildSideBySideGrantCapsule([])).toBeNull();
  });
});

describe("parseSideBySideGrantCapsule", () => {
  it("narrows a well-formed JSONB payload", () => {
    expect(parseSideBySideGrantCapsule({ v: 1, declaredTokenKeys: ["k_widget_auth"] })).toEqual({
      v: 1,
      declaredTokenKeys: ["k_widget_auth"],
    });
  });
  it("is tolerant of legacy/absent/garbage (null, no throw)", () => {
    expect(parseSideBySideGrantCapsule(null)).toBeNull();
    expect(parseSideBySideGrantCapsule(undefined)).toBeNull();
    expect(parseSideBySideGrantCapsule({ v: 2, declaredTokenKeys: [] })).toBeNull();
    expect(parseSideBySideGrantCapsule({ v: 1, declaredTokenKeys: "nope" })).toBeNull();
    expect(parseSideBySideGrantCapsule("garbage")).toBeNull();
  });
  it("drops non-string entries and de-dupes/sorts", () => {
    expect(
      parseSideBySideGrantCapsule({ v: 1, declaredTokenKeys: ["b", 1, "a", "b", null] }),
    ).toEqual({ v: 1, declaredTokenKeys: ["a", "b"] });
  });
});

describe("reconcileSideBySideOwnershipOnTeardown — survivor-check + revoke", () => {
  const base = { packageName: "@v/wp-connector", orgId: null as string | null };

  it("REVOKES a key no surviving sibling declares (net-new / last-declarer)", async () => {
    const revoke = vi.fn(async () => {});
    const res = await reconcileSideBySideOwnershipOnTeardown({
      ...base,
      declaredTokenKeys: ["wp_widget_auth"],
      survivorKeys: new Set<string>(), // no survivor declares it
      revokeOwnershipGrant: revoke,
      onFailure: () => {},
    });
    expect(revoke).toHaveBeenCalledWith({
      packageName: base.packageName,
      orgId: null,
      tokenConfigKey: "wp_widget_auth",
    });
    expect(res).toEqual({ revoked: ["wp_widget_auth"], kept: [] });
  });

  it("KEEPS a key a surviving sibling still declares (never revoke a live key)", async () => {
    const revoke = vi.fn(async () => {});
    const res = await reconcileSideBySideOwnershipOnTeardown({
      ...base,
      declaredTokenKeys: ["wp_widget_auth"],
      survivorKeys: new Set(["wp_widget_auth"]), // the default (or another sibling) still declares it
      revokeOwnershipGrant: revoke,
      onFailure: () => {},
    });
    expect(revoke).not.toHaveBeenCalled();
    expect(res).toEqual({ revoked: [], kept: ["wp_widget_auth"] });
  });

  it("mixes: revokes orphaned keys, keeps survivor-declared keys", async () => {
    const revoke = vi.fn(async () => {});
    const res = await reconcileSideBySideOwnershipOnTeardown({
      ...base,
      declaredTokenKeys: ["shared_widget_auth", "orphan_widget_auth"],
      survivorKeys: new Set(["shared_widget_auth"]),
      revokeOwnershipGrant: revoke,
      onFailure: () => {},
    });
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith({
      packageName: base.packageName,
      orgId: null,
      tokenConfigKey: "orphan_widget_auth",
    });
    expect(res.revoked).toEqual(["orphan_widget_auth"]);
    expect(res.kept).toEqual(["shared_widget_auth"]);
  });

  it("closes the round-1 resurrection hole: with NO surviving declarer the key is REVOKED, never restored", async () => {
    // A introduced+approved K, B captured it, A removed while B survived (K kept),
    // then B removed. At B's teardown the survivor set no longer contains K → revoke.
    const revoke = vi.fn(async () => {});
    const res = await reconcileSideBySideOwnershipOnTeardown({
      ...base,
      declaredTokenKeys: ["k_widget_auth"],
      survivorKeys: new Set<string>(), // A already gone; no live declarer
      revokeOwnershipGrant: revoke,
      onFailure: () => {},
    });
    expect(res.revoked).toEqual(["k_widget_auth"]);
  });

  it("de-duplicates declared keys (revokes once)", async () => {
    const revoke = vi.fn(async () => {});
    const res = await reconcileSideBySideOwnershipOnTeardown({
      ...base,
      declaredTokenKeys: ["dupe_widget_auth", "dupe_widget_auth"],
      survivorKeys: new Set<string>(),
      revokeOwnershipGrant: revoke,
      onFailure: () => {},
    });
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(res.revoked).toEqual(["dupe_widget_auth"]);
  });

  it("is best-effort + isolated: a revoke failure routes to onFailure and never throws", async () => {
    const failures: Array<{ key: string; err: unknown }> = [];
    const revoke = vi.fn(async ({ tokenConfigKey }: { tokenConfigKey: string }) => {
      if (tokenConfigKey === "boom_widget_auth") throw new Error("db down");
    });
    const res = await reconcileSideBySideOwnershipOnTeardown({
      ...base,
      declaredTokenKeys: ["boom_widget_auth", "ok_widget_auth"],
      survivorKeys: new Set<string>(),
      revokeOwnershipGrant: revoke,
      onFailure: (key, err) => failures.push({ key, err }),
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]!.key).toBe("boom_widget_auth");
    expect(res.revoked).toEqual(["ok_widget_auth"]); // the other key still revoked
  });
});
