// pickEffectiveStatusForIdentity unit tests.
//
// The biggest correctness risk is status bleed across multiple canonical rows
// for the same package. Marketplace readers resolve status from the canonical
// manifest by exact identity with a platform fallback. These tests pin the
// tie-break so an archived exact-scope row is never masked by an active
// platform/other-scope row.
import { describe, expect, it } from "vitest";

import {
  pickEffectiveStatusForIdentity,
  type CanonicalManifestRow,
} from "../store";

const SENTINEL = "__platform__";

function row(over: Partial<CanonicalManifestRow>): CanonicalManifestRow {
  return {
    package_name: "@cinatra-ai/foo-agent",
    organization_id: "org-1",
    owner_level: "organization",
    owner_id: "org-1",
    status: "active",
    ...over,
  };
}

describe("pickEffectiveStatusForIdentity status-bleed gate", () => {
  const candidate = { orgId: "org-1", ownerLevel: "organization", ownerId: "org-1", packageName: "@cinatra-ai/foo-agent" };

  it("archived EXACT row wins over an active PLATFORM row (no bleed)", () => {
    const rows = [
      row({ status: "archived" }), // exact org-1 row -> archived
      row({ organization_id: null, owner_level: "platform", owner_id: SENTINEL, status: "active" }),
    ];
    expect(pickEffectiveStatusForIdentity(candidate, rows)).toBe("archived");
  });

  it("active EXACT row wins over an archived platform row", () => {
    const rows = [
      row({ status: "active" }),
      row({ organization_id: null, owner_level: "platform", owner_id: SENTINEL, status: "archived" }),
    ];
    expect(pickEffectiveStatusForIdentity(candidate, rows)).toBe("active");
  });

  it("locked EXACT row resolves to legacy 'active'", () => {
    expect(pickEffectiveStatusForIdentity(candidate, [row({ status: "locked" })])).toBe("active");
  });

  it("falls back to the PLATFORM row when no exact-scope row exists", () => {
    const rows = [
      row({ organization_id: null, owner_level: "platform", owner_id: SENTINEL, status: "archived" }),
    ];
    expect(pickEffectiveStatusForIdentity(candidate, rows)).toBe("archived");
  });

  it("ignores a same-package row from a DIFFERENT org (scope isolation)", () => {
    const rows = [
      row({ organization_id: "org-2", owner_id: "org-2", status: "archived" }),
    ];
    // No exact org-1 row, no platform row -> null (caller grandfathers to active).
    expect(pickEffectiveStatusForIdentity(candidate, rows)).toBeNull();
  });

  it("returns null when the package has no canonical row at all", () => {
    expect(pickEffectiveStatusForIdentity(candidate, [])).toBeNull();
  });

  it("normalizes a null owner_level to 'organization' (matches data backfill)", () => {
    const nullLevelCandidate = { orgId: "org-1", ownerLevel: null, ownerId: "org-1", packageName: "@cinatra-ai/foo-agent" };
    // Null owner_level values normalize to "organization"; the exact match
    // must still resolve.
    expect(pickEffectiveStatusForIdentity(nullLevelCandidate, [row({ status: "archived" })])).toBe("archived");
  });

  it("platform candidate matches the sentinel owner_id", () => {
    const platformCandidate = { orgId: null, ownerLevel: "platform", ownerId: null, packageName: "@cinatra-ai/foo-agent" };
    const rows = [row({ organization_id: null, owner_level: "platform", owner_id: SENTINEL, status: "archived" })];
    expect(pickEffectiveStatusForIdentity(platformCandidate, rows)).toBe("archived");
  });
});
