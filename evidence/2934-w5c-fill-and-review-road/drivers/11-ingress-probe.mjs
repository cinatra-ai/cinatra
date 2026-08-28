// W5c picture leg — WARM THE INGRESS BEFORE A PICTURED TURN, and say so.
// This host's public origin is its own funnel, and the runtime refuses a turn it
// cannot serve with the instance's tools. So before the pictured turns a PROBE
// turn is sent on the product's own chat page — never on a run whose window is
// photographed — and what the server's own log said about it is recorded.
// The probe is disclosed in the record; it is not a capture and decides nothing.
//   env: APP_ORIGIN, OWNER_EMAIL, OWNER_PW, CAPTURE_DIR, SERVER_LOG, LANE_PUBLIC_ORIGIN
import fs from "node:fs";
import { openAs, readWindow, stamp, waitForPublicOrigin } from "./03-capture-lib.mjs";

const log = process.env.SERVER_LOG;
const size = () => { try { return fs.statSync(log).size; } catch { return 0; } };

const ingress = await waitForPublicOrigin();
stamp("ingress probe before the warm turn", ingress);

const { browser, page } = await openAs(process.env.OWNER_EMAIL, process.env.OWNER_PW);
await page.goto("/chat", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(20_000);
const from = size();
const PROMPT = 'div[contenteditable="true"][role="textbox"], textarea';
await page.click(PROMPT);
await page.type(PROMPT, "say ok", { delay: 8 });
await page.keyboard.press("Enter");
stamp("warm turn sent on the chat page (a probe, not a capture)");
for (let i = 0; i < 60; i += 1) {
  await page.waitForTimeout(3000);
  const w = await readWindow(page);
  if (w.bubbles.length >= 2) break;
}
await page.waitForTimeout(5000);
const slice = (() => { try { return fs.readFileSync(log).slice(from).toString("utf8"); } catch { return ""; } })();
const out = {
  ingress,
  refusedForMissingTools: /refusing to run the turn without Cinatra tools/.test(slice),
  toolEnumeration424: /424 \(Failed Dependency\)|MCP tool enumeration failed/.test(slice),
  mcpCallbacks: (slice.match(/POST \/api\/mcp 200/g) || []).length,
  bubbles: (await readWindow(page)).bubbles.slice(-2),
};
stamp("warm turn result", { refused: out.refusedForMissingTools, e424: out.toolEnumeration424, callbacks: out.mcpCallbacks });
console.log(JSON.stringify(out, null, 2));
await browser.close();
