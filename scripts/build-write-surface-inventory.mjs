#!/usr/bin/env node
// Write-surface inventory generator + gate.
//
// Turns the MutationResult rollout from an unbounded hunt into a checklist:
// scans server-action files (`**/actions.ts` and the data-safety action
// modules) that mutate `cinatra.objects` (objects client / canonical writer /
// legacy facade), lists every exported async server action, and cross-checks
// each against the curated classification map below. Emits
// `src/lib/object-history/__generated__/write-surface-inventory.json`.
//
// Classification:
//   MIGRATED  — returns MutationResult<T> (threads changeSetId).
//   PENDING   — a primary write not yet on MutationResult (must name a reason
//               + the follow-up; per-area, browser-UAT'd).
//   EXCLUDED  — not a primary object write (read-only / system job / shadow),
//               with a reason.
//
// Gate (`--check`): FAILS when (a) a scanned write action is absent from the
// map (a NEW unclassified write surface), or (b) the on-disk JSON is stale.
// New write surfaces CANNOT merge until classified. PENDING is allowed +
// tracked (rails-first; redirect-form CRUD rides follow-up PRs), but never
// silent.

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, relative } from "node:path";

const REPO_ROOT = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
const OUT_PATH = resolve(
  REPO_ROOT,
  "src/lib/object-history/__generated__/write-surface-inventory.json",
);

// Markers that indicate a file mutates cinatra.objects.
const WRITE_MARKERS = [
  "createSessionObjectsClient",
  "historyAwareUpsert",
  "upsertObjectAndEnqueue",
];

// Curated classification — keyed by "file::action". KEEP in sync; the gate
// fails when a scanned write action is missing here.
const CLASSIFICATION = {
  // The entity-accounts / entity-contacts / lists action classifications were
  // removed: those CRM write-action files (packages/entity-{accounts,contacts}/
  // src/actions.ts + packages/lists/src/actions.ts) were retired in the Twenty
  // migration. Keeping stale path→status entries here would let a future
  // same-path reintroduction silently inherit an old MIGRATED/EXCLUDED
  // classification and bypass the "new write surface must be classified" gate.

  // ── email-outreach stage actions ──
  "packages/agents/src/email-outreach-stage-actions.ts::fetchChildInterruptOutput":
    { status: "EXCLUDED", reason: "read-only" },
  "packages/agents/src/email-outreach-stage-actions.ts::checkEmailOutreachAsyncStatus":
    { status: "EXCLUDED", reason: "read-only status poll" },
  "packages/agents/src/email-outreach-stage-actions.ts::fetchCampaignRecipients":
    { status: "EXCLUDED", reason: "read-only" },
  // ARCHIVED STUBS — callPrimitive() targets handlers that return {ok:true} with
  // the request unused (createEmailOutreachPrimitiveHandlers, "primitive handlers
  // are archived"). NO object mutation; called imperatively from client renderers,
  // not <form action>. If the handlers are ever un-archived to perform real writes,
  // these MUST be reclassified PENDING/MIGRATED (the source-pin test enforces the
  // stub fact).
  "packages/agents/src/email-outreach-stage-actions.ts::confirmCampaignRecipients":
    { status: "EXCLUDED", reason: "archived stub — email_outreach_recipients_confirm returns {ok:true}, no object mutation" },
  "packages/agents/src/email-outreach-stage-actions.ts::removeEmailOutreachRecipient":
    { status: "EXCLUDED", reason: "archived stub — email_outreach_recipients_clear returns {ok:true}, no object mutation" },
  "packages/agents/src/email-outreach-stage-actions.ts::removeEmailOutreachRecipients":
    { status: "EXCLUDED", reason: "archived stub — email_outreach_recipients_clear returns {ok:true}, no object mutation" },
  "packages/agents/src/email-outreach-stage-actions.ts::fetchInitialDrafts":
    { status: "EXCLUDED", reason: "read-only" },
  "packages/agents/src/email-outreach-stage-actions.ts::updateInitialDraft":
    { status: "EXCLUDED", reason: "archived stub — email_outreach_initial_drafts_update returns {ok:true}, no object mutation" },
  "packages/agents/src/email-outreach-stage-actions.ts::runReviewCheck":
    { status: "EXCLUDED", reason: "read-only review computation" },
  "packages/agents/src/email-outreach-stage-actions.ts::getReviewCheckState":
    { status: "EXCLUDED", reason: "read-only" },
  "packages/agents/src/email-outreach-stage-actions.ts::dismissReviewRecommendation":
    { status: "EXCLUDED", reason: "archived stub — email_outreach_review_recommendation_dismiss returns {ok:true}, no object mutation" },
  "packages/agents/src/email-outreach-stage-actions.ts::applyReviewRecommendation":
    { status: "EXCLUDED", reason: "archived stub — email_outreach_review_recommendation_apply_start returns {ok:true}, no object mutation" },

  // ── data-safety (already MutationResult — the object-history vertical slice) ──
  "src/components/data-safety/restore-object-version-action.ts::restoreObjectToVersionAction":
    { status: "MIGRATED", reason: "object-history vertical slice — returns MutationResult<T>" },
};

// Dynamically discover candidate action files via git — a fixed list lets a
// NEW object-write action in another file escape the gate. Scan every
// `actions.ts` under src/app + packages/*/src, plus the
// data-safety action modules, then keep the ones that actually touch
// cinatra.objects (WRITE_MARKERS). A new write surface anywhere is discovered
// → must be classified → gate fails until it is.
function discoverScanFiles() {
  const tracked = execSync("git ls-files", { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return tracked.filter((rel) => {
    if (rel.includes("/__tests__/") || rel.endsWith(".test.ts")) return false;
    const isActionsFile =
      (rel.startsWith("src/app/") || /^packages\/[^/]+\/src\//.test(rel)) &&
      rel.endsWith("actions.ts");
    // Data-safety action modules are named *-action(s).ts (not actions.ts).
    const isDataSafetyAction =
      rel.startsWith("src/components/data-safety/") && /-actions?\.ts$/.test(rel);
    return isActionsFile || isDataSafetyAction;
  });
}

const SCAN_FILES = discoverScanFiles();

function listExportedAsyncActions(rel) {
  const src = readFileSync(resolve(REPO_ROOT, rel), "utf8");
  const touchesObjects =
    WRITE_MARKERS.some((m) => src.includes(m)) ||
    rel.includes("restore-object-version-action");
  const actions = [];
  const re = /export async function (\w+)/g;
  let m;
  while ((m = re.exec(src)) !== null) actions.push(m[1]);
  return { touchesObjects, actions };
}

function build() {
  const surfaces = [];
  const missing = [];
  for (const rel of SCAN_FILES) {
    const { touchesObjects, actions } = listExportedAsyncActions(rel);
    if (!touchesObjects) continue;
    for (const action of actions) {
      const key = `${rel}::${action}`;
      const cls = CLASSIFICATION[key];
      if (!cls) {
        missing.push(key);
        continue;
      }
      surfaces.push({ file: rel, action, status: cls.status, reason: cls.reason });
    }
  }
  surfaces.sort((a, b) =>
    (a.file + a.action).localeCompare(b.file + b.action),
  );
  const tally = surfaces.reduce(
    (acc, s) => ((acc[s.status] = (acc[s.status] ?? 0) + 1), acc),
    {},
  );
  return { surfaces, tally, missing };
}

const { surfaces, tally, missing } = build();
const payload = {
  note: "Generated by scripts/build-write-surface-inventory.mjs. Do not edit by hand.",
  tally,
  surfaces,
};
const serialized = JSON.stringify(payload, null, 2) + "\n";

const isCheck = process.argv.includes("--check");

if (missing.length > 0) {
  console.error(
    "write-surface inventory: UNCLASSIFIED write action(s) — add a classification in build-write-surface-inventory.mjs:\n" +
      missing.map((k) => `  - ${k}`).join("\n"),
  );
  process.exit(1);
}

if (isCheck) {
  let onDisk = "";
  try {
    onDisk = readFileSync(OUT_PATH, "utf8");
  } catch {
    onDisk = "";
  }
  if (onDisk !== serialized) {
    console.error(
      `write-surface inventory is stale. Run \`node scripts/build-write-surface-inventory.mjs\` to refresh ${relative(REPO_ROOT, OUT_PATH)}.`,
    );
    process.exit(1);
  }
  console.log("write-surface inventory: up to date.");
} else {
  writeFileSync(OUT_PATH, serialized);
  console.log(
    `write-surface inventory: wrote ${relative(REPO_ROOT, OUT_PATH)} ` +
      `(${surfaces.length} actions; ${JSON.stringify(tally)})`,
  );
}
