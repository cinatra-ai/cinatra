// ---------------------------------------------------------------------------
// THE CHAT DRIVER — one real conversation turn per cell, on the running app.
//
// Nothing here writes a transcript. It signs in with the lane session cookie,
// opens `/chat`, TYPES a message into the shipped composer and presses the
// shipped Send button. Everything after that is the app: the runtime picks the
// turn's branch, the real self-MCP answers the real pull primitives, the
// producer mints the envelope and the shipped card resolves its own state.
//
// The layout is chosen the way a person chooses it — one @mention or two —
// never by setting a flag: `shouldEnterSlackModeOnSend` reads the message.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import { chromium } from "@playwright/test";

const BASE = process.env.CHAT_BASE;
const IDS = JSON.parse(fs.readFileSync(process.env.IDS_JSON, "utf8"));
const OUT = process.env.OUT_JSON;
const MESSAGE = process.env.CHAT_MESSAGE;
const SHOT = process.env.SHOT_PATH ?? "";
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 12000);
const WAIT_FOR = process.env.WAIT_FOR ?? '[data-lifecycle-card="artifact_review_gate"]';
const WAIT_MS = Number(process.env.WAIT_MS ?? 90000);
const VIEWPORT_W = Number(process.env.VIEWPORT_W ?? 1440);
const VIEWPORT_H = Number(process.env.VIEWPORT_H ?? 1120);

const host = new URL(BASE).hostname;
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: VIEWPORT_W, height: VIEWPORT_H },
  deviceScaleFactor: 2,
});
await ctx.addCookies(
  IDS.cookie.split("; ").map((c) => {
    const i = c.indexOf("=");
    return { name: c.slice(0, i), value: c.slice(i + 1), domain: host, path: "/" };
  }),
);
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));

await page.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded", timeout: 240000 });
await page.locator('[data-testid="chat-prompt-input"]').waitFor({ state: "visible", timeout: 180000 });
await page.waitForTimeout(2500);

const editor = page.locator('[data-testid="chat-prompt-input"]');
await editor.click();
// Type it like a person: the mention menu opens on `@`, and Escape closes it
// without taking the highlighted suggestion, so the literal handle is what the
// message carries.
for (const piece of MESSAGE.split(/(?<=\s)/)) {
  await page.keyboard.type(piece, { delay: 12 });
  if (piece.trimEnd().startsWith("@")) await page.keyboard.press("Escape");
}
await page.waitForTimeout(400);
const typed = await editor.innerText();
await page.getByRole("button", { name: "Send message" }).click();

let sawCard = false;
try {
  await page.locator(WAIT_FOR).first().waitFor({ state: "attached", timeout: WAIT_MS });
  sawCard = true;
} catch { /* recorded as false; the dump below says what was actually there */ }
await page.waitForTimeout(SETTLE_MS);

const dump = await page.evaluate(() => {
  const count = (s) => document.querySelectorAll(s).length;
  const card = document.querySelector('[data-lifecycle-card="artifact_review_gate"]');
  return {
    url: location.pathname + location.search,
    conversationList: count("[data-conversation-list]"),
    hostChat: count('[data-lifecycle-card-host="chat_thread"]'),
    reviewCard: count('[data-lifecycle-card="artifact_review_gate"]'),
    decisionBar: count('[data-conformance-id="review-decision-bar"]'),
    errorCards: count('[data-conformance-id="chat-error-card"], [role="alert"]'),
    slackShell: count("[data-slack-mode], [data-chat-layout='slack']"),
    cardText: card ? card.innerText.slice(0, 600) : "",
    bodyText: document.body.innerText.slice(0, 2500),
  };
});

let thread = null;
try {
  const res = await page.request.get(`${BASE}/api/assistants/threads`);
  thread = (await res.json());
} catch (e) { thread = { error: String(e) }; }

if (SHOT) {
  await page.screenshot({ path: SHOT, fullPage: false, scale: "device" });
}
fs.writeFileSync(OUT, JSON.stringify({ typed, sawCard, dump, pageErrors, thread }, null, 2));
console.log(JSON.stringify({ typed, sawCard, dump: { ...dump, bodyText: dump.bodyText.slice(0, 900) }, pageErrors }, null, 2));
await browser.close();
