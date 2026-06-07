// Lifecycle-UI dev-version rendering tests.
//
// sourceVersion() (exercised via lifecycleBadgesFor) renders "dev / <short-sha>"
// for (a) a local source and (b) a dev verdaccio version (`0.0.0-dev.<sha>`),
// while a normal verdaccio version stays "v<x.y.z>" (byte-identical to before).
import { describe, expect, it } from "vitest";

import type { ExtensionSource, InstalledExtension } from "../canonical-types";
import { lifecycleBadgesFor } from "../lifecycle-ui";

function ext(
  over: Partial<InstalledExtension> & { source?: ExtensionSource } = {},
): InstalledExtension {
  return {
    id: "id",
    packageName: "@cinatra-ai/foo-agent",
    ownerLevel: "platform",
    ownerId: null,
    organizationId: null,
    kind: "agent",
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

function versionLabel(installed: InstalledExtension): string | undefined {
  return lifecycleBadgesFor(installed).find((b) => b.key === "version")?.label;
}

describe("sourceVersion dev rendering", () => {
  it("local source renders 'dev / <short-sha>' (7 chars)", () => {
    const label = versionLabel(
      ext({
        source: {
          type: "local",
          path: "/repo/extensions/cinatra-ai/foo-agent",
          resolvedCommitOrTreeHash: "abcdef0123456789",
        },
      }),
    );
    expect(label).toBe("dev / abcdef0");
  });

  it("dev verdaccio version renders 'dev / <short-sha>' (prefix stripped, 7 chars)", () => {
    const label = versionLabel(
      ext({
        source: {
          type: "verdaccio",
          registryUrl: "x",
          packageName: "@cinatra-ai/foo-agent",
          version: "0.0.0-dev.abcdef0123456789",
          integrity: "sha",
        },
      }),
    );
    expect(label).toBe("dev / abcdef0");
  });

  it("normal verdaccio version stays 'v<x.y.z>' (unchanged)", () => {
    const label = versionLabel(
      ext({
        source: {
          type: "verdaccio",
          registryUrl: "x",
          packageName: "@cinatra-ai/foo-agent",
          version: "1.2.3",
          integrity: "sha",
        },
      }),
    );
    expect(label).toBe("v1.2.3");
  });
});
