// Pure model logic for the per-extension Settings page (design §V). Node-env,
// no DB — mirrors the lifecycle-ui unit-test pattern (a plain InstalledExtension
// factory feeds disabledActionReason through resolveSettingsAffordances).
import { describe, expect, it } from "vitest";

import type { ExtensionSource, InstalledExtension } from "../../canonical-types";
import {
  ACCESS_POLICY_KINDS,
  VALID_SETTINGS_KINDS,
  canPublishToMarketplace,
  isRegisteredMarketplaceVendor,
  resolveSettingsAffordances,
  resolveUpdateRow,
  settingsHrefFor,
} from "../extension-settings-model";
import type {
  LifecycleCapability,
  LifecycleCapabilityMap,
  LifecycleCapabilityOp,
} from "../../lifecycle-target-resolver";

function ext(
  over: Partial<InstalledExtension> & { source?: ExtensionSource } = {},
): InstalledExtension {
  return {
    id: "id",
    packageName: "@cinatra-ai/foo-agent",
    ownerLevel: "platform",
    ownerId: null,
    organizationId: null,
    kind: "connector",
    status: "active",
    source: {
      type: "verdaccio",
      registryUrl: "x",
      packageName: "@cinatra-ai/foo-agent",
      version: "1.2.3",
      integrity: "sha",
    },
    requiredInProd: false,
    dependencies: [],
    manifestHash: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

describe("settingsHrefFor (§V — the card's Settings action target)", () => {
  it("routes to the per-extension settings page under the extension kind", () => {
    expect(settingsHrefFor("connector", "@acme/crm-sync")).toBe(
      "/configuration/extensions/settings/connector/@acme/crm-sync",
    );
  });
  it("keeps a scoped package name's slash as path segments (no %2F single-segment encoding)", () => {
    const href = settingsHrefFor("agent", "@cinatra-ai/research-assistant");
    expect(href).not.toContain("%2F");
    expect(href).toContain("/@cinatra-ai/research-assistant");
  });
  it("handles an unscoped package name", () => {
    expect(settingsHrefFor("skill", "my-skill")).toBe(
      "/configuration/extensions/settings/skill/my-skill",
    );
  });
});

describe("resolveUpdateRow (§V — Maintenance · Update: the §III card states spelled out in words)", () => {
  it("update-available: names the current and available versions; the button is live", () => {
    expect(
      resolveUpdateRow({
        state: "update-available",
        installedVersion: "0.4.2",
        latestVersion: "0.5.0",
      }),
    ).toEqual({
      enabled: true,
      description: "Currently on version 0.4.2 — version 0.5.0 is available.",
    });
  });
  it('incompatible: the verbatim "Newer version needs a newer Cinatra." wording; the button greys out', () => {
    const row = resolveUpdateRow({
      state: "incompatible",
      installedVersion: "0.4.2",
      latestVersion: "0.5.0",
    });
    expect(row.description).toBe("Newer version needs a newer Cinatra.");
    expect(row.enabled).toBe(false);
  });
  it('non-comparable (github/dev/local sources): the verbatim "No registry version to compare." wording; the button greys out', () => {
    for (const installedVersion of [null, "0.0.0-dev.20260701"]) {
      const row = resolveUpdateRow({
        state: "non-comparable",
        installedVersion,
        latestVersion: null,
      });
      expect(row.description).toBe("No registry version to compare.");
      expect(row.enabled).toBe(false);
    }
  });
  it("up-to-date: the up-to-date line; the button greys out (nothing to run)", () => {
    const row = resolveUpdateRow({
      state: "up-to-date",
      installedVersion: "1.2.0",
      latestVersion: "1.2.0",
    });
    expect(row.description).toBe("Currently on version 1.2.0 — up to date.");
    expect(row.enabled).toBe(false);
  });
  it("none (fail-quiet stale readout): falls back to the up-to-date line with the button greyed — never a stale claim of an update", () => {
    const row = resolveUpdateRow({
      state: "none",
      installedVersion: "1.2.0",
      latestVersion: null,
    });
    expect(row.description).toBe("Currently on version 1.2.0 — up to date.");
    expect(row.enabled).toBe(false);
  });
});

describe("isRegisteredMarketplaceVendor (§V — Marketplace gating)", () => {
  it("is true for an approved / active / registered vendor state", () => {
    for (const s of ["approved", "active", "registered", "Approved"]) {
      expect(isRegisteredMarketplaceVendor(s)).toBe(true);
    }
  });
  it("is false for a not-yet-approved / absent state", () => {
    for (const s of ["none", "rejected", "pending", null, undefined, ""]) {
      expect(isRegisteredMarketplaceVendor(s)).toBe(false);
    }
  });
});

describe("canPublishToMarketplace (§V — one-way Publish)", () => {
  const base = {
    isPublic: false,
    isRegisteredVendor: true,
    kind: "agent" as const,
    versionKnown: true,
  };
  it("is live for a private agent, registered vendor, known version", () => {
    expect(canPublishToMarketplace(base)).toBe(true);
  });
  it("is not live once already public (cannot demote)", () => {
    expect(canPublishToMarketplace({ ...base, isPublic: true })).toBe(false);
  });
  it("is not live when the instance is not a registered vendor", () => {
    expect(canPublishToMarketplace({ ...base, isRegisteredVendor: false })).toBe(false);
  });
  it("is not live for non-agent kinds (the promote path is agent-only today)", () => {
    expect(canPublishToMarketplace({ ...base, kind: "connector" })).toBe(false);
  });
});

// cinatra#2416: every affordance now folds in a SERVER-DERIVED capability
// verdict. `ALLOW_ALL` is the "this session can address and act on the row"
// verdict — with it, every pre-#2416 expectation below must hold UNCHANGED.
const cap = (
  op: LifecycleCapabilityOp,
  denial?: { code: "no_addressable_row" | "platform_admin_required"; reason: string },
): LifecycleCapability =>
  denial
    ? { op, allowed: false, code: denial.code, reason: denial.reason }
    : { op, allowed: true, code: "ok", reason: null };

const ALLOW_ALL: LifecycleCapabilityMap = {
  archive: cap("archive"),
  activate: cap("activate"),
  uninstall: cap("uninstall"),
  force_delete: cap("force_delete"),
};

const SCOPE_REASON =
  "Installed for the whole platform. Only a platform administrator with no active organization can act on it.";

/** The exact verdict #2416 reports: a platform-anchored row, org-active session. */
const PLATFORM_ROW_FROM_ORG_SESSION: LifecycleCapabilityMap = {
  archive: cap("archive", { code: "no_addressable_row", reason: SCOPE_REASON }),
  activate: cap("activate", { code: "no_addressable_row", reason: SCOPE_REASON }),
  uninstall: cap("uninstall", { code: "no_addressable_row", reason: SCOPE_REASON }),
  // force_delete takes no row resolver — platform standing is its only gate.
  force_delete: cap("force_delete"),
};

/** The second refused session shape: a platform-scoped session (no active
 *  org) that still lacks platform-admin standing over the SAME platform row.
 *  Denied through `no_write_standing` rather than `no_addressable_row`, but
 *  the reason text must read IDENTICALLY — the settings page must never
 *  suggest that clearing the active org alone would let this session act. */
const PLATFORM_ROW_NO_STANDING_SESSION: LifecycleCapabilityMap = {
  archive: cap("archive", { code: "no_write_standing", reason: SCOPE_REASON }),
  activate: cap("activate", { code: "no_write_standing", reason: SCOPE_REASON }),
  uninstall: cap("uninstall", { code: "no_write_standing", reason: SCOPE_REASON }),
  force_delete: cap("force_delete", {
    code: "platform_admin_required",
    reason: "Requires platform admin.",
  }),
};

describe("resolveSettingsAffordances (§V — locked/system + complementary Archive/Activate)", () => {
  it("active install: Archive live, Activate greyed (exactly one live)", () => {
    const a = resolveSettingsAffordances({
      canonical: ext({ status: "active" }),
      lockedRow: null,
      isArchived: false,
      versionKnown: true,
      capabilities: ALLOW_ALL,
    });
    expect(a.archiveDisabled).toBeNull();
    expect(a.activateDisabled).toBe("Already active");
    expect(a.reinstallDisabled).toBeNull();
    expect(a.forceDeleteDisabled).toBeNull();
    expect(a.capabilityReasons).toEqual({});
  });

  it("archived install: Activate live, Archive greyed (the pair flips)", () => {
    const a = resolveSettingsAffordances({
      canonical: ext({ status: "archived" }),
      lockedRow: null,
      isArchived: true,
      versionKnown: true,
      capabilities: ALLOW_ALL,
    });
    expect(a.archiveDisabled).toBe("Already archived");
    expect(a.activateDisabled).toBeNull();
  });

  it("locked / system: Archive + Force-delete + Reinstall disabled-in-place", () => {
    const a = resolveSettingsAffordances({
      canonical: ext({ status: "locked", requiredInProd: true }),
      lockedRow: ext({ status: "locked", requiredInProd: true }),
      isArchived: false,
      versionKnown: true,
      capabilities: ALLOW_ALL,
    });
    expect(a.archiveDisabled).toBeTruthy();
    expect(a.forceDeleteDisabled).toBeTruthy();
    expect(a.reinstallDisabled).toBeTruthy();
  });

  it("no canonical row + unknown version: version-requiring actions disabled; the pair still resolves", () => {
    const a = resolveSettingsAffordances({
      canonical: null,
      lockedRow: null,
      isArchived: false,
      versionKnown: false,
      capabilities: ALLOW_ALL,
    });
    expect(a.archiveDisabled).toBe("Installed version unknown");
    expect(a.forceDeleteDisabled).toBe("Installed version unknown");
    expect(a.activateDisabled).toBe("Already active");
    expect(a.reinstallDisabled).toBeNull();
  });
});

describe("resolveSettingsAffordances — the server capability (cinatra#2416)", () => {
  it("a platform-anchored row + org-active session: the three row-scoped actions carry the SCOPE reason, Force-delete stays live", () => {
    const a = resolveSettingsAffordances({
      canonical: ext({ status: "active" }),
      lockedRow: null,
      isArchived: false,
      versionKnown: true,
      capabilities: PLATFORM_ROW_FROM_ORG_SESSION,
    });
    expect(a.archiveDisabled).toBe(SCOPE_REASON);
    expect(a.activateDisabled).toBe(SCOPE_REASON);
    expect(a.reinstallDisabled).toBe(SCOPE_REASON);
    expect(a.forceDeleteDisabled).toBeNull();
    // …and all three are flagged as CAPABILITY denials, so the view renders the
    // reason visibly rather than only as a tooltip.
    expect(a.capabilityReasons).toEqual({
      archive: SCOPE_REASON,
      activate: SCOPE_REASON,
      reinstall: SCOPE_REASON,
    });
  });

  it("a platform-anchored row + a platform-scoped, non-admin session reads the SAME reason as the org-active session", () => {
    const a = resolveSettingsAffordances({
      canonical: ext({ status: "active" }),
      lockedRow: null,
      isArchived: false,
      versionKnown: true,
      capabilities: PLATFORM_ROW_NO_STANDING_SESSION,
    });
    expect(a.archiveDisabled).toBe(SCOPE_REASON);
    expect(a.activateDisabled).toBe(SCOPE_REASON);
    expect(a.reinstallDisabled).toBe(SCOPE_REASON);
    // This session also lacks platform-admin standing, so unlike the
    // org-active session (which stays live on Force-delete), Force-delete is
    // ALSO denied here — correctly, on its own platform-admin-only gate.
    expect(a.forceDeleteDisabled).toBe("Requires platform admin.");
    expect(a.capabilityReasons).toEqual({
      archive: SCOPE_REASON,
      activate: SCOPE_REASON,
      reinstall: SCOPE_REASON,
      forceDelete: "Requires platform admin.",
    });
  });

  it("the capability OUTRANKS the status reason — an unaddressable row never reads 'Already active'", () => {
    const a = resolveSettingsAffordances({
      canonical: ext({ status: "active" }),
      lockedRow: null,
      isArchived: false,
      versionKnown: true,
      capabilities: PLATFORM_ROW_FROM_ORG_SESSION,
    });
    expect(a.activateDisabled).not.toBe("Already active");
  });

  it("the #1036 locked/system invariant still OUTRANKS the capability (the stronger rule wins)", () => {
    const a = resolveSettingsAffordances({
      canonical: ext({ status: "locked", requiredInProd: true }),
      lockedRow: ext({ status: "locked", requiredInProd: true }),
      isArchived: false,
      versionKnown: true,
      capabilities: PLATFORM_ROW_FROM_ORG_SESSION,
    });
    expect(a.archiveDisabled).toContain("locked");
    expect(a.archiveDisabled).not.toBe(SCOPE_REASON);
    // …and a locked-claimed affordance is NOT reported as a capability denial.
    expect(a.capabilityReasons.archive).toBeUndefined();
  });

  it("the capability-denial flag is keyed STRUCTURALLY, not by comparing the copy", () => {
    // Pathological but decisive: the invariant copy and the capability copy are
    // the SAME string. The invariant won, so the affordance must NOT be flagged
    // as a capability denial (a string comparison would mis-attribute it and
    // render a spurious visible line).
    const collidingCopy = "Cannot archive — locked; update is permitted.";
    const a = resolveSettingsAffordances({
      canonical: ext({ status: "active" }),
      lockedRow: ext({ status: "locked", requiredInProd: false }),
      isArchived: false,
      versionKnown: true,
      capabilities: {
        ...ALLOW_ALL,
        archive: {
          op: "archive",
          allowed: false,
          code: "no_addressable_row",
          reason: collidingCopy,
        },
      },
    });
    expect(a.archiveDisabled).toBe(collidingCopy);
    expect(a.capabilityReasons.archive).toBeUndefined();
  });

  it("an ORG admin's Force-delete carries the platform-admin standing copy", () => {
    const a = resolveSettingsAffordances({
      canonical: ext({ status: "active" }),
      lockedRow: null,
      isArchived: false,
      versionKnown: true,
      capabilities: {
        ...ALLOW_ALL,
        force_delete: cap("force_delete", {
          code: "platform_admin_required",
          reason: "Requires platform admin.",
        }),
      },
    });
    expect(a.forceDeleteDisabled).toBe("Requires platform admin.");
    expect(a.capabilityReasons.forceDelete).toBe("Requires platform admin.");
  });

  it("a LOCKED SIBLING in another scope disables the affordances even when the TARGET row is addressable and active", () => {
    // codex-found regression pin. `assertNoLockedCanonicalRow` is PACKAGE-WIDE:
    // a locked platform row refuses archive / uninstall / force_delete for every
    // scope. Describing the lock from the resolved TARGET row alone would render
    // those live and have the dispatcher refuse — the exact defect #2416 fixes.
    const a = resolveSettingsAffordances({
      // the actor's own org row: active, addressable, standing held
      canonical: ext({ status: "active", organizationId: "org-x", ownerLevel: "organization" }),
      // …but a platform sibling is LOCKED
      lockedRow: ext({ id: "iext-platform", status: "locked", requiredInProd: true }),
      isArchived: false,
      versionKnown: true,
      capabilities: ALLOW_ALL,
    });
    expect(a.archiveDisabled).toContain("locked");
    expect(a.reinstallDisabled).toContain("locked");
    expect(a.forceDeleteDisabled).toContain("locked");
    // Activate is not a destructive op, so the lock does not claim it.
    expect(a.activateDisabled).toBe("Already active");
    // None of these are capability denials — no visible scope line.
    expect(a.capabilityReasons).toEqual({});
  });

  it("a version-unknown row that is ALSO unaddressable reports the SCOPE reason (the more fundamental fact)", () => {
    const a = resolveSettingsAffordances({
      canonical: null,
      lockedRow: null,
      isArchived: false,
      versionKnown: false,
      capabilities: PLATFORM_ROW_FROM_ORG_SESSION,
    });
    expect(a.archiveDisabled).toBe(SCOPE_REASON);
  });
});

describe("kind sets", () => {
  it("access-policy kinds are exactly the canonical-row-identity kinds (workflow removed — cinatra#1035)", () => {
    expect([...ACCESS_POLICY_KINDS]).toEqual(["connector", "artifact"]);
    expect(ACCESS_POLICY_KINDS).not.toContain("workflow");
  });
  it("valid settings kinds cover the four extension kinds (workflow removed — cinatra#1035)", () => {
    expect([...VALID_SETTINGS_KINDS]).toEqual([
      "agent",
      "skill",
      "connector",
      "artifact",
    ]);
    expect(VALID_SETTINGS_KINDS).not.toContain("workflow");
  });
});
