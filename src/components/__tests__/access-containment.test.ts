/**
 * Pure containment-algebra contract (cinatra#1607 §VI — parentScope &
 * allowedScopes), against the ratified spec app-permissions.html §6.1–§6.6.
 * No DOM: the algebra is unit-tested directly.
 *
 *   pnpm exec vitest run src/components/__tests__/access-containment.test.ts
 */
import { describe, it, expect } from "vitest";
import {
  scopeIdentityOf,
  scopeIdentityToToken,
  resolveParentContainment,
  isScopeOffered,
  reconcileSelection,
  hasContainment,
  type ContainmentContext,
} from "@/components/access-containment";

// acme{rev,eng} + project p1; beta{ops} + project p2
const knownOrgIds = new Set(["org-acme", "org-beta"]);
const teamOrgOf = (teamId: string): string | undefined =>
  teamId === "team-rev" || teamId === "team-eng"
    ? "org-acme"
    : teamId === "team-ops"
      ? "org-beta"
      : undefined;
const projectOrgOf = (projectId: string): string | undefined =>
  projectId === "p1" ? "org-acme" : projectId === "p2" ? "org-beta" : undefined;
const ctx: ContainmentContext = { knownOrgIds, teamOrgOf, projectOrgOf };
// A context with NO project attribution (mirrors the multi-select nested shape).
const ctxNoProjectOrg: ContainmentContext = { knownOrgIds, teamOrgOf };

describe("scopeIdentityOf / scopeIdentityToToken (§6.7 typed identities)", () => {
  it("parses every token kind, failing closed to Personal on garbage", () => {
    expect(scopeIdentityOf("owner")).toEqual({ kind: "personal" });
    expect(scopeIdentityOf("workspace")).toEqual({ kind: "workspace" });
    expect(scopeIdentityOf("admin")).toEqual({ kind: "admin" });
    expect(scopeIdentityOf("org")).toEqual({ kind: "org" });
    expect(scopeIdentityOf("org:o1")).toEqual({ kind: "org", id: "o1" });
    expect(scopeIdentityOf("team:t1")).toEqual({ kind: "team", id: "t1" });
    expect(scopeIdentityOf("project:p1")).toEqual({ kind: "project", id: "p1" });
    expect(scopeIdentityOf("garbage")).toEqual({ kind: "personal" });
  });

  it("round-trips a token through the typed identity", () => {
    for (const t of ["owner", "workspace", "admin", "org:o1", "team:t1", "project:p1"]) {
      expect(scopeIdentityToToken(scopeIdentityOf(t))).toBe(t);
    }
    // legacy bare org → { kind: org } → bare "org"
    expect(scopeIdentityToToken(scopeIdentityOf("org"))).toBe("org");
  });
});

describe("resolveParentContainment (§6.1 / §6.3)", () => {
  it("no parent → all", () => {
    expect(resolveParentContainment(null, knownOrgIds)).toEqual({ mode: "all" });
    expect(resolveParentContainment(undefined, knownOrgIds)).toEqual({ mode: "all" });
  });
  it("known org parent → org-descendants", () => {
    expect(resolveParentContainment({ kind: "org", id: "org-acme" }, knownOrgIds)).toEqual({
      mode: "org-descendants",
      orgId: "org-acme",
    });
  });
  it("unknown / stale org parent → personal-only (fail closed, §6.3)", () => {
    expect(resolveParentContainment({ kind: "org", id: "ghost" }, knownOrgIds)).toEqual({
      mode: "personal-only",
    });
  });
  it("leaf (team/project) and Personal parents → personal-only", () => {
    expect(resolveParentContainment({ kind: "team", id: "team-rev" }, knownOrgIds).mode).toBe("personal-only");
    expect(resolveParentContainment({ kind: "project", id: "p1" }, knownOrgIds).mode).toBe("personal-only");
    expect(resolveParentContainment({ kind: "personal" }, knownOrgIds).mode).toBe("personal-only");
  });
});

describe("isScopeOffered — parentScope (§6.1, §6.2)", () => {
  it("no constraint → every token offered", () => {
    for (const t of ["owner", "project:p1", "team:team-rev", "org:org-acme", "workspace", "admin"]) {
      expect(isScopeOffered(t, {}, ctx)).toBe(true);
    }
  });

  it("org parent → only that org's teams + attributed projects + Personal; org itself + workspace + admin excluded", () => {
    const c = { parentScope: { kind: "org" as const, id: "org-acme" } };
    expect(isScopeOffered("owner", c, ctx)).toBe(true); // Personal always (§6.2)
    expect(isScopeOffered("team:team-rev", c, ctx)).toBe(true);
    expect(isScopeOffered("team:team-eng", c, ctx)).toBe(true);
    expect(isScopeOffered("project:p1", c, ctx)).toBe(true); // p1 attributed to acme
    // a team / project of ANOTHER org is not a descendant
    expect(isScopeOffered("team:team-ops", c, ctx)).toBe(false);
    expect(isScopeOffered("project:p2", c, ctx)).toBe(false); // p2 is beta's
    // the org itself, and the broader scopes, are excluded
    expect(isScopeOffered("org:org-acme", c, ctx)).toBe(false);
    expect(isScopeOffered("workspace", c, ctx)).toBe(false);
    expect(isScopeOffered("admin", c, ctx)).toBe(false);
  });

  it("org parent WITHOUT project attribution → projects fail CLOSED (multi-shape); teams still offered", () => {
    const c = { parentScope: { kind: "org" as const, id: "org-acme" } };
    expect(isScopeOffered("team:team-rev", c, ctxNoProjectOrg)).toBe(true);
    // No projectOrgOf → a project cannot be proven a descendant → excluded.
    expect(isScopeOffered("project:p1", c, ctxNoProjectOrg)).toBe(false);
    // The §6.4 lever for narrowing projects is `allowedScopes` (the agent-run
    // intersection case) used WITHOUT a conflicting parentScope: it admits
    // specific project ids regardless of the missing org attribution.
    const viaAllowed = { allowedScopes: [{ kind: "project" as const, id: "p1" }] };
    expect(isScopeOffered("project:p1", viaAllowed, ctxNoProjectOrg)).toBe(true);
    expect(isScopeOffered("project:p2", viaAllowed, ctxNoProjectOrg)).toBe(false);
  });

  it("unrecognized token fails CLOSED — never offered, never treated as Personal", () => {
    expect(isScopeOffered("garbage", {}, ctx)).toBe(false);
    expect(isScopeOffered("", {}, ctx)).toBe(false);
    // the real owner token IS always offered
    expect(isScopeOffered("owner", {}, ctx)).toBe(true);
  });

  it("malformed empty-id team:/project: fail CLOSED even when allowedScopes admits the kind; empty-tail org: stays recognized", () => {
    const teamKind = { allowedScopes: (s: { kind: string }) => s.kind === "team" };
    expect(isScopeOffered("team:", teamKind, ctx)).toBe(false); // empty id → not recognized
    const projKind = { allowedScopes: (s: { kind: string }) => s.kind === "project" };
    expect(isScopeOffered("project:", projKind, ctx)).toBe(false);
    // The intentional empty-tail `org:` (no active org install target) is recognized.
    expect(isScopeOffered("org:", {}, ctx)).toBe(true);
    // And reconciliation drops the malformed tokens (fail closed).
    expect(reconcileSelection(["team:", "team:team-rev"], {}, ctx).dropped).toEqual(["team:"]);
  });

  it("leaf / unknown parent → Personal only (fail closed)", () => {
    for (const parent of [
      { kind: "team" as const, id: "team-rev" },
      { kind: "project" as const, id: "p1" },
      { kind: "org" as const, id: "ghost" },
      { kind: "personal" as const },
    ]) {
      const c = { parentScope: parent };
      expect(isScopeOffered("owner", c, ctx)).toBe(true);
      expect(isScopeOffered("team:team-rev", c, ctx)).toBe(false);
      expect(isScopeOffered("project:p1", c, ctx)).toBe(false);
      expect(isScopeOffered("org:org-acme", c, ctx)).toBe(false);
      expect(isScopeOffered("workspace", c, ctx)).toBe(false);
    }
  });
});

describe("isScopeOffered — allowedScopes (§6.4) + intersection", () => {
  it("predicate form narrows independently of parentScope", () => {
    const c = { allowedScopes: (s: { kind: string; id?: string }) => s.kind === "project" && s.id === "p1" };
    expect(isScopeOffered("owner", c, ctx)).toBe(true); // Personal never dropped
    expect(isScopeOffered("project:p1", c, ctx)).toBe(true);
    expect(isScopeOffered("project:p2", c, ctx)).toBe(false);
    expect(isScopeOffered("team:team-rev", c, ctx)).toBe(false);
  });

  it("set form admits by (kind,id) membership", () => {
    const c = { allowedScopes: [{ kind: "team" as const, id: "team-rev" }, { kind: "workspace" as const }] };
    expect(isScopeOffered("team:team-rev", c, ctx)).toBe(true);
    expect(isScopeOffered("team:team-eng", c, ctx)).toBe(false);
    expect(isScopeOffered("workspace", c, ctx)).toBe(true);
    expect(isScopeOffered("owner", c, ctx)).toBe(true);
  });

  it("parentScope ∩ allowedScopes (both honoured)", () => {
    const c = {
      parentScope: { kind: "org" as const, id: "org-acme" },
      allowedScopes: [{ kind: "team" as const, id: "team-rev" }],
    };
    // team-rev passes BOTH; team-eng passes parentScope but not allowedScopes
    expect(isScopeOffered("team:team-rev", c, ctx)).toBe(true);
    expect(isScopeOffered("team:team-eng", c, ctx)).toBe(false);
    // Personal survives the intersection (never dropped)
    expect(isScopeOffered("owner", c, ctx)).toBe(true);
  });
});

describe("reconcileSelection (§6.6)", () => {
  it("drops out-of-scope tokens, keeps in-scope + Personal", () => {
    const c = { parentScope: { kind: "org" as const, id: "org-acme" } };
    const { kept, dropped } = reconcileSelection(
      ["owner", "team:team-rev", "team:team-ops", "workspace"],
      c,
      ctx,
    );
    expect(kept).toEqual(["owner", "team:team-rev"]);
    expect(dropped).toEqual(["team:team-ops", "workspace"]);
  });

  it("no containment → keeps every RECOGNIZED token", () => {
    const { kept, dropped } = reconcileSelection(["team:team-ops", "workspace"], {}, ctx);
    expect(kept).toEqual(["team:team-ops", "workspace"]);
    expect(dropped).toEqual([]);
  });

  it("drops an unrecognized token even with no containment (fail closed, not fail-open Personal)", () => {
    const { kept, dropped } = reconcileSelection(["owner", "garbage"], {}, ctx);
    expect(kept).toEqual(["owner"]);
    expect(dropped).toEqual(["garbage"]);
  });
});

describe("hasContainment", () => {
  it("is false only when neither constraint is supplied", () => {
    expect(hasContainment({})).toBe(false);
    expect(hasContainment({ parentScope: null })).toBe(false);
    expect(hasContainment({ parentScope: { kind: "org", id: "x" } })).toBe(true);
    expect(hasContainment({ allowedScopes: [] })).toBe(true);
  });
});
