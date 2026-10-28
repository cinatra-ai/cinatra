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

import {
  CAPTURE_HOSTS,
  CAPTURE_INDEX_PATH,
  CARD_KINDS,
  captureHostAdmissibility,
  captureStatesFor,
} from "../../ci/lib/capture-record-contract.mjs";
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

// One re-ratification entry of the anchor contract's note: from its own head
// (for example "RE-RATIFIED 2026-10-23 (cinatra#4308") up to the head of the
// next entry, or to the end of the note. An assertion about one entry reads
// only that entry, so a later entry that repeats a phrase cannot satisfy it.
const NOTE_ENTRY_HEAD = /RE-RATIFIED (?:AGAIN )?\d{4}-\d{2}-\d{2} \(/g;
function noteEntry(note, head) {
  const start = note.indexOf(head);
  if (start === -1) return "";
  NOTE_ENTRY_HEAD.lastIndex = start + head.length;
  const next = NOTE_ENTRY_HEAD.exec(note);
  return note.slice(start, next ? next.index : note.length);
}

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

// ---------------------------------------------------------------------------
// ROW 15'S CENSUS, READ WHOLE. Row 15's gap says its census is COUNTED, not
// recited, off the capture index, and strict mode prints it. A reader that
// picks out only the counts it recognises lets a stale number stand beside a
// true one, so this one reads the census sentence from end to end and refuses
// whatever it cannot read: a bucket stated twice, a bucket left out, a host or
// a state the capture vocabulary does not have, and any text after a count.
// The bucket set is the vocabulary's own (every kind x every host it may be
// photographed on x every state it resolves), not the set the index happens
// to hold. Clauses (a), (c) and (d) are held WHOLE, word for word, with each
// count in them taken from the index (or, for the walk's cells, from the walk
// plan): a reader that looks for numbers in prose misses the number forms it
// does not know ("dozen", "thousand", Roman numerals, non-ASCII digits), so
// none is looked for. Clauses (b) and (e) are not read here, except that
// clause (d)'s pair of counts, in any decimal digits, must be in the whole gap
// exactly once. It returns its problems instead of asserting, so each mutant
// below is held to it on its own.
// ---------------------------------------------------------------------------
const NUMBER_WORDS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen",
  "nineteen", "twenty",
];
const numberWord = (n) => (n <= 20 ? NUMBER_WORDS[n] : String(n));
// The two hosts the census calls "the two page hosts".
const PAGE_HOSTS = ["site_widget", "page_gate_region"];
const CENSUS_OPEN = "per kind x host x state: ";
const CENSUS_CLOSE = " STILL ABSENT, with the exact obstacle: ";
// `\p{Nd}` is every decimal digit Unicode has, so a pair written in other digits is still counted.
const CLAUSE_D_PAIR =
  /chat_thread (\p{Nd}+) pending \/ (\p{Nd}+) decided, site_widget (\p{Nd}+) pending \/ (\p{Nd}+) decided/gu;
// The whole text of clauses (a), (c) and (d), each up to the next clause's "(x) " and with its trailing space; every
// count is a parameter, taken from the index or the walk plan by the reader below.
const CLAUSE_TEXT = {
  a: ({ schedule, walkCells }) =>
    `(a) trigger_schedule_proposal on every host in every state — ${schedule} records. The card is drawn and ` +
    "dispatched on main (packages/chat/src/renderable-views/registry.tsx maps the kind to ScheduleProposalCard, " +
    `cinatra#2788), so what is owed here is the picture, not the card. The ${walkCells} records of the S9d rework ` +
    "walk on chat_thread and run_card counted the card's earlier Confirm value, not the " +
    '`[data-action="confirm-schedule -> scheduled"]` that §VI draws, and were withdrawn on 2026-10-27; their ' +
    "re-shoot is the open item of cinatra#4390 (row 3's gap). site_widget and page_gate_region in every state, and " +
    "the run_card PENDING reading, had no record before that either. ",
  c: ({ siteDecided, runDecided, pageDecided }) =>
    `(c) artifact_review_gate DECIDED on site_widget — ${siteDecided} records. The run_card DECIDED reading is ` +
    `answered by ${runDecided} records (cinatra#2936 W6 part 2b batch 2), and the settled card on ` +
    `page_gate_region is DELIVERED, ${pageDecided} records, so the route no longer blocks before the card mounts. ` +
    "On site_widget a real widget-started run opened its review gate and the widget drew no review card, live or " +
    "after a reload (cinatra#2936 W6 part 2b batch 3, recorded in the census ratchet of " +
    "scripts/ci/__tests__/capture-record-contract.test.mjs). ",
  d: ([chatPending, chatDecided, widgetPending, widgetDecided]) =>
    "(d) recommendation_hold — the 'RATCHETED AS OWED … those cells must NOT be observed yet' this clause carried " +
    "is WITHDRAWN: both mounts landed (cinatra#2786 S9b for chat_thread, cinatra#2790/#2890 S9f for site_widget) " +
    `and both are photographed in both states (chat_thread ${chatPending} pending / ${chatDecided} decided, ` +
    `site_widget ${widgetPending} pending / ${widgetDecided} decided). What is absent on this kind is the PENDING ` +
    "reading on page_gate_region, which carries decided records only. ",
};

function row15CensusProblems(gap, index, walkPlan) {
  const problems = [];
  const actual = {};
  const cells = {};
  for (const r of index.records) {
    const k = `${r.declaredKind} | ${r.declaredHost} | ${r.declaredState}`;
    actual[k] = (actual[k] ?? 0) + 1;
    (cells[k] ??= []).push(r.cell);
  }
  const count = (k) => actual[k] ?? 0;

  const totals = [...gap.matchAll(/\(scripts\/ci\/chat-hitl-capture-index\.json, (\d+) records\)/g)];
  if (totals.length !== 1) problems.push(`the record total is stated ${totals.length} times, not once`);
  else if (Number(totals[0][1]) !== index.records.length) {
    problems.push(`the record total says ${totals[0][1]}; the index holds ${index.records.length}`);
  }

  const opened = gap.split(CENSUS_OPEN);
  const closed = gap.split(CENSUS_CLOSE);
  if (opened.length !== 2 || closed.length !== 2) {
    problems.push("the census sentence and the STILL ABSENT list are not each there exactly once");
    return problems;
  }
  const census = opened[1].slice(0, opened[1].indexOf(CENSUS_CLOSE));
  if (!census.endsWith(".")) problems.push(`the census sentence does not end with a full stop: "${census.slice(-40)}"`);

  // --- the census, every item consumed -------------------------------------------------------------------------
  const stated = new Map();
  const compositionOnly = {};
  const kinds = [];
  const put = (kind, host, state, n) => {
    if (!CAPTURE_HOSTS.includes(host)) return problems.push(`${kind}: "${host}" is not a capture host`);
    if (!captureStatesFor(kind).includes(state)) return problems.push(`${kind}: "${state}" is not a state it resolves`);
    if (!captureHostAdmissibility(kind, host).capturable) {
      return problems.push(`${kind} | ${host} is composition-only, and the census gives it a count`);
    }
    const k = `${kind} | ${host} | ${state}`;
    if (stated.has(k)) return problems.push(`${k} is stated twice`);
    stated.set(k, n);
  };
  for (const clause of census.replace(/\.$/, "").split("; ")) {
    const head = clause.match(/^([a-z_]+) — /);
    if (!head || !Object.hasOwn(CARD_KINDS, head[1])) {
      problems.push(`a census clause names no card kind: "${clause.slice(0, 50)}"`);
      continue;
    }
    const kind = head[1];
    if (kinds.includes(kind)) problems.push(`${kind} has two census clauses`);
    kinds.push(kind);
    let readingState = null;
    const items = [
      [/^(\w+) pending (\d+) \/ decided (\d+)/, (m) => {
        put(kind, m[1], "pending", Number(m[2]));
        put(kind, m[1], "decided", Number(m[3]));
      }],
      [/^none on (\w+)/, (m) => captureStatesFor(kind).forEach((s) => put(kind, m[1], s, 0))],
      [/^(\w+) none/, (m) => captureStatesFor(kind).forEach((s) => put(kind, m[1], s, 0))],
      [/^(?:and|(\w+)) on (\w+) (\d+) \(([A-Z]\d+)\)/, (m) => {
        if (m[1]) readingState = m[1];
        if (!readingState) return problems.push(`${kind}: "${m[0]}" names no state`);
        put(kind, m[2], readingState, Number(m[3]));
        const k = `${kind} | ${m[2]} | ${readingState}`;
        if (!(cells[k] ?? []).length || !cells[k].every((c) => c.startsWith(`${m[4]}__`))) {
          problems.push(`${k}: the label (${m[4]}) is not the group of its records`);
        }
      }],
      [/^and the two page hosts recorded as composition-only with their reasons/, () => {
        compositionOnly[kind] = [...PAGE_HOSTS];
      }],
    ];
    let rest = clause.slice(head[0].length);
    while (rest.length) {
      const hit = items.map(([re, take]) => [rest.match(re), take]).find(([m]) => m);
      if (!hit) {
        problems.push(`${kind}: text the census does not read: "${rest.slice(0, 50)}"`);
        break;
      }
      hit[1](hit[0]);
      rest = rest.slice(hit[0][0].length);
      if (!rest.length) break;
      const sep = rest.match(/^(?:, | (?=and ))/);
      if (!sep) {
        problems.push(`${kind}: text after "${hit[0][0]}": "${rest.slice(0, 50)}"`);
        break;
      }
      rest = rest.slice(sep[0].length);
      if (!rest.length) problems.push(`${kind}: a separator after "${hit[0][0]}" leads to no item`);
    }
  }
  for (const kind of Object.keys(CARD_KINDS)) {
    const unreachable = CAPTURE_HOSTS.filter((h) => !captureHostAdmissibility(kind, h).capturable);
    if (String(compositionOnly[kind] ?? []) !== String(unreachable)) {
      problems.push(`${kind}: the census names [${compositionOnly[kind] ?? []}] composition-only; the contract, [${unreachable}]`);
    }
    for (const host of CAPTURE_HOSTS.filter((h) => !unreachable.includes(h))) {
      for (const state of captureStatesFor(kind)) {
        const k = `${kind} | ${host} | ${state}`;
        if (!stated.has(k)) problems.push(`${k} is left out of the census`);
        else if (stated.get(k) !== count(k)) problems.push(`${k}: the census says ${stated.get(k)}, the index holds ${count(k)}`);
      }
    }
  }
  for (const k of Object.keys(actual)) {
    if (!stated.has(k)) problems.push(`${k}: the index holds ${actual[k]} records the census has no bucket for`);
  }

  // --- the clauses, (a) to (e) once each and in order ------------------------------------------------------------
  const absent = closed[1];
  const at = [..."abcde"].map((l) => absent.split(`(${l}) `).length === 2 ? absent.indexOf(`(${l}) `) : -1);
  if (at.includes(-1) || at.some((p, i) => i && p < at[i - 1])) {
    problems.push(`clauses (a) to (e) are not each there once and in order: ${at}`);
    return problems;
  }
  const clause = (l) => {
    const i = "abcde".indexOf(l);
    return absent.slice(at[i], at[i + 1] ?? absent.length);
  };
  const held = (l, want) => {
    const got = clause(l);
    if (got === want) return;
    let i = 0;
    while (got[i] === want[i]) i += 1;
    problems.push(`clause (${l}) is not its text: at ${i} it reads "${got.slice(i, i + 40)}", not "${want.slice(i, i + 40)}"`);
  };
  const ARG = "artifact_review_gate";
  const HOLD = "recommendation_hold";
  const schedule = Object.keys(actual)
    .filter((k) => k.startsWith("trigger_schedule_proposal | "))
    .reduce((n, k) => n + actual[k], 0);
  const walkCells = walkPlan.steps.flatMap((s) => s.cells ?? []).length;
  held("a", CLAUSE_TEXT.a({ schedule: numberWord(schedule), walkCells: numberWord(walkCells) }));
  held("c", CLAUSE_TEXT.c({
    siteDecided: numberWord(count(`${ARG} | site_widget | decided`)),
    runDecided: numberWord(count(`${ARG} | run_card | decided`)),
    pageDecided: numberWord(count(`${ARG} | page_gate_region | decided`)),
  }));
  const holdCounts = ["chat_thread | pending", "chat_thread | decided", "site_widget | pending", "site_widget | decided"]
    .map((hs) => String(count(`${HOLD} | ${hs}`)));
  held("d", CLAUSE_TEXT.d(holdCounts));
  const pairs = [...gap.matchAll(CLAUSE_D_PAIR)];
  if (pairs.length !== 1) problems.push(`clause (d)'s pair of counts is stated ${pairs.length} times, not once`);
  else if (String(pairs[0].slice(1)) !== String(holdCounts)) {
    problems.push(`clause (d)'s counts are ${pairs[0].slice(1)}; the index holds ${holdCounts}`);
  }
  if (/records are in the index/.test(gap)) problems.push(`the gap still says "records are in the index"`);
  return problems;
}

// Each mutant puts a stale number into the gap in a form the pre-2 review of
// cinatra#4392 found the earlier reader passing (the ninth and the eighth it
// already refused), and the last five in a form the pre-3 review found the
// next reader passing: a number word it did not know ("dozen") in clauses (a),
// (c) and (d), a second clause (d) pair in non-ASCII digits, and a census
// separator that leads to no item. Each returns the mutated gap, or null when
// its anchor is not in the gap exactly once: then the census has moved and the
// mutant must be re-aimed.
const once = (re, to) => (gap) => {
  const all = gap.match(new RegExp(re.source, "g")) ?? [];
  return all.length === 1 ? gap.replace(re, to) : null;
};
const first = (re, to) => (gap) => (re.test(gap) ? gap.replace(re, to) : null);
const ROW15_MUTANTS = [
  ["a stale bucket stated before the true one",
    once(/recommendation_hold — (\w+) pending (\d+) \/ decided (\d+)/,
      (m, h, p, d) => `recommendation_hold — ${h} pending ${Number(p) + 2} / decided ${Number(d) + 2}, ${h} pending ${p} / decided ${d}`)],
  ["a zero bucket left out", once(/, run_card none(?=,)/, "")],
  ["a zero bucket under a misspelled host", once(/\bsite_widget none\b/, "site_wdiget none")],
  ["a stale count after a bucket", once(/\bchat_thread none(?=,)/, "chat_thread none (4 records remain)")],
  ["a second, stale clause (d) pair",
    once(/(chat_thread \d+ pending \/ \d+ decided, site_widget \d+ pending \/ \d+ decided)\)/,
      "$1) (was chat_thread 5 pending / 4 decided, site_widget 5 pending / 2 decided)")],
  ["a stale count in clause (a)", once(/\bThe (\w+) records of the S9d rework walk/, "The twelve records of the S9d rework walk")],
  ["a stale count in clause (c)",
    once(/answered by (\w+) records/, (m, w) => `answered by ${w === "two" ? "three" : "two"} records`)],
  ["a stale record total",
    once(/(chat-hitl-capture-index\.json, )(\d+)( records\))/, (m, a, n, b) => `${a}${Number(n) - 1}${b}`)],
  ["one census count moved by one",
    first(/(run_card pending \d+ \/ decided )(\d+)/, (m, a, n) => `${a}${Number(n) + 1}`)],
  ["a dozen-fold count in clause (a)",
    once(/\bThe (\w+) records of the S9d rework walk/, (m, w) => `The ${w} dozen records of the S9d rework walk`)],
  ["a dozen-fold count in clause (c)", once(/answered by (\w+) records/, (m, w) => `answered by ${w} dozen records`)],
  ["older records added after clause (d)'s pair",
    once(/(site_widget \d+ pending \/ \d+ decided\))/, "$1 plus a dozen older records")],
  ["a second clause (d) pair in non-ASCII digits",
    once(/does not re-open them\.$/,
      "does not re-open them. Before: chat_thread ٥ pending / ٤ decided, site_widget ٥ pending / ٢ decided.")],
  ["a census separator that leads to no item",
    once(/(page_gate_region pending \d+ \/ decided \d+)(; recommendation_hold)/, "$1, $2")],
];

const captureIndex = () => JSON.parse(readFileSync(CAPTURE_INDEX_PATH, "utf8"));
const walkPlan = () =>
  JSON.parse(
    readFileSync(join(REPO_ROOT, "scripts", "audit", "__fixtures__", "capture-walk", "s9d-rework-walk-plan.json"), "utf8"),
  );

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
    // Row 15's gap no longer says that trigger_schedule_proposal "is NOT DRAWN
    // on main". Item (a) of its STILL ABSENT list now says that the obstacle it
    // used to name is gone (the card is drawn and dispatched on main) and that
    // what is owed is the picture. The row stays MISSING because it asks for the
    // S0 spec-matrix capture sweep, a different round's work. This suite pins
    // only that the false sentence does not come back.
    expect(manifest().rows[14].gap).not.toMatch(/is NOT DRAWN on main/);
    // The line the CLI would print, spelled out here so a regression in either
    // count is still legible as the sentence a reader sees.
    expect(`${total - unproven.length}/${total} criteria proven, ${unproven.length} MISSING, ${partial.length} partial`).toBe(
      "15/16 criteria proven, 1 MISSING, 2 partial",
    );
  });

  it("the design pin is the ratified drawing, and the drift is recorded rather than overwritten", () => {
    const m = manifest();
    // The pin was adopted onto the newest revision of the drawings' main line
    // that touches a governed drawing, taking in the three ratifications of
    // governed drawings it had not adopted. Every pin the rows
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
      revision: "67ecd66da3e6a83d27a0d8c5d777e98fc5309917",
      paths: ["specs/app-lifecycle-cards.html", "specs/app-artifact-review.html"],
    });
    // The displaced pin governed both drawings, so it is recorded with both:
    // the canonical parser reads it exactly as it read the pin when it stood.
    // It is the pin the main line stood at before the move.
    expect(parseSpecCommit(m.specCommitDrift.previousPin)).toEqual({
      revision: "06230d4e8de397e86e3216199342d15c0b4fc5a6",
      paths: ["specs/app-lifecycle-cards.html", "specs/app-artifact-review.html"],
    });
    // An earlier move took two steps on a branch that was squashed into one
    // commit, so the main line never stood at the intermediate revision: it is
    // no pin of the trail.
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
      "bc0c04e4ee4cea4ae177355ee438896ca8ce9e0f",
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
    // It governed both drawings, and the canonical parser reads it with both
    // once its date label is taken off.
    const undated = (entry) => entry.replace(/ \(until \d{4}-\d{2}-\d{2}\)$/, "");
    expect(m.specCommitDrift.priorPins.at(-1)).toContain("bc0c04e4ee4cea4ae177355ee438896ca8ce9e0f");
    expect(parseSpecCommit(undated(m.specCommitDrift.priorPins.at(-1)))).toEqual({
      revision: "bc0c04e4ee4cea4ae177355ee438896ca8ce9e0f",
      paths: ["specs/app-lifecycle-cards.html", "specs/app-artifact-review.html"],
    });
    expect(m.specCommitDrift.priorPins.at(-1)).toMatch(/\(until 2026-10-23\)$/);
    // The entry before it keeps the one drawing it governed: appending never
    // rewrites what is already on the trail.
    expect(parseSpecCommit(undated(m.specCommitDrift.priorPins.at(-2)))).toEqual({
      revision: "8a5d5013fdcb92af5508d61e997cd43564000de3",
      paths: ["specs/app-lifecycle-cards.html"],
    });
    expect(m.specCommitDrift.priorPins.at(-2)).toMatch(/\(until 2026-10-21\)$/);
    expect(m.specCommitDrift.movedOn).toBe("2026-10-27");
    // No pin is ever its own predecessor: a "move" that recorded the same commit
    // on both sides would satisfy every check above and record nothing.
    expect(m.specCommitDrift.previousPin).not.toBe(m.specCommit);
    expect(m.specCommitDrift.why.length).toBeGreaterThan(60);
    // The move says what CHANGED between the two documents, not merely that one
    // happened, and it does not claim an approval it cannot see.
    expect(m.specCommitDrift.differs.length).toBeGreaterThan(120);
    // Each of the three revisions that touch a governed drawing was ratified by
    // its own commit, all on the same day, and each is named.
    expect(m.specCommitDrift.whoRatified).toMatch(/ratified on 2026-10-27/);
    for (const ratification of [
      "bd905e698872d7b9632929135b82cd279b117453",
      "b21087727312db41e64230c4e50d90cb17703b67",
    ]) {
      expect(m.specCommitDrift.whoRatified, ratification).toContain(ratification);
    }
    // The added section's two cards are named, in the drift record and in the
    // contract's re-ratification entry, and both say that no recorded anchor
    // changed rather than leaving a reader to infer it.
    const contractNote = JSON.parse(
      readFileSync(join(REPO_ROOT, "scripts", "audit", "chat-hitl-anchor-contract.json"), "utf8"),
    ).note;
    for (const surface of ["embed-signin-first", "embed-signin-again"]) {
      expect(m.specCommitDrift.differs, surface).toContain(surface);
      expect(contractNote, surface).toContain(surface);
    }
    expect(m.specCommitDrift.differs).toMatch(/No recorded anchor changed/);
    const entry1027 = noteEntry(contractNote, "RE-RATIFIED 2026-10-27 (cinatra#4386");
    expect(entry1027).toMatch(/NO RECORDED ANCHOR CHANGED/);
    // The quarter and year interval boxes removed in §VI carry `style`, and
    // eight of them `role="combobox"` and an `svg` chevron, but no `data-*`
    // attribute. Both records say exactly that: no recorded anchor attribute
    // and no data attribute moves. Neither claims that no attribute moves.
    for (const [where, text] of [
      ["differs", m.specCommitDrift.differs],
      ["the 2026-10-27 note entry", entry1027],
    ]) {
      expect(text, where).not.toMatch(/adds or removes no attribute/);
      expect(text, where).toContain("none carries a `data-*` attribute");
      expect(text, where).toContain("adds or removes no recorded anchor attribute and no data attribute");
    }
    // An adoption APPENDS its entry to the note: the newest entry stands last.
    expect(contractNote.lastIndexOf("RE-RATIFIED 2026-10-27 (cinatra#4386")).toBeGreaterThan(
      contractNote.lastIndexOf("RE-RATIFIED 2026-10-23 (cinatra#4308"),
    );
    // The earlier entries stay on file: an adoption appends to the note, it
    // never rewrites what an earlier re-examination recorded.
    for (const surface of [
      "schedule-card-recurrence-first-shown",
      "schedule-card-recurrence-configured",
      "schedule-card-recurrence-restricted",
      "schedule-card-recurrence-expired",
      "schedule-card-recurrence-fired-recurring",
      "schedule-card-recurrence-stopped",
    ]) {
      expect(contractNote, surface).toContain(surface);
    }
    expect(noteEntry(contractNote, "RE-RATIFIED 2026-10-23 (cinatra#4308")).toMatch(/NO RECORDED ANCHOR CHANGED/);
    for (const surface of [
      "email-gate-sender-field",
      "email-gate-follow-up-cadence-field",
      "email-gate-drafts-review-field",
      "email-gate-recipients-review-field",
      "email-gate-test-delivery-field",
    ]) {
      expect(contractNote, surface).toContain(surface);
    }
    expect(noteEntry(contractNote, "RE-RATIFIED 2026-10-22 (cinatra#4308")).toMatch(/NO RECORDED ANCHOR CHANGED/);
    // The mutants: each earlier entry that loses the phrase must fail its own
    // check, although later entries still carry it. The unbounded form the
    // checks above replaced, `<head>[^]*NO RECORDED ANCHOR CHANGED`, still
    // passes on each mutant, which is why the checks read one entry only.
    for (const head of ["RE-RATIFIED 2026-10-22 (cinatra#4308", "RE-RATIFIED 2026-10-23 (cinatra#4308"]) {
      const entry = noteEntry(contractNote, head);
      const mutant = contractNote.replace(entry, entry.replaceAll("NO RECORDED ANCHOR CHANGED", "(phrase removed)"));
      expect(mutant, head).not.toBe(contractNote);
      expect(noteEntry(mutant, head), head).not.toMatch(/NO RECORDED ANCHOR CHANGED/);
      expect(mutant.slice(mutant.indexOf(head)), head).toMatch(/NO RECORDED ANCHOR CHANGED/);
    }
    // The two Sign in buttons of the added section carry a `data-action` of
    // their own. The contract records the bare capture selector `[data-action]`,
    // which names no value and so reads both of them: the drift record names
    // that selector and the value, and claims only that no recorded selector
    // names the value, never that no recorded selector reads the buttons.
    const recordedCaptureSelectors = new Set(
      Object.values(captureAnchorExpectations())
        .flatMap((cells) => Object.values(cells).flat())
        .map((claim) => claim.split(" ")[0]),
    );
    expect(recordedCaptureSelectors.has("[data-action]")).toBe(true);
    expect(m.specCommitDrift.differs).toContain("the bare capture selector `[data-action]`");
    expect(m.specCommitDrift.differs).toContain("start-sign-in -> sign-in-window-opened");
    expect(m.specCommitDrift.differs).toMatch(/no recorded selector names their value/);
  });

  it("row 15 keeps the proofs it had — a flip withdraws a claim, not evidence", () => {
    const row = manifest().rows[14];
    expect(row.disposition, row.criterion.slice(0, 40)).toBe("MISSING");
    expect(row.partial).toBe(true);
    expect(proofsOf(row).length, row.criterion.slice(0, 40)).toBeGreaterThan(0);
    expect(row.gap.length).toBeGreaterThan(200);
  });

  it("row 15's census is the capture index's census, count for count", () => {
    // The gap says its census is COUNTED, not recited, and strict mode prints
    // it. cinatra#4390 (2026-10-27) withdrew ten schedule records and the gap
    // went on counting them, beside counts of an index of 93 records. The
    // reader above holds the whole census sentence and the whole text of
    // clauses (a), (c) and (d) to the index as it stands.
    expect(row15CensusProblems(manifest().rows[14].gap, captureIndex(), walkPlan())).toEqual([]);
  });

  it.each(ROW15_MUTANTS)("row 15's census reader refuses %s", (name, mutate) => {
    // A reader is only as good as the stale numbers it refuses (pre-2 of
    // cinatra#4392 found seven forms the earlier reader passed, pre-3 five
    // more that the next one passed).
    const gap = manifest().rows[14].gap;
    const mutated = mutate(gap);
    expect(mutated, `${name}: the anchor is not in the gap exactly once; re-aim the mutant`).not.toBeNull();
    expect(mutated).not.toBe(gap);
    expect(row15CensusProblems(mutated, captureIndex(), walkPlan()), name).not.toEqual([]);
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
