// cinatra #1057 / #1234 — the post-install resolver, narrowed to AGENT roots
// with REQUIRED connector dependencies. It must:
//   - short-circuit a non-agent root without probing,
//   - consider only DIRECT REQUIRED (non-peer) connector dependencies, each by
//     its OWN readiness probe (per-connector-authoritative; a facade's probe
//     reflects its whole chain — the resolver never descends into probe-less
//     base/oauth deps that would perpetually read not-connected),
//   - drop a required connector with no catalog descriptor (no setup surface),
//   - surface each connector's HUMAN-READABLE manifest displayName (the SAME
//     name the /connectors card grid renders), never the bare package name,
//     falling back to the slug only when a descriptor omits displayName.
// This pins the resolver boundary (`configuration-needs.server.ts`),
// complementing the pure-derivation and component-render tests.
//
// Both dependencies are mocked (the established pattern): the connector-catalog
// descriptor source and the readiness/setup-href registry. `server-only` is
// aliased to a stub by vitest.config, so importing the `.server` module works.
import { describe, expect, it, vi } from "vitest";

const DESCRIPTORS: Record<string, { packageId: string; slug: string; displayName: string }> = {
  "linkedin-connector": {
    packageId: "@cinatra-ai/linkedin-connector",
    slug: "linkedin-connector",
    displayName: "LinkedIn",
  },
  "linkedin-oauth-connector": {
    packageId: "@cinatra-ai/linkedin-oauth-connector",
    slug: "linkedin-oauth-connector",
    displayName: "LinkedIn OAuth",
  },
  "apollo-connector": {
    packageId: "@cinatra-ai/apollo-connector",
    slug: "apollo-connector",
    displayName: "Apollo",
  },
  // a (hypothetical) descriptor with an EMPTY displayName — exercises the slug
  // fallback so a name is ALWAYS rendered, never a blank primary label.
  "mystery-connector": {
    packageId: "@cinatra-ai/mystery-connector",
    slug: "mystery-connector",
    displayName: "",
  },
};

vi.mock("@cinatra-ai/connectors-catalog/descriptors.mjs", () => ({
  getConnectorDescriptorBySlug: (slug: string) => DESCRIPTORS[slug],
}));

// Hoisted so the spy is available both to the (hoisted) vi.mock factory and to
// the assertions below (`not.toHaveBeenCalled` for the non-agent short-circuit).
const { resolveConnectorBadgeState, connectedPackageIds } = vi.hoisted(() => {
  const connectedPackageIds = new Set<string>();
  return {
    connectedPackageIds,
    resolveConnectorBadgeState: vi.fn(async (packageId: string) => ({
      connected: connectedPackageIds.has(packageId),
    })),
  };
});
vi.mock("@/lib/connectors-registry.server", () => ({
  resolveConnectorBadgeState,
  getConnectorSetupHref: (slug: string) => `/connectors/cinatra-ai/${slug}/setup`,
}));

import {
  resolveAgentConfigurationNeeds,
  resolveConfigurationNeedsForAgents,
} from "@/lib/configuration-needs.server";
import type {
  ExtensionDependency,
  ExtensionKind,
} from "@cinatra-ai/extensions/canonical-types";

function dep(over: Partial<ExtensionDependency> & { packageName: string }): ExtensionDependency {
  return {
    edgeType: "runtime",
    requirement: "required",
    versionConstraint: { kind: "semver-range", range: "*" },
    kind: "connector",
    ...over,
  };
}

function agent(
  packageName: string,
  dependencies: ExtensionDependency[],
): { kind: ExtensionKind; packageName: string; dependencies: ExtensionDependency[] } {
  return { kind: "agent", packageName, dependencies };
}

describe("resolveAgentConfigurationNeeds — human-readable connector name", () => {
  it("uses the manifest displayName as the connector's name, not the package id", async () => {
    connectedPackageIds.clear();
    const summary = await resolveAgentConfigurationNeeds(
      agent("@cinatra-ai/list-curator-agent", [
        dep({ packageName: "@cinatra-ai/linkedin-oauth-connector" }),
      ]),
      { userId: null },
    );

    const need = summary.needs.find(
      (n) => n.packageName === "@cinatra-ai/linkedin-oauth-connector",
    );
    expect(need).toBeDefined();
    expect(need!.displayName).toBe("LinkedIn OAuth");
    expect(need!.displayName).not.toBe(need!.packageName);
  });

  it("falls back to the slug only when a descriptor omits displayName", async () => {
    connectedPackageIds.clear();
    const summary = await resolveAgentConfigurationNeeds(
      agent("@cinatra-ai/mystery-agent", [dep({ packageName: "@cinatra-ai/mystery-connector" })]),
      { userId: null },
    );

    expect(summary.needs).toHaveLength(1);
    expect(summary.needs[0].displayName).toBe("mystery-connector");
  });
});

describe("resolveAgentConfigurationNeeds — scope narrowing", () => {
  it("a non-agent root never probes and surfaces nothing", async () => {
    resolveConnectorBadgeState.mockClear();
    const summary = await resolveAgentConfigurationNeeds(
      {
        kind: "connector",
        packageName: "@cinatra-ai/linkedin-oauth-connector",
        dependencies: [dep({ packageName: "@cinatra-ai/social-media-connector" })],
      },
      { userId: null },
    );
    expect(summary.hasConnectors).toBe(false);
    expect(summary.needs).toEqual([]);
    expect(resolveConnectorBadgeState).not.toHaveBeenCalled();
  });

  it("skips OPTIONAL and PEER connector dependencies", async () => {
    connectedPackageIds.clear();
    const summary = await resolveAgentConfigurationNeeds(
      agent("@cinatra-ai/list-curator-agent", [
        dep({ packageName: "@cinatra-ai/linkedin-oauth-connector", requirement: "optional" }),
        dep({ packageName: "@cinatra-ai/mystery-connector", edgeType: "peer" }),
      ]),
      { userId: null },
    );
    expect(summary.hasConnectors).toBe(false);
    expect(summary.needs).toEqual([]);
  });

  it("skips a required dependency that is not a catalog connector", async () => {
    connectedPackageIds.clear();
    const summary = await resolveAgentConfigurationNeeds(
      agent("@cinatra-ai/list-curator-agent", [
        dep({ packageName: "@cinatra-ai/some-skill", kind: "skill" }),
        dep({ packageName: "@cinatra-ai/linkedin-oauth-connector" }),
      ]),
      { userId: null },
    );
    expect(summary.needs.map((n) => n.packageName)).toEqual([
      "@cinatra-ai/linkedin-oauth-connector",
    ]);
  });
});

describe("resolveAgentConfigurationNeeds — per-connector-authoritative (direct facades)", () => {
  it("evaluates each direct required connector by its OWN probe; a connected facade is not surfaced", async () => {
    // The agent requires two connector facades directly. One is connected (its
    // OWN probe is authoritative for its whole chain), the other is not.
    connectedPackageIds.clear();
    connectedPackageIds.add("@cinatra-ai/linkedin-connector");

    const summary = await resolveAgentConfigurationNeeds(
      agent("@cinatra-ai/list-curator-agent", [
        dep({ packageName: "@cinatra-ai/linkedin-connector" }),
        dep({ packageName: "@cinatra-ai/apollo-connector" }),
      ]),
      { userId: null },
    );

    // The connected facade is NOT surfaced; only the unconfigured one is.
    expect(summary.needs.map((n) => n.packageName)).toEqual(["@cinatra-ai/apollo-connector"]);
    expect(summary.needs[0].displayName).toBe("Apollo");
    expect(summary.needs[0].settingsHref).toBe("/connectors/cinatra-ai/apollo-connector/setup");
  });

  it("does NOT descend into a facade's transitive base/oauth deps (they are not the agent's direct edges)", async () => {
    // linkedin-oauth-connector is linkedin-connector's OWN required base, NOT a
    // direct edge of the agent. The agent card keys on the direct facade only —
    // descending into the probe-less base would leave it perpetually not-ready.
    connectedPackageIds.clear(); // nothing connected
    const summary = await resolveAgentConfigurationNeeds(
      agent("@cinatra-ai/list-curator-agent", [
        dep({ packageName: "@cinatra-ai/linkedin-connector" }),
      ]),
      { userId: null },
    );
    expect(summary.needs.map((n) => n.packageName)).toEqual(["@cinatra-ai/linkedin-connector"]);
    expect(summary.needs.map((n) => n.packageName)).not.toContain(
      "@cinatra-ai/linkedin-oauth-connector",
    );
  });
});

describe("resolveConfigurationNeedsForAgents — keyed map for the card grid", () => {
  it("keys only agent rows that have unconfigured required connectors", async () => {
    connectedPackageIds.clear();
    const map = await resolveConfigurationNeedsForAgents(
      [
        {
          packageName: "@cinatra-ai/list-curator-agent",
          kind: "agent",
          dependencies: [dep({ packageName: "@cinatra-ai/linkedin-oauth-connector" })],
        },
        // a connector row — never keyed (out of scope)
        {
          packageName: "@cinatra-ai/linkedin-oauth-connector",
          kind: "connector",
          dependencies: [],
        },
        // an agent with no required connector deps — no entry
        {
          packageName: "@cinatra-ai/depless-agent",
          kind: "agent",
          dependencies: [],
        },
      ],
      { userId: null },
    );

    expect(Object.keys(map)).toEqual(["@cinatra-ai/list-curator-agent"]);
    expect(map["@cinatra-ai/list-curator-agent"].needs[0].displayName).toBe("LinkedIn OAuth");
  });
});
