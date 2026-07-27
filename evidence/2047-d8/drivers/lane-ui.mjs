import { chromium } from "@playwright/test";
import fs from "node:fs";
const BASE = "http://localhost:3149";
const SHOTS = process.env.SHOTS;
const [, , action, ...rest] = process.argv;
const ids = JSON.parse(fs.readFileSync(process.env.IDS_JSON, "utf8"));
const browser = await chromium.launch({ headless: true });
const cookies = ids.cookie.split("; ").map((c) => { const i = c.indexOf("="); return { name: c.slice(0, i), value: c.slice(i + 1), domain: "localhost", path: "/" }; });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
await ctx.addCookies(cookies);
const page = await ctx.newPage();
page.on("console", (m) => { if (m.type() === "error") console.log("[browser:error]", m.text().slice(0, 250)); });
const shot = async (n) => { await page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true }); console.log("SHOT", `${SHOTS}/${n}.png`); };
const go = async (p) => { const r = await page.goto(BASE + p, { waitUntil: "domcontentloaded", timeout: 240000 }); console.log("GOTO", p, r?.status()); await page.waitForLoadState("load").catch(()=>{}); await page.waitForTimeout(6000); };
try {
  if (action === "review") {
    const [runId, taskId, name] = rest;
    await go(`/agents/cinatra-ai/blog-draft-writer-agent/${runId}/review/${encodeURIComponent(taskId)}`);
    await shot(name);
    console.log("BODY", (await page.locator("body").innerText()).replace(/\n{2,}/g, "\n").slice(0, 3500));
  }
  if (action === "request-changes") {
    const [runId, taskId, feedback, name] = rest;
    await go(`/agents/cinatra-ai/blog-draft-writer-agent/${runId}/review/${encodeURIComponent(taskId)}`);
    await shot(`${name}-before`);
    const field = page.locator('[contenteditable="true"]').last();
    await field.click();
    await page.keyboard.type(feedback);
    await page.waitForTimeout(600);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(9000);
    await shot(`${name}-after`);
    console.log("BODY", (await page.locator("body").innerText()).replace(/\n{2,}/g, "\n").slice(0, 3500));
  }
} finally { await browser.close(); }
