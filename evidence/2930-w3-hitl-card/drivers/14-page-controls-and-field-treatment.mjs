// THE PAGE-CONTROLS SIDECAR, and the MEASURED FIELD TREATMENT.
//
// The shipped recorder writes what was COUNTED; this writes what the card
// actually HELD at the same screen — its controls, its labels, its text, its
// rectangle — and the computed treatment of the field §I rules on: the field's
// own border, background and box-shadow, and its label's font-family, beside the
// conversation's chat box measured the same way. It takes no picture and asserts
// nothing the recorder asserts; it reads the DOM and writes it down.
//
//   env: WALK_BASE, LANE_ACCOUNT, LANE_SECRET, SUPABASE_DB_URL, WALK_RUN_ID,
//        CONTROLS_OUT, CELLS_JSON (a JSON array of {cell, url, theme})
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { Client } from "pg";

const APP = process.env.WALK_BASE;
const OUT = process.env.CONTROLS_OUT;
const CELLS = JSON.parse(process.env.CELLS_JSON ?? readFileSync(process.env.CELLS_FILE, "utf8"));
const RUN = process.env.WALK_RUN_ID;
for (const [n, v] of Object.entries({ WALK_BASE: APP, CONTROLS_OUT: OUT, WALK_RUN_ID: RUN }))
  if (!v) throw new Error(`the page-controls driver needs ${n}`);

const db = new Client({ connectionString: process.env.SUPABASE_DB_URL });
await db.connect();
const browser = await chromium.launch();
const records = [];
for (const cell of CELLS) {
  const context = await browser.newContext({
    baseURL: APP, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2,
    colorScheme: cell.theme,
  });
  await context.addInitScript((t) => { try { window.localStorage.setItem("theme", t); } catch { /* the record says which theme resolved */ } }, cell.theme);
  const si = await context.request.post("/api/auth/sign-in/email", { headers: { Origin: APP }, data: { email: process.env.LANE_ACCOUNT, password: process.env.LANE_SECRET } });
  if (!si.ok()) throw new Error(`sign-in ${si.status()}`);
  const page = await context.newPage();
  page.setDefaultTimeout(300_000);
  page.setDefaultNavigationTimeout(300_000);
  await page.goto(cell.url, { waitUntil: "domcontentloaded" });
  if (cell.waitFor) await page.waitForSelector(cell.waitFor, { timeout: 300_000 }).catch(() => {});
  await page.waitForTimeout(cell.settleMs ?? 9000);
  const measured = await page.evaluate(() => {
    const painted = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const root = document.querySelector('[data-conformance-id="agent-hitl-screen-card"]');
    const fields = document.querySelector('[data-conformance-id="hitl-screen-fields"]');
    const inCard = (el) => (root ? root.contains(el) : false);
    const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; };
    const treat = (el) => {
      if (!el) return null;
      const s = getComputedStyle(el);
      return {
        tag: el.tagName.toLowerCase(),
        borderTopWidth: s.borderTopWidth, borderRightWidth: s.borderRightWidth,
        borderBottomWidth: s.borderBottomWidth, borderLeftWidth: s.borderLeftWidth,
        borderBottomStyle: s.borderBottomStyle, borderBottomColor: s.borderBottomColor,
        backgroundColor: s.backgroundColor, backgroundImage: s.backgroundImage,
        boxShadow: s.boxShadow, borderRadius: s.borderRadius,
        fontFamily: s.fontFamily, fontSize: s.fontSize,
      };
    };
    const fieldControl = fields ? fields.querySelector("textarea, input:not([type='hidden']), select") : null;
    const fieldLabel = fields ? fields.querySelector("label") : null;
    const composer = document.querySelector('div[contenteditable="true"][role="textbox"]');
    const composerBox = composer ? (composer.closest("form") ?? composer.parentElement) : null;
    return {
      url: location.pathname + location.search,
      resolvedTheme: document.documentElement.classList.contains("dark") || document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light",
      fieldPresentation: fields ? fields.getAttribute("data-field-presentation") : null,
      fieldsRegion: fields ? { ...treat(fields), classList: Array.from(fields.classList), rect: rect(fields) } : null,
      fieldControl: fieldControl ? { ...treat(fieldControl), placeholder: fieldControl.getAttribute("placeholder"), rect: rect(fieldControl) } : null,
      fieldLabel: fieldLabel ? { ...treat(fieldLabel), text: (fieldLabel.textContent || "").replace(/\s+/g, " ").trim(), letterSpacing: getComputedStyle(fieldLabel).letterSpacing, textTransform: getComputedStyle(fieldLabel).textTransform } : null,
      chatBox: composer ? { ...treat(composer), rect: rect(composer) } : null,
      chatBoxContainer: composerBox ? { ...treat(composerBox), rect: rect(composerBox) } : null,
      sendAffordanceInFields: fields ? Array.from(fields.querySelectorAll("button, [role='button']")).map((b) => ({ text: (b.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60), dataAction: b.getAttribute("data-action") })) : [],
      // THE COUNT THIS HEAD TURNS ON, read as two numbers rather than one.
      // Section I forbids a send INSIDE the subordinate field; the card's own
      // Continue stands OUTSIDE the region. Counting only the total would not
      // tell the two apart, and "no button in the region" and "a Continue on the
      // card" are two different claims that have to be measured separately.
      sendAffordance: (() => {
        const inRegion = fields ? Array.from(fields.querySelectorAll("button, [role='button']")) : [];
        const sendAll = Array.from(document.querySelectorAll('[data-action="submit-hitl-screen"]'));
        const outside = sendAll.filter((b) => inCard(b) && (!fields || !fields.contains(b)));
        const one = sendAll[0] ?? null;
        const r = one ? one.getBoundingClientRect() : null;
        return {
          regionDeclaresCardOwnsSend: fields ? fields.getAttribute("data-send-affordance") : null,
          buttonsInsideRegion: fields ? inRegion.length : null,
          buttonTextsInsideRegion: inRegion.map((b) => (b.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60)),
          sendInsideRegion: fields ? fields.querySelectorAll('[data-action="submit-hitl-screen"]').length : null,
          sendOutsideRegionInCard: outside.length,
          sendTotalInFrame: sendAll.length,
          sendText: one ? (one.textContent || "").replace(/\s+/g, " ").trim() : null,
          sendDisabled: one ? (one.hasAttribute("disabled") || one.getAttribute("aria-disabled") === "true") : null,
          sendBox: r ? { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } : null,
          primaryInputsInConversation: document.querySelectorAll('div[contenteditable="true"][role="textbox"]').length,
        };
      })(),
      cards: Array.from(document.querySelectorAll("[data-lifecycle-card]")).map((el) => ({
        tag: el.tagName.toLowerCase(),
        attributes: Object.fromEntries(Array.from(el.attributes).map((x) => [x.name, x.value])),
        text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 400),
        painted: painted(el),
      })),
      cardRect: root ? rect(root) : null,
      cardHeadings: Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6")).filter(inCard).map((el) => (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160)),
      cardLabels: Array.from(document.querySelectorAll("label")).filter(inCard).map((el) => (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120)),
      cardControls: Array.from(document.querySelectorAll("button, input, textarea, select, [role='button']")).filter(inCard).map((el) => ({
        tag: el.tagName.toLowerCase(), type: el.getAttribute("type"), text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
        placeholder: el.getAttribute("placeholder"), dataAction: el.getAttribute("data-action"),
        disabled: el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true", painted: painted(el),
      })),
      cardText: root ? (root.textContent || "").replace(/\s+/g, " ").trim().slice(0, 900) : null,
      assistantSentenceUnderCard: (() => {
        if (!root) return null;
        const turn = root.closest("[data-turn-role], article, li") ?? root.parentElement;
        const t = turn ? (turn.textContent || "").replace(/\s+/g, " ").trim() : "";
        const c = root ? (root.textContent || "").replace(/\s+/g, " ").trim() : "";
        return t.replace(c, " ").replace(/\s+/g, " ").trim().slice(0, 400) || null;
      })(),
      contractAnchors: (() => {
        const sels = [
          '[data-lifecycle-card="agent_hitl_screen"]',
          '[data-lifecycle-card-host]',
          '[data-conformance-id="agent-hitl-screen-card"]',
          '[data-conformance-id="hitl-screen-fields"]',
          '[data-field-presentation]',
          '[data-action="submit-hitl-screen"]',
          '[data-lifecycle-card-state]',
          '[data-conversation-list]',
        ];
        const out = {};
        for (const sel of sels) {
          const all = Array.from(document.querySelectorAll(sel));
          out[sel] = { frame: all.length, framePainted: all.filter(painted).length,
                       root: root ? (root.matches(sel) ? 1 : 0) + root.querySelectorAll(sel).length : 0 };
        }
        return out;
      })(),
      assistantTurnText: (() => {
        if (!root) return null;
        const turn = root.closest('[data-turn-id], [data-message-id], article, li');
        if (!turn) return null;
        const clone = turn.cloneNode(true);
        for (const el of Array.from(clone.querySelectorAll('[data-lifecycle-card], [data-inline-run-card]'))) el.remove();
        return (clone.textContent || "").replace(/\s+/g, " ").trim().slice(0, 500) || null;
      })(),
      toolNamesInTranscript: Array.from(document.querySelectorAll("[data-tool-name]")).map((e) => e.getAttribute("data-tool-name")),
      stepRailPresent: document.querySelectorAll('[data-conformance-id="run-step-rail"], [data-run-step-rail]').length,
    };
  });
  const dbAt = (await db.query(
    `SELECT id, status, started_at, completed_at, lifecycle_moment, lifecycle_card_kind, lifecycle_card_ref, input_params, a2a_task_id, now() AS read_at
       FROM cinatra.agent_runs WHERE id=$1`, [RUN])).rows[0] ?? null;
  records.push({ cell: cell.cell, at: new Date().toISOString(), ...measured, dbAt });
  console.log(`read ${cell.cell} presentation=${measured.fieldPresentation} theme=${measured.resolvedTheme} cards=${measured.cards.length}`);
  await context.close();
}
await browser.close();
await db.end();
mkdirSync(dirname(resolve(OUT)), { recursive: true });
const existing = (() => { try { return JSON.parse(readFileSync(OUT, "utf8")); } catch { return { records: [] }; } })();
const by = new Map((existing.records ?? []).map((r) => [r.cell, r]));
for (const r of records) by.set(r.cell, r);
writeFileSync(OUT, `${JSON.stringify({ schemaVersion: 1, recorder: "cinatra-lifecycle-page-controls@1", records: [...by.values()] }, null, 2)}\n`);
console.log(`wrote ${records.length} sidecar record(s) -> ${OUT}`);
