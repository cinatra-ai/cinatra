/**
 * Source-text conformance for the generic artifact-review surface — the host
 * decision chrome (cinatra#1795, epic #1620 S12 item 4), pinned to the RATIFIED
 * design spec `specs/app-artifact-review.html`
 * @ design@5e5c53aff581c01f8b801c4a5e41e9c6f3f0b891 (owner-approved). Every conformance id the
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

const SPEC_COMMIT = "design@5e5c53aff581c01f8b801c4a5e41e9c6f3f0b891"; // specs/app-artifact-review.html (ratified)

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
const DECISION_BAR = routeFile("review-decision-bar.tsx");
const GATE_STATES = routeFile("review-gate-states.tsx");
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

/** Every source file that renders route chrome — the render→spec corpus. */
const CHROME_SOURCES = [PAGE, TARGET_PANEL, DECISION_BAR, GATE_STATES];

/** Strip line + block comments so a NEGATIVE assertion ("no edit affordance")
 * matches real CODE, never an explanatory docstring that names the thing it
 * forbids. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const CODE_SOURCES = CHROME_SOURCES.map(stripComments);

/**
 * The CLOSED set of conformance ids the spec annotates at design@5e5c53aff581c01f8b801c4a5e41e9c6f3f0b891, with
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
const HOST_STANDARD_IDS = new Set(["review-not-authorized"]);

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
    expect(PAGE).toMatch(/Review requested/);
    expect(PAGE).toMatch(/Awaiting your decision/);
    expect(PAGE).toMatch(/surface\.agentSummary \?/);
    expect(PAGE).toMatch(/Agent summary/);
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

  it("a runtime provenance additionally shows its package identity (§III)", () => {
    expect(TARGET_PANEL).toMatch(/provenance\.kind === "runtime"/);
    expect(TARGET_PANEL).toMatch(/provenance\.packageName/);
  });

  it("the representation slot mounts through the host ReviewTargetMount with a generic-floor fallback", () => {
    expect(TARGET_PANEL).toMatch(/ReviewTargetMount/);
    expect(TARGET_PANEL).toMatch(/fallback=\{genericFloor\}/);
    // The floor renders from host display-only props, never the raw bytes.
    expect(TARGET_PANEL).toMatch(/ReviewGenericFloor/);
  });
});

describe("§IV — the decision: three affordances, one bar, atomic, re-validated", () => {
  it("offers exactly Approve / Reject / Comment with the spec action outcomes; no 'request changes'", () => {
    expect(DECISION_BAR).toMatch(/data-action="approve-review -> resolved"/);
    expect(DECISION_BAR).toMatch(/data-action="reject-review -> resolved"/);
    expect(DECISION_BAR).toMatch(/data-action="comment-review -> annotated"/);
    expect(stripComments(DECISION_BAR)).not.toMatch(/request changes|request-changes/i);
  });

  it("Reject is destructive + structurally distinct from Approve (primary) — never a quiet approve (§IV/§VI)", () => {
    expect(DECISION_BAR).toMatch(/variant="destructive"[\s\S]*?data-action="reject-review/);
    expect(DECISION_BAR).toMatch(/variant="default"[\s\S]*?data-action="approve-review/);
  });

  it("carries the one optional rationale field (expected on reject) that travels to the audit trail", () => {
    expect(DECISION_BAR).toMatch(/Decision rationale/);
    expect(DECISION_BAR).toMatch(/optional on approve, expected on reject/);
    expect(DECISION_BAR).toMatch(/Textarea/);
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
    // The page streams each target behind the loading skeleton.
    expect(PAGE).toMatch(/Suspense[\s\S]*?fallback=\{<ReviewGateLoading/);
  });
});

describe("§VI — reject semantics: tombstone, never a destructive delete", () => {
  it("no affordance on the surface hard-deletes an artifact", () => {
    for (const src of CODE_SOURCES) {
      expect(src).not.toMatch(/hard-delete|hardDelete|deleteArtifact|destroy/i);
    }
  });

  it("the terminal reject notice reads as turned-back (a first-class outcome, not a quiet approve)", () => {
    expect(DECISION_BAR).toMatch(/turned back/);
  });
});

describe("§IV — LIFECYCLE prompt-window wiring (owner ruling 2026-07-25, cinatra#2063)", () => {
  // The ruling: the prompt window (the Comment path) IS where the user requests
  // changes — no dedicated 'request changes' field. On a lifecycle review gate with
  // the fence on, the typed Comment feedback drives a `changes_requested` decision
  // through the S2 store entry point; otherwise the Comment path is byte-identical.

  it("adds NO fourth decision affordance — the three-button conformance lock is unchanged", () => {
    // Still exactly the three data-action affordances; no 'request changes' button.
    expect(DECISION_BAR).toMatch(/data-action="approve-review -> resolved"/);
    expect(DECISION_BAR).toMatch(/data-action="reject-review -> resolved"/);
    expect(DECISION_BAR).toMatch(/data-action="comment-review -> annotated"/);
    expect(stripComments(DECISION_BAR)).not.toMatch(/request changes|request-changes/i);
    // The disposition set the bar offers stays approve/reject/comment (no
    // changes_requested affordance on the surface — it rides the Comment path).
    expect(MODEL).toMatch(/REVIEW_DISPOSITIONS[\s\S]*?"approve",\s*"reject",\s*"comment",?\s*\]/);
    expect(stripComments(MODEL)).not.toMatch(/"changes_requested"/);
  });

  it("the action routes the Comment path to changes_requested ONLY when fenced + a single-target lifecycle gate", () => {
    // The fence gate + the lifecycle-gate class check + single-target guard.
    expect(ACTIONS).toMatch(/isLifecycleReviewOrchestrationActive\(\)/);
    expect(ACTIONS).toMatch(/isAutoReviewTaskId\(reviewTaskId\)/);
    expect(ACTIONS).toMatch(/!isBatchAutoReviewTaskId\(reviewTaskId\)/);
    expect(ACTIONS).toMatch(/pinnedTargets\.length === 1/);
    // Only the Comment disposition with non-empty feedback takes the path.
    expect(ACTIONS).toMatch(/disposition === "comment"/);
    expect(ACTIONS).toMatch(/submitReviewSurfaceChangesRequested/);
    expect(ACTIONS).toMatch(/mapChangesRequestedToOutcome/);
  });

  it("the changes_requested outcome renders as a status notice (data-review-outcome), NOT a new conformance anchor", () => {
    expect(DECISION_BAR).toMatch(/data-review-outcome="changes-requested"/);
    // It must NOT introduce a new data-conformance-id (render→spec closed set).
    const ids = conformanceIdsIn(DECISION_BAR);
    for (const id of ids) expect(new Set<string>([...SPEC_IDS, ...HOST_STANDARD_IDS]).has(id)).toBe(true);
    // The gate is RESOLVED on this path — the notice reads as turned back for repair.
    expect(DECISION_BAR).toMatch(/turned back for repair/);
  });

  it("the base Comment path stays byte-identical — a plain comment is still annotated, gate stays pending", () => {
    // The changes_requested branch is ADDITIVE: the comment→annotated mapping and
    // the 'stays open' notice are untouched (the fence-off / non-lifecycle path).
    expect(MODEL).toMatch(/disposition === "comment"[\s\S]*?return \{ kind: "annotated" \}/);
    expect(DECISION_BAR).toMatch(/Comment recorded\. The gate stays open/);
  });
});

describe("§I–III — run-embedded anchors: the revised spec's closed set is rendered bidirectionally", () => {
  // The run-embedded surface (design@5e5c53aff, v0.2.0) added five anchors beyond
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

  it('spec→render: the prompt window carries "request-changes -> changes-requested" — the typed request IS how changes are requested (spec §VI)', () => {
    expect(REVIEW_PROMPT_WINDOW).toMatch(/data-action="request-changes -> changes-requested"/);
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
    expect(RUN_SURFACE).toMatch(/run\.status !== "pending_input" && rail\.entries\.length > 0/);
  });

  it("the decision floor stays LOCKED at Approve/Reject/Comment — the run-embedded anchors add no fourth affordance", () => {
    expect(DECISION_BAR).toMatch(/data-action="approve-review -> resolved"/);
    expect(DECISION_BAR).toMatch(/data-action="reject-review -> resolved"/);
    expect(DECISION_BAR).toMatch(/data-action="comment-review -> annotated"/);
    expect(stripComments(DECISION_BAR)).not.toMatch(/request changes|request-changes/i);
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
