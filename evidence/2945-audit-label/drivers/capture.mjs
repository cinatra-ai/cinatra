// ---------------------------------------------------------------------------
// cinatra#2945 — THE RE-SHOOT RECORDER.
//
// Adapted from evidence/2904-settled-gate-review-page/drivers/capture.mjs,
// which is adapted from evidence/2791-s9g-conformance's — the shipped shape. It
// drives a real browser against the running lane app and writes each cell's
// record through the SHIPPED observer (`observeCapture`) over the SHIPPED
// Playwright port (`playwrightPage`). Nothing about frames, URLs or counts is
// written by this file: a cell says WHICH page to open, which host it claims and
// which kind and state it photographs, and the observer measures the rest.
//
// WHAT THIS ROUND ADDS:
//
//   `chat`   — the chat cells are reached the way a person reaches them: the
//              browser opens `/chat`, TYPES a sentence into the composer and
//              presses Enter. The turn runs on the development runtime's
//              scripted model bridge, which calls the SHIPPED read-only
//              lifecycle pull primitives (`artifact_review_gates_list` then
//              `artifact_review_gate_render`) — so the card in the transcript is
//              produced by the app answering a real turn, not by a transcript
//              written into the store. What stands in is the ONE decision a
//              model makes on this path: which tool the turn calls.
//
//   `pressIndex` — §VIII decides PER CHIP, so a cell that dismisses the MIDDLE
//              suggestion has to name it. The pressable control is the `button`
//              INSIDE the block wrapper that carries the `data-action`; clicking
//              the wrapper does nothing.
//
//   `extraWithin` — the card root the cell's own extra anchors are counted in,
//              because this round photographs two different card kinds.
//
// The picture is the observer's own: a FULL-PAGE frame of the browser window,
// uncropped, at device scale 2. `finalUrl` has its origin removed and nothing
// else: the contract takes a repo-style path, every committed record carries one,
// and the origin is the one thing on this page that names the machine it ran on.
//
// Every origin, credential and path comes from the environment. Nothing about
// the lane host is written here.
// ---------------------------------------------------------------------------
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const pwModule = await import(process.env.CAP_PLAYWRIGHT);
const pw = pwModule.chromium ? pwModule : pwModule.default;
const { playwrightPage } = await import(
  path.join(process.env.CAP_REPO_ROOT, "scripts/audit/lib/chat-hitl-capture-driver.mjs")
);
const { observeCapture, captureRequirementsFor, validateCaptureRecord } = await import(
  path.join(process.env.CAP_REPO_ROOT, "scripts/audit/lib/chat-hitl-capture-recorder.mjs")
);

const BASE = process.env.CAP_BASE;
const REPO = process.env.CAP_REPO_ROOT;
const IDS = JSON.parse(fs.readFileSync(process.env.IDS_JSON, "utf8"));
const PLAN = JSON.parse(fs.readFileSync(process.env.CAP_PLAN, "utf8"));
const OUT = process.env.CAP_OUT_JSON;
const ONLY = process.env.CAP_ONLY ? new Set(process.env.CAP_ONLY.split(",")) : null;

const CHAT_PROMPT = '[data-testid="chat-prompt-input"]';

const cookies = IDS.cookie.split("; ").map((c) => {
  const i = c.indexOf("=");
  return { name: c.slice(0, i), value: c.slice(i + 1), domain: new URL(BASE).hostname, path: "/" };
});

/** The kind+state specs the CI half asks for that the host set does not carry. */
function extraSpecsFor(host, kind, state) {
  if (host === "chat_thread") return [];
  const base = captureRequirementsFor(host);
  const full = captureRequirementsFor(host, kind, state);
  const key = (s) => `${s.frame}::${s.scope}::${s.within ?? ""}::${s.selector}::${s.expect}`;
  const have = new Set(base.map(key));
  return full.filter((s) => !have.has(key(s)));
}

const sha = (rel) =>
  createHash("sha256").update(fs.readFileSync(path.join(REPO, rel))).digest("hex");

const records = [];
const failures = [];
const browser = await pw.chromium.launch({ headless: true });

for (const cell of PLAN) {
  if (ONLY && !ONLY.has(cell.cell)) continue;
  const ctx = await browser.newContext({
    viewport: { width: cell.width ?? 1228, height: cell.height ?? 1400 },
    deviceScaleFactor: 2,
    colorScheme: cell.dark ? "dark" : "light",
  });
  await ctx.addCookies(cookies);
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e).slice(0, 300)));
  const stripOverlay = () =>
    page.evaluate(() => document.querySelectorAll("nextjs-portal").forEach((n) => n.remove()));
  try {
    await page.goto(BASE + cell.path, { waitUntil: "domcontentloaded", timeout: 180000 });

    // THE CHAT TURN, typed by the browser into the app's own composer.
    if (cell.chat) {
      const prompt = page.locator(CHAT_PROMPT);
      await prompt.waitFor({ state: "visible", timeout: 180000 });
      // HYDRATION, waited for rather than assumed. The composer is painted by
      // the server render before React has attached to it, and text typed into
      // an unattached contentEditable is text the client never sees — the turn
      // is then never sent and the transcript never exists.
      await page.waitForTimeout(cell.hydrateMs ?? 10000);
      // The composer is `contentEditable="false"` until the client is ready and
      // whenever an SSE turn is active, so a press before that lands nowhere and
      // the turn is never sent. Polled, exactly as the shipped held-turn flow
      // polls it (tests/e2e/chat-hitl-held-turn/held-turn.spec.ts).
      const deadline = Date.now() + 120000;
      for (;;) {
        if (await prompt.isEditable().catch(() => false)) break;
        if (Date.now() > deadline) throw new Error("the chat composer never became editable");
        await page.waitForTimeout(1000);
      }
      await stripOverlay();
      await prompt.click();
      await page.keyboard.insertText(cell.chatMessage);
      await prompt.press("Enter");
      // The turn has to have STARTED before the card is waited for: the
      // transcript list itself does not exist until the thread carries a turn.
      await page.waitForSelector("[data-conversation-list]", { timeout: 300000 });
    }

    if (cell.waitFor) {
      await page.waitForSelector(cell.waitFor, { timeout: 180000 }).catch(() => {});
    }
    // THE TARGET ISLAND is a same-origin `<iframe>` with a document of its own,
    // and it paints well after the card does. Waited for so the card is
    // photographed WITH its target rather than with the island's placeholder —
    // a picture of a preview that had not arrived yet invites a finding about
    // the app that the app did not earn.
    const islandFrameEl = await page.$('[data-conformance-id="review-gate-card"] iframe');
    if (islandFrameEl) {
      const frame = await islandFrameEl.contentFrame();
      if (frame) {
        await frame
          .locator(
            '[data-conformance-id="review-target-island-body"], [data-conformance-id="review-target-island-empty"]',
          )
          .first()
          .waitFor({ state: "attached", timeout: 120000 })
          .catch(() => {});
      }
    }
    await page.waitForTimeout(cell.settleMs ?? 12000);
    await stripOverlay();

    // THE PER-CHIP PRESS, in the browser, on this screen.
    if (cell.press) {
      const target = page.locator(cell.press).nth(cell.pressIndex ?? 0);
      await target.waitFor({ state: "visible", timeout: 120000 });
      await target.click({ timeout: 60000 });
      await page.waitForTimeout(cell.afterPressMs ?? 4000);
    }

    if (cell.scrollToFoot) {
      await page.evaluate(() => {
        const l = document.querySelector("[data-conversation-list]");
        for (const el of [l, l?.closest("[class*=overflow]"), l?.parentElement]) {
          if (el) el.scrollTop = el.scrollHeight;
        }
      });
      await page.waitForTimeout(2000);
    }
    await stripOverlay();

    const documentClass = await page.evaluate(() => document.documentElement.className);

    const record = await observeCapture({
      page: playwrightPage(page),
      cell: cell.cell,
      declaredHost: cell.declaredHost,
      kind: cell.kind,
      state: cell.state,
      instance: cell.instance ?? null,
      screenshot: cell.screenshot,
      build: "development",
      extraAssertions: [
        ...extraSpecsFor(cell.declaredHost, cell.kind, cell.state),
        // The anchors THIS round is about, counted INSIDE the card's own root so
        // a marker borrowed from another card on the same screen cannot answer
        // for this one. Each carries its own `expect`, which is the cell's
        // CLAIM; `validateCaptureRecord` refuses the record when the page
        // disagrees, so the claim is checked against the screen rather than
        // written down beside it.
        ...(cell.extraAnchors ?? []).map(({ selector, expect }) => ({
          selector,
          scope: "root",
          within: cell.extraWithin,
          expect,
        })),
      ],
      repoRoot: REPO,
    });
    // THE ORIGIN, REMOVED — see the header. Done BEFORE validation, so what is
    // validated is what is written.
    try {
      const u = new URL(record.finalUrl);
      record.finalUrl = `${u.pathname}${u.search}${u.hash}`;
    } catch {}
    record.runtime = process.env.CAP_RUNTIME ?? "dev-runtime";
    if (cell.note) record.note = cell.note;
    const v = validateCaptureRecord(record, { hashOf: sha, tier: "audit" });
    if (v.length > 0) {
      failures.push({ cell: cell.cell, violations: v, documentClass, consoleErrors });
      console.log(`FAILED ${cell.cell}`);
      for (const line of v) console.log(`   ${JSON.stringify(line)}`);
    } else {
      records.push(record);
      console.log(
        `OK ${cell.cell} (${record.declaredHost}/${record.declaredKind}/${record.declaredState}) url=${record.finalUrl} errors=${consoleErrors.length}`,
      );
    }
  } catch (err) {
    failures.push({ cell: cell.cell, violations: [String(err?.message ?? err)], consoleErrors });
    console.log(`THREW ${cell.cell}: ${err?.message ?? err}`);
  } finally {
    await ctx.close();
  }
}

await browser.close();
const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : { records: [], failures: [] };
const merged = {
  records: [...prev.records.filter((r) => !records.some((n) => n.cell === r.cell)), ...records],
  failures,
};
fs.writeFileSync(OUT, JSON.stringify(merged, null, 2));
console.log(`RECORDS ${records.length} FAILURES ${failures.length}`);
