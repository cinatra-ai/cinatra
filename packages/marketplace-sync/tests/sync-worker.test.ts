import { describe, expect, it, vi } from "vitest";
import {
  createMockMarketplaceMcpClient,
  type MarketplacePackageSyncFromRegistryInput,
} from "@cinatra-ai/marketplace-mcp-client";
import { runMarketplaceSync, mapPackageMetadata, checkScopeOwnership } from "../src";

describe("mapPackageMetadata", () => {
  it("maps a fully-populated package.json", () => {
    const result = mapPackageMetadata({
      packageJson: {
        name: "@acme/email-outreach-agent",
        version: "1.2.0",
        description: "Send personalised outreach.",
        license: "MIT",
        cinatra: {
          kind: "agent",
          marketplace: {
            longDescription: "Long form.",
            assets: [{ path: "screenshots/hero.png", role: "hero" }],
          },
        },
      },
      readme: "# README\n\nContent.",
    });
    expect(result.metadata.packageName).toBe("@acme/email-outreach-agent");
    expect(result.metadata.kind).toBe("agent");
    expect(result.metadata.license).toBe("MIT");
    expect(result.metadata.marketplaceAssets).toEqual([{ path: "screenshots/hero.png", role: "hero" }]);
    expect(result.metadata.readmeMarkdown).toContain("README");
    expect(result.warnings).toEqual([]);
  });

  it("fails closed (throws) when cinatra.kind is missing — never defaults to 'agent'", () => {
    expect(() =>
      mapPackageMetadata({
        packageJson: { name: "@acme/widget", version: "0.1.0" },
        readme: null,
      }),
    ).toThrow(/no cinatra\.kind declared/);
  });

  it("does NOT infer kind from keywords — a matching keyword without cinatra.kind still throws", () => {
    expect(() =>
      mapPackageMetadata({
        packageJson: {
          name: "@acme/widget",
          version: "0.1.0",
          // A canonical-looking keyword is deliberately ignored: keyword
          // inference was removed, so this must still fail closed.
          keywords: ["other", "skill"],
        } as never,
        readme: null,
      }),
    ).toThrow(/no cinatra\.kind declared/);
  });

  it("fails closed (throws) when cinatra.kind is an invalid value", () => {
    expect(() =>
      mapPackageMetadata({
        packageJson: {
          name: "@acme/widget",
          version: "0.1.0",
          cinatra: { kind: "plugin" as never },
        },
        readme: null,
      }),
    ).toThrow(/invalid cinatra\.kind "plugin"/);
  });

  it("rejects marketplace assets with absolute or URL paths", () => {
    const result = mapPackageMetadata({
      packageJson: {
        name: "@acme/widget",
        version: "0.1.0",
        cinatra: {
          kind: "skill",
          marketplace: {
            assets: [
              { path: "good/icon.png", role: "icon" },
              { path: "/bad/abs.png", role: "icon" },
              { path: "https://evil/img.png", role: "icon" },
            ],
          },
        },
      },
      readme: null,
    });
    expect(result.metadata.marketplaceAssets).toEqual([{ path: "good/icon.png", role: "icon" }]);
    expect(result.warnings.join(" ")).toContain("path must be relative");
  });

  it("caps marketplace assets at 20 entries", () => {
    const assets = Array.from({ length: 30 }, (_, i) => ({
      path: `asset-${i}.png`,
      role: "screenshot" as const,
    }));
    const result = mapPackageMetadata({
      packageJson: {
        name: "@acme/many-assets",
        version: "0.1.0",
        cinatra: { kind: "skill", marketplace: { assets } },
      },
      readme: null,
    });
    expect(result.metadata.marketplaceAssets).toHaveLength(20);
    expect(result.warnings.some((w) => w.includes("20-entry cap"))).toBe(true);
  });
});

describe("checkScopeOwnership", () => {
  it("returns ok when the scope is approved", async () => {
    const result = await checkScopeOwnership({
      packageName: "@acme/widget",
      isScopeApproved: async (scope) => scope === "@acme",
    });
    expect(result.ok).toBe(true);
    expect(result.rejectionReason).toBeNull();
  });

  it("rejects when the scope is not approved", async () => {
    const result = await checkScopeOwnership({
      packageName: "@evil/widget",
      isScopeApproved: async () => false,
    });
    expect(result.ok).toBe(false);
    expect(result.rejectionReason).toContain('"@evil"');
  });

  it("rejects malformed package names (no scope)", async () => {
    const result = await checkScopeOwnership({
      packageName: "no-scope-here",
      isScopeApproved: async () => true,
    });
    expect(result.ok).toBe(false);
    expect(result.rejectionReason).toContain("scoped npm package");
  });
});

describe("runMarketplaceSync", () => {
  it("syncs every package whose scope is approved + reports per-package results", async () => {
    const syncCalls: MarketplacePackageSyncFromRegistryInput[] = [];
    const client = createMockMarketplaceMcpClient({
      onSync: (input) => syncCalls.push(input),
    });
    const summary = await runMarketplaceSync({
      client,
      verdaccioPackageNames: async () => ["@acme/a", "@acme/b", "@evil/c"],
      getPackageSource: async (name) => ({
        packageJson: { name, version: "0.1.0", cinatra: { kind: "skill" } },
        readme: null,
        versions: [{ version: "0.1.0", releasedAt: "2026-05-01T00:00:00Z" }],
      }),
      isScopeApproved: async (scope) => scope === "@acme",
    });
    expect(summary.totalPackages).toBe(3);
    expect(summary.syncedCount).toBe(2);
    expect(summary.scopeRejectedCount).toBe(1);
    expect(summary.fetchFailedCount).toBe(0);
    expect(summary.mapFailedCount).toBe(0);
    expect(summary.syncFailedCount).toBe(0);
    expect(syncCalls).toHaveLength(2);
    expect(syncCalls.map((c) => c.metadata.packageName).sort()).toEqual(["@acme/a", "@acme/b"]);
    expect(syncCalls.every((c) => c.idempotencyKey.endsWith("@0.1.0"))).toBe(true);
  });

  it("records fetch failures without aborting the run", async () => {
    const client = createMockMarketplaceMcpClient();
    const summary = await runMarketplaceSync({
      client,
      verdaccioPackageNames: async () => ["@acme/ok", "@acme/broken"],
      getPackageSource: async (name) => {
        if (name === "@acme/broken") throw new Error("tarball corrupt");
        return {
          packageJson: { name, version: "0.1.0", cinatra: { kind: "skill" } },
          readme: null,
          versions: [{ version: "0.1.0", releasedAt: "2026-05-01T00:00:00Z" }],
        };
      },
      isScopeApproved: async () => true,
    });
    expect(summary.syncedCount).toBe(1);
    expect(summary.fetchFailedCount).toBe(1);
    const broken = summary.perPackage.find((p) => p.packageName === "@acme/broken")!;
    expect(broken.status).toBe("fetch-failed");
    expect(broken.rejectionReason).toContain("tarball corrupt");
  });

  it("records sync POST failures without aborting the run", async () => {
    const failingClient = createMockMarketplaceMcpClient();
    failingClient.packageSyncFromRegistry = vi.fn(async () => {
      throw new Error("marketplace 500");
    });
    const summary = await runMarketplaceSync({
      client: failingClient,
      verdaccioPackageNames: async () => ["@acme/x"],
      getPackageSource: async (name) => ({
        packageJson: { name, version: "1.0.0", cinatra: { kind: "agent" } },
        readme: null,
        versions: [{ version: "1.0.0", releasedAt: "2026-05-01T00:00:00Z" }],
      }),
      isScopeApproved: async () => true,
    });
    expect(summary.syncFailedCount).toBe(1);
    expect(summary.perPackage[0].status).toBe("sync-failed");
    expect(summary.perPackage[0].rejectionReason).toContain("marketplace 500");
  });

  it("records map failures (undeclared kind) without aborting the run", async () => {
    const client = createMockMarketplaceMcpClient();
    const summary = await runMarketplaceSync({
      client,
      verdaccioPackageNames: async () => ["@acme/ok", "@acme/nokind"],
      getPackageSource: async (name) => ({
        packageJson:
          name === "@acme/nokind"
            ? { name, version: "0.1.0" }
            : { name, version: "0.1.0", cinatra: { kind: "skill" } },
        readme: null,
        versions: [{ version: "0.1.0", releasedAt: "2026-05-01T00:00:00Z" }],
      }),
      isScopeApproved: async () => true,
    });
    expect(summary.syncedCount).toBe(1);
    expect(summary.mapFailedCount).toBe(1);
    const failed = summary.perPackage.find((p) => p.packageName === "@acme/nokind")!;
    expect(failed.status).toBe("map-failed");
    expect(failed.rejectionReason).toContain("no cinatra.kind declared");
  });
});
