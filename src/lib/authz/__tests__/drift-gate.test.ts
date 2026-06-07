/**
 * Bidirectional authz invariant coverage.
 *
 * Asserts:
 *   1. Every primitive in `__generated__/inventory.json` has a
 *      classification in `inventory-augment.ts`.
 *   2. Every classification's `(resourceType, action)` exists in the central
 *      registry (`registry.ts`).
 *   3. Every CarveOut entry's `(primitiveName, boundary)` either targets an
 *      enforced primitive OR a documented future enforcement.
 *   4. No CarveOut is stale — every entry's `primitiveName` exists in the
 *      generated inventory (the bypass is real, not a leftover note).
 *   5. The generated inventory is up-to-date with the source tree (running
 *      the builder in `--check` mode produces no diff).
 *
 * Coverage should also assert that every recorded carve-out has a matching
 * `requireAccess(..., { carveOut: ... })` call site in code. Until then we
 * check the carve-out side only.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { CLASSIFICATION_ENTRIES, lookupClassification, type Action } from "../registry";
import { PRIMITIVE_CLASSIFICATIONS } from "../inventory-augment";
import { CARVE_OUTS } from "../carve-out";
import type { ResourceType } from "../resource-ref";

const REPO_ROOT = resolve(__dirname, "../../../..");
const INVENTORY_PATH = resolve(REPO_ROOT, "src/lib/authz/__generated__/inventory.json");

type InventoryFile = {
  generatedBy: string;
  primitives: { primitiveName: string; file: string; line: number }[];
};

function loadInventory(): InventoryFile {
  return JSON.parse(readFileSync(INVENTORY_PATH, "utf8"));
}

describe("authz invariant coverage", () => {
  it("every inventory primitive has a classification entry", () => {
    const inv = loadInventory();
    const missing: string[] = [];
    for (const p of inv.primitives) {
      if (!PRIMITIVE_CLASSIFICATIONS[p.primitiveName]) missing.push(p.primitiveName);
    }
    if (missing.length > 0) {
      // De-duplicate before reporting: one primitive may appear N times in
      // the inventory (different files) but only one classification entry.
      const unique = [...new Set(missing)].sort();
      throw new Error(
        `Missing classification for ${unique.length} primitive(s) in src/lib/authz/inventory-augment.ts:\n` +
          unique.map((n) => `  - ${n}`).join("\n"),
      );
    }
    expect(missing).toEqual([]);
  });

  it("every classification's (resourceType, action) exists in the registry", () => {
    const orphans: string[] = [];
    for (const [name, cls] of Object.entries(PRIMITIVE_CLASSIFICATIONS)) {
      const reg = lookupClassification(cls.resourceType as ResourceType, cls.action as Action);
      if (!reg) orphans.push(`${name} → ${cls.resourceType}::${cls.action}`);
    }
    if (orphans.length > 0) {
      throw new Error(
        `Classification(s) reference an unknown (resourceType, action) — registry.ts needs an entry:\n` +
          orphans.map((o) => `  - ${o}`).join("\n"),
      );
    }
    expect(orphans).toEqual([]);
  });

  it("every CarveOut targets a real primitive (no stale entries)", () => {
    const inv = loadInventory();
    const known = new Set(inv.primitives.map((p) => p.primitiveName));
    const stale = CARVE_OUTS.filter((c) => !known.has(c.primitiveName));
    if (stale.length > 0) {
      throw new Error(
        `Stale CarveOut entries — primitive not found in inventory (carve-out removed without removing the entry):\n` +
          stale.map((c) => `  - ${c.primitiveName} (boundary=${c.boundary})`).join("\n"),
      );
    }
    expect(stale).toEqual([]);
  });

  it("every CarveOut's (resourceType, action) exists in the registry", () => {
    const bad = CARVE_OUTS.filter(
      (c) => !lookupClassification(c.resourceType, c.action),
    );
    if (bad.length > 0) {
      throw new Error(
        `CarveOut(s) reference an unknown (resourceType, action):\n` +
          bad.map((c) => `  - ${c.primitiveName} → ${c.resourceType}::${c.action}`).join("\n"),
      );
    }
    expect(bad).toEqual([]);
  });

  it("registry has no duplicate entries", () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const entry of CLASSIFICATION_ENTRIES) {
      const key = `${entry.resourceType}::${entry.action}`;
      if (seen.has(key)) dupes.push(key);
      seen.add(key);
    }
    expect(dupes).toEqual([]);
  });

  it("every ResourceType in the union has at least one registry entry", () => {
    // A new resource type added to the ResourceType union WITHOUT a
    // classification entry fails CI. We parse the union from resource-ref.ts
    // statically so adding a member there forces a registry entry here.
    const refPath = resolve(REPO_ROOT, "src/lib/authz/resource-ref.ts");
    const body = readFileSync(refPath, "utf8");
    const m = body.match(/export type ResourceType =([\s\S]*?);/);
    expect(m, "ResourceType union not found").toBeTruthy();
    const unionMembers = [...m![1].matchAll(/"([a-z_]+)"/g)].map((mm) => mm[1]);
    const covered = new Set(CLASSIFICATION_ENTRIES.map((e) => e.resourceType));
    // "platform" + "administration" + "audit" are sentinels / platform-level;
    // they carry registry entries too, but we allow a small documented set to
    // be read-only sentinels with at least one entry. Assert every union
    // member has >=1 entry.
    const uncovered = unionMembers.filter((rt) => !covered.has(rt as never));
    if (uncovered.length > 0) {
      throw new Error(
        `ResourceType(s) without any registry classification entry:\n` +
          uncovered.map((rt) => `  - ${rt}`).join("\n"),
      );
    }
    expect(uncovered).toEqual([]);
  });

  it("delegated-chat policy overrides equal the typed CarveOut entries at delegated_chat_token boundary", () => {
    // Static parse of the policy file; we deliberately avoid importing the
    // policy module to keep the invariant test dependency-free.
    const POLICY_PATH = resolve(REPO_ROOT, "packages/mcp-server/src/delegated-chat-tool-policy.ts");
    const body = readFileSync(POLICY_PATH, "utf8");
    const m = body.match(/ALLOWED_PROPOSAL_OVERRIDE\s*=\s*new\s+Set<string>\(\[([\s\S]*?)\]\)/);
    expect(m, "ALLOWED_PROPOSAL_OVERRIDE block not found").toBeTruthy();
    const block = m![1];
    const policyNames = [...block.matchAll(/"([a-z_][a-z0-9_]*)"/g)].map((mm) => mm[1]).sort();
    const carveNames = CARVE_OUTS.filter((c) => c.boundary === "delegated_chat_token")
      .map((c) => c.primitiveName)
      .sort();
    expect(policyNames).toEqual(carveNames);
  });

  it("generated inventory carries no volatile timestamp (deterministic byte-gated artifact)", () => {
    // Recurrence guard. A `generatedAt` date in this byte-compared file made the
    // RBAC inventory check fail the day after every commit (the file was committed
    // on day N with generatedAt=N; --check on day N+1 regenerated it with N+1 and
    // saw a diff). It was repeatedly "fixed" by re-regenerating — a band-aid.
    // The real fix is keeping the emitted JSON free of volatile fields. If a
    // future change re-introduces a date/timestamp, this fails immediately.
    const parsed = JSON.parse(readFileSync(INVENTORY_PATH, "utf8")) as Record<string, unknown>;
    const volatileKeys = Object.keys(parsed).filter((k) => /generatedat|timestamp|date|time/i.test(k));
    expect(volatileKeys).toEqual([]);
  });

  it("inventory file is up to date with the source tree (build script --check)", () => {
    // Running the builder under --check exits 0 if the file matches; any
    // drift produces exit 1 + a stderr line that the test surfaces.
    try {
      execFileSync(process.execPath, [resolve(REPO_ROOT, "scripts/build-authz-inventory.mjs"), "--check"], {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: REPO_ROOT,
      });
    } catch (err) {
      const e = err as { stderr?: Buffer | string; stdout?: Buffer | string };
      const stderr = (e.stderr ?? "").toString();
      const stdout = (e.stdout ?? "").toString();
      throw new Error(
        `authz inventory is stale. Run \`pnpm authz:inventory\` to refresh.\nstdout=${stdout}\nstderr=${stderr}`,
      );
    }
  });
});
