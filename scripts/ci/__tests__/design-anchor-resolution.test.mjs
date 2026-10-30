// THE ANCHORS A CONTRACT REQUIRES MUST RESOLVE IN THE DRAWING IT CITES
// (cinatra#3144 G4).
//
// The anchor contract's digest binds three things and re-ratifies by hand. It
// hashes nothing from the drawings, so a contract can record an anchor that no
// drawing under its pin draws and stay green for ever. This check reads the
// drawings and says so.
//
// EVERY DRAWING IN THIS SUITE IS SYNTHETIC. The drawings themselves are not
// public and no byte of one is copied here: what these fixtures exercise is the
// MATCHER and the reporting, against markup written for that purpose. The real
// measurement is what the checker prints when it is run against a real copy
// with a credential, and the docs page says so.
//
// Organised by the six acceptance items of cinatra#3144 G4:
//
//   1. Every recorded anchor that resolves in NONE of the governed drawings is
//      reported per kind, and the check exits non-zero when any does not under
//      a red event (a pull request that touches no mapped path only warns,
//      unless a recorded `anchorsUnresolvedAtPin` disagrees).
//   2. An anchor resolving in a governed drawing other than the first is
//      RESOLVED; one resolving only in a drawing the pin does not govern is
//      UNRESOLVED, with that distinction stated.
//   3. A selector matched only inside prose or a code sample does not count.
//   4. An unsupported selector form is a HARD FAILURE, never a silent pass.
//   5. The printed output carries no drawing text beyond the selector.
//   6. The sibling binding suite and --print-anchor-digest still agree — held
//      here for the DIGEST SCHEMA half: `anchorsUnresolvedAtPin` is a fourth
//      digest input the moment it is recorded, and while it is absent the
//      recorded digest stands exactly where it stood. The contract now records
//      it, as the empty array.

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MANIFEST_PATH } from "../../audit/chat-hitl-acceptance-gate.mjs";
import {
  anchorDigestInputs,
  auditAnchorContract,
  captureAnchorExpectations,
  computeAnchorDigest,
  loadAnchorContract,
} from "../../audit/lib/anchor-contract.mjs";
import {
  UnsupportedSelectorError,
  attributeIndexOf,
  checkAnchorResolution,
  drawingIndexOf,
  collectRecordedAnchors,
  decide,
  formatReport,
  parseAnchorSelector,
  resolvesIn,
  runCli,
} from "../design-anchor-resolution.mjs";
import {
  ANCHOR_RESOLUTION_CHECKER_PATH,
  COMMIT_BEARING_PINS,
  DesignSourceError,
  GLOBAL_PATHS,
  loadGatePathMap,
  resolveTouchedPins,
} from "../lib/design-pin.mjs";


const manifest = () => JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
const contract = () => loadAnchorContract();

const A = "a".repeat(40);

const pin = (paths = ["specs/one.html"]) => ({
  id: "chat-hitl-lifecycle",
  authority: "scripts/audit/chat-hitl-acceptance-manifest.json",
  mirror: "scripts/audit/chat-hitl-anchor-contract.json",
  revision: A,
  paths,
});

/** A synthetic drawing that draws the given attribute selectors. */
const drawingWith = (...selectors) =>
  `<!doctype html><html><body>\n${selectors
    .map((s) => {
      const parsed = parseAnchorSelector(s);
      return parsed.value === null
        ? `<section ${parsed.attribute}>x</section>`
        : `<section ${parsed.attribute}="${parsed.value}">x</section>`;
    })
    .join("\n")}\n</body></html>`;

const anchor = (selector, kind = "artifact_review_gate", origin = "ownerAnchors") => ({
  kind,
  origin,
  selector,
});

// The decided passive capture markers. Visible cards, fields and controls are
// deliberately absent: they still need to resolve against a governed drawing.
const PASSIVE_CAPTURE_SELECTORS = [
  ".cw-frame",
  "[data-conversation-list]",
  '[data-embed-assistant][data-phase="active"]',
  '[data-lifecycle-card-host="chat_thread"]',
  '[data-lifecycle-card-host="page_gate_region"]',
  '[data-lifecycle-card-host="run_card"]',
  '[data-lifecycle-card-host="site_widget"]',
  "[data-lifecycle-card-state]",
  '[data-lifecycle-card="agent_hitl_screen"]',
  '[data-lifecycle-card="artifact_review_gate"]',
  '[data-lifecycle-card="recommendation_hold"]',
];

describe("serialized capture assertions retain selector and observation provenance", () => {
  const emptyDrawing = [{ path: "specs/one.html", text: "<main>empty</main>" }];
  const retired = ['[data-skill-action="confirm"]', '[data-skill-action="adjust"]', '[data-skill-action="skip"]'];
  const within = '[data-lifecycle-card="recommendation_hold"]';
  const captured = (entries, cell = "recommendation_hold|pending", host = "run_card") =>
    collectRecordedAnchors({ anchorContract: {}, captureAnchors: { [host]: { [cell]: entries } } });
  const checked = (anchors) => checkAnchorResolution({ pin: pin(), anchors, governed: emptyDrawing });

  it.each([
    ['[data-action="confirm-schedule -> scheduled"]', "trigger_schedule_proposal"],
    ['[data-action="continue -> selection-saved"]', "recommendation_hold"],
  ])("passes the intact quoted selector %s from the collector into the real matcher", (selector, kind) => {
    const anchors = captured([`${selector} root present [data-lifecycle-card="${kind}"] canonical`], `${kind}|pending`);
    expect(anchors.map((a) => a.selector)).toEqual([selector]);
    const report = checkAnchorResolution({ pin: pin(), anchors, governed: [{ path: "specs/one.html", text: drawingWith(selector) }] });
    expect(report.refused).toHaveLength(0);
    expect(report.results[0].status).toBe("resolved");
  });

  it("preserves all capture claims including different scope, state, host and polarity", () => {
    const selector = retired[0];
    const captureAnchors = {
      run_card: {
        "recommendation_hold|pending": [`${selector} root absent ${within} canonical`],
        "recommendation_hold|decided": [`${selector} frame present  audit`],
      },
      chat_thread: { "recommendation_hold|pending": [`${selector} root absent ${within} canonical`] },
    };
    const before = JSON.stringify(captureAnchors);
    const anchors = collectRecordedAnchors({ anchorContract: {}, captureAnchors });
    expect(anchors).toHaveLength(1);
    expect(anchors[0].captureAssertions).toEqual([
      { host: "run_card", cell: "recommendation_hold|pending", scope: "root", expect: "absent", within, tier: "canonical" },
      { host: "run_card", cell: "recommendation_hold|decided", scope: "frame", expect: "present", within: "", tier: "audit" },
      { host: "chat_thread", cell: "recommendation_hold|pending", scope: "root", expect: "absent", within, tier: "canonical" },
    ]);
    expect(JSON.stringify(captureAnchors)).toBe(before);
    const report = checked(anchors);
    expect(report.captureAbsences ?? []).toHaveLength(0);
    expect(report.unresolved.map((a) => a.selector)).toEqual([selector]);
  });

  // cinatra#3677: the live contract records none of the four controls that
  // kept this check red on main (the per-skill Confirm, Adjust and Skip, which
  // the drawing retired, and the schedule card's Confirm, whose floor the
  // drawing draws under another value) — in
  // either polarity, as an owner anchor, a drawing claim or a passive marker —
  // and the record of what is unresolved is empty.
  it("records none of an agent card's own controls as a drawing claim of the live contract", () => {
    const agentOwned = [...retired, '[data-action="confirm-schedule-proposal"]'];
    const captureAnchors = captureAnchorExpectations();
    const before = JSON.stringify(captureAnchors);
    const inputs = anchorDigestInputs({ specCommit: manifest().specCommit, domExpectations: contract().domExpectations, captureAnchors });
    const digestBefore = computeAnchorDigest(inputs);
    const anchors = collectRecordedAnchors({ anchorContract: contract(), captureAnchors });
    const report = checked(anchors);
    expect(anchors.filter((a) => agentOwned.includes(a.selector))).toEqual([]);
    expect(report.results.filter((a) => agentOwned.includes(a.selector))).toEqual([]);
    expect(report.unresolved.filter((a) => agentOwned.includes(a.selector))).toEqual([]);
    expect(report.captureHooks.filter((a) => agentOwned.includes(a.selector))).toEqual([]);
    expect(report.refused).toHaveLength(0);
    expect(contract().anchorsUnresolvedAtPin).toEqual([]);
    expect(JSON.stringify(captureAnchors)).toBe(before);
    expect(computeAnchorDigest(inputs)).toBe(digestBefore);
  });

  it("still sends the same controls through the drawing check when something records them", () => {
    // The contract leaves them out; the checker does not excuse them. A record
    // that carries one is a drawing claim, red on main while no drawing draws it.
    const agentOwned = [...retired, '[data-action="confirm-schedule-proposal"]'];
    const report = checked(agentOwned.map((s) => anchor(s, "recommendation_hold", "capture")));
    expect(report.unresolved.map((a) => a.selector)).toEqual(agentOwned);
    expect(report.captureHooks).toHaveLength(0);
    expect(decide({ event: "push-main", report, touchedPinIds: [] }).exitCode).toBe(1);
  });

  it.each(["present", "absent"])("keeps even canonical %s control observations inside the drawing check", (expectation) => {
    const report = checked(captured(retired.map((selector) => `${selector} root ${expectation} ${within} canonical`)));
    expect(report.unresolved.map((a) => a.selector).sort()).toEqual([...retired].sort());
    expect(report.unresolved.every((a) => a.captureAssertions[0].expect === expectation)).toBe(true);
    expect(decide({ event: "push-main", report, touchedPinIds: [] }).exitCode).toBe(1);
  });

  it("keeps both owner and capture claims for the same control", () => {
    const selector = retired[0];
    const report = checked(collectRecordedAnchors({
      anchorContract: { domExpectations: { carriage: { recommendation_hold: { ownerAnchors: [selector] } } } },
      captureAnchors: { run_card: { "recommendation_hold|pending": [`${selector} root absent ${within} canonical`] } },
    }));
    expect(report.unresolved.map((a) => [a.origin, a.selector])).toEqual([["ownerAnchors", selector], ["capture", selector]]);
  });

  it.each([true, false])("never deduplicates a positive assertion behind an absence (absent first: %s)", (absentFirst) => {
    const selector = retired[1];
    const entries = [`${selector} root absent ${within} canonical`, `${selector} root present ${within} canonical`];
    if (!absentFirst) entries.reverse();
    const report = checked(captured(entries));
    expect(report.captureAbsences ?? []).toHaveLength(0);
    expect(report.unresolved.map((a) => a.selector)).toEqual([selector]);
    expect(report.unresolved[0].captureAssertions.map((a) => a.expect)).toEqual(absentFirst ? ["absent", "present"] : ["present", "absent"]);
  });

  it.each([
    ['[data-skill-action="unknown"] root absent [data-lifecycle-card="recommendation_hold"] canonical', "recommendation_hold|pending", "run_card"],
    ['[data-skill-action="confirm"] frame absent  canonical', "recommendation_hold|pending", "run_card"],
    ['[data-skill-action="confirm"] root absent [data-lifecycle-card="recommendation_hold"] audit', "recommendation_hold|pending", "run_card"],
    ['[data-skill-action="confirm"] root absent [data-lifecycle-card="artifact_review_gate"] canonical', "recommendation_hold|pending", "run_card"],
    ['[data-skill-action="confirm"] root absent [data-lifecycle-card="recommendation_hold"] canonical', "recommendation_hold|unknown", "run_card"],
    ['[data-skill-action="confirm"] root absent [data-lifecycle-card="recommendation_hold"] canonical', "artifact_review_gate|pending", "run_card"],
    ['[data-skill-action="confirm"] root absent [data-lifecycle-card="recommendation_hold"] canonical', "recommendation_hold|pending", "unknown_host"],
  ])("does not excuse an unknown or noncanonical absence %s / %s / %s", (entry, cell, host) => {
    const report = checked(captured([entry], cell, host));
    expect(report.captureAbsences ?? []).toHaveLength(0);
    expect(report.unresolved).toHaveLength(1);
  });

  it.each([
    '[data-skill-action^="confirm"] root absent [data-lifecycle-card="recommendation_hold"] canonical',
    '[data-skill-action=confirm] root absent [data-lifecycle-card="recommendation_hold"] canonical',
  ])("still refuses unsupported selector forms rather than accounting an absence: %s", (entry) => {
    const report = checked(captured([entry]));
    expect(report.captureAbsences ?? []).toHaveLength(0);
    expect(report.refused).toHaveLength(1);
  });

  it.each([
    null,
    '[data-skill-action="confirm"]',
    '[data-skill-action="confirm"] root unknown [data-lifecycle-card="recommendation_hold"] canonical',
    '[data-skill-action="confirm"] root absent [data-lifecycle-card="recommendation_hold"] unknown',
    '[data-skill-action="confirm"] [data-other] root absent [data-lifecycle-card="recommendation_hold"] canonical',
    '[data-skill-action="confirm] root absent [data-lifecycle-card="recommendation_hold"] canonical',
  ])("refuses malformed serialized capture data before it can waive a drawing claim: %s", (entry) => {
    expect(() => captured([entry])).toThrow(UnsupportedSelectorError);
  });

});

describe("passive capture markers are accounted for separately from drawn parts", () => {
  const emptyDrawing = [{ path: "specs/one.html", text: "<!doctype html><main>empty</main>" }];

  it("classifies all eleven live markers without changing their capture requirements", () => {
    const captureAnchors = captureAnchorExpectations();
    const before = JSON.stringify(captureAnchors);
    const anchors = collectRecordedAnchors({ anchorContract: contract(), captureAnchors });
    const report = checkAnchorResolution({ pin: pin(), anchors, governed: emptyDrawing });
    expect(report.results.some((a) => PASSIVE_CAPTURE_SELECTORS.includes(a.selector))).toBe(false);
    expect([...new Set(report.captureHooks.map((a) => a.selector))].sort()).toEqual(
      [...PASSIVE_CAPTURE_SELECTORS].sort(),
    );
    expect(report.results.filter((a) => a.origin === "ownerAnchors")).toHaveLength(5);
    expect(report.unresolved.some((a) => a.selector === '[data-conformance-id="agent-hitl-screen-card"]')).toBe(true);
    expect(JSON.stringify(captureAnchors)).toBe(before);
  });

  it("reports a retained capture requirement without calling it resolved in a drawing", () => {
    const report = checkAnchorResolution({
      pin: pin(), anchors: [anchor(".cw-frame", "site_widget", "capture")], governed: emptyDrawing,
    });
    expect(report.unresolved).toHaveLength(0);
    expect(report.captureHooks).toHaveLength(1);
    expect(report.results).toHaveLength(0);
    const text = formatReport(report);
    expect(text).toContain(".cw-frame");
    expect(text).toContain("capture requirement — not a drawn part");
    expect(text).not.toContain("resolved in governed drawing");
  });

  it("keeps owner anchors, unknown markers and visible controls inside the drawing check", () => {
    const selectors = [
      ".cw-frame",
      '[data-lifecycle-card-host="unknown_host"]',
      '[data-lifecycle-card="unknown_card"]',
      '[data-embed-assistant][data-phase="starting"]',
      '[data-conformance-id="hitl-screen-fields"]',
      '[data-action="confirm-schedule-proposal"]',
      '[data-skill-action="confirm"]',
      '[data-skill-action="adjust"]',
      '[data-skill-action="skip"]',
    ];
    const anchors = selectors.map((s, i) => ({
      ...anchor(s, "k", i === 0 ? "ownerAnchors" : "capture"),
      // A caller cannot supply the classification to get out of the check.
      anchorClass: "capture-hook",
    }));
    const report = checkAnchorResolution({ pin: pin(), anchors, governed: emptyDrawing });
    expect(report.unresolved.map((a) => a.selector)).toEqual(selectors);
    expect(report.refused).toHaveLength(0);
    expect(decide({ event: "push-main", report, touchedPinIds: [] }).exitCode).toBe(1);
  });

  it("still refuses an unsupported selector that contains a passive marker", () => {
    const selector = '.cw-frame [data-conformance-id="review-gate-card"]';
    const report = checkAnchorResolution({
      pin: pin(), anchors: [anchor(selector, "k", "capture")], governed: emptyDrawing,
    });
    expect(report.refused.map((a) => a.selector)).toEqual([selector]);
  });

  it("prints only unresolved drawn parts and refuses the unchanged stale recorded array", async () => {
    const dir = mkdtempSync(join(tmpdir(), "design-capture-class-"));
    mkdirSync(join(dir, "specs"));
    writeFileSync(join(dir, "specs", "one.html"), emptyDrawing[0].text);
    const selectors = [".cw-frame", '[data-conformance-id="agent-hitl-screen-card"]'];
    const anchors = selectors.map((s) => anchor(s, "k", "capture"));
    const out = [];
    const err = [];
    const options = {
      env: { DESIGN_DRAWINGS_DIR: dir }, pins: [pin()], anchors,
      runGit: () => "", log: (l) => out.push(String(l)), logError: (l) => err.push(String(l)),
    };
    expect(await runCli({ ...options, argv: ["--print-unresolved"] })).toBe(0);
    expect(JSON.parse(out.join("\n"))).toEqual([selectors[1]]);
    out.length = 0;
    expect(await runCli({ ...options, argv: ["--event=push-main"], recordedUnresolved: selectors })).toBe(1);
    expect(err.join("\n")).toContain("recorded and not unresolved: .cw-frame");
    out.length = 0;
    expect(await runCli({
      ...options, argv: ["--event=push-main"], anchors: [anchors[0]], recordedUnresolved: [],
    })).toBe(0);
    expect(out.join("\n")).not.toContain("every recorded anchor resolves");
    expect(out.join("\n")).toContain("capture requirement — not a drawn part");
  });
});

// ---------------------------------------------------------------------------
// The matcher
// ---------------------------------------------------------------------------

describe("matching is exact, over parsed tags", () => {
  it("resolves an attribute-with-value selector against a real tag", () => {
    const drawing = drawingWith('[data-lifecycle-card="artifact_review_gate"]');
    expect(
      resolvesIn(attributeIndexOf(drawing), '[data-lifecycle-card="artifact_review_gate"]'),
    ).toBe(true);
  });

  it("resolves a bare attribute-presence selector", () => {
    expect(
      resolvesIn(attributeIndexOf("<div data-lifecycle-card-state>x</div>"), "[data-lifecycle-card-state]"),
    ).toBe(true);
  });

  it("does NOT resolve on a value that merely contains the recorded one", () => {
    const index = attributeIndexOf('<div data-lifecycle-card="artifact_review_gate_v2">x</div>');
    expect(resolvesIn(index, '[data-lifecycle-card="artifact_review_gate"]')).toBe(false);
  });

  it("does NOT resolve a selector that appears only in prose", () => {
    const drawing =
      '<!doctype html><p>Every card carries [data-conformance-id="review-gate-card"] on its root.</p>';
    expect(resolvesIn(attributeIndexOf(drawing), '[data-conformance-id="review-gate-card"]')).toBe(
      false,
    );
  });

  it("does NOT resolve a selector that appears only in a code sample", () => {
    const escaped =
      '<pre><code>&lt;div data-conformance-id="review-gate-card"&gt;&lt;/div&gt;</code></pre>';
    const literal = '<pre><div data-conformance-id="review-gate-card"></div></pre>';
    for (const drawing of [escaped, literal]) {
      expect(
        resolvesIn(attributeIndexOf(drawing), '[data-conformance-id="review-gate-card"]'),
        drawing,
      ).toBe(false);
    }
  });

  it("does NOT resolve a selector that appears only inside a comment", () => {
    const drawing = '<!-- <div data-conformance-id="review-gate-card"></div> -->';
    expect(resolvesIn(attributeIndexOf(drawing), '[data-conformance-id="review-gate-card"]')).toBe(
      false,
    );
  });

  it("refuses every selector form outside the decidable set", () => {
    for (const bad of [
      '[data-a="b"] [data-c="d"]',
      'div[data-a="b"]',
      "#card",
      '[data-a^="b"]',
      "[data-a=b]",
      ".card.other",
      '.card[data-a="b"]',
      '[data-a="b"].card',
      "[data-a]junk",
      "[]",
      ".",
      "",
    ]) {
      expect(() => parseAnchorSelector(bad), JSON.stringify(bad)).toThrow(UnsupportedSelectorError);
    }
  });
});

// ---------------------------------------------------------------------------
// The two forms the recorded set carries and this matcher used to refuse
// ---------------------------------------------------------------------------

describe("a class selector is decided against the elements that carry the class", () => {
  it("parses as a class form rather than throwing", () => {
    expect(parseAnchorSelector(".cw-frame")).toMatchObject({ form: "class", className: "cw-frame" });
  });

  it("resolves against an element whose class list carries the token", () => {
    expect(resolvesIn(drawingIndexOf('<div class="cw-frame is-open">x</div>'), ".cw-frame")).toBe(
      true,
    );
  });

  it("resolves when the token is one of several, in any position", () => {
    for (const value of ["cw-frame", "a cw-frame", "cw-frame b", "a  cw-frame\n b"]) {
      expect(resolvesIn(drawingIndexOf(`<div class="${value}">x</div>`), ".cw-frame"), value).toBe(
        true,
      );
    }
  });

  it("does NOT resolve on a class whose name merely contains the token", () => {
    expect(resolvesIn(drawingIndexOf('<div class="cw-frame-outer">x</div>'), ".cw-frame")).toBe(
      false,
    );
  });

  it("does NOT resolve against a drawing that draws no such class", () => {
    expect(resolvesIn(drawingIndexOf('<div class="card">x</div>'), ".cw-frame")).toBe(false);
  });

  it("does NOT resolve a class named only in prose, a code sample or a comment", () => {
    for (const drawing of [
      "<p>The widget is reached by .cw-frame on the host page.</p>",
      '<pre><code>&lt;div class="cw-frame"&gt;&lt;/div&gt;</code></pre>',
      '<pre><div class="cw-frame"></div></pre>',
      '<!-- <div class="cw-frame"></div> -->',
    ]) {
      expect(resolvesIn(drawingIndexOf(drawing), ".cw-frame"), drawing).toBe(false);
    }
  });

  it("does NOT resolve a token carried only by a SECOND class attribute", () => {
    // An HTML parser keeps the first `class` on an element and drops the
    // rest, so the second one draws nothing and must decide nothing.
    const index = drawingIndexOf('<div class="other" class="cw-frame">x</div>');
    expect(resolvesIn(index, ".cw-frame")).toBe(false);
    expect(resolvesIn(index, ".other")).toBe(true);
  });

  it("does NOT split a class value on a no-break space", () => {
    // HTML separates class tokens on ASCII whitespace only. `a\u00a0b` is ONE
    // token in the DOM, so neither half of it is a class this drawing carries.
    const index = drawingIndexOf('<div class="other\u00a0cw-frame">x</div>');
    expect(resolvesIn(index, ".cw-frame")).toBe(false);
    expect(resolvesIn(index, ".other")).toBe(false);
  });
});

describe("a compound attribute predicate is decided against ONE element at a time", () => {
  const SELECTOR = '[data-embed-assistant][data-phase="active"]';

  it("parses as a compound of every term rather than throwing", () => {
    expect(parseAnchorSelector(SELECTOR)).toMatchObject({
      form: "compound",
      terms: [
        { attribute: "data-embed-assistant", value: null },
        { attribute: "data-phase", value: "active" },
      ],
    });
  });

  it("resolves when ONE element satisfies every term", () => {
    expect(
      resolvesIn(drawingIndexOf('<div data-embed-assistant data-phase="active">x</div>'), SELECTOR),
    ).toBe(true);
  });

  it("does NOT resolve when the terms are scattered over different elements", () => {
    // This is the whole reason the index had to become per-element: a flat
    // attribute index answers yes to each term on its own, and a compound that
    // read it would certify an anchor no single element draws.
    const index = drawingIndexOf('<div data-embed-assistant>x</div><div data-phase="active">y</div>');
    expect(resolvesIn(index, SELECTOR)).toBe(false);
    expect(resolvesIn(index, "[data-embed-assistant]")).toBe(true);
    expect(resolvesIn(index, '[data-phase="active"]')).toBe(true);
  });

  it("does NOT resolve when a term's value differs on the element that carries both", () => {
    expect(
      resolvesIn(drawingIndexOf('<div data-embed-assistant data-phase="idle">x</div>'), SELECTOR),
    ).toBe(false);
  });

  it("does NOT resolve a compound drawn only inside a code sample", () => {
    expect(
      resolvesIn(drawingIndexOf('<pre><div data-embed-assistant data-phase="active"></div></pre>'), SELECTOR),
    ).toBe(false);
  });

  it("reads a repeated attribute on one element as its FIRST value", () => {
    // Same parser rule as the class list: the second `data-phase` is dropped,
    // so an element written `idle` first does not satisfy the `active` term.
    const index = drawingIndexOf(
      '<div data-embed-assistant data-phase="idle" data-phase="active">x</div>',
    );
    expect(resolvesIn(index, SELECTOR)).toBe(false);
    expect(resolvesIn(index, '[data-embed-assistant][data-phase="idle"]')).toBe(true);
  });
});

describe("the decidable set did not grow beyond those two forms", () => {
  it("still refuses a descendant compound, and the report still says REFUSED", () => {
    const report = checkAnchorResolution({
      pin: pin(),
      anchors: [anchor('[data-a="b"] [data-c="d"]')],
      governed: [{ path: "specs/one.html", text: drawingWith('[data-a="b"]') }],
      others: [],
    });
    expect(report.refused).toHaveLength(1);
    expect(report.unresolved).toHaveLength(0);
    expect(formatReport(report)).toContain("REFUSED");
  });

  it("decides both of the recorded forms rather than refusing them", () => {
    const report = checkAnchorResolution({
      pin: pin(),
      anchors: [
        // As drawn anchors, these still exercise the matcher forms. Capture
        // origin is tested separately against the passive-marker class.
        anchor(".cw-frame", "site_widget"),
        anchor('[data-embed-assistant][data-phase="active"]', "site_widget"),
      ],
      governed: [
        {
          path: "specs/one.html",
          text:
            '<!doctype html><div class="cw-frame">' +
            '<span data-embed-assistant data-phase="active">x</span></div>',
        },
      ],
      others: [],
    });
    expect(report.refused).toHaveLength(0);
    expect(report.unresolved).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 1. Reported per kind, non-zero when any does not resolve
// ---------------------------------------------------------------------------

describe("the report", () => {
  const governedText = drawingWith('[data-lifecycle-card="artifact_review_gate"]');

  it("exits clean when every recorded anchor resolves", () => {
    const report = checkAnchorResolution({
      pin: pin(),
      anchors: [anchor('[data-lifecycle-card="artifact_review_gate"]')],
      governed: [{ path: "specs/one.html", text: governedText }],
      others: [],
    });
    expect(report.unresolved).toHaveLength(0);
    expect(report.results[0].status).toBe("resolved");
  });

  it("names every kind whose anchor resolves in none of the governed drawings", () => {
    const report = checkAnchorResolution({
      pin: pin(),
      anchors: [
        anchor('[data-lifecycle-card="artifact_review_gate"]', "artifact_review_gate"),
        anchor('[data-skill-action="confirm"]', "recommendation_hold"),
      ],
      governed: [{ path: "specs/one.html", text: governedText }],
      others: [],
    });
    expect(report.unresolved).toHaveLength(1);
    expect(report.unresolved[0].kind).toBe("recommendation_hold");
    expect(formatReport(report)).toContain("recommendation_hold");
  });

  // The count is FIVE, not eight, and the drawing at the pin is why. `recommendation_hold`
  // recorded four owner anchors — the chip row's conformance id and one per per-chip
  // action — until specs/app-lifecycle-cards.html §V redrew the row as checkbox pills:
  // "There is no heading plate above the row, and a pill carries nothing to press — no
  // Confirm, no Adjust, no Skip. The reader sets the boxes and presses Continue beneath
  // the list … and the whole row is answered at once, every box together." The three
  // per-chip anchors are absent from the drawing at the pin, so the contract narrows this
  // kind to the one anchor its owner draws on EVERY host, which is the shape every other
  // kind in the table already has: five kinds, one owner anchor each.
  it("reports TODAY'S recorded owner anchors as unresolved against a drawing that draws none of them, all five named", () => {
    const anchors = collectRecordedAnchors({ anchorContract: contract() }).filter(
      (a) => a.origin === "ownerAnchors",
    );
    expect(anchors).toHaveLength(5);
    const report = checkAnchorResolution({
      pin: pin(),
      anchors,
      governed: [
        { path: "specs/one.html", text: "<!doctype html><main><section>a drawing</section></main>" },
      ],
      others: [],
    });
    expect(report.unresolved).toHaveLength(5);
    const text = formatReport(report);
    for (const a of anchors) expect(text, a.selector).toContain(a.selector);
    for (const kind of [
      "recommendation_hold",
      "artifact_review_gate",
      "trigger_schedule_proposal",
      "verification_summary",
      "agent_hitl_screen",
    ]) {
      expect(text, kind).toContain(kind);
    }
  });

  it("collects the capture requirements too, and skips the composition-only cells", () => {
    const anchors = collectRecordedAnchors({
      anchorContract: contract(),
      captureAnchors: captureAnchorExpectations(),
    });
    const capture = anchors.filter((a) => a.origin === "capture");
    expect(capture.length).toBeGreaterThan(0);
    for (const a of capture) {
      expect(a.selector).not.toContain("composition-only");
      expect(a.selector).not.toContain(" ");
    }
  });

  it("DECIDES every selector the live recorded set carries today, refusing none", () => {
    const anchors = collectRecordedAnchors({
      anchorContract: contract(),
      captureAnchors: captureAnchorExpectations(),
    });
    const report = checkAnchorResolution({
      pin: pin(),
      anchors,
      governed: [{ path: "specs/one.html", text: "<!doctype html><main>a drawing</main>" }],
      others: [],
    });
    // The decided passive capture markers have their own accounting; visible
    // parts still resolve against the drawing. A form outside the decidable
    // set is still refused by name — the suite above holds that half.
    expect(report.refused).toHaveLength(0);
    expect(report.unresolved.length).toBeGreaterThan(0);
    const selectors = report.unresolved.map((r) => r.selector);
    expect(selectors).not.toContain(".cw-frame");
    expect(selectors).not.toContain('[data-embed-assistant][data-phase="active"]');
    expect(report.captureHooks.map((r) => r.selector)).toContain(".cw-frame");
    expect(report.captureHooks.map((r) => r.selector)).toContain('[data-embed-assistant][data-phase="active"]');
    expect(formatReport(report)).toContain("UNRESOLVED");
  });
});

// ---------------------------------------------------------------------------
// 2. Which drawing it resolved in
// ---------------------------------------------------------------------------

describe("which drawing resolved it", () => {
  it("counts a drawing other than the first as resolved, and says which", () => {
    const report = checkAnchorResolution({
      pin: pin(["specs/one.html", "specs/two.html"]),
      anchors: [anchor('[data-lifecycle-card="verification_summary"]')],
      governed: [
        { path: "specs/one.html", text: drawingWith('[data-other="x"]') },
        { path: "specs/two.html", text: drawingWith('[data-lifecycle-card="verification_summary"]') },
      ],
      others: [],
    });
    expect(report.unresolved).toHaveLength(0);
    expect(report.results[0].governedIndex).toBe(2);
    expect(formatReport(report)).toContain("governed drawing 2");
  });

  it("calls an anchor drawn only OUTSIDE the pin's set unresolved, and states the distinction", () => {
    const report = checkAnchorResolution({
      pin: pin(["specs/one.html"]),
      anchors: [anchor('[data-lifecycle-card="verification_summary"]')],
      governed: [{ path: "specs/one.html", text: drawingWith('[data-other="x"]') }],
      others: [
        { path: "specs/two.html", text: drawingWith('[data-lifecycle-card="verification_summary"]') },
      ],
    });
    expect(report.unresolved).toHaveLength(1);
    expect(report.unresolved[0].elsewhere).toBe(true);
    expect(formatReport(report)).toContain("this pin does not govern");
  });
});

// ---------------------------------------------------------------------------
// 4/5. Hard failure, and the disclosure bound
// ---------------------------------------------------------------------------

describe("it never passes silently, and never prints the drawing", () => {
  it("refuses an unsupported selector by name rather than reporting it resolved OR unresolved", () => {
    const report = checkAnchorResolution({
      pin: pin(),
      anchors: [anchor('[data-a="b"] [data-c="d"]')],
      governed: [{ path: "specs/one.html", text: drawingWith('[data-a="b"]') }],
      others: [],
    });
    expect(report.refused).toHaveLength(1);
    expect(report.unresolved).toHaveLength(0);
    expect(report.results[0].status).toBe("refused");
    expect(formatReport(report)).toContain("REFUSED");
    // The parser itself still throws — the refusal is the CALLER's decision to
    // record rather than a form the matcher quietly accepts.
    expect(() => parseAnchorSelector('[data-a="b"] [data-c="d"]')).toThrow(UnsupportedSelectorError);
  });

  it("prints no drawing text beyond the selectors it was given", () => {
    const secret = "A SENTENCE ONLY THE DRAWING KNOWS";
    const report = checkAnchorResolution({
      pin: pin(),
      anchors: [anchor('[data-lifecycle-card="verification_summary"]')],
      governed: [
        {
          path: "specs/one.html",
          text: `<!doctype html><h2 data-section="vi">${secret}</h2><p>${secret}</p>`,
        },
      ],
      others: [],
    });
    const text = formatReport(report);
    expect(text).toContain('[data-lifecycle-card="verification_summary"]');
    expect(text).not.toContain(secret);
    expect(text).not.toContain("data-section");
    expect(text).not.toContain("specs/");
    expect(text).not.toMatch(/(?<![0-9a-f])[0-9a-f]{40}(?![0-9a-f])/);
  });
});

// ---------------------------------------------------------------------------
// The CLI
// ---------------------------------------------------------------------------

describe("the CLI", () => {
  const drawingsDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "design-drawings-"));
    mkdirSync(join(dir, "specs"), { recursive: true });
    return dir;
  };

  const write = (dir, name, text) => writeFileSync(join(dir, "specs", name), text, "utf8");

  const gitStub =
    (touched = []) =>
    (args) => {
      if (args[0] === "rev-parse") return "";
      if (args[0] === "diff") return touched.join("\n");
      throw new Error(`unexpected git ${args.join(" ")}`);
    };

  // `recordedUnresolved` defaults to null because these runs drive FIXTURE
  // drawings: reading the repository's own recorded set into them would compare
  // a record about the real drawings with a finding about a two-line fixture,
  // and turn a suite about the CHECKER red every time the RECORD moves.
  async function run({
    argv = [],
    env = {},
    dir,
    anchors,
    touched = [],
    pins,
    recordedUnresolved = null,
  }) {
    const out = [];
    const err = [];
    const code = await runCli({
      argv,
      env: { DESIGN_DRAWINGS_DIR: dir, DESIGN_PIN_DRIFT_DIFF_BASE: "base", ...env },
      pins,
      anchors,
      recordedUnresolved,
      runGit: gitStub(touched),
      log: (l) => out.push(String(l)),
      logError: (l) => err.push(String(l)),
    });
    return { code, all: [...out, ...err].join("\n") };
  }

  it("exits 0 when every anchor resolves, in every event class", async () => {
    const dir = drawingsDir();
    write(dir, "one.html", drawingWith('[data-lifecycle-card="verification_summary"]'));
    for (const env of [
      { GITHUB_EVENT_NAME: "push", GITHUB_REF_NAME: "main" },
      { GITHUB_EVENT_NAME: "pull_request" },
      {},
    ]) {
      const r = await run({
        env,
        dir,
        pins: [pin()],
        anchors: [anchor('[data-lifecycle-card="verification_summary"]')],
      });
      expect(r.code, JSON.stringify(env)).toBe(0);
    }
  });

  it("is RED under dispatch and push-to-main when an anchor does not resolve", async () => {
    const dir = drawingsDir();
    write(dir, "one.html", drawingWith('[data-other="x"]'));
    for (const env of [{}, { GITHUB_EVENT_NAME: "push", GITHUB_REF_NAME: "main" }]) {
      const r = await run({
        env,
        dir,
        pins: [pin()],
        anchors: [anchor('[data-lifecycle-card="verification_summary"]')],
      });
      expect(r.code, JSON.stringify(env)).toBe(1);
      expect(r.all).toContain('[data-lifecycle-card="verification_summary"]');
    }
  });

  it("warns and exits 0 on a pull request that touches no mapped path", async () => {
    const dir = drawingsDir();
    write(dir, "one.html", drawingWith('[data-other="x"]'));
    const r = await run({
      env: { GITHUB_EVENT_NAME: "pull_request" },
      argv: ["--github-annotations"],
      dir,
      touched: ["README.md"],
      pins: [pin()],
      anchors: [anchor('[data-lifecycle-card="verification_summary"]')],
    });
    expect(r.code).toBe(0);
    expect(r.all).toContain("::warning");
  });

  it("exits 2 with neither a local copy nor a credential", async () => {
    const r = await run({
      env: { DESIGN_DRAWINGS_DIR: "", DESIGN_SOURCE_TOKEN: "" },
      dir: "",
      pins: [pin()],
      anchors: [anchor('[data-lifecycle-card="verification_summary"]')],
    });
    expect(r.code).toBe(2);
    expect(r.all).toContain("could not run");
  });

  it("exits 2 when a governed drawing is missing from the local copy", async () => {
    const dir = drawingsDir();
    const r = await run({
      dir,
      pins: [pin()],
      anchors: [anchor('[data-lifecycle-card="verification_summary"]')],
    });
    expect(r.code).toBe(2);
  });

  it("exits 2 on an unsupported selector rather than reporting it unresolved", async () => {
    const dir = drawingsDir();
    write(dir, "one.html", drawingWith('[data-other="x"]'));
    const r = await run({ dir, pins: [pin()], anchors: [anchor('[data-a="b"] [data-c="d"]')] });
    expect(r.code).toBe(2);
    expect(r.all).toContain("could not run");
  });

  it("prints the unresolved set as data for the adoption road", async () => {
    const dir = drawingsDir();
    write(dir, "one.html", drawingWith('[data-other="x"]'));
    const out = [];
    await runCli({
      argv: ["--print-unresolved"],
      env: { DESIGN_DRAWINGS_DIR: dir },
      pins: [pin()],
      anchors: [anchor('[data-lifecycle-card="verification_summary"]')],
      runGit: gitStub(),
      log: (l) => out.push(String(l)),
      logError: () => {},
    });
    expect(JSON.parse(out.join("\n"))).toEqual(['[data-lifecycle-card="verification_summary"]']);
  });
});

// ---------------------------------------------------------------------------
// 5b. A run that cannot read the drawings (cinatra#3555)
// ---------------------------------------------------------------------------
//
// The check is a REQUIRED context, and it reads the drawings through a
// credential. A run without one is a fork pull request (no Actions secrets), a
// Dependabot-triggered run (Dependabot gets its own secret store, not the
// Actions one), or a run whose App credential was refused; a run whose read
// fails with a credential present is an outage of the design source. For a pull
// request that changes no path the checker reads, none of these can change the
// verdict, so such a run exits 0 with a notice and certifies nothing. A run that
// does change such a path, and every push to main and dispatch, keeps exit 2.

describe("a run that cannot read the drawings", () => {
  const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const mapped = "scripts/audit/chat-hitl-anchor-contract.json";

  const gitStub =
    (touched = []) =>
    (args) => (args[0] === "rev-parse" ? "" : touched.join("\n"));

  const noReader = () => null;
  const outageReader = () => ({
    drawingAt: async () => {
      throw new DesignSourceError("read-failed");
    },
    revisionsTouching: async () => [],
  });

  async function runBlind({ env = {}, touched = [], createReader = noReader, argv = [], runGit, repoRoot, pins }) {
    const out = [];
    const err = [];
    const code = await runCli({
      argv,
      env: { DESIGN_PIN_DRIFT_DIFF_BASE: "base", GITHUB_EVENT_NAME: "pull_request", ...env },
      ...(repoRoot ? { repoRoot } : {}),
      pins: pins ?? [pin()],
      anchors: [anchor('[data-lifecycle-card="verification_summary"]')],
      recordedUnresolved: null,
      createReader,
      runGit: runGit ?? gitStub(touched),
      log: (l) => out.push(String(l)),
      logError: (l) => err.push(String(l)),
    });
    return { code, all: [...out, ...err].join("\n"), out: out.join("\n") };
  }

  it("exits 0 with a notice on a pull request that changes no path the checker reads, with no credential", async () => {
    const r = await runBlind({ touched: ["README.md", "docs/guide.md"] });
    expect(r.code).toBe(0);
    expect(r.out).toContain("::notice");
    expect(r.out).toContain("not run");
    expect(r.out).toContain("no credential for the design source is present");
  });

  it("exits 0 with a notice on an untouched merge group and on an untouched push to another branch", async () => {
    for (const env of [
      { GITHUB_EVENT_NAME: "merge_group" },
      { GITHUB_EVENT_NAME: "push", GITHUB_REF_NAME: "feature/x" },
    ]) {
      const r = await runBlind({ env, touched: ["README.md"] });
      expect(r.code, JSON.stringify(env)).toBe(0);
      expect(r.out, JSON.stringify(env)).toContain("::notice");
    }
  });

  it("does not say the anchors resolve when it read nothing", async () => {
    const r = await runBlind({ touched: ["README.md"] });
    expect(r.all).not.toContain("ok: every drawing anchor resolves");
    expect(r.all).not.toContain("WARNING");
  });

  it("exits 0 with a notice when the design source cannot be read, with a credential, and no mapped path changed", async () => {
    const r = await runBlind({
      env: { DESIGN_SOURCE_TOKEN: "token-present" },
      touched: ["README.md"],
      createReader: outageReader,
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("::notice");
    expect(r.out).toContain("not run");
  });

  it("keeps exit 2 with no credential when the diff touches a path the checker reads", async () => {
    for (const touched of [
      [mapped],
      ["README.md", "scripts/audit/lib/anchor-contract.mjs"],
      ["scripts/ci/lib/capture-record-contract.mjs"],
      ["scripts/ci/design-pin-drift.mjs"],
      [".github/workflows/gates.yml"],
      ["scripts/ci/design-anchor-resolution.mjs"],
    ]) {
      const r = await runBlind({ touched });
      expect(r.code, touched.join(",")).toBe(2);
      expect(r.all, touched.join(",")).toContain("could not run");
    }
  });

  it("keeps exit 2 on an outage when the diff touches a path the checker reads", async () => {
    const r = await runBlind({
      env: { DESIGN_SOURCE_TOKEN: "token-present" },
      touched: [mapped],
      createReader: outageReader,
    });
    expect(r.code).toBe(2);
  });

  it("keeps exit 2 on a push to main and on dispatch, whatever the diff", async () => {
    for (const env of [{ GITHUB_EVENT_NAME: "push", GITHUB_REF_NAME: "main" }, { GITHUB_EVENT_NAME: "" }]) {
      const r = await runBlind({ env, touched: ["README.md"] });
      expect(r.code, JSON.stringify(env)).toBe(2);
    }
  });

  it("keeps exit 2 when no diff base is set, because then every pin counts as touched", async () => {
    const r = await runBlind({ env: { DESIGN_PIN_DRIFT_DIFF_BASE: "" }, touched: ["README.md"] });
    expect(r.code).toBe(2);
  });

  it("keeps exit 2 when the diff base does not resolve", async () => {
    const code = await runCli({
      env: { DESIGN_PIN_DRIFT_DIFF_BASE: "gone", GITHUB_EVENT_NAME: "pull_request" },
      pins: [pin()],
      anchors: [anchor('[data-lifecycle-card="verification_summary"]')],
      recordedUnresolved: null,
      createReader: noReader,
      runGit: () => {
        throw new Error("bad revision");
      },
      log: () => {},
      logError: () => {},
    });
    expect(code).toBe(2);
  });

  it("reads the diff without rename detection, so a moved file lists its old path too", async () => {
    // `git diff --name-only` pairs a rename and lists only its destination; the
    // source of a moved file the checker reads would then be invisible.
    const calls = [];
    const r = await runBlind({
      runGit: (args) => {
        calls.push(args);
        return args[0] === "rev-parse" ? "" : "README.md";
      },
    });
    expect(r.code).toBe(0);
    const diff = calls.find((a) => a[0] === "diff");
    expect(diff).toBeDefined();
    expect(diff).toContain("--no-renames");
    expect(diff).toContain("--name-only");
  });

  it("does not take the exit-0 road under --print-unresolved, which promises a printed set on exit 0", async () => {
    const r = await runBlind({ argv: ["--print-unresolved"], touched: ["README.md"] });
    expect(r.code).toBe(2);
    expect(r.all).toContain("could not run");
    expect(r.all).not.toContain("::notice title=design-anchor-resolution");
  });

  it("refuses a path map whose pin ids differ from the pins it reads, though the diff is untouched", async () => {
    const real = JSON.parse(readFileSync(resolvePath(REPO_ROOT, "scripts/ci/design-pin-gates.paths.json"), "utf8"));
    for (const pinsOfMap of [{}, { "some-other-pin": ["README.md"] }, { ...real.pins, "extra-pin": ["README.md"] }]) {
      const root = mkdtempSync(join(tmpdir(), "anchor-map-"));
      mkdirSync(join(root, "scripts/ci"), { recursive: true });
      writeFileSync(join(root, "scripts/ci/design-pin-gates.paths.json"), JSON.stringify({ ...real, pins: pinsOfMap }));
      const r = await runBlind({ repoRoot: root, touched: ["README.md"] });
      expect(r.code, JSON.stringify(Object.keys(pinsOfMap))).toBe(2);
      expect(r.all, JSON.stringify(Object.keys(pinsOfMap))).toContain("could not run");
    }
  });

  it("keeps exit 2 when the pin or the contract cannot be read, though the diff is untouched", async () => {
    const code = await runCli({
      env: { DESIGN_PIN_DRIFT_DIFF_BASE: "base", GITHUB_EVENT_NAME: "pull_request" },
      pins: () => {
        throw new Error("unreadable");
      },
      anchors: [],
      recordedUnresolved: null,
      createReader: noReader,
      runGit: gitStub(["README.md"]),
      log: () => {},
      logError: () => {},
    });
    expect(code).toBe(2);
  });

  // The untouched-diff shortcut is only as good as the set of paths it calls
  // "read by the checker", so that set is derived here from the checker's own
  // inputs and not typed in: the static relative imports of the checker, taken
  // transitively, plus the files it opens as data (the pin carriers). Each must
  // count as touching the pin under the shared rule. Imports made by a dynamic
  // or computed specifier are not followed.
  it("counts every file the checker imports or reads as touching its pin", () => {
    const seen = new Set();
    const todo = [ANCHOR_RESOLUTION_CHECKER_PATH];
    while (todo.length) {
      const rel = todo.pop();
      if (seen.has(rel)) continue;
      seen.add(rel);
      const text = readFileSync(resolvePath(REPO_ROOT, rel), "utf8");
      for (const m of text.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g)) {
        todo.push(normalize(join(dirname(rel), m[1])).split("\\").join("/"));
      }
    }
    const inputs = [...seen, ...COMMIT_BEARING_PINS.flatMap((p) => [p.authority, p.mirror])];
    expect(inputs.length).toBeGreaterThan(5);
    const map = loadGatePathMap(REPO_ROOT);
    const uncovered = inputs.filter(
      (f) => resolveTouchedPins({ touchedPaths: [f], map, globalPaths: GLOBAL_PATHS }).length === 0,
    );
    expect(uncovered).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6. The digest schema: anchorsUnresolvedAtPin as a fourth input
// ---------------------------------------------------------------------------

describe("anchorsUnresolvedAtPin is a fourth digest input", () => {
  it("is bound into today's recorded digest, now that the adoption has recorded it", () => {
    expect(auditAnchorContract({ anchorContract: contract(), manifest: manifest() })).toEqual([]);
    const three = {
      specCommit: manifest().specCommit,
      domExpectations: contract().domExpectations,
      captureAnchors: captureAnchorExpectations(),
    };
    const withRecorded = computeAnchorDigest(
      anchorDigestInputs({ ...three, anchorsUnresolvedAtPin: contract().anchorsUnresolvedAtPin }),
    );
    expect(withRecorded).toBe(contract().digest);
    // and dropping it moves the digest, which is what makes it an input rather
    // than a comment beside one.
    expect(computeAnchorDigest(anchorDigestInputs(three))).not.toBe(contract().digest);
  });

  it("moves the digest the moment it is recorded, and again when it is edited", () => {
    const base = anchorDigestInputs({
      specCommit: manifest().specCommit,
      domExpectations: contract().domExpectations,
      captureAnchors: captureAnchorExpectations(),
    });
    const withEmpty = computeAnchorDigest({ ...base, anchorsUnresolvedAtPin: [] });
    const withOne = computeAnchorDigest({ ...base, anchorsUnresolvedAtPin: ['[data-a="b"]'] });
    // The contract records the EMPTY set at this pin (cinatra#3677), so the
    // empty array is the recorded one: recording it moved the digest away from
    // the absent key, and recording anything else moves it again.
    expect(contract().anchorsUnresolvedAtPin).toEqual([]);
    expect(withEmpty).toBe(contract().digest);
    expect(computeAnchorDigest(base)).not.toBe(withEmpty);
    expect(withOne).not.toBe(contract().digest);
    expect(withOne).not.toBe(withEmpty);
  });

  it("is refused by the audit when it is recorded in an unreadable shape", () => {
    const violations = auditAnchorContract({
      anchorContract: { ...contract(), anchorsUnresolvedAtPin: "[data-a]" },
      manifest: manifest(),
    });
    expect(violations.join("\n")).toContain("anchorsUnresolvedAtPin");
  });

  it("is carried into the digest by anchorDigestInputs when present, and omitted when not", () => {
    const inputs = anchorDigestInputs({
      specCommit: "x",
      domExpectations: {},
      captureAnchors: {},
      anchorsUnresolvedAtPin: ['[data-a="b"]'],
    });
    expect(Object.keys(inputs)).toContain("anchorsUnresolvedAtPin");
    const without = anchorDigestInputs({ specCommit: "x", domExpectations: {}, captureAnchors: {} });
    expect(Object.keys(without)).not.toContain("anchorsUnresolvedAtPin");
  });
});

// ---------------------------------------------------------------------------
// The verdict function
// ---------------------------------------------------------------------------

describe("decide", () => {
  const unresolved = { unresolved: [{ kind: "k", selector: "[data-a]" }] };
  it("reds on push-main and on dispatch", () => {
    for (const event of ["push-main", "workflow_dispatch"]) {
      expect(decide({ event, report: unresolved, touchedPinIds: [] }).exitCode, event).toBe(1);
    }
  });
  it("warns on a pull request that touches no mapped path", () => {
    const verdict = decide({ event: "pull_request", report: unresolved, touchedPinIds: [] });
    expect(verdict.exitCode).toBe(0);
    expect(verdict.warn).toBe(true);
  });
  it("reds a pull request that touches a mapped path", () => {
    const verdict = decide({
      event: "pull_request",
      report: unresolved,
      touchedPinIds: ["chat-hitl-lifecycle"],
    });
    expect(verdict.exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The convergence round's findings
// ---------------------------------------------------------------------------

describe("the adoption road refuses to answer while a selector is refused", () => {
  const drawingsDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "design-drawings-"));
    mkdirSync(join(dir, "specs"), { recursive: true });
    return dir;
  };
  const write = (dir, name, text) => writeFileSync(join(dir, "specs", name), text, "utf8");
  const gitStub = () => (args) => (args[0] === "rev-parse" ? "" : "");

  async function printUnresolved({ dir, anchors }) {
    const out = [];
    const err = [];
    const code = await runCli({
      argv: ["--print-unresolved"],
      env: { DESIGN_DRAWINGS_DIR: dir },
      pins: [pin()],
      anchors,
      runGit: gitStub(),
      log: (l) => out.push(String(l)),
      logError: (l) => err.push(String(l)),
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  }

  it("exits 2 and prints NO array when the recorded set mixes unresolved and refused", async () => {
    // The set this road hands the adoption script must be COMPLETE. A refused
    // selector is a verdict the matcher never reached, so an array printed
    // beside it would be recorded — and digest-bound — as if it were the whole
    // finding. This is the mixed case: one honestly unresolved, one refused.
    const dir = drawingsDir();
    write(dir, "one.html", drawingWith('[data-other="x"]'));
    const r = await printUnresolved({
      dir,
      anchors: [
        anchor('[data-lifecycle-card="verification_summary"]'),
        anchor('[data-a="b"] [data-c="d"]'),
      ],
    });
    expect(r.code).toBe(2);
    expect(r.out.trim()).toBe("");
    expect(r.err).toContain("could not run");
    // The error prints a refused selector as a JSON string.
    expect(r.err).toContain(JSON.stringify('[data-a="b"] [data-c="d"]'));
  });

  it("names an empty selector as \"\" in its refusal error, and prints NO array", async () => {
    // An empty selector is refused like every other form it does not decide.
    // Printed bare, it would end the error in a blank that names nothing.
    const dir = drawingsDir();
    write(dir, "one.html", drawingWith('[data-other="x"]'));
    const r = await printUnresolved({
      dir,
      anchors: [anchor('[data-lifecycle-card="verification_summary"]'), anchor("")],
    });
    expect(r.code).toBe(2);
    expect(r.out.trim()).toBe("");
    expect(r.err).toContain('the unresolved set is incomplete and is not printed: "".');
  });

  it("PRINTS the array for a recorded set carrying the two forms it now decides", async () => {
    // The measured defect: this road refused to answer at all while the two
    // forms below were undecidable, so the adoption transaction could never
    // record what the re-examination found. Both are decided here, and the one
    // the drawing does not draw is reported as unresolved rather than refused.
    const dir = drawingsDir();
    write(
      dir,
      "one.html",
      '<!doctype html><div class="cw-frame">x</div><span data-embed-assistant>y</span>',
    );
    const r = await printUnresolved({
      dir,
      anchors: [
        // A drawn claim still uses the matcher even for a selector which the
        // capture recorder uses separately as a passive marker.
        anchor(".cw-frame", "site_widget"),
        anchor('[data-embed-assistant][data-phase="active"]', "site_widget"),
      ],
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual(['[data-embed-assistant][data-phase="active"]']);
  });

  it("still prints the array, and exits 0, when nothing is refused", async () => {
    const dir = drawingsDir();
    write(dir, "one.html", drawingWith('[data-other="x"]'));
    const r = await printUnresolved({
      dir,
      anchors: [anchor('[data-lifecycle-card="verification_summary"]')],
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual(['[data-lifecycle-card="verification_summary"]']);
  });
});

describe("an attribute NAME is matched case-insensitively, a value is not", () => {
  it("resolves a lowercase selector against an upper-case attribute name", () => {
    // HTML folds attribute names; a drawing written `DATA-LIFECYCLE-CARD=`
    // draws the same anchor, and reporting it unresolved would be a false
    // finding against a drawing that does draw it.
    const index = attributeIndexOf('<div DATA-LIFECYCLE-CARD="artifact_review_gate">x</div>');
    expect(resolvesIn(index, '[data-lifecycle-card="artifact_review_gate"]')).toBe(true);
  });

  it("does NOT fold the value — a conformance id is case-sensitive", () => {
    const index = attributeIndexOf('<div data-lifecycle-card="Artifact_Review_Gate">x</div>');
    expect(resolvesIn(index, '[data-lifecycle-card="artifact_review_gate"]')).toBe(false);
  });
});

describe("a run that did not read the sibling drawings says so", () => {
  const remoteReader = (text) => () => ({
    drawingAt: async () => text,
    revisionsTouching: async () => [],
  });

  it("words an unresolved anchor as an unanswered question, not a negative answer", async () => {
    // Over the authenticated road only the governed drawings are read, so
    // "no governed drawing draws it" is all this run knows — it may not also
    // imply the sibling set was looked at and did not draw it either.
    const out = [];
    const err = [];
    const code = await runCli({
      env: {},
      pins: [pin()],
      anchors: [anchor('[data-lifecycle-card="verification_summary"]')],
      recordedUnresolved: null,
      createReader: remoteReader(drawingWith('[data-other="x"]')),
      runGit: () => "",
      log: (l) => out.push(String(l)),
      logError: (l) => err.push(String(l)),
    });
    const all = [...out, ...err].join("\n");
    expect(code).not.toBe(0);
    expect(all).toContain("the sibling drawings were not read");
  });

  it("says nothing of the sort when a local copy DID carry the siblings", () => {
    const report = checkAnchorResolution({
      pin: pin(),
      anchors: [anchor('[data-lifecycle-card="verification_summary"]')],
      governed: [{ path: "specs/one.html", text: drawingWith('[data-other="x"]') }],
      others: [{ path: "specs/two.html", text: drawingWith('[data-other="y"]') }],
      siblingsKnown: true,
    });
    expect(formatReport(report)).toContain("no governed drawing draws it");
    expect(formatReport(report)).not.toContain("were not read");
  });
});

describe("a recorded anchorsUnresolvedAtPin is compared with what this check finds", () => {
  const drawingsDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "design-drawings-"));
    mkdirSync(join(dir, "specs"), { recursive: true });
    return dir;
  };
  const write = (dir, name, text) => writeFileSync(join(dir, "specs", name), text, "utf8");

  async function run({ dir, anchors, recordedUnresolved }) {
    const out = [];
    const err = [];
    const code = await runCli({
      env: { DESIGN_DRAWINGS_DIR: dir, GITHUB_EVENT_NAME: "push", GITHUB_REF_NAME: "main" },
      argv: ["--event", "push-main"],
      pins: [pin()],
      anchors,
      recordedUnresolved,
      runGit: () => "",
      log: (l) => out.push(String(l)),
      logError: (l) => err.push(String(l)),
    });
    return { code, all: [...out, ...err].join("\n") };
  }

  it("names both directions of a disagreement", async () => {
    // The digest proves the array was not EDITED. It cannot prove it was TRUE
    // when it was written, and this is the script G0's acceptance item names
    // for that comparison.
    const dir = drawingsDir();
    write(dir, "one.html", drawingWith('[data-other="x"]'));
    const r = await run({
      dir,
      anchors: [anchor('[data-lifecycle-card="verification_summary"]')],
      recordedUnresolved: ['[data-lifecycle-card="agent_hitl_screen"]'],
    });
    expect(r.code).toBe(1);
    expect(r.all).toContain("unresolved and unrecorded: [data-lifecycle-card=\"verification_summary\"]");
    expect(r.all).toContain("recorded and not unresolved: [data-lifecycle-card=\"agent_hitl_screen\"]");
  });

  it("decides nothing when the recorded set is exactly what it finds", async () => {
    const dir = drawingsDir();
    write(dir, "one.html", drawingWith('[data-other="x"]'));
    const r = await run({
      dir,
      anchors: [anchor('[data-lifecycle-card="verification_summary"]')],
      recordedUnresolved: ['[data-lifecycle-card="verification_summary"]'],
    });
    // Still red, but for the ANCHOR being unresolved — not for the record.
    expect(r.code).toBe(1);
    expect(r.all).not.toContain("is not what this check finds");
  });

  it("exits 2 on a refused selector when the recorded set agrees with what it finds", async () => {
    // The comparison runs first and agrees, so the refusal decides: a set with
    // a selector this matcher did not decide is not a set it may call red or
    // green, even though another recorded anchor is unresolved.
    const dir = drawingsDir();
    write(dir, "one.html", drawingWith('[data-other="x"]'));
    const r = await run({
      dir,
      anchors: [
        anchor('[data-lifecycle-card="verification_summary"]'),
        anchor('[data-a="b"] [data-c="d"]'),
      ],
      recordedUnresolved: ['[data-lifecycle-card="verification_summary"]'],
    });
    expect(r.code).toBe(2);
    expect(r.all).toContain("could not run");
    expect(r.all).not.toContain("is not what this check finds");
  });

  it("exits 1 on a refused selector when the recorded set disagrees, because the comparison comes first", async () => {
    const dir = drawingsDir();
    write(dir, "one.html", drawingWith('[data-other="x"]'));
    const r = await run({
      dir,
      anchors: [
        anchor('[data-lifecycle-card="verification_summary"]'),
        anchor('[data-a="b"] [data-c="d"]'),
      ],
      recordedUnresolved: [],
    });
    expect(r.code).toBe(1);
    expect(r.all).toContain("is not what this check finds");
    expect(r.all).not.toContain("could not run");
  });

  it("names an empty selector as \"\" in the report and in the refusal error, and exits 2", async () => {
    // A run that reaches the refusal exit prints the report of the whole set
    // with the refused selector named in it. The empty selector is named as
    // `""`; printed bare, its report line and its error would show a blank.
    const dir = drawingsDir();
    write(dir, "one.html", drawingWith('[data-lifecycle-card="verification_summary"]'));
    const r = await run({
      dir,
      anchors: [anchor('[data-lifecycle-card="verification_summary"]'), anchor("")],
      recordedUnresolved: [],
    });
    expect(r.code).toBe(2);
    expect(r.all).not.toContain("is not what this check finds");
    expect(r.all).toContain('    ""  [ownerAnchors]  REFUSED');
    expect(r.all).toContain('refuses to approximate: "". Every other anchor is reported above.');
  });

  it("has a recorded set to compare against, and it is EMPTY at this pin, which is this repository's state today", () => {
    // cinatra#3677: the four selectors this array carried were four card
    // controls that no governed drawing draws under the recorded value, which
    // the contract no longer records, so nothing it records is unresolved at
    // the pin. The array stays PRESENT — an absent key would
    // take it out of the digest and out of this comparison.
    const recorded = contract().anchorsUnresolvedAtPin;
    expect(Array.isArray(recorded)).toBe(true);
    expect(recorded).toEqual([]);
  });

  it("goes green on a push to main once every recorded anchor resolves and the recorded set is empty", async () => {
    const dir = drawingsDir();
    write(dir, "one.html", drawingWith('[data-lifecycle-card="verification_summary"]'));
    const r = await run({
      dir,
      anchors: [anchor('[data-lifecycle-card="verification_summary"]')],
      recordedUnresolved: [],
    });
    expect(r.code).toBe(0);
    expect(r.all).not.toContain("is not what this check finds");
  });
});

describe("anchorsUnresolvedAtPin refuses a shape that hides a re-examination", () => {
  it("refuses a repeated selector", () => {
    const c = { ...contract(), anchorsUnresolvedAtPin: ["[data-a]", "[data-a]"] };
    const violations = auditAnchorContract({ anchorContract: c, manifest: manifest() });
    expect(violations.join("\n")).toContain("repeats a selector");
  });
});
