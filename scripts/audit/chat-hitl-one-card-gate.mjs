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
 *   R2 THE RETIRED PARALLELS ARE GONE. The three renderers the epic ordered
 *      deleted may not come back, by name:
 *        · the review REDIRECT card (`ArtifactReviewRedirectCard`) — the
 *          display-only "Continue to review" link that sent a reader away;
 *        · a DIRECT `<RunRecommendationChipRow` mount on a lifecycle HOST — the
 *          pre-S4 poll-driven panel mount;
 *        · the review page's DIRECT decision composition — a `<ReviewDecisionBar`
 *          mounted by the page instead of by the card. (Scoped to the BAR: the
 *          page's own ROUTE-LEVEL `ReviewGateBlocked` panel is legitimate and
 *          uses the shipped component — see the entry's own note.)
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
 * WHAT THE COMPLETENESS RULES ADD (the S9 round). R1–R4 answer "is there more
 * than one renderer?". They never answered "is there ONE?" — and that is how a
 * kind with NO drawing passed: two kinds pointed at the S1 shell, and one
 * component serving two kinds reads as "one implementation per interaction" to a
 * duplicate-detector. The rules below close that:
 *
 *   R5 ONE NAMED OWNER PER KIND. Every member of `LIFECYCLE_CARD_KINDS` —
 *      including the typed-INTERRUPT recommendation kind — has its own row in
 *      `LIFECYCLE_CARD_CONTRACTS`, and a DRAWN row names an owner module and a
 *      component that no other kind shares. A kind with no drawing is recorded
 *      as a PLACEHOLDER with a gap sentence: it may not claim an owner, and its
 *      ratified component name may not exist anywhere in the tree (a card that
 *      gets drawn without flipping its row fails here, so the placeholder claim
 *      cannot become a lie in either direction).
 *
 *   R6 THE OWNER CONSUMES ITS AUTHORIZED BODY. The owner reads its kind's
 *      validated body seam and every field the contract lists, and every body
 *      parameter it declares is read in the component. An owner that takes a
 *      body and ignores it is drawing something other than what the server
 *      authorized.
 *
 *   R7 THE OWNER EMITS ITS RATIFIED ANCHOR SET. Every anchor in the contract is
 *      emitted as a literal `data-conformance-id` by the owner or by a module
 *      the owner composes, from code that is REACHABLE — an anchor inside a
 *      statically dead branch does not count, and a component whose only return
 *      is `null` emits nothing at all.
 *
 *   R8 ONE PRODUCTION MOUNT SET PER HOST. Each DRAWN kind declares, per host,
 *      the production modules that mount it. The declared set must equal the
 *      set found in the tree: an undeclared mount is a duplicate host mount, a
 *      declared module that no longer mounts is a missing host adapter, and a
 *      host with more than one module must say WHY on each entry.
 *
 *   R9 THE RETIRED PARALLEL CORE RENDERERS. `VerificationView` — the route-bound
 *      page component that draws the §VII reading outside the card — is banned
 *      by name. Its own module is recorded as a PENDING RETIREMENT, and that
 *      record is valid ONLY while the verification kind is a placeholder: the
 *      slice that draws the card must delete the parallel renderer with it.
 *
 * TWO MODES, the same shape as the sibling acceptance gate:
 *   default    — the HONESTY check. Every DRAWN kind is fully enforced and every
 *                PLACEHOLDER kind is honestly recorded. Exit 0 means "no false
 *                claim", never "the program is finished".
 *   --complete — the DONE check. Additionally requires every kind to be DRAWN
 *                and every host to be mounted. It names the kinds that are still
 *                placeholders, which is what the epic's finished tree must clear.
 *
 * WHERE THE ANCHOR SETS COME FROM. Each contract's `anchors` are read off the
 * ratified drawing — `specs/app-lifecycle-cards.html` at design commit
 * 92c1be7c6f864dec6382a9ef01e7b2e1c38aa871, the same commit the acceptance
 * manifest pins — section by section: §II for the review card, §V for the
 * recommendation row, §VI for the schedule proposal, §VII for the verification
 * reading. They are written down HERE, ahead of the drawing, so a slice cannot
 * decide after the fact that whatever it drew was the requirement.
 *
 * THE HONEST LIMIT, stated because a gate that overclaims is worse than none.
 * This scanner reads source text. Source text can be arranged to satisfy a
 * lexical rule without drawing anything, which is exactly the failure this round
 * exists to end — so the anchor rule is deliberately NOT the proof. Each DRAWN
 * kind also names a RENDERED owner test ({file, testName}), verified present
 * here and EXECUTED by vitest, in which the anchors appear in real DOM produced
 * from validated body fields. This gate proves the declaration; that suite
 * proves the pixels. Neither alone is the criterion.
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
 * The closed set of interaction kinds, mirrored from
 * `packages/agent-ui-protocol/src/renderable-views/lifecycle-cards.ts`. Mirrored
 * rather than imported because a `.mjs` gate cannot load the project's
 * TypeScript; the pinned tests assert the two lists are identical, so a fifth
 * kind added there and forgotten here fails immediately.
 */
export const LIFECYCLE_CARD_KINDS = Object.freeze([
  "artifact_review_gate",
  "verification_summary",
  "recommendation_hold",
  "trigger_schedule_proposal",
]);

/** How each kind reaches a surface. Mirrors `LIFECYCLE_CARD_CARRIAGE`. */
export const LIFECYCLE_CARD_CARRIAGE = Object.freeze({
  artifact_review_gate: "data_part",
  verification_summary: "data_part",
  recommendation_hold: "interrupt",
  trigger_schedule_proposal: "data_part",
});

/** The four hosts. Mirrors `LIFECYCLE_CARD_HOSTS`. */
export const LIFECYCLE_CARD_HOSTS = Object.freeze([
  "chat_thread",
  "site_widget",
  "run_card",
  "page_gate_region",
]);

/** The S1 shell — the "not yet drawn" renderer, and its one module. */
export const S1_SHELL = Object.freeze({
  component: "LifecycleCard",
  owner: "packages/chat/src/renderable-views/lifecycle-card.tsx",
});

/**
 * THE CONTRACT, one row per interaction kind.
 *
 * A row is either DRAWN — it names the sole owner module, the component, the
 * modules that owner composes, the authorized body it consumes, the anchors it
 * must emit, its host mounts and the rendered test that photographs them — or
 * PLACEHOLDER, which names the SAME requirements as the obligation the drawing
 * slice inherits, plus a `gap` sentence saying what is absent today.
 *
 * A PLACEHOLDER row carries `owner: null` on purpose. Pointing it at the S1
 * shell is what let the previous round read as satisfied: one component serving
 * two kinds looks like "one implementation per interaction" to a duplicate
 * detector, and the two kinds with no drawing at all were counted as met.
 */
export const LIFECYCLE_CARD_CONTRACTS = Object.freeze({
  artifact_review_gate: {
    status: "DRAWN",
    design: "§II (the review card in the thread) with §VIII chips",
    component: "ReviewGateCard",
    owner: "packages/agents/src/review-gate-card.tsx",
    // The floor lives in its own module and is composed by the card. Anchors it
    // emits count as the card's, because the card is what mounts it.
    composes: ["packages/agents/src/review-decision-bar.tsx"],
    body: {
      validator: "useLifecycleCardState",
      params: ["view"],
      fields: ["state", "canDecide", "canComment", "suggestions"],
    },
    anchors: [
      "review-gate-card",
      "review-target-island",
      "review-decision-bar",
      "suggestion-chips",
    ],
    hosts: {
      chat_thread: [
        {
          module: "packages/chat/src/renderable-views/registry.tsx",
          kind: "registry",
          why: "the transcript dispatch — the chat column declares the host once and every turn resolves inside it",
        },
      ],
      site_widget: [
        {
          module: "packages/chat/src/renderable-views/registry.tsx",
          kind: "registry",
          why: "the SAME registry row serves the widget transcript; a second table would be a parallel registry",
        },
      ],
      run_card: [
        {
          module: "packages/agents/src/agentic-run-panel.tsx",
          kind: "mount",
          why: "the epic's named run_card mount",
        },
        {
          module: "packages/agents/src/orchestrator-stepper-panel.tsx",
          kind: "mount",
          why: "the stepper branch of the same host — the run card is drawn by branch-exclusive panels, and each is named so a further one cannot appear silently",
        },
      ],
      page_gate_region: [
        {
          module:
            "src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/page.tsx",
          kind: "mount",
          why: "the review page mounts the card in its gate region; the page composes no floor of its own",
        },
      ],
    },
    renderedProof: {
      file: "packages/agents/src/__tests__/review-gate-card.test.tsx",
      testName: "draws the SAME card on every first-party host, differing only in the frame",
    },
  },

  recommendation_hold: {
    status: "DRAWN",
    design: "§V (the recommendation card) — the chip row IS the whole card",
    component: "RecommendationHoldCard",
    owner: "packages/agents/src/run-recommendation-chip-row.tsx",
    composes: [],
    body: {
      // A typed INTERRUPT, so its authorized state comes from the hold's own
      // cookie-bound read rather than the data-part resolve seam.
      validator: "useRecommendationHoldState",
      params: ["runId", "wireRef"],
      fields: [
        "state",
        "agentPackageName",
        "promptText",
        "recommendations",
        "holdRef",
        "skillNames",
      ],
    },
    anchors: ["run-chip-row"],
    hosts: {
      chat_thread: null,
      site_widget: null,
      run_card: [
        {
          module: "packages/agents/src/agentic-run-panel.tsx",
          kind: "mount",
          why: "the epic's named run_card mount",
        },
        {
          module: "packages/agents/src/orchestrator-stepper-panel.tsx",
          kind: "mount",
          why: "the stepper branch of the same host",
        },
        {
          module: "packages/agents/src/instance-screens.tsx",
          kind: "mount",
          why: "the run-detail branch: the agentic panel does not render for a run that is pending_input, and a HELD run is exactly that, so this branch draws the held state",
        },
      ],
      page_gate_region: null,
    },
    hostGap:
      "Three of the four hosts are undefined for this kind: the card is reachable only from the run card today. The chat thread, the site widget and the page gate region are named by the parity slice that follows this one.",
    renderedProof: {
      file: "packages/agents/src/__tests__/agentic-run-panel.chat-lifecycle.test.tsx",
      testName: "draws the core recommendation card when skills match",
    },
  },

  trigger_schedule_proposal: {
    status: "PLACEHOLDER",
    design: "§VI (the schedule proposal card)",
    component: "ScheduleProposalCard",
    owner: null,
    composes: [],
    body: {
      validator: "useLifecycleCardState",
      params: ["view"],
      fields: ["state", "proposal", "options", "estimatedDuration"],
    },
    anchors: [
      "schedule-proposal-card",
      "schedule-option-rows",
      "schedule-estimated-duration",
      "schedule-proposal-floor",
      "trigger-configuration-summary",
    ],
    hosts: {
      chat_thread: null,
      site_widget: null,
      run_card: null,
      page_gate_region: null,
    },
    hostGap:
      "No host mounts this kind, because no component draws it. The registry still dispatches the kind to the S1 shell.",
    renderedProof: null,
    gap: "The card is not drawn. The registry dispatches this kind to the S1 shell, which calls itself not-yet-drawn; the server already returns the proposal body and the client parses only the state name; the confirm action has no user interface caller. The anchors and body fields above are the obligation the drawing slice inherits, not a description of anything shipped.",
  },

  verification_summary: {
    status: "PLACEHOLDER",
    design: "§VII (the verification card) — advisory, no floor",
    component: "VerificationSummaryCard",
    owner: null,
    composes: [],
    body: {
      validator: "useLifecycleCardState",
      params: ["view"],
      fields: ["state", "outcome", "revisions", "fields", "comments"],
    },
    anchors: [
      "verification-summary-card",
      "verification-outcome-pill",
      "verification-revision-pins",
      "verification-field-table",
      "verification-advisory-comments",
    ],
    hosts: {
      chat_thread: null,
      site_widget: null,
      run_card: null,
      page_gate_region: null,
    },
    hostGap:
      "No host mounts this kind, because no component draws it. The rich reading exists only as a route-bound page component, which R9 records as a pending retirement.",
    renderedProof: null,
    gap: "The card is not drawn. The registry dispatches this kind to the S1 shell; the resolver answers with an advisory state name and no body; the rich reading of the same facts lives in a route-bound page component that is not a lifecycle card. The anchors and body fields above are the obligation the drawing slice inherits, not a description of anything shipped.",
  },
});

/**
 * The SOLE module that may define each interaction's card component — derived
 * from the contract so the two can never disagree. A PLACEHOLDER kind
 * contributes no owner row; the S1 shell keeps its own row so a second shell
 * definition is still an R1 violation while the shell is still in service.
 */
export const CARD_OWNERS = Object.freeze(
  Object.fromEntries([
    ...Object.entries(LIFECYCLE_CARD_CONTRACTS)
      .filter(([, c]) => c.status === "DRAWN")
      .map(([kind, c]) => [kind, { component: c.component, owner: c.owner }]),
    ["s1_placeholder_shell", { component: S1_SHELL.component, owner: S1_SHELL.owner }],
  ]),
);

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
 * R2 — the three retired parallel renderers, as exact JSX/identifier forms.
 *
 * Each entry names WHAT was deleted and WHY it may not return, because the ban
 * is the whole content of the criterion. `allow` lists the modules where the
 * token is legitimate: the component's own definition module, and (for the
 * decision bar / blocked state) the ONE card that composes them.
 */
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
  {
    id: "verification-page-view",
    // R9 — the route-bound page component that draws the §VII reading OUTSIDE
    // the card. It is a parallel core renderer of the verification kind: the
    // same facts, a second drawing, on one host only. It may not spread, and it
    // may not survive the card.
    re: /(?:<\s*VerificationView\b|\b(?:function|const|class)\s+(?:[A-Z][A-Za-z0-9]*)?VerificationView\s*[({=])/g,
    // Filled from PENDING_RETIREMENT below — the two modules that carry it
    // today, allowed ONLY while the verification kind has no card.
    allow: [
      "src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/verification-view.tsx",
      "src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/page.tsx",
    ],
    fix: "The verification reading is a lifecycle card; the review page reuses that card rather than composing its own view.",
  },
]);

/**
 * R9's one recorded exception, with its expiry written into the record.
 *
 * The parallel renderer exists today because the card does not. The moment the
 * verification kind is DRAWN, these modules must be gone — so the exception is
 * checked against the contract's own status rather than against a date or a
 * reviewer's memory.
 */
export const PENDING_RETIREMENT = Object.freeze({
  id: "verification-page-view",
  kind: "verification_summary",
  modules: Object.freeze([
    "src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/verification-view.tsx",
    "src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/page.tsx",
  ]),
  why: "The route-bound §VII view, kept only while the verification kind has no card of its own. The slice that draws the card deletes this and empties the allowlist in the same change.",
});

/** R3 — the JSX mounts that are lifecycle CARD mounts. */
const CARD_MOUNT_RE = /<\s*(ReviewGateCard|RecommendationHoldCard|LifecycleCard)\b/g;
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

// ---------------------------------------------------------------------------
// The completeness rules — R5 to R9
// ---------------------------------------------------------------------------

/** Skip a string or template literal from `i`; returns the index after it. */
function skipQuoted(code, i) {
  const quote = code[i];
  for (let j = i + 1; j < code.length; j++) {
    if (code[j] === "\\") {
      j += 1;
      continue;
    }
    if (code[j] === quote) return j + 1;
  }
  return code.length;
}

/**
 * The index just past the block that opens at `open` (a `{`, `(` or `[`),
 * skipping quoted spans so a brace inside a string cannot end it early.
 */
export function matchBlock(code, open) {
  const pairs = { "{": "}", "(": ")", "[": "]" };
  const close = pairs[code[open]];
  if (close === undefined) return -1;
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipQuoted(code, i) - 1;
      continue;
    }
    if (ch === code[open]) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Remove the branches that can never run: `if (false) {…}`, `if (0) {…}` and the
 * `false && (…)` / `0 && (…)` short-circuit form.
 *
 * This is what stops an anchor from being satisfied by dead text. It is
 * deliberately narrow — a statically-false literal is the shape that reads as
 * "the anchor is here" while nothing ever renders it. A branch that is false for
 * a runtime reason is NOT dead code and is left alone; the rendered owner test
 * is what proves those paths draw.
 */
export function stripUnreachable(code) {
  let out = code;
  for (const guard of [/\bif\s*\(\s*(?:false|0)\s*\)\s*\{/g, /(?:\bfalse|(?<![\w.])0)\s*&&\s*\(/g]) {
    for (;;) {
      guard.lastIndex = 0;
      const m = guard.exec(out);
      if (m === null) break;
      const open = m.index + m[0].length - 1;
      const end = matchBlock(out, open);
      if (end < 0) break;
      out = out.slice(0, m.index) + out.slice(end);
    }
  }
  return out;
}

/**
 * The body of one top-level component, or `null` when it is not defined here.
 * Handles the `function X(…) {…}` and `const X = (…) => {…}` forms.
 */
export function extractComponentBody(code, component) {
  const decl = new RegExp(
    String.raw`\b(?:export\s+)?(?:function\s+${component}\s*\(|const\s+${component}\s*(?::[^=]+)?=\s*(?:function\s*)?\()`,
  );
  const m = decl.exec(code);
  if (m === null) return null;
  const paramsOpen = code.indexOf("(", m.index + m[0].length - 1);
  const afterParams = matchBlock(code, paramsOpen);
  if (afterParams < 0) return null;
  const bodyOpen = code.indexOf("{", afterParams);
  if (bodyOpen < 0) return null;
  const bodyEnd = matchBlock(code, bodyOpen);
  if (bodyEnd < 0) return null;
  return code.slice(bodyOpen, bodyEnd);
}

/** Is `anchor` emitted as a literal conformance id anywhere in `code`? */
export function emitsAnchor(code, anchor) {
  return new RegExp(String.raw`data-conformance-id=["']${anchor}["']`).test(code);
}

/**
 * R5/R6/R7 for ONE drawn kind. Pure over the sources it is handed, so a fixture
 * drives exactly what CI runs.
 *
 * @param {string} kind
 * @param {object} contract  the row from LIFECYCLE_CARD_CONTRACTS
 * @param {Record<string,string>} sourcesByRel  owner + composed module sources
 */
export function scanOwnerModule(kind, contract, sourcesByRel) {
  const findings = [];
  const push = (rule, detail, file = contract.owner) =>
    findings.push({ rule, file, line: 1, detail });

  const ownerRaw = sourcesByRel[contract.owner];
  if (typeof ownerRaw !== "string") {
    push("R5", `'${kind}': the declared owner module is not readable — a named owner must exist`);
    return findings;
  }
  const owner = stripComments(ownerRaw);

  // R5 — the owner module really defines the component it is named for.
  if (!new RegExp(String.raw`\b(?:export\s+)?(?:function|const|class)\s+${contract.component}\b`).test(owner)) {
    push("R5", `'${kind}': ${contract.owner} does not define ${contract.component}`);
  }

  const body = extractComponentBody(owner, contract.component);
  if (body === null) {
    push("R5", `'${kind}': ${contract.component} has no readable component body in ${contract.owner}`);
  } else {
    const live = stripUnreachable(body);
    // R7 — an owner that never returns DOM draws nothing. The empty stub and the
    // null-returning owner both land here.
    if (!/return\s*[(<]/.test(live)) {
      push(
        "R7",
        `'${kind}': ${contract.component} never returns drawn DOM — an owner that only returns null is a placeholder with a name`,
      );
    }
    // R6 — a body parameter the component never reads is a body it does not use.
    for (const param of contract.body.params) {
      if (!new RegExp(String.raw`\b${param}\b`).test(live)) {
        push(
          "R6",
          `'${kind}': ${contract.component} declares the body parameter '${param}' and never reads it — the card would draw something the server did not authorize`,
        );
      }
    }
  }

  // R6/R7 — the owner plus everything it composes. The floor lives in its own
  // module; anchors and fields it consumes belong to the card that mounts it.
  const parts = [owner];
  for (const rel of contract.composes) {
    const src = sourcesByRel[rel];
    if (typeof src !== "string") {
      push("R5", `'${kind}': the composed module ${rel} is not readable`, rel);
      continue;
    }
    parts.push(stripComments(src));
  }
  const consumed = parts.join("\n");
  const drawn = parts.map(stripUnreachable).join("\n");

  if (!new RegExp(String.raw`\b${contract.body.validator}\b`).test(consumed)) {
    push(
      "R6",
      `'${kind}': the owner never reads its authorized body through ${contract.body.validator} — an unvalidated body is not an authorized one`,
    );
  }
  for (const field of contract.body.fields) {
    if (!new RegExp(String.raw`\.${field}\b`).test(consumed)) {
      push("R6", `'${kind}': the authorized body field '${field}' is never consumed`);
    }
  }
  for (const anchor of contract.anchors) {
    if (emitsAnchor(drawn, anchor)) continue;
    const dead = parts.some((p) => emitsAnchor(p, anchor));
    push(
      "R7",
      dead
        ? `'${kind}': the anchor '${anchor}' is emitted only from a branch that can never run`
        : `'${kind}': the ratified anchor '${anchor}' is never emitted`,
    );
  }
  return findings;
}

/**
 * R8 for ONE drawn kind: the declared mount set equals the mounts in the tree.
 *
 * @param {string} kind
 * @param {object} contract
 * @param {string[]} mountedIn  production modules where the component is mounted
 * @param {string} registrySource  the renderable-view registry's source
 */
export function scanHostMounts(kind, contract, mountedIn, registrySource) {
  const findings = [];
  const push = (detail, file = contract.owner) =>
    findings.push({ rule: "R8", file, line: 1, detail });
  const declaredMounts = new Set();
  const registryModules = new Set();

  for (const host of LIFECYCLE_CARD_HOSTS) {
    const entries = contract.hosts[host];
    if (entries === null || entries === undefined) continue;
    if (entries.length > 1) {
      for (const e of entries) {
        if (!e.why || e.why.length < 20) {
          push(
            `'${kind}' declares ${entries.length} modules on host '${host}' and ${e.module} does not say why — more than one drawing per host needs a reason on every entry`,
            e.module,
          );
        }
      }
    }
    for (const e of entries) {
      if (e.kind === "registry") registryModules.add(e.module);
      else declaredMounts.add(e.module);
    }
  }

  const found = new Set(mountedIn);
  for (const rel of declaredMounts) {
    if (!found.has(rel)) {
      push(`'${kind}': ${rel} is declared as a host mount and does not mount ${contract.component} — a missing host adapter`, rel);
    }
  }
  for (const rel of found) {
    if (declaredMounts.has(rel) || registryModules.has(rel)) continue;
    push(`'${kind}': ${rel} mounts ${contract.component} and is not a declared host mount — a second production mount is a duplicate host mount`, rel);
  }

  // A registry-served host is served by the registry ROW, not by a JSX mount.
  if (registryModules.size > 0 && typeof registrySource === "string") {
    const code = stripComments(registrySource);
    const row = new RegExp(String.raw`^\s*${kind}\s*:\s*${contract.component}\b`, "m");
    if (!row.test(code)) {
      push(
        `'${kind}': the renderable-view registry does not dispatch this kind to ${contract.component} — the transcript hosts would draw something else`,
        REGISTRY_MODULE,
      );
    }
  }
  return findings;
}

/**
 * R5 at the TABLE level, plus R9's expiry. Shape only — no file reads — so the
 * fixtures can hand it a synthetic table.
 */
export function auditContracts(contracts = LIFECYCLE_CARD_CONTRACTS) {
  const findings = [];
  const push = (rule, detail) => findings.push({ rule, file: "scripts/audit/chat-hitl-one-card-gate.mjs", line: 1, detail });

  const kinds = Object.keys(contracts);
  for (const kind of LIFECYCLE_CARD_KINDS) {
    if (!kinds.includes(kind)) push("R5", `'${kind}' has no contract row — every lifecycle card kind needs one named owner`);
  }
  for (const kind of kinds) {
    if (!LIFECYCLE_CARD_KINDS.includes(kind)) push("R5", `'${kind}' is not a lifecycle card kind`);
  }

  const byComponent = new Map();
  const byOwner = new Map();
  for (const [kind, c] of Object.entries(contracts)) {
    if (c.status !== "DRAWN" && c.status !== "PLACEHOLDER") {
      push("R5", `'${kind}': status "${c.status}" is neither DRAWN nor PLACEHOLDER`);
      continue;
    }
    if (LIFECYCLE_CARD_CARRIAGE[kind] !== undefined && c.carriage !== undefined && c.carriage !== LIFECYCLE_CARD_CARRIAGE[kind]) {
      push("R5", `'${kind}': the contract carries it as ${c.carriage}; the protocol says ${LIFECYCLE_CARD_CARRIAGE[kind]}`);
    }
    if (!c.component) push("R5", `'${kind}': no component name`);
    if (!Array.isArray(c.anchors) || c.anchors.length === 0) {
      push("R7", `'${kind}': no ratified anchor set — the requirement must be written down before the drawing`);
    }
    if (c.component) {
      const seen = byComponent.get(c.component);
      if (seen !== undefined) push("R5", `'${kind}' and '${seen}' both name ${c.component} — one component serving two kinds is how a placeholder passes for a card`);
      else byComponent.set(c.component, kind);
    }
    if (c.status === "DRAWN") {
      if (!c.owner) {
        push("R5", `'${kind}': DRAWN with no owner module`);
      } else {
        const seen = byOwner.get(c.owner);
        if (seen !== undefined) push("R5", `'${kind}' and '${seen}' share the owner module ${c.owner}`);
        else byOwner.set(c.owner, kind);
      }
      if (!c.renderedProof || !c.renderedProof.file || !c.renderedProof.testName) {
        push("R7", `'${kind}': DRAWN with no rendered owner test — the anchors would be a source-text claim`);
      }
      if (c.owner === S1_SHELL.owner || c.component === S1_SHELL.component) {
        push("R5", `'${kind}': DRAWN but pointing at the S1 shell, which draws no card`);
      }
    } else {
      if (c.owner !== null) push("R5", `'${kind}': PLACEHOLDER rows may not claim an owner — ${c.owner}`);
      if (!c.gap || c.gap.length < 40) push("R5", `'${kind}': PLACEHOLDER rows must say what is absent, in \`gap\` (a real sentence)`);
    }
    for (const host of LIFECYCLE_CARD_HOSTS) {
      if (!(host in (c.hosts ?? {}))) push("R8", `'${kind}': host '${host}' is not declared`);
    }
    const unmounted = LIFECYCLE_CARD_HOSTS.filter((h) => (c.hosts ?? {})[h] === null);
    if (unmounted.length > 0 && (!c.hostGap || c.hostGap.length < 40)) {
      push("R8", `'${kind}': ${unmounted.join(", ")} carry no mount and the row does not say why, in \`hostGap\``);
    }
  }

  // R9 — the recorded parallel renderer outlives nothing.
  const retiringKind = contracts[PENDING_RETIREMENT.kind];
  if (retiringKind !== undefined && retiringKind.status === "DRAWN") {
    push(
      "R9",
      `'${PENDING_RETIREMENT.kind}' is DRAWN, so the pending-retirement record for ${PENDING_RETIREMENT.id} must be gone — ${PENDING_RETIREMENT.modules.join(", ")}`,
    );
  }
  return findings;
}

/** The kinds with no drawing today, named. */
export function placeholderKinds(contracts = LIFECYCLE_CARD_CONTRACTS) {
  return Object.entries(contracts)
    .filter(([, c]) => c.status === "PLACEHOLDER")
    .map(([kind, c]) => ({ kind, design: c.design, gap: c.gap }));
}

/**
 * R5–R9 over the real tree.
 *
 * `complete` turns the honesty check into the DONE check: a placeholder kind and
 * an unmounted host stop being honest records and become the violations they
 * describe.
 */
export function collectContractViolations({
  contracts = LIFECYCLE_CARD_CONTRACTS,
  files,
  complete = false,
  repoRoot = DEFAULT_REPO_ROOT,
  readFileImpl = (p) => readFileSync(p, "utf8"),
} = {}) {
  const violations = [...auditContracts(contracts)];
  const read = (rel) => {
    try {
      return readFileImpl(resolve(repoRoot, rel));
    } catch {
      return null;
    }
  };
  const list = files ?? collectFiles(repoRoot);
  const registrySource = read(REGISTRY_MODULE);

  // Every production mount of every contracted component, in one pass.
  const mountsByComponent = new Map();
  const definitionsByComponent = new Map();
  for (const rel of list) {
    const code = stripComments(read(rel) ?? "");
    for (const [, c] of Object.entries(contracts)) {
      if (!c.component) continue;
      if (new RegExp(String.raw`<\s*${c.component}\b`).test(code)) {
        const seen = mountsByComponent.get(c.component) ?? [];
        seen.push(rel);
        mountsByComponent.set(c.component, seen);
      }
      if (cardDefinitionPattern(c.component).test(code)) {
        const seen = definitionsByComponent.get(c.component) ?? [];
        seen.push(rel);
        definitionsByComponent.set(c.component, seen);
      }
    }
  }

  for (const [kind, c] of Object.entries(contracts)) {
    if (c.status === "DRAWN") {
      const sources = {};
      for (const rel of [c.owner, ...c.composes]) {
        const src = read(rel);
        if (src !== null) sources[rel] = src;
      }
      violations.push(...scanOwnerModule(kind, c, sources));
      violations.push(
        ...scanHostMounts(kind, c, mountsByComponent.get(c.component) ?? [], registrySource),
      );
      if (c.renderedProof) {
        const proof = read(c.renderedProof.file);
        if (proof === null) {
          violations.push({ rule: "R7", file: c.renderedProof.file, line: 1, detail: `'${kind}': the rendered owner test is gone` });
        } else {
          if (!proof.includes(c.renderedProof.testName)) {
            violations.push({ rule: "R7", file: c.renderedProof.file, line: 1, detail: `'${kind}': the rendered owner test "${c.renderedProof.testName}" is not in this file` });
          }
          for (const anchor of c.anchors) {
            if (!proof.includes(anchor)) {
              violations.push({ rule: "R7", file: c.renderedProof.file, line: 1, detail: `'${kind}': the rendered owner test never reads the anchor '${anchor}' back out of the DOM` });
            }
          }
        }
      }
      continue;
    }

    // PLACEHOLDER — the claim must be true in BOTH directions.
    const defined = definitionsByComponent.get(c.component) ?? [];
    if (defined.length > 0) {
      violations.push({
        rule: "R5",
        file: defined[0],
        line: 1,
        detail: `'${kind}' is recorded as a placeholder and ${c.component} is defined in ${defined.join(", ")} — flip the row, or delete the component`,
      });
    }
    if (complete) {
      violations.push({
        rule: "R5",
        file: "scripts/audit/chat-hitl-one-card-gate.mjs",
        line: 1,
        detail: `'${kind}' has no card of its own (${c.design}) — ${c.gap}`,
      });
    }
  }

  if (complete) {
    for (const [kind, c] of Object.entries(contracts)) {
      if (c.status !== "DRAWN") continue;
      for (const host of LIFECYCLE_CARD_HOSTS) {
        if ((c.hosts ?? {})[host] !== null) continue;
        violations.push({
          rule: "R8",
          file: c.owner ?? "scripts/audit/chat-hitl-one-card-gate.mjs",
          line: 1,
          detail: `'${kind}' has no production mount on host '${host}' — ${c.hostGap ?? "no reason recorded"}`,
        });
      }
    }
  }
  return violations;
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

function main(argv = []) {
  const complete = argv.includes("--complete");
  const violations = [
    ...collectViolations(),
    ...collectContractViolations({ complete }),
  ];
  const placeholders = placeholderKinds();

  if (violations.length === 0) {
    if (complete) {
      console.log(`[${LABEL}] --complete: every lifecycle card kind is drawn, consumed and mounted.`);
      return 0;
    }
    console.log(
      `[${LABEL}] no false claim — ${Object.keys(LIFECYCLE_CARD_CONTRACTS).length - placeholders.length}/` +
        `${Object.keys(LIFECYCLE_CARD_CONTRACTS).length} kinds drawn by a named owner, ` +
        `every mount host-declared, every placeholder recorded.`,
    );
    if (placeholders.length > 0) {
      console.log(
        `\nSTILL A PLACEHOLDER (run with --complete for the done-check): ` +
          placeholders.map((p) => `${p.kind} ${p.design}`).join("; "),
      );
    }
    return 0;
  }

  console.error(
    `[${LABEL}]${complete ? " --complete:" : ""} ${violations.length} violation(s):\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.rule}]  ${v.detail}`);
  }
  console.error(
    "\nThe epic's structural rule is ONE card per interaction, rendered on every host —" +
      "\nonly the frame adapts. A second renderer is not a smaller feature; it is a second" +
      "\nplace where 'approved' can come to mean something different — and a kind with NO" +
      "\nrenderer is not one implementation either, however few duplicates it has.",
  );
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(`[${LABEL}] fatal:`, e);
    process.exit(2);
  }
}
