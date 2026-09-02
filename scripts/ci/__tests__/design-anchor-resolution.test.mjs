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
//      reported per kind, and the check exits non-zero when any does not.
//   2. An anchor resolving in a governed drawing other than the first is
//      RESOLVED; one resolving only in a drawing the pin does not govern is
//      UNRESOLVED, with that distinction stated.
//   3. A selector matched only inside prose or a code sample does not count.
//   4. An unsupported selector form is a HARD FAILURE, never a silent pass.
//   5. The printed output carries no drawing text beyond the selector.
//   6. The sibling binding suite and --print-anchor-digest still agree — held
//      here for the DIGEST SCHEMA half: `anchorsUnresolvedAtPin` is a fourth
//      digest input the moment it is recorded, and its absence today leaves the
//      recorded digest exactly where it stands.

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
        anchor(".cw-frame", "site_widget", "capture"),
        anchor('[data-embed-assistant][data-phase="active"]', "site_widget", "capture"),
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

  it("reports TODAY'S recorded owner anchors as unresolved against a drawing that draws none of them, all eight named", () => {
    const anchors = collectRecordedAnchors({ anchorContract: contract() }).filter(
      (a) => a.origin === "ownerAnchors",
    );
    expect(anchors).toHaveLength(8);
    const report = checkAnchorResolution({
      pin: pin(),
      anchors,
      governed: [
        { path: "specs/one.html", text: "<!doctype html><main><section>a drawing</section></main>" },
      ],
      others: [],
    });
    expect(report.unresolved).toHaveLength(8);
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
    // Measured, not assumed: the frame-wide requirements carry a class
    // selector and a compound attribute predicate, and both are now DECIDED
    // against the drawing rather than refused. A form outside the decidable
    // set is still refused by name — the suite above holds that half.
    expect(report.refused).toHaveLength(0);
    expect(report.unresolved.length).toBeGreaterThan(0);
    const selectors = report.unresolved.map((r) => r.selector);
    expect(selectors).toContain(".cw-frame");
    expect(selectors).toContain('[data-embed-assistant][data-phase="active"]');
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
    expect(withEmpty).not.toBe(contract().digest);
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
    expect(r.err).toContain('[data-a="b"] [data-c="d"]');
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
        anchor(".cw-frame", "site_widget", "capture"),
        anchor('[data-embed-assistant][data-phase="active"]', "site_widget", "capture"),
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

  it("has a recorded set to compare against, which is this repository's state today", () => {
    const recorded = contract().anchorsUnresolvedAtPin;
    expect(Array.isArray(recorded)).toBe(true);
    expect(recorded.length).toBeGreaterThan(0);
    // sorted and without a repeat — the shape the contract's own audit refuses
    // in any other form, because a re-examination may not hide behind an order.
    expect([...recorded]).toEqual([...new Set(recorded)].sort());
  });
});

describe("anchorsUnresolvedAtPin refuses a shape that hides a re-examination", () => {
  it("refuses a repeated selector", () => {
    const c = { ...contract(), anchorsUnresolvedAtPin: ["[data-a]", "[data-a]"] };
    const violations = auditAnchorContract({ anchorContract: c, manifest: manifest() });
    expect(violations.join("\n")).toContain("repeats a selector");
  });
});
