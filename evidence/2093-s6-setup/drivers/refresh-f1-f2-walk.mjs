/**
 * F1 / F2 REFRESH WALK (cinatra#2093, epic #2086 S6 — PR #2213 review round).
 *
 * The first walk (`setup-ai-walk.mjs`) recorded two findings on this PR's own
 * surface. Both are now fixed, so the affected evidence is RE-DRIVEN here
 * against the same kind of stack: a real `pnpm dev` boot, a real Postgres, a
 * real admin session created through the sign-up form, an isolated Chromium
 * profile, `CINATRA_E2E_SETUP_BYPASS` deliberately unset, and the provider HTTP
 * boundary stubbed by the same `node --import` preload.
 *
 * What is re-driven, and nothing else:
 *   F1  the Anthropic key SAVE against an unconfigured connection service —
 *       previously an unhandled server error, now an in-page actionable state.
 *   (d) the readiness FAILURE — its fix-forward must now name a control that
 *       EXISTS, and that control must be rendered.
 *   F2  clicking that control must actually flip the stored MCP mode, which is
 *       then proven twice: the durable row, and the saga's own success arm.
 *   (c) the receipt — re-driven only because its precondition changed: the
 *       out-of-band `mcpMode` flip the first walk had to perform is GONE, so
 *       the success arm is now reached entirely from the UI.
 *
 * Flows (a), (b) and (e) — the provider choice, the whole OpenAI arm, and the
 * matcher constraint — are untouched by these fixes and keep their originally
 * captured evidence.
 */
import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const PORT = process.env.LANE_PORT ?? "3293";
const BASE = `http://localhost:${PORT}`;
const OUT = process.env.LANE_OUT;
const PROFILE = process.env.LANE_PROFILE;
const STUB = process.env.LANE_STUB_DIR;
const EMAIL = process.env.LANE_EMAIL;
const PASSWORD = process.env.LANE_PASSWORD;
const PG = process.env.LANE_PG_CONTAINER ?? "s6-2093-pg";
const AI = "/setup/ai?stay=1";

const results = [];
const ok = (name, detail) => { results.push({ name, verdict: "PASS", detail }); console.log(`PASS  ${name} — ${detail}`); };
const bad = (name, detail) => { results.push({ name, verdict: "FAIL", detail }); console.log(`FAIL  ${name} — ${detail}`); };

function setPhase(patch) {
  const cur = existsSync(path.join(STUB, "control.json"))
    ? JSON.parse(readFileSync(path.join(STUB, "control.json"), "utf8"))
    : {};
  writeFileSync(path.join(STUB, "control.json"), JSON.stringify({ ...cur, ...patch }, null, 2));
}
// The refresh run writes its OWN ledger so the first walk's 28-call record —
// which is what makes "zero Anthropic egress on the OpenAI path" a measurement
// for the flows this round did not re-drive — stays intact.
const LEDGER_FILE = process.env.LANE_LEDGER ?? "egress-refresh.jsonl";
function ledger() {
  const p = path.join(STUB, LEDGER_FILE);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
/** Read a connector-config row straight out of Postgres — the durable truth. */
function storedConnectorConfig(key) {
  const sql = `select value from cinatra.metadata where key = $$connector_config:${key}$$;`;
  const out = execFileSync(
    "docker",
    ["exec", "-i", PG, "psql", "-U", "postgres", "-d", "postgres", "-tAq", "-v", "ON_ERROR_STOP=1", "-c", sql],
    { encoding: "utf8" },
  ).trim();
  return out === "" ? null : out;
}

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: true,
  viewport: { width: 1440, height: 1200 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();
const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push(e.message));
// The wizard's <SearchParamToast> CONSUMES its code and `router.replace`s it out
// of the URL, so the address bar after the dust settles is not where the flash
// can be observed. Record every navigation instead.
const navigations = [];
page.on("framenavigated", (frame) => {
  if (frame === page.mainFrame()) navigations.push(frame.url());
});

const shot = async (name) => {
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
  console.log(`shot  ${name}`);
};

/** Click "Verify and save" and wait for the OUTCOME REGION to change. */
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
  const idField = page.locator('input[name="username"], input[name="email"], input[name="identifier"]').first();
  await idField.fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(9000);
}
console.log("after sign-in:", page.url());
if (page.url().includes("/sign-in")) {
  throw new Error("sign-in did not establish a session — refusing to fabricate a walk");
}

// ===========================================================================
// F1 — the Anthropic key SAVE against an UNCONFIGURED connection service.
//
// This instance's NANGO_SERVER_URL points at nothing (a freshly provisioned
// instance has no connection service), which is precisely the condition the
// connector's writer refuses on and precisely the normal pre-setup state.
// ===========================================================================
setPhase({ phase: "refresh-f1-anthropic-key-save" });
await page.goto(`${BASE}${AI}`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
await page.click('[data-testid="setup-provider-anthropic"]');
await page.waitForTimeout(4500);

await page.fill('[data-testid="setup-anthropic-api-key"]', "lane2093-anthropic-not-a-real-key");
await page.click('form:has([data-testid="setup-anthropic-api-key"]) button[type="submit"]');
await page.waitForTimeout(8000);

const bodyAfterSave = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, " ").trim();
const saveAlert = page.locator('[data-testid="setup-anthropic-key-save-failure"]');
if (await saveAlert.count()) {
  const t = (await saveAlert.innerText()).replace(/\s+/g, " ").trim();
  ok("f1a the key-save failure renders as an IN-PAGE actionable state", t);
  if (/Connections/.test(t)) {
    ok("f1b the state names the step to complete FIRST", "the fix-forward names the Connections step");
  } else {
    bad("f1b the state names the step to complete FIRST", t);
  }
} else {
  bad("f1a the key-save failure renders as an IN-PAGE actionable state",
      `no setup-anthropic-key-save-failure node; page said: ${bodyAfterSave.slice(0, 240)}`);
}
// The old symptom, gone: the step is still the step, not an error page.
if (/Choose your AI provider/.test(bodyAfterSave) && !/Application error|Internal Server Error/i.test(bodyAfterSave)) {
  ok("f1c the wizard step still renders (no unhandled server error)", "the provider choice + both sections are still on the page");
} else {
  bad("f1c the wizard step still renders (no unhandled server error)", bodyAfterSave.slice(0, 240));
}
// The action redirects with a stable CODE; the toast island then consumes it and
// replaces it out of the URL — so the evidence is the navigation, and the
// settled URL carrying no code is the consumption.
const flashNav = navigations.find((u) => u.includes("error=setup-provider-save-failed"));
if (flashNav) {
  ok("f1d reported through the wizard's CODES-ONLY flash",
     `redirected to ${flashNav.replace(BASE, "")}, then consumed by the toast island (settled at ${page.url().replace(BASE, "")})`);
} else {
  bad("f1d reported through the wizard's CODES-ONLY flash",
      `no navigation carried the code; navigations = ${navigations.map((u) => u.replace(BASE, "")).join(" -> ")}`);
}
await shot("06c-anthropic-key-save-actionable");

// The stored credential a successful save would have left behind. STILL seeded
// out of band, and still for the reason the first walk gave: with no live
// Anthropic key in this lane, the connector's Nango import path (which verifies
// the credential against the real API from inside Nango's own container,
// outside this lane's host-process boundary stub) cannot be driven honestly.
// F1 was never about making that arm work — it was about what the operator sees
// when it cannot.
execFileSync("node", [path.join(import.meta.dirname, "seed-anthropic-connection.mjs")], {
  stdio: "inherit",
  env: { ...process.env, LANE_MCP_MODE: "function-tools" },
});
await page.waitForTimeout(11000); // connector-config read cache

// ===========================================================================
// FLOW (d) — the readiness FAILURE, now with a FOLLOWABLE fix-forward.
// ===========================================================================
setPhase({ phase: "refresh-d-readiness-failure", probeAccept: false });
await page.goto(`${BASE}${AI}`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
const beforeFail = ledger().length;
await runReadiness("anthropic function-tools");

const failure = page.locator('[data-testid="setup-readiness-failure"]');
if (await failure.count()) {
  const t = (await failure.innerText()).replace(/\s+/g, " ").trim();
  ok("d1 readiness failure renders actionably", t);
  if (/Switch to native MCP delivery/.test(t) && !/in its settings/.test(t)) {
    ok("d2 the fix-forward names an EXISTING control, not an unreachable settings page", t);
  } else {
    bad("d2 the fix-forward names an EXISTING control", t);
  }
} else {
  bad("d1 readiness failure renders actionably", "setup-readiness-failure absent");
}
const switchBtn = page.locator('[data-testid="setup-enable-native-mcp"]');
if (await switchBtn.count()) {
  ok("d3 the fix-forward's control is RENDERED in the failure state", await switchBtn.innerText());
} else {
  bad("d3 the fix-forward's control is RENDERED in the failure state", "setup-enable-native-mcp absent");
}
console.log("FAIL_WINDOW_EGRESS", JSON.stringify(ledger().slice(beforeFail)));
await shot("07-readiness-failure");

// ===========================================================================
// F2 — the control PERFORMS the switch. Proven on the durable row, not on the
// button's label.
// ===========================================================================
const modeBefore = storedConnectorConfig("anthropic");
setPhase({ phase: "refresh-f2-native-switch" });
await switchBtn.click();
await page.waitForTimeout(6000);
const modeAfter = storedConnectorConfig("anthropic");
console.log("STORED_ANTHROPIC_BEFORE", modeBefore);
console.log("STORED_ANTHROPIC_AFTER ", modeAfter);
if (/"mcpMode"\s*:\s*"function-tools"/.test(modeBefore ?? "") && /"mcpMode"\s*:\s*"native"/.test(modeAfter ?? "")) {
  ok("f2a the control flips the STORED mcpMode", `${modeBefore} -> ${modeAfter}`);
} else {
  bad("f2a the control flips the STORED mcpMode", `${modeBefore} -> ${modeAfter}`);
}
const failureAfterSwitch = await page.locator('[data-testid="setup-readiness-failure"]').count();
if (failureAfterSwitch === 0) {
  ok("f2b the resolved failure is cleared", "no setup-readiness-failure node after the switch");
} else {
  bad("f2b the resolved failure is cleared", "the failure alert is still standing");
}
const stillNotReady = (await page.getByText("AI setup complete").count()) === 0;
if (stillNotReady) {
  ok("f2c the switch does NOT fabricate readiness", "no receipt panel — readiness is still a probe the operator has to run");
} else {
  bad("f2c the switch does NOT fabricate readiness", "a receipt panel appeared without a probe");
}
await shot("09-native-mcp-switched");

// ===========================================================================
// FLOW (c) — the receipt, now reached with NO out-of-band mcpMode flip.
// ===========================================================================
setPhase({ phase: "refresh-c-anthropic-success", probeAccept: true });
const beforeOk = ledger().length;
await runReadiness("anthropic native (mode set from the UI)");
const receipt = await page.getByText("AI setup complete").count();
const win = ledger().slice(beforeOk);
const probe = win.find((e) => e.path === "/v1/messages");
if (receipt) {
  ok("c1 the saga reaches a valid receipt with the mode set FROM THE UI",
     `receipt panel renders; probe reference = ${probe ? JSON.stringify(probe.containerSkillsRef) : "not recorded"}`);
} else {
  bad("c1 the saga reaches a valid receipt with the mode set FROM THE UI", "no receipt panel");
}
if (probe?.containerSkillsRef?.skill_id && probe?.containerSkillsRef?.version) {
  ok("c2 probe carried BOTH halves of the container.skills reference", JSON.stringify(probe.containerSkillsRef));
} else {
  bad("c2 probe carried BOTH halves of the container.skills reference", JSON.stringify(probe ?? null));
}
console.log("SUCCESS_WINDOW_EGRESS", JSON.stringify(win, null, 1));
await shot("08-anthropic-receipt");

console.log("CONSOLE_PAGE_ERRORS", JSON.stringify(consoleErrors));
console.log("RESULTS", JSON.stringify(results, null, 1));
writeFileSync(
  path.join(OUT, "..", "refresh-results.json"),
  JSON.stringify(
    { results, consoleErrors, navigations: navigations.map((u) => u.replace(BASE, "")) },
    null,
    2,
  ),
);
await ctx.close();
