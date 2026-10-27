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
//      (https://github.com/cinatra-ai/cinatra/blob/35e369ed68a6446b0125cfecaee6aa993742a961/evidence/2788-s9d-rework) gave AC-3 the rendered proof its gap named as
//      absent, so that row is MAPPED again. The conformance-matrix row is
//      UNTOUCHED by this round and stays MISSING: it asks for the S0 spec-
//      matrix capture sweep specifically, which is a different round's work.
//      cinatra#4390 (2026-10-27) then gave the schedule card's Confirm the
//      value the drawing names. The ten S9d records counted the earlier value
//      and never observed the drawn one, so they are withdrawn and AC-3 stays
//      MAPPED but `partial`, its gap naming the re-shoot #4390 still owes.
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

import { parseSpecCommit } from "../../ci/lib/design-pin.mjs";
import { captureAnchorExpectations } from "../lib/anchor-contract.mjs";

import {
  CANONICAL_CRITERIA,
  DISPOSITIONS,
  MANIFEST_PATH,
  auditManifest,
  proofExists,
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

  it("the criteria half reports the program NOT READY — one proof gap and two partial rows, named", () => {
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
    // The second partial row is AC-3 (cinatra#4390): its ten picture proofs
    // were withdrawn with the records that never observed the drawn Confirm,
    // and its gap names the re-shoot. The first is the one-implementation row.
    expect(partial).toHaveLength(2);
    expect(partial.map((r) => r.criterion)).toContain(CANONICAL_CRITERIA[2]);
    expect(partial.find((r) => r.criterion === CANONICAL_CRITERIA[2]).gap).toMatch(/cinatra#4390/);
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
      "15/16 criteria proven, 1 MISSING, 2 partial",
    );
  });

  it("the design pin is the ratified drawing, and the drift is recorded rather than overwritten", () => {
    const m = manifest();
    // The pin was adopted onto the revision the drawings' main line stands at,
    // taking in the two ratifications of governed drawings it had not adopted.
    // Every pin the rows
    // were read against before this move is still here: the previous head
    // becomes `previousPin`, and the head before THAT is APPENDED to
    // `priorPins` rather than replacing what was already in it. The whole point
    // of the drift record is that a pin move leaves a trail, so the assertions
    // walk the WHOLE trail rather than only checking the head — a move that
    // dropped an older pin on its way past would still satisfy a head-only
    // check.
    // The approved revision governs both drawings; the canonical parser keeps
    // the immutable revision and exact sibling set strict.
    expect(parseSpecCommit(m.specCommit)).toEqual({
      revision: "06230d4e8de397e86e3216199342d15c0b4fc5a6",
      paths: ["specs/app-lifecycle-cards.html", "specs/app-artifact-review.html"],
    });
    // The displaced pin governed both drawings, so it is recorded with both:
    // the canonical parser reads it exactly as it read the pin when it stood.
    // It is the pin the main line stood at before the move, not a revision the
    // move passed through on its own branch.
    expect(parseSpecCommit(m.specCommitDrift.previousPin)).toEqual({
      revision: "bc0c04e4ee4cea4ae177355ee438896ca8ce9e0f",
      paths: ["specs/app-lifecycle-cards.html", "specs/app-artifact-review.html"],
    });
    // The move took two steps on a branch that was squashed into one commit, so
    // the main line never stood at the intermediate revision: it is no pin of
    // the trail.
    expect(
      [m.specCommit, m.specCommitDrift.previousPin, ...m.specCommitDrift.priorPins].join("\n"),
    ).not.toContain("46b2d8bc642cfcebc20477872fb47132e1bcd795");
    for (const prior of [
      "6c20871b4108176c1d0193f19ecd2947f6c6355f",
      "92c1be7c6f864dec6382a9ef01e7b2e1c38aa871",
      "71398a49c1f8adfe6176ab0dda25486920fac958",
      "fe2182547d4a98125a0968824ffb0d45fb25a8e5",
      "458fb7ffce6cf4ab6a2c60d3ff47198135d8ea2f",
      "38f3635b83c34a30d2a8fe76fcbba8e4f5fbb978",
      "a9f9ad01a0b80fa6400396e91605270730f47802",
      "1836b4f996d8ed157d5d837b630a6c2443f966dd",
      "99e6977ca1443c5ec8a92b90f9a64a04c84364c7",
      "b3665f8f308f32138f47f59ca490684c526c1e89",
      "831df38088ec969c7392018e79b297a49ee935a2",
      "8a5d5013fdcb92af5508d61e997cd43564000de3",
    ]) {
      expect(m.specCommitDrift.priorPins.join("\n"), prior).toContain(prior);
    }
    // Nothing on the trail repeats: a pin that appears twice is a record that
    // lost track of which move it belongs to.
    const trail = [m.specCommit, m.specCommitDrift.previousPin, ...m.specCommitDrift.priorPins];
    const commits = trail.map((entry) => entry.slice("design@".length, "design@".length + 40));
    expect(new Set(commits).size, trail.join("\n")).toBe(commits.length);
    // The trail is a TRAIL: the entries stand in the order they stood in, oldest
    // first, each labelled with the date it stopped standing. A membership check
    // alone would pass a record that put a displaced pin in front of a pin it
    // outlived, and a reader walking such a trail would read the moves in the
    // wrong order.
    const untilDates = m.specCommitDrift.priorPins.map((entry) => {
      const match = /\(until (\d{4}-\d{2}-\d{2})\)$/.exec(entry);
      expect(match, entry).not.toBeNull();
      return match[1];
    });
    expect(untilDates, m.specCommitDrift.priorPins.join("\n")).toStrictEqual([...untilDates].sort());
    // The pin before the displaced one is the one that stood LAST before it, so
    // it is the tail of the trail and not an insertion into the middle of it.
    expect(m.specCommitDrift.priorPins.at(-1)).toContain("8a5d5013fdcb92af5508d61e997cd43564000de3");
    // The appended entry keeps the one drawing it governed, read by the
    // canonical parser once its date label is taken off.
    expect(
      parseSpecCommit(m.specCommitDrift.priorPins.at(-1).replace(/ \(until \d{4}-\d{2}-\d{2}\)$/, "")),
    ).toEqual({
      revision: "8a5d5013fdcb92af5508d61e997cd43564000de3",
      paths: ["specs/app-lifecycle-cards.html"],
    });
    expect(m.specCommitDrift.priorPins.at(-1)).toMatch(/\(until 2026-10-21\)$/);
    expect(m.specCommitDrift.movedOn).toBe("2026-10-23");
    // No pin is ever its own predecessor: a "move" that recorded the same commit
    // on both sides would satisfy every check above and record nothing.
    expect(m.specCommitDrift.previousPin).not.toBe(m.specCommit);
    expect(m.specCommitDrift.why.length).toBeGreaterThan(60);
    // The move says what CHANGED between the two documents, not merely that one
    // happened, and it does not claim an approval it cannot see.
    expect(m.specCommitDrift.differs.length).toBeGreaterThan(120);
    // Each of the two governed drawings was ratified by its own revision.
    expect(m.specCommitDrift.whoRatified).toMatch(/ratified on 2026-10-21/);
    expect(m.specCommitDrift.whoRatified).toMatch(/ratified on 2026-10-22/);
    // The added section's six examples are named, in the drift record and in
    // the contract's re-ratification entry, and both say that no recorded
    // anchor changed rather than leaving a reader to infer it.
    const contractNote = JSON.parse(
      readFileSync(join(REPO_ROOT, "scripts", "audit", "chat-hitl-anchor-contract.json"), "utf8"),
    ).note;
    for (const surface of [
      "schedule-card-recurrence-first-shown",
      "schedule-card-recurrence-configured",
      "schedule-card-recurrence-restricted",
      "schedule-card-recurrence-expired",
      "schedule-card-recurrence-fired-recurring",
      "schedule-card-recurrence-stopped",
    ]) {
      expect(m.specCommitDrift.differs, surface).toContain(surface);
      expect(contractNote, surface).toContain(surface);
    }
    expect(m.specCommitDrift.differs).toMatch(/No recorded anchor changed/);
    expect(contractNote).toMatch(/RE-RATIFIED 2026-10-23 \(cinatra#4308[^]*NO RECORDED ANCHOR CHANGED/);
    // The earlier entry stays on file: an adoption appends to the note, it never
    // rewrites what an earlier re-examination recorded. Its five examples are in
    // the range from the previous pin, so the drift record names them too.
    for (const surface of [
      "email-gate-sender-field",
      "email-gate-follow-up-cadence-field",
      "email-gate-drafts-review-field",
      "email-gate-recipients-review-field",
      "email-gate-test-delivery-field",
    ]) {
      expect(m.specCommitDrift.differs, surface).toContain(surface);
      expect(contractNote, surface).toContain(surface);
    }
    expect(contractNote).toMatch(/RE-RATIFIED 2026-10-22 \(cinatra#4308[^]*NO RECORDED ANCHOR CHANGED/);
    // The controls drawn inside those five examples carry twelve `data-action`
    // attributes of their own. The contract records the bare capture selector
    // `[data-action]`, which names no value and so reads every one of them: the
    // drift record names that selector, and claims only that no recorded
    // selector names their values, never that no recorded selector reads them.
    const recordedCaptureSelectors = new Set(
      Object.values(captureAnchorExpectations())
        .flatMap((cells) => Object.values(cells).flat())
        .map((claim) => claim.split(" ")[0]),
    );
    expect(recordedCaptureSelectors.has("[data-action]")).toBe(true);
    expect(m.specCommitDrift.differs).toContain("the bare capture selector `[data-action]`");
    expect(m.specCommitDrift.differs).not.toMatch(/none of them is a selector the anchor contract records/);
  });

  it("row 15 keeps the proofs it had — a flip withdraws a claim, not evidence", () => {
    const row = manifest().rows[14];
    expect(row.disposition, row.criterion.slice(0, 40)).toBe("MISSING");
    expect(row.partial).toBe(true);
    expect(proofsOf(row).length, row.criterion.slice(0, 40)).toBeGreaterThan(0);
    expect(row.gap.length).toBeGreaterThan(200);
  });

  it("row 3 is MAPPED and partial: every transaction proof stands, and the withdrawn picture proofs are named in its gap", () => {
    // The mirror of the test above, and the rule holds in both directions: no
    // proof already earned is thrown away. The transaction proofs cinatra#2573's
    // acceptance round wrote are untouched below — mint/consume identity,
    // arm-before-expose, single-use, replay, the concurrent double-Confirm and
    // drain reconciliation. cinatra#2788 (PR #2939) added ten S9d picture
    // proofs beside them. cinatra#4390 (2026-10-27) gave the card's Confirm
    // the value the drawing names; the ten records counted the earlier value
    // and never observed the drawn one, so the capture contract no longer
    // accepts them and they are withdrawn, from the index and from this row.
    // The row says so in `partial` and `gap` rather than rounding itself up.
    const row = manifest().rows[2];
    expect(row.disposition).toBe("MAPPED");
    expect(row.partial).toBe(true);
    expect(row.gap).toMatch(/cinatra#4390/);
    expect(row.gap).toContain('[data-action="confirm-schedule -> scheduled"]');
    expect(row.gap).toMatch(/re-shoot/);
    expect(row.unitProofs).toHaveLength(3);
    expect(row.integrationProofs).toHaveLength(6);
    // No picture proof is cited until the re-shoot lands: a citation of a
    // withdrawn record is the unindexed screenshot the binding refuses.
    expect(row.e2eProofs).toBeUndefined();
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


// ---------------------------------------------------------------------------
// EVERY READER OVERRIDE IS GATED BY THE ONE FLAG. `proofExists` and
// `auditManifest` took reader overrides that were honoured merely for being
// passed — the last place in this module where supplying a function replaced
// the source of truth without asking for a virtual filesystem.
// ---------------------------------------------------------------------------
describe("an injected document reader is honoured only under the flag", () => {
  // `package.json` really exists and really does NOT contain this string, so a
  // reader that vouches for it is vouching for something untrue.
  const CELL = "ZZZ__review-card__chat_thread__pending.png";
  const proof = { file: "package.json", testName: CELL };
  const vouchingReader = () => `a document that mentions ${CELL} and nothing else`;

  it("WITHOUT the flag the override is dropped and the lexical check reads the real file", () => {
    const found = proofExists(proof, REPO_ROOT, vouchingReader);
    expect(found.ok).toBe(false);
    expect(found.reason).toBe(`no "${CELL}" in package.json`);
  });

  it("WITH the flag the suite's reader is honoured, as designed", () => {
    expect(proofExists(proof, REPO_ROOT, vouchingReader, null, true)).toEqual({ ok: true });
  });

  it("the real file still answers honestly for something it DOES contain", () => {
    expect(proofExists({ file: "package.json", testName: '"name"' }, REPO_ROOT).ok).toBe(true);
  });

  it("auditManifest passes the flag through — a vouching reader is ignored without it", () => {
    const manifest = {
      rows: [
        {
          criterion: CANONICAL_CRITERIA[0],
          disposition: "BUILT",
          unitProofs: [{ file: "package.json", testName: CELL }],
        },
      ],
    };
    const ignored = auditManifest({ manifest, repoRoot: REPO_ROOT, readFileImpl: vouchingReader });
    expect(ignored.some((v) => v.includes(`no "${CELL}" in package.json`))).toBe(true);
    const honoured = auditManifest({
      manifest,
      repoRoot: REPO_ROOT,
      readFileImpl: vouchingReader,
      virtualFilesystem: true,
    });
    expect(honoured.some((v) => v.includes(`no "${CELL}"`))).toBe(false);
  });
});
