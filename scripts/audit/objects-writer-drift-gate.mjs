#!/usr/bin/env node
// Canonical history-aware writer guard.
//
// Bans direct DML (INSERT / UPDATE / DELETE) against `cinatra.objects` from
// any code path outside the allowlist below. The allowlist is the SINGLE
// canonical writer module + the small ring of legacy writer files that
// will themselves migrate to delegate through the canonical writer; new
// writers OUTSIDE this ring fail CI.
//
// Reads are allowed (SELECT / EXPLAIN). DDL (CREATE / ALTER / DROP) is
// allowed in the DDL owner (`src/lib/drizzle-store.ts`) + migration
// scripts. Tests + audit scripts are excluded.
//
// Exit 0 → clean; exit 1 → at least one violation, lines printed to stderr.
//
// Usage:
//   node scripts/audit/objects-writer-drift-gate.mjs
//
// Policy: block mutation DML, allow reads. Allowlist entries must be
// rare and reviewed.

import { readFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const REPO_ROOT = execSync("git rev-parse --show-toplevel", {
  encoding: "utf8",
}).trim();

// Allowlist of files allowed to issue DML against cinatra.objects.
const WRITER_ALLOWLIST = new Set([
  // The canonical history-aware writer module — the only "new code" path.
  "src/lib/object-history/canonical-writer.ts",
  "src/lib/object-history/change-set.ts",
  "src/lib/object-history/eligibility.ts",
  "src/lib/object-history/restore-engine.ts",
  // Legacy writers (kept as facades; a follow-up routes them through
  // canonical-writer for full compliance). They are still single-tenant
  // + atomic-outbox-correct.
  "src/lib/objects-store.ts",
  "src/lib/objects-dual-write.ts",
  // DDL owner.
  "src/lib/drizzle-store.ts",
  // Self-allowlist (the gate names the pattern; it must mention the table
  // name + the keywords or it would always self-fail).
  "scripts/audit/objects-writer-drift-gate.mjs",
  // Worker-side projection metadata writers — not application mutations.
  // These update graphiti_* columns (sync_status, projected_version) that
  // are explicitly stripped from history snapshots (see
  // buildSnapshotFromRow). Allowlisted because they don't carry a
  // history event for application-visible state changes — they record
  // projection progress, not data semantics.
  "packages/objects/src/graphiti-projector.ts",
  // Artifact stores — semantic_artifact, representation, assertion. These
  // are CTE-atomic writers that already keep their own
  // graphiti_projection_outbox row + version bump. Migration to canonical
  // writer is a follow-up.
  "src/lib/artifacts/artifact-creation.ts",
  "src/lib/artifacts/artifact-retention.ts",
  "src/lib/artifacts/semantic-assertion-store.ts",
  // Project-move cascade — UPDATE objects SET project_id; documented
  // legacy writer that a follow-up routes through canonical writer.
  "src/lib/resource-project-move.ts",
]);

// Allowlisted glob roots — paths matching any prefix are exempt entirely.
// Migrations + audit scripts + docs.
const ROOT_ALLOWLIST = [
  "src/lib/migrations/",
  "scripts/",
  "docs/",
];

// DML pattern. Must appear adjacent to the "objects" table identifier; we
// require the table name in quotes OR after a schema-qualified prefix so
// random "objects" strings (e.g. in API JSON, OAS, comments) don't trigger.
// The token regexes use word-boundaries to avoid matching `objectsUpdateSchema`.
const TABLE_TOKENS = [
  // quoted, exact: "objects"
  /"objects"/,
  // schema-qualified, exact: ${schema}."objects"
  /\."objects"/,
];

// DML verbs as standalone tokens — must be followed by whitespace or a
// quote, NOT by another identifier character. Prevents matching
// "UPDATE" inside `objectsUpdateSchema` or `objects_update`.
const DML_PATTERNS = [
  // INSERT INTO ... "objects"
  { label: "INSERT INTO", re: /\bINSERT\s+INTO\b/i },
  // UPDATE "objects" or UPDATE "${schema}"."objects" or UPDATE table
  // (we require a quote, schema-qualified pattern, or whitespace + quote
  // after UPDATE to avoid matching `objectsUpdate*` identifiers).
  { label: "UPDATE", re: /\bUPDATE\s+["`]/i },
  // DELETE FROM ... "objects"
  { label: "DELETE FROM", re: /\bDELETE\s+FROM\b/i },
];

function looksLikeDmlAgainstObjects(line) {
  // First, line must contain a DML keyword as a real SQL token, not as
  // part of an identifier.
  let matchedVerb = null;
  for (const { label, re } of DML_PATTERNS) {
    if (re.test(line)) {
      matchedVerb = label;
      break;
    }
  }
  if (!matchedVerb) return null;
  // Then, the same line must contain the "objects" table identifier in a
  // SQL-shape (quoted or schema-qualified). Avoids matching
  // `objectsUpdateSchema` etc.
  for (const tokenRe of TABLE_TOKENS) {
    if (tokenRe.test(line)) {
      return { verb: matchedVerb, token: tokenRe.source };
    }
  }
  return null;
}

function isCommentLine(line) {
  return /^\s*(\/\/|\*|\/\*|#)/.test(line);
}

async function collectFiles() {
  const out = execSync(
    'git ls-files "src/**/*.ts" "src/**/*.tsx" "packages/**/*.ts" "packages/**/*.tsx"',
    { encoding: "utf8" },
  );
  return out
    .split("\n")
    .filter(Boolean)
    .filter(
      (p) =>
        !p.endsWith(".test.ts") &&
        !p.endsWith(".test.tsx") &&
        !p.includes("/__tests__/") &&
        !p.includes(".d.ts"),
    )
    .filter((p) => !ROOT_ALLOWLIST.some((root) => p.startsWith(root)));
}

async function main() {
  const files = await collectFiles();
  const violations = [];
  for (const rel of files) {
    if (WRITER_ALLOWLIST.has(rel)) continue;
    const content = await readFile(resolve(REPO_ROOT, rel), "utf8");
    const lines = content.split("\n");
    // Scan with a small lookahead window to catch multi-line SQL where
    // the DML verb and the table name land on different lines (e.g.
    // template-literal SQL split across rows).
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (isCommentLine(line)) continue;
      const m = looksLikeDmlAgainstObjects(line);
      if (m) {
        violations.push({ file: rel, line: i + 1, verb: m.verb, token: m.token, text: line.trim() });
        continue;
      }
      // Look for INSERT INTO / DELETE FROM that may continue onto the
      // next 1-4 lines with the table identifier landing later. (UPDATE
      // is excluded from the multi-line lookahead because it's commonly
      // a function/variable name fragment; restricting UPDATE to a
      // single-line match removes the false-positive tail.)
      for (const { label, re } of DML_PATTERNS) {
        if (label === "UPDATE") continue;
        if (!re.test(line)) continue;
        for (let j = 1; j <= 4 && i + j < lines.length; j++) {
          const peek = lines[i + j];
          for (const tokenRe of TABLE_TOKENS) {
            if (tokenRe.test(peek)) {
              violations.push({
                file: rel,
                line: i + 1,
                verb: label,
                token: tokenRe.source,
                text: line.trim() + " ... " + peek.trim(),
              });
            }
          }
        }
      }
    }
  }
  if (violations.length === 0) {
    console.log(
      "[objects-writer-drift-gate] clean — no direct DML against cinatra.objects outside the allowlist.",
    );
    process.exit(0);
  }
  console.error(
    `[objects-writer-drift-gate] ${violations.length} violation(s) — direct DML against cinatra.objects must go through @/lib/object-history/canonical-writer.ts:\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.verb} ${v.token}]  ${v.text}`);
  }
  console.error(
    `\nFix: route through historyAwareUpsert / historyAwareSoftDelete / historyAwareTombstone (@/lib/object-history). New writer files must be added to the WRITER_ALLOWLIST in this script ONLY when they themselves emit canonical history events.`,
  );
  process.exit(1);
}

main().catch((e) => {
  console.error("[objects-writer-drift-gate] fatal:", e);
  process.exit(2);
});
