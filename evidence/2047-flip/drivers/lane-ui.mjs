// cinatra#2047 activation-flip lane — isolated headless Chromium UI driver.
// Adapted from evidence/2047-d8/drivers/lane-ui.mjs; adds the approve action and
// the run-view chip-row actions the row-6 recommendation proof needs.
import { chromium } from "@playwright/test";
import fs from "node:fs";

const BASE = process.env.WALK_BASE ?? "http://localhost:3167";
const SHOTS = process.env.SHOTS;
const AGENT_PATH = process.env.AGENT_PATH ?? "/agents/cinatra-ai/blog-draft-writer-agent";
const [, , action, ...rest] = process.argv;
const ids = JSON.parse(fs.readFileSync(process.env.IDS_JSON, "utf8"));

const browser = await chromium.launch({ headless: true });
const cookies = ids.cookie.split("; ").map((c) => {
  const i = c.indexOf("=");
  return { name: c.slice(0, i), value: c.slice(i + 1), domain: "localhost", path: "/" };
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
await ctx.addCookies(cookies);
const page = await ctx.newPage();
page.on("console", (m) => {
  if (m.type() === "error") console.log("[browser:error]", m.text().slice(0, 250));
});

const shot = async (n) => {
  await page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true });
  console.log("SHOT", `${SHOTS}/${n}.png`);
};
const body = async (n = 3500) =>
  console.log("BODY", (await page.locator("body").innerText()).replace(/\n{2,}/g, "\n").slice(0, n));
const go = async (p) => {
  const r = await page.goto(BASE + p, { waitUntil: "domcontentloaded", timeout: 240000 });
  console.log("GOTO", p, r?.status());
  await page.waitForLoadState("load").catch(() => {});
  await page.waitForTimeout(6000);
};

try {
  if (action === "review") {
    const [runId, taskId, name] = rest;
    await go(`${AGENT_PATH}/${runId}/review/${encodeURIComponent(taskId)}`);
    await shot(name);
    await body();
  }

  if (action === "approve") {
    const [runId, taskId, name] = rest;
    await go(`${AGENT_PATH}/${runId}/review/${encodeURIComponent(taskId)}`);
    await shot(`${name}-before`);
    const btn = page.getByRole("button", { name: /^Approve$/i }).last();
    await btn.click();
    await page.waitForTimeout(9000);
    await shot(`${name}-after`);
    await body();
  }

  if (action === "request-changes") {
    const [runId, taskId, feedback, name] = rest;
    await go(`${AGENT_PATH}/${runId}/review/${encodeURIComponent(taskId)}`);
    await shot(`${name}-before`);
    const field = page.locator('[contenteditable="true"]').last();
    await field.click();
    await page.keyboard.type(feedback);
    await page.waitForTimeout(600);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(9000);
    await shot(`${name}-after`);
    await body();
  }

  // ── the run-start recommendation chip row (row-6 proof) ──────────────────
  if (action === "run-view") {
    const [runId, name] = rest;
    await go(`${AGENT_PATH}/${runId}`);
    await page.waitForTimeout(4000);
    await shot(name);
    const chip = page.locator("[data-run-recommendation-chip-row]");
    console.log("CHIP_ROW_COUNT", await chip.count());
    const decided = page.locator("[data-run-recommendation-decision]");
    console.log(
      "DECISION_ATTR",
      (await decided.count()) ? await decided.first().getAttribute("data-run-recommendation-decision") : null,
    );
    await body();
  }

  if (action === "confirm-selection") {
    const [runId, name] = rest;
    await go(`${AGENT_PATH}/${runId}`);
    await page.waitForTimeout(4000);
    const chip = page.locator("[data-run-recommendation-chip-row]");
    console.log("CHIP_ROW_COUNT", await chip.count());
    await shot(`${name}-before`);
    const confirm = page.getByRole("button", { name: /^Confirm/i }).last();
    await confirm.click();
    await page.waitForTimeout(9000);
    await shot(`${name}-after`);
    const decided = page.locator("[data-run-recommendation-decision]");
    console.log(
      "DECISION_ATTR",
      (await decided.count()) ? await decided.first().getAttribute("data-run-recommendation-decision") : null,
    );
    await body();
  }

  if (action === "pick-and-confirm") {
    const [runId, name] = rest;
    await go(`${AGENT_PATH}/${runId}`);
    await page.waitForTimeout(4000);
    const chip = page.locator("[data-run-recommendation-chip-row]");
    console.log("CHIP_ROW_COUNT", await chip.count());
    const skillBtn = page.locator("[data-skill-id]").first();
    console.log("SKILL_ID", await skillBtn.getAttribute("data-skill-id"));
    await skillBtn.click();
    await page.waitForTimeout(800);
    console.log("SKILL_SELECTED", await skillBtn.getAttribute("data-selected"));
    await shot(`${name}-before`);
    await page.locator('[data-action="confirm-run-recommendation"]').last().click();
    await page.waitForTimeout(9000);
    await shot(`${name}-after`);
    const decided = page.locator("[data-run-recommendation-decision]");
    console.log(
      "DECISION_ATTR",
      (await decided.count()) ? await decided.first().getAttribute("data-run-recommendation-decision") : null,
    );
    await body();
  }

  if (action === "page") {
    const [path, name] = rest;
    await go(path);
    await shot(name);
    await body(4000);
  }
} finally {
  await browser.close();
}
