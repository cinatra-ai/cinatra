/**
 * The per-scope ROW BUILDERS (cinatra#2808, per-scope surfaces S2).
 *
 * Acceptance items proved here, verbatim:
 *
 *   "Agents tab: reuse AgentAllCard/AgentRunClient with a scoped runHref (S3)
 *    and EXTEND the card + row model by name: per-entry Settings (opens the
 *    assignment page — the assignment epic), version, status. Non-assistant
 *    agent packages, active|locked."
 *
 *   "Assistants tab: reuse the directory resolver parameterized by the viewed
 *    scope (inject the predicate — never a value import of scope-filter) and
 *    EXTEND the rows around the preserved Chat button(s) with Settings
 *    (Skills-only page) and the installed-card fields. Assistant packages only."
 */
import { describe, expect, it } from "vitest";

import {
  buildScopeAgentRows,
  buildScopeAssistantRows,
  scopeSurfaceScopeMatch,
} from "../scope-surface-rows";
import type { ScopeEligibilityRow } from "../scope-surface-eligibility";

const TEAM = { kind: "team", id: "team-7" } as const;
const ORG = { kind: "organization", id: "org-1" } as const;

function eligible(over: Partial<ScopeEligibilityRow> & { packageName: string }): ScopeEligibilityRow {
  return {
    displayName: over.packageName,
    description: null,
    version: "1.0.0",
    status: "active",
    isAssistant: false,
    executionOrganizationIds: ["org-1"],
    ...over,
  };
}

describe("buildScopeAgentRows", () => {
  const rows = [
    eligible({ packageName: "@acme/orbit-agent", displayName: "Orbit", version: "1.2.0" }),
    eligible({ packageName: "@acme/ledger-agent", status: "locked", version: "3.0.1" }),
    eligible({ packageName: "@acme/atlas-assistant", isAssistant: true }),
  ];

  it("lists NON-assistant packages only", () => {
    expect(buildScopeAgentRows(TEAM, rows).map((r) => r.key)).toEqual([
      "@acme/orbit-agent",
      "@acme/ledger-agent",
    ]);
  });

  it("gives every row its scoped Run href and the S3 Settings href", () => {
    const [orbit] = buildScopeAgentRows(TEAM, rows);
    expect(orbit!.runHref).toBe("/teams/team-7/agents/acme/orbit-agent/new");
    expect(orbit!.settingsHref).toBe("/teams/team-7/agents/acme/orbit-agent/settings");
    expect(buildScopeAgentRows(ORG, rows)[0]!.runHref).toBe(
      "/organizations/org-1/agents/acme/orbit-agent/new",
    );
  });

  it("carries each row's own version and status, and no /configuration detail href", () => {
    const [orbit, ledger] = buildScopeAgentRows(TEAM, rows);
    expect([orbit!.version, orbit!.status]).toEqual(["1.2.0", "active"]);
    expect([ledger!.version, ledger!.status]).toEqual(["3.0.1", "locked"]);
    expect(orbit!.detailHref).toBeNull();
    expect(orbit!.packageName).toBe("@acme/orbit-agent");
  });
});

describe("buildScopeAssistantRows", () => {
  const directory = [
    {
      packageName: "@acme/atlas-assistant",
      vendor: "acme",
      slug: "atlas-assistant",
      displayName: "Atlas Assistant",
      localChatHref: "/chat/acme/atlas-assistant",
      remoteInstances: [
        {
          instanceId: "site-1",
          name: "Main site",
          localChatHref: "/chat/acme/atlas-assistant/site-1",
          remoteHref: "https://example.invalid/wp-admin",
        },
      ],
    },
    {
      packageName: "@acme/local-assistant",
      vendor: "acme",
      slug: "local-assistant",
      displayName: "Local Assistant",
      localChatHref: "/chat/acme/local-assistant",
      remoteInstances: [],
    },
  ];
  const eligibility = [
    eligible({ packageName: "@acme/atlas-assistant", isAssistant: true, version: "2.4.0" }),
    eligible({
      packageName: "@acme/local-assistant",
      isAssistant: true,
      version: "0.9.0",
      status: "locked",
    }),
    eligible({ packageName: "@acme/orbit-agent" }),
  ];

  it("re-addresses every Chat control at the viewed scope and keeps them all", () => {
    const [atlas, local] = buildScopeAssistantRows(TEAM, directory, eligibility);
    expect(local!.localChatHref).toBe("/teams/team-7/assistants/acme/local-assistant");
    expect(atlas!.remoteInstances[0]!.localChatHref).toBe(
      "/teams/team-7/assistants/acme/atlas-assistant/site-1",
    );
    // The jump-out is the site's own URL — never re-based on a scope.
    expect(atlas!.remoteInstances[0]!.remoteHref).toBe("https://example.invalid/wp-admin");
  });

  it("adds the Skills-only Settings href and the installed-card fields", () => {
    const [atlas, local] = buildScopeAssistantRows(TEAM, directory, eligibility);
    expect(atlas!.settingsHref).toBe("/teams/team-7/assistants/acme/atlas-assistant/settings");
    expect([atlas!.version, atlas!.status]).toEqual(["2.4.0", "active"]);
    expect([local!.version, local!.status]).toEqual(["0.9.0", "locked"]);
  });

  it("drops a directory row the scope's eligibility does not admit", () => {
    const [only] = buildScopeAssistantRows(TEAM, directory, [eligibility[0]!]);
    expect(only!.packageName).toBe("@acme/atlas-assistant");
    expect(buildScopeAssistantRows(TEAM, directory, [eligibility[0]!])).toHaveLength(1);
  });
});

describe("scopeSurfaceScopeMatch — the INJECTED directory predicate", () => {
  it("admits an entry of the viewed scope and the tenant-wide entry", () => {
    const match = scopeSurfaceScopeMatch(TEAM);
    expect(match([{ locus: "team", locusId: "team-7" }])).toBe(true);
    expect(match([{ locus: "workspace" }])).toBe(true);
    expect(match([{ locus: "team", locusId: "team-9" }])).toBe(false);
    expect(match([])).toBe(false);
  });

  it("never admits an admin-only grant on a member-facing tab", () => {
    expect(scopeSurfaceScopeMatch(ORG)([{ locus: "workspace", adminOnly: true }])).toBe(false);
  });

  it("reads the VIEWED organization, not any other", () => {
    const match = scopeSurfaceScopeMatch(ORG);
    expect(match([{ locus: "organization", locusId: "org-1" }])).toBe(true);
    expect(match([{ locus: "organization", locusId: "org-2" }])).toBe(false);
  });

  it("admits everything the actor already sees on their personal scope", () => {
    const match = scopeSurfaceScopeMatch({ kind: "personal" });
    expect(match([{ locus: "team", locusId: "team-9" }])).toBe(true);
    expect(match([{ locus: "workspace", adminOnly: true }])).toBe(false);
  });
});
