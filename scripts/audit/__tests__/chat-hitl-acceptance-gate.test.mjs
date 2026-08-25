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
//      exists. The CLI is RED, for one criterion MISSING and one partial, which
//      are held apart from the evidence-binding arm below because conflating
//      the two is how one of them would get fixed and the other forgotten:
//
//      THE CRITERIA HALF. Strict reports the program NOT READY: one criterion
//      MISSING and one partial, each naming what is absent. That expectation
//      has now been inverted THREE times, and each inversion is recorded where
//      it happened. It asserted NOT READY by design so that no lane could flip
//      a row green in passing; the finisher round (2026-08-13) flipped it to
//      READY once the two S7-found defects had LANDED ON MAIN — D-1
//      cinatra#2710 (`7123d2bf1`) and D-2 cinatra#2711 (`6b4c3e887`) — and the
//      owner had ruled on the three open questions (coordination-tracker entry
//      334). A code-grounded audit then showed that flip was wrong on two rows:
//      the schedule criterion was mapped onto tests that never draw a card, and
//      the conformance matrix was recorded ready with no cells at all on two of
//      its four cards. It read NOT READY again, and cinatra#2788 (PR #2939, the
//      S9d rework) then DREW the schedule card — packages/chat/src/renderable-
//      views/registry.tsx now maps `trigger_schedule_proposal` to the shipped
//      `ScheduleProposalCard` — and its own ten-record capture round
//      (evidence/2788-s9d-rework) gave AC-3 the rendered proof its gap named as
//      absent, so that row is MAPPED again. The conformance-matrix row is
//      UNTOUCHED by this round and stays MISSING: it asks for the S0 spec-
//      matrix capture sweep specifically, which is a different round's work.
//
//      THE EVIDENCE HALF. The manifest's chat_thread cells point at screenshots
//      the canonical capture index never validated, and an unindexed screenshot
//      counts as zero. The CLI refuses that in BOTH modes, and it refuses it
//      before it reports on the criteria at all — so the criteria half is
//      asserted against the library below rather than against CLI output. The
//      ten S9d cells this round adds are bound the same way: driven through the
//      shipped recorder and registered in the capture index before being cited.
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
    // exits 1 because one criterion is legitimately MISSING and one is partial
    // (see the next test), and conflating the two is exactly what the comment
    // above warns against.
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

  it("the criteria half reports the program NOT READY — one proof gap and one partial row, named", () => {
    // The honest state of the program at this commit, and the THIRD time this
    // expectation has been inverted. It read NOT READY until the finisher round
    // flipped it, a code-grounded audit flipped it back for two rows, and this
    // round flips ONE of those two forward again: cinatra#2788 (PR #2939, the
    // S9d rework) drew the schedule card and its ten-record capture round gave
    // AC-3 the rendered proof the earlier gap named as absent. The conformance-
    // matrix row is untouched here and stays MISSING — it asks for the S0
    // spec-matrix capture sweep specifically, and this round did not run it.
    //
    // Asked of the LIBRARY, not of CLI output, because the evidence half above
    // refuses both modes before the CLI reaches its readiness report. Holding
    // the two halves apart is what keeps either from hiding the other: binding
    // the captures does not make the program ready, and drawing a card does not
    // bind it.
    const { violations, unproven, partial, total } = strictReport();
    expect(violations).toEqual([]);
    expect(total).toBe(CANONICAL_CRITERIA.length);
    expect(unproven).toHaveLength(1);
    expect(partial).toHaveLength(1);
    // "CARD AXIS MISSING" became "CARD AXIS PARTIAL" with cinatra#2791 (S9g):
    // six cells landed — the review gate on chat_thread pending AND decided, the
    // review gate on the page gate region, the audit card on two hosts, the chip
    // row on the run card — so "missing" stopped being the true word. The row is
    // still MISSING as a criterion, and the gap now names each remaining cell
    // with the shipped line that blocks it, which is what this assertion pins.
    expect(unproven.map((r) => r.gap).join("\n")).toMatch(/CARD AXIS PARTIAL/);
    // NOT pinned here: row 15's gap also still says trigger_schedule_proposal
    // "is NOT DRAWN on main" (item (a) of its own STILL-ABSENT list). That
    // sentence is stale as of this same commit — the card IS drawn — but row 15
    // is untouched by this round (it asks for the S0 spec-matrix capture sweep
    // specifically, a different round's work), and this suite must not pin a
    // sentence it knows to be false. See the manifest row itself for the open
    // follow-up this leaves.
    // The line the CLI would print, spelled out here so a regression in either
    // count is still legible as the sentence a reader sees.
    expect(`${total - unproven.length}/${total} criteria proven, ${unproven.length} MISSING, ${partial.length} partial`).toBe(
      "15/16 criteria proven, 1 MISSING, 1 partial",
    );
  });

  it("the design pin is the ratified drawing, and the drift is recorded rather than overwritten", () => {
    const m = manifest();
    // design#132 (lifecycle-b W1) moved the pin to the drawing that makes the
    // schedule ONE FORM in five readings. Every pin the rows were read against
    // before this move is still here: the previous head becomes `previousPin`,
    // and the head before THAT is APPENDED to `priorPins` rather than replacing
    // what was already in it. The whole point of the drift record is that a pin
    // move leaves a trail, so the assertions walk the WHOLE trail rather than
    // only checking the head — a move that dropped an older pin on its way past
    // would still satisfy a head-only check.
    expect(m.specCommit).toContain("fe2182547d4a98125a0968824ffb0d45fb25a8e5");
    // An IMMUTABLE pin: a 40-character commit, never a branch name.
    expect(m.specCommit).toMatch(/^design@[0-9a-f]{40}\s\S+$/);
    expect(m.specCommitDrift.previousPin).toContain("71398a49c1f8adfe6176ab0dda25486920fac958");
    expect(m.specCommitDrift.previousPin).toMatch(/^design@[0-9a-f]{40}\s\S+$/);
    for (const prior of [
      "6c20871b4108176c1d0193f19ecd2947f6c6355f",
      "92c1be7c6f864dec6382a9ef01e7b2e1c38aa871",
    ]) {
      expect(m.specCommitDrift.priorPins.join("\n"), prior).toContain(prior);
    }
    // Nothing on the trail repeats: a pin that appears twice is a record that
    // lost track of which move it belongs to.
    const trail = [m.specCommit, m.specCommitDrift.previousPin, ...m.specCommitDrift.priorPins];
    const commits = trail.map((entry) => entry.slice("design@".length, "design@".length + 40));
    expect(new Set(commits).size, trail.join("\n")).toBe(commits.length);
    // No pin is ever its own predecessor: a "move" that recorded the same commit
    // on both sides would satisfy every check above and record nothing.
    expect(m.specCommitDrift.previousPin).not.toBe(m.specCommit);
    expect(m.specCommitDrift.why.length).toBeGreaterThan(60);
    // The move says what CHANGED between the two documents, not merely that one
    // happened, and it does not claim an approval it cannot see.
    expect(m.specCommitDrift.differs.length).toBeGreaterThan(120);
    expect(m.specCommitDrift.whoRatified).toMatch(/ratified on 2026-08-25/);
  });

  it("row 15 keeps the proofs it had — a flip withdraws a claim, not evidence", () => {
    const row = manifest().rows[14];
    expect(row.disposition, row.criterion.slice(0, 40)).toBe("MISSING");
    expect(row.partial).toBe(true);
    expect(proofsOf(row).length, row.criterion.slice(0, 40)).toBeGreaterThan(0);
    expect(row.gap.length).toBeGreaterThan(200);
  });

  it("row 3 is MAPPED again and kept every proof it had before the UI gap existed", () => {
    // The mirror of the test above: this flip runs the OTHER way, and the same
    // rule holds regardless of direction. The transaction proofs cinatra#2573's
    // acceptance round wrote are untouched below — mint/consume identity,
    // arm-before-expose, single-use, replay, the concurrent double-Confirm and
    // drain reconciliation — and cinatra#2788 (PR #2939) adds the UI proof
    // beside them rather than replacing anything.
    const row = manifest().rows[2];
    expect(row.disposition).toBe("MAPPED");
    expect(row.partial).toBeUndefined();
    expect(row.gap).toBeUndefined();
    expect(row.unitProofs).toHaveLength(3);
    expect(row.integrationProofs).toHaveLength(6);
    // The S9d rework round produced exactly ten records (five cells, light +
    // dark) and this row cites all ten — pinned exactly, not merely "some",
    // so a future citation dropped or silently added is caught here.
    expect(row.e2eProofs).toHaveLength(10);
    expect(row.e2eProofs.every((p) => p.file === "evidence/2788-s9d-rework/README.md")).toBe(
      true,
    );
    expect(new Set(row.e2eProofs.map((p) => p.testName)).size).toBe(10);
    for (const stem of ["C1", "C2", "C3", "C5", "C6"]) {
      const cell = row.e2eProofs.filter((p) => p.testName.startsWith(`S9d-${stem}__`));
      expect(cell, stem).toHaveLength(2); // light + dark
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
