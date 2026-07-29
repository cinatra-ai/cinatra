// Lane 2164 works-after driver: REAL drag-and-drop upload proof for the
// react-dropzone 15 -> 19.1.1 hop. Drives the running dev app in an ISOLATED
// chromium (own userDataDir; never the shared MCP browser).
//
// Usage: node dnd-driver.mjs <label>   e.g. "before" | "after"
//
// What it asserts, in order:
//   1. the rendered <input> accept attribute + the input's COMPUTED accessible
//      name (read off the real accessibility tree via CDP, not inferred)
//   2. the rejection path  — a .txt drop is refused, root message shown,
//      file list stays empty
//   3. the accept path     — a .zip drop is accepted, parsed, preview rendered
//   4. the upload LANDS    — submit, captured server response status, and the
//      success navigation
//   5. rapid double-drop   — two drops issued back to back inside one tick.
//      react-dropzone 19.1.0 made every drop start a supersession-guarded
//      "processing" run, so a newer drop aborts an earlier still-pending
//      getFilesFromEvent. This step characterises that delta on both lines.
import { chromium } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const LABEL = process.argv[2] ?? "run";
const PORT = process.env.LANE_PORT ?? "3164";
const BASE = process.env.LANE_BASE ?? `http://localhost:${PORT}`;
const FIXTURES = process.env.LANE_FIXTURES;
const OUT = process.env.LANE_OUT;
const EMAIL = process.env.LANE_EMAIL;
const PASSWORD = process.env.LANE_PASSWORD;

mkdirSync(OUT, { recursive: true });

const shot = async (page, name) => {
  const p = path.join(OUT, `${LABEL}-${name}.png`);
  await page.screenshot({ path: p, fullPage: false });
  console.log(`SHOT ${p}`);
};

const b64 = (f) => readFileSync(path.join(FIXTURES, f)).toString("base64");

// Build a real File in page context from base64 and dispatch a genuine
// HTML5 drag sequence (dragenter -> dragover -> drop) carrying a DataTransfer.
// This exercises react-dropzone's own onDragEnter/onDrop + getFilesFromEvent
// path, not the <input> shortcut.
const DROP_FN = ({ selector, files }) => {
  const dt = new DataTransfer();
  for (const { fileName, mimeType, base64 } of files) {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    dt.items.add(new File([bytes], fileName, { type: mimeType }));
  }
  const el = document.querySelector(selector);
  if (!el) throw new Error(`drop target not found: ${selector}`);
  const mk = (type) =>
    new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
  el.dispatchEvent(mk("dragenter"));
  el.dispatchEvent(mk("dragover"));
  // Report what the browser actually exposed, so the proof records that a real
  // file rode the DataTransfer rather than an empty synthetic event.
  const seen = { types: Array.from(dt.types), fileCount: dt.files.length };
  el.dispatchEvent(mk("drop"));
  return seen;
};

const dropFile = (page, selector, fileName, mimeType, base64) =>
  page.evaluate(DROP_FN, { selector, files: [{ fileName, mimeType, base64 }] });

/** Computed accessible name straight off Chromium's accessibility tree. */
const accessibleName = async (page, cdp, selector) => {
  const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  const { nodeId } = await cdp.send("DOM.querySelector", {
    nodeId: root.nodeId,
    selector,
  });
  if (!nodeId) return null;
  const { nodes } = await cdp.send("Accessibility.getPartialAXTree", {
    nodeId,
    fetchRelatives: false,
  });
  const self = nodes.find((n) => n.backendDOMNodeId !== undefined && n.name);
  return self?.name?.value ?? null;
};

const run = async () => {
  const userDataDir = path.join(OUT, `.browser-${LABEL}`);
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    viewport: { width: 1440, height: 1000 },
  });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

  // Capture the real HTTP status of the upload POST rather than asserting it.
  const uploadResponses = [];
  page.on("response", (r) => {
    const u = new URL(r.url());
    if (r.request().method() === "POST" && u.pathname === "/configuration/extensions/upload") {
      uploadResponses.push(r.status());
    }
  });

  // ---- sign in -----------------------------------------------------------
  await page.goto(`${BASE}/sign-in`, { waitUntil: "domcontentloaded" });
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/sign-in"), { timeout: 45000 });
  console.log(`SIGNED_IN as ${EMAIL}`);

  // ---- the upload surface ------------------------------------------------
  await page.goto(`${BASE}/configuration/extensions/upload`, { waitUntil: "domcontentloaded" });
  const zone = '[aria-label="dropzone"]';
  const fileInput = '[aria-label="dropzone"] input[type="file"]';
  await page.waitForSelector(zone, { timeout: 45000 });

  // Record the resolved react-dropzone version so a screenshot cannot be
  // mistaken for the other side of the A/B.
  console.log(`RDZ_VERSION ${process.env.LANE_RDZ_VERSION}`);
  await shot(page, "01-upload-surface-idle");

  const cdp = await ctx.newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("Accessibility.enable");

  const inputAttrs = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    return {
      ariaLabel: el.getAttribute("aria-label"),
      accept: el.getAttribute("accept"),
      multiple: el.hasAttribute("multiple"),
      className: el.getAttribute("class"),
      inlineStyle: el.getAttribute("style"),
    };
  }, fileInput);
  console.log(`INPUT_ATTRS ${JSON.stringify(inputAttrs)}`);
  console.log(`INPUT_ACCESSIBLE_NAME ${JSON.stringify(await accessibleName(page, cdp, fileInput))}`);

  // ---- 1. REJECTION PATH: drop a .txt (accepted types = .zip only) -------
  const seenTxt = await dropFile(page, zone, "lane2164-notes.txt", "text/plain", b64("lane2164-notes.txt"));
  console.log(`DROPPED_TXT ${JSON.stringify(seenTxt)}`);
  await page.waitForTimeout(1200);
  const rootError = await page.evaluate(() => {
    const ps = Array.from(document.querySelectorAll("p"));
    const hit = ps.find((p) => /allowed|max |min /i.test(p.textContent || ""));
    return hit ? hit.textContent.trim() : null;
  });
  console.log(`REJECT_MESSAGE ${JSON.stringify(rootError)}`);
  const listAfterReject = await page.evaluate(
    () => document.querySelectorAll('[aria-label="dropzone-file-list-item"]').length,
  );
  console.log(`FILE_LIST_AFTER_REJECT ${listAfterReject}`);
  await shot(page, "02-rejection-wrong-type");

  // ---- 2. ACCEPT PATH: drop the .zip -------------------------------------
  const seenZip = await dropFile(page, zone, "lane2164-agent.zip", "application/zip", b64("lane2164-agent.zip"));
  console.log(`DROPPED_ZIP ${JSON.stringify(seenZip)}`);
  await page.waitForSelector('[aria-label="dropzone-file-list-item"]', { timeout: 30000 });
  await page.waitForTimeout(1500);
  const accepted = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('[aria-label="dropzone-file-list-item"]'));
    return items.map((li) => li.textContent.replace(/\s+/g, " ").trim());
  });
  console.log(`ACCEPTED_ITEMS ${JSON.stringify(accepted)}`);
  await shot(page, "03-accepted-zip-parsed");

  // ---- 3. UPLOAD LANDS: submit the form ----------------------------------
  const submit = page.locator('form button[type="submit"]').last();
  await submit.waitFor({ state: "visible", timeout: 20000 });
  await submit.scrollIntoViewIfNeeded();
  await shot(page, "04-before-submit");
  await submit.click();
  // Wait for the success navigation rather than a fixed sleep, so both sides of
  // the A/B are compared in the same settled state.
  await page
    .waitForURL((u) => !u.pathname.startsWith("/configuration/extensions/upload"), { timeout: 60000 })
    .catch(() => {});
  await page.waitForTimeout(2000);
  console.log(`UPLOAD_POST_STATUS ${JSON.stringify(uploadResponses)}`);
  console.log(`POST_SUBMIT_URL ${new URL(page.url()).pathname}`);
  await shot(page, "05-after-submit");

  // ---- 4. RAPID DOUBLE-DROP: the 19.1.0 supersession delta ---------------
  // Two drops issued back to back with no await in between. On 19.1.0+ the
  // second drop aborts the first run's pending getFilesFromEvent, so only the
  // later file survives; on 15 both are processed. Characterised, not asserted.
  await page.goto(`${BASE}/configuration/extensions/upload`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(zone, { timeout: 45000 });
  const zipB64 = b64("lane2164-agent.zip");
  await page.evaluate(
    async ({ selector, dropFnSrc, zipB64 }) => {
      const drop = new Function(`return (${dropFnSrc})`)();
      drop({ selector, files: [{ fileName: "rapid-a.zip", mimeType: "application/zip", base64: zipB64 }] });
      drop({ selector, files: [{ fileName: "rapid-b.zip", mimeType: "application/zip", base64: zipB64 }] });
    },
    { selector: zone, dropFnSrc: DROP_FN.toString(), zipB64 },
  );
  await page.waitForTimeout(4000);
  const rapid = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[aria-label="dropzone-file-list-item"]')).map((li) =>
      (li.querySelector("p")?.textContent || "").trim(),
    ),
  );
  console.log(`RAPID_DOUBLE_DROP_ITEMS ${JSON.stringify(rapid)}`);
  await shot(page, "06-rapid-double-drop");

  console.log(`CONSOLE_ERROR_COUNT ${consoleErrors.length}`);
  console.log(
    `CONSOLE_ERROR_KINDS ${JSON.stringify(
      consoleErrors.map((e) => e.slice(0, 60).replace(/\s+/g, " ")),
    )}`,
  );
  await ctx.close();
};

run().then(
  () => console.log("DRIVER_OK"),
  (e) => {
    console.error("DRIVER_FAIL", e);
    process.exit(1);
  },
);
