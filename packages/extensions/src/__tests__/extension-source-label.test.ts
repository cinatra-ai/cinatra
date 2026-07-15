import { describe, expect, it } from "vitest";

import type {
  ExtensionSource,
  InstalledExtension,
} from "../canonical-types";
import {
  classifyExtensionSource,
  normalizeRegistryUrl,
  resolveConfiguredRegistryIdentities,
  type ConfiguredRegistryIdentities,
} from "../screens/extension-source-label";

// The classifier reads ONLY `canonical.source`; every other field is filled
// with an inert value so the fixture is a structurally-valid InstalledExtension.
function row(source: ExtensionSource): InstalledExtension {
  return {
    id: "row-id",
    packageName: "@acme/thing",
    ownerLevel: "platform",
    ownerId: null,
    organizationId: null,
    kind: "agent",
    status: "active",
    source,
    requiredInProd: false,
    dependencies: [],
    manifestHash: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function verdaccio(registryUrl: string): ExtensionSource {
  return {
    type: "verdaccio",
    registryUrl,
    packageName: "@acme/thing",
    version: "1.0.0",
    integrity: "sha512-x",
  };
}

const MARKETPLACE_URL = "https://marketplace.example";
const INSTANCE_URL = "http://127.0.0.1:4873";
const IDENTITIES: ConfiguredRegistryIdentities = {
  marketplaceUrl: MARKETPLACE_URL,
  instanceUrl: INSTANCE_URL,
};

describe("classifyExtensionSource — per source class", () => {
  it("null canonical → unknown (never a wrong claim)", () => {
    expect(classifyExtensionSource(null, IDENTITIES).kind).toBe("unknown");
  });

  it("verdaccio matching the configured marketplace identity → marketplace", () => {
    expect(classifyExtensionSource(row(verdaccio(MARKETPLACE_URL)), IDENTITIES).kind).toBe(
      "marketplace",
    );
  });

  it("verdaccio matching the configured instance (local) identity → instance", () => {
    expect(classifyExtensionSource(row(verdaccio(INSTANCE_URL)), IDENTITIES).kind).toBe(
      "instance",
    );
  });

  it("github → github (neither marketplace nor instance)", () => {
    const source: ExtensionSource = {
      type: "github",
      repo: "acme/thing",
      ref: "v1",
      resolvedSha: "abc",
    };
    expect(classifyExtensionSource(row(source), IDENTITIES).kind).toBe("github");
  });

  it("local (in-tree dev build) → local-build, and NEVER the instance label", () => {
    const source: ExtensionSource = {
      type: "local",
      path: "/repo/pkg",
      resolvedCommitOrTreeHash: "deadbeef",
    };
    const label = classifyExtensionSource(row(source), IDENTITIES);
    expect(label.kind).toBe("local-build");
    // Naming-collision guard: `local` the source type must stay visibly distinct
    // from `instance` the local REGISTRY.
    expect(label.kind).not.toBe("instance");
    const instanceLabel = classifyExtensionSource(row(verdaccio(INSTANCE_URL)), IDENTITIES);
    expect(label.label).not.toBe(instanceLabel.label);
  });

  it("bundled → bundled (first-party, shipped with the product)", () => {
    const source: ExtensionSource = {
      type: "bundled",
      packageName: "@cinatra-ai/thing",
      version: "1.0.0",
    };
    expect(classifyExtensionSource(row(source), IDENTITIES).kind).toBe("bundled");
  });
});

describe("classifyExtensionSource — the crux (two verdaccio rows, distinguished by registry identity)", () => {
  it("one marketplace-identity URL and one instance-identity URL classify differently", () => {
    const marketplaceRow = row(verdaccio(MARKETPLACE_URL));
    const instanceRow = row(verdaccio(INSTANCE_URL));
    const a = classifyExtensionSource(marketplaceRow, IDENTITIES);
    const b = classifyExtensionSource(instanceRow, IDENTITIES);
    expect(a.kind).toBe("marketplace");
    expect(b.kind).toBe("instance");
    expect(a.kind).not.toBe(b.kind);
  });
});

describe("classifyExtensionSource — first-class unknown (AC3)", () => {
  it("verdaccio matching NEITHER configured identity → unknown", () => {
    expect(
      classifyExtensionSource(row(verdaccio("https://some-other-registry.example")), IDENTITIES)
        .kind,
    ).toBe("unknown");
  });

  it("malformed (unparseable) registryUrl → unknown", () => {
    expect(classifyExtensionSource(row(verdaccio("not a url")), IDENTITIES).kind).toBe("unknown");
  });

  it("empty registryUrl → unknown", () => {
    expect(classifyExtensionSource(row(verdaccio("")), IDENTITIES).kind).toBe("unknown");
  });

  it("non-http(s) scheme registryUrl → unknown", () => {
    expect(classifyExtensionSource(row(verdaccio("ftp://marketplace.example")), IDENTITIES).kind).toBe(
      "unknown",
    );
  });

  it("a marketplace-looking URL is still unknown when NO marketplace identity is configured", () => {
    const noMarketplace: ConfiguredRegistryIdentities = {
      marketplaceUrl: null,
      instanceUrl: INSTANCE_URL,
    };
    expect(
      classifyExtensionSource(row(verdaccio("https://looks-like-a-store.example")), noMarketplace)
        .kind,
    ).toBe("unknown");
  });

  it("an unconfigured instance slot never yields a wrong 'from your instance' claim", () => {
    const noInstance: ConfiguredRegistryIdentities = {
      marketplaceUrl: MARKETPLACE_URL,
      instanceUrl: null,
    };
    expect(classifyExtensionSource(row(verdaccio("http://127.0.0.1:4873")), noInstance).kind).toBe(
      "unknown",
    );
  });
});

describe("classifyExtensionSource — URL normalization equivalences (AC6)", () => {
  const cases: Array<[string, string]> = [
    ["trailing slash", "https://marketplace.example/"],
    ["scheme upper-case", "HTTPS://marketplace.example"],
    ["host upper-case", "https://Marketplace.Example"],
    ["explicit default port", "https://marketplace.example:443"],
    ["trailing slash + default port", "https://marketplace.example:443/"],
    ["stray query string", "https://marketplace.example/?foo=bar"],
  ];
  for (const [name, url] of cases) {
    it(`marketplace identity matches despite: ${name}`, () => {
      expect(classifyExtensionSource(row(verdaccio(url)), IDENTITIES).kind).toBe("marketplace");
    });
  }

  it("http and https are NOT the same identity", () => {
    expect(
      classifyExtensionSource(row(verdaccio("http://marketplace.example")), IDENTITIES).kind,
    ).toBe("unknown");
  });

  it("a registry with a base path normalizes the trailing slash but keeps the path", () => {
    const identities: ConfiguredRegistryIdentities = {
      marketplaceUrl: "https://host.example/npm/",
      instanceUrl: null,
    };
    expect(classifyExtensionSource(row(verdaccio("https://host.example/npm")), identities).kind).toBe(
      "marketplace",
    );
    expect(classifyExtensionSource(row(verdaccio("https://host.example/other")), identities).kind).toBe(
      "unknown",
    );
  });
});

describe("normalizeRegistryUrl", () => {
  it("folds trailing slash, scheme case, host case, and default port to one key", () => {
    const a = normalizeRegistryUrl("HTTPS://Marketplace.Example:443/");
    const b = normalizeRegistryUrl("https://marketplace.example");
    expect(a).toBe(b);
    expect(a).toBe("https://marketplace.example");
  });

  it("returns null for null/empty/non-url/non-http inputs", () => {
    expect(normalizeRegistryUrl(null)).toBeNull();
    expect(normalizeRegistryUrl(undefined)).toBeNull();
    expect(normalizeRegistryUrl("")).toBeNull();
    expect(normalizeRegistryUrl("   ")).toBeNull();
    expect(normalizeRegistryUrl("not a url")).toBeNull();
    expect(normalizeRegistryUrl("ftp://host")).toBeNull();
  });
});

describe("resolveConfiguredRegistryIdentities", () => {
  it("the remote slot is the marketplace identity; the local slot is the instance identity", () => {
    const r = resolveConfiguredRegistryIdentities({
      remoteUrl: "https://remote.example",
      localUrl: "http://127.0.0.1:4873",
    });
    expect(r.marketplaceUrl).toBe("https://remote.example");
    expect(r.instanceUrl).toBe("http://127.0.0.1:4873");
  });

  it("marketplace identity is null when no remote slot is configured (no product-default host guess)", () => {
    expect(resolveConfiguredRegistryIdentities({}).marketplaceUrl).toBeNull();
    expect(resolveConfiguredRegistryIdentities({ remoteUrl: "  " }).marketplaceUrl).toBeNull();
  });

  it("the instance identity has NO product default — an unconfigured local slot is null", () => {
    expect(resolveConfiguredRegistryIdentities({}).instanceUrl).toBeNull();
    expect(resolveConfiguredRegistryIdentities({ localUrl: "  " }).instanceUrl).toBeNull();
  });

  it("the marketplace identity is NEVER the local slot — a legacy loopback stays an INSTANCE row, never marketplace (codex#1572)", () => {
    // deriveRegistriesShim routes a legacy loopback registry into
    // registries.local (and leaves the same URL in the top-level registryUrl).
    // The resolver only reads the remote + local slots, so with no remote slot
    // the marketplace identity is null — never the loopback.
    const identities = resolveConfiguredRegistryIdentities({
      remoteUrl: null,
      localUrl: "http://127.0.0.1:4873",
    });
    expect(identities.marketplaceUrl).toBeNull();
    expect(identities.instanceUrl).toBe("http://127.0.0.1:4873");
    // A verdaccio row from that loopback classifies as INSTANCE, not marketplace.
    expect(classifyExtensionSource(row(verdaccio("http://127.0.0.1:4873")), identities).kind).toBe(
      "instance",
    );
  });
});

describe("labels are informational, not trust-bearing (AC1a)", () => {
  const allKinds = ["marketplace", "instance", "github", "local-build", "bundled", "unknown"] as const;
  const forbidden = /\b(safe|verified|verify|approved|trusted|secure|official)\b/i;

  it("no label or tooltip implies safety / verification / approval", () => {
    const sources: Record<(typeof allKinds)[number], InstalledExtension | null> = {
      marketplace: row(verdaccio(MARKETPLACE_URL)),
      instance: row(verdaccio(INSTANCE_URL)),
      github: row({ type: "github", repo: "a/b", ref: "v1", resolvedSha: "s" }),
      "local-build": row({ type: "local", path: "/p", resolvedCommitOrTreeHash: "h" }),
      bundled: row({ type: "bundled", packageName: "@cinatra-ai/x", version: "1.0.0" }),
      unknown: null,
    };
    for (const kind of allKinds) {
      const label = classifyExtensionSource(sources[kind], IDENTITIES);
      expect(label.kind).toBe(kind);
      expect(label.label).not.toMatch(forbidden);
      expect(label.tooltip).not.toMatch(forbidden);
    }
  });

  it("the unknown label is a qualified neutral phrase, not a bare 'Unknown'", () => {
    const label = classifyExtensionSource(null, IDENTITIES);
    expect(label.label.toLowerCase()).not.toBe("unknown");
    expect(label.label.toLowerCase()).toContain("unknown");
  });
});

describe("fail-closed ambiguity guard (codex#1572)", () => {
  it("coinciding marketplace + instance identities resolve a matching row to unknown, NOT marketplace", () => {
    const identities: ConfiguredRegistryIdentities = {
      marketplaceUrl: "https://same.example/",
      instanceUrl: "https://SAME.example",
    };
    // The two configured identities normalize equal — a row matching that URL is
    // genuinely ambiguous, so it must fail closed to unknown rather than claim
    // either provenance.
    expect(classifyExtensionSource(row(verdaccio("https://same.example")), identities).kind).toBe(
      "unknown",
    );
  });
});
