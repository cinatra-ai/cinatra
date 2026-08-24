#!/usr/bin/env node
// THE CREATION FENCE (cinatra#2928, epic #2926 W2a).
//
// The queue fence next door pins the DISPATCH chokepoint: every agent-run
// enqueue goes through `enqueueAgentRun`. This is its sibling on the other half
// of the act — every agent run is CREATED through the lifecycle coordinator's
// `launchAgentRun`, and nowhere else.
//
// WHY A FENCE AND NOT A CONVENTION. `launchAgentRun` is where presence is
// derived, where the create-parked → evaluate → release-or-park ordering lives,
// and where the moment the run is waiting at is stated. A run created around it
// is a run with an untrue presence stamp, no moment, and — if anything later
// parks it — a park nothing can release. That is not a style question, so it is
// not left to review.
//
// WHAT IT BANS. A call to `createAgentRun(` in any tracked `.ts`/`.tsx` outside
// the allowlist below. Single-line comments are skipped so the reasoning in
// this file and in the modules that explain the seam is not a violation; block
// comments and JSDoc are scanned, exactly as the queue fence does it.
//
// THE SECOND CREATOR. `createAgentRunPendingInput` mints a pre-dispatch run for
// the schedule/trigger paths. It is not banned outright — its callers are
// ENUMERATED, so a new one cannot appear unnoticed. An unlisted caller is a
// violation just the same; the difference is that the listed ones are recorded
// with who owns them rather than being invisible.
//
// Usage: `node scripts/audit/run-creation-fence.mjs`
//        exit 0 → clean
//        exit 1 → at least one violation, printed to stderr.

import { readFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const REPO_ROOT = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();

/** The only modules that may CREATE an agent run. */
export const CREATE_ALLOWLIST = new Set([
  // The creation primitive itself — the guarded perimeter it is banned outside of.
  "packages/agents/src/store.ts",
  // The ONE caller: the lifecycle coordinator's launch entry.
  "packages/agents/src/lifecycle-coordinator.ts",
  // The workspace barrel RE-EXPORTS the creators; it calls neither. Allowlisting
  // it costs nothing, because a file that reaches a creator THROUGH the barrel
  // is caught by the same import rule that catches a direct one — the specifier
  // list below covers "@cinatra-ai/agents" as well as "./store", so the barrel
  // is a pass-through and not a way around.
  "packages/agents/src/index.ts",
  // Self-allowlist — this script names the banned call to ban it.
  "scripts/audit/run-creation-fence.mjs",
]);

/**
 * The enumerated callers of the pre-dispatch creator, each with its owner.
 *
 * A row here is a RECORD, not an exemption: the fence still fails on any caller
 * that is not listed, and a listed caller that disappears fails too, so the list
 * cannot go stale in either direction.
 */
export const PENDING_INPUT_CALLERS = Object.freeze({
  "packages/agents/src/store.ts":
    "the creator itself",
  "packages/agents/src/lifecycle-coordinator.ts":
    "the coordinator's launch entry, for a run created pre-dispatch",
  "scripts/audit/run-creation-fence.mjs":
    "this script, which names the call to enumerate it",
});

/**
 * The two surfaces that bypass the worker today, with their owner.
 *
 * These are the plan's own carve-out — the widget's content-edit run keeps its
 * blocking reply and its timeout, and a run of an EXTERNAL agent over the
 * agent-to-agent protocol keeps its remote task stream. Both reach the
 * coordinator through an ADAPTER, and building those adapters is W2b's
 * (cinatra#2929). W2a routes everything else.
 *
 * A RED DONE-CHECK, NOT A WAIVER, in both directions: an owed file that stops
 * creating runs fails as a stale record, so W2b cannot land its adapter without
 * striking the row; and no file can be added here silently, because a row with
 * no owner named is refused below.
 */
export const OWED_BY_ADAPTER = Object.freeze({
  "packages/agents/src/a2a-actions.ts":
    "cinatra#2929 (lifecycle-b W2b) — the adapter that keeps the external agent's remote task stream",
  "src/lib/host-content-editor-dispatch.ts":
    "cinatra#2929 (lifecycle-b W2b) — the worker-backed adapter that keeps the widget content-edit run's blocking reply and its timeout",
});

/**
 * The two creator names, and every shape a file can reach one by.
 *
 * A CALL is the obvious shape and the easy one to miss things around. Three
 * others reach the same function and used to walk straight past this gate:
 *
 *   · `store.createAgentRun(...)` — a namespace or object access, which the
 *     call pattern's own left-boundary deliberately excludes so that the WORD
 *     inside a longer identifier is not a hit;
 *   · `import { createAgentRun as mint }` — an alias, after which no line in
 *     the file names the creator at all;
 *   · a call written across lines, whose `(` sits on the next line.
 *
 * So the gate reads the file's IMPORTS as well as its calls: naming a creator
 * in an import is itself the violation, whatever the file goes on to do with
 * it, and that closes the alias and the namespace at once. A namespace import
 * of the store (`import * as store from "./store"`) is a hit for the same
 * reason — it reaches every export without naming one.
 */
const CREATOR_NAMES = ["createAgentRun", "createAgentRunPendingInput"];

/** `X.createAgentRun(` / `X.createAgentRunPendingInput(` — a member call. */
const MEMBER_CALL = new RegExp(
  String.raw`\.\s*(?:${CREATOR_NAMES.join("|")})\s*\(`,
);

/** The store modules a creator can be imported FROM. */
const STORE_SPECIFIERS = [
  /from\s+["'](?:\.{1,2}\/)*store["']/,
  /from\s+["']@cinatra-ai\/agents(?:\/store)?["']/,
];

const BANNED = [
  {
    label: "createAgentRun(",
    re: /(?<![A-Za-z0-9_.])createAgentRun\s*\(/,
    allow: CREATE_ALLOWLIST,
    remedy:
      "Every agent run is created through `launchAgentRun` in packages/agents/src/lifecycle-coordinator.ts — it derives presence, owns the create-parked ordering, and states the run's lifecycle moment.",
  },
  {
    label: "member call on a creator",
    re: MEMBER_CALL,
    allow: CREATE_ALLOWLIST,
    remedy:
      "A creator reached through a namespace or an object is still a run created outside `launchAgentRun`.",
  },
];

/**
 * Every creator name this file IMPORTS, aliased or not, plus a namespace import
 * of a store module. Returns the offending fragments, or an empty array.
 */
export function creatorImports(source) {
  const hits = [];
  // Import statements can span lines; join the file and scan the statements.
  for (const m of source.matchAll(/import\s+([\s\S]*?)\s+from\s+["'][^"']+["']/g)) {
    const statement = m[0];
    if (!STORE_SPECIFIERS.some((re) => re.test(statement))) continue;
    if (/^\s*import\s+type\b/.test(statement)) continue;
    if (/import\s+\*\s+as\s+/.test(statement)) {
      hits.push(statement.replace(/\s+/g, " ").trim());
      continue;
    }
    for (const name of CREATOR_NAMES) {
      if (new RegExp(String.raw`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(m[1])) {
        hits.push(statement.replace(/\s+/g, " ").trim());
        break;
      }
    }
  }
  return hits;
}

async function collectFiles() {
  const out = execSync('git ls-files "src/**/*.ts" "src/**/*.tsx" "packages/**/*.ts" "packages/**/*.tsx"', {
    encoding: "utf8",
    cwd: REPO_ROOT,
  });
  return out
    .split("\n")
    .filter(Boolean)
    .filter((p) => !p.includes("/__tests__/"))
    .filter((p) => !/\.test\.tsx?$/.test(p));
}

function isLineComment(line) {
  return /^\s*(\/\/|\*|\/\*)/.test(line);
}

export async function scan(files, read) {
  const violations = [];
  const seenPendingCallers = new Set();
  const seenOwed = new Set();
  for (const rel of files) {
    const content = await read(rel);
    // THE IMPORT PASS, ahead of the line pass. Naming a creator in an import is
    // the violation on its own — that is what makes an alias unable to hide a
    // call, and a namespace import unable to reach one without naming it.
    if (!CREATE_ALLOWLIST.has(rel)) {
      for (const statement of creatorImports(content)) {
        if (rel in OWED_BY_ADAPTER) {
          seenOwed.add(rel);
          continue;
        }
        violations.push({
          file: rel,
          line: 1,
          label: "creator import",
          text: statement,
          remedy:
            "A file that imports a run creator can create a run. Import `launchAgentRun` from packages/agents/src/lifecycle-coordinator.ts instead.",
        });
      }
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (isLineComment(line)) continue;
      for (const rule of BANNED) {
        if (!rule.re.test(line) || rule.allow.has(rel)) continue;
        if (rel in OWED_BY_ADAPTER) {
          // Recorded, with its owner named. Not a violation TODAY, and the
          // stale-record pass below turns it into one the day it stops.
          seenOwed.add(rel);
          continue;
        }
        violations.push({ file: rel, line: i + 1, label: rule.label, text: line.trim(), remedy: rule.remedy });
      }
      if (/(?<![A-Za-z0-9_.])createAgentRunPendingInput\s*\(/.test(line)) {
        seenPendingCallers.add(rel);
        if (!(rel in PENDING_INPUT_CALLERS)) {
          violations.push({
            file: rel,
            line: i + 1,
            label: "createAgentRunPendingInput(",
            text: line.trim(),
            remedy:
              "A new caller of the pre-dispatch creator must be recorded in PENDING_INPUT_CALLERS with what it is for — or, better, routed through `launchAgentRun`.",
          });
        }
      }
    }
  }
  for (const [rel, owner] of Object.entries(OWED_BY_ADAPTER)) {
    if (!owner || owner.length < 20) {
      violations.push({
        file: rel,
        line: 1,
        label: "unowned record",
        text: `${rel} is recorded as owed with no owner named`,
        remedy: "An obligation with no owner is indistinguishable from a waiver — name the slice that routes it.",
      });
    }
    if (!seenOwed.has(rel)) {
      violations.push({
        file: rel,
        line: 1,
        label: "stale record",
        text: `OWED_BY_ADAPTER records ${rel}, which no longer creates a run outside the coordinator`,
        remedy: "The adapter landed — strike the row. A ratchet that outlives what it tracked is decoration.",
      });
    }
  }
  for (const rel of Object.keys(PENDING_INPUT_CALLERS)) {
    if (rel === "scripts/audit/run-creation-fence.mjs") continue;
    if (!seenPendingCallers.has(rel)) {
      violations.push({
        file: rel,
        line: 1,
        label: "stale record",
        text: `PENDING_INPUT_CALLERS records ${rel}, which no longer calls the pre-dispatch creator`,
        remedy: "Strike the row — a record that outlives its caller is a list nobody read.",
      });
    }
  }
  return violations;
}

async function main() {
  const files = await collectFiles();
  const violations = await scan(files, (rel) => readFile(resolve(REPO_ROOT, rel), "utf8"));
  if (violations.length === 0) {
    console.log(`[run-creation-fence] OK — ${files.length} files scanned, 0 violations`);
    process.exit(0);
  }
  console.error(`[run-creation-fence] FAIL — ${violations.length} violation(s):`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} [${v.label}] → ${v.text}`);
  }
  console.error(`\n${violations[0].remedy}`);
  process.exit(1);
}

if (process.argv[1] && process.argv[1].endsWith("run-creation-fence.mjs")) {
  main().catch((err) => {
    console.error(`[run-creation-fence] crashed: ${err.message}`);
    process.exit(2);
  });
}
