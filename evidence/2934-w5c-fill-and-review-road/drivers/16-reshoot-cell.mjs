// W5c picture leg — take ONE cell's pair and record what each frame shows.
//
// WHY A SHOOT-ONLY DRIVER, AND WHAT IT MAY NOT BE USED FOR. The turns are
// already in the run: §IX keeps the window's exchange WITH THE RUN, so
// re-opening the page draws the same exchange back. A frame can therefore be
// taken without sending anything, and nothing here types, presses or uploads —
// the run is read, never driven.
//
// IT MAY NOT TAKE A FILL CELL. What the RUN holds comes back on a fresh page;
// what the SCREEN holds does not. An unsubmitted fill is the second kind: the
// values live in the page that received the turn, and nothing re-applies them
// on mount (`use-run-window-conversation.ts` applies only what `send()`
// returned). A pair taken here for a fill cell therefore photographs empty
// fields under an answer that says they are filled, which is exactly what a
// graded review caught. Fill cells go through `18-cell-in-turn-context.mjs`,
// which takes the frame in the context that sent the turn.
//
// The pair itself is the capture library's (one context per theme, themed
// before the run page opens, the account footer waited for); what this file
// adds is the READBACK beside the picture: the window's own rows as the DOM
// holds them, the assistant's own markup — so "bold reads bold" has a DOM fact
// under it and not just a pixel — and, where the page has one, the geometry of
// the decision bar against the panel.
//   env: APP_ORIGIN, OWNER_EMAIL, OWNER_PW, CAPTURE_DIR, PAGE_PATH, CELL,
//        READBACK_NAME (optional), MEASURE_DECISION_BAR (optional)
import fs from "node:fs";
import path from "node:path";
import {
  OUT_DIR, openAs, openPanel, readWindow, stamp, waitForDrawnFrame, write,
} from "./03-capture-lib.mjs";

const PAGE_PATH = process.env.PAGE_PATH;
const CELL = process.env.CELL;
if (!PAGE_PATH || !CELL) throw new Error("16-reshoot-cell needs PAGE_PATH and CELL");

const record = { cell: CELL, path: PAGE_PATH, frames: [] };

for (const theme of ["light", "dark"]) {
  const { browser, page } = await openAs(
    process.env.OWNER_EMAIL, process.env.OWNER_PW, { theme },
  );
  await page.goto(PAGE_PATH, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(12_000);
  const settled = await waitForDrawnFrame(page);
  await openPanel(page);

  const win = await readWindow(page);
  // E — the ratified drawing puts the window BENEATH the decision bar, as two
  // stacked blocks. Where a decision bar is on the page, this measures whether
  // the panel stands over it, in pixels, rather than asserting it from a look.
  let decisionBar = null;
  if (process.env.MEASURE_DECISION_BAR) {
    decisionBar = await page.evaluate(() => {
      // The bar names itself: the rationale field carries the decision bar's own
      // test id, and the bar is the block that holds it.
      const rationale = document.querySelector("#review-rationale, [data-testid='review-rationale']");
      const bar = rationale
        ? rationale.closest("div[class*='rounded'], section, form") ?? rationale.parentElement
        : null;
      const scroll = document.querySelector("[data-run-window-scroll]");
      const panel = scroll ? scroll.closest("div[class*='rounded-panel']") ?? scroll : null;
      const rect = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) };
      };
      const b = rect(bar), p = rect(panel);
      if (!b || !p) return { bar: b, panel: p, overlapHeightPx: null, overlapWidthPx: null };
      return {
        bar: b, panel: p,
        barHeightPx: b.bottom - b.top,
        overlapHeightPx: Math.max(0, Math.min(b.bottom, p.bottom) - Math.max(b.top, p.top)),
        overlapWidthPx: Math.max(0, Math.min(b.right, p.right) - Math.max(b.left, p.left)),
        // Which of the two is painted on top, read off the page rather than guessed.
        panelZIndex: getComputedStyle(panel.parentElement ?? panel).zIndex,
        barCoveredAtItsOwnMiddle: (() => {
          const x = (b.left + b.right) / 2, y = (b.top + b.bottom) / 2;
          const hit = document.elementFromPoint(x, y);
          return Boolean(hit && panel.contains(hit));
        })(),
      };
    });
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${CELL}__${theme}.png`);
  await page.screenshot({ path: file });
  stamp("capture recorded", { file: path.basename(file), theme, footer: settled.footer, footerSettled: settled.settled });
  record.frames.push({
    theme,
    file: path.basename(file),
    accountFooter: settled.footer,
    footerSettled: settled.settled,
    footerWaitedMs: settled.waitedMs,
    windowPlaceholder: win.placeholder,
    bubbles: win.bubbles,
    decisionBar,
  });
  await browser.close();
}

if (process.env.READBACK_NAME) write(process.env.READBACK_NAME, record);
console.log(JSON.stringify(record.frames.map((f) => ({
  theme: f.theme, footer: f.accountFooter, bubbles: f.bubbles.length,
  assistantDrawn: f.bubbles.filter((b) => b.side === "assistant").map((b) => b.drawn),
  decisionBar: f.decisionBar,
})), null, 2));
