// ---------------------------------------------------------------------------
// Render-parity LIVE-compare normalization proof (cinatra#1222, epic S6).
//
// The live-run `/chat` target (S2-enabled — tests/e2e/agents-run/
// chat-render-parity.spec.ts) drives the REAL running `/chat` and DOM-normalized
// -compares its rendered content against the SAME committed goldens the static
// slice locked. Ten of the eleven content/hostile fixtures render byte-identical
// inner HTML on the live surface (the same `renderMarkdown` the reference target
// calls, wrapped by chat-messages-view). The ONE exception is `code`: `/chat`
// asynchronously hydrates each `.chat-code-block` placeholder into shiki-
// highlighted markup, so its live DOM legitimately diverges from the golden's
// PRE-hydration placeholder. `canonicalizeCodeBlocks` (normalize.ts) reconciles
// that boundary by collapsing every code block — placeholder OR hydrated — to
// one `(language, source)` marker, applied SYMMETRICALLY to golden + candidate.
//
// This spec is the DETERMINISTIC, server-free proof of that reconciliation. It
// rides `design-conformance-functional` (pure Node + a headless DOM parse, no
// app navigation) so the live compare's one piece of novel logic is verified in
// per-PR CI — the browser-driven live run itself is the gated agents-run spec.
// It proves the canonicalizer is (1) INVARIANT to the exact shiki hydration
// mutation chat-messages-view performs, (2) a NO-OP on code-free fixtures (so
// non-code parity stays plain `domNormalize`, unchanged from the static gate),
// and (3) still SENSITIVE to a real source/language divergence (it neutralizes
// only the highlight-span layer, never masks a content drift).
// ---------------------------------------------------------------------------

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { test, expect } from "@playwright/test";

import { ALL_CONTENT_CASES, THEMES } from "./corpus";
import type { RenderTheme } from "./targets/target";
import { domNormalize, canonicalizeCodeBlocks } from "./normalize";

const CONTENT_GOLDEN_DIR = join(__dirname, "__goldens__", "content");

function goldenPath(name: string, theme: string): string {
  return join(CONTENT_GOLDEN_DIR, `${name}.${theme}.html`);
}

// Self-contained (page-evaluable) emulation of the REAL shiki hydration swap in
// packages/chat/src/chat-messages-view.tsx (the effect at ~L871-893): for each
// `[data-shiki-code]` placeholder, replace its `<pre>` with a shiki-highlighted
// `<pre>` whose token spans PRESERVE the source text, then remove the
// `data-shiki-code` attribute (leaving `data-shiki-lang`/`data-shiki-theme`).
// The token markup here is representative, not shiki's exact output — the point
// is that arbitrary highlight spans (with the same textContent) must canonicalize
// to the same marker as the placeholder, which is the property the live compare
// relies on.
function simulateShikiHydration(html: string): string {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  tpl.content.querySelectorAll<HTMLElement>("[data-shiki-code]").forEach((el) => {
    const code = decodeURIComponent(el.getAttribute("data-shiki-code") ?? "");
    const pre = el.querySelector("pre");
    if (!pre) return;
    const shikiPre = document.createElement("pre");
    shikiPre.className = "shiki";
    shikiPre.setAttribute("style", "background-color:#0d1117;color:#e6edf3");
    // A few representative layout classes the real effect re-adds — their exact
    // set is immaterial to this proof (the canonicalizer discards the block's
    // internals), so the arbitrary `text-[…]` token is intentionally omitted.
    shikiPre.classList.add("overflow-x-auto", "whitespace-pre", "p-4", "leading-relaxed", "font-mono");
    const codeEl = document.createElement("code");
    const lines = code.split("\n");
    lines.forEach((line, i) => {
      const lineSpan = document.createElement("span");
      lineSpan.className = "line";
      const tok = document.createElement("span");
      tok.setAttribute("style", "color:#79c0ff");
      tok.textContent = line; // preserves the exact source text
      lineSpan.appendChild(tok);
      codeEl.appendChild(lineSpan);
      if (i < lines.length - 1) codeEl.appendChild(document.createTextNode("\n"));
    });
    shikiPre.appendChild(codeEl);
    pre.replaceWith(shikiPre);
    el.removeAttribute("data-shiki-code"); // exactly as the real effect does
  });
  return tpl.innerHTML;
}

// Perturb the FIRST code block's SOURCE (negative control): proves the
// canonicalizer neutralizes only the highlight layer, never a real content
// divergence. Mutates the actual source text the canonicalizer reads (the
// <pre>'s textContent), not an attribute it ignores.
function perturbFirstCodeSource(html: string): string {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const el = tpl.content.querySelector<HTMLElement>(".chat-code-block");
  if (el) {
    const codeEl = el.querySelector("code") ?? el.querySelector("pre");
    if (codeEl) {
      codeEl.textContent = `${codeEl.textContent ?? ""}\nconst injected = "drift";`;
    }
  }
  return tpl.innerHTML;
}

// Flip the FIRST code block's declared theme (negative control): proves a real
// code-THEME divergence still fails — the canonicalizer keeps `data-shiki-theme`
// (present in both the placeholder and the hydrated shape).
function flipFirstCodeTheme(html: string): string {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const el = tpl.content.querySelector<HTMLElement>(".chat-code-block[data-shiki-theme]");
  if (el) {
    const t = el.getAttribute("data-shiki-theme");
    el.setAttribute("data-shiki-theme", t === "github-dark" ? "github-light" : "github-dark");
  }
  return tpl.innerHTML;
}

// Append TWO trailing newlines to the FIRST code block's source: pins the
// single-newline normalization (`/\n$/`) — a regression back to `/\n+$/` would
// mask this multi-trailing-newline drift, which this control catches.
function appendTrailingNewlines(html: string): string {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const el = tpl.content.querySelector<HTMLElement>(".chat-code-block");
  if (el) {
    const codeEl = el.querySelector("code") ?? el.querySelector("pre");
    if (codeEl) codeEl.textContent = `${codeEl.textContent ?? ""}\n\n`;
  }
  return tpl.innerHTML;
}

async function canon(page: import("@playwright/test").Page, html: string): Promise<string> {
  const canonicalized = await page.evaluate(canonicalizeCodeBlocks, html);
  return page.evaluate(domNormalize, canonicalized);
}

// Enumerate every committed golden and split by whether it renders a
// `.chat-code-block` placeholder (carries `data-shiki-code`). This is NOT only
// the `code` fixture: the hostile `broken-fences` and `incomplete-embeds`
// fixtures intentionally render an unterminated fence as a code block too — so
// the live compare canonicalizes ALL fixtures uniformly, and this proof covers
// every code-bearing golden, not a hand-picked one.
type GoldenRef = { name: string; theme: RenderTheme; path: string };
const ALL_GOLDENS: GoldenRef[] = ALL_CONTENT_CASES.flatMap((c) =>
  THEMES.map((theme) => ({ name: c.name, theme, path: goldenPath(c.name, theme) })),
).filter((g) => existsSync(g.path));
const CODE_BEARING = ALL_GOLDENS.filter((g) =>
  readFileSync(g.path, "utf8").includes("data-shiki-code"),
);
const CODE_FREE = ALL_GOLDENS.filter(
  (g) => !readFileSync(g.path, "utf8").includes("chat-code-block"),
);

test.describe("render-parity live-compare normalization (canonicalizeCodeBlocks)", () => {
  test("the corpus still renders code-block placeholders to reconcile", () => {
    expect(
      CODE_BEARING.length,
      "no golden carries a shiki placeholder — the live hydration invariant this " +
        "spec proves would not apply (corpus drift?)",
    ).toBeGreaterThan(0);
    // The known code-bearing set: `code` + the two hostile fence fixtures.
    expect(new Set(CODE_BEARING.map((g) => g.name))).toEqual(
      new Set(["code", "broken-fences", "incomplete-embeds"]),
    );
  });

  for (const g of CODE_BEARING) {
    test(`INVARIANT · golden == its hydrated form after canonicalization · ${g.name} · ${g.theme}`, async ({
      page,
    }) => {
      const golden = readFileSync(g.path, "utf8");
      const hydrated = await page.evaluate(simulateShikiHydration, golden);

      // Sanity: the emulation mutated the DOM the way the real effect does —
      // every data-shiki-code gone, a shiki <pre> present.
      expect(hydrated.includes("data-shiki-code"), "emulation left data-shiki-code").toBe(false);
      expect(hydrated.includes('class="shiki'), "emulation added no shiki <pre>").toBe(true);

      const normGolden = await canon(page, golden);
      const normHydrated = await canon(page, hydrated);

      expect(
        normHydrated,
        `canonicalizeCodeBlocks is NOT invariant to shiki hydration (${g.name}, ` +
          `${g.theme}) — the live /chat code-block compare would false-positive ` +
          `on the highlight layer the static gate deliberately excludes`,
      ).toBe(normGolden);
    });
  }

  test("SENSITIVE · a real source divergence survives canonicalization (negative control)", async ({
    page,
  }) => {
    const golden = readFileSync(goldenPath("code", "github-light"), "utf8");
    // Perturb IN THE PAGE (the helper uses DOM globals).
    const drifted = await page.evaluate(perturbFirstCodeSource, golden);
    expect(drifted, "perturbation did not change the source").not.toBe(golden);

    const normGolden = await canon(page, golden);
    const normDrifted = await canon(page, drifted);

    expect(
      normDrifted,
      "canonicalizeCodeBlocks washed away a real code-source change — it must " +
        "neutralize ONLY the highlight spans, never the source/language",
    ).not.toBe(normGolden);
  });

  test("SENSITIVE · a real code-theme divergence survives canonicalization (negative control)", async ({
    page,
  }) => {
    const golden = readFileSync(goldenPath("code", "github-light"), "utf8");
    const flipped = await page.evaluate(flipFirstCodeTheme, golden);
    expect(flipped, "theme flip did not change the html").not.toBe(golden);

    const normGolden = await canon(page, golden);
    const normFlipped = await canon(page, flipped);

    expect(
      normFlipped,
      "canonicalizeCodeBlocks washed away a real code-theme change — it must keep " +
        "data-shiki-theme so a wrong-theme code render on the live surface fails",
    ).not.toBe(normGolden);
  });

  test("SENSITIVE · a multi-trailing-newline drift survives (pins /\\n$/ over /\\n+$/)", async ({
    page,
  }) => {
    const golden = readFileSync(goldenPath("code", "github-light"), "utf8");
    const extra = await page.evaluate(appendTrailingNewlines, golden);

    const normGolden = await canon(page, golden);
    const normExtra = await canon(page, extra);

    expect(
      normExtra,
      "a 2-trailing-newline source drift was masked — the normalization must strip " +
        "at MOST ONE trailing newline (regressed to /\\n+$/?)",
    ).not.toBe(normGolden);
  });

  for (const g of CODE_FREE) {
    test(`NO-OP · code-free fixture unchanged by canonicalization · ${g.name} · ${g.theme}`, async ({
      page,
    }) => {
      const golden = readFileSync(g.path, "utf8");
      const plain = await page.evaluate(domNormalize, golden);
      const viaCanon = await canon(page, golden);

      expect(
        viaCanon,
        `canonicalizeCodeBlocks changed a code-free fixture (${g.name}, ${g.theme}) ` +
          `— it must be a strict no-op when there is no .chat-code-block`,
      ).toBe(plain);
    });
  }
});
