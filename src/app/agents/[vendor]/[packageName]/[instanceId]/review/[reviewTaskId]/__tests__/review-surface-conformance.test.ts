/**
 * Source-text conformance for the generic artifact-review surface — the host
 * decision chrome (cinatra#1795, epic #1620 S12 item 4), pinned to the RATIFIED
 * design spec `specs/app-artifact-review.html`
 * @ design@458fb7ffce6cf4ab6a2c60d3ff47198135d8ea2f (owner-approved). Every conformance id the
 * spec annotates is mapped BIDIRECTIONALLY: spec→render (every spec anchor is
 * rendered by the route) and render→spec (every anchor the route renders is in
 * the spec's closed set — no invented affordance).
 *
 * The repo runs vitest in a node environment without @testing-library/react, so
 * the surface is pinned via source assertions (the established repo pattern —
 * see components/artifacts/__tests__/surface-conformance.test.ts). The LIVE
 * bidirectional Playwright walk on the real running surface is the proof-at-close
 * on the PR (design-surface doctrine).
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// cinatra#3080 acceptance item 8 — THE CONFORMANCE PIN MOVES WITH THE FLOOR.
// The ratified drawings this surface follows are the review and cards
// specifications at the merge that redrew the floor (Comment · Regenerate ·
// Continue). The pin is the ONE place this suite names a revision, so moving it
// is what makes "the app follows that drawing" a checkable statement rather than
// a claim in a comment.
const SPEC_COMMIT = "6abd0c580473"; // specs/app-artifact-review.html (ratified)

// The chrome now lives under the agent-run route
// `src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]`
// (owner ruling 2026-07-25 (3): the review is part of an agent run). __dirname is
// that route's `__tests__`; ROUTE is its parent; the shared surface model was
// relocated to `src/lib/artifacts` (SRC_ROOT is seven levels above ROUTE).
const ROUTE = path.resolve(__dirname, "..");
const SRC_ROOT = path.resolve(ROUTE, "..", "..", "..", "..", "..", "..", "..");
const read = (abs: string) => readFileSync(abs, "utf8");
const routeFile = (rel: string) => read(path.join(ROUTE, rel));

const MODEL = read(path.join(SRC_ROOT, "lib", "artifacts", "review-surface-model.ts"));
const PAGE = routeFile("page.tsx");
const TARGET_PANEL = routeFile("review-target-panel.tsx");
const ACTIONS = routeFile("actions.ts");

// ── Run-embedded render sites (design@5e5c53aff §I–III) ──────────────────────
// The run-embedded anchors live OUTSIDE the review-route chrome: the run surface +
// left rail + chip-row (packages/agents), the notification builder (src/lib), and
// the review route's prompt window. REPO_ROOT is one above SRC_ROOT.
const REPO_ROOT = path.resolve(SRC_ROOT, "..");
const readRepo = (rel: string) => read(path.join(REPO_ROOT, rel));
const RUN_SURFACE = readRepo("packages/agents/src/instance-screens.tsx");
const RUN_STEP_RAIL = readRepo("packages/agents/src/run-step-rail-panel.tsx");
const RUN_CHIP_ROW = readRepo("packages/agents/src/run-recommendation-chip-row.tsx");
const RUN_GATE_NOTIFICATION = readRepo("src/lib/agent-run-wait-notifications.ts");
const REVIEW_PROMPT_WINDOW = routeFile("review-prompt-window.tsx");

// cinatra#2566 (epic #2564 S2) — the decision bar, the gate states, and the
// gate-region COMPOSITION (header + target stack + one floor) moved out of this
// route so that ONE renderer can draw the review on the chat thread and the run
// card too. Nothing about the chrome changed; only where it is read from. The
// route-local files are now re-export shims, so this suite follows the source to
// its new home rather than asserting against a two-line re-export.
const REVIEW_GATE_CARD = readRepo("packages/agents/src/review-gate-card.tsx");
const DECISION_BAR = readRepo("packages/agents/src/review-decision-bar.tsx");
const GATE_STATES = readRepo("packages/agents/src/review-gate-states.tsx");
const TARGET_ISLAND = read(
  path.join(SRC_ROOT, "app", "lifecycle", "review-island", "page.tsx"),
);

/** Every source file that renders route chrome — the render→spec corpus. */
const CHROME_SOURCES = [
  PAGE,
  TARGET_PANEL,
  DECISION_BAR,
  GATE_STATES,
  REVIEW_GATE_CARD,
  TARGET_ISLAND,
];

/** Strip line + block comments so a NEGATIVE assertion ("no edit affordance")
 * matches real CODE, never an explanatory docstring that names the thing it
 * forbids. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const CODE_SOURCES = CHROME_SOURCES.map(stripComments);

/**
 * The CLOSED set of conformance ids the spec annotates at design@458fb7ffce6cf4ab6a2c60d3ff47198135d8ea2f, with
 * the state axes it declares. Extracted from the ratified `data-conformance-id` /
 * `data-state` annotations (§II review-target; §III provenance × floor; §IV
 * decision bar; §V disabled / loading / blocked). This is the map every id is
 * checked against.
 */
const SPEC_CONFORMANCE = {
  "review-target": ["loading", "error"],
  "review-provenance-native": ["loading", "error"],
  "review-provenance-marketplace": ["loading", "error"],
  "review-target-floor": ["error"],
  "review-decision-bar": [],
  "review-decision-disabled": ["loading"],
  "review-gate-loading": ["loading"],
  "review-gate-blocked": ["error"],
} as const;

const SPEC_IDS = Object.keys(SPEC_CONFORMANCE);

/** Host-standard anchors the spec DEFERS by name rather than annotating — the
 * "standard not-authorized panel" (§V). Allowed in render→spec, documented. */
const HOST_STANDARD_IDS = new Set([
  "review-not-authorized",
  // cinatra#2566 (epic #2564 S2) — anchors fixed by the LATER ratified spec
  // `specs/app-lifecycle-cards.html` @ 6c20871b4108176c1d0193f19ecd2947f6c6355f,
  // not by 5e5c53aff. They are the card the review is now drawn as (§II)
  // and the island that carries §III's ladder onto a client-rendered host. They
  // are listed here — rather than added to SPEC_CONFORMANCE — because this
  // suite's closed set is, by construction, the OLDER spec's; the newer spec's
  // own conformance is pinned in the S2 card suite.
  "review-gate-card",
  "review-target-island",
  "review-target-island-body",
  "review-target-island-empty",
  // cinatra#2572 (epic #2564 S6c), REDRAWN by cinatra#2852 — the SUGGESTIONS,
  // fixed by the newer spec's §VIII ("Marks, not a decision") at
  // design@60b27dfbb8a2a1594e6e88333cc5c048c244e640, whose two drawn states are
  // annotated there as `suggestion-accepted` / `suggestion-dismissed` and whose
  // per-suggestion before/after panel sits beneath the pill. Listed here for the
  // identical reason the S2 anchors are: this suite's closed set is
  // design@5e5c53aff's, and §VIII is not in it. Their own bidirectional
  // conformance is pinned in the S2 card suite.
  "suggestion-chips",
  "suggestion-accepted",
  "suggestion-dismissed",
  // cinatra#3080 — the PICTURE PROMPT field, fixed by the drawing this suite now
  // pins (the floor redrawn as Comment · Regenerate · Continue). Listed here for
  // the identical reason the anchors above are: this suite's closed set is the
  // older ratified revision's, and the redrawn floor is not in it.
  "review-regenerate-prompt-field",
  // cinatra#3080 — THE REVIEW'S RECORDED NOTES. `Comment` records the reviewer's
  // words against the review and leaves the gate pending; the words reached the
  // store and no surface at all until this anchor. Its drawn shape is not
  // invented: the cards drawing fixes ONE reading for the comments hanging off a
  // gate (a label over one panel per comment, each carrying its author kind in
  // mono above the comment itself), which the verification card already draws
  // off the same seam. Listed here for the identical reason the anchors above
  // are: this suite's closed set is the OLDER ratified revision's, and this
  // reading is not in it.
  "review-recorded-notes",
  // cinatra#2997 — the RUN CARD'S placeholder for the review screen. It is not a
  // review-page anchor at all: this route never draws it, and the module it
  // lives in is scanned here only because that module owns the review screen's
  // OTHER states (loading / blocked / settled), which this route does draw. The
  // anchor belongs to the run card's own reading, ruled by the maintainer's
  // request for changes on pull request 2890 and by PLAN: Agents Lifecycle (A)
  // section 4.2 — "While the agent works, the conversation shows basically just
  // a card (maybe even an empty review screen) with a spinning icon" — and its
  // own conformance is pinned where it is drawn
  // (packages/agents/src/__tests__/agentic-run-panel.review-slot.test.tsx) and
  // photographed (https://github.com/cinatra-ai/cinatra/blob/6c2147748ca40c09eaa7bbdf3ead65ce7f84daab/evidence/2790-s9f-host-parity, the S5a / R7a cells).
  "review-gate-placeholder",
  "suggestion-before-after",
  // A HISTORY-only reading, unreachable on a pending gate: a gate decided under
  // the old three-state marking recorded a row only for the items the reviewer
  // touched, and drawing the rest as accepted or dismissed would report a choice
  // nobody made.
  "suggestion-unrecorded",
  // cinatra#2855 — the SETTLED panel that names the recorded outcome and its
  // decider (the plan's settled-state target; the drawing addition rides the
  // design page's next §IV revision). Listed here for the same reason as the
  // S2 anchors: this suite's closed set is the older spec's. The panel's own
  // conformance (outcome named, decider named, no Refresh) is pinned in the
  // card suite.
  "review-gate-settled",
  // cinatra#2865 — the §I input hierarchy, annotated in the SAME newer ratified
  // spec (section I): the subordinate note field the decision bar draws, and
  // the primary composer the conversation column carries. Listed here for the
  // same reason as the S2 anchors: this suite's closed set is the older
  // spec's. Their own conformance is pinned in the decision-bar and
  // conversation-column suites.
  "review-note-field-subordinate",
  // Two host-standard lines the row owns rather than the drawing: the truth owed
  // to a reader whose marks were dropped when the surfaced set changed, and the
  // count of what the decision below is about to carry.
  "suggestion-marks-cleared",
  "suggestion-accepted-count",
  // cinatra#2566's COMPOSER-FOCUS deliverable — the row that says which review
  // a typed chat message reaches, and the refusal when the reader has not said.
  //
  // NAMED HONESTLY: unlike the anchors above, these are NOT fixed by a ratified
  // drawing. #2566 requires the BEHAVIOUR ("the card names WHICH item your
  // message goes to"; two open gates route only after explicit focus) and S2
  // recorded the focused composer as drawn nowhere. The row is therefore
  // COMPOSED from shipped primitives — the card's own panel treatment and the
  // shipped Button — and carries no invented pixel; the drawing itself still
  // owes a design spec. On the review PAGE the row never renders at all (no
  // composer, so no store, so `available` is false), which is why it appears
  // here only as source the page's card file contains.
  "review-composer-focus",
  "review-composer-bound",
  "review-composer-ambiguous",
  "review-composer-unbound",
  // cinatra#2713 — the island's OWN load state while its iframe document
  // fetches: a skeleton before the `load` event, and a bounded-timeout retry
  // panel if it never fires. A THIRD axis, orthogonal to this file's §V
  // `review-gate-loading` / `review-gate-blocked` (those are the OUTER
  // gate's own lifecycle; none of `review-gate-blocked`'s reasons is true
  // when only the preview failed to arrive, which is why the timeout panel
  // reuses that component's visual shape rather than the component itself —
  // see the doc comment on `ReviewTargetIsland`).
  //
  // NAMED HONESTLY: no dedicated island mockup exists for this window in
  // either `specs/app-lifecycle-cards.html` or `specs/app-components.html`'s
  // Skeleton/Spinner section (checked) — the skeleton reuses that section's
  // generic bar-skeleton language verbatim, and the timeout panel reuses
  // `ReviewGateBlocked`'s shape. The owner ruled the catalog's standard
  // loading pattern IS the drawing of record for this state (the ruling is
  // recorded with cinatra#2713's closing trail). Listed here, like the
  // composer anchors above, on the honestly-reused primitives; if a dedicated
  // drawing ever supersedes the catalog pattern, these ids move to
  // SPEC_CONFORMANCE under its spec commit.
  "review-target-island-skeleton",
  "review-target-island-timeout",
]);

function conformanceIdsIn(src: string): string[] {
  return [...src.matchAll(/data-conformance-id="([^"]+)"/g)].map((m) => m[1]);
}

describe(`§I–VI — spec→render: every ${SPEC_COMMIT} conformance anchor is rendered`, () => {
  // An anchor is "rendered" when the route emits it — either as a static
  // `data-conformance-id="id"` attribute, or (the §III provenance anchors) as
  // the model's mapping literal the panel binds `data-conformance-id={…}` to.
  const anchorCorpus = [...CHROME_SOURCES, MODEL];
  for (const id of SPEC_IDS) {
    it(`renders the "${id}" anchor`, () => {
      const asAttr = CHROME_SOURCES.some((s) => s.includes(`data-conformance-id="${id}"`));
      const asMappedLiteral = MODEL.includes(`"${id}"`);
      expect(asAttr || asMappedLiteral).toBe(true);
      // And the id string genuinely appears in the surface source (not a typo).
      expect(anchorCorpus.some((s) => s.includes(id))).toBe(true);
    });
  }
});

describe("§I–VI — render→spec: the route invents no anchor outside the closed spec set", () => {
  it("every data-conformance-id the route renders is a spec anchor (or a documented host-standard panel)", () => {
    const allowed = new Set<string>([...SPEC_IDS, ...HOST_STANDARD_IDS]);
    for (const src of CHROME_SOURCES) {
      for (const id of conformanceIdsIn(src)) {
        expect(allowed.has(id)).toBe(true);
      }
    }
  });
});

describe("§I — one type-agnostic surface (G1-clean: no concrete type / renderer id)", () => {
  it("the model + panel key on the OPAQUE mount kind, never a concrete type/binding/renderer id", () => {
    // The provenance/floor anchor is derived from the mount kind union only.
    expect(MODEL).toMatch(/case "build-map":/);
    expect(MODEL).toMatch(/case "runtime":/);
    expect(MODEL).toMatch(/case "floor":/);
    // No renderer-id / concrete-type prop is threaded through the surface.
    expect(stripComments(TARGET_PANEL)).not.toMatch(/rendererId|generatedKey=|packageName=/);
    expect(stripComments(PAGE)).not.toMatch(/rendererId/);
  });

  it("the gate header presents 'Review requested' + the agent summary WHEN present (§I/§II)", () => {
    // cinatra#2566: the header is the CARD's, and the agent summary rides with
    // the targets in the island — one drawing, three hosts. The page still owns
    // the surrounding review document; it no longer composes the gate itself.
    expect(REVIEW_GATE_CARD).toMatch(/Review requested/);
    expect(REVIEW_GATE_CARD).toMatch(/Awaiting your decision/);
    expect(TARGET_ISLAND).toMatch(/surface\.agentSummary \?/);
    expect(TARGET_ISLAND).toMatch(/Agent summary/);
  });
});

describe("§II — the immutable target header is inert (no edit control, no revision picker)", () => {
  it("carries the pinned marker + the name=type.displayName field binding", () => {
    expect(TARGET_PANEL).toMatch(/data-conformance-id="review-target"/);
    expect(TARGET_PANEL).toMatch(/data-field="name=type\.displayName"/);
    expect(TARGET_PANEL).toMatch(/pinned/);
  });

  it("exposes NO edit affordance and NO revision picker on the target header", () => {
    expect(stripComments(TARGET_PANEL)).not.toMatch(/revision picker|RevisionPicker|Edit\b|contentEditable|<select/i);
  });
});

describe("§III — renderer provenance is host-derived; the floor is never blank", () => {
  it("maps build-map→native chip, runtime→marketplace chip, floor→generic-floor anchor", () => {
    expect(MODEL).toMatch(/"review-provenance-native"/);
    expect(MODEL).toMatch(/"review-provenance-marketplace"/);
    expect(MODEL).toMatch(/"review-target-floor"/);
    // build-map → native, runtime → marketplace, floor → floor.
    expect(MODEL).toMatch(/case "build-map":\s*\n\s*return "review-provenance-native"/);
    expect(MODEL).toMatch(/case "runtime":\s*\n\s*return "review-provenance-marketplace"/);
    expect(MODEL).toMatch(/case "floor":\s*\n\s*return "review-target-floor"/);
  });

  // cinatra#2931 W4 — the maintainer's answer of 2026-08-23 (Q1): NO label at
  // all above the reviewed work for the built-in markdown / plain-text
  // rendering. The host's own text rendering names no package and did render
  // the work, so it takes no region and is given no fourth one.
  it("the form rung renders NO provenance region", () => {
    expect(MODEL).toMatch(/case "form":\s*\n\s*return null/);
  });

  // cinatra#3080 — THE ROW THE NEWER DRAWING FORBIDS. This suite's closed set
  // is the OLDER ratified revision's, which annotated a region for each renderer
  // tier; the drawing pinned above (SPEC_COMMIT) settles what such a region may
  // DRAW, and the answer is nothing: the renderer resolution "is NOT put on
  // screen: a display shows the work and nothing about itself — no renderer
  // name, no package identity, no provenance line", and its build-time and
  // runtime examples are drawn identically for exactly that reason. The panel
  // therefore draws ONE region beneath the header — the floor's — and the two
  // renderer-tier anchors stay a classification the model makes and nothing
  // renders. The live render is pinned in `review-target-provenance.test.tsx`;
  // these are the source-level backstops.
  it("draws NO renderer-resolution line and NO package identity beneath the header", () => {
    const panel = stripComments(TARGET_PANEL);
    expect(panel).not.toMatch(/build-time · /);
    expect(panel).not.toMatch(/runtime · /);
    expect(panel).not.toMatch(/provenance\.packageName/);
  });

  it("gates the ONE region it draws on the floor anchor alone", () => {
    const panel = stripComments(TARGET_PANEL);
    expect(panel).toMatch(/provenanceConformanceId === "review-target-floor"/);
    expect(panel).not.toMatch(/data-conformance-id="review-provenance/);
  });

  it("no review surface draws a resolution line on any host", () => {
    for (const src of CODE_SOURCES) {
      expect(src).not.toMatch(/build-time · /);
      expect(src).not.toMatch(/runtime · /);
    }
  });

  it("the representation slot mounts through the host ReviewTargetMount, on the host's org scope", () => {
    expect(TARGET_PANEL).toMatch(/ReviewTargetMount/);
    expect(TARGET_PANEL).toMatch(/orgId=\{orgId\}/);
  });

  // cinatra#2931 W4 — plan (B) §5: "The fallback face dies with its wrong
  // diagnosis." The sentence, the table of technical fields and the Preview /
  // Download links are gone from the card; what remains is the mount's own
  // sanitized diagnostic for a genuine no-renderer state and for each defensive
  // state, which keep their honest readings.
  it("carries NO fallback face — no 'no renderer resolved' sentence, no field table, no Preview/Download", () => {
    const panel = stripComments(TARGET_PANEL);
    expect(panel).not.toMatch(/No type renderer resolved/);
    expect(panel).not.toMatch(/ReviewGenericFloor/);
    expect(panel).not.toMatch(/genericFloor/);
    expect(panel).not.toMatch(/urls\.preview|urls\.download/);
    expect(panel).not.toMatch(/>\s*Download\s*</);
    expect(TARGET_PANEL).toMatch(/fallback=\{null\}/);
  });
});

describe("§IV — the decision: three affordances, one bar, atomic, re-validated", () => {
  it("offers exactly Comment / Regenerate / Continue with the spec action outcomes", () => {
    expect(DECISION_BAR).toMatch(/data-action="comment-review -> annotated"/);
    expect(DECISION_BAR).toMatch(/data-action="regenerate-review -> changes-requested"/);
    expect(DECISION_BAR).toMatch(/data-action="continue-review -> resolved"/);
  });

  it("draws NEITHER Reject NOR Approve on a pending review (cinatra#3080)", () => {
    const code = stripComments(DECISION_BAR);
    expect(code).not.toMatch(/data-action="reject-review/);
    expect(code).not.toMatch(/data-action="approve-review/);
    expect(code).not.toMatch(/>\s*Reject\s*</);
    expect(code).not.toMatch(/>\s*Approve\s*</);
    // Nothing on the floor is drawn in the retired Reject's destructive weight:
    // Regenerate asks for another go, it does not turn work back.
    expect(code).not.toMatch(/variant="destructive"/);
  });

  it("Continue is the primary act and Regenerate is structurally distinct from it (§IV/§VI)", () => {
    expect(DECISION_BAR).toMatch(/variant="secondary"[\s\S]*?data-action="regenerate-review/);
    expect(DECISION_BAR).toMatch(/variant="default"[\s\S]*?data-action="continue-review/);
  });

  it("carries the one note field, in the drawing's own words, that travels to the audit trail", () => {
    // cinatra#3080 — the field is the drawing's NOTE, and it is labelled with the
    // drawing's sentence rather than a paraphrase of it: one note, optional when
    // the run simply goes on, and the material a Regenerate works from. The DOM
    // proof of the exact label and placeholder is `review-floor-bar.test.tsx`;
    // this pin keeps the source from drifting back to a summary of the drawing.
    expect(DECISION_BAR).toMatch(/optional on Continue · the words a Regenerate works from/);
    expect(DECISION_BAR).toMatch(/Add a note, or say what to change before Regenerate/);
    expect(stripComments(DECISION_BAR)).not.toMatch(/Decision rationale/);
    expect(DECISION_BAR).toMatch(/Textarea/);
  });

  it("carries the picture's prompt as its OWN field beside the note (item 5)", () => {
    expect(DECISION_BAR).toMatch(/data-conformance-id="review-regenerate-prompt-field"/);
    expect(DECISION_BAR).toMatch(/Picture prompt/);
    // Its own value on the submit, never folded into the note.
    expect(DECISION_BAR).toMatch(/regeneratePrompt/);
  });

  it("the submit sends ONLY disposition + comment (display+decide) — no client target/renderer set", () => {
    expect(DECISION_BAR).toMatch(/submitAction\(\{\s*[\s\S]*?disposition[\s\S]*?comment/);
    expect(stripComments(DECISION_BAR)).not.toMatch(/reviewedTargets|targets:/);
    // The server assembles the WHOLE-gate decision from the frozen pinned set.
    expect(ACTIONS).toMatch(/readReviewGatePinnedTargets/);
    expect(ACTIONS).toMatch(/reviewedTargets: pinnedTargets/);
  });

  it("FAIL-CLOSED: a fingerprint conflict / settled gate is a BLOCK, never a silent success (§IV)", () => {
    // mapSubmitResultToOutcome routes gate-conflict + gate-not-pending → blocked.
    expect(MODEL).toMatch(/case "gate-conflict":\s*\n\s*case "gate-not-pending":\s*\n\s*return \{ kind: "blocked", reason: "no-longer-pending" \}/);
    expect(MODEL).toMatch(/case "revision-not-member":\s*\n\s*return \{ kind: "blocked", reason: "revision-not-live" \}/);
  });

  it("a landed non-terminal comment keeps the gate pending (annotated, nothing resumes)", () => {
    expect(MODEL).toMatch(/disposition === "comment"[\s\S]*?return \{ kind: "annotated" \}/);
    expect(DECISION_BAR).toMatch(/Comment recorded\. The gate stays open/);
  });
});

describe("§V — permission, loading & blocked states", () => {
  it("terminal decide is approve-gated; comment is respond-gated; a see-but-not-decide viewer is disabled with a reason", () => {
    expect(DECISION_BAR).toMatch(/permissions\.canDecide/);
    expect(DECISION_BAR).toMatch(/permissions\.canComment/);
    expect(DECISION_BAR).toMatch(/data-conformance-id="review-decision-disabled"/);
    expect(MODEL).toMatch(/reviewDecideDisabledReason/);
    // A viewer with NO run access never reaches the targets — the standard panel.
    expect(PAGE).toMatch(/surface\.kind === "not-authorized"/);
    expect(PAGE).toMatch(/ReviewNotAuthorizedPanel/);
  });

  it("the surface loader gates on read access FIRST, then a pending gate, then prepares (§V order)", () => {
    // (loadReviewGateSurface lives in the review-gate-ports binder; its ordering
    // is unit-proven there. The page consumes the discriminated model.)
    expect(PAGE).toMatch(/loadReviewGateSurface/);
    expect(PAGE).toMatch(/surface\.kind === "blocked"/);
  });

  it("loading skeleton + blocked panel with a refresh back to the live gate (never a stale slip)", () => {
    expect(GATE_STATES).toMatch(/data-conformance-id="review-gate-loading"/);
    expect(GATE_STATES).toMatch(/data-conformance-id="review-gate-blocked"/);
    expect(GATE_STATES).toMatch(/router\.refresh\(\)/);
    expect(GATE_STATES).toMatch(/data-action="refresh-gate -> live-gate"/);
    // cinatra#2566: the targets stream behind the SAME skeleton, now inside the
    // island that renders them for every host.
    expect(TARGET_ISLAND).toMatch(/Suspense[\s\S]*?fallback=\{<ReviewGateLoading/);
  });
});

describe("§VI — nothing on the floor destroys work (cinatra#3080)", () => {
  it("no affordance on the surface hard-deletes an artifact", () => {
    for (const src of CODE_SOURCES) {
      expect(src).not.toMatch(/hard-delete|hardDelete|deleteArtifact|destroy/i);
    }
  });

  it("the retired reject's tombstone reading is drawn nowhere on the floor", () => {
    // §VI used to require the reject notice to read as TURNED BACK — a
    // first-class outcome rather than a quiet approve. With reject retired there
    // is no such notice: the two acts that settle a gate are Continue (the run
    // goes on) and Regenerate (it is made again), and neither turns work back.
    const code = stripComments(DECISION_BAR);
    expect(code).not.toMatch(/Rejected\./);
    expect(code).not.toMatch(/tombstone/i);
  });
});

describe("§IV — LIFECYCLE prompt-window wiring (owner ruling 2026-07-25, cinatra#2063)", () => {
  // The ruling: the prompt window (the Comment path) IS where the user requests
  // changes — no dedicated 'request changes' field. On a lifecycle review gate with
  // the fence on, the typed Comment feedback drives a `changes_requested` decision
  // through the S2 store entry point; otherwise the Comment path is byte-identical.

  it("adds NO fourth decision affordance — the three-button conformance lock is unchanged", () => {
    // Still exactly three data-action affordances, and they are the floor's.
    expect(DECISION_BAR).toMatch(/data-action="comment-review -> annotated"/);
    expect(DECISION_BAR).toMatch(/data-action="regenerate-review -> changes-requested"/);
    expect(DECISION_BAR).toMatch(/data-action="continue-review -> resolved"/);
    expect(stripComments(DECISION_BAR).match(/data-action="[a-z-]+-review/g) ?? []).toHaveLength(3);
    // What a NEW decision may carry is approve (Continue's stored value) and
    // comment — reject retired with the button (cinatra#3080), and Regenerate
    // carries no disposition at all because it rides the change road.
    // The SETTLED-OUTCOME vocabulary may name the recorded outcome; only that
    // type union and its copy switch may carry the literal.
    expect(MODEL).toMatch(/REVIEW_DISPOSITIONS[\s\S]*?"approve",\s*"comment"\s*\]/);
    const literalLines = stripComments(MODEL)
      .split("\n")
      .filter((l) => l.includes('"changes_requested"'));
    for (const l of literalLines) {
      expect(l).toMatch(/ReviewSettledOutcome|case "changes_requested":/);
    }
  });

  it("REGENERATE routes to changes_requested — and the Comment overload is gone (cinatra#3080)", () => {
    // The fence gate + the lifecycle-gate class check + single-target guard all
    // survive; what moved is WHICH action they guard.
    expect(ACTIONS).toMatch(/isLifecycleReviewOrchestrationActive\(\)/);
    expect(ACTIONS).toMatch(/isAutoReviewTaskId\(reviewTaskId\)/);
    expect(ACTIONS).toMatch(/isBatchAutoReviewTaskId\(reviewTaskId\)/);
    expect(ACTIONS).toMatch(/pinnedTargets\.length !== 1/);
    expect(ACTIONS).toMatch(/action === "regenerate"/);
    expect(ACTIONS).toMatch(/submitReviewSurfaceChangesRequested/);
    expect(ACTIONS).toMatch(/mapChangesRequestedToOutcome/);
    // THE OVERLOAD IS REMOVED: no branch keys the canonical change operation off
    // a comment any more, so Comment cannot resolve a gate.
    expect(stripComments(ACTIONS)).not.toMatch(/disposition === "comment"/);
  });

  it("the changes_requested outcome renders as a status notice (data-review-outcome), NOT a new conformance anchor", () => {
    expect(DECISION_BAR).toMatch(/data-review-outcome="changes-requested"/);
    // It must NOT introduce a new data-conformance-id (render→spec closed set).
    const ids = conformanceIdsIn(DECISION_BAR);
    for (const id of ids) expect(new Set<string>([...SPEC_IDS, ...HOST_STANDARD_IDS]).has(id)).toBe(true);
    // The gate is RESOLVED on this path — the notice reads as sent back to be
    // made again, which is what Regenerate did (cinatra#3080).
    expect(DECISION_BAR).toMatch(/Sent back to be made again/);
  });

  it("the Comment path is the annotation and NOTHING else (cinatra#3080)", () => {
    expect(MODEL).toMatch(/disposition === "comment"[\s\S]*?return \{ kind: "annotated" \}/);
    expect(DECISION_BAR).toMatch(/Comment recorded\. The gate stays open/);
  });
});

describe("§I–III — run-embedded anchors: the revised spec's closed set is rendered bidirectionally", () => {
  // The run-embedded surface (design@5e5c53aff) added five anchors beyond
  // the review-route chrome. This block asserts the CLOSED set of run-embedded
  // anchors bidirectionally: every spec anchor has a render site, and each render
  // site carries only spec anchors. `run-gate-notification` has NO DOM home (it is
  // a notification) — it is asserted BEHAVIORALLY against its builder.
  const RUN_EMBEDDED_DOM_ANCHORS: Record<string, string> = {
    "run-surface": RUN_SURFACE,
    "run-step-rail": RUN_STEP_RAIL,
    "run-chip-row": RUN_CHIP_ROW,
    "review-prompt-window": REVIEW_PROMPT_WINDOW,
  };

  for (const [id, src] of Object.entries(RUN_EMBEDDED_DOM_ANCHORS)) {
    it(`spec→render: the "${id}" anchor is rendered at its run-embedded site`, () => {
      expect(src.includes(`data-conformance-id="${id}"`)).toBe(true);
    });
  }

  it('spec→render: the run rail carries the "open-run-step -> step-detail" action (spec §I)', () => {
    expect(RUN_STEP_RAIL).toMatch(/data-action="open-run-step -> step-detail"/);
  });

  it('spec→render: the run-start chip-row carries the "confirm-skill -> confirmed" action (spec §II)', () => {
    expect(RUN_CHIP_ROW).toMatch(/data-action="confirm-skill -> confirmed"/);
  });

  it('spec→render: the prompt window carries "comment-review -> annotated" — a typed sentence is a NOTE now (cinatra#3080)', () => {
    // The window used to file typed feedback as a `changes_requested` decision:
    // the affordance that decides nothing was the strongest act on the surface.
    // Asking for another go is Regenerate's, on the floor; what is typed here is
    // a note, and the window says so.
    expect(REVIEW_PROMPT_WINDOW).toMatch(/data-action="comment-review -> annotated"/);
    expect(stripComments(REVIEW_PROMPT_WINDOW)).not.toMatch(/data-action="request-changes/);
    // And it adds NO fourth decision affordance — the request rides the Comment path.
    expect(stripComments(REVIEW_PROMPT_WINDOW)).not.toMatch(/request changes<|>Request changes/i);
  });

  it('spec→render: run-gate-notification is asserted behaviorally — a pending auto-gate deep-links to the RUN, never a detached page (spec §I)', () => {
    // No DOM anchor — the builder threads an href to the run view + tags the
    // run-awaiting-human category, deep-linking straight to the gate inside the run.
    expect(RUN_GATE_NOTIFICATION).toMatch(/RUN_GATE_NOTIFICATION_CONFORMANCE_ID = "run-gate-notification"/);
    expect(RUN_GATE_NOTIFICATION).toMatch(/buildAutoGateOpenNotificationInput/);
    expect(RUN_GATE_NOTIFICATION).toMatch(/input\.href \? \{ href: input\.href \}/);
    expect(RUN_GATE_NOTIFICATION).toMatch(/runAwaitingHuman: \{ runId: input\.runId/);
  });

  it("render→spec: every run-embedded render site carries ONLY anchors in the revised spec's closed set (no invented affordance)", () => {
    // The full closed set the spec annotates at design@5e5c53aff (review-route
    // anchors + the five run-embedded anchors + the documented host-standard panel).
    const RUN_EMBEDDED_IDS = ["run-surface", "run-step-rail", "run-chip-row", "run-gate-notification", "review-prompt-window"];
    const closed = new Set<string>([...SPEC_IDS, ...RUN_EMBEDDED_IDS, ...HOST_STANDARD_IDS]);
    for (const src of [RUN_SURFACE, RUN_STEP_RAIL, RUN_CHIP_ROW, REVIEW_PROMPT_WINDOW]) {
      for (const foundId of conformanceIdsIn(src)) {
        expect(closed.has(foundId)).toBe(true);
      }
    }
  });

  it("CHIP-ROW PLACEMENT NUANCE (reported for a spec touch-up): the spec places run-chip-row at the trigger-gate HEAD of the rail; the ship renders it in the run detail with the rail SUPPRESSED pre-execution (#2067's pre-execution hold), so the anchor is asserted on the CARD", () => {
    // The chip-row anchor is on the chip-row card (its real render home), NOT woven
    // into the rail at run-start — a not-yet-started run shows no rail. This is the
    // brief's fallback option: assert the anchor at its real placement + report the
    // spec nuance rather than silently drop it. The design pair (C3 chip placement)
    // reconciles the rail-head presentation.
    expect(RUN_CHIP_ROW).toMatch(/data-conformance-id="run-chip-row"/);
    // The rail is suppressed for a pending_input (run-start) run in the screen.
    // Since S9d (#2788) that predicate is NAMED (`railDraws`) and derived above
    // the left column instead of being written inline on the mount: the plan's
    // §7.2 step 5 puts the SCHEDULE step above "1 Review", so the column may
    // have to draw when the run's own rail does not, and the two conditions
    // could no longer share one expression.
    //
    // Since S9f (#2790) the expression itself is an EXPORTED predicate
    // (`screenDrawsPageRail`), because the suppression acquired a condition: a
    // run HELD at its skills question is `pending_input` too, and plan (A) §6.2
    // puts that gate row "ahead of the work steps it would authorize" — a rail
    // holding the gate row alone shows nothing for it to be ahead of. So the
    // pin follows the predicate, and the behavioural table it answers is pinned
    // in packages/agents/src/__tests__/instance-screens-recommendation-step.test.ts.
    expect(RUN_SURFACE).toMatch(
      /const railDraws = screenDrawsPageRail\(\{[\s\S]*?railEntryCount: rail\.entries\.length,/,
    );
    expect(RUN_SURFACE).toMatch(/railDraws \?\s*\(?\s*<RunStepRailPanel/);
  });

  it("the decision floor stays LOCKED at Comment/Regenerate/Continue — the run-embedded anchors add no fourth affordance", () => {
    expect(DECISION_BAR).toMatch(/data-action="comment-review -> annotated"/);
    expect(DECISION_BAR).toMatch(/data-action="regenerate-review -> changes-requested"/);
    expect(DECISION_BAR).toMatch(/data-action="continue-review -> resolved"/);
    expect(stripComments(DECISION_BAR)).not.toMatch(/data-action="(approve|reject)-review/);
  });
});

describe("meta — the surface pins exactly one spec commit and no stray fixture route", () => {
  it("the route directory contains only the review chrome (no design-fixture leakage)", () => {
    const entries = readdirSync(ROUTE);
    // The live proof drives THIS real route, never a fixture route.
    expect(entries).toContain("page.tsx");
    expect(entries.some((e) => /fixture/i.test(e))).toBe(false);
  });
});
