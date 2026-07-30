/**
 * WHY the readiness receipt says "22 skill(s) uploaded" while the Cinatra
 * assistant's own required bundle is not among them (cinatra#2094 finding F7,
 * part A) — measured by calling the PRODUCT's own candidate builder, not by
 * re-deriving anything.
 *
 * This replaces the S7 lane's vacuous post-teardown diagnostic
 * (`results/F7-sync-key-diagnosis-POST-TEARDOWN-VACUOUS.txt`) for part A: it
 * runs `buildSyncCandidatesWithRefusals()` — the exact function the strict
 * catalog sync runs inside its namespace lock — against the LIVE lane database
 * and prints, per refused skill, the router references its STORED bundle does
 * not ship. Those are the skills the fail-closed one-hop lint (cinatra#2089, S2)
 * excludes from every upload.
 *
 * It reads only; it uploads nothing and mutates nothing.
 *
 * Run with the app's own env + TS resolution:
 *   node --env-file=.env.local --import tsx evidence/.../diagnose-sync-refusals.mjs
 *
 * LEAK GATE: prints catalog skill ids and bundle-relative file paths only —
 * never bundle bytes, never a credential, never an absolute machine path.
 */
import process from "node:process";

const { buildSyncCandidatesWithRefusals } = await import(
  "../../../../src/lib/anthropic-skill-sync-service.ts"
);

// The Cinatra assistant's required bundle — the set whose absence makes the
// first /chat turn fail loud. Kept as literals so this driver does not import
// the runtime config (which would drag the server-only chat graph in).
const ASSISTANT_REQUIRED = [
  "@cinatra-ai/chat:chat-assistant-core",
  "@cinatra-ai/chat:chat-extension-authoring",
  "@cinatra-ai/chat:chat-automation-authoring",
  "@cinatra-ai/chat:company-research",
  "@cinatra-ai/chat:blog-content",
];

const { candidates, refusedForDanglingReferences } = await buildSyncCandidatesWithRefusals();
const candidateIds = new Set(candidates.map((c) => c.catalogSkillId));
const refusedById = new Map(refusedForDanglingReferences.map((r) => [r.catalogSkillId, r.missing]));

console.log(`candidates: ${candidates.length}`);
console.log(`refused by the fail-closed one-hop lint: ${refusedForDanglingReferences.length}`);
for (const r of refusedForDanglingReferences) {
  console.log(`  REFUSED ${r.catalogSkillId} -> missing bundled file(s): ${r.missing.join(", ")}`);
}
console.log("\nassistant-required bundle:");
let missingForAssistant = 0;
for (const id of ASSISTANT_REQUIRED) {
  const isCandidate = candidateIds.has(id);
  const refused = refusedById.get(id);
  if (!isCandidate) missingForAssistant += 1;
  console.log(
    `  ${id}: candidate=${isCandidate}` +
      (refused ? ` REFUSED(missing=${refused.join(",")})` : isCandidate ? "" : " ABSENT(not refused — no stored bundle)"),
  );
}
console.log(
  `\nVERDICT: ${missingForAssistant}/${ASSISTANT_REQUIRED.length} of the assistant's required skills are NOT upload candidates`,
);
process.exit(0);
