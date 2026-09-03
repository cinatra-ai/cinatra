// `agent_assigned_context` store primitives (cinatra#2813 S1, epic #2812).
//
// The context store is the artifact twin of the skills store: the SAME exact-
// scope tuple rule, the same per-(package, scope) advisory lock, and the same
// idempotent write. It differs in two deliberate ways — it is UNCAPPED (a
// slot's own min/max decides at run time, not the store), and it validates the
// write against the agent's trusted slot manifest before it lands.
//
// The validation is FAIL-CLOSED, and that is what most of this suite is about:
// a slot the agent does not declare, an artifact the writer cannot see, an
// artifact the slot does not accept, and an unreadable validation source all
// refuse the write. Admitting any of them would let a person attach a document
// to an agent through a slot that was never meant to carry it.
import { describe, expect, it, vi } from "vitest";

import { WORKSPACE_SCOPE_SENTINEL } from "@/lib/assignment-scope";
import {
  AGENT_ASSIGNED_CONTEXT_TABLE,
  deleteAssignedContext,
  deleteAssignedContextForAgentPackage,
  deleteAssignedContextForArtifacts,
  insertAssignedContext,
  readAssignedContextForAgentScope,
  type AgentAssignedContextStoreDeps,
} from "@/lib/agent-assigned-context-store";

const PKG = "@acme/writer";
const SLOT = "brand_guide";
const ARTIFACT = "res_1";
const PROJECT_SCOPE = { scopeKind: "project", scopeId: "proj_1" } as const;

type Call = { text: string; values: readonly unknown[] };

/** A query double that records every statement and answers from a script. */
function harness(script: Array<unknown[]> = []) {
  const calls: Call[] = [];
  let i = 0;
  const query = async <T>(text: string, values?: readonly unknown[]) => {
    calls.push({ text, values: values ?? [] });
    return (script[i++] ?? []) as T[];
  };
  return { calls, query };
}

function allowAll(): Required<Pick<
  AgentAssignedContextStoreDeps,
  "slotExists" | "artifactVisibleToWriter" | "slotAcceptsArtifact"
>> {
  return {
    slotExists: vi.fn(async () => true),
    artifactVisibleToWriter: vi.fn(async () => true),
    slotAcceptsArtifact: vi.fn(async () => true),
  };
}

const RAW = {
  agent_package_name: PKG,
  slot_id: SLOT,
  artifact_id: ARTIFACT,
  scope_kind: "project",
  scope_id: "proj_1",
  position: 1,
  created_by: "user_1",
  created_at: "2026-01-01T00:00:00.000Z",
};

describe("agent_assigned_context — the exact-scope tuple rule", () => {
  it("refuses a workspace row that does not carry the sentinel", async () => {
    const { query } = harness();
    await expect(
      insertAssignedContext(
        {
          agentPackageName: PKG,
          slotId: SLOT,
          artifactId: ARTIFACT,
          scope: { scopeKind: "workspace", scopeId: "org_1" } as never,
          createdBy: "user_1",
        },
        { query, ...allowAll() },
      ),
    ).rejects.toThrow(/workspace/i);
  });

  it("refuses a project row smuggling the workspace sentinel", async () => {
    const { query } = harness();
    await expect(
      insertAssignedContext(
        {
          agentPackageName: PKG,
          slotId: SLOT,
          artifactId: ARTIFACT,
          scope: { scopeKind: "project", scopeId: WORKSPACE_SCOPE_SENTINEL } as never,
          createdBy: "user_1",
        },
        { query, ...allowAll() },
      ),
    ).rejects.toThrow(/sentinel/i);
  });

  it("admits a workspace row carrying the sentinel", async () => {
    const { query } = harness([[], [], [{ ...RAW, scope_kind: "workspace", scope_id: WORKSPACE_SCOPE_SENTINEL }]]);
    const res = await insertAssignedContext(
      {
        agentPackageName: PKG,
        slotId: SLOT,
        artifactId: ARTIFACT,
        scope: { scopeKind: "workspace", scopeId: WORKSPACE_SCOPE_SENTINEL },
        createdBy: "user_1",
      },
      { query, ...allowAll() },
    );
    expect(res.outcome).toBe("assigned");
  });
});

describe("agent_assigned_context — server-side validation is FAIL-CLOSED", () => {
  it("refuses a slot the agent's trusted manifest does not declare", async () => {
    const { query, calls } = harness();
    const deps = { ...allowAll(), slotExists: vi.fn(async () => false) };
    const res = await insertAssignedContext(
      { agentPackageName: PKG, slotId: "made_up", artifactId: ARTIFACT, scope: PROJECT_SCOPE, createdBy: "user_1" },
      { query, ...deps },
    );
    expect(res).toEqual({ outcome: "refused", reason: "unknown-slot" });
    // Refused BEFORE any statement — nothing is written and nothing is locked.
    expect(calls).toEqual([]);
  });

  it("refuses an artifact the writer cannot see", async () => {
    const { query, calls } = harness();
    const deps = { ...allowAll(), artifactVisibleToWriter: vi.fn(async () => false) };
    const res = await insertAssignedContext(
      { agentPackageName: PKG, slotId: SLOT, artifactId: ARTIFACT, scope: PROJECT_SCOPE, createdBy: "user_1" },
      { query, ...deps },
    );
    expect(res).toEqual({ outcome: "refused", reason: "artifact-not-visible" });
    expect(calls).toEqual([]);
  });

  it("refuses an artifact the slot's accepted extensions do not admit", async () => {
    const { query } = harness();
    const deps = { ...allowAll(), slotAcceptsArtifact: vi.fn(async () => false) };
    const res = await insertAssignedContext(
      { agentPackageName: PKG, slotId: SLOT, artifactId: ARTIFACT, scope: PROJECT_SCOPE, createdBy: "user_1" },
      { query, ...deps },
    );
    expect(res).toEqual({ outcome: "refused", reason: "incompatible-artifact" });
  });

  it("refuses when a validation source THROWS — an unreadable answer is not a yes", async () => {
    const { query } = harness();
    const deps = {
      ...allowAll(),
      slotExists: vi.fn(async () => {
        throw new Error("manifest unreachable");
      }),
    };
    const res = await insertAssignedContext(
      { agentPackageName: PKG, slotId: SLOT, artifactId: ARTIFACT, scope: PROJECT_SCOPE, createdBy: "user_1" },
      { query, ...deps },
    );
    expect(res).toEqual({ outcome: "refused", reason: "validation-unreadable" });
  });

  it("validates the writer, not the agent — the visibility check receives the writer", async () => {
    const { query } = harness([[], [], [RAW]]);
    const deps = allowAll();
    await insertAssignedContext(
      { agentPackageName: PKG, slotId: SLOT, artifactId: ARTIFACT, scope: PROJECT_SCOPE, createdBy: "user_7" },
      { query, ...deps },
    );
    expect(deps.artifactVisibleToWriter).toHaveBeenCalledWith(
      expect.objectContaining({ artifactId: ARTIFACT, writerId: "user_7", scope: PROJECT_SCOPE }),
    );
  });
});

describe("agent_assigned_context — the write", () => {
  it("takes the advisory lock keyed per (package, EXACT scope)", async () => {
    const { query, calls } = harness([[], [], [RAW]]);
    await insertAssignedContext(
      { agentPackageName: PKG, slotId: SLOT, artifactId: ARTIFACT, scope: PROJECT_SCOPE, createdBy: "user_1" },
      { query, ...allowAll() },
    );
    expect(calls[0]?.text).toMatch(/pg_advisory_xact_lock/);
    // ONE composed key, built by the shared scope module — so the lock the
    // skills store takes and the lock this store takes cannot drift apart.
    const key = String(calls[0]?.values[0]);
    expect(key).toContain(PKG);
    expect(key).toContain("project");
    expect(key).toContain("proj_1");
  });

  it("is idempotent — a re-submitted tuple reports already_assigned and inserts nothing", async () => {
    const { query, calls } = harness([[], [RAW]]);
    const res = await insertAssignedContext(
      { agentPackageName: PKG, slotId: SLOT, artifactId: ARTIFACT, scope: PROJECT_SCOPE, createdBy: "user_1" },
      { query, ...allowAll() },
    );
    expect(res.outcome).toBe("already_assigned");
    expect(calls.some((c) => /INSERT INTO/.test(c.text))).toBe(false);
  });

  it("is UNCAPPED — it never counts the rows before inserting", async () => {
    const { query, calls } = harness([[], [], [RAW]]);
    await insertAssignedContext(
      { agentPackageName: PKG, slotId: SLOT, artifactId: ARTIFACT, scope: PROJECT_SCOPE, createdBy: "user_1" },
      { query, ...allowAll() },
    );
    expect(calls.some((c) => /count\(\*\)/i.test(c.text))).toBe(false);
  });

  it("positions the row within its own scope tuple, never across scopes", async () => {
    const { query, calls } = harness([[], [], [RAW]]);
    await insertAssignedContext(
      { agentPackageName: PKG, slotId: SLOT, artifactId: ARTIFACT, scope: PROJECT_SCOPE, createdBy: "user_1" },
      { query, ...allowAll() },
    );
    const insert = calls.find((c) => /INSERT INTO/.test(c.text));
    expect(insert?.text).toMatch(/MAX\("position"\)/);
    expect(insert?.text).toMatch(/scope_kind = \$\d/);
    expect(insert?.text).toMatch(/scope_id = \$\d/);
  });
});

describe("agent_assigned_context — the read", () => {
  it("orders deterministically by position, then artifact id", async () => {
    const { query, calls } = harness([[RAW]]);
    const rows = await readAssignedContextForAgentScope(PKG, PROJECT_SCOPE, { query });
    expect(calls[0]?.text).toMatch(/ORDER BY "position" ASC, artifact_id ASC/);
    expect(rows[0]).toEqual({
      agentPackageName: PKG,
      slotId: SLOT,
      artifactId: ARTIFACT,
      scopeKind: "project",
      scopeId: "proj_1",
      position: 1,
      createdBy: "user_1",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("reads EXACTLY one scope — it never widens to the package", async () => {
    const { query, calls } = harness([[]]);
    await readAssignedContextForAgentScope(PKG, PROJECT_SCOPE, { query });
    expect(calls[0]?.text).toMatch(/scope_kind = \$\d/);
    expect(calls[0]?.text).toMatch(/scope_id = \$\d/);
  });
});

describe("agent_assigned_context — removal and teardown", () => {
  it("removes by the FULL tuple identity", async () => {
    const { query, calls } = harness([[{ artifact_id: ARTIFACT }]]);
    const res = await deleteAssignedContext(
      { agentPackageName: PKG, slotId: SLOT, artifactId: ARTIFACT, scope: PROJECT_SCOPE },
      { query },
    );
    expect(res).toEqual({ deleted: true });
    for (const col of ["agent_package_name", "slot_id", "artifact_id", "scope_kind", "scope_id"]) {
      expect(calls[0]?.text).toContain(col);
    }
  });

  it("removing a row that is already gone is not an error", async () => {
    const { query } = harness([[]]);
    await expect(
      deleteAssignedContext(
        { agentPackageName: PKG, slotId: SLOT, artifactId: ARTIFACT, scope: PROJECT_SCOPE },
        { query },
      ),
    ).resolves.toEqual({ deleted: false });
  });

  it("package uninstall sweeps every scope of that package", async () => {
    const { query, calls } = harness([[{ slot_id: SLOT, artifact_id: ARTIFACT, scope_kind: "project", scope_id: "proj_1" }]]);
    const res = await deleteAssignedContextForAgentPackage(PKG, { query });
    expect(res.removed).toHaveLength(1);
    expect(calls[0]?.text).toMatch(/DELETE FROM/);
    expect(calls[0]?.text).not.toMatch(/scope_kind = \$/);
  });

  it("an artifact sweep is available for callers that cannot rely on the cascade", async () => {
    const { query, calls } = harness([[{ agent_package_name: PKG, slot_id: SLOT, artifact_id: ARTIFACT, scope_kind: "project", scope_id: "proj_1" }]]);
    const res = await deleteAssignedContextForArtifacts([ARTIFACT], { query });
    expect(res.removed).toHaveLength(1);
    expect(calls[0]?.text).toMatch(/artifact_id = ANY/);
  });

  it("names the table once, for both twins to agree with", () => {
    expect(AGENT_ASSIGNED_CONTEXT_TABLE).toBe("agent_assigned_context");
  });
});

// ── the lock is only a lock inside a transaction ──────────────────────────
//
// `pg_advisory_xact_lock` is released when the transaction that took it ends.
// On a pooled autocommit connection every statement is its own transaction, so
// a lock taken that way is gone before the next statement runs and the
// re-check / MAX(position) insert it is supposed to protect run unserialized.
// This block pins that the whole locked section is issued through ONE
// transaction handle.
describe("agent_assigned_context — the locked section shares one transaction", () => {
  it("issues the lock AND every locked statement through the transaction handle", async () => {
    const outside: string[] = [];
    const inside: string[] = [];
    const outerQuery = async <T>(text: string) => {
      outside.push(text);
      return [] as T[];
    };
    let opened = 0;
    const script: Array<unknown[]> = [[], [], [RAW]];
    let i = 0;
    const transaction = async <T>(fn: (tx: typeof outerQuery) => Promise<T>) => {
      opened += 1;
      const txQuery = async <U>(text: string) => {
        inside.push(text);
        return (script[i++] ?? []) as U[];
      };
      return fn(txQuery as typeof outerQuery);
    };

    const res = await insertAssignedContext(
      { agentPackageName: PKG, slotId: SLOT, artifactId: ARTIFACT, scope: PROJECT_SCOPE, createdBy: "user_1" },
      { query: outerQuery, transaction, ...allowAll() } as AgentAssignedContextStoreDeps,
    );

    expect(res.outcome).toBe("assigned");
    expect(opened).toBe(1);
    // Nothing in the locked section escaped to the autocommit handle.
    expect(outside).toEqual([]);
    expect(inside[0]).toMatch(/pg_advisory_xact_lock/);
    expect(inside.some((t) => /INSERT INTO/.test(t))).toBe(true);
    expect(inside.some((t) => /SELECT/.test(t) && !/pg_advisory/.test(t))).toBe(true);
  });

  it("does NOT hold the transaction open across the validators", async () => {
    const order: string[] = [];
    const validators = {
      slotExists: async () => {
        order.push("validate");
        return true;
      },
      artifactVisibleToWriter: async () => true,
      slotAcceptsArtifact: async () => true,
    };
    const transaction = async <T>(fn: (tx: <U>(t: string) => Promise<U[]>) => Promise<T>) => {
      order.push("transaction");
      let i = 0;
      const script: Array<unknown[]> = [[], [], [RAW]];
      return fn(async <U>() => (script[i++] ?? []) as U[]);
    };
    await insertAssignedContext(
      { agentPackageName: PKG, slotId: SLOT, artifactId: ARTIFACT, scope: PROJECT_SCOPE, createdBy: "user_1" },
      { query: async () => [], transaction, ...validators } as AgentAssignedContextStoreDeps,
    );
    expect(order[0]).toBe("validate");
    expect(order).toContain("transaction");
  });
});
