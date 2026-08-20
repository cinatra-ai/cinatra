#!/usr/bin/env node
/**
 * ONE CARD PER INTERACTION — the structural gate (cinatra#2573, epic #2564 S7).
 *
 * S7's program-wide acceptance criterion, verbatim:
 *
 *   "EXACTLY ONE card implementation per interaction across /chat, embed/widget,
 *    run card, and the review gate region — the parallel renderers (redirect
 *    card, panel chip-row mount, review-page direct composition) are gone
 *    (grep-gated)."
 *
 * WHY A GATE AND NOT A TEST. The epic's whole thesis is that each lifecycle
 * question is ONE component rendered everywhere, and that the pre-epic world had
 * three look-alikes instead. A look-alike does not announce itself: it is a
 * plausible, well-written second renderer that drifts from the first over a few
 * quarters until two surfaces disagree about what "approved" means. Individual
 * slices proved their own host clean (S2's card suite reads
 * `agentic-run-panel.tsx`, S4's reads the stepper). Nothing read the WHOLE tree,
 * so a fourth host could grow a fourth renderer and every slice suite would stay
 * green. This is that whole-tree read.
 *
 * WHAT IT ENFORCES — four independent rules:
 *
 *   R1 SOLE RENDERER. For each interaction kind, exactly ONE module may DEFINE
 *      the card component, and it is the module named in CARD_OWNERS below.
 *      Anywhere else, declaring a component whose name is that card's — or a
 *      `Prefixed…` look-alike of it — is a violation.
 *
 *   R2 THE RETIRED PARALLELS ARE GONE. The renderers the epic ordered deleted
 *      may not come back, by name (or, for §VII, by anchor):
 *        · the review REDIRECT card (`ArtifactReviewRedirectCard`) — the
 *          display-only "Continue to review" link that sent a reader away;
 *        · a DIRECT `<RunRecommendationChipRow` mount on a lifecycle HOST — the
 *          pre-S4 poll-driven panel mount;
 *        · the review page's DIRECT decision composition — a `<ReviewDecisionBar`
 *          mounted by the page instead of by the card. (Scoped to the BAR: the
 *          page's own ROUTE-LEVEL `ReviewGateBlocked` panel is legitimate and
 *          uses the shipped component — see the entry's own note.)
 *        · the review page's DIRECT §VII composition — `VerificationView`
 *          drawing the verification core itself instead of mounting
 *          `VerificationSummaryCard`. (Scoped to the §VII ANCHORS, not to the
 *          component name: `VerificationView` legitimately survives as the
 *          page's adjunct composition — see the entry's own note.)
 *
 *   R3 EVERY MOUNT IS HOST-DECLARED. A lifecycle card may only be mounted
 *      inside a `LifecycleCardSurfaceProvider` subtree, so the fail-closed host
 *      gate cannot be bypassed by a surface that simply renders the component.
 *      Checked per FILE (a mount and its provider live in one component tree).
 *
 *   R4 ONE REGISTRY ENTRY PER KIND. The renderable-view component registry maps
 *      each lifecycle viewType exactly once; a second dispatch table anywhere is
 *      a parallel registry by another name.
 *
 * KNOWN RESIDUALS, recorded rather than hidden (same posture as the sibling
 * writer guards):
 *
 *   MISSES (accepted):
 *   - A renderer that copies the DRAWING without matching the naming patterns
 *     (`MyGateThing`) is invisible to a lexical guard. R3 still catches it if it
 *     mounts under a declared host and R4 if it registers; a genuinely novel
 *     name that never registers and never declares a host is a review catch.
 *   - A mount produced by indirection (`const C = cond ? A : B; <C/>`).
 *   - Per-file provider checking cannot see a provider supplied by a PARENT file
 *     — which is exactly why the two known such mounts are allowlisted BY NAME
 *     in HOST_PROVIDED_BY_PARENT, each with the parent that provides it.
 *
 *   OVER-DETECTION (accepted, and preferred):
 *   - A prose mention inside a string literal reads like code. The scan is
 *     comment-stripped, so genuine prose in comments is safe; a deliberate
 *     string is flagged. A spurious red is one conversation; a miss is a second
 *     approval surface.
 *
 * Exit 0 -> clean; exit 1 -> at least one violation; exit 2 -> scanner error.
 *
 * Usage: node scripts/audit/chat-hitl-one-card-gate.mjs
 */

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./lib/strip-comments.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_REPO_ROOT = join(__dirname, "..", "..");
const LABEL = "chat-hitl-one-card";

/**
 * The SOLE module that may define each interaction's card component, and the
 * component-name pattern that identifies a definition of that card.
 *
 * The four kinds are the closed set in
 * `packages/agent-ui-protocol/src/renderable-views/lifecycle-cards.ts`
 * (`LIFECYCLE_CARD_KINDS`); adding a fifth interaction means adding a row here,
 * which is the point — a new card is a design decision with an owner.
 */
export const CARD_OWNERS = Object.freeze({
  artifact_review_gate: {
    component: "ReviewGateCard",
    owner: "packages/agents/src/review-gate-card.tsx",
  },
  recommendation_hold: {
    component: "RecommendationHoldCard",
    owner: "packages/agents/src/run-recommendation-chip-row.tsx",
  },
  // S9e (cinatra#2789) DREW the verification card, so this row moves off the S1
  // shell — the "retire the shell for this kind" half of the slice, expressed
  // where the gate can see it. `VerificationSummaryCard` is now the sole module
  // that may define this card, and a second implementation anywhere in the tree
  // is an R1 violation exactly as it is for the review gate.
  verification_summary: {
    component: "VerificationSummaryCard",
    owner: "packages/agents/src/verification-summary-card.tsx",
  },
  // The schedule-proposal kind is still drawn by the S1 shell `LifecycleCard`,
  // and that is the truth rather than a placeholder: §VI has not been given its
  // own drawn component yet (S5 shipped the proposal's producer, token and
  // install order, not a second renderer; S9d owns the drawing). One component
  // serving one remaining kind still satisfies "exactly one implementation per
  // interaction"; two components serving one kind would not.
  trigger_schedule_proposal: {
    component: "LifecycleCard",
    owner: "packages/chat/src/renderable-views/lifecycle-card.tsx",
  },
});

/**
 * The definition pattern for one card component: the component's own name, or
 * any `Prefixed…` look-alike of it. The optional prefix group is what makes a
 * second, differently-named implementation of the SAME card visible — a
 * `CompactReviewGateCard` is exactly the drift this rule exists to catch — while
 * the bare name is matched at the owner so the allowlist can never go vacuous.
 */
export function cardDefinitionPattern(component) {
  return new RegExp(
    String.raw`\b(?:function|const|class)\s+((?:[A-Z][A-Za-z0-9]*)?${component})\b`,
    "g",
  );
}

/**
 * R2 — the retired parallel renderers, as exact JSX / identifier / anchor forms.
 *
 * Each entry names WHAT was deleted and WHY it may not return, because the ban
 * is the whole content of the criterion. `allow` lists the modules where the
 * token is legitimate: the component's own definition module, and (for the
 * decision bar / blocked state) the ONE card that composes them.
 */
/**
 * The STRUCTURAL ANCHORS of §VII's core — the data attributes that identify the
 * verification drawing itself, independently of what any component is called.
 *
 * Exported because two things read them and they must not drift: the R2 rule
 * below (which bans them outside the owner module) and the slice's own
 * one-renderer test (which asserts the owner really emits every one of them, so
 * the ban can never go vacuous by the anchors quietly disappearing).
 *
 * They are the sections §VII names: the Core-analysis chrome, the outcome pill,
 * the REVISION PINS, the authorized-scope region, the field-by-field
 * before/after, and the advisory comments.
 *
 * `revisions` is in this list and must stay: the two revision pins are §VII
 * CORE, not a page adjunct. The page's own ruling names exactly two adjuncts —
 * the pinned VISUAL pair (#2044 L-D) and the back-to-gate route affordance —
 * and the revision pins are neither. The name collision between "the revision
 * pins" and "the pinned visual pair" is precisely how this anchor was left out
 * of the first cut of this list (restored in cinatra#2861): without it, a
 * production module could emit `data-verification-revisions` and redraw that
 * portion of the reading without tripping R2 or the emitter test — which is
 * exactly the parallel renderer this gate exists to forbid.
 */
export const VERIFICATION_CORE_ANCHORS = Object.freeze([
  "chrome",
  "outcome",
  "revisions",
  "authorized-scope",
  "field-diff",
  "advisory",
]);

export const RETIRED_PARALLELS = Object.freeze([
  {
    id: "review-redirect-card",
    // The display-only "Continue to review" card that navigated the reader away
    // instead of letting them decide in the conversation. Deleted by S2 (#2566).
    re: /\bArtifactReviewRedirectCard\b/g,
    allow: [],
    fix: "The review gate renders `ReviewGateCard` on every host; there is no redirect card.",
  },
  {
    id: "direct-chip-row-mount",
    // The pre-S4 mount: a host rendering the chip row itself (and polling for
    // its state) rather than mounting `RecommendationHoldCard`, which owns
    // WHETHER the row appears, WHICH state it is in, and WHEN it re-reads.
    re: /<\s*RunRecommendationChipRow\b/g,
    allow: [
      // The card that composes the shipped row — the one legitimate mount, and
      // now the ONLY one.
      //
      // HISTORY, kept because an empty-looking allowlist hides what it cost.
      // S7 first shipped this rule with `packages/agents/src/instance-screens.tsx`
      // allowlisted BY NAME: the run-DETAIL screen rendered the recommendation
      // interaction ITSELF — its own park read, its own candidate prefetch and a
      // direct `<RunRecommendationChipRow holdRef={…}>` — bypassing
      // `RecommendationHoldCard`, the host declaration and the card's
      // authoritative-refetch contract. That was defect D-1, and it was not
      // cosmetic: `AgenticRunPanel` (which mounts the card correctly under
      // `host="run_card"`) renders only for `run.status !== "pending_input"`,
      // and a HELD run IS `pending_input`, so the HELD state on the run-detail
      // page was drawn ONLY by the parallel path. cinatra#2710 (`7123d2bf1`)
      // deleted that path: the screen now mounts `RecommendationHoldCard`
      // inside its own `<LifecycleCardSurfaceProvider host="run_card">`,
      // branch-selected by `runDetailPanelKind` / `screenHostsRecommendationCard`
      // so exactly one renderer draws on every branch. The allowlist entry was
      // deleted with it, which is what makes this gate's pass mean the criterion.
      "packages/agents/src/run-recommendation-chip-row.tsx",
    ],
    fix: "Mount <RecommendationHoldCard> under a declared host; the card composes the row.",
  },
  {
    id: "page-direct-verification-composition",
    // The review page's `VerificationView` DRAWING §VII itself. Before S9e
    // (cinatra#2789) that component composed the whole reading — the
    // Core-analysis chrome, the outcome pill, the revision pins, the
    // field-by-field before/after and the advisory comments — while the same
    // reading in a chat transcript drew the S1 shell. Two drawings of one
    // reading is exactly the drift this gate exists to catch, so the core moved
    // into `VerificationSummaryCard` and `VerificationView` became a composition
    // of that card plus its two page-only adjuncts (the pinned visual pair, the
    // navigation back to the gate).
    //
    // BANNED BY THE §VII ANCHORS, NOT BY A COMPONENT NAME, and deliberately so.
    // `VerificationView` still exists and must — it is the legitimate adjunct
    // composition — so banning its name would ban the right answer. What may
    // not come back is the DRAWING, and the drawing is identified by the
    // structural anchors §VII's core carries: the Core-analysis chrome, the
    // outcome pill, the REVISION PINS, the authorized-scope region, the
    // before/after table and the advisory-comment list — every section the
    // history above says the page used to draw, because the ban and that
    // history have to name the same drawing or the ban has a hole in it.
    // Emitting any of those outside the owner module is a second §VII renderer
    // whatever it is called — which also catches the look-alike that R1's name
    // patterns structurally cannot see.
    re: new RegExp(
      String.raw`data-verification-(?:${VERIFICATION_CORE_ANCHORS.join("|")})\b`,
      "g",
    ),
    allow: ["packages/agents/src/verification-summary-card.tsx"],
    fix: "`VerificationView` mounts <VerificationSummaryCard> and keeps only its page-only adjuncts; the card owns §VII's core.",
  },
  {
    id: "page-direct-decision-composition",
    // The review PAGE composing the DECISION FLOOR itself. S2 moved the bar into
    // the card so all four hosts draw one floor, bound to one decision module.
    //
    // SCOPED TO THE BAR, DELIBERATELY. `ReviewGateBlocked` is NOT banned here
    // even though S2 moved it too: the page uses it for its own ROUTE-LEVEL
    // absence ("this route resolves to no gate at all"), which happens before
    // and outside any gate region, and it uses the SHIPPED component rather
    // than a look-alike — which is the property the criterion actually protects.
    // Banning it would force the page to grow a second absence panel, i.e. the
    // exact duplication this gate exists to prevent.
    re: /<\s*ReviewDecisionBar\b/g,
    allow: [
      "packages/agents/src/review-gate-card.tsx",
      "packages/agents/src/review-decision-bar.tsx",
    ],
    fix: "The page mounts <ReviewGateCard> in its gate region; the card owns the floor.",
  },
]);

/** R3 — the JSX mounts that are lifecycle CARD mounts. */
const CARD_MOUNT_RE =
  /<\s*(ReviewGateCard|RecommendationHoldCard|LifecycleCard|VerificationSummaryCard)\b/g;
const HOST_PROVIDER_RE = /<\s*LifecycleCardSurfaceProvider\b/;

/**
 * Files that mount a lifecycle card whose host provider is supplied by a PARENT
 * component in another file. Allowlisted BY NAME with that parent, because a
 * per-file scan structurally cannot see it — and because an unexplained
 * exception is how a fail-closed gate rots.
 */
export const HOST_PROVIDED_BY_PARENT = Object.freeze({
  // The chat/widget conversation column declares the host once, at the column
  // root, and every turn's renderable-view dispatch happens inside it.
  "packages/chat/src/renderable-views/registry.tsx":
    "packages/chat/src/chat-messages-view.tsx (<LifecycleCardSurfaceProvider {...lifecycleSurface}>)",
  "packages/chat/src/renderable-views/lifecycle-card.tsx":
    "packages/chat/src/chat-messages-view.tsx (<LifecycleCardSurfaceProvider {...lifecycleSurface}>)",
});

/** R4 — the one registry, and the one line per kind inside it.
 *
 * SCOPED TO THE DATA-PART KINDS. `recommendation_hold` rides a typed INTERRUPT,
 * not a `DATA_PART` (`LIFECYCLE_CARD_CARRIAGE`), so it is correctly absent from
 * the renderable-view registry — its single mount is the `RecommendationHoldCard`
 * on each declared host, which R1 and R3 cover. Requiring a registry row for it
 * would demand the second dispatch path this gate exists to forbid. */
export const REGISTRY_MODULE = "packages/chat/src/renderable-views/registry.tsx";
export const REGISTRY_KINDS = Object.freeze([
  "artifact_review_gate",
  "verification_summary",
  "trigger_schedule_proposal",
]);

/** Paths exempt from every rule: tests, fixtures, evidence, docs, this script. */
export function isExempt(rel) {
  return (
    rel.startsWith("evidence/") ||
    rel.startsWith("docs/") ||
    rel.startsWith("scripts/") ||
    rel.startsWith("tests/") ||
    rel.endsWith(".d.ts") ||
    rel.includes("/__tests__/") ||
    rel.includes("/__fixtures__/") ||
    /\.test\.tsx?$/.test(rel)
  );
}

/** Tracked application sources this gate scans. */
export function collectFiles(repoRoot = DEFAULT_REPO_ROOT) {
  const out = execSync(
    'git ls-files "src/**/*.ts" "src/**/*.tsx" "packages/**/*.ts" "packages/**/*.tsx"',
    { encoding: "utf8", cwd: repoRoot },
  );
  return out.split("\n").filter(Boolean).filter((rel) => !isExempt(rel));
}

function lineOf(code, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (code[i] === "\n") line += 1;
  return line;
}

/**
 * Scan ONE module. Pure: source text in, findings out — so the CLI and the
 * pinned tests share exactly one matcher and can never drift.
 *
 * @param {string} rel  repo-relative path (decides which allowlists apply)
 * @param {string} source raw file contents
 */
export function scanModule(rel, source) {
  const code = stripComments(source);
  const findings = [];

  // R1 — a card DEFINITION outside its owner module.
  for (const [kind, spec] of Object.entries(CARD_OWNERS)) {
    if (rel === spec.owner) continue;
    const re = cardDefinitionPattern(spec.component);
    let m;
    while ((m = re.exec(code)) !== null) {
      findings.push({
        rule: "R1",
        detail: `a second '${kind}' card implementation (${m[1]}) — the sole owner is ${spec.owner}`,
        line: lineOf(code, m.index),
      });
    }
  }

  // R2 — a retired parallel renderer, back by name.
  for (const parallel of RETIRED_PARALLELS) {
    if (parallel.allow.includes(rel)) continue;
    const re = new RegExp(parallel.re.source, parallel.re.flags);
    let m;
    while ((m = re.exec(code)) !== null) {
      findings.push({
        rule: "R2",
        detail: `retired parallel renderer '${parallel.id}' is back — ${parallel.fix}`,
        line: lineOf(code, m.index),
      });
    }
  }

  // R3 — a card mount with no host declaration in this file.
  const mounts = [...code.matchAll(CARD_MOUNT_RE)];
  if (mounts.length > 0 && !HOST_PROVIDER_RE.test(code)) {
    const parent = HOST_PROVIDED_BY_PARENT[rel];
    if (!parent) {
      findings.push({
        rule: "R3",
        detail:
          `mounts ${[...new Set(mounts.map((m) => m[1]))].join(", ")} with no ` +
          "<LifecycleCardSurfaceProvider> in this file — a card must be host-declared " +
          "(add the provider, or record the providing parent in HOST_PROVIDED_BY_PARENT)",
        line: lineOf(code, mounts[0].index),
      });
    }
  }

  return findings.sort((a, b) => a.line - b.line);
}

/**
 * R4 — the registry maps each lifecycle kind exactly once. Separate from
 * scanModule because it is a property of ONE named module, not of every file.
 */
export function scanRegistry(source) {
  const code = stripComments(source);
  const findings = [];
  for (const kind of REGISTRY_KINDS) {
    const hits = [...code.matchAll(new RegExp(String.raw`^\s*${kind}\s*:`, "gm"))];
    if (hits.length !== 1) {
      findings.push({
        rule: "R4",
        detail: `the renderable-view registry maps '${kind}' ${hits.length} time(s) — expected exactly 1`,
        line: hits.length > 0 ? lineOf(code, hits[0].index) : 1,
      });
    }
  }
  return findings;
}

export function collectViolations({
  files,
  repoRoot = DEFAULT_REPO_ROOT,
  readFileImpl = (p) => readFileSync(p, "utf8"),
} = {}) {
  const list = files ?? collectFiles(repoRoot);
  const violations = [];
  for (const rel of list) {
    for (const f of scanModule(rel, readFileImpl(resolve(repoRoot, rel)))) {
      violations.push({ file: rel, ...f });
    }
  }
  if (!files) {
    for (const f of scanRegistry(readFileImpl(resolve(repoRoot, REGISTRY_MODULE)))) {
      violations.push({ file: REGISTRY_MODULE, ...f });
    }
  }
  return violations;
}

function main() {
  const violations = collectViolations();
  if (violations.length === 0) {
    console.log(
      `[${LABEL}] clean — one card implementation per interaction, every mount host-declared.`,
    );
    return 0;
  }
  console.error(`[${LABEL}] ${violations.length} violation(s):\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.rule}]  ${v.detail}`);
  }
  console.error(
    "\nThe epic's structural rule is ONE card per interaction, rendered on every host —" +
      "\nonly the frame adapts. A second renderer is not a smaller feature; it is a second" +
      "\nplace where 'approved' can come to mean something different.",
  );
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
  try {
    process.exit(main());
  } catch (e) {
    console.error(`[${LABEL}] fatal:`, e);
    process.exit(2);
  }
}
