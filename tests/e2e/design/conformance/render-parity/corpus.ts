// ---------------------------------------------------------------------------
// Render-parity fixture corpus (cinatra#1222, epic #1216 S6).
//
// ONE corpus, three fixture families, covering the epic's render-parity
// checklist for the STATIC-FIXTURE slice:
//
//   1. CONTENT_CASES — markdown the S3 packaged renderer renders TODAY:
//      paragraphs, nested/ordered/task lists, GFM tables, inline + fenced code
//      (syntax highlight), KaTeX math, links (external / app-route / mailto /
//      unsafe-dropped), blockquotes, headings, strikethrough, rules, plus the
//      chart/mermaid DETECTION embeds. Rendered through the reference target and
//      DOM-normalized-compared against committed goldens (both themes).
//
//   2. HOSTILE_CASES — the hostile/streaming-partial set: unsafe links/schemes,
//      raw HTML (escaped), broken/unterminated fences, incomplete math/mermaid/
//      chart embeds mid-stream, and a mid-flight streaming capture. Same render +
//      DOM-normalized compare — the point is that hostile input renders SAFELY
//      and DETERMINISTICALLY, not that it renders "nicely".
//
//   3. AG_UI_CORPUS — the AG-UI event sequences + the change-diff DATA_PART
//      payload, REUSED from the S1 conformance surface (#1217,
//      `@cinatra-ai/agent-ui-protocol/conformance` `CONFORMANCE_CORPUS`) whose authors built
//      it FOR this stage. The AG-UI interactive layer is not in the packaged
//      renderer yet (S4 lands the components; S2/S5 land the live run), so this
//      slice SCHEMA-LOCKS the corpus against the S1 contract — the DOM/visual
//      render-compare of these plugs in when S4/live-run arrives.
//
// Content sources live as `.md` files beside this module so they diff cleanly
// and can be edited without touching TypeScript.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CONFORMANCE_CORPUS,
  type ConformanceCorpus,
} from "@cinatra-ai/agent-ui-protocol/conformance";

import type { RenderTheme } from "./targets/target";

// The Playwright/tsx runner transforms these suite modules as CJS (base.ts
// relies on `__dirname` too), so anchor fixture reads to `__dirname` — NOT
// `import.meta.url`, which is undefined under that transform.
const HERE = __dirname;

/** Both themes the content corpus is rendered + baselined at. */
export const THEMES: readonly RenderTheme[] = ["github-light", "github-dark"];

/** A single content fixture: a named markdown source rendered through a target. */
export type ContentCase = {
  /** Stable case id — also the golden/baseline file stem. */
  readonly name: string;
  /** Which render-parity checklist items this case exercises (for reports). */
  readonly covers: readonly string[];
  /** The markdown source. */
  readonly source: string;
};

function loadFixture(family: "content" | "hostile", file: string): string {
  return readFileSync(join(HERE, "fixtures", family, file), "utf8");
}

/** The well-formed content corpus — renders cleanly through the S3 renderer. */
export const CONTENT_CASES: readonly ContentCase[] = [
  {
    name: "formatting",
    covers: [
      "paragraphs",
      "headings",
      "inline-code",
      "strikethrough",
      "links-external",
      "links-app-route",
      "links-mailto",
      "blockquotes",
      "horizontal-rule",
    ],
    source: loadFixture("content", "formatting.md"),
  },
  {
    name: "lists",
    covers: ["nested-lists", "ordered-lists", "task-lists", "inline-code"],
    source: loadFixture("content", "lists.md"),
  },
  {
    name: "tables",
    covers: ["gfm-tables", "table-alignment"],
    source: loadFixture("content", "tables.md"),
  },
  {
    name: "code",
    covers: ["fenced-code-highlight", "fenced-code-no-language", "inline-code"],
    source: loadFixture("content", "code.md"),
  },
  {
    name: "math",
    covers: ["katex-inline", "katex-display"],
    source: loadFixture("content", "math.md"),
  },
  {
    name: "embeds",
    covers: ["chart-embed", "mermaid-embed", "chart-embed-invalid"],
    source: loadFixture("content", "embeds.md"),
  },
];

/** The hostile / streaming-partial corpus — must render SAFELY + deterministically. */
export const HOSTILE_CASES: readonly ContentCase[] = [
  {
    name: "unsafe-links",
    covers: [
      "unsafe-scheme-dropped",
      "protocol-relative-blocked",
      "backslash-obfuscation-blocked",
      "unsafe-image-dropped",
    ],
    source: loadFixture("hostile", "unsafe-links.md"),
  },
  {
    name: "raw-html",
    covers: ["raw-html-escaped", "event-handler-neutralized"],
    source: loadFixture("hostile", "raw-html.md"),
  },
  {
    name: "broken-fences",
    covers: ["unterminated-code-fence"],
    source: loadFixture("hostile", "broken-fences.md"),
  },
  {
    name: "incomplete-embeds",
    covers: [
      "incomplete-math-trimmed",
      "incomplete-mermaid-trimmed",
      "incomplete-chart-trimmed",
    ],
    source: loadFixture("hostile", "incomplete-embeds.md"),
  },
  {
    name: "streaming-partial",
    covers: ["mid-stream-truncation", "partial-table", "partial-list"],
    source: loadFixture("hostile", "streaming-partial.md"),
  },
];

/** Every content-family case (well-formed + hostile) the render compare covers. */
export const ALL_CONTENT_CASES: readonly ContentCase[] = [
  ...CONTENT_CASES,
  ...HOSTILE_CASES,
];

/**
 * The AG-UI event-sequence + change-diff corpus, reused verbatim from the S1
 * conformance surface. Keyed by scenario name; each value is an ordered
 * `readonly AgUiEvent[]`. This slice schema-locks it against the S1 contract;
 * the render compare of these plugs in with S4's components + the live run.
 */
export const AG_UI_CORPUS: ConformanceCorpus = CONFORMANCE_CORPUS;
