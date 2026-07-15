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

describe("resolveSettingsAffordances (§V — locked/system + complementary Archive/Activate)", () => {
  it("active install: Archive live, Activate greyed (exactly one live)", () => {
    const a = resolveSettingsAffordances({
      canonical: ext({ status: "active" }),
      isArchived: false,
      versionKnown: true,
    });
    expect(a.archiveDisabled).toBeNull();
    expect(a.activateDisabled).toBe("Already active");
    expect(a.reinstallDisabled).toBeNull();
    expect(a.forceDeleteDisabled).toBeNull();
  });

  it("archived install: Activate live, Archive greyed (the pair flips)", () => {
    const a = resolveSettingsAffordances({
      canonical: ext({ status: "archived" }),
      isArchived: true,
      versionKnown: true,
    });
    expect(a.archiveDisabled).toBe("Already archived");
    expect(a.activateDisabled).toBeNull();
  });

  it("locked / system: Archive + Force-delete + Reinstall disabled-in-place", () => {
    const a = resolveSettingsAffordances({
      canonical: ext({ status: "locked", requiredInProd: true }),
      isArchived: false,
      versionKnown: true,
    });
    expect(a.archiveDisabled).toBeTruthy();
    expect(a.forceDeleteDisabled).toBeTruthy();
    expect(a.reinstallDisabled).toBeTruthy();
  });

  it("no canonical row + unknown version: version-requiring actions disabled; the pair still resolves", () => {
    const a = resolveSettingsAffordances({
      canonical: null,
      isArchived: false,
      versionKnown: false,
    });
    expect(a.archiveDisabled).toBe("Installed version unknown");
    expect(a.forceDeleteDisabled).toBe("Installed version unknown");
    expect(a.activateDisabled).toBe("Already active");
    expect(a.reinstallDisabled).toBeNull();
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
