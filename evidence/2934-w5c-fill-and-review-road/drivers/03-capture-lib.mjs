// W5c picture leg — the shared capture machinery.
//
// EVERY reading here comes off the running app: the field values are read out of
// the rendered DOM, the run state out of the database, and the pictures are the
// browser's own full window (1440x900, device scale 2, uncropped) in BOTH themes,
// switched through the app's own theme control and nothing else.
//
// It presses NO screen button of its own. Where a cell says "the screen's own
// button was not pressed", that is enforced here: the only clicks this file makes
// are the prompt field, the paperclip and the theme control.
import { chromium } from "@playwright/test";
import pg from "pg";
import fs from "node:fs";
import path from "node:path";

export const APP = process.env.APP_ORIGIN;
export const OUT_DIR = process.env.CAPTURE_DIR;
const PROMPT = 'div[contenteditable="true"][role="textbox"]';

if (process.env.CINATRA_TEST_LLM_PROVIDER) {
  console.log("ABORT CINATRA_TEST_LLM_PROVIDER is set — the scripted provider is banned from proofs");
  process.exit(1);
}

export function stampFile() {
  return path.join(OUT_DIR, "timeline.jsonl");
}
export function stamp(what, extra = {}) {
  const row = { at: new Date().toISOString(), what, ...extra };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.appendFileSync(stampFile(), JSON.stringify(row) + "\n");
  console.log(`${row.at} ${what}${Object.keys(extra).length ? " " + JSON.stringify(extra) : ""}`);
  return row;
}

export async function db() {
  const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL });
  await c.connect();
  return c;
}

export async function openAs(email, password) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    baseURL: APP,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const r = await ctx.request.post("/api/auth/sign-in/email", {
    headers: { Origin: APP }, data: { email, password },
  });
  if (!r.ok()) throw new Error(`sign-in ${r.status()} for ${email}`);
  const page = await ctx.newPage();
  page.setDefaultTimeout(420_000);
  page.setDefaultNavigationTimeout(420_000);
  return { browser, ctx, page };
}

/** Every editable field the surface is showing, read off the rendered DOM. */
export async function readFields(page) {
  return page.evaluate(() => {
    const labelFor = (el) => {
      if (el.id) {
        const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l) return l.textContent.replace(/\s+/g, " ").trim();
      }
      const wrap = el.closest("label");
      if (wrap) return wrap.textContent.replace(/\s+/g, " ").trim();
      return null;
    };
    const out = {};
    for (const el of Array.from(document.querySelectorAll("input, textarea, select"))) {
      if (el.type === "hidden" || el.type === "file") continue;
      // the window's own field is a contenteditable div, never an input — so
      // nothing here can confuse the message box with the form.
      const key = el.name || el.id || labelFor(el) || el.getAttribute("aria-label");
      if (!key) continue;
      out[key] = {
        value: el.type === "checkbox" || el.type === "radio" ? String(el.checked) : String(el.value ?? ""),
        label: labelFor(el),
        tag: el.tagName.toLowerCase(),
      };
    }
    return out;
  });
}

/** The window's own field: its placeholder and its current text. */
export async function readWindow(page) {
  return page.evaluate((sel) => {
    const f = document.querySelector(sel);
    const bubbles = Array.from(document.querySelectorAll(".whitespace-pre-wrap")).map((b) => ({
      text: b.textContent.replace(/\s+/g, " ").trim().slice(0, 600),
      side: b.parentElement?.className?.includes("justify-end") ? "person" : "assistant",
    }));
    return {
      present: Boolean(f),
      placeholder: f?.getAttribute("data-placeholder") ?? f?.getAttribute("placeholder") ?? null,
      draft: f ? f.textContent : null,
      bubbles,
    };
  }, PROMPT);
}

export async function setTheme(page, theme) {
  for (let i = 0; i < 4; i += 1) {
    const cls = await page.evaluate(() => document.documentElement.className);
    const isDark = /\bdark\b/.test(cls);
    if ((theme === "dark") === isDark) return;
    await page.getByRole("button", { name: /Toggle theme/i }).first().click();
    await page.waitForTimeout(1200);
  }
  throw new Error(`the app's own theme control did not reach ${theme}`);
}

/** One cell, both themes, full window, uncropped. */
export async function shoot(page, name) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const files = [];
  for (const theme of ["light", "dark"]) {
    await setTheme(page, theme);
    await page.waitForTimeout(1500);
    const file = path.join(OUT_DIR, `${name}__${theme}.png`);
    await page.screenshot({ path: file });           // the window, not the document
    files.push(file);
    stamp("capture recorded", { file: path.basename(file), theme });
  }
  await setTheme(page, "light");
  return files;
}

/** The platform's own line when the turn could not be answered at all. */
export const COULD_NOT_ANSWER = "The assistant could not answer just now";

/** Type into the window's own field and send. Presses no screen button. */
export async function sendTurn(page, text, { waitForAnswer = true } = {}) {
  await page.click(PROMPT);
  await page.type(PROMPT, text, { delay: 6 });
  const before = (await readWindow(page)).bubbles.length;
  await page.keyboard.press("Enter");
  stamp("the person typed into the window and sent", { text });
  if (!waitForAnswer) return;
  for (let i = 0; i < 150; i += 1) {
    const w = await readWindow(page);
    if (w.bubbles.length > before + 1) break;
    await page.waitForTimeout(2000);
  }
  await page.waitForTimeout(3000);
}

/**
 * THE ONE RETRY, AND WHAT DECIDES IT.
 *
 * The provider's hosted MCP connector fetches this instance's tool list over the
 * public origin, and on a cold OAuth path that fetch answers 424; the app then
 * says so in its own log — "MCP tool enumeration failed (424) — retrying stream
 * without MCP tool" — and the model answers that turn with NO toolbox at all. A
 * turn served without the toolbox cannot fill or press whatever it was asked,
 * so it proves nothing either way.
 *
 * The retry is therefore decided by THE SERVER'S OWN LOG for this turn's own
 * window — never by whether the answer was the one wanted. The SAME words are
 * sent again, at most `max` times, and every attempt is stamped. A turn whose
 * slice carries no 424 is kept exactly as it came back, right or wrong.
 */
/**
 * THE APP REFUSES A TURN IT CANNOT SERVE. When the instance's own public origin
 * does not answer within its 2.5 s budget, the runtime refuses to run the turn
 * "without Cinatra tools" and the window says it could not answer. On this host
 * that ingress FLAPS — minutes of timeouts, then 200 again — so every attempt
 * waits for the app's own public origin to answer before a word is typed. The
 * wait is recorded; a turn sent while the origin was down measures the ingress,
 * not the road.
 */
export async function waitForPublicOrigin({ tries = 40, everyMs = 15_000 } = {}) {
  const origin = process.env.LANE_PUBLIC_ORIGIN;
  if (!origin) return { checked: false };
  for (let i = 0; i < tries; i += 1) {
    const started = Date.now();
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 10_000);
      const res = await fetch(`${origin}/sign-in`, { signal: ctl.signal, redirect: "manual" });
      clearTimeout(t);
      if (res.status > 0 && res.status < 500) {
        return { checked: true, ok: true, tries: i + 1, ms: Date.now() - started };
      }
    } catch { /* the ingress is down right now */ }
    if (i === 0) stamp("the instance's own public origin is not answering — waiting for it");
    await new Promise((r) => setTimeout(r, everyMs));
  }
  stamp("the instance's own public origin never answered within the wait");
  return { checked: true, ok: false, tries };
}

export async function sendTurnWithColdStartRetry(page, text, { max = 4, beforeEachAttempt } = {}) {
  const log = process.env.SERVER_LOG;
  const logLen = () => { try { return fs.statSync(log).size; } catch { return 0; } };
  const sliceHas424 = (from) => {
    if (!log) return false;
    try {
      const buf = fs.readFileSync(log);
      const slice = buf.slice(from).toString("utf8");
      return /424 \(Failed Dependency\)|MCP tool enumeration failed/.test(slice);
    } catch { return false; }
  };
  const attempts = [];
  for (let i = 0; i < max; i += 1) {
    const from = logLen();
    // A retry has to carry EVERYTHING the first attempt carried. The window
    // consumes its pending attachments on submit, so a re-sent message with no
    // file attached again is a different message — and would have measured the
    // driver rather than the road.
    const ingress = await waitForPublicOrigin();
    if (beforeEachAttempt) await beforeEachAttempt(i + 1);
    await sendTurn(page, text);
    const w = await readWindow(page);
    const last = w.bubbles[w.bubbles.length - 1];
    const platformCouldNotAnswer =
      Boolean(last && last.side === "assistant" && last.text.includes(COULD_NOT_ANSWER));
    const toolboxMissing = sliceHas424(from);
    attempts.push({ attempt: i + 1, toolboxMissing, platformCouldNotAnswer, publicOrigin: ingress });
    if (!toolboxMissing && !platformCouldNotAnswer) break;
    if (i + 1 < max) {
      stamp(
        "the app's own log says the model was served WITHOUT its toolbox (424) — the SAME message is sent again",
        { attempt: i + 1, text },
      );
      await page.waitForTimeout(6000);
    }
  }
  return { attempts, retried: attempts.length > 1, servedWithoutToolbox: attempts[attempts.length - 1].toolboxMissing };
}

export async function runRow(c, runId) {
  const r = await c.query(
    `select id, status, created_at, started_at, completed_at, lifecycle_moment, template_id, run_by
       from cinatra.agent_runs where id = $1`,
    [runId],
  );
  return r.rows[0] ?? null;
}

export function write(name, obj) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, name), JSON.stringify(obj, null, 2));
}
