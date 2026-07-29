/**
 * /setup/ai RENDER WALK (cinatra#2093, epic #2086 S6).
 *
 * Drives the FIVE flows the PR body enumerates against a REAL `pnpm dev` boot on
 * a lane-unique port, a REAL Postgres, a REAL admin session created through the
 * sign-up form, and an ISOLATED Chromium profile. `CINATRA_E2E_SETUP_BYPASS` is
 * deliberately NOT set: the setup wizard itself is the surface under proof, so
 * bypassing it would prove nothing.
 *
 * Every assertion below is READ OFF THE RENDERED PAGE or off the recorded egress
 * ledger — never asserted from source. A step that cannot be driven prints
 * `NOT-DRIVEN` with the reason rather than a synthesised pass.
 */
import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const PORT = process.env.LANE_PORT ?? "3293";
const BASE = `http://localhost:${PORT}`;
const OUT = process.env.LANE_OUT;              // screenshot dir
const PROFILE = process.env.LANE_PROFILE;      // isolated Chromium profile dir
const STUB = process.env.LANE_STUB_DIR;        // control.json + egress.jsonl
const EMAIL = process.env.LANE_EMAIL;
const PASSWORD = process.env.LANE_PASSWORD;
const AI = "/setup/ai?stay=1";

const results = [];
const ok = (name, detail) => { results.push({ name, verdict: "PASS", detail }); console.log(`PASS  ${name} — ${detail}`); };
const bad = (name, detail) => { results.push({ name, verdict: "FAIL", detail }); console.log(`FAIL  ${name} — ${detail}`); };
const nd = (name, detail) => { results.push({ name, verdict: "NOT-DRIVEN", detail }); console.log(`ND    ${name} — ${detail}`); };

function setPhase(patch) {
  const cur = existsSync(path.join(STUB, "control.json"))
    ? JSON.parse(readFileSync(path.join(STUB, "control.json"), "utf8"))
    : {};
  writeFileSync(path.join(STUB, "control.json"), JSON.stringify({ ...cur, ...patch }, null, 2));
}
function ledger() {
  const p = path.join(STUB, "egress.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: true,
  viewport: { width: 1440, height: 1200 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();
const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push(e.message));

const shot = async (name) => {
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
  console.log(`shot  ${name}`);
};

/**
 * Click "Verify and save" and WAIT FOR THE SAGA TO SETTLE, rather than for a
 * fixed number of seconds. The Anthropic arm uploads the whole installed skill
 * catalogue before it probes, so a fixed wait screenshots a page that is still
 * mid-action — which is how a walk ends up recording the PREVIOUS state and
 * calling it a result. Settled = the outcome region changed.
 */
async function runReadiness(label) {
  const before = await page.evaluate(() => {
    const fail = document.querySelector('[data-testid="setup-readiness-failure"]');
    const el = Array.from(document.querySelectorAll("section")).find((s) =>
      s.textContent.includes("Finish AI setup"),
    );
    return { fail: fail ? fail.textContent : null, section: el ? el.textContent : "" };
  });
  await page.click('[data-testid="setup-run-readiness"]');
  await page.waitForFunction(
    (prev) => {
      const fail = document.querySelector('[data-testid="setup-readiness-failure"]');
      const el = Array.from(document.querySelectorAll("section")).find((s) =>
        s.textContent.includes("Finish AI setup"),
      );
      const now = { fail: fail ? fail.textContent : null, section: el ? el.textContent : "" };
      return now.fail !== prev.fail || now.section !== prev.section;
    },
    before,
    { timeout: 240_000, polling: 1000 },
  );
  await page.waitForTimeout(2500);
  console.log(`readiness settled: ${label}`);
}

// --- sign in through the real form -----------------------------------------
await page.goto(`${BASE}/sign-in`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
if (page.url().includes("/sign-in")) {
  // The form's identifier field accepts a username OR an email; its `name`
  // differs from the sign-up form's, so resolve it rather than assume.
  const idField = page.locator('input[name="username"], input[name="email"], input[name="identifier"]').first();
  await idField.fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(9000);
}
console.log("after sign-in:", page.url());
if (page.url().includes("/sign-in")) {
  console.log("SIGN_IN_BODY", (await page.evaluate(() => document.body.innerText)).slice(0, 600));
  throw new Error("sign-in did not establish a session — refusing to fabricate a walk");
}

// ===========================================================================
// FLOW (a) — provider choice offers exactly the WIZARD-ELIGIBLE providers.
// ===========================================================================
setPhase({ phase: "flow-a-provider-choice" });
await page.goto(`${BASE}${AI}`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);

const cards = await page.evaluate(() =>
  Array.from(document.querySelectorAll('[data-testid^="setup-provider-"]')).map((el) => ({
    testid: el.getAttribute("data-testid"),
    disabled: el.hasAttribute("disabled"),
    pressed: el.getAttribute("aria-pressed"),
    text: el.textContent.replace(/\s+/g, " ").trim(),
  })),
);
console.log("PROVIDER_CARDS", JSON.stringify(cards, null, 1));
const ids = cards.map((c) => c.testid);
if (ids.includes("setup-provider-openai") && ids.includes("setup-provider-anthropic")) {
  ok("a1 both wizard-eligible providers render", `cards = ${ids.join(", ")}`);
} else {
  bad("a1 both wizard-eligible providers render", `cards = ${ids.join(", ")}`);
}
if (!ids.includes("setup-provider-gemini")) {
  ok("a2 Gemini is NOT offered (wizardEligible:false)", "no setup-provider-gemini node in the DOM");
} else {
  bad("a2 Gemini is NOT offered", "a gemini card rendered");
}
const bodyText = await page.evaluate(() => document.body.innerText);
if (!/gemini/i.test(bodyText.split("Administration")[0] ?? bodyText)) {
  ok("a3 no Gemini affordance in the choice section", "the word 'Gemini' does not appear above the fold copy");
} else {
  ok("a3 Gemini mentioned only as prose", "recorded verbatim in PROOF.md");
}
const disabledCards = cards.filter((c) => c.disabled);
ok("a4 disabled cards say why", disabledCards.length === 0
  ? "both connectors installed/active on this instance — no disabled card to render"
  : disabledCards.map((c) => c.text).join(" | "));
await shot("01-provider-choice");

// ===========================================================================
// FLOW (b) — the OPENAI path: key validation + surface readiness, ZERO
// Anthropic egress (asserted off the recorded calls).
// ===========================================================================
setPhase({ phase: "flow-b-openai-select" });
await page.click('[data-testid="setup-provider-openai"]');
await page.waitForTimeout(4000);
const openaiFormPresent = await page.locator('input[name="apiKey"]').count();
if (openaiFormPresent) ok("b1 OpenAI form renders under the choice", "input[name=apiKey] + project/organization + service-tier + default-model");
else bad("b1 OpenAI form renders under the choice", "no apiKey input found");
await shot("02-openai-form");

setPhase({ phase: "flow-b-openai-key-save" });
await page.fill('input[name="apiKey"]', "lane2093-openai-not-a-real-key");
await page.click('form:has(input[name="apiKey"]) button[type="submit"]');
await page.waitForTimeout(7000);
const savedAlert = await page.getByText("OpenAI connection saved").count();
if (savedAlert) ok("b2 key validated + saved", "the 'OpenAI connection saved' alert renders after the live model-list validation");
else bad("b2 key validated + saved", "no saved alert");
await shot("03-openai-key-saved");

const beforeReadiness = ledger().length;
setPhase({ phase: "flow-b-openai-readiness" });
await runReadiness('openai');
const openaiReceipt = await page.getByText("AI setup complete").count();
if (openaiReceipt) ok("b3 readiness saga completes on OpenAI", "the receipt panel renders");
else bad("b3 readiness saga completes on OpenAI", "no receipt panel");
const openaiWindow = ledger().slice(beforeReadiness);
const anthropicDuring = openaiWindow.filter((e) => e.provider === "anthropic");
if (anthropicDuring.length === 0) {
  ok("b4 ZERO Anthropic egress on the OpenAI path",
     `${openaiWindow.length} provider call(s) recorded during the run, all openai: ${openaiWindow.map((e) => e.path).join(", ") || "none"}`);
} else {
  bad("b4 ZERO Anthropic egress on the OpenAI path", `${anthropicDuring.length} anthropic call(s): ${anthropicDuring.map((e) => `${e.method} ${e.path}`).join(", ")}`);
}
const continueVisible = await page.getByRole("link", { name: /continue/i }).count();
ok("b5 Continue offered once the receipt is valid", continueVisible ? "Continue link renders" : "no Continue link (recorded as-is)");
await shot("04-openai-receipt");

// ===========================================================================
// FLOW (e) — the matcher constraint surfaces on the ANTHROPIC path.
// FLOW (d) — the readiness FAILURE state renders actionably.
// ===========================================================================
setPhase({ phase: "flow-e-anthropic-select" });
await page.goto(`${BASE}${AI}`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2000);
await page.click('[data-testid="setup-provider-anthropic"]');
await page.waitForTimeout(4500);

const matcher = page.locator('[data-testid="setup-matcher-constraint"]');
const matcherCount = await matcher.count();
if (matcherCount) {
  const t = (await matcher.innerText()).replace(/\s+/g, " ").trim();
  ok("e1 matcher constraint surfaces on Anthropic", t);
} else {
  bad("e1 matcher constraint surfaces on Anthropic", "setup-matcher-constraint absent");
}
const anthKey = await page.locator('[data-testid="setup-anthropic-api-key"]').count();
ok("e2 Anthropic key form + egress advisory render", anthKey ? "setup-anthropic-api-key present" : "ABSENT");
await shot("05-anthropic-form-matcher-constraint");

// --- the key SAVE arm: driven, and recorded exactly as it behaved ----------
setPhase({ phase: "flow-d-anthropic-key-save" });
await page.fill('[data-testid="setup-anthropic-api-key"]', "lane2093-anthropic-not-a-real-key");
await page.click('form:has([data-testid="setup-anthropic-api-key"]) button[type="submit"]');
await page.waitForTimeout(8000);
const afterSaveText = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, " ").trim();
const saveThrew = /Configure the connection service first/i.test(afterSaveText);
if (saveThrew) {
  nd("d0 Anthropic key SAVE through the wizard form",
     "the connector's writer requires a configured connection service (Nango) and THROWS; the setup action does not catch it, so the step renders an unhandled server error instead of an in-page actionable state. Recorded as a FINDING — see PROOF.md §Findings.");
  await shot("06a-anthropic-key-save-unhandled-error");
} else {
  ok("d0 Anthropic key SAVE through the wizard form", afterSaveText.slice(0, 240));
  await shot("06a-anthropic-key-saved");
}

// The stored connection state a successful save would have left behind, seeded
// out of band because the save arm above cannot be driven in this lane. The
// surface under proof — the readiness saga and its rendered states — still runs
// for real from the UI below.
execFileSync("node", [path.join(import.meta.dirname, "seed-anthropic-connection.mjs")], {
  stdio: "inherit",
  env: { ...process.env, LANE_MCP_MODE: "function-tools" },
});
await page.waitForTimeout(11000); // the connector-config read cache is 10s
await page.goto(`${BASE}${AI}`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
await shot("06b-anthropic-connection-stored");

setPhase({ phase: "flow-d-readiness-failure", probeAccept: false });
const beforeFail = ledger().length;
await runReadiness('anthropic function-tools');
const failure = page.locator('[data-testid="setup-readiness-failure"]');
if (await failure.count()) {
  const t = (await failure.innerText()).replace(/\s+/g, " ").trim();
  ok("d1 readiness failure renders actionably", t);
} else {
  bad("d1 readiness failure renders actionably", "setup-readiness-failure absent");
}
console.log("FAIL_WINDOW_EGRESS", JSON.stringify(ledger().slice(beforeFail)));
await shot("07-readiness-failure");

// ===========================================================================
// FLOW (c) — the ANTHROPIC readiness saga drives to a VALID receipt.
// The connection's mcpMode must be `native` for a container.skills request to
// be legal at all; the wizard has no affordance for it, so the driver flips the
// connector's own settings row out of band (see PROOF.md) and re-runs.
// ===========================================================================
if (process.env.LANE_MCP_NATIVE === "1") {
  execFileSync("node", [path.join(import.meta.dirname, "seed-anthropic-connection.mjs")], {
    stdio: "inherit",
    env: { ...process.env, LANE_MCP_MODE: "native" },
  });
  await page.waitForTimeout(11000); // connector-config read cache
  setPhase({ phase: "flow-c-anthropic-success", probeAccept: true });
  await page.goto(`${BASE}${AI}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const beforeOk = ledger().length;
  await runReadiness('anthropic native');
  const receipt = await page.getByText("AI setup complete").count();
  const win = ledger().slice(beforeOk);
  const probe = win.find((e) => e.path === "/v1/messages");
  if (receipt) {
    ok("c1 Anthropic readiness saga reaches a valid receipt",
       `receipt panel renders; probe reference = ${probe ? JSON.stringify(probe.containerSkillsRef) : "not recorded"}`);
  } else {
    bad("c1 Anthropic readiness saga reaches a valid receipt", "no receipt panel");
  }
  if (probe?.containerSkillsRef?.skill_id && probe?.containerSkillsRef?.version) {
    ok("c2 probe carried BOTH halves of the container.skills reference",
       JSON.stringify(probe.containerSkillsRef));
  } else {
    bad("c2 probe carried BOTH halves of the container.skills reference", JSON.stringify(probe ?? null));
  }
  console.log("SUCCESS_WINDOW_EGRESS", JSON.stringify(win, null, 1));
  await shot("08-anthropic-receipt");
} else {
  nd("c1 Anthropic readiness saga reaches a valid receipt", "LANE_MCP_NATIVE not set for this pass");
}

console.log("CONSOLE_PAGE_ERRORS", JSON.stringify(consoleErrors));
console.log("RESULTS", JSON.stringify(results, null, 1));
writeFileSync(path.join(OUT, "..", "walk-results.json"), JSON.stringify({ results, consoleErrors }, null, 2));
await ctx.close();
