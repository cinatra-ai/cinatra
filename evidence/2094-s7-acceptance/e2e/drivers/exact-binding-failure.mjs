/**
 * BLOCK C — EXACT-BINDING FAILURE VISIBILITY (cinatra#2094 S7 item 3a).
 *
 * The property under test is the one the runtime states in its own words:
 * "the stored provider; unavailability is a VISIBLE error, not a silent hop"
 * (src/lib/assistant-runtime/runtime.ts, `resolveBoundDefaultAdapter` /
 * `BoundDefaultProviderUnavailableError`).
 *
 * The setup is chosen so a silent failover would be BOTH possible and
 * detectable — otherwise the test proves nothing:
 *   · the stored default provider is ANTHROPIC;
 *   · Anthropic's credential is REMOVED, so it cannot serve the turn;
 *   · OPENAI's credential is deliberately LEFT IN PLACE and valid, so a
 *     failover target genuinely exists.
 *
 * Two things are then asserted, and the second is what makes this more than a
 * screenshot: the error must NAME the stored provider, and the egress ledger
 * must record ZERO OpenAI calls for the phase — i.e. the absence of failover is
 * MEASURED on the wire, not inferred from the message.
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
const CONTAINER = process.env.LANE_PG_CONTAINER ?? "lane2094-pg";
const PHASE = "C-exact-binding-failure";

for (const [k, v] of Object.entries({ PROFILE, SHOTS, LEDGER_DIR, RESULTS })) {
  if (!v) {
    console.error(`LANE_${k} is required`);
    process.exit(1);
  }
}
mkdirSync(SHOTS, { recursive: true });

const checks = [];
const check = (id, what, pass, detail) => {
  checks.push({ id, what, verdict: pass ? "PASS" : "FAIL", detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${id} — ${what}${detail ? ` :: ${detail}` : ""}`);
};
const sql = (q) =>
  execFileSync("docker", ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-tAc", q], {
    encoding: "utf8",
  }).trim();
const ledgerRows = () => {
  try {
    return readFileSync(path.join(LEDGER_DIR, "egress.jsonl"), "utf8")
      .trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

// ---- arrange: default = anthropic, anthropic credential REMOVED, openai kept
execFileSync("docker", [
  "exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c",
  `insert into cinatra.metadata(key,value) values ('connector_config:llm_default_provider','"anthropic"')
     on conflict (key) do update set value = excluded.value;
   delete from cinatra.metadata where key = 'connector_config:anthropic_connection';`,
], { encoding: "utf8" });

const storedDefault = sql("select value from cinatra.metadata where key='connector_config:llm_default_provider'");
const anthropicCred = sql("select count(*) from cinatra.metadata where key='connector_config:anthropic_connection'");
const openaiCred = sql("select count(*) from cinatra.metadata where key='openai_connection'");
check("C0a", "the stored default provider is anthropic", storedDefault.includes("anthropic"), storedDefault);
check("C0b", "the anthropic credential is REMOVED (provider made unavailable)", anthropicCred === "0");
check("C0c", "a VALID openai credential remains — a failover target exists", openaiCred === "1");

writeFileSync(path.join(LEDGER_DIR, "control.json"), JSON.stringify({ phase: PHASE }));
const startIndex = ledgerRows().length;

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: true,
  viewport: { width: 1440, height: 1200 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();
page.setDefaultTimeout(180_000);

await page.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(7000);
const composer = page
  .locator('[contenteditable="true"], input[placeholder*="Ask"], input[placeholder*="Type a message"], textarea')
  .first();
await composer.fill("Say hello.");
await composer.press("Enter");

let surfaced = "";
for (let i = 0; i < 36; i++) {
  await page.waitForTimeout(5000);
  const t = await page.evaluate(() => document.body.innerText);
  if (/Something went wrong|The request failed|not configured|unavailable|No LLM provider/i.test(t)) {
    surfaced = t;
    break;
  }
}
await page.screenshot({ path: path.join(SHOTS, "C1-exact-binding-failure.png"), fullPage: true });

// Some surfaces put the precise reason behind a details affordance; open it so
// the screenshot carries the provider-naming text rather than only the banner.
let detail = "";
const copyBtn = page.getByRole("button", { name: /error details|copy error/i }).first();
if (await copyBtn.count()) {
  try {
    await copyBtn.click();
    await page.waitForTimeout(1500);
    detail = await page.evaluate(() => document.body.innerText);
    await page.screenshot({ path: path.join(SHOTS, "C2-exact-binding-failure-detail.png"), fullPage: true });
  } catch {
    /* best effort */
  }
}

const visible = /Something went wrong|The request failed|not configured|unavailable|No LLM provider/i.test(surfaced);
check("C1a", "the assistant surfaces a VISIBLE failure instead of answering", visible, surfaced.slice(0, 200).replace(/\s+/g, " "));

// Server-side, the thrown class names the provider. Read it from the running
// server's own output so the claim is the product's text, not the driver's.
let serverNamed = false;
let serverLine = "";
try {
  const log = readFileSync(process.env.LANE_SERVER_LOG ?? "", "utf8");
  const lines = log.split("\n").filter((l) => /BoundDefaultProviderUnavailable|No LLM provider configured/i.test(l));
  serverLine = (lines[lines.length - 1] ?? "").slice(0, 400);
  serverNamed = /anthropic/i.test(serverLine);
} catch {
  /* log unavailable */
}
check("C1b", "the failure NAMES the stored provider (anthropic)", serverNamed || /anthropic/i.test(surfaced) || /anthropic/i.test(detail), serverLine || "see surfaced text");

// ---- THE MEASUREMENT: no silent hop to the available provider --------------
const armRows = ledgerRows().slice(startIndex);
const openaiCalls = armRows.filter((r) => r.provider === "openai");
const anthropicCalls = armRows.filter((r) => r.provider === "anthropic");
check(
  "C2a",
  "NO SILENT FAILOVER — zero OpenAI egress while OpenAI was available (MEASURED)",
  openaiCalls.length === 0,
  `openai calls=${openaiCalls.length} anthropic calls=${anthropicCalls.length} total=${armRows.length}`,
);
// The prompt here is "Say hello.", so the sentinel must be the ANSWER this
// prompt would produce — not another driver's sentinel. Checking for
// ACKNOWLEDGED would have PASSED even if the assistant had cheerfully answered
// "Hello." (codex round-1 finding).
const answered = /\bhello\b/i.test(surfaced.split("Say hello.").join(""));
check(
  "C2b",
  "the turn produced no assistant answer to the prompt",
  !answered,
  answered ? "an answer WAS produced — exact binding did not refuse" : "no answer text present",
);

writeFileSync(
  RESULTS,
  JSON.stringify(
    {
      block: "C — exact-binding failure visibility",
      at: new Date().toISOString(),
      storedDefaultProvider: storedDefault,
      anthropicCredentialRows: Number(anthropicCred),
      openaiCredentialRows: Number(openaiCred),
      checks,
      serverLine,
      providerCallsDuringFailure: armRows.map((r) => ({ provider: r.provider, method: r.method, path: r.path, status: r.status })),
    },
    null,
    2,
  ),
);
console.log(`\nPASS=${checks.filter((c) => c.verdict === "PASS").length} FAIL=${checks.filter((c) => c.verdict === "FAIL").length}`);
await ctx.close();
