/**
 * BLOCK A — the ANTHROPIC arm of cinatra#2094 S7 acceptance item 3a, LIVE.
 *
 * Drives the REAL `/setup/ai` wizard in an ISOLATED Chromium against a REAL
 * `pnpm dev` boot, a REAL lane Postgres with the 73 core migrations actually
 * applied, and the REAL Anthropic API using the org key. Nothing on the
 * provider boundary is stubbed — the preload in this lane only OBSERVES and
 * records egress (drivers/egress-observer.mjs).
 *
 * What it proves, in order:
 *   A1  the provider choice renders and Anthropic is selectable
 *   A2  selecting Anthropic surfaces its credential form + the matcher constraint
 *   A3  the readiness saga RUNS LIVE: bulk consent -> strict catalog sync
 *       (real uploads to the real Skills API) -> native-skills probe
 *   A4  a `function-tools` instance fails the probe ACTIONABLY, and the
 *       fix-forward control is rendered (S6's F2, re-driven here as the
 *       precondition of the live success arm)
 *   A5  the UI control flips the stored mode
 *   A6  the saga reaches a VALID RECEIPT naming a real uploaded skill count and
 *       a real container.skills acceptance
 *
 * Every verdict is written to a machine-readable results file; the phase label
 * is pushed to the egress ledger's control file before each step so the ledger
 * can be sliced per phase afterwards.
 */
import { chromium } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const PORT = process.env.LANE_PORT ?? "3294";
const BASE = `http://localhost:${PORT}`;
const PROFILE = process.env.LANE_PROFILE;
const SHOTS = process.env.LANE_SHOTS;
const LEDGER_DIR = process.env.LANE_LEDGER_DIR;
const RESULTS = process.env.LANE_RESULTS;
const CONTAINER = process.env.LANE_PG_CONTAINER ?? "lane2094-pg";

for (const [k, v] of Object.entries({ PROFILE, SHOTS, LEDGER_DIR, RESULTS })) {
  if (!v) {
    console.error(`LANE_${k} is required`);
    process.exit(1);
  }
}
mkdirSync(SHOTS, { recursive: true });

const checks = [];
const pageErrors = [];
function check(id, what, pass, detail) {
  checks.push({ id, what, verdict: pass ? "PASS" : "FAIL", detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${id} — ${what}${detail ? ` :: ${detail}` : ""}`);
}
function phase(name) {
  writeFileSync(path.join(LEDGER_DIR, "control.json"), JSON.stringify({ phase: name }));
  console.log(`--- phase ${name} ---`);
}
function sql(q) {
  return execFileSync(
    "docker",
    ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-tAc", q],
    { encoding: "utf8" },
  ).trim();
}

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: true,
  viewport: { width: 1440, height: 1200 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();
page.on("pageerror", (e) => {
  pageErrors.push(e.message);
  console.log("pageerror:", e.message);
});
page.setDefaultTimeout(180_000);

async function shot(name) {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

// ---------------------------------------------------------------- A1
phase("A-provider-choice");
await page.goto(`${BASE}/setup/ai`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);
const anthropicBtn = page.getByTestId("setup-provider-anthropic");
const openaiBtn = page.getByTestId("setup-provider-openai");
check("A1a", "Anthropic is offered in the wizard", (await anthropicBtn.count()) > 0);
check("A1b", "OpenAI is offered in the wizard", (await openaiBtn.count()) > 0);
check(
  "A1c",
  "Gemini is NOT offered (wizardEligible false)",
  (await page.getByTestId("setup-provider-gemini").count()) === 0,
);
await shot("A1-provider-choice");

// ---------------------------------------------------------------- A2
phase("A-select-anthropic");
await anthropicBtn.click();
await page.waitForTimeout(5000);
check(
  "A2a",
  "the Anthropic credential form renders",
  (await page.getByTestId("setup-anthropic-api-key").count()) > 0,
);
check(
  "A2b",
  "the matcher constraint is surfaced on Anthropic",
  (await page.getByTestId("setup-matcher-constraint").count()) > 0,
);
const storedProvider = sql(
  "select value from cinatra.metadata where key = 'connector_config:setup_provider_selection'",
);
check("A2c", "the pick is persisted", storedProvider.includes("anthropic"), storedProvider);
await shot("A2-anthropic-selected");

// ---------------------------------------------------------------- A3/A4
// First readiness run. mcpMode is unset -> the connector's default is
// function-tools, so the native-skills probe MUST refuse. The strict catalog
// sync ahead of it is REAL: it uploads the installed skills to the real API.
phase("A-readiness-run-1");
await page.getByTestId("setup-run-readiness").click();
await page.waitForTimeout(8000);
// The saga uploads a whole catalog live; wait for the page to settle rather
// than assuming a fixed duration.
for (let i = 0; i < 60; i++) {
  const done =
    (await page.getByTestId("setup-readiness-failure").count()) > 0 ||
    (await page.getByText("AI setup complete").count()) > 0;
  if (done) break;
  await page.waitForTimeout(5000);
}
const syncedAfterRun1 = Number(sql("select count(*) from cinatra.anthropic_skill_sync"));
const consentAfterRun1 = Number(sql("select count(*) from cinatra.skill_upload_consent"));
check("A3a", "strict catalog sync uploaded skills LIVE", syncedAfterRun1 > 0, `sync rows=${syncedAfterRun1}`);
check("A3b", "bulk consent was recorded", consentAfterRun1 > 0, `consent rows=${consentAfterRun1}`);

const failureVisible = (await page.getByTestId("setup-readiness-failure").count()) > 0;
const failureText = failureVisible
  ? ((await page.getByTestId("setup-readiness-failure").innerText()).replace(/\s+/g, " ").trim())
  : "";
check(
  "A4a",
  "a function-tools instance fails the native-skills probe ACTIONABLY",
  failureVisible && /native-skills-probe/i.test(failureText),
  failureText.slice(0, 300),
);
check(
  "A4b",
  "the performable fix-forward control is rendered",
  (await page.getByTestId("setup-enable-native-mcp").count()) > 0,
);
await shot("A3-readiness-failure-function-tools");

// ---------------------------------------------------------------- A5
phase("A-switch-native-mcp");
if ((await page.getByTestId("setup-enable-native-mcp").count()) > 0) {
  await page.getByTestId("setup-enable-native-mcp").click();
  await page.waitForTimeout(6000);
}
const storedMode = sql("select value from cinatra.metadata where key = 'connector_config:anthropic'");
check("A5a", "the UI control flipped the STORED mcpMode to native", /"mcpMode"\s*:\s*"native"/.test(storedMode), storedMode);
check(
  "A5b",
  "the switch does not fabricate readiness (no receipt yet)",
  (await page.getByText("AI setup complete").count()) === 0,
);
await shot("A4-native-mcp-switched");

// ---------------------------------------------------------------- A6
phase("A-readiness-run-2");
await page.getByTestId("setup-run-readiness").click();
await page.waitForTimeout(8000);
for (let i = 0; i < 60; i++) {
  const done =
    (await page.getByText("AI setup complete").count()) > 0 ||
    (await page.getByTestId("setup-readiness-failure").count()) > 0;
  if (done) break;
  await page.waitForTimeout(5000);
}
const receiptRaw = sql(
  "select coalesce(value,'') from cinatra.metadata where key = 'connector_config:setup_readiness_receipt'",
);
let receipt = null;
try {
  receipt = JSON.parse(receiptRaw);
} catch {
  /* recorded as absent below */
}
const receiptOk = Boolean(receipt && receipt.provider === "anthropic" && receipt.probe?.accepted === true);
check("A6a", "the readiness saga reached a VALID receipt on the real API", receiptOk, receiptRaw.slice(0, 400));
check(
  "A6b",
  "the probe used container-skills mode",
  receipt?.probe?.mode === "container-skills",
  String(receipt?.probe?.mode),
);
check(
  "A6c",
  "the receipt reports a real uploaded skill count",
  typeof receipt?.syncedSkillCount === "number" && receipt.syncedSkillCount > 0,
  String(receipt?.syncedSkillCount),
);
check(
  "A6d",
  "the wizard renders the completion receipt",
  (await page.getByText("AI setup complete").count()) > 0,
);
const defaultProvider = sql(
  "select coalesce(value,'') from cinatra.metadata where key = 'connector_config:llm_default_provider'",
);
check("A6e", "the default provider is committed to anthropic", defaultProvider.includes("anthropic"), defaultProvider);
await shot("A5-anthropic-receipt");

writeFileSync(
  RESULTS,
  JSON.stringify(
    {
      arm: "anthropic",
      label: "LIVE — real Anthropic API with the org key; provider boundary observed, never stubbed",
      at: new Date().toISOString(),
      checks,
      pageErrors,
      syncedSkillRows: syncedAfterRun1,
      consentRows: consentAfterRun1,
      receipt,
    },
    null,
    2,
  ),
);
console.log(`\nPASS=${checks.filter((c) => c.verdict === "PASS").length} FAIL=${checks.filter((c) => c.verdict === "FAIL").length}`);
await ctx.close();
