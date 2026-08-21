// ---------------------------------------------------------------------------
// THE RECORDER RUN — drive one real conversation turn per cell, then let the
// SHIPPED recorder observe the screen it produced (cinatra#2825, S9l).
//
// There is one way to make a record and it is a browser: this file drives the
// turn and hands the live page to `observeCapture`
// (scripts/audit/lib/chat-hitl-capture-recorder.mjs) through the shipped
// `playwrightPage` port (scripts/audit/lib/chat-hitl-capture-driver.mjs). It
// passes NO counts, NO anchors and NO URL: everything written into a record is
// read off the page by the recorder, measured twice, and refused if the screen
// moved between the measurement and the shutter.
//
// The framing is fixed for every cell — one viewport, `deviceScaleFactor: 2`,
// uncropped — so the paired layout cells can be read side by side.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

import { playwrightPage } from "../../../scripts/audit/lib/chat-hitl-capture-driver.mjs";
import { observeCapture } from "../../../scripts/audit/lib/chat-hitl-capture-recorder.mjs";

const REPO_ROOT = process.env.CAP_REPO_ROOT;
const IDS = JSON.parse(fs.readFileSync(process.env.IDS_JSON, "utf8"));
const PLAN = JSON.parse(fs.readFileSync(process.env.CAP_PLAN, "utf8"));
const OUT = process.env.CAP_OUT;
const VIEWPORT = { width: Number(process.env.VIEWPORT_W ?? 1440), height: Number(process.env.VIEWPORT_H ?? 1120) };

const records = [];
const results = [];

for (const cell of PLAN.cells) {
  const base = cell.base;
  const host = new URL(base).hostname;
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 });
  await ctx.addCookies(
    IDS.cookie.split("; ").map((c) => {
      const i = c.indexOf("=");
      return { name: c.slice(0, i), value: c.slice(i + 1), domain: host, path: "/" };
    }),
  );
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));

  await page.goto(`${base}/chat`, { waitUntil: "domcontentloaded", timeout: 240000 });
  await page.locator('[data-testid="chat-prompt-input"]').waitFor({ state: "visible", timeout: 180000 });
  await page.waitForTimeout(2500);

  const editor = page.locator('[data-testid="chat-prompt-input"]');
  await editor.click();
  for (const piece of cell.message.split(/(?<=\s)/)) {
    await page.keyboard.type(piece, { delay: 12 });
    if (piece.trimEnd().startsWith("@")) await page.keyboard.press("Escape");
  }
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Send message" }).click();

  let sawCard = true;
  try {
    await page.locator('[data-lifecycle-card="artifact_review_gate"]').first()
      .waitFor({ state: "attached", timeout: cell.waitMs ?? 90000 });
  } catch { sawCard = false; }
  // The card resolves its own state server-side after it mounts; settle so the
  // recorder's two measurements bracket a screen that has stopped moving.
  await page.waitForTimeout(cell.settleMs ?? 14000);

  const record = await observeCapture({
    page: playwrightPage(page),
    cell: cell.cell,
    declaredHost: "chat_thread",
    kind: "artifact_review_gate",
    state: "pending",
    screenshot: cell.screenshot,
    build: "development",
    repoRoot: REPO_ROOT,
  });
  records.push(record);

  const abs = path.join(REPO_ROOT, cell.screenshot);
  const bytes = fs.readFileSync(abs);
  results.push({
    cell: cell.cell,
    message: cell.message,
    sawCard,
    finalUrl: record.finalUrl,
    pixels: { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) },
    sha256: record.sha256,
    turnText: await page.evaluate(() => {
      const list = document.querySelector("[data-conversation-list]");
      return list ? list.innerText.slice(0, 1400) : "";
    }),
    pageErrors,
  });
  console.log(`CAP ${cell.cell} -> ${record.finalUrl} (${records.at(-1).assertions.length} anchors)`);
  await browser.close();
}

fs.writeFileSync(OUT, JSON.stringify({ records, results }, null, 2));
console.log(`wrote ${records.length} record(s) to ${OUT}`);
