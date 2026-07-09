// cinatra #1234 (owner review) — the post-install resolver must surface each
// connector's HUMAN-READABLE manifest displayName (the SAME name the
// /connectors card grid renders), never the bare package name, and fall back to
// the slug only when a descriptor omits displayName. This pins the resolver
// boundary (`configuration-needs.server.ts`), complementing the pure-derivation
// and component-render tests.
//
// Both dependencies are mocked (the established pattern): the connector-catalog
// descriptor source and the readiness/setup-href registry. `server-only` is
// aliased to a stub by vitest.config, so importing the `.server` module works.
import { describe, expect, it, vi } from "vitest";

vi.mock("@cinatra-ai/connectors-catalog/descriptors.mjs", () => ({
  getConnectorDescriptorBySlug: (slug: string) =>
    ({
      // a normal catalog connector — carries a human-readable displayName
      "linkedin-oauth-connector": {
        packageId: "@cinatra-ai/linkedin-oauth-connector",
        slug: "linkedin-oauth-connector",
        displayName: "LinkedIn",
      },
      // a (hypothetical) descriptor with an EMPTY displayName — exercises the
      // slug fallback so a name is ALWAYS rendered, never a blank primary label
      "mystery-connector": {
        packageId: "@cinatra-ai/mystery-connector",
        slug: "mystery-connector",
        displayName: "",
      },
    })[slug],
}));

vi.mock("@/lib/connectors-registry.server", () => ({
  // every probed connector reports not-connected → each is surfaced as a need
  resolveConnectorBadgeState: vi.fn(async () => ({ connected: false })),
  getConnectorSetupHref: (slug: string) => `/connectors/cinatra-ai/${slug}/setup`,
}));

import { resolveBatchConfigurationNeeds } from "@/lib/configuration-needs.server";
import type {
  InstallBatch,
  InstallBatchMember,
} from "@/lib/extension-install-batch-ops";

function member(over: Partial<InstallBatchMember> & { packageName: string }): InstallBatchMember {
  return {
    version: "1.0.0",
    typeId: "connector",
    status: "installed",
    preState: { present: false },
    ...over,
  };
}

function batch(members: InstallBatchMember[], rootPackage: string): InstallBatch {
  return {
    batchId: "b-1",
    rootPackage,
    orgId: null,
    phase: "finalized",
    members,
    createdAt: "2026-07-09T00:00:00.000Z",
    updatedAt: "2026-07-09T00:01:00.000Z",
  };
}

describe("resolveBatchConfigurationNeeds — human-readable connector name", () => {
  it("uses the manifest displayName as the connector's name, not the package id", async () => {
    const summary = await resolveBatchConfigurationNeeds(
      batch(
        [
          member({ packageName: "@cinatra-ai/linkedin-oauth-connector" }),
          // a non-connector member (agent root) has no catalog descriptor and is skipped
          member({ packageName: "@cinatra-ai/list-curator-agent", typeId: "agent" }),
        ],
        "@cinatra-ai/list-curator-agent",
      ),
      { userId: null },
    );

    const need = summary.needs.find(
      (n) => n.packageName === "@cinatra-ai/linkedin-oauth-connector",
    );
    expect(need).toBeDefined();
    // the PRIMARY label is the human-readable manifest name…
    expect(need!.displayName).toBe("LinkedIn");
    // …and it is NOT the bare package name
    expect(need!.displayName).not.toBe(need!.packageName);
    // the non-connector member carried no descriptor → never surfaced
    expect(summary.needs.map((n) => n.packageName)).not.toContain(
      "@cinatra-ai/list-curator-agent",
    );
  });

  it("falls back to the slug only when a descriptor omits displayName", async () => {
    const summary = await resolveBatchConfigurationNeeds(
      batch(
        [member({ packageName: "@cinatra-ai/mystery-connector" })],
        "@cinatra-ai/mystery-connector",
      ),
      { userId: null },
    );

    expect(summary.needs).toHaveLength(1);
    expect(summary.needs[0].displayName).toBe("mystery-connector");
  });
});
