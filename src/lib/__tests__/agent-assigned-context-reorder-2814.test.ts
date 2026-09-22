// Reordering one slot's context artifacts at ONE exact scope (cinatra#2814,
// per-scope assignment S2).
//
// The issue asks the Artifacts pane for "add, remove, and reorder rows for THIS
// scope". Add and remove are S1's store primitives; reorder is the one the pane
// needs and S1 did not ship. It follows the store's own rules:
//
//   - the identity is the FULL tuple: one package, one slot, one exact scope;
//   - it runs under the SAME per-(package, scope) advisory lock the insert
//     takes, inside one transaction, so a concurrent add cannot interleave;
//   - positions are per scope tuple (shared across the scope's slots), so the
//     reorder REUSES the slot's own position values and never touches another
//     slot's rows;
//   - an order that is not exactly the slot's current rows (a stale page, a
//     forged id) is refused, and nothing is written.
import { describe, expect, it } from "vitest";

import { WORKSPACE_SCOPE_SENTINEL } from "@/lib/assignment-scope";
import { reorderAssignedContext } from "@/lib/agent-assigned-context-store";

const PKG = "@acme/writer";
const SLOT = "brand_voice";
const TEAM = { scopeKind: "team", scopeId: "team_growth" } as const;

type Call = { text: string; values: readonly unknown[] };

function harness(script: Array<unknown[]> = []) {
  const calls: Call[] = [];
  let i = 0;
  const query = async <T>(text: string, values?: readonly unknown[]) => {
    calls.push({ text, values: values ?? [] });
    return (script[i++] ?? []) as T[];
  };
  return { calls, query };
}

const current = [
  { artifact_id: "res_a", position: 2 },
  { artifact_id: "res_b", position: 5 },
  { artifact_id: "res_c", position: 9 },
];

describe("reorderAssignedContext", () => {
  it("locks the exact scope, then rewrites only this slot's positions, reusing its own values", async () => {
    const { calls, query } = harness([[], current, []]);
    const result = await reorderAssignedContext(
      {
        agentPackageName: PKG,
        slotId: SLOT,
        scope: TEAM,
        orderedArtifactIds: ["res_c", "res_a", "res_b"],
      },
      { query },
    );
    expect(result).toEqual({ outcome: "reordered" });

    expect(calls[0]!.text).toContain("pg_advisory_xact_lock");
    expect(calls[0]!.values).toEqual([`agent_assigned_context|${PKG}|team|team_growth`]);

    expect(calls[1]!.text).toMatch(/SELECT artifact_id, "position"/);
    expect(calls[1]!.values).toEqual([PKG, SLOT, "team", "team_growth"]);

    expect(calls[2]!.text).toMatch(/UPDATE/);
    expect(calls[2]!.values).toEqual([
      PKG,
      SLOT,
      "team",
      "team_growth",
      ["res_c", "res_a", "res_b"],
      [2, 5, 9],
    ]);
    expect(calls).toHaveLength(3);
  });

  it("refuses an order that is not exactly the slot's current rows, and writes nothing", async () => {
    for (const ordered of [
      ["res_a", "res_b"],
      ["res_a", "res_b", "res_c", "res_x"],
      ["res_a", "res_a", "res_b"],
      ["res_a", "res_b", "res_x"],
    ]) {
      const { calls, query } = harness([[], current]);
      const result = await reorderAssignedContext(
        { agentPackageName: PKG, slotId: SLOT, scope: TEAM, orderedArtifactIds: ordered },
        { query },
      );
      expect(result).toEqual({ outcome: "stale-order" });
      expect(calls.some((c) => /UPDATE/.test(c.text))).toBe(false);
    }
  });

  it("treats an order that changes nothing as done, without a write", async () => {
    const { calls, query } = harness([[], current]);
    const result = await reorderAssignedContext(
      {
        agentPackageName: PKG,
        slotId: SLOT,
        scope: TEAM,
        orderedArtifactIds: ["res_a", "res_b", "res_c"],
      },
      { query },
    );
    expect(result).toEqual({ outcome: "reordered" });
    expect(calls.some((c) => /UPDATE/.test(c.text))).toBe(false);
  });

  it("keys the workspace tier on the sentinel and refuses a malformed tuple before any statement", async () => {
    const ok = harness([[], [{ artifact_id: "res_a", position: 1 }]]);
    await reorderAssignedContext(
      {
        agentPackageName: PKG,
        slotId: SLOT,
        scope: { scopeKind: "workspace", scopeId: WORKSPACE_SCOPE_SENTINEL },
        orderedArtifactIds: ["res_a"],
      },
      { query: ok.query },
    );
    expect(ok.calls[1]!.values).toEqual([PKG, SLOT, "workspace", WORKSPACE_SCOPE_SENTINEL]);

    const bad = harness();
    await expect(
      reorderAssignedContext(
        {
          agentPackageName: PKG,
          slotId: SLOT,
          scope: { scopeKind: "workspace", scopeId: "org_1" } as never,
          orderedArtifactIds: ["res_a"],
        },
        { query: bad.query },
      ),
    ).rejects.toThrow(/assignment scope refused/);
    expect(bad.calls).toHaveLength(0);
  });
});
