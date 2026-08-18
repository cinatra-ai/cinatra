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

  it("an archived row of an UNKNOWN provenance is left alone", () => {
    // The archived arm below speaks only about a MARKETPLACE install beside
    // bundled fallbacks. Any other provenance means the ranking is unknown, so
    // the set is left exactly as it was and the pre-existing refusal stands.
    const rows = [
      bundled(),
      marketplace({
        status: "archived",
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

// ---------------------------------------------------------------------------
// cinatra#2762 round 5 — THE POST-ROLLBACK PAIR: rollback must not be a one-way
// door.
//
// `rollBackExtensionToBundledFormAction` archives the install and reactivates
// the bundled row, so it leaves {bundled LIVE, install ARCHIVED} BY
// CONSTRUCTION. Precedence used to bail on any non-live candidate, so that pair
// counted as two and the next visit to the settings page answered
// `ambiguous_target` for every op: Activate greyed as "More than one install
// matches your scope", Retry and Roll back hidden. The recovery #2762 item 2
// asks for could be taken once and never undone.
//
// The pair now resolves to the ARCHIVED INSTALL, because that is the row every
// op on it means — above all `activate`, which addresses an archived row by
// definition and is the way back through the door.
// ---------------------------------------------------------------------------
describe("the post-rollback pair (live bundled + archived install)", () => {
  const rolledBack = () => [bundled(), marketplace({ status: "archived" })];

  it("resolves to the ARCHIVED INSTALL — not ambiguous, and not the live bundle", () => {
    const res = resolveLifecycleScope(rolledBack(), platformAdmin);
    expect(res.ok).toBe(true);
    expect(res.ok && res.row.id).toBe("iext_installed");
    expect(res.ok && res.row.status).toBe("archived");
  });

  it("is order independent", () => {
    const res = resolveLifecycleScope(
      [marketplace({ status: "archived" }), bundled()],
      platformAdmin,
    );
    expect(res.ok && res.row.id).toBe("iext_installed");
  });

  it("ACTIVATE is enabled — this is the way back through the door", () => {
    // The exact affordance #2762 item 2 requires: after a rollback the operator
    // can put the install back. It was `ambiguous_target` (greyed, "More than
    // one install matches your scope") before this arm existed.
    const caps = evaluateLifecycleCapabilities(rolledBack(), platformAdmin);
    expect(caps.activate.allowed).toBe(true);
    expect(caps.activate.code).toBe("ok");
  });

  it("the recovery actions can RESOLVE the pair instead of throwing", () => {
    // Both recovery actions call `resolveLifecycleTargetRow`, whose throwing
    // core is this. It raised AmbiguousLifecycleTargetError on this exact set.
    expect(() => pickLifecycleTargetRow(rolledBack(), platformAdmin)).not.toThrow();
    expect(pickLifecycleTargetRow(rolledBack(), platformAdmin).id).toBe("iext_installed");
  });

  it("the capability verdict and the enforcement agree on the SAME row", () => {
    const rows = rolledBack();
    expect(evaluateLifecycleCapabilities(rows, platformAdmin).activate.allowed).toBe(true);
    expect(pickLifecycleTargetRow(rows, platformAdmin).id).toBe("iext_installed");
  });

  it("a NAMED TIER still reaches the live bundled row, so the bundle is addressable", () => {
    // The selector the settings loader mints is what re-addresses the OTHER
    // tier at the same org-NULL scope; the narrowing runs after that filter, on
    // a one-row set, and leaves it alone.
    const res = resolveLifecycleScope(rolledBack(), platformAdmin, {
      ownerLevel: "platform",
    });
    expect(res.ok && res.row.id).toBe("iext_bundled");
  });

  it("standing is still gated over the resolved row", () => {
    const orgMember: Actor = {
      actorType: "human",
      userId: "u-member",
      source: "ui",
      orgId: "org-1",
      orgRole: "member",
    };
    expect(
      evaluateLifecycleCapabilities(rolledBack(), orgMember).activate.allowed,
    ).toBe(false);
  });
});

describe("the archived arm refuses to widen anything else", () => {
  it("TWO archived installs beside the bundle stay ambiguous", () => {
    // No single answer to "which one did the operator mean" — the guess this
    // resolver exists not to make.
    const rows = [
      bundled(),
      marketplace({ status: "archived" }),
      marketplace({ id: "iext_other", status: "archived" }),
    ];
    const res = resolveLifecycleScope(rows, platformAdmin);
    expect(!res.ok && res.code).toBe("ambiguous_target");
  });

  it("a LIVE install beside an archived one stays ambiguous", () => {
    // Both are real targets: the live one is serving, the archived one is
    // restorable. This is not the post-rollback shape.
    const rows = [
      marketplace({ id: "iext_live" }),
      marketplace({ status: "archived" }),
    ];
    const res = resolveLifecycleScope(rows, platformAdmin);
    expect(!res.ok && res.code).toBe("ambiguous_target");
  });

  it("an archived install beside an ARCHIVED bundle stays ambiguous", () => {
    // The arm keys on a LIVE bundled fallback — the state a rollback actually
    // leaves. Two archived rows are not that state.
    const rows = [
      bundled({ status: "archived" }),
      marketplace({ status: "archived" }),
    ];
    const res = resolveLifecycleScope(rows, platformAdmin);
    expect(!res.ok && res.code).toBe("ambiguous_target");
  });

  it("a NON-DEFAULT archived install is not the target", () => {
    const rows = [bundled(), marketplace({ status: "archived", isDefault: false })];
    const res = resolveLifecycleScope(rows, platformAdmin);
    expect(!res.ok && res.code).toBe("ambiguous_target");
  });

  it("an archived install ALONE still resolves to itself, unchanged", () => {
    const res = resolveLifecycleScope([marketplace({ status: "archived" })], platformAdmin);
    expect(res.ok && res.row.id).toBe("iext_installed");
  });

  it("supersession still runs FIRST", () => {
    // A live workspace install supersedes the org rows before any of this runs.
    const rows = [
      marketplace(),
      row("iext_org", {
        ownerLevel: "organization",
        ownerId: "org-1",
        organizationId: "org-1",
        status: "archived",
      }),
    ];
    const res = resolveLifecycleScope(rows, platformAdmin);
    expect(res.ok && res.row.id).toBe("iext_installed");
  });
});
