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
  resolveUpdateAvailable,
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

describe("resolveUpdateAvailable (§V — Maintenance › Update gating)", () => {
  it("is available when the installed version is behind the newest", () => {
    expect(resolveUpdateAvailable("0.4.2", "0.5.0")).toBe(true);
  });
  it("is not available when already on the newest", () => {
    expect(resolveUpdateAvailable("1.2.0", "1.2.0")).toBe(false);
  });
  it("is not available when the installed version is newer", () => {
    expect(resolveUpdateAvailable("2.0.0", "1.0.0")).toBe(false);
  });
  it("is not available when either version is unknown", () => {
    expect(resolveUpdateAvailable(null, "1.0.0")).toBe(false);
    expect(resolveUpdateAvailable("1.0.0", null)).toBe(false);
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
  it("access-policy kinds are exactly the canonical-row-identity kinds", () => {
    expect([...ACCESS_POLICY_KINDS]).toEqual(["connector", "artifact", "workflow"]);
  });
  it("valid settings kinds cover all five extension kinds", () => {
    expect([...VALID_SETTINGS_KINDS]).toEqual([
      "agent",
      "skill",
      "connector",
      "artifact",
      "workflow",
    ]);
  });
});
