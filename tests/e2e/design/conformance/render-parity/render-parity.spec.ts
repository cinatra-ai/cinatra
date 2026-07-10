// ---------------------------------------------------------------------------
// Render-parity conformance CI — static-fixture slice (cinatra#1222, epic S6).
//
// Automates render-parity so "exactly like /chat" cannot silently drift. Renders
// a fixture corpus through the S3 packaged renderer (the reference target,
// #1228) and fails on divergence, DOM-normalized. It rides the existing
// design-conformance CI (design-visual-verify.yml, `design-conformance-functional`
// project) via this `tests/e2e/design/conformance/**` path — NO .github edits,
// exactly as the header-rule gate did.
//
// WHAT THIS SLICE ENFORCES (deterministic, OS-independent — safe on CI):
//   1. Content render parity — every content + hostile fixture rendered through
//      the packaged renderer is DOM-normalized-compared against a committed
//      golden (both themes). Renderer drift → RED.
//   2. Embed-detection parity — chart/mermaid detection + schema validation is
//      locked against a golden.
//   3. AG-UI corpus conformance — the S1 AG-UI event sequences + the change-diff
//      DATA_PART are validated against the S1 contract AND each known scenario's
//      exact event-type sequence is locked (a schema-valid reorder/insert/delete
//      is caught, not just a malformed event). Payload detail stays owned by S1
//      (the fixtures) and S4 (the concrete view schema).
//
// OUT OF SCOPE HERE (say so on the PR) — the LIVE-RUN slice, after S2 (`/chat`
// on the wire) and S5 (widgets embedded):
//   - Driving the corpus through the generic embedded view + the WordPress /
//     Drupal iframes as additional targets and asserting cross-target DOM +
//     visual equality (the three-target compare). The seam is built
//     (`RenderTarget`); those targets only implement it.
//   - The #1214 no-direct-egress assertion inside the embedded E2E.
//   - The DOM/visual render-compare of the AG-UI interactive layer (tool-call
//     chips, HITL, RUN_ERROR, the change-diff component) — the components land
//     in S4 (#1220); this slice schema-locks their wire fixtures now.
//
// REGENERATING BASELINES (documented + regenerable — see README.md):
//   - HTML + detection goldens:  RENDER_PARITY_UPDATE=1 pnpm test:e2e:design
//   - Visual snapshot baselines: RENDER_PARITY_VISUAL=1 pnpm test:e2e:design:update
//   The visual layer is OPT-IN (RENDER_PARITY_VISUAL) so cross-OS anti-aliasing
//   drift never blocks the deterministic parity gate; the DOM-normalized compare
//   is the hard gate, visual snapshots are regenerable supporting evidence.
// ---------------------------------------------------------------------------

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { test, expect } from "@playwright/test";

import {
  analyzeEventLog,
  isAgUiEvent,
} from "@cinatra-ai/agent-ui-protocol/conformance";

import {
  ALL_CONTENT_CASES,
  CONTENT_CASES,
  THEMES,
  AG_UI_CORPUS,
} from "./corpus";
import { REFERENCE_TARGET } from "./targets/packaged-renderer-target";
import type { RenderTheme } from "./targets/target";
import { domNormalize } from "./normalize";

// Local renderable-view helpers. The renderable-view GUARDS + the registered
// view schemas are owned by the S4 lane (#1220) and land with its
// renderable-view module; S6 reads the wire discriminator directly so the
// corpus schema-lock below does not depend on S4's unmerged exports. When S4
// merges, its `isRenderableViewDataPart` / `renderableViewType` (identical
// semantics) supersede these, and the render-compare of the view components
// plugs into the target seam.
function readViewType(data: unknown): string | undefined {
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    const vt = (data as { viewType?: unknown }).viewType;
    if (typeof vt === "string" && vt.length > 0) return vt;
  }
  return undefined;
}
function isRenderableViewDataPart(event: {
  type?: unknown;
  data?: unknown;
}): boolean {
  return event.type === "DATA_PART" && readViewType(event.data) !== undefined;
}

const GOLDEN_DIR = join(__dirname, "__goldens__");
const CONTENT_GOLDEN_DIR = join(GOLDEN_DIR, "content");
const DETECTION_GOLDEN = join(GOLDEN_DIR, "embeds.detection.json");

const UPDATE = !!process.env.RENDER_PARITY_UPDATE;
const VISUAL = !!process.env.RENDER_PARITY_VISUAL;

function contentGoldenPath(name: string, theme: RenderTheme): string {
  return join(CONTENT_GOLDEN_DIR, `${name}.${theme}.html`);
}

// Minimal, self-contained styling for the OPT-IN visual layer — enough to give
// tables, code, blockquotes and rules deterministic structure without pulling
// the whole app shell (full-fidelity token styling is the live-run slice, which
// drives the real running surface). Kept tiny + inline so the visual baseline
// is reproducible from this file alone.
function visualDocument(html: string, theme: RenderTheme): string {
  const dark = theme === "github-dark";
  const bg = dark ? "#0d1117" : "#ffffff";
  const fg = dark ? "#e6edf3" : "#1f2328";
  const line = dark ? "#30363d" : "#d0d7de";
  const codeBg = dark ? "#161b22" : "#f6f8fa";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    body { margin: 0; padding: 24px; background: ${bg}; color: ${fg};
      font-family: -apple-system, system-ui, sans-serif; font-size: 15px; line-height: 1.6; }
    .render-parity-surface { max-width: 760px; }
    h1,h2,h3 { line-height: 1.25; margin: 1.2em 0 0.5em; }
    table { border-collapse: collapse; margin: 1em 0; }
    th, td { border: 1px solid ${line}; padding: 6px 12px; }
    pre { background: ${codeBg}; border: 1px solid ${line}; border-radius: 6px;
      padding: 12px; overflow-x: auto; }
    code { font-family: ui-monospace, monospace; }
    :not(pre) > code { background: ${codeBg}; border-radius: 4px; padding: 1px 4px; }
    blockquote { border-left: 3px solid ${line}; margin: 1em 0; padding: 0 1em; color: ${fg}; opacity: .85; }
    hr { border: 0; border-top: 1px solid ${line}; margin: 1.5em 0; }
    a { color: ${dark ? "#4493f8" : "#0969da"}; }
  </style></head><body><div class="render-parity-surface">${html}</div></body></html>`;
}

// ---------------------------------------------------------------------------
// 1. Content render parity — DOM-normalized compare vs the S3 reference target.
// ---------------------------------------------------------------------------
test.describe("content render parity — S3 packaged renderer (DOM-normalized)", () => {
  for (const testCase of ALL_CONTENT_CASES) {
    for (const theme of THEMES) {
      test(`${testCase.name} · ${theme}`, async ({ page }) => {
        const { html } = REFERENCE_TARGET.renderContent(testCase.source, theme);
        const goldenPath = contentGoldenPath(testCase.name, theme);

        if (UPDATE) {
          mkdirSync(CONTENT_GOLDEN_DIR, { recursive: true });
          writeFileSync(goldenPath, html);
        }

        expect(
          existsSync(goldenPath),
          `missing golden ${goldenPath} — regenerate with RENDER_PARITY_UPDATE=1`,
        ).toBe(true);

        const golden = readFileSync(goldenPath, "utf8");
        // Genuine DOM normalization: the browser's own parser builds both trees,
        // then re-serializes them canonically (sorted attrs, collapsed ws).
        const normalizedCandidate = await page.evaluate(domNormalize, html);
        const normalizedGolden = await page.evaluate(domNormalize, golden);

        expect(
          normalizedCandidate,
          `render-parity drift in "${testCase.name}" (${theme}) — the S3 renderer's ` +
            `DOM diverged from the committed golden. If intentional, regenerate ` +
            `with RENDER_PARITY_UPDATE=1. Covers: ${testCase.covers.join(", ")}`,
        ).toBe(normalizedGolden);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// 2. Embed-detection parity — chart/mermaid detection + schema validation.
// ---------------------------------------------------------------------------
test.describe("embed-detection parity", () => {
  test("charts + mermaid are detected and schema-validated, locked to a golden", () => {
    const embedsCase = CONTENT_CASES.find((c) => c.name === "embeds");
    expect(embedsCase, "embeds fixture missing").toBeTruthy();

    const { charts, mermaid } = REFERENCE_TARGET.renderContent(
      embedsCase!.source,
      "github-light",
    );

    // Structural expectations independent of the golden: one valid chart (spec
    // parsed), one invalid chart (schema-rejected → spec null, rendered as an
    // error not a crash), one mermaid block.
    expect(charts.length).toBe(2);
    expect(charts.filter((c) => c.spec !== null).length).toBe(1);
    expect(charts.filter((c) => c.spec === null).length).toBe(1);
    expect(mermaid.length).toBe(1);

    const actual = JSON.stringify({ charts, mermaid }, null, 2);
    if (UPDATE) {
      mkdirSync(GOLDEN_DIR, { recursive: true });
      writeFileSync(DETECTION_GOLDEN, `${actual}\n`);
    }
    expect(
      existsSync(DETECTION_GOLDEN),
      `missing ${DETECTION_GOLDEN} — regenerate with RENDER_PARITY_UPDATE=1`,
    ).toBe(true);
    expect(`${actual}\n`).toBe(readFileSync(DETECTION_GOLDEN, "utf8"));
  });
});

// ---------------------------------------------------------------------------
// 3. AG-UI corpus schema conformance — lock the S1 event sequences + change-diff.
// ---------------------------------------------------------------------------
test.describe("AG-UI corpus schema conformance (S1 contract lock)", () => {
  // Shape lock: the exact event-TYPE sequence of each known scenario, so a
  // reorder / insertion / deletion in the reused S1 corpus is caught (schema
  // validity alone would let a resequenced log pass). Payload-level detail is
  // deliberately not frozen here — S1 owns the fixtures and S4 owns the
  // concrete view schema; this locks the wire SHAPE S6 renders.
  const EXPECTED_SEQUENCES: Record<string, readonly string[]> = {
    full_turn: [
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "TOOL_CALL_START",
      "TOOL_CALL_END",
      "DATA_PART",
      "RUN_FINISHED",
    ],
    interrupt_resume: ["RUN_STARTED", "INTERRUPT", "RESUME", "RUN_FINISHED"],
    run_error: [
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_ERROR",
    ],
    streaming_partial: [
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
    ],
    unknown_renderable_view: [
      "RUN_STARTED",
      "DATA_PART",
      "DATA_PART",
      "RUN_FINISHED",
    ],
  };

  test("each known scenario matches its locked event-type sequence", () => {
    for (const [name, sequence] of Object.entries(EXPECTED_SEQUENCES)) {
      expect(AG_UI_CORPUS[name], `scenario "${name}" missing from corpus`).toBeTruthy();
      expect(
        AG_UI_CORPUS[name].map((e) => e.type),
        `event-type sequence drift in "${name}"`,
      ).toEqual(sequence);
    }
  });

  test("every event in every corpus log is a valid AG-UI wire event", () => {
    for (const [name, log] of Object.entries(AG_UI_CORPUS)) {
      const analysis = analyzeEventLog(log);
      expect(analysis.invalidIndices, `invalid events in "${name}"`).toEqual([]);
      expect(analysis.unknownTypes, `unknown types in "${name}"`).toEqual([]);
      for (const event of log) {
        expect(isAgUiEvent(event), `bad event in "${name}"`).toBe(true);
      }
    }
  });

  test("turn-shape diagnostics match the documented scenarios", () => {
    expect(analyzeEventLog(AG_UI_CORPUS.full_turn).complete).toBe(true);

    const runError = analyzeEventLog(AG_UI_CORPUS.run_error);
    expect(runError.terminal).toBe("RUN_ERROR");

    // A mid-flight capture is valid (no invalid indices) but NOT a complete
    // turn — the streaming/partial (resumed) render-parity case.
    const partial = analyzeEventLog(AG_UI_CORPUS.streaming_partial);
    expect(partial.invalidIndices).toEqual([]);
    expect(partial.complete).toBe(false);
    expect(partial.terminal).toBeNull();

    expect(analyzeEventLog(AG_UI_CORPUS.interrupt_resume).complete).toBe(true);
    expect(analyzeEventLog(AG_UI_CORPUS.unknown_renderable_view).complete).toBe(
      true,
    );
  });

  test("the change-diff is carried as a well-formed renderable-view DATA_PART", () => {
    // The change-diff (S4's named deliverable) rides the one wire as a typed
    // DATA_PART whose viewType S4 registers. This slice locks its wire shape.
    const dataPart = AG_UI_CORPUS.full_turn.find(
      (e) => e.type === "DATA_PART" && isRenderableViewDataPart(e),
    );
    expect(dataPart, "full_turn carries no renderable-view DATA_PART").toBeTruthy();
    expect(dataPart!.type).toBe("DATA_PART");

    const data = (dataPart as { data: Record<string, unknown> }).data;
    expect(readViewType(data)).toBe("content_change_proposal");

    // The change-diff payload shape S4's renderer consumes (before/after fields).
    const fields = data.fields as Array<Record<string, unknown>>;
    expect(Array.isArray(fields)).toBe(true);
    expect(fields.length).toBeGreaterThan(0);
    for (const f of fields) {
      expect(typeof f.field).toBe("string");
      expect(typeof f.before).toBe("string");
      expect(typeof f.after).toBe("string");
    }
    expect(typeof data.rich).toBe("boolean");
  });

  test("an unknown renderable-view viewType is a safe forward-compat fallback", () => {
    // A DATA_PART whose viewType is not (yet) registered is still a valid
    // renderable view on the wire; a conforming renderer falls back rather than
    // crashing. A plain DATA_PART with no viewType is not a renderable view.
    const events = AG_UI_CORPUS.unknown_renderable_view;

    const unknownView = events.find(
      (e) => e.type === "DATA_PART" && readViewType((e as { data: unknown }).data) === "future_view_not_yet_registered",
    );
    expect(unknownView, "no unknown renderable-view fixture").toBeTruthy();
    expect(isRenderableViewDataPart(unknownView!)).toBe(true);

    const plainDataPart = events.find(
      (e) => e.type === "DATA_PART" && readViewType((e as { data: unknown }).data) === undefined,
    );
    expect(plainDataPart, "no plain DATA_PART fixture").toBeTruthy();
    expect(isRenderableViewDataPart(plainDataPart!)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Visual baseline (OPT-IN — regenerable supporting evidence, not the gate).
//    Enabled with RENDER_PARITY_VISUAL=1 so cross-OS AA drift never blocks the
//    deterministic DOM-normalized parity gate above.
// ---------------------------------------------------------------------------
test.describe("content render parity — visual snapshots (opt-in)", () => {
  test.skip(
    !VISUAL,
    "visual baselines are opt-in (RENDER_PARITY_VISUAL=1); the DOM-normalized " +
      "compare is the enforced gate. Regenerate with " +
      "RENDER_PARITY_VISUAL=1 pnpm test:e2e:design:update.",
  );

  for (const testCase of CONTENT_CASES) {
    for (const theme of THEMES) {
      test(`${testCase.name} · ${theme}`, async ({ page }) => {
        const { html } = REFERENCE_TARGET.renderContent(testCase.source, theme);
        await page.setContent(visualDocument(html, theme), { waitUntil: "load" });
        await expect(page).toHaveScreenshot(
          `render-parity-${testCase.name}-${theme}.png`,
          { fullPage: true },
        );
      });
    }
  }
});
