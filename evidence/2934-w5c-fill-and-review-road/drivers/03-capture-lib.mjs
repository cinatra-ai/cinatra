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

export async function openAs(email, password, { theme } = {}) {
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
  // THE THEME IS CHOSEN BEFORE THE SURFACE UNDER TEST OPENS, through the app's
  // own control on its own chrome, and the CONTEXT is what remembers it.
  if (theme) {
    await page.goto("/agents", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(6000);
    await setTheme(page, theme);
    await page.waitForTimeout(1500);
  }
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

/**
 * The window's own field: its placeholder and its current text.
 *
 * THE BUBBLES ARE READ BY THEIR OWN HOOK, not by a class. The assistant's line
 * is now DRAWN markdown (cinatra#2934, fix A), so it no longer carries the
 * pre-wrap class the person's line still does — a reader keyed on that class
 * would have quietly stopped seeing half the exchange. `data-run-window-entry`
 * names the side, and the assistant's own markup is read back beside its text
 * so a picture's claim that bold reads bold has a DOM fact under it.
 */
export async function readWindow(page) {
  return page.evaluate((sel) => {
    const f = document.querySelector(sel);
    const bubbles = Array.from(document.querySelectorAll("[data-run-window-entry]")).map((b) => ({
      text: b.textContent.replace(/\s+/g, " ").trim().slice(0, 600),
      side: b.getAttribute("data-run-window-entry"),
      drawn:
        b.getAttribute("data-run-window-entry") === "assistant"
          ? {
              strong: b.querySelectorAll("strong").length,
              tables: b.querySelectorAll("table").length,
              listRows: b.querySelectorAll("div.flex.gap-2").length,
              rawAsterisks: (b.textContent.match(/\*\*/g) ?? []).length,
              rawPipes: (b.textContent.match(/\|/g) ?? []).length,
            }
          : null,
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

/**
 * One cell, both themes, full window, uncropped — EACH THEME IN ITS OWN CONTEXT.
 *
 * WHY NOT ONE PAGE AND A TOGGLE. The graded leg toggled the theme on the page it
 * was standing on, and every frame of one run came back with a blank account
 * footer — an empty avatar, no name, no email. `src/components/nav-user.tsx`
 * draws `name` and `email` as "" while `authClient.useSession()` is pending, so
 * a frame taken while the chrome is in that state photographs a person who is
 * not there. Measured on this head, same run, same identity: opened once and
 * themed in place, the footer stayed blank past a 60 s wait in BOTH frames;
 * opened in a context that was already in its theme, it drew
 * "Rita Owner / owner@example.com" before the shutter, in both.
 *
 * So a pair is two contexts, each signed in, each themed on the app's own
 * chrome BEFORE the run page opens. The exchange is not lost by doing this: §IX
 * keeps it with the RUN, so the second context opens on the same turns.
 *
 * It presses NO screen button — the only clicks are the theme control and the
 * window's own field, which §IX says is how the panel opens again.
 *
 * `inPlace` is for the one reading that CANNOT be re-opened: an unsent draft
 * lives in the browser's own storage, so a fresh context would have nothing to
 * photograph. That reading toggles in place and records what its footer drew.
 */
export async function shoot(page, name, { inPlace = false, themes } = {}) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (inPlace) return shootInPlace(page, name, themes);
  const url = page.url();
  const files = [];
  for (const theme of ["light", "dark"]) {
    const { browser, page: fresh } = await openAs(
      process.env.OWNER_EMAIL,
      process.env.OWNER_PW,
      { theme },
    );
    await fresh.goto(url, { waitUntil: "domcontentloaded" });
    await fresh.waitForTimeout(12_000);
    const settled = await waitForDrawnFrame(fresh);
    await openPanel(fresh);
    const file = path.join(OUT_DIR, `${name}__${theme}.png`);
    await fresh.screenshot({ path: file });
    files.push(file);
    stamp("capture recorded", {
      file: path.basename(file), theme, footer: settled.footer, footerSettled: settled.settled,
    });
    await browser.close();
  }
  return files;
}

/** §IX: "clicking into the field opens it again", and the panel holds itself at
 *  the bottom so the newest turn is the one in view. Nothing is typed. */
export async function openPanel(page) {
  try {
    const f = page.locator(PROMPT).first();
    if (await f.count()) {
      await f.click();
      await page.waitForTimeout(1800);
    }
    // THE PANEL IS ADDRESSED DIRECTLY. The old walk climbed from the first
    // pre-wrap bubble looking for a scrollable ancestor; in the graded leg's
    // dark sibling of one cell it found none and the frame was left showing an
    // EARLIER exchange. The panel names itself now.
    await page.evaluate(() => {
      const panel = document.querySelector("[data-run-window-scroll]");
      if (panel) panel.scrollTop = panel.scrollHeight;
    });
    await page.waitForTimeout(1200);
  } catch { /* the surface may not carry the window */ }
  await waitForDrawnFrame(page, { tries: 20 });
}

/** The pair taken on the page as it stands, for a reading whose state is in the
 *  browser rather than in the run. */
// THEMES, NAMED BY THE CALLER WHERE IT MATTERS. A cell whose turn cannot be
// sent twice runs ONE RUN PER THEME and its context was themed BEFORE the turn,
// so it asks for that one theme rather than toggling through the other.
async function shootInPlace(page, name, themes) {
  const files = [];
  for (const theme of themes ?? ["light", "dark"]) {
    await setTheme(page, theme);
    await page.waitForTimeout(1200);
    await openPanel(page);
    await page.waitForTimeout(1200);
    const settled = await waitForDrawnFrame(page, { tries: 25 });
    const file = path.join(OUT_DIR, `${name}__${theme}.png`);
    await page.screenshot({ path: file });
    files.push(file);
    stamp("capture recorded", {
      file: path.basename(file), theme, footer: settled.footer, footerSettled: settled.settled,
      inPlace: true,
    });
  }
  if (!themes) await setTheme(page, "light");
  return files;
}

/**
 * A FRAME IS ONLY EVIDENCE ONCE THE PAGE HAS FINISHED DRAWING IT.
 *
 * Three things make a frame unusable and all three are waits, not fixes:
 *
 *   · the development server's own "Compiling…" pill, which says the picture
 *     was taken of a build rather than of the product;
 *   · a form still reading "Loading…", which photographs the page's spinner
 *     instead of the fields the cell is about;
 *   · THE ACCOUNT FOOTER, which is why the graded leg's run-page pictures show
 *     an empty avatar with no name and no email. `src/components/nav-user.tsx`
 *     renders `name` as "" and `email` as "" while `authClient.useSession()` is
 *     still pending, so a frame taken inside that window draws a blank person.
 *     It is the app shell's own loading state; here it is simply waited out, so
 *     every frame carries the person who is looking at it.
 *
 * Bounded, and it reports rather than throws — a cell that genuinely cannot
 * reach a settled frame should say so in its record, not lose the run.
 */
export async function waitForDrawnFrame(page, { tries = 60, everyMs = 1000 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const state = await page.evaluate(() => {
      const footer = document.querySelector('[data-sidebar="footer"]');
      const footerText = footer ? footer.textContent.replace(/\s+/g, " ").trim() : "";
      const drawsPerson = /\S+@\S+\.\S+/.test(footerText) && footerText.replace(/\S+@\S+/, "").trim().length > 1;
      const body = document.body.innerText;
      // The dev indicator lives in its own portal, often behind a shadow root.
      const portals = Array.from(document.querySelectorAll("nextjs-portal"));
      const portalText = portals
        .map((p) => (p.shadowRoot ? p.shadowRoot.textContent : "") || "")
        .join(" ");
      return {
        footerText,
        drawsPerson,
        compiling: /Compiling/i.test(body) || /Compiling/i.test(portalText),
        loading: /\bLoading…|\bLoading\.\.\./.test(body),
      };
    });
    if (state.drawsPerson && !state.compiling && !state.loading) {
      return { settled: true, waitedMs: i * everyMs, footer: state.footerText.slice(0, 120) };
    }
    await page.waitForTimeout(everyMs);
  }
  const last = await page.evaluate(() => {
    const f = document.querySelector('[data-sidebar="footer"]');
    return f ? f.textContent.replace(/\s+/g, " ").trim() : "";
  });
  stamp("the frame never settled within the wait", { footer: last.slice(0, 120) });
  return { settled: false, waitedMs: tries * everyMs, footer: last.slice(0, 120) };
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
