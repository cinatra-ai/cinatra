// GIVE THE AGENT A CANDIDATE SKILL, THROUGH THE APP'S OWN SCREEN
// (/configuration/skills -> Matches -> "Add a skill…" -> "Add skill").
//
// WHY: the run-start recommendation checkpoint fires for a human-present run, but
// `maybeHoldRunForRecommendation` only PARKS when the request-aware scorer returns
// a candidate — and a candidate has to be an assigned skill of that agent. Without
// one no run of it can ever hold, so the hold cell has nothing to photograph.
//
// The app's own action writes the match; this driver types and presses, then
// prints what it picked. Nothing is written to the database here.
//
//   env: WALK_BASE, LANE_ACCOUNT, LANE_SECRET, MATCH_AGENT_SLUG, MATCH_SKILL_NAME (optional)
import { chromium } from "@playwright/test";

const BASE = process.env.WALK_BASE;
const AGENT = process.env.MATCH_AGENT_SLUG;
if (!BASE || !AGENT) throw new Error("needs WALK_BASE and MATCH_AGENT_SLUG");
const browser = await chromium.launch();
const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 1100 } });
await ctx.request.post("/api/auth/sign-in/email", {
  headers: { Origin: BASE },
  data: { email: process.env.LANE_ACCOUNT, password: process.env.LANE_SECRET },
});
const page = await ctx.newPage();
page.setDefaultTimeout(240_000);
await page.goto("/configuration/skills", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);
await page.getByRole("tab", { name: /Matches/i }).first().click().catch(() => {});
await page.waitForTimeout(9000);
const slug = page.locator(`p:text-is("${AGENT}")`).first();
await slug.waitFor();
const card = slug.locator("xpath=ancestor::div[.//button[@role='combobox']][1]");
await card.locator('button[role="combobox"]').first().click();
await page.waitForTimeout(2500);
const options = await page.evaluate(() =>
  Array.from(document.querySelectorAll('[role="option"]')).map((o) => o.textContent.replace(/\s+/g, " ").trim()));
if (options.length === 0) { console.log("FAIL no skill options offered"); await browser.close(); process.exit(1); }
const want = process.env.MATCH_SKILL_NAME;
const pick = want && options.includes(want) ? want : options[0];
await page.getByRole("option", { name: pick, exact: true }).first().click();
await page.waitForTimeout(2000);
await card.getByRole("button", { name: "Add skill", exact: true }).first().click();
await page.waitForTimeout(9000);
console.log(`PASS picked "${pick}" for ${AGENT} and pressed Add skill on the app's own Matches tab`);
await browser.close();
