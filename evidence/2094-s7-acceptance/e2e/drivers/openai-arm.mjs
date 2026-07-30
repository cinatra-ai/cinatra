/**
 * BLOCK B — the OPENAI arm of cinatra#2094 S7 acceptance item 3a.
 *
 * Fresh AI-step state (drivers/reset-ai-step.mjs — the wizard's own row-scoped
 * reset, established by S6), then the OpenAI provider chosen and its readiness
 * completed THROUGH THE UI.
 *
 * The key save is ATTEMPTED through the real form (OpenAI's writer, unlike
 * Anthropic's, does not hard-require the connection service). On this tree that
 * attempt fails reproducibly — see the B2 block and finding F9 — so the arm
 * records the failure and then continues from the seeded credential row. The
 * results file reports which path was taken in `credentialPath`; nothing here
 * claims a form save that did not happen.
 *
 * The claim this arm exists to make is NEGATIVE and therefore has to be
 * MEASURED, not asserted: completing readiness on OpenAI must perform ZERO
 * Anthropic egress — no skill upload, no container.skills probe. The egress
 * ledger records every provider-host request with its phase, so the assertion
 * READS the recorded calls for this arm's phases.
 *
 * Note what makes that measurement meaningful here: the Anthropic arm ran FIRST
 * on this same instance and left 22 real uploaded skills plus a valid receipt
 * behind. So "no Anthropic egress" is not true by absence of configuration — the
 * instance is fully capable of talking to Anthropic and provably did minutes
 * earlier. The reset removes the AI step's rows, not that capability.
 */
import { chromium } from "@playwright/test";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const BASE = `http://localhost:${process.env.LANE_PORT ?? "3294"}`;
const PROFILE = process.env.LANE_PROFILE;
const SHOTS = process.env.LANE_SHOTS;
const LEDGER_DIR = process.env.LANE_LEDGER_DIR;
const RESULTS = process.env.LANE_RESULTS;
const KEY_FILE = process.env.LANE_KEY_FILE;
const CONTAINER = process.env.LANE_PG_CONTAINER ?? "lane2094-pg";

for (const [k, v] of Object.entries({ PROFILE, SHOTS, LEDGER_DIR, RESULTS, KEY_FILE })) {
  if (!v) {
    console.error(`LANE_${k} is required`);
    process.exit(1);
  }
}
mkdirSync(SHOTS, { recursive: true });
const apiKey = readFileSync(KEY_FILE, "utf8").trim();

const checks = [];
function check(id, what, pass, detail) {
  checks.push({ id, what, verdict: pass ? "PASS" : "FAIL", detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${id} — ${what}${detail ? ` :: ${detail}` : ""}`);
}
function sql(q) {
  return execFileSync(
    "docker",
    ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-tAc", q],
    { encoding: "utf8" },
  ).trim();
}
function ledgerRows() {
  try {
    return readFileSync(path.join(LEDGER_DIR, "egress.jsonl"), "utf8")
      .trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
function phase(name) {
  writeFileSync(path.join(LEDGER_DIR, "control.json"), JSON.stringify({ phase: name }));
  console.log(`--- phase ${name} ---`);
}

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: true,
  viewport: { width: 1440, height: 1200 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
page.setDefaultTimeout(180_000);
const shot = (n) => page.screenshot({ path: path.join(SHOTS, `${n}.png`), fullPage: true });

// Mark where this arm begins so the ledger slice is unambiguous.
const armStartIndex = ledgerRows().length;

// ------------------------------------------------------------------ B1
phase("B-select-openai");
await page.goto(`${BASE}/setup/ai`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);
await page.getByTestId("setup-provider-openai").click();
await page.waitForTimeout(5000);
check("B1a", "the OpenAI connection form renders under the choice", (await page.locator('input[name="apiKey"]').count()) > 0);
check(
  "B1b",
  "the Anthropic matcher-constraint alert is ABSENT on the OpenAI arm",
  (await page.getByTestId("setup-matcher-constraint").count()) === 0,
);
await shot("B1-openai-form");

// ------------------------------------------------------------------ B2
// The form save is attempted FIRST and its real outcome recorded. On this tree
// it fails REPRODUCIBLY with `read ECONNRESET` from inside the connector's own
// validation call — while the very same key returns HTTP 200 from `curl` on the
// same host, seconds apart (finding F9). When that happens the arm continues
// from the SEEDED credential row (the durable state a successful save leaves)
// so the block this arm actually exists to measure — zero Anthropic egress on
// the OpenAI readiness path — is still measured rather than abandoned. Which
// path was taken is recorded, never blurred.
phase("B-openai-key-save");
await page.locator('input[name="apiKey"]').first().fill(apiKey);
await page.locator('form:has(input[name="apiKey"]) button[type="submit"]').first().click();
await page.waitForTimeout(14000);
const formUrl = page.url();
let savedRow = sql("select coalesce(value,'') from cinatra.metadata where key = 'openai_connection'");
const formSaveWorked = savedRow.includes("apiKey");
check(
  "B2a",
  "the key was validated + saved THROUGH THE FORM",
  formSaveWorked,
  formSaveWorked ? "row present" : `NOT saved — landed on ${formUrl}`,
);
check(
  "B2b",
  "the save attempt reached the LIVE OpenAI validation boundary",
  ledgerRows().slice(armStartIndex).some((r) => r.provider === "openai"),
);
await shot("B2-openai-key-save-attempt");

let credentialPath = "form";
if (!formSaveWorked) {
  credentialPath = "seeded-after-form-failure";
  console.log("[B2] form save failed — seeding the credential row and continuing (recorded)");
  execFileSync("node", [path.join(process.cwd(), "evidence/2094-s7-acceptance/e2e/drivers/seed-provider-credential.mjs")], {
    env: { ...process.env, LANE_PROVIDER: "openai", LANE_KEY_FILE: process.env.LANE_KEY_FILE },
    encoding: "utf8",
  });
  savedRow = sql("select coalesce(value,'') from cinatra.metadata where key = 'openai_connection'");
  check("B2c", "the credential row is present after seeding", savedRow.includes("apiKey"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);
  await shot("B2b-openai-credential-stored");
}

// ------------------------------------------------------------------ B3
phase("B-openai-readiness");
await page.getByTestId("setup-run-readiness").click();
await page.waitForTimeout(8000);
for (let i = 0; i < 48; i++) {
  const done =
    (await page.getByText("AI setup complete").count()) > 0 ||
    (await page.getByTestId("setup-readiness-failure").count()) > 0;
  if (done) break;
  await page.waitForTimeout(5000);
}
const receiptRaw = sql("select coalesce(value,'') from cinatra.metadata where key='connector_config:setup_readiness_receipt'");
let receipt = null;
try { receipt = JSON.parse(receiptRaw); } catch { /* absent */ }
check("B3a", "readiness completed on OpenAI", Boolean(receipt && receipt.provider === "openai"), receiptRaw.slice(0, 240));
check("B3b", "the wizard renders the completion receipt", (await page.getByText("AI setup complete").count()) > 0);
const dflt = sql("select coalesce(value,'') from cinatra.metadata where key='connector_config:llm_default_provider'");
check("B3c", "the default provider is committed to openai", dflt.includes("openai"), dflt);
await shot("B3-openai-receipt");

// ------------------------------------------------------------------ B4 — THE MEASUREMENT
const armRows = ledgerRows().slice(armStartIndex);
const anthropicRows = armRows.filter((r) => r.provider === "anthropic");
check(
  "B4a",
  "the ENTIRE OpenAI setup arm performed ZERO Anthropic egress (MEASURED)",
  anthropicRows.length === 0,
  `${armRows.length} provider calls recorded in this arm; anthropic=${anthropicRows.length}`,
);
check(
  "B4b",
  "no Anthropic skill UPLOAD happened during the OpenAI arm",
  !anthropicRows.some((r) => r.path === "/v1/skills"),
);
check(
  "B4c",
  "no container.skills PROBE happened during the OpenAI arm",
  !anthropicRows.some((r) => r.fingerprint?.containerSkillRefs),
);
// The sync table is untouched by the OpenAI arm (rows were cleared by the reset).
check(
  "B4d",
  "the OpenAI readiness path wrote no Anthropic sync rows",
  Number(sql("select count(*) from cinatra.anthropic_skill_sync")) === 0,
  `sync rows=${sql("select count(*) from cinatra.anthropic_skill_sync")}`,
);

writeFileSync(
  RESULTS,
  JSON.stringify(
    {
      arm: "openai",
      label: "LIVE — real OpenAI API through the wizard form; provider boundary OBSERVED (pass-through), never stubbed",
      at: new Date().toISOString(),
      checks,
      pageErrors,
      receipt,
      credentialPath,
      armProviderCalls: armRows.map((r) => ({ phase: r.phase, provider: r.provider, method: r.method, path: r.path, status: r.status })),
    },
    null,
    2,
  ),
);
console.log(`\nPASS=${checks.filter((c) => c.verdict === "PASS").length} FAIL=${checks.filter((c) => c.verdict === "FAIL").length}`);
await ctx.close();
