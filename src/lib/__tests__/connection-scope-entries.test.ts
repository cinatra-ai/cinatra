// /connectors scope-filter entry fold (cinatra#953 W3): real granted
// connections → NormalizedResourceScope entries. Pins the converged
// semantics: personal = the actor's OWN rows only; org/team/project = the
// CONCRETE granted locus; workspace grants add no locus entry; foreign
// owner-only rows contribute nothing; absent policy = owner default.

import { describe, it, expect } from "vitest";
import type { AgentAuthPolicy } from "@cinatra-ai/agents/auth-policy";
import { buildConnectionScopeEntries } from "@/lib/connection-scope-entries";
import {
  isDefaultScopeSelection,
  parseScopeFilterParam,
  scopeSelectionMatches,
  scopeSelectionMatchesAny,
} from "@/lib/scope-filter";

const ACTOR = "user-actor";
const OTHER = "user-other";
const ORG = "org-1";
const PKG = "@cinatra-ai/gmail-connector";

function policyOf(visibility: string): AgentAuthPolicy {
  return {
    runListVisibility: [visibility],
    runDataVisibility: [visibility],
    runExecuteVisibility: [visibility],
    allowRunSharing: false,
  } as unknown as AgentAuthPolicy;
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

  // Multi-scope W2: runDataVisibility is a token array — fan out ONE locus
  // entry per token.
  const policyMulti = (tokens: string[]): AgentAuthPolicy =>
    ({
      runListVisibility: tokens,
      runDataVisibility: tokens,
      runExecuteVisibility: tokens,
      allowRunSharing: false,
    }) as unknown as AgentAuthPolicy;

  it("fans out one locus entry per token in a multi-scope grant", () => {
    const entries = buildConnectionScopeEntries(
      [row("c11", OTHER)],
      new Map([["c11", policyMulti(["team:team-9", "project:proj-7"])]]),
      ACTOR,
    );
    expect(entries.get(PKG)).toEqual([
      { locus: "team", locusId: "team-9" },
      { locus: "project", locusId: "proj-7" },
    ]);
  });

  it("a mix of a broad token and a concrete token emits only the concrete locus", () => {
    const entries = buildConnectionScopeEntries(
      [row("c12", OTHER)],
      new Map([["c12", policyMulti(["workspace", `org:${ORG}`])]]),
      ACTOR,
    );
    // workspace → no entry (default view); org:<id> → one org entry.
    expect(entries.get(PKG)).toEqual([{ locus: "organization", locusId: ORG }]);
  });

  it("the actor's own multi-scope connection still contributes a single personal entry plus its shared loci", () => {
    const entries = buildConnectionScopeEntries(
      [row("c13", ACTOR)],
      new Map([["c13", policyMulti(["team:team-9", "project:proj-7"])]]),
      ACTOR,
    );
    expect(entries.get(PKG)).toEqual([
      { locus: "personal" },
      { locus: "team", locusId: "team-9" },
      { locus: "project", locusId: "proj-7" },
    ]);
  });
});

// Multi-scope W5 (cinatra#1074): the /connectors page pipeline end-to-end —
// real granted-connection entries × a comma-separated multi-scope ?scope=
// URL, exactly as ConnectorsPage composes them (canonical parse → default
// short-circuit → per-entry OR-match).
describe("multi-scope ?scope= OR-filter over connection scope entries (W5)", () => {
  const accessible = new Set([
    "personal",
    "workspace",
    "admin",
    `org:${ORG}`,
    "team:team-9",
    "project:proj-7",
  ]);

  const policyArr = (tokens: string[]): AgentAuthPolicy =>
    ({
      runListVisibility: tokens,
      runDataVisibility: tokens,
      runExecuteVisibility: tokens,
      allowRunSharing: false,
    }) as unknown as AgentAuthPolicy;

  // Three connectors: one granted to team-9, one to proj-7, one actor-owned.
  const TEAM_PKG = "@cinatra-ai/team-connector";
  const PROJ_PKG = "@cinatra-ai/project-connector";
  const MINE_PKG = "@cinatra-ai/mine-connector";
  const entries = buildConnectionScopeEntries(
    [
      { id: "t", connectorPackageId: TEAM_PKG, organizationId: ORG, ownerUserId: OTHER },
      { id: "p", connectorPackageId: PROJ_PKG, organizationId: ORG, ownerUserId: OTHER },
      { id: "m", connectorPackageId: MINE_PKG, organizationId: ORG, ownerUserId: ACTOR },
    ],
    new Map([
      ["t", policyArr(["team:team-9"])],
      ["p", policyArr(["project:proj-7"])],
      ["m", policyArr(["owner"])],
    ]),
    ACTOR,
  );

  const visible = (url: string) => {
    const tokens = parseScopeFilterParam(url, accessible);
    return [TEAM_PKG, PROJ_PKG, MINE_PKG].filter(
      (pkg) =>
        isDefaultScopeSelection(tokens) ||
        (entries.get(pkg) ?? []).some((e) => scopeSelectionMatchesAny(tokens, e)),
    );
  };

  it("a multi-scope URL ORs across parents of different kinds", () => {
    expect(visible("team:team-9,project:proj-7")).toEqual([TEAM_PKG, PROJ_PKG]);
    expect(visible("personal,team:team-9")).toEqual([TEAM_PKG, MINE_PKG]);
  });

  it("single-scope URLs keep working", () => {
    expect(visible("team:team-9")).toEqual([TEAM_PKG]);
    expect(visible("personal")).toEqual([MINE_PKG]);
  });

  it("invalid tokens drop; workspace-mixed and absent selections show everything", () => {
    expect(visible("team:team-9,team:evil")).toEqual([TEAM_PKG]);
    expect(visible("workspace,project:proj-7")).toEqual([TEAM_PKG, PROJ_PKG, MINE_PKG]);
    expect(visible("")).toEqual([TEAM_PKG, PROJ_PKG, MINE_PKG]);
  });
});
