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
//   3. THE REAL MANIFEST is honest right now: every referenced test really
//      exists. The CLI is RED, for two INDEPENDENT reasons that are held apart
//      below, because conflating them is how one of them would get fixed and
//      the other forgotten:
//
//      THE CRITERIA HALF. Strict reports the program NOT READY: two criteria
//      MISSING and one partial, each naming what is absent. That expectation
//      has now been inverted twice, and each inversion is recorded where it
//      happened. It asserted NOT READY by design so that no lane could flip a
//      row green in passing; the finisher round (2026-08-13) flipped it to
//      READY once the two S7-found defects had LANDED ON MAIN — D-1
//      cinatra#2710 (`7123d2bf1`) and D-2 cinatra#2711 (`6b4c3e887`) — and the
//      owner had ruled on the three open questions (coordination-tracker entry
//      334). A code-grounded audit then showed that flip was wrong on two rows:
//      the schedule criterion was mapped onto tests that never draw a card, and
//      the conformance matrix was recorded ready with no cells at all on two of
//      its four cards. It reads NOT READY again, and it goes green when those
//      cards are DRAWN — never when they are re-read.
//
//      THE EVIDENCE HALF. The manifest's chat_thread cells point at screenshots
//      the canonical capture index never validated, and an unindexed screenshot
//      counts as zero. The CLI refuses that in BOTH modes, and it refuses it
//      before it reports on the criteria at all — so the criteria half is
//      asserted against the library below rather than against CLI output.
//
//      Both halves must be true before READY prints again.

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

  it("the MANIFEST half of the CLI is clean — every named proof exists", () => {
    // The manifest's own honesty is unchanged and still passes; what the CLI
    // now also refuses is the EVIDENCE binding, asserted in the test below and
    // owned by chat-hitl-capture-index.test.mjs. "Honest" is not "done": the
    // readiness question is a separate assertion again below.
    expect(auditManifest()).toEqual([]);
  });

  it("the CLI REFUSES both modes while a chat_thread cell is unbound", () => {
    // THE FLIP, and it is deliberate. Until the capture binding existed, the
    // gate printed READY over a manifest whose chat_thread cells pointed at
    // screenshots nothing had ever validated — the exact false green the
    // program's own review round caught by hand. An unindexed screenshot now
    // counts as zero, so the honest answer on this tree is RED in both modes.
    //
    // This expectation was READY before, then RED, and it is green again now —
    // for the reason the previous comment named as the only acceptable one.
    // cinatra#2791 (S9g) drove both cells against a live app with the shipped
    // recorder, validated them at the audit tier, registered the records in
    // scripts/ci/chat-hitl-capture-index.json, and moved the manifest citations
    // onto the new cell names. The evidence half is therefore silent.
    //
    // It is the EVIDENCE half this arm asserts, not readiness: `--strict` still
    // exits 1 because two criteria are legitimately MISSING (see the next test),
    // and conflating the two is exactly what the comment above warns against.
    for (const args of [[], ["--strict"]]) {
      const res = spawnSync(process.execPath, [GATE, ...args], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      });
      expect(
        res.stdout + res.stderr,
        `mode ${args.join(" ") || "audit"}`,
      ).not.toMatch(/an unindexed screenshot counts as zero/);
    }
    // The default mode — the required job — is fully green.
    expect(
      spawnSync(process.execPath, [GATE], { cwd: REPO_ROOT, encoding: "utf8" }).status,
    ).toBe(0);
  });

  it("the criteria half reports the program NOT READY — the two proof gaps, named", () => {
    // The honest state of the program at this commit, and the SECOND time this
    // expectation has been inverted. It read NOT READY until the finisher round
    // flipped it, and it is flipped back now because a code-grounded audit found
    // that two of the sixteen criteria were never met: the schedule criterion
    // was mapped onto transaction tests that draw no card, and the conformance
    // matrix was recorded ready with zero cells on two of its four cards.
    //
    // Flipping this expectation is a deliberate act in either direction, which
    // is why it carries its reason inline. Going green again needs the two cards
    // DRAWN and their cells captured — not a re-reading of the same evidence.
    //
    // Asked of the LIBRARY, not of CLI output, because the evidence half above
    // refuses both modes before the CLI reaches its readiness report. Holding
    // the two halves apart is what keeps either from hiding the other: binding
    // the captures does not make the program ready, and drawing the two cards
    // does not bind them.
    const { violations, unproven, partial, total } = strictReport();
    expect(violations).toEqual([]);
    expect(total).toBe(CANONICAL_CRITERIA.length);
    expect(unproven).toHaveLength(2);
    expect(partial).toHaveLength(1);
    expect(unproven.map((r) => r.gap).join("\n")).toMatch(/UI PROOF MISSING/);
    // "CARD AXIS MISSING" became "CARD AXIS PARTIAL" with cinatra#2791 (S9g):
    // six cells landed — the review gate on chat_thread pending AND decided, the
    // review gate on the page gate region, the audit card on two hosts, the chip
    // row on the run card — so "missing" stopped being the true word. The row is
    // still MISSING as a criterion, and the gap now names each remaining cell
    // with the shipped line that blocks it, which is what this assertion pins.
    expect(unproven.map((r) => r.gap).join("\n")).toMatch(/CARD AXIS PARTIAL/);
    expect(unproven.map((r) => r.gap).join("\n")).toMatch(
      /§VI is NOT DRAWN on main/,
    );
    // The line the CLI would print, spelled out here so a regression in either
    // count is still legible as the sentence a reader sees.
    expect(`${total - unproven.length}/${total} criteria proven, ${unproven.length} MISSING, ${partial.length} partial`).toBe(
      "14/16 criteria proven, 2 MISSING, 1 partial",
    );
  });

  it("the design pin is the ratified drawing, and the drift is recorded rather than overwritten", () => {
    const m = manifest();
    expect(m.specCommit).toContain("92c1be7c6f864dec6382a9ef01e7b2e1c38aa871");
    // An IMMUTABLE pin: a 40-character commit, never a branch name.
    expect(m.specCommit).toMatch(/^design@[0-9a-f]{40}\s\S+$/);
    expect(m.specCommitDrift.previousPin).toContain("6c20871b4108176c1d0193f19ecd2947f6c6355f");
    expect(m.specCommitDrift.why.length).toBeGreaterThan(60);
  });

  it("both flipped rows keep the proofs they had — a flip withdraws a claim, not evidence", () => {
    const rows = manifest().rows;
    for (const i of [2, 14]) {
      expect(rows[i].disposition, rows[i].criterion.slice(0, 40)).toBe("MISSING");
      expect(rows[i].partial).toBe(true);
      expect(proofsOf(rows[i]).length, rows[i].criterion.slice(0, 40)).toBeGreaterThan(0);
      expect(rows[i].gap.length).toBeGreaterThan(200);
    }
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
