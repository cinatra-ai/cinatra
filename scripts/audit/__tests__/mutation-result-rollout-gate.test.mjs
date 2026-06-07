// Tests for the MutationResult rollout gate + inventory.

import { describe, expect, it } from "vitest";
import { spawnSync, execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();

function run(script) {
  return spawnSync("node", [script], { cwd: REPO_ROOT, encoding: "utf8" });
}

describe("mutation-result rollout gate", () => {
  it("passes on the current tree (inventory fresh + all classified + no MIGRATED regression)", () => {
    const r = run("scripts/audit/mutation-result-rollout-gate.mjs");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/rollout gate: OK/);
  });

  it("the generated inventory is fresh (build --check passes)", () => {
    const r = spawnSync(
      "node",
      ["scripts/build-write-surface-inventory.mjs", "--check"],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    expect(r.status).toBe(0);
  });
});

describe("write-surface inventory shape", () => {
  const inv = JSON.parse(
    readFileSync(
      resolve(REPO_ROOT, "src/lib/object-history/__generated__/write-surface-inventory.json"),
      "utf8",
    ),
  );

  it("classifies every surface as MIGRATED / PENDING / EXCLUDED", () => {
    for (const s of inv.surfaces) {
      expect(["MIGRATED", "PENDING", "EXCLUDED"]).toContain(s.status);
      // PENDING + EXCLUDED must carry a reason (never silent).
      if (s.status !== "MIGRATED") expect(s.reason).toBeTruthy();
    }
  });

  it("records the version-restore vertical slice as the one MIGRATED surface", () => {
    const migrated = inv.surfaces.filter((s) => s.status === "MIGRATED");
    expect(migrated.length).toBeGreaterThanOrEqual(1);
    expect(
      migrated.some((s) => s.action === "restoreObjectToVersionAction"),
    ).toBe(true);
  });

  it("tally matches the surface counts", () => {
    const recomputed = inv.surfaces.reduce(
      (acc, s) => ((acc[s.status] = (acc[s.status] ?? 0) + 1), acc),
      {},
    );
    expect(inv.tally).toEqual(recomputed);
  });
});
