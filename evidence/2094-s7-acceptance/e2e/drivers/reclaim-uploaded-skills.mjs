/**
 * LIVE-API HYGIENE (cinatra#2094 S7 item 3a): reclaim every Custom Skill this
 * lane uploaded to the REAL org Anthropic workspace, in the documented
 * versions-then-skill order.
 *
 * That order is not a courtesy — the S7 round-1 conformance run proved (C5) that
 * the server REFUSES a skill delete while undeleted versions remain.
 *
 * SAFETY — this runs against the ORG's real workspace, so it is deliberately
 * ALLOW-LISTED rather than "delete everything":
 *   · the authoritative set is the lane's OWN `cinatra.anthropic_skill_sync`
 *     rows, captured to a CSV before any reset cleared them;
 *   · the remote list is fetched and DIFFED against that set. A remote skill the
 *     lane did not create is REPORTED and LEFT ALONE — never deleted. Another
 *     lane's or the owner's skill must not be collateral damage.
 *   · reclamation is only scored when a follow-up read returns a DEFINITIVE 404.
 *     A 401/429/5xx scores INDETERMINATE, not reclaimed (the round-2 correction).
 *
 * LEAK GATE: no header is ever recorded or printed; remote skill ids are not
 * secrets and are printed so the ledger is auditable.
 */
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const KEY_FILE = process.env.LANE_KEY_FILE;
const CSV = process.env.LANE_UPLOADED_CSV;
const OUT = process.env.LANE_RESULTS;
const BASE = "https://api.anthropic.com";
const BETA = "code-execution-2025-08-25,skills-2025-10-02,files-api-2025-04-14";

if (!KEY_FILE || !CSV || !OUT) {
  console.error("LANE_KEY_FILE, LANE_UPLOADED_CSV and LANE_RESULTS are required");
  process.exit(1);
}
const apiKey = readFileSync(KEY_FILE, "utf8").trim();

const owned = new Map(); // remote skill id -> catalog id
for (const line of readFileSync(CSV, "utf8").trim().split("\n").filter(Boolean)) {
  const [skillId, , catalogId] = line.split(",");
  if (skillId) owned.set(skillId.trim(), (catalogId ?? "").trim());
}
console.log(`lane-owned remote skills (from the sync table): ${owned.size}`);

function headers() {
  return {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": BETA,
  };
}
async function req(method, path) {
  const res = await fetch(`${BASE}${path}`, { method, headers: headers() });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* 204 / empty */
  }
  return { status: res.status, body };
}

// ---- 1. what is actually in the workspace ---------------------------------
const listed = [];
let page = await req("GET", "/v1/skills?limit=100");
for (const s of page.body?.data ?? []) listed.push(s.id);
console.log(`remote custom skills currently listed: ${listed.length}`);

const foreign = listed.filter((id) => !owned.has(id));
if (foreign.length > 0) {
  console.log(`NOT TOUCHING ${foreign.length} remote skill(s) this lane did not create:`);
  for (const id of foreign) console.log(`  leave: ${id}`);
}

// ---- 2. reclaim, versions THEN skill --------------------------------------
const ledger = [];
let versionsDeleted = 0;
let skillsReclaimed = 0;
let indeterminate = 0;

for (const [skillId, catalogId] of owned) {
  const entry = { skillId, catalogSkillId: catalogId, versions: [], outcome: null };

  // Paginate versions to EXHAUSTION on the real cursor (`page` / `next_page`) —
  // the F1 fix. `has_more` + `last_id` was the pre-fix shape and terminated
  // after page one.
  const versions = [];
  let next = null;
  for (let guard = 0; guard < 50; guard++) {
    const q = next ? `?page=${encodeURIComponent(next)}` : "";
    const r = await req("GET", `/v1/skills/${encodeURIComponent(skillId)}/versions${q}`);
    if (r.status === 404) break;
    for (const v of r.body?.data ?? []) versions.push(v.version ?? v.id);
    next = r.body?.next_page ?? null;
    if (!next) break;
  }
  for (const v of versions) {
    const d = await req("DELETE", `/v1/skills/${encodeURIComponent(skillId)}/versions/${encodeURIComponent(v)}`);
    entry.versions.push({ version: v, status: d.status });
    if (d.status === 200 || d.status === 204) versionsDeleted += 1;
  }

  const del = await req("DELETE", `/v1/skills/${encodeURIComponent(skillId)}`);
  entry.deleteStatus = del.status;

  // Only a DEFINITIVE 404 on re-read counts as reclaimed.
  const verify = await req("GET", `/v1/skills/${encodeURIComponent(skillId)}`);
  entry.verifyStatus = verify.status;
  if (verify.status === 404) {
    entry.outcome = "reclaimed";
    skillsReclaimed += 1;
  } else {
    entry.outcome = "indeterminate";
    indeterminate += 1;
  }
  ledger.push(entry);
  console.log(`${entry.outcome.padEnd(14)} ${skillId} (versions deleted: ${entry.versions.length})`);
}

// ---- 3. final state ------------------------------------------------------
const after = await req("GET", "/v1/skills?limit=100");
const remaining = (after.body?.data ?? []).map((s) => s.id);
const laneRemaining = remaining.filter((id) => owned.has(id));

const summary = {
  at: new Date().toISOString(),
  laneOwnedSkills: owned.size,
  versionsDeleted,
  skillsReclaimed,
  indeterminate,
  allReclaimed: laneRemaining.length === 0 && indeterminate === 0,
  laneSkillsStillPresent: laneRemaining,
  foreignSkillsLeftUntouched: foreign,
  remoteSkillsRemainingTotal: remaining.length,
  ledger,
};
writeFileSync(OUT, JSON.stringify(summary, null, 2));
console.log(
  `\nversions deleted=${versionsDeleted} skills reclaimed=${skillsReclaimed}/${owned.size} ` +
    `indeterminate=${indeterminate} allReclaimed=${summary.allReclaimed}`,
);
if (!summary.allReclaimed) process.exitCode = 1;
