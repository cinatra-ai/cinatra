// Fixture tests for the CHAT-HITL PROGRAM ACCEPTANCE gate (cinatra#2573, epic
// #2564 S7).
//
// This gate is the program's Done-definition made mechanical, so the failure it
// must never have is a manifest that LOOKS green. The tests hold that from both
// sides:
//
//   1. HONESTY. A row whose named proof does not exist FAILS — for a MISSING
//      row exactly as for a MAPPED one, because a MISSING row routinely carries
//      the proofs of the clauses that ARE met and a stale reference there is
//      just as misleading. A row that drifts from the issue's wording, is out of
//      order, is duplicated, or claims a disposition with no proof, also fails.
//   2. STRICTNESS MEANS DONE. `--strict` reports NOT READY for a manifest with
//      MISSING or partial rows — it is not satisfied by "no false claim found".
//      An all-red manifest is the case that must never read as clean.
//   3. THE REAL MANIFEST is honest right now: audit passes, every referenced
//      test really exists, and strict reports the program READY — every one of
//      the sixteen criteria MAPPED or BUILT, none partial.
//
//      That last expectation was deliberately the OPPOSITE until the finisher
//      round (2026-08-13): it asserted NOT READY so that no lane could flip a
//      row green in passing. Flipping it is the conscious act that comment
//      demanded, and it happened only once the two S7-found defects had LANDED
//      ON MAIN — D-1 cinatra#2710 (`7123d2bf1`) and D-2 cinatra#2711
//      (`6b4c3e887`) — and the owner had ruled on the three open questions
//      (coordination-tracker entry 334). If a row ever goes back to MISSING or
//      partial, this test is what turns red first.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CANONICAL_CRITERIA,
  DISPOSITIONS,
  MANIFEST_PATH,
  auditManifest,
  proofsOf,
  strictReport,
} from "../chat-hitl-acceptance-gate.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GATE = join(REPO_ROOT, "scripts", "audit", "chat-hitl-acceptance-gate.mjs");
const manifest = () => JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));

/** A minimal well-formed manifest: every criterion, all MAPPED to one real proof. */
function wellFormed() {
  const proof = {
    file: "scripts/audit/chat-hitl-acceptance-gate.mjs",
    testName: "CANONICAL_CRITERIA",
  };
  return {
    rows: CANONICAL_CRITERIA.map((criterion) => ({
      criterion,
      disposition: "MAPPED",
      unitProofs: [proof],
    })),
  };
}

describe("the manifest's shape is pinned to the issue body", () => {
  it("holds exactly the 16 literal criteria", () => {
    expect(CANONICAL_CRITERIA).toHaveLength(16);
    expect(new Set(CANONICAL_CRITERIA).size).toBe(16);
  });

  it("accepts a well-formed manifest", () => {
    expect(auditManifest({ manifest: wellFormed() })).toEqual([]);
  });

  it("REJECTS a criterion that drifts from the issue's wording", () => {
    const m = wellFormed();
    m.rows[0].criterion = m.rows[0].criterion.replace("Chat-dispatch", "Chat dispatch");
    const v = auditManifest({ manifest: m });
    expect(v.join("\n")).toMatch(/not one of the issue's literal criteria/);
  });

  it("REJECTS a reordered manifest", () => {
    const m = wellFormed();
    [m.rows[0], m.rows[1]] = [m.rows[1], m.rows[0]];
    expect(auditManifest({ manifest: m }).join("\n")).toMatch(/out of order/);
  });

  it("REJECTS a dropped or duplicated row", () => {
    const short = wellFormed();
    short.rows.pop();
    expect(auditManifest({ manifest: short }).join("\n")).toMatch(/15 rows/);

    const dup = wellFormed();
    dup.rows[1] = { ...dup.rows[0] };
    expect(auditManifest({ manifest: dup }).join("\n")).toMatch(/duplicate criterion/);
  });

  it("REJECTS an unknown disposition", () => {
    const m = wellFormed();
    m.rows[0].disposition = "PROBABLY";
    expect(auditManifest({ manifest: m }).join("\n")).toMatch(/is not one of/);
    expect(DISPOSITIONS).toEqual(["MAPPED", "BUILT", "MISSING"]);
  });

  it("REJECTS a MAPPED/BUILT row with no proof at all", () => {
    const m = wellFormed();
    delete m.rows[0].unitProofs;
    expect(auditManifest({ manifest: m }).join("\n")).toMatch(/with no proof/);
  });

  it("REJECTS a MISSING row that does not say why", () => {
    const m = wellFormed();
    m.rows[0] = { criterion: CANONICAL_CRITERIA[0], disposition: "MISSING", gap: "todo" };
    expect(auditManifest({ manifest: m }).join("\n")).toMatch(/must say WHY/);
  });

  it("REJECTS a `partial` claim with no gap sentence", () => {
    const m = wellFormed();
    m.rows[0].partial = true;
    expect(auditManifest({ manifest: m }).join("\n")).toMatch(/without a `gap` sentence/);
  });
});

describe("a stale proof reference is caught on EVERY disposition", () => {
  it("a renamed test fails a MAPPED row", () => {
    const m = wellFormed();
    m.rows[0].unitProofs = [{ file: "scripts/audit/chat-hitl-acceptance-gate.mjs", testName: "NO_SUCH_SYMBOL" }];
    expect(auditManifest({ manifest: m }).join("\n")).toMatch(/no "NO_SUCH_SYMBOL"/);
  });

  it("a deleted file fails a MAPPED row", () => {
    const m = wellFormed();
    m.rows[0].unitProofs = [{ file: "src/does/not/exist.ts", testName: "x" }];
    expect(auditManifest({ manifest: m }).join("\n")).toMatch(/file not found/);
  });

  it("…and fails a MISSING row's PARTIAL proofs too — the case that would otherwise hide", () => {
    const m = wellFormed();
    m.rows[0] = {
      criterion: CANONICAL_CRITERIA[0],
      disposition: "MISSING",
      gap: "a sentence long enough to satisfy the shape check, saying what is not proven",
      unitProofs: [{ file: "src/does/not/exist.ts", testName: "x" }],
    };
    expect(auditManifest({ manifest: m }).join("\n")).toMatch(/file not found/);
  });
});

describe("--strict means DONE, not merely 'no false claim'", () => {
  it("an ALL-RED manifest is NOT READY, never clean", () => {
    const m = {
      rows: CANONICAL_CRITERIA.map((criterion) => ({
        criterion,
        disposition: "MISSING",
        gap: "nothing is proven yet; this manifest is the zero state of the program",
      })),
    };
    const r = strictReport({ manifest: m });
    expect(r.violations).toEqual([]);
    expect(r.unproven).toHaveLength(16);
  });

  it("a PARTIAL row keeps strict red even though its disposition is not MISSING", () => {
    const m = wellFormed();
    m.rows[3].partial = true;
    m.rows[3].gap = "the second clause of this criterion has no implementation to test yet";
    const r = strictReport({ manifest: m });
    expect(r.unproven).toHaveLength(0);
    expect(r.partial).toHaveLength(1);
  });

  it("an all-green, no-partial manifest is READY", () => {
    const r = strictReport({ manifest: wellFormed() });
    expect(r.violations).toEqual([]);
    expect(r.unproven).toEqual([]);
    expect(r.partial).toEqual([]);
  });
});

describe("the REAL manifest", () => {
  it("passes audit — every named proof exists in the tree", () => {
    expect(auditManifest()).toEqual([]);
  });

  it("names a real proof on every non-MISSING row", () => {
    for (const row of manifest().rows) {
      if (row.disposition === "MISSING") continue;
      expect(proofsOf(row).length, row.criterion.slice(0, 50)).toBeGreaterThan(0);
    }
  });

  it("the CLI's audit mode exits 0", () => {
    const res = spawnSync(process.execPath, [GATE], { cwd: REPO_ROOT, encoding: "utf8" });
    expect(res.stdout + res.stderr).toMatch(/manifest honest/);
    expect(res.status).toBe(0);
  });

  it("the CLI's --strict mode reports the program READY — all sixteen, none partial", () => {
    // The honest state of #2573 at this commit. This expectation was NOT READY
    // until the finisher round; changing it is the conscious act the previous
    // comment demanded, and it is only correct because the two defects the
    // acceptance round found are merged to main and the owner's rulings are
    // cast. It stays here, inverted, for the same reason it existed before: a
    // row that regresses to MISSING or partial fails this test immediately.
    const res = spawnSync(process.execPath, [GATE, "--strict"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(res.stdout + res.stderr).toMatch(/READY — 16\/16 criteria proven, none partial/);
    expect(res.status).toBe(0);
  });

  it("every row carries the ruling that moved it, wherever one did", () => {
    // A row amended by an owner ruling must SAY which ruling, so the record can
    // be audited without reading a chat log. Rows that were never contested
    // carry no `ruling` and must not invent one.
    const ruled = manifest().rows.filter((r) => r.ruling);
    expect(ruled.length).toBeGreaterThan(0);
    for (const r of ruled) {
      expect(r.ruling, r.criterion.slice(0, 50)).toMatch(/coordination-tracker entry \d+/);
      // The tracker lives in a private repo: its name must never appear in this
      // public manifest (the source-leak gate enforces the same rule repo-wide).
      expect(r.ruling, r.criterion.slice(0, 50)).not.toMatch(/eng(ineering)?#\d+/);
    }
  });
});
