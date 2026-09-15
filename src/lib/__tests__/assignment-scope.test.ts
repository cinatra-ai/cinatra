// The shared exact-scope tuple rule (cinatra#2813 S1, epic #2812).
//
// ONE rule, used by BOTH assignment stores and by the authorization resolver,
// so the three cannot drift: a `workspace` row carries the sentinel and only
// the sentinel; every other kind carries a non-empty real id and NEVER the
// sentinel. The rule is expressed once in TypeScript (this module) and once as
// a SQL CHECK built by the same module, so the database enforces exactly what
// the code refuses.
import { describe, expect, it } from "vitest";

import {
  ASSIGNMENT_SCOPE_KINDS,
  AssignmentScopeError,
  WORKSPACE_SCOPE_SENTINEL,
  assertAssignmentScope,
  assignmentScopeCheckSql,
  assignmentScopeKindCheckSql,
  agentRunAssignmentScopeSchemaQueries,
  assignmentScopeLockKey,
  evaluateAssignmentScope,
} from "@/lib/assignment-scope";

describe("assignment scope — the five kinds", () => {
  it("names exactly the five kinds of the epic, in coarse-to-fine order", () => {
    expect([...ASSIGNMENT_SCOPE_KINDS]).toEqual([
      "workspace",
      "organization",
      "team",
      "project",
      "user",
    ]);
  });

  it("pins the workspace sentinel", () => {
    expect(WORKSPACE_SCOPE_SENTINEL).toBe("__workspace__");
  });
});

describe("assignment scope — evaluate (the exact-scope tuple rule)", () => {
  it("admits a workspace row carrying the sentinel", () => {
    expect(
      evaluateAssignmentScope({ scopeKind: "workspace", scopeId: WORKSPACE_SCOPE_SENTINEL }),
    ).toEqual({ ok: true, scope: { scopeKind: "workspace", scopeId: WORKSPACE_SCOPE_SENTINEL } });
  });

  it("refuses a workspace row carrying anything but the sentinel", () => {
    expect(evaluateAssignmentScope({ scopeKind: "workspace", scopeId: "org_1" })).toEqual({
      ok: false,
      reason: "workspace-requires-sentinel",
    });
    expect(evaluateAssignmentScope({ scopeKind: "workspace", scopeId: "" })).toEqual({
      ok: false,
      reason: "workspace-requires-sentinel",
    });
  });

  it.each(["organization", "team", "project", "user"] as const)(
    "admits a %s row carrying a real id",
    (kind) => {
      expect(evaluateAssignmentScope({ scopeKind: kind, scopeId: "  id_1  " })).toEqual({
        ok: true,
        scope: { scopeKind: kind, scopeId: "id_1" },
      });
    },
  );

  it.each(["organization", "team", "project", "user"] as const)(
    "refuses a %s row with no id",
    (kind) => {
      expect(evaluateAssignmentScope({ scopeKind: kind, scopeId: "   " })).toEqual({
        ok: false,
        reason: "missing-scope-id",
      });
      expect(evaluateAssignmentScope({ scopeKind: kind, scopeId: null })).toEqual({
        ok: false,
        reason: "missing-scope-id",
      });
    },
  );

  it.each(["organization", "team", "project", "user"] as const)(
    "refuses a %s row smuggling the workspace sentinel",
    (kind) => {
      expect(
        evaluateAssignmentScope({ scopeKind: kind, scopeId: WORKSPACE_SCOPE_SENTINEL }),
      ).toEqual({ ok: false, reason: "sentinel-outside-workspace" });
    },
  );

  it("fails closed on an unknown kind", () => {
    expect(evaluateAssignmentScope({ scopeKind: "everyone", scopeId: "x" })).toEqual({
      ok: false,
      reason: "unknown-scope-kind",
    });
    expect(evaluateAssignmentScope({ scopeKind: null, scopeId: "x" })).toEqual({
      ok: false,
      reason: "unknown-scope-kind",
    });
  });

  it("assert throws a typed error carrying the refusal reason", () => {
    expect(() => assertAssignmentScope({ scopeKind: "project", scopeId: "" })).toThrow(
      AssignmentScopeError,
    );
    try {
      assertAssignmentScope({ scopeKind: "project", scopeId: "" });
    } catch (err) {
      expect((err as AssignmentScopeError).reason).toBe("missing-scope-id");
    }
  });
});

describe("assignment scope — the advisory-lock key", () => {
  it("separates two scopes of the SAME package", () => {
    const a = assignmentScopeLockKey("ns", "@v/p", { scopeKind: "project", scopeId: "p1" });
    const b = assignmentScopeLockKey("ns", "@v/p", { scopeKind: "project", scopeId: "p2" });
    expect(a).not.toEqual(b);
  });

  it("separates two kinds sharing an id", () => {
    const a = assignmentScopeLockKey("ns", "@v/p", { scopeKind: "team", scopeId: "x" });
    const b = assignmentScopeLockKey("ns", "@v/p", { scopeKind: "user", scopeId: "x" });
    expect(a).not.toEqual(b);
  });

  it("is stable for the same tuple", () => {
    const t = { scopeKind: "user", scopeId: "u1" } as const;
    expect(assignmentScopeLockKey("ns", "@v/p", t)).toEqual(
      assignmentScopeLockKey("ns", "@v/p", t),
    );
  });
});

describe("assignment scope — the SHARED SQL CHECK shape", () => {
  const check = assignmentScopeCheckSql();

  it("pins the workspace arm to the sentinel", () => {
    expect(check).toContain("scope_kind = 'workspace' AND scope_id = '__workspace__'");
  });

  it("forbids the sentinel and the empty id on every other arm", () => {
    expect(check).toContain("scope_kind <> 'workspace'");
    expect(check).toContain("scope_id <> '__workspace__'");
    expect(check).toContain("length(scope_id) > 0");
    // The SQL half refuses exactly what the TypeScript half refuses: a
    // whitespace-only or whitespace-padded id.
    expect(check).toContain("scope_id = btrim(scope_id)");
  });

  it("enumerates exactly the five kinds", () => {
    const kinds = assignmentScopeKindCheckSql();
    for (const k of ASSIGNMENT_SCOPE_KINDS) expect(kinds).toContain(`'${k}'`);
    expect(kinds.match(/'/g)?.length).toBe(ASSIGNMENT_SCOPE_KINDS.length * 2);
  });
});

// The run's scope column ships from this leaf (cinatra#2813 S1). It moved out
// of `drizzle-store.ts` — which is at its file-size ceiling, and which may only
// ever shrink — into the module that already owns this slice's SQL.
describe("assignment scope — the run's scope column DDL", () => {
  it("adds the column to agent_runs, idempotently and nullably", () => {
    expect(agentRunAssignmentScopeSchemaQueries("cinatra").map((q) => q.text)).toEqual([
      `ALTER TABLE "cinatra"."agent_runs" ADD COLUMN IF NOT EXISTS assignment_scope_snapshot jsonb`,
    ]);
  });

  it("quotes an adversarial schema name", () => {
    const sql = agentRunAssignmentScopeSchemaQueries('we"ird')
      .map((q) => q.text)
      .join("\n");
    expect(sql).toContain('"we""ird"');
  });
});

describe("assignment scope — a fresh install still gets the run column", () => {
  it("the store schema builder adds it after agent_runs exists, beside the delegated-actor snapshot", async () => {
    const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
    const texts = buildCreateStoreSchemaQueries("cinatra").map(
      (q) => (q as { text: string }).text,
    );
    const runs = texts.findIndex((t) =>
      t.includes(`CREATE TABLE IF NOT EXISTS "cinatra"."agent_runs"`),
    );
    const delegated = texts.findIndex((t) => t.includes("delegated_actor_snapshot"));
    const scope = texts.findIndex(
      (t) => t.includes("assignment_scope_snapshot") && t.includes(`"agent_runs"`),
    );
    expect(runs).toBeGreaterThanOrEqual(0);
    expect(delegated).toBeGreaterThan(runs);
    expect(scope).toBeGreaterThan(delegated);
  });
});
