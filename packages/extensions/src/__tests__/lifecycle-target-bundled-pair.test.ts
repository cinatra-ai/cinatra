import { describe, it, expect } from "vitest";
import type { Actor } from "@cinatra-ai/extension-types";
import type { InstalledExtension } from "../canonical-types";
import {
  evaluateLifecycleCapabilities,
  resolveLifecycleScope,
  pickLifecycleTargetRow,
  AmbiguousLifecycleTargetError,
} from "../lifecycle-target-resolver";

// ---------------------------------------------------------------------------
// cinatra#2762 — the lifecycle resolver must apply the SHARED source-precedence
// policy, like every other row-picking seam.
//
// THE DEFECT, as the reviewer's own screenshot shows it. A package that ships in
// the image AND holds a marketplace install has TWO live rows, both at org-NULL:
// the bundled anchor and the install. Supersession (`effectiveInstallRows`)
// removes only superseded ORGANIZATION rows, so both reached the "exactly one"
// count and every lifecycle op on that package answered `ambiguous_target`:
//   - Archive, Activate and Reinstall rendered DISABLED with "More than one
//     install matches your scope" — immediately after the install that CREATED
//     the pair;
//   - Retry activation and Roll back to bundled rendered ENABLED (they take a
//     different capability path) and then THREW AmbiguousLifecycleTargetError
//     out of `resolveLifecycleTargetRow`.
// So a successful install disabled every recovery affordance — #2762 item 2.
//
// The fix is deliberately narrow: only the bundled + SINGLE-marketplace pair
// widens. The negative half of this file is the load-bearing half — every other
// case keeps its old outcome exactly.
// ---------------------------------------------------------------------------

const PKG = "@cinatra-ai/google-appointment-schedules-connector";

function row(
  id: string,
  extra: Partial<InstalledExtension> = {},
): InstalledExtension {
  return {
    id,
    packageName: PKG,
    ownerLevel: "platform",
    ownerId: null,
    organizationId: null,
    kind: "connector",
    status: "active",
    source: { type: "verdaccio", version: "0.1.1" } as InstalledExtension["source"],
    requiredInProd: false,
    dependencies: [],
    manifestHash: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...extra,
  };
}

/** The row the image always provides. */
const bundled = (extra: Partial<InstalledExtension> = {}) =>
  row("iext_bundled", {
    source: { type: "bundled", version: "0.1.0" } as InstalledExtension["source"],
    ...extra,
  });

/** The marketplace install that overrides it. */
const marketplace = (extra: Partial<InstalledExtension> = {}) =>
  row("iext_installed", {
    ownerLevel: "workspace",
    ownerId: "__platform__",
    ...extra,
  });

const platformAdmin: Actor = {
  actorType: "human",
  userId: "u-admin",
  source: "ui",
  platformRole: "platform_admin",
};

describe("the bundled + marketplace pair resolves to the install", () => {
  it("resolveLifecycleScope picks the marketplace row instead of refusing", () => {
    const res = resolveLifecycleScope([bundled(), marketplace()], platformAdmin);
    expect(res.ok).toBe(true);
    expect(res.ok && res.row.id).toBe("iext_installed");
  });

  it("is order independent — the rows arrive in whatever order the store returns", () => {
    const res = resolveLifecycleScope([marketplace(), bundled()], platformAdmin);
    expect(res.ok && res.row.id).toBe("iext_installed");
  });

  it("a LOCKED install is live and still wins", () => {
    const res = resolveLifecycleScope(
      [bundled(), marketplace({ status: "locked" })],
      platformAdmin,
    );
    expect(res.ok && res.row.id).toBe("iext_installed");
  });

  it("pickLifecycleTargetRow no longer THROWS on the pair (Retry / Roll back)", () => {
    // The enforcement entry point `resolveLifecycleTargetRow` calls — this is the
    // throw that made both recovery actions unusable after a successful install.
    expect(() => pickLifecycleTargetRow([bundled(), marketplace()], platformAdmin)).not.toThrow();
    expect(pickLifecycleTargetRow([bundled(), marketplace()], platformAdmin).id).toBe(
      "iext_installed",
    );
  });

  it("Archive, Activate, Reinstall and Uninstall are ENABLED, not ambiguous_target", () => {
    // The exact defect in `post-install-extension-settings.png`.
    const caps = evaluateLifecycleCapabilities([bundled(), marketplace()], platformAdmin);
    for (const op of ["archive", "activate", "uninstall"] as const) {
      expect(caps[op].allowed, `${op} must be enabled`).toBe(true);
      expect(caps[op].code).toBe("ok");
      expect(caps[op].reason).toBeNull();
    }
  });

  it("the capability verdict and the enforcement agree on the SAME row", () => {
    const rows = [bundled(), marketplace()];
    const caps = evaluateLifecycleCapabilities(rows, platformAdmin);
    expect(caps.archive.allowed).toBe(true);
    expect(pickLifecycleTargetRow(rows, platformAdmin).id).toBe("iext_installed");
  });
});

describe("every other case keeps its old outcome", () => {
  it("TWO competing marketplace installs still refuse as ambiguous_target", () => {
    // NOT `no_addressable_row`: precedence drops every candidate on this pair, and
    // the resolver must fall back to the original set so the refusal CODE (and the
    // operator-facing message) is the one it always was.
    const rows = [
      marketplace({ ownerLevel: "platform", ownerId: null }),
      marketplace({ id: "iext_other" }),
    ];
    const res = resolveLifecycleScope(rows, platformAdmin);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.code).toBe("ambiguous_target");
    expect(() => pickLifecycleTargetRow(rows, platformAdmin)).toThrow(
      AmbiguousLifecycleTargetError,
    );
  });

  it("an ARCHIVED row in the set is left alone — precedence speaks about LIVE rows", () => {
    // `activate` addresses an archived row. Collapsing the set onto a live
    // sibling here would silently retarget the op, so the whole set is left as it
    // was and the pre-existing refusal stands.
    const rows = [bundled(), marketplace({ status: "archived" })];
    const res = resolveLifecycleScope(rows, platformAdmin);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.code).toBe("ambiguous_target");
  });

  it("a row of some OTHER provenance leaves the pair untouched", () => {
    const rows = [
      bundled(),
      marketplace({
        source: {
          type: "github",
          repo: "acme/thing",
          ref: "main",
          resolvedSha: "0".repeat(40),
        } as InstalledExtension["source"],
      }),
    ];
    const res = resolveLifecycleScope(rows, platformAdmin);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.code).toBe("ambiguous_target");
  });

  it("bundled ALONE still resolves the bundled row", () => {
    const res = resolveLifecycleScope([bundled()], platformAdmin);
    expect(res.ok && res.row.id).toBe("iext_bundled");
  });

  it("no rows at all is still no_addressable_row", () => {
    const res = resolveLifecycleScope([], platformAdmin);
    expect(!res.ok && res.code).toBe("no_addressable_row");
  });

  it("supersession still runs FIRST: an org row beside a live workspace install is gone", () => {
    // The precedence narrowing is applied to what supersession leaves, never
    // instead of it.
    const rows = [
      marketplace(),
      row("iext_org", { ownerLevel: "organization", ownerId: "org-1", organizationId: "org-1" }),
    ];
    const res = resolveLifecycleScope(rows, platformAdmin);
    expect(res.ok && res.row.id).toBe("iext_installed");
  });

  it("standing is still gated over the resolved row, not skipped by the narrowing", () => {
    // An org actor facing the org-NULL pair: precedence resolves one row, and the
    // standing check on that row is what refuses — the pre-existing rule.
    const orgMember: Actor = {
      actorType: "human",
      userId: "u-member",
      source: "ui",
      orgId: "org-1",
      orgRole: "member",
    };
    const caps = evaluateLifecycleCapabilities([bundled(), marketplace()], orgMember);
    expect(caps.archive.allowed).toBe(false);
  });
});
