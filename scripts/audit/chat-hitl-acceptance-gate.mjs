#!/usr/bin/env node
/**
 * CHAT-HITL PROGRAM ACCEPTANCE GATE — the one entrypoint (cinatra#2573, epic
 * #2564 S7).
 *
 * WHAT THIS IS. S7's job is to prove the whole lifecycle-HITL program, and its
 * issue body is a list of SIXTEEN literal acceptance criteria. A prose checklist
 * rots silently — nobody re-verifies an already-ticked box — and this program
 * has learned that twice already (the org-write table sweep, the writer
 * manifest, and most recently the #1943 archive acceptance gate this file is
 * modelled on). So "#2573 is green" is a MECHANICAL claim: a manifest with one
 * row per literal criterion, each row pointing at a proof that exists where it
 * says it does.
 *
 * WHY IT MAPS RATHER THAN RE-AUTHORS. Twelve slices landed before this one and
 * each carries its own suite. Re-deriving those proofs here would double the
 * surface a future change must keep green, and a duplicate proof is worse than
 * no proof: when the two drift, neither is authoritative. So every row declares
 * a `disposition`:
 *
 *   MAPPED   the criterion is ALREADY fully proven by a landed slice's own test.
 *            The row names {file, testName} and this gate verifies that pair is
 *            grep-findable in the real tree — so a renamed or deleted test
 *            breaks S7's own check immediately.
 *   BUILT    the criterion had NO owner before S7. The proof is one of this
 *            slice's own artifacts and is named the same way.
 *   MISSING  the criterion is NOT proven, and the row says WHY in `gap`, with a
 *            `trackingIssue` where one exists. A MISSING row is an honest red —
 *            it is never a "covered by inspection" and never a silent pass.
 *
 * TWO MODES:
 *   `audit` (default) — the HONESTY check. Exactly 16 rows, one per literal
 *       criterion, pinned against CANONICAL_CRITERIA so a row can never drift
 *       from the issue's own wording; every row well-shaped for its disposition;
 *       every referenced {file, testName} pair actually present in the tree;
 *       every MISSING row carrying a `gap`; every non-MISSING row carrying at
 *       least one proof. Does NOT execute anything.
 *   `--strict` — the DONE check. Re-runs the whole shape validation, then
 *       requires every row to be MAPPED or BUILT. An all-red manifest is
 *       correctly reported NOT READY, never "clean" — conflating "no false green
 *       claim" with "done" would let a zero-progress manifest satisfy the one
 *       check whose entire purpose is proving the program finished.
 *
 * THE HONEST LIMIT, stated because a gate that overclaims is worse than none:
 * this verifies that a named proof EXISTS as a live declaration in the tree. It
 * does not execute it, and it cannot see whether CI runs the file it lives in.
 * The referenced suites are inside the root vitest include (or a pinned CI job),
 * so a deleted test shows up as a failure in that job's own run rather than
 * here; what THIS gate catches is the silent rename, the quiet deletion, and the
 * green claim with nothing behind it.
 *
 * THE ANCHOR CONTRACT rides it too (cinatra#2826, S9m). The manifest half checks
 * that a named proof exists; the capture half checks that a screenshot shows what
 * it claims; the anchor half checks that all of them are still talking about the
 * SAME drawing — a digest over the design pin, the executable DOM expectations
 * and the anchors a capture is graded against. A pin moved without an explicit
 * re-ratification fails HERE, which is the one place a reader looks to ask
 * whether the program's claims are current. See `lib/anchor-contract.mjs`.
 *
 * THE CAPTURE INDEX rides the same entrypoint. A criterion row names a proof;
 * a capture record names a SCREEN. The manifest half catches the proof that was
 * renamed away; the capture half catches the screenshot filed under a host it
 * does not show. Both run on every invocation, and both must be clean.
 *
 * Usage:
 *   node scripts/audit/chat-hitl-acceptance-gate.mjs            # audit
 *   node scripts/audit/chat-hitl-acceptance-gate.mjs --strict   # done-check
 *   node scripts/audit/chat-hitl-acceptance-gate.mjs --print-anchor-digest
 *
 * Exit 0 -> clean; exit 1 -> at least one violation; exit 2 -> script error.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CAPTURE_INDEX_PATH,
  isHistoricalPermalink,
  parsePermalink,
  readPinnedArtifact,
  repoPathOf,
  validateCaptureIndex as validateCanonicalIndex,
} from "../ci/lib/capture-record-contract.mjs";
import {
  ANCHOR_CONTRACT_PATH,
  anchorDigestInputs,
  auditAnchorContract,
  captureAnchorExpectations,
  computeAnchorDigest,
  loadAnchorContract,
} from "./lib/anchor-contract.mjs";
import {
  chatThreadRequirementsFor,
  hostTokenInCell,
  kindTokenInCell,
  stateTokenInCell,
  validateCaptureIndex,
} from "./lib/chat-hitl-capture-recorder.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_REPO_ROOT = join(__dirname, "..", "..");
const LABEL = "chat-hitl-acceptance";

export const MANIFEST_PATH = join(__dirname, "chat-hitl-acceptance-manifest.json");
// THE ONE CANONICAL INDEX, re-exported rather than recomputed from THIS
// directory. There used to be a `scripts/audit/chat-hitl-capture-index.json`
// beside this file that also called itself canonical, held no records, and was
// the capture driver's default output; this gate read it while the CI gate read
// the populated one. Both halves now resolve the same constant, which
// `scripts/ci/__tests__/capture-index-path.test.mjs` pins.
export { CAPTURE_INDEX_PATH, ANCHOR_CONTRACT_PATH };

/** The valid dispositions. See the header for what each one claims. */
export const DISPOSITIONS = ["MAPPED", "BUILT", "MISSING"];

/**
 * The SIXTEEN literal criteria from cinatra#2573's issue body, in order and
 * verbatim (trimmed of the checkbox marker only). This is the canonical set the
 * manifest is pinned against, so a row can never silently drift from the issue's
 * own wording — a typo, an accidental duplicate, or a criterion quietly dropped
 * all fail `audit`.
 */
export const CANONICAL_CRITERIA = [
  // --- In-app (production-equivalent Playwright + unit) ---
  "Chat-dispatch → typed chip-row hold → confirm → artifact → review card renders island + capture pair → focused-composer comment → `changes_requested` → repair successor in the same chat → verification chip → approve → effects release.",
  "Path-2: background gate pulled into a chat → decided there; the review page gate region renders the same card component.",
  "Propose → Confirm → scheduled fire; no-fire-without-confirm; token replay + concurrent double-Confirm return the original run; drain crash/retry idempotence incl. arm-before-expose and due-during-drain.",
  "Late stream subscription + reload re-render (decided gate shows resolved state); multiple concurrent gates require explicit composer focus.",
  "Island renders build-map, runtime, and floor renderer classes; refuses cross-origin framing.",
  "Multi-target Comment semantics match the page exactly; same-fingerprint idempotent retry AND different-fingerprint conflict races (page vs card vs widget).",
  "Forged/replayed suggestion IDs rejected; persisted refusal payloads contain no lifecycle identifiers (assert on `assistant_turns.content`).",
  // --- Widget ---
  "A signed-in reviewer decides a CMS review end-to-end from a real WP/Drupal widget: captures load via signed same-origin URLs; the decision travels from the widget review card into the same decision module; fingerprint/audit identical to in-app.",
  "The widget renders and operates the full lifecycle card set identically to first-party chat — same components, same human decisions, and the same audit contract; the authenticated principal is derived from the validated widget session and cannot be selected or overridden by the embedding site.",
  "Revocation-after-emission matrix: link/site/membership/token revoked between DATA_PART emission and stream resume / card refetch / decision / capture GET — each fails closed (no DOM, refusal, 4xx).",
  "Wrong-audience and cross-gate/cross-site action capabilities are refused; copied/expired/revoked capture URLs fail.",
  "Carrier-run exclusion proven: a widget content-editor carrier run emits no recommendation hold and no trigger interaction; the surface-matrix conformance test fails if any lifecycle interaction kind appears on a broker surface outside the matrix.",
  "`/embed/assistant` renders captures with NO island and refuses a nested island by ancestry.",
  // --- Program-wide ---
  "EXACTLY ONE card implementation per interaction across /chat, embed/widget, run card, and the review gate region — the parallel renderers (redirect card, panel chip-row mount, review-page direct composition) are gone (grep-gated).",
  "Conformance vs the S0 spec matrix (per surface, per card, per state) on a production-equivalent build with recorded screenshots.",
  "Production-boundary retirement identity greps stay zero (exact-identity constructions); the stale trigger-agent fixtures are gone.",
];

/** Proof kinds a row may carry. A row needs at least one unless it is MISSING. */
export const PROOF_KINDS = ["unitProofs", "integrationProofs", "e2eProofs", "gateProofs"];

function loadManifest(manifestPath = MANIFEST_PATH) {
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

/**
 * Is `{file, testName}` findable in the tree? For a test file, the name must
 * appear as a literal inside it (the repo's tests name themselves in
 * `it("…")` / `describe("…")`). For a GATE proof the `testName` is the gate's
 * own success label or an exported symbol, which is the same lexical check.
 *
 * Deliberately a substring match rather than a parse: the repo's test titles
 * carry template pieces (`` `${name} is refused…` ``) that no regex over source
 * can reconstruct, and a stricter check would reject honest rows. What this
 * catches is the case that actually happens — the file was renamed, or the test
 * was deleted.
 */
export function proofExists(
  proof,
  repoRoot = DEFAULT_REPO_ROOT,
  readFileImpl = null,
  readPinnedImpl = null,
  virtualFilesystem = false,
) {
  // THE SAME RULE AS EVERY OTHER READER OVERRIDE: honoured only under the
  // explicit flag. The positional signature is kept so an existing positional
  // caller still type-checks, but passing a reader WITHOUT the flag no longer
  // buys anything -- the overrides are dropped and the document is read from
  // where it really lives. Production passes neither.
  const readFile = virtualFilesystem === true ? readFileImpl : null;
  const readPinned = virtualFilesystem === true ? readPinnedImpl : null;
  // A PINNED PROOF. Once a proof document leaves the working tree, the row cites
  // it as a historical permalink into this repository at a full 40-char commit.
  // The document is READ BACK FROM THAT COMMIT with `git cat-file`, and the
  // lexical check below runs on those bytes exactly as it runs on a file in the
  // tree -- same rule, different source. A blob that cannot be produced is
  // reported, never waved through.
  if (isHistoricalPermalink(proof.file)) {
    const got = (readPinned ?? readPinnedArtifact)(proof.file, { repoRoot });
    if (!got.ok) {
      return { ok: false, reason: `pinned proof unreachable: ${got.reason}` };
    }
    const pinnedSource = got.bytes.toString("utf8");
    if (!pinnedSource.includes(proof.testName)) {
      return { ok: false, reason: `no "${proof.testName}" in ${proof.file}` };
    }
    return { ok: true, pinned: true };
  }
  if (proof.file?.startsWith("http://") || proof.file?.startsWith("https://")) {
    return {
      ok: false,
      reason: `"${proof.file}" is a URL but not a pinned permalink into this repository`,
    };
  }
  const abs = resolve(repoRoot, proof.file);
  let source;
  try {
    source = readFile ? readFile(proof.file) : readFileSync(abs, "utf8");
  } catch {
    return { ok: false, reason: `file not found: ${proof.file}` };
  }
  if (!source.includes(proof.testName)) {
    return { ok: false, reason: `no "${proof.testName}" in ${proof.file}` };
  }
  return { ok: true };
}

/** Every proof a row declares, flattened with its kind. */
export function proofsOf(row) {
  const out = [];
  for (const kind of PROOF_KINDS) {
    for (const p of row[kind] ?? []) out.push({ kind, ...p });
  }
  return out;
}

/**
 * Validate the manifest's SHAPE and its references. Pure over injected IO so the
 * pinned tests drive the same validator CI runs.
 */
export function auditManifest({
  manifest = loadManifest(),
  repoRoot = DEFAULT_REPO_ROOT,
  readFileImpl = null,
  // TEST-ONLY, and the ONE name that unlocks every reader override in this
  // module. Without it an injected reader is ignored and every cited proof is
  // read from the tree or from git history, as it is in production.
  virtualFilesystem = false,
} = {}) {
  const violations = [];
  const rows = manifest.rows ?? [];

  if (rows.length !== CANONICAL_CRITERIA.length) {
    violations.push(
      `the manifest has ${rows.length} rows; cinatra#2573's issue body has ${CANONICAL_CRITERIA.length} criteria`,
    );
  }

  const seen = new Set();
  rows.forEach((row, i) => {
    const where = `row ${i + 1}`;
    if (typeof row.criterion !== "string") {
      violations.push(`${where}: no criterion`);
      return;
    }
    if (seen.has(row.criterion)) violations.push(`${where}: duplicate criterion`);
    seen.add(row.criterion);
    if (!CANONICAL_CRITERIA.includes(row.criterion)) {
      violations.push(
        `${where}: criterion is not one of the issue's literal criteria — it reads\n      ${row.criterion}`,
      );
    }
    if (CANONICAL_CRITERIA[i] !== row.criterion) {
      violations.push(`${where}: out of order — expected\n      ${CANONICAL_CRITERIA[i]}`);
    }
    if (!DISPOSITIONS.includes(row.disposition)) {
      violations.push(`${where}: disposition "${row.disposition}" is not one of ${DISPOSITIONS.join("/")}`);
      return;
    }

    const proofs = proofsOf(row);
    if (row.disposition === "MISSING") {
      if (!row.gap || row.gap.length < 20) {
        violations.push(`${where}: MISSING rows must say WHY, in \`gap\` (a real sentence)`);
      }
    } else if (proofs.length === 0) {
      violations.push(`${where}: ${row.disposition} with no proof — name one`);
    }
    // EVERY declared proof is verified, on EVERY disposition. A MISSING row
    // routinely carries the proofs of the clauses that ARE met (a criterion is
    // often part-proven), and a stale reference inside one of those is exactly
    // as misleading as a stale reference on a green row.
    for (const p of proofs) {
      if (!p.file || !p.testName) {
        violations.push(`${where}: a ${p.kind} entry is missing file/testName`);
        continue;
      }
      const found = proofExists(p, repoRoot, readFileImpl, null, virtualFilesystem);
      if (!found.ok) violations.push(`${where}: ${found.reason}`);
    }

    // A partially-proven criterion is a real and common state; it must be
    // declared rather than rounded up. `partial` carries what is NOT covered.
    if (row.partial && (!row.gap || row.gap.length < 20)) {
      violations.push(`${where}: \`partial\` set without a \`gap\` sentence saying what is uncovered`);
    }
  });

  return violations;
}

/** Strict mode: shape + every row proven. */
export function strictReport({ manifest = loadManifest(), ...rest } = {}) {
  const violations = auditManifest({ manifest, ...rest });
  const rows = manifest.rows ?? [];
  const unproven = rows.filter((r) => r.disposition === "MISSING");
  const partial = rows.filter((r) => r.disposition !== "MISSING" && r.partial);
  return { violations, unproven, partial, total: rows.length };
}

/** The committed capture index. */
export function loadCaptureIndex(indexPath = CAPTURE_INDEX_PATH) {
  return JSON.parse(readFileSync(indexPath, "utf8"));
}

/**
 * Audit the capture index: schema, hashes, URL class, required host assertions
 * and their observed counts. Pure over injected IO, like `auditManifest`, so the
 * pinned fixtures drive the same validator CI runs.
 */
export function auditCaptureIndex({
  index = loadCaptureIndex(),
  repoRoot = DEFAULT_REPO_ROOT,
  // NO DEFAULT HASHER. It used to default to a plain "hash whatever is at this
  // path" reader, and injecting a hasher is what tells the validator its caller
  // is supplying a virtual filesystem -- so this entrypoint was opting itself
  // out of the resolved-path check on every run. Left undefined, the validator
  // hashes from disk AND resolves the path first. A suite may still pass one.
  hashOf,
  tier = "graded",
} = {}) {
  // THE CANONICAL FLOOR, FIRST, for EVERY record. The ratified contract owns
  // what a record is; this tier's extras are graded on top of it (see
  // `RECORD_TIERS` in the recorder). Running the floor here rather than relying
  // on the CI gate to run it means this entrypoint refuses a mislabeled capture
  // on its own, which is what "both must be clean" is supposed to mean.
  const canonical = validateCanonicalIndex(index, { repoRoot }).violations.map(
    (v) => `[canonical] ${v.cell ? `record "${v.cell}": ` : ""}${v.code} — ${v.detail}`,
  );
  return [...canonical, ...validateCaptureIndex({ index, hashOf, repoRoot, tier })];
}

/** A cell name without its image extension. */
function cellKey(name) {
  return String(name ?? "").replace(/\.(png|jpe?g|webp)$/i, "");
}

/**
 * Every manifest proof that NAMES a chat_thread cell.
 *
 * A manifest row points at proofs; a proof that names a chat-thread capture cell
 * is a claim that a card was photographed inside the chat. This finds those
 * claims so the next function can demand the evidence behind them.
 */
export function chatThreadCellClaims(manifest) {
  const claims = [];
  for (const [i, row] of (manifest.rows ?? []).entries()) {
    for (const proof of proofsOf(row)) {
      if (hostTokenInCell(proof.testName) !== "chat_thread") continue;
      // Tokens are read off the cell KEY, not the raw proof name: a trailing
      // `.png` puts a `.` where the token boundary is expected and silently
      // turns "decided" into no claim at all.
      const key = cellKey(proof.testName);
      claims.push({
        row: i + 1,
        cell: key,
        file: proof.file,
        // The PROOF TIER (unitProofs / e2eProofs / …), not a lifecycle kind.
        // Named plainly because the earlier spelling read like the latter and
        // invited a reader to think it was being checked against the record.
        proofTier: proof.kind,
        // The lifecycle kind the CELL NAME claims, when it names one. This is
        // what the record must agree with — otherwise a record's self-declared
        // kind would be authoritative over the row that cites it.
        claimedKind: kindTokenInCell(key),
        // The state the cell name claims. A `decided` cell answered with pending
        // evidence would be judged against the easier requirement set.
        claimedState: stateTokenInCell(key),
      });
    }
  }
  return claims;
}

/**
 * EVERY screenshot-like proof in the manifest, with the host its name declares.
 *
 * The binding below is keyed off a host token in the cell name, which makes it
 * opt-in: renaming `__chat_thread__` to `__chat__` would drop the claim and the
 * evidence requirement with it. This inventory is the answer — the pinned suite
 * asserts the exact list, so a rename changes it and fails there, whatever the
 * binding then computes. A capture cannot be un-claimed by relabelling it.
 */
export function screenshotProofInventory(manifest = loadManifest()) {
  const out = [];
  for (const [i, row] of (manifest.rows ?? []).entries()) {
    for (const proof of proofsOf(row)) {
      if (!/\.(png|jpe?g|webp)$/i.test(String(proof.testName ?? ""))) continue;
      out.push({
        row: i + 1,
        cell: cellKey(proof.testName),
        host: hostTokenInCell(proof.testName),
      });
    }
  }
  return out.sort((a, b) => a.cell.localeCompare(b.cell) || a.row - b.row);
}

/**
 * THE BINDING. An unindexed screenshot counts as ZERO.
 *
 * Every manifest cell that names `chat_thread` must resolve to a record in the
 * canonical index, and that record must be a chat capture with the card really
 * in it: the chat URL class, and same-frame counts of at least one for the
 * conversation list, the kind's own card root, the `chat_thread` host
 * declaration, and the kind's decision controls. A file name on a README is not
 * evidence; this is what makes the index non-vacuous.
 *
 * Returns violations. `--strict` and `audit` both refuse them, and the pinned
 * suite asserts the exact set that is unbound today, so a later round cannot add
 * an unindexed chat screenshot and stay green.
 */
export function auditManifestIndexBinding({ manifest = loadManifest(), index = loadCaptureIndex() } = {}) {
  const violations = [];
  const byCell = new Map((index.records ?? []).map((r) => [cellKey(r.cell), r]));

  for (const claim of chatThreadCellClaims(manifest)) {
    const record = byCell.get(claim.cell);
    if (!record) {
      violations.push(
        `manifest row ${claim.row} claims the chat_thread cell "${claim.cell}" (${claim.file}), ` +
          "and no record in the capture index carries that cell — an unindexed screenshot counts as zero",
      );
      continue;
    }
    if (record.declaredHost !== "chat_thread") {
      violations.push(
        `manifest row ${claim.row} claims "${claim.cell}" as chat_thread; its record declares "${record.declaredHost}"`,
      );
      continue;
    }
    // The row's own claim wins over the record's self-declaration. Without
    // this, a proof cited for one kind binds happily to a record photographing
    // another, and the record decides what the row proved.
    if (claim.claimedKind !== null && claim.claimedKind !== record.declaredKind) {
      violations.push(
        `manifest row ${claim.row} cites "${claim.cell}" for ${claim.claimedKind}; ` +
          `its record photographs ${record.declaredKind}`,
      );
      continue;
    }
    // THE IMAGE MUST LIVE WHERE THE CITING PROOF LIVES, in the same PLACE and
    // at the same MOMENT. Without the place, the row cites one proof folder's
    // README while its record points at a screenshot in another and the two
    // halves of the claim never meet. Both sides are read as the IN-REPOSITORY
    // PATH first, so a pinned permalink and a live path compare on one axis.
    const claimPath = repoPathOf(claim.file);
    const shotPath = repoPathOf(record.screenshot);
    const claimDir = claimPath.slice(0, claimPath.lastIndexOf("/"));
    if (claimDir && !shotPath.startsWith(`${claimDir}/`)) {
      violations.push(
        `manifest row ${claim.row} cites "${claim.cell}" from ${claim.file}, but its record's ` +
          `screenshot is ${record.screenshot} — the image must sit with the proof that cites it`,
      );
      continue;
    }
    // ...AND AT THE SAME MOMENT. Reading both halves as paths is what makes the
    // place comparable, and on its own it throws the COMMIT away: a README
    // pinned at one commit and a screenshot pinned at another satisfy the
    // directory rule while never having coexisted in any tree, which is a
    // bundle assembled after the fact rather than a round that happened. When
    // both halves are pinned they must name the SAME commit. Every file of one
    // proof directory is pinned at that directory's own last commit, so an
    // honest bundle satisfies this by construction; a hand-assembled one does
    // not. A live path is exempt: it has no commit to agree with.
    const claimPin = parsePermalink(claim.file);
    const shotPin = parsePermalink(record.screenshot);
    if (claimPin && shotPin && claimPin.sha !== shotPin.sha) {
      violations.push(
        `manifest row ${claim.row} cites "${claim.cell}" from a proof pinned at ${claimPin.sha}, ` +
          `but its record's screenshot is pinned at ${shotPin.sha} — the two halves of the claim ` +
          "were never in the same tree, so they are not one round",
      );
      continue;
    }
    if (
      claim.claimedState !== null &&
      claim.claimedState !== (record.declaredState ?? "pending")
    ) {
      violations.push(
        `manifest row ${claim.row} cites "${claim.cell}" as ${claim.claimedState}; ` +
          `its record photographs ${record.declaredState ?? "pending"}`,
      );
      continue;
    }
    // Observations are keyed by SCOPE, selector AND `within` — the canonical
    // contract's own key plus the root a root-scoped count names. An earlier arm
    // matched on frame alone, so a frame-wide count satisfied a requirement meant
    // to be taken INSIDE the card root; the scope key closed that, and `within`
    // closes the rest of it: an observation taken inside a DIFFERENT root
    // answers a different question and can no longer stand in for this one. An
    // observation that names no root is the canonical spelling, read as
    // answering the requirement exactly as that half reads it.
    const observationFor = (selector, scope, within) =>
      (record.assertions ?? []).find(
        (a) =>
          a?.selector === selector &&
          (a?.scope ?? "frame") === scope &&
          (a?.within === undefined || within === undefined || a.within === within),
      );
    // PRESENT means painted, WHEN THE RECORD CLAIMS A PAINTED COUNT. The binding
    // asks the same question the record's own validator does, at the same
    // grading: a screenshot whose card is attached-but-unrendered cannot satisfy
    // a manifest row here after failing there, and a record written by the
    // canonical driver — which records attachment only, and labels no
    // observation — is read the way that half reads it rather than refused for
    // fields it never claimed.
    const satisfies = (selector, scope, within, wanted) => {
      const found = observationFor(selector, scope, within);
      if (!found || (found.expect ?? wanted) !== wanted) return false;
      if (wanted !== "present") return found.count === 0;
      if (found.count < 1) return false;
      return found.visible === undefined || found.visible >= 1;
    };
    // The SAME tier predicate the record validator uses: a record that pins a
    // card root speaks this tier and owes its whole set; one that does not is
    // read the way the canonical half reads it.
    const strict = record.instance !== undefined;
    for (const req of chatThreadRequirementsFor(
      record.declaredKind,
      record.declaredState ?? "pending",
    )) {
      // This tier's root-scoped ADDITION is asked of records that pin a card
      // root; the rest is the canonical requirement set either way.
      if (req.tier === "audit" && !strict) continue;
      const wanted = req.expect ?? "present";
      // The canonical `any` group (Confirm OR Skip) is honoured for a record
      // that claims no more than the canonical half; this tier requires every
      // member of the group from a record written at its own tier.
      if (
        !strict &&
        req.any &&
        req.any.some((sel) => (observationFor(sel, req.scope, req.within)?.count ?? 0) >= 1)
      ) {
        continue;
      }
      if (!satisfies(req.selector, req.scope, req.within, wanted)) {
        violations.push(
          `manifest row ${claim.row}: the record for "${claim.cell}" does not observe ` +
            `${req.selector} ${wanted} (${req.scope}-scoped)`,
        );
      }
    }
  }
  return violations;
}

function summarise(rows) {
  const counts = { MAPPED: 0, BUILT: 0, MISSING: 0 };
  for (const r of rows) counts[r.disposition] = (counts[r.disposition] ?? 0) + 1;
  return counts;
}

function main(argv) {
  const strict = argv.includes("--strict");
  if (!existsSync(MANIFEST_PATH)) {
    console.error(`[${LABEL}] manifest not found at ${MANIFEST_PATH}`);
    return 2;
  }
  const manifest = loadManifest();

  // The re-ratification helper: print what the digest WOULD be, and write
  // nothing. Deliberately read-only — a digest a script refreshes on its own
  // alarms about nothing, so the new value is pasted by the person who
  // re-examined the anchors.
  if (argv.includes("--print-anchor-digest")) {
    if (!existsSync(ANCHOR_CONTRACT_PATH)) {
      console.error(`[${LABEL}] anchor contract not found at ${ANCHOR_CONTRACT_PATH}`);
      return 2;
    }
    const anchorContract = loadAnchorContract();
    const digest = computeAnchorDigest(
      anchorDigestInputs({
        specCommit: manifest.specCommit,
        domExpectations: anchorContract.domExpectations,
        captureAnchors: captureAnchorExpectations(),
        // The fourth input, RECORDED since the pin was adopted at the current
        // revision (cinatra#3144, cinatra#3175). It is absent from the digest
        // only while the contract carries no such array.
        anchorsUnresolvedAtPin: anchorContract.anchorsUnresolvedAtPin,
      }),
    );
    console.log(`[${LABEL}] design pin  : ${manifest.specCommit}`);
    console.log(`[${LABEL}] recorded    : ${anchorContract.digest}`);
    console.log(`[${LABEL}] recomputed  : ${digest}`);
    return 0;
  }

  if (!existsSync(ANCHOR_CONTRACT_PATH)) {
    console.error(`[${LABEL}] anchor contract not found at ${ANCHOR_CONTRACT_PATH}`);
    return 2;
  }
  const anchorViolations = auditAnchorContract({ manifest });
  if (anchorViolations.length > 0) {
    console.error(
      `[${LABEL}] ${anchorViolations.length} anchor-contract violation(s) — the design pin, the ` +
        "executable DOM expectations and the capture anchors must be re-ratified together:\n",
    );
    for (const v of anchorViolations) console.error(`  ${v}`);
    return 1;
  }
  const rows = manifest.rows ?? [];
  const counts = summarise(rows);

  // The capture half runs on EVERY invocation. A mislabeled capture is a false
  // green whether or not the manifest is being asked whether it is done.
  if (!existsSync(CAPTURE_INDEX_PATH)) {
    console.error(`[${LABEL}] capture index not found at ${CAPTURE_INDEX_PATH}`);
    return 2;
  }
  const captureIndex = loadCaptureIndex();
  const captureViolations = [
    ...auditCaptureIndex({ index: captureIndex }),
    ...auditManifestIndexBinding({ manifest, index: captureIndex }),
  ];
  if (captureViolations.length > 0) {
    console.error(
      `[${LABEL}] ${captureViolations.length} capture-index violation(s) — a capture's ` +
        "declared host must match its recorded anchors; file names carry no authority:\n",
    );
    for (const v of captureViolations) console.error(`  ${v}`);
    return 1;
  }
  const captureCount = (captureIndex.records ?? []).length;

  if (!strict) {
    const violations = auditManifest({ manifest });
    if (violations.length === 0) {
      console.log(
        `[${LABEL}] manifest honest — ${rows.length} rows ` +
          `(${counts.MAPPED} MAPPED, ${counts.BUILT} BUILT, ${counts.MISSING} MISSING); ` +
          "every named proof exists in the tree. " +
          `Capture index host-anchored — ${captureCount} record(s). ` +
          "Anchor contract ratified at the manifest's design pin.",
      );
      return 0;
    }
    console.error(`[${LABEL}] ${violations.length} manifest violation(s):\n`);
    for (const v of violations) console.error(`  ${v}`);
    return 1;
  }

  const { violations, unproven, partial, total } = strictReport({ manifest });
  if (violations.length > 0) {
    console.error(`[${LABEL}] --strict: the manifest is malformed before it can be judged:\n`);
    for (const v of violations) console.error(`  ${v}`);
    return 1;
  }
  if (unproven.length > 0 || partial.length > 0) {
    console.error(
      `[${LABEL}] NOT READY — ${total - unproven.length}/${total} criteria proven, ` +
        `${unproven.length} MISSING, ${partial.length} partial:\n`,
    );
    for (const r of unproven) console.error(`  MISSING  ${r.criterion}\n           gap: ${r.gap}`);
    for (const r of partial) console.error(`  PARTIAL  ${r.criterion}\n           gap: ${r.gap}`);
    return 1;
  }
  console.log(
    `[${LABEL}] READY — ${total}/${total} criteria proven, none partial; ` +
      `capture index host-anchored (${captureCount} record(s)).`,
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(`[${LABEL}] fatal:`, e);
    process.exit(2);
  }
}
