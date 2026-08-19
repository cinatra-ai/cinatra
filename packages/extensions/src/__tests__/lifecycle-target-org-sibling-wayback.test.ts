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
// cinatra#2856 — the ORG-SIBLING variant of the rollback way back.
//
// #2774 (cinatra#2762) closed the one-way door for the org-NULL pair: after
// "Roll back to bundled" the {live bundled, archived install} pair resolves to
// the ARCHIVED INSTALL, so Activate is the way back. groganz's round-6 review
// found the variant that survives it, and this file is its pin.
//
// THE DEFECT. The org-NULL rows reach a PLATFORM ADMIN in an ORG-SCOPED session
// through arm 2 of `addressableLifecycleRows` (`platformFallback`), which
// `resolveLifecycleScope` consults ONLY while arm 1 (the actor's own scope) is
// empty. A rollback flips exactly that gate:
//
//   - BEFORE: the workspace install is LIVE, so supersession removes the
//     organization sibling, arm 1 is EMPTY, arm 2 runs, and the platform admin
//     resolves and operates the app-wide install from their org-scoped session.
//   - AFTER: the install is archived, supersession LIFTS, the organization
//     sibling returns to arm 1 — and arm 2 goes dark WITH the archived install
//     inside it. The page silently retargets to the organization's own row and
//     the app-wide install has no affordance at all in that session.
//
// THE FIX IS A REFUSAL, NOT A REOPEN. The two candidates are both real and mean
// different rows (a live own-scope organization install; an archived app-wide
// install that is still restorable), so resolving one would silently retarget
// an administrator's destructive ops across tiers — which is the guess this
// resolver exists not to make, and would break arm 2's invariant that it only
// ever converts a REFUSAL into a resolution. The arm therefore stops HIDING the
// second candidate: the shape now refuses `ambiguous_target` with a reason that
// NAMES the recovery, which is the half a bare `ambiguous_target` never had.
//
// The negative half of this file is the load-bearing half — exactly ONE shape
// changes verdict and every other case keeps its old outcome.
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

/** The row the image always provides, at the org-NULL platform tier. */
const bundled = (extra: Partial<InstalledExtension> = {}) =>
  row("iext_bundled", {
    source: { type: "bundled", version: "0.1.0" } as InstalledExtension["source"],
    ...extra,
  });

/** The app-wide marketplace install, at the WORKSPACE anchor. */
const marketplace = (extra: Partial<InstalledExtension> = {}) =>
  row("iext_installed", {
    ownerLevel: "workspace",
    ownerId: "__platform__",
    ...extra,
  });

/** The ORGANIZATION sibling supersession releases when the install is archived. */
const orgSibling = (extra: Partial<InstalledExtension> = {}) =>
  row("iext_org", {
    ownerLevel: "organization",
    ownerId: "org-a",
    organizationId: "org-a",
    ...extra,
  });

/** A platform admin WITH an active organization — the only principal arm 2
 *  exists for, and the only one this arm can reach. */
const platformAdminInOrg: Actor = {
  actorType: "human",
  userId: "u-admin",
  source: "ui",
  orgId: "org-a",
  platformRole: "platform_admin",
};

/** The same administrator with no active organization — where the recovery is. */
const platformAdminNullOrg: Actor = {
  actorType: "human",
  userId: "u-admin",
  source: "ui",
  platformRole: "platform_admin",
};

const orgAdmin: Actor = {
  actorType: "human",
  userId: "u-org-admin",
  source: "ui",
  orgId: "org-a",
  orgRole: "org_admin",
};

/** The state a completed rollback leaves, WITH an organization sibling. */
const stranded = () => [bundled(), marketplace({ status: "archived" }), orgSibling()];

describe("the org-sibling strand is attributable, not silent", () => {
  it("REFUSES instead of silently resolving the organization sibling", () => {
    // Before this arm the org-scoped platform admin resolved `iext_org` here —
    // a different row, at a different tier, with no sign that the app-wide
    // install they had just rolled back still existed.
    const res = resolveLifecycleScope(stranded(), platformAdminInOrg);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.code).toBe("ambiguous_target");
  });

  it("counts BOTH candidates — the sibling and the row arm 2 was hiding", () => {
    const res = resolveLifecycleScope(stranded(), platformAdminInOrg);
    expect(!res.ok && res.code === "ambiguous_target" && res.count).toBe(2);
  });

  it("the refusal NAMES the recovery", () => {
    const res = resolveLifecycleScope(stranded(), platformAdminInOrg);
    const reason = !res.ok && res.code === "ambiguous_target" ? res.reason : undefined;
    expect(reason).toBeTruthy();
    expect(reason).toContain("app-wide install");
    expect(reason).toContain("active organization");
  });

  it("is scope-shaped copy — never a row id, never an organization id", () => {
    const res = resolveLifecycleScope(stranded(), platformAdminInOrg);
    const reason = (!res.ok && res.code === "ambiguous_target" && res.reason) || "";
    expect(reason).not.toContain("iext_");
    expect(reason).not.toContain("org-a");
  });

  it("is order independent — rows arrive in whatever order the store returns", () => {
    const orders = [
      [orgSibling(), marketplace({ status: "archived" }), bundled()],
      [marketplace({ status: "archived" }), bundled(), orgSibling()],
      [bundled(), orgSibling(), marketplace({ status: "archived" })],
    ];
    for (const rows of orders) {
      const res = resolveLifecycleScope(rows, platformAdminInOrg);
      expect(!res.ok && res.code).toBe("ambiguous_target");
      expect(!res.ok && res.code === "ambiguous_target" && res.reason).toBeTruthy();
    }
  });

  it("every row-scoped capability carries the ATTRIBUTABLE reason, not the generic copy", () => {
    const caps = evaluateLifecycleCapabilities(stranded(), platformAdminInOrg);
    for (const op of ["archive", "activate", "uninstall"] as const) {
      expect(caps[op].allowed, `${op} must be refused`).toBe(false);
      expect(caps[op].code).toBe("ambiguous_target");
      expect(caps[op].reason).toContain("app-wide install");
      expect(caps[op].reason).not.toContain("contact an administrator");
    }
  });

  it("the throwing enforcement path carries the reason too", () => {
    // Both recovery actions reach the resolver through `pickLifecycleTargetRow`,
    // so the refusal an operator sees in a log must be attributable there as well.
    expect(() => pickLifecycleTargetRow(stranded(), platformAdminInOrg)).toThrow(
      AmbiguousLifecycleTargetError,
    );
    try {
      pickLifecycleTargetRow(stranded(), platformAdminInOrg);
      throw new Error("unreachable");
    } catch (err) {
      expect(err).toBeInstanceOf(AmbiguousLifecycleTargetError);
      const e = err as AmbiguousLifecycleTargetError;
      expect(e.reason).toContain("app-wide install");
      expect(e.message).toContain("app-wide install");
      expect(e.count).toBe(2);
    }
  });

  it("the capability verdict and the enforcement agree", () => {
    const rows = stranded();
    expect(evaluateLifecycleCapabilities(rows, platformAdminInOrg).activate.allowed).toBe(
      false,
    );
    expect(() => pickLifecycleTargetRow(rows, platformAdminInOrg)).toThrow(
      AmbiguousLifecycleTargetError,
    );
  });
});

describe("the recovery the refusal names actually works", () => {
  it("a PLATFORM-SCOPED session resolves the archived install — arm (b), unchanged", () => {
    // The literal recovery in the copy: with no active organization the actor's
    // own scope IS the org-NULL rows, so #2774's archived-install precedence arm
    // runs and the way back is a click.
    const res = resolveLifecycleScope(stranded(), platformAdminNullOrg);
    expect(res.ok).toBe(true);
    expect(res.ok && res.row.id).toBe("iext_installed");
    expect(res.ok && res.row.status).toBe("archived");
  });

  it("ACTIVATE is enabled there — the door is genuinely reopenable", () => {
    const caps = evaluateLifecycleCapabilities(stranded(), platformAdminNullOrg);
    expect(caps.activate.allowed).toBe(true);
    expect(caps.activate.code).toBe("ok");
  });

  it("a NAMED TIER still reaches the archived install from the org-scoped session", () => {
    // The selector path is NOT stranded — `addressable.all` is arm 1 plus arm 2
    // — so this arm must leave it exactly as it was.
    const res = resolveLifecycleScope(stranded(), platformAdminInOrg, {
      ownerLevel: "workspace",
    });
    expect(res.ok && res.row.id).toBe("iext_installed");
  });

  it("a NAMED TIER still reaches the organization sibling, and the bundle", () => {
    const org = resolveLifecycleScope(stranded(), platformAdminInOrg, {
      ownerLevel: "organization",
    });
    expect(org.ok && org.row.id).toBe("iext_org");
    const bundle = resolveLifecycleScope(stranded(), platformAdminInOrg, {
      ownerLevel: "platform",
    });
    expect(bundle.ok && bundle.row.id).toBe("iext_bundled");
  });

  it("the door WAS open before the rollback — this is the state that shuts it", () => {
    // With the workspace install live, supersession removes the sibling, arm 1
    // is empty and arm 2 resolves the install for this very actor. That is what
    // makes the post-rollback silence a one-way door rather than a scope rule.
    const res = resolveLifecycleScope(
      [bundled(), marketplace(), orgSibling()],
      platformAdminInOrg,
    );
    expect(res.ok && res.row.id).toBe("iext_installed");
  });
});

describe("the strand is the NARROWING, not a row count (round 2)", () => {
  // The arm's firing condition is "arm 2 narrows to exactly one archived
  // default WORKSPACE install", and `narrowByArchivedInstallPrecedence` admits
  // ANY NUMBER of live bundled anchors beside that install. So a THREE-row
  // fallback is the same strand as the literal pair, and these pin that the
  // doc, the code and the reported count all say so.
  const secondBundle = () =>
    bundled({
      id: "iext_bundled_b",
      source: { type: "bundled", version: "0.0.9" } as InstalledExtension["source"],
    });

  /** The same post-rollback strand with a SECOND live bundled anchor in arm 2. */
  const strandedWide = () => [
    bundled(),
    secondBundle(),
    marketplace({ status: "archived" }),
    orgSibling(),
  ];

  it("a THREE-row fallback still refuses, and still names the recovery", () => {
    // Tightening the arm to `platformFallback.length === 2` would resolve
    // `iext_org` here and re-silence a genuinely stranded archived install —
    // the exact defect cinatra#2856 exists to close.
    const res = resolveLifecycleScope(strandedWide(), platformAdminInOrg);
    expect(!res.ok && res.code).toBe("ambiguous_target");
    expect(!res.ok && res.code === "ambiguous_target" && res.reason).toContain(
      "app-wide install",
    );
  });

  it("counts TARGETS, not rows — still 2 with four rows in play", () => {
    // The extra bundled anchor is not a target: the SAME narrowing collapses it
    // away in the recovery session below, so counting it would advertise a
    // choice the operator is never offered — and contradict the copy beside it,
    // which names exactly two installs.
    const res = resolveLifecycleScope(strandedWide(), platformAdminInOrg);
    expect(!res.ok && res.code === "ambiguous_target" && res.count).toBe(2);
    try {
      pickLifecycleTargetRow(strandedWide(), platformAdminInOrg);
      throw new Error("unreachable");
    } catch (err) {
      expect(err).toBeInstanceOf(AmbiguousLifecycleTargetError);
      expect((err as AmbiguousLifecycleTargetError).count).toBe(2);
    }
  });

  it("the named recovery works there too — arm (b) applies the SAME narrowing", () => {
    // This is WHY the wide set may fire: clearing the active organization makes
    // arm 2 the actor's own scope, and `narrowByArchivedInstallPrecedence` runs
    // over THESE SAME rows to THE SAME single row. The recovery never read the
    // row count, so the firing condition must not either.
    const res = resolveLifecycleScope(strandedWide(), platformAdminNullOrg);
    expect(res.ok && res.row.id).toBe("iext_installed");
    expect(res.ok && res.row.status).toBe("archived");
    expect(
      evaluateLifecycleCapabilities(strandedWide(), platformAdminNullOrg).activate.allowed,
    ).toBe(true);
  });

  it("a wide fallback whose narrowing FAILS is still left alone", () => {
    // The counterpart, at the width this round admits: FOUR fallback rows that
    // do NOT reduce to one — two archived installs have no single answer to
    // "which did the operator mean" — keep their old verdict. The loosened arm
    // is bounded by the narrowing and by nothing else, at every width. The
    // three-row form of this is pinned below and stays.
    const res = resolveLifecycleScope(
      [
        bundled(),
        secondBundle(),
        marketplace({ status: "archived" }),
        marketplace({ id: "iext_other", status: "archived" }),
        orgSibling(),
      ],
      platformAdminInOrg,
    );
    expect(res.ok && res.row.id).toBe("iext_org");
  });

  it("a wide fallback of only LIVE bundles strands nothing", () => {
    const res = resolveLifecycleScope(
      [bundled(), secondBundle(), orgSibling()],
      platformAdminInOrg,
    );
    expect(res.ok && res.row.id).toBe("iext_org");
  });

  it("every row-scoped capability carries the reason for the wide set too", () => {
    const caps = evaluateLifecycleCapabilities(strandedWide(), platformAdminInOrg);
    for (const op of ["archive", "activate", "uninstall"] as const) {
      expect(caps[op].allowed, `${op} must be refused`).toBe(false);
      expect(caps[op].reason).toContain("app-wide install");
    }
  });
});

describe("the org-sibling arm refuses to widen anything else", () => {
  it("supersession still runs FIRST — a LIVE workspace install hides the sibling", () => {
    const res = resolveLifecycleScope(
      [bundled(), marketplace(), orgSibling({ status: "archived" })],
      platformAdminInOrg,
    );
    expect(res.ok && res.row.id).toBe("iext_installed");
  });

  it("keys on the ARM, not the sibling's tier — a user-anchored sibling strands too", () => {
    // The mechanism is "arm 1 is non-empty", so any row anchored inside the
    // actor's organization hides arm 2. Refusing only for `ownerLevel:
    // 'organization'` would fix the reviewer's example and leave its twin
    // silent, which is the same door with a narrower frame.
    const userRow = row("iext_user", {
      ownerLevel: "user",
      ownerId: "u-someone",
      organizationId: "org-a",
    });
    const res = resolveLifecycleScope(
      [bundled(), marketplace({ status: "archived" }), userRow],
      platformAdminInOrg,
    );
    expect(!res.ok && res.code).toBe("ambiguous_target");
    expect(!res.ok && res.code === "ambiguous_target" && res.reason).toContain(
      "app-wide install",
    );
  });

  it("an ORG ADMIN is untouched — arm 2 is empty for them, their row resolves", () => {
    // No platform standing means no fallback arm, so nothing was ever hidden
    // from them and nothing may be taken away.
    const res = resolveLifecycleScope(stranded(), orgAdmin);
    expect(res.ok).toBe(true);
    expect(res.ok && res.row.id).toBe("iext_org");
  });

  it("an organization row with NO org-NULL rows is completely unaffected", () => {
    for (const actor of [platformAdminInOrg, orgAdmin]) {
      const res = resolveLifecycleScope([orgSibling()], actor);
      expect(res.ok && res.row.id).toBe("iext_org");
    }
  });

  it("a live bundled fallback with NO archived install strands nothing", () => {
    const res = resolveLifecycleScope([bundled(), orgSibling()], platformAdminInOrg);
    expect(res.ok && res.row.id).toBe("iext_org");
  });

  it("a live app-wide install beside the sibling is not this shape either", () => {
    // Supersession already removed the sibling here; arm 2 resolves the install.
    const res = resolveLifecycleScope([marketplace(), orgSibling()], platformAdminInOrg);
    expect(res.ok && res.row.id).toBe("iext_installed");
  });

  it("a LONE archived install in arm 2 is not the post-rollback PAIR", () => {
    // A single-row fallback narrows to itself, which is not the state a
    // rollback leaves — the arm keys on the pair #2774 named.
    const res = resolveLifecycleScope(
      [marketplace({ status: "archived" }), orgSibling()],
      platformAdminInOrg,
    );
    expect(res.ok && res.row.id).toBe("iext_org");
  });

  it("TWO archived installs in arm 2 stay hidden — no single answer to reopen", () => {
    const res = resolveLifecycleScope(
      [
        bundled(),
        marketplace({ status: "archived" }),
        marketplace({ id: "iext_other", status: "archived" }),
        orgSibling(),
      ],
      platformAdminInOrg,
    );
    expect(res.ok && res.row.id).toBe("iext_org");
  });

  it("an archived install beside an ARCHIVED bundle is not the rollback state", () => {
    const res = resolveLifecycleScope(
      [bundled({ status: "archived" }), marketplace({ status: "archived" }), orgSibling()],
      platformAdminInOrg,
    );
    expect(res.ok && res.row.id).toBe("iext_org");
  });

  it("a NON-DEFAULT archived install is not the target", () => {
    const res = resolveLifecycleScope(
      [bundled(), marketplace({ status: "archived", isDefault: false }), orgSibling()],
      platformAdminInOrg,
    );
    expect(res.ok && res.row.id).toBe("iext_org");
  });

  it("an archived install of an UNKNOWN provenance is left alone", () => {
    const res = resolveLifecycleScope(
      [
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
        orgSibling(),
      ],
      platformAdminInOrg,
    );
    expect(res.ok && res.row.id).toBe("iext_org");
  });

  it("an archived install at the PLATFORM tier is not the WORKSPACE anchor", () => {
    // The strand is about the app-wide install a rollback archives. An archived
    // row at the bundled/system tier is a different row with a different path.
    const res = resolveLifecycleScope(
      [
        bundled(),
        marketplace({ status: "archived", ownerLevel: "platform", ownerId: null }),
        orgSibling(),
      ],
      platformAdminInOrg,
    );
    expect(res.ok && res.row.id).toBe("iext_org");
  });

  it("an ALREADY-ambiguous own scope keeps the GENERIC refusal", () => {
    // Two organization rows already refuse. The arm speaks about a candidate the
    // gate HID, so it never re-labels an ambiguity that was visible all along.
    const res = resolveLifecycleScope(
      [
        bundled(),
        marketplace({ status: "archived" }),
        orgSibling(),
        orgSibling({ id: "iext_org2" }),
      ],
      platformAdminInOrg,
    );
    expect(!res.ok && res.code).toBe("ambiguous_target");
    expect(!res.ok && res.code === "ambiguous_target" && res.reason).toBeUndefined();
    expect(!res.ok && res.code === "ambiguous_target" && res.count).toBe(2);
  });

  it("the org-NULL ambiguities keep their generic copy, reason-free", () => {
    const rows = [
      marketplace({ ownerLevel: "platform", ownerId: null }),
      marketplace({ id: "iext_other" }),
    ];
    const res = resolveLifecycleScope(rows, platformAdminNullOrg);
    expect(!res.ok && res.code).toBe("ambiguous_target");
    expect(!res.ok && res.code === "ambiguous_target" && res.reason).toBeUndefined();
    const caps = evaluateLifecycleCapabilities(rows, platformAdminNullOrg);
    expect(caps.archive.reason).toContain("contact an administrator");
  });

  it("no rows at all is still no_addressable_row", () => {
    const res = resolveLifecycleScope([], platformAdminInOrg);
    expect(!res.ok && res.code).toBe("no_addressable_row");
  });

  it("force_delete keeps its role-derived verdict — it never reads the scope", () => {
    const caps = evaluateLifecycleCapabilities(stranded(), platformAdminInOrg);
    expect(caps.force_delete.allowed).toBe(true);
  });
});
