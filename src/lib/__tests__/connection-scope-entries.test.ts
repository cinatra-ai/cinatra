// /connectors scope-filter entry fold (cinatra#953 W3): real granted
// connections → NormalizedResourceScope entries. Pins the converged
// semantics: personal = the actor's OWN rows only; org/team/project = the
// CONCRETE granted locus; workspace grants add no locus entry; foreign
// owner-only rows contribute nothing; absent policy = owner default.

import { describe, it, expect } from "vitest";
import type { AgentAuthPolicy } from "@cinatra-ai/agents/auth-policy";
import { buildConnectionScopeEntries } from "@/lib/connection-scope-entries";
import { scopeSelectionMatches } from "@/lib/scope-filter";

const ACTOR = "user-actor";
const OTHER = "user-other";
const ORG = "org-1";
const PKG = "@cinatra-ai/gmail-connector";

function policyOf(visibility: string): AgentAuthPolicy {
  return {
    runListVisibility: visibility,
    runDataVisibility: visibility,
    runExecuteVisibility: visibility,
    allowRunSharing: false,
  } as AgentAuthPolicy;
}

function row(id: string, ownerUserId: string, organizationId: string | null = ORG) {
  return { id, connectorPackageId: PKG, organizationId, ownerUserId };
}

describe("buildConnectionScopeEntries", () => {
  it("actor-owned rows always contribute a personal entry; foreign owner-only rows contribute nothing", () => {
    const entries = buildConnectionScopeEntries(
      [row("c1", ACTOR), row("c2", OTHER)],
      new Map([
        ["c1", policyOf("owner")],
        ["c2", policyOf("owner")],
      ]),
      ACTOR,
    );
    expect(entries.get(PKG)).toEqual([{ locus: "personal" }]);
  });

  it("an absent policy row is treated as owner-only (never auto-shares)", () => {
    const entries = buildConnectionScopeEntries([row("c2", OTHER)], new Map(), ACTOR);
    expect(entries.get(PKG)).toBeUndefined();
  });

  it("a team grant narrows to exactly that team (acceptance: Team filter shows connections granted to that team)", () => {
    const entries = buildConnectionScopeEntries(
      [row("c3", OTHER)],
      new Map([["c3", policyOf("team:team-9")]]),
      ACTOR,
    );
    const list = entries.get(PKG)!;
    expect(list).toEqual([{ locus: "team", locusId: "team-9" }]);
    expect(list.some((e) => scopeSelectionMatches("team:team-9", e))).toBe(true);
    expect(list.some((e) => scopeSelectionMatches("team:team-other", e))).toBe(false);
    expect(list.some((e) => scopeSelectionMatches("personal", e))).toBe(false);
  });

  it("org / project grants bind their concrete locus ids", () => {
    const entries = buildConnectionScopeEntries(
      [row("c4", OTHER), row("c5", OTHER)],
      new Map([
        ["c4", policyOf(`org:${ORG}`)],
        ["c5", policyOf("project:p-1")],
      ]),
      ACTOR,
    );
    expect(entries.get(PKG)).toEqual([
      { locus: "organization", locusId: ORG },
      { locus: "project", locusId: "p-1" },
    ]);
  });

  it("a legacy bare org grant binds to the row's own org; a null-org row's contributes an id-less entry that matches nothing", () => {
    const entries = buildConnectionScopeEntries(
      [row("c6", OTHER, ORG), row("c7", OTHER, null)],
      new Map([
        ["c6", policyOf("org")],
        ["c7", policyOf("org")],
      ]),
      ACTOR,
    );
    const list = entries.get(PKG)!;
    expect(list).toEqual([
      { locus: "organization", locusId: ORG },
      { locus: "organization", locusId: undefined },
    ]);
    // Fail-closed predicate: the id-less entry matches no org selection.
    expect(scopeSelectionMatches(`org:${ORG}`, list[1]!)).toBe(false);
  });

  it("workspace grants add no locus entry (default view only); admin grants add the admin tier", () => {
    const entries = buildConnectionScopeEntries(
      [row("c8", OTHER), row("c9", OTHER)],
      new Map([
        ["c8", policyOf("workspace")],
        ["c9", policyOf("admin")],
      ]),
      ACTOR,
    );
    const list = entries.get(PKG)!;
    expect(list).toEqual([{ locus: "workspace", adminOnly: true }]);
    expect(list.some((e) => scopeSelectionMatches("admin", e))).toBe(true);
  });

  it("an unknown grant token contributes nothing (fail-closed)", () => {
    const entries = buildConnectionScopeEntries(
      [row("c10", OTHER)],
      new Map([["c10", policyOf("everyone")]]),
      ACTOR,
    );
    expect(entries.get(PKG)).toBeUndefined();
  });
});
