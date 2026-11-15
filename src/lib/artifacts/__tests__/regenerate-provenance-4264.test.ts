/**
 * cinatra#4264 slice B1a, T2 (pure tier): the reader's three steps over an
 * in-memory stand-in of its three queries. The same cases run on a real
 * Postgres in regenerate-provenance-4264.integration.test.ts.
 *
 * Red at main: the module does not exist.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/pooled", () => ({ getPooledDb: () => ({ query: vi.fn() }) }));
vi.mock("@/lib/postgres-config", () => ({ getPostgresConnectionString: () => "", postgresSchema: "cinatra" }));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));

import {
  readVerifiedFilingNode,
  REGENERATE_PROVENANCE_MAX_DEPTH,
  type ProvenanceDb,
} from "@/lib/artifacts/regenerate-provenance";

type Ledger = { org: string; run: string; art: string; rev: string; phase: string; verified: string | null };
type Repair = { org: string; status: string; base: [string, string]; succ: [string, string] };
type Run = { id: string; org: string; template: string };

function fakeDb(ledger: Ledger[], repairs: Repair[], runs: Run[]): ProvenanceDb {
  return {
    schema: "cinatra",
    query: async (text, values) => {
      const v = values as string[];
      if (text.includes('"artifact_materializations"')) {
        expect(text).toMatch(/path = 'materialize_tool' AND phase = 'finalized'/);
        return {
          rows: ledger
            .filter((l) => l.org === v[0] && l.art === v[1] && l.rev === v[2] && l.phase === "finalized" && l.verified)
            .slice(0, 2)
            .map((l) => ({ run_id: l.run, verified_step_id: l.verified })),
        };
      }
      if (text.includes('"lifecycle_repair"')) {
        return {
          rows: repairs
            .filter((r) => r.org === v[0] && r.status === "repaired" && r.succ[0] === v[1] && r.succ[1] === v[2])
            .slice(0, 2)
            .map((r) => ({ base_artifact_id: r.base[0], base_representation_revision_id: r.base[1] })),
        };
      }
      if (text.includes('"agent_runs"')) {
        return { rows: runs.filter((r) => r.id === v[0] && r.org === v[1] && r.template === v[2]).map(() => ({ "?column?": 1 })) };
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
}

const L = (run: string, art: string, rev: string, over: Partial<Ledger> = {}): Ledger => ({
  org: "org-1", run, art, rev, phase: "finalized", verified: "file_image", ...over,
});
const RUNS: Run[] = ["R1", "R2", "R3", "R4"].map((id) => ({ id, org: "org-1", template: "tmpl-1" }))
  .concat([{ id: "RX", org: "org-1", template: "tmpl-other" }]);
const read = (db: ProvenanceDb, art: string, rev: string, over: { orgId?: string; templateId?: string } = {}) =>
  readVerifiedFilingNode(
    { orgId: over.orgId ?? "org-1", artifactId: art, representationRevisionId: rev, templateId: over.templateId ?? "tmpl-1" },
    db,
  );

describe("readVerifiedFilingNode (cinatra#4264 B1a, T2 pure tier)", () => {
  const db = fakeDb(
    [
      L("R1", "A", "A1"),
      L("R2", "A", "A2"),
      L("R3", "B", "B1"),
      L("R4", "B", "B1"),
      L("R1", "C", "C1"),
      L("R1", "D", "D1", { verified: null }),
      L("R1", "D", "D1", { phase: "claimed" }),
      L("RX", "E", "E1"),
    ],
    [
      { org: "org-1", status: "repaired", base: ["A", "A2"], succ: ["A", "A3"] },
      { org: "org-1", status: "repaired", base: ["C", "C1"], succ: ["C", "C2"] },
      { org: "org-1", status: "repaired", base: ["C", "C1"], succ: ["C", "C2"] },
      { org: "org-1", status: "dispatched", base: ["A", "A1"], succ: ["A", "A9"] },
    ],
    RUNS,
  );

  it("R1 files A/1, R2 appends A/2: each revision resolves its own run", async () => {
    expect(await read(db, "A", "A2")).toEqual({ runId: "R2", nodeId: "file_image" });
    expect(await read(db, "A", "A1")).toEqual({ runId: "R1", nodeId: "file_image" });
  });

  it("a refiled successor A/3 of a repaired repair over A/2 resolves R2", async () => {
    expect(await read(db, "A", "A3")).toEqual({ runId: "R2", nodeId: "file_image" });
  });

  it("ambiguity, missing proof, another template or org -> null", async () => {
    expect(await read(db, "B", "B1")).toBeNull();
    expect(await read(db, "C", "C2")).toBeNull();
    expect(await read(db, "D", "D1")).toBeNull();
    expect(await read(db, "E", "E1")).toBeNull();
    expect(await read(db, "A", "A9")).toBeNull();
    expect(await read(db, "A", "A2", { orgId: "org-2" })).toBeNull();
    expect(await read(db, "A", "A2", { templateId: "tmpl-other" })).toBeNull();
  });

  it("a successor chain longer than the depth cap -> null", async () => {
    const chain: Repair[] = [];
    for (let i = 0; i <= REGENERATE_PROVENANCE_MAX_DEPTH; i += 1) {
      chain.push({ org: "org-1", status: "repaired", base: ["F", `F${i}`], succ: ["F", `F${i + 1}`] });
    }
    const deep = fakeDb([L("R1", "F", "F0")], chain, RUNS);
    expect(await read(deep, "F", `F${REGENERATE_PROVENANCE_MAX_DEPTH + 1}`)).toBeNull();
    expect(await read(deep, "F", `F${REGENERATE_PROVENANCE_MAX_DEPTH}`)).toEqual({ runId: "R1", nodeId: "file_image" });
  });
});
