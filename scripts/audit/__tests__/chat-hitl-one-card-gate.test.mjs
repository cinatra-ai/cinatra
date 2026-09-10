// Fixture tests for the ONE-CARD-PER-INTERACTION gate (cinatra#2573, epic
// #2564 S7).
//
// The gate's whole value is that a SECOND renderer of a lifecycle interaction
// fails CI. These tests hold both halves of that claim:
//
//   1. A synthetic violation FAILS — in each of the four rules the gate claims
//      to enforce (a second card definition; each of the three retired parallel
//      renderers; an undeclared-host mount; a duplicated registry row).
//   2. The REAL modules pass, and pass BECAUSE they are correct rather than
//      because the matcher is blind: the owner modules are asserted to contain
//      the definitions the gate looks for, so the allowlist can never rot into
//      a vacuously-green list of files that stopped rendering anything.
//   3. The false-positive half: prose about a retired renderer, inside a
//      comment, does NOT trip the gate.
//   4. The gate exits 0 on the real tree — which is also what makes it RUN in
//      CI, since `scripts/audit/__tests__/**` is inside the root vitest include.
//
// The S9 round adds the other half of the claim: that each interaction has ONE
// renderer, not merely no more than one. The completeness fixtures below hold
// every way a kind could LOOK owned while drawing nothing — an empty stub, an
// owner that only returns null, an owner that ignores the body it was handed, an
// anchor parked in a branch that can never run, a placeholder row left stale
// after its card landed, a duplicate host mount and a missing host adapter. The
// proper-owner fixture beside each one is what keeps the rules from being
// satisfiable by refusing everything.
//
// The matcher is IMPORTED from the gate rather than re-implemented, so a fixture
// can never assert a rule that differs from what CI enforces.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CARD_OWNERS,
  cardDefinitionPattern,
  RETIRED_PARALLELS,
  VERIFICATION_CORE_ANCHORS,
  REGISTRY_MODULE,
  REGISTRY_KINDS,
  HOST_PROVIDED_BY_PARENT,
  collectFiles,
  LIFECYCLE_CARD_CONTRACTS,
  LIFECYCLE_CARD_KINDS,
  LIFECYCLE_CARD_HOSTS,
  auditContracts,
  collectContractViolations,
  collectViolations,
  emitsAnchor,
  extractComponentBody,
  assertsAbout,
  assertsExactlyOneInstance,
  extractTestBlock,
  openRequirements,
  proofAssertsAnchor,
  REQUIRED_ROOT_ATTRIBUTES,
  isExempt,
  placeholderKinds,
  scanHostMounts,
  scanModule,
  scanOwnerModule,
  scanRegistry,
  stripUnreachable,
} from "../chat-hitl-one-card-gate.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GATE_REL = "scripts/audit/chat-hitl-one-card-gate.mjs";
const GATE = join(REPO_ROOT, GATE_REL);
// The committed verbatim transcript of a CLEAN run of this gate. It is a real
// test input — the assertion below re-runs the gate and compares byte for byte
// — so it lives beside the suite as a fixture rather than in a proof folder.
const TRANSCRIPT_REL = "scripts/audit/__fixtures__/one-card-gate/clean-run-transcript.txt";
const read = (rel) => readFileSync(join(REPO_ROOT, rel), "utf8");

describe("R1 — a second card implementation is a violation", () => {
  it("flags a second review-gate card definition outside its owner module", () => {
    const hits = scanModule(
      "packages/agents/src/somewhere-else.tsx",
      "export function CompactReviewGateCard() { return null; }",
    );
    expect(hits.map((h) => h.rule)).toContain("R1");
  });

  it("a SECOND review-gate card definition outside its owner module fails R1", () => {
    const hits = scanModule("src/app/some/route/card.tsx", "const MyReviewGateCard = () => null;");
    expect(hits).toHaveLength(1);
    expect(hits[0].detail).toMatch(/second 'artifact_review_gate' card implementation/);
  });

  it("does NOT flag the definition in its own owner module — the owner is the point", () => {
    const owner = CARD_OWNERS.artifact_review_gate.owner;
    expect(scanModule(owner, "export function ReviewGateCard() { return null; }")).toEqual([]);
  });

  it("every declared owner module really contains the definition the gate keys on", () => {
    for (const [kind, spec] of Object.entries(CARD_OWNERS)) {
      const src = read(spec.owner);
      const re = cardDefinitionPattern(spec.component);
      expect(re.test(src), `${kind}: ${spec.owner} no longer defines ${spec.component}`).toBe(true);
    }
  });

  it("the pattern is a LOOK-ALIKE detector, not just a name match", () => {
    const re = cardDefinitionPattern("ReviewGateCard");
    expect(re.test("function ReviewGateCard() {}")).toBe(true);
    expect(cardDefinitionPattern("ReviewGateCard").test("class CompactReviewGateCard {}")).toBe(true);
    // …and it does not fire on an unrelated symbol that merely mentions it.
    expect(cardDefinitionPattern("ReviewGateCard").test("const reviewGateCardRef = x;")).toBe(false);
  });
});

describe("R2 — each retired parallel renderer is banned by name", () => {
  for (const parallel of RETIRED_PARALLELS) {
    it(`flags '${parallel.id}' coming back`, () => {
      const sample = {
        "review-redirect-card": "return <ArtifactReviewRedirectCard gate={g} />;",
        "direct-chip-row-mount": "return <RunRecommendationChipRow runId={id} />;",
        "page-direct-decision-composition": "return <ReviewDecisionBar action={a} />;",
        "page-direct-verification-composition":
          'return <div data-verification-chrome="Core analysis">Core analysis</div>;',
      }[parallel.id];
      expect(sample, `no fixture for '${parallel.id}'`).toBeTypeOf("string");
      const hits = scanModule("src/app/new-surface/page.tsx", sample);
      expect(hits.map((h) => h.rule)).toContain("R2");
      expect(hits.find((h) => h.rule === "R2").detail).toContain(parallel.id);
    });
  }

  it("FALSE-POSITIVE CONTROL: prose in a comment about a retired renderer is clean", () => {
    const src = [
      "// The ArtifactReviewRedirectCard was deleted by S2; nothing renders it.",
      "/* A host must not mount <RunRecommendationChipRow> directly. */",
      "export const NOTE = 1;",
    ].join("\n");
    expect(scanModule("src/app/some/module.ts", src)).toEqual([]);
  });

  it("the allowlisted composer really does mount the row — the exception is not vacuous", () => {
    const owner = read("packages/agents/src/run-recommendation-chip-row.tsx");
    expect(owner).toMatch(/<\s*RunRecommendationChipRow\b/);
  });

  // THE DISTINCTION THIS RULE KEEPS, pinned after cinatra#3160 hit it: a HARNESS
  // is not an exemption. A design-fixture module that declares the host and then
  // draws the row itself is the same second renderer as a page that does — it
  // hands the row a reading the card would have RESOLVED, so the two can
  // disagree, and a harness that draws its own reading is asserting the harness.
  // The three cases below pin the whole distinction: the host declaration buys
  // nothing, the CARD is the way through, and the allowlist stays the owner's
  // definition module alone.
  it("a DESIGN-FIXTURE mount is NOT an exemption: declaring the host does not license the row", () => {
    const src = [
      '<LifecycleCardSurfaceProvider host="chat_thread">',
      "  <RunRecommendationChipRow runId={id} initialRecommendations={fixture} />",
      "</LifecycleCardSurfaceProvider>",
    ].join("\n");
    const hits = scanModule(
      "src/app/design-fixtures/conformance/lifecycle-recommendation-fixtures.tsx",
      src,
    );
    expect(hits.map((h) => h.rule)).toContain("R2");
    expect(hits.find((h) => h.rule === "R2").detail).toContain("direct-chip-row-mount");
  });

  it("…and the way through is the CARD, on that same harness path", () => {
    const src = [
      '<LifecycleCardSurfaceProvider host="chat_thread">',
      "  <RecommendationHoldCard runId={id} />",
      "</LifecycleCardSurfaceProvider>",
    ].join("\n");
    const hits = scanModule(
      "src/app/design-fixtures/conformance/lifecycle-recommendation-fixtures.tsx",
      src,
    );
    expect(hits.filter((h) => h.rule === "R2")).toEqual([]);
  });

  it("the row's allowlist is the OWNER module and nothing else — no harness may join it", () => {
    const entry = RETIRED_PARALLELS.find((p) => p.id === "direct-chip-row-mount");
    expect(entry.allow).toEqual(["packages/agents/src/run-recommendation-chip-row.tsx"]);
  });
});

describe("R3 — a card mount must be host-declared", () => {
  it("flags a mount with no provider in the file", () => {
    const hits = scanModule("src/app/x/page.tsx", "return <ReviewGateCard view={v} />;");
    expect(hits.map((h) => h.rule)).toContain("R3");
  });

  it("is clean when the file declares the host itself", () => {
    const src =
      '<LifecycleCardSurfaceProvider host="page_gate_region"><ReviewGateCard view={v} /></LifecycleCardSurfaceProvider>';
    expect(scanModule("src/app/x/page.tsx", src).filter((h) => h.rule === "R3")).toEqual([]);
  });

  it("the parent-provided exceptions are real: each named parent declares a host", () => {
    const parents = new Set(
      Object.values(HOST_PROVIDED_BY_PARENT).map((v) => v.split(" ")[0]),
    );
    expect(parents.size).toBeGreaterThan(0);
    for (const parent of parents) {
      expect(read(parent), parent).toMatch(/<\s*LifecycleCardSurfaceProvider\b/);
    }
  });
});

describe("R4 — one registry row per data-part kind", () => {
  it("flags a duplicated mapping", () => {
    const src = [
      "const M = {",
      "  artifact_review_gate: ReviewGateCard,",
      "  artifact_review_gate: OtherCard,",
      "  verification_summary: LifecycleCard,",
      "  trigger_schedule_proposal: ScheduleProposalCard,",
      "};",
    ].join("\n");
    const hits = scanRegistry(src);
    expect(hits.map((h) => h.detail).join(" ")).toMatch(/artifact_review_gate' 2 time/);
  });

  it("flags a MISSING mapping just as loudly as a duplicate", () => {
    const hits = scanRegistry("const M = { verification_summary: X, trigger_schedule_proposal: Y };");
    expect(hits.map((h) => h.detail).join(" ")).toMatch(/artifact_review_gate' 0 time/);
  });

  it("the real registry maps each data-part kind exactly once", () => {
    expect(scanRegistry(read(REGISTRY_MODULE))).toEqual([]);
    // …and the interrupt-carried kind is deliberately NOT there.
    expect(REGISTRY_KINDS).not.toContain("recommendation_hold");
  });

  it("flags a row that still counts as ONE but dispatches to the wrong component", () => {
    // cinatra#2861: counting `kind:` occurrences left the rule half-blind.
    // Reverting the drawn verification card to the S1 shell keeps the count at
    // exactly one and used to sail through — silently un-retiring the shell for
    // a kind the epic has DRAWN. The right-hand side is checked against
    // CARD_OWNERS, the same table R1 enforces ownership with.
    const hits = scanRegistry(
      [
        "const M = {",
        "  artifact_review_gate: ReviewGateCard,",
        "  verification_summary: LifecycleCard,",
        "  trigger_schedule_proposal: ScheduleProposalCard,",
        "};",
      ].join("\n"),
    );
    expect(hits.map((h) => h.rule)).toEqual(["R4"]);
    expect(hits[0].detail).toMatch(/dispatches 'verification_summary' to 'LifecycleCard'/);
    expect(hits[0].detail).toContain(CARD_OWNERS.verification_summary.component);
  });

  it("flags a right-hand side it cannot read rather than trusting it", () => {
    // Fail-closed: an expression in the dispatch slot is not a bare owner
    // identifier, so the gate reports it instead of letting it through.
    const hits = scanRegistry(
      [
        "const M = {",
        "  artifact_review_gate: ReviewGateCard,",
        "  verification_summary: pick(kind),",
        "  trigger_schedule_proposal: ScheduleProposalCard,",
        "};",
      ].join("\n"),
    );
    expect(hits.map((h) => h.rule)).toEqual(["R4"]);
    expect(hits[0].detail).toMatch(/verification_summary/);
  });

  // REGRESSION (cinatra#2861, both cuts found by this reconciliation's Codex
  // rounds). The rule shipped two fail-OPENS of the same shape: it read only the
  // FRONT of the value, and the expected component name was sitting there.
  //   · cut 1 captured a LEADING identifier, so `Owner(kind)` passed.
  //   · cut 2 ended the capture at a NEWLINE, so the same call split across two
  //     lines passed — a newline does not end a JavaScript value.
  // `pick(kind)` above caught neither, because `pick` is not the owner's name:
  // the fail-closed claim had never been tested against an expression that
  // STARTS with the right word. Every shape below does.
  it("fails CLOSED on an expression that merely BEGINS with the owner's name", () => {
    const owner = CARD_OWNERS.verification_summary.component;
    const shapes = [
      `${owner}(kind)`,
      // The multiline continuation — cut 2's bypass, pinned by fixture.
      `${owner}\n    (kind)`,
      `${owner}\n    .Inner`,
      `x.${owner}`,
      `() => ${owner}`,
      `cond ? ${owner} : Other`,
    ];
    for (const rhs of shapes) {
      const hits = scanRegistry(
        [
          "const M = {",
          "  artifact_review_gate: ReviewGateCard,",
          `  verification_summary: ${rhs},`,
          "  trigger_schedule_proposal: ScheduleProposalCard,",
          "};",
        ].join("\n"),
      );
      expect(hits.map((h) => h.rule), JSON.stringify(rhs)).toEqual(["R4"]);
      expect(hits[0].detail, JSON.stringify(rhs)).toMatch(/an expression this gate cannot read/);
    }
  });

  it("still accepts the one legal shape — a bare imported identifier", () => {
    const hits = scanRegistry(
      [
        "const M = {",
        "  artifact_review_gate: ReviewGateCard,",
        `  verification_summary: ${CARD_OWNERS.verification_summary.component},`,
        "  trigger_schedule_proposal: ScheduleProposalCard,",
        "};",
      ].join("\n"),
    );
    expect(hits).toEqual([]);
  });
});

/**
 * §VII's ONE RENDERER, as a structural property of the tree (cinatra#2789,
 * epic #2784 S9e).
 *
 * R1 keys on a component NAME, which a look-alike can simply not use. The
 * verification card is therefore ALSO pinned by its drawing: the anchors §VII's
 * core carries may be emitted by exactly one module, that module must emit all
 * of them, and the review page — the one surface that used to draw them itself
 * — must mount the card instead of re-emitting any.
 */
describe("§VII — one renderer, pinned on the drawing's own anchors", () => {
  const OWNER = CARD_OWNERS.verification_summary.owner;
  const VERIFICATION_VIEW = [
    "src/app/agents/[vendor]/[packageName]/[instanceId]/review",
    "[reviewTaskId]/verification-view.tsx",
  ].join("/");

  // The anchor list is PINNED as a set, not just iterated. Every other
  // assertion in this block loops over `VERIFICATION_CORE_ANCHORS`, so dropping
  // an entry would silently shrink what they check rather than fail anything —
  // which is how `revisions` sat outside the ban until cinatra#2861 restored
  // it. This is the one assertion a deletion cannot pass through.
  //
  // `authorized-scope` is NOT among them, and that is the other direction of
  // the same discipline (cinatra#2861): §VII draws five regions, and the plan's
  // binding correction puts the authorization in the card's copy and its
  // before/after columns rather than in a region of its own. An anchor for a
  // region the spec does not draw would make the ban certify a drawing outside
  // the closed set.
  it("pins §VII's core to FIVE anchors — dropping one is a hole, adding one is a region", () => {
    expect([...VERIFICATION_CORE_ANCHORS].sort()).toEqual([
      "advisory",
      "chrome",
      "field-diff",
      "outcome",
      "revisions",
    ]);
    expect(VERIFICATION_CORE_ANCHORS).not.toContain("authorized-scope");
  });

  it("NO module in the tree draws an authorized-scope region — §VII has none", () => {
    // The region the round asked to be removed, pinned as absent from the whole
    // first-party tree rather than just from the card: it is not a parallel
    // drawing to be banned, it is a region the spec does not have.
    const emitters = collectFiles().filter((rel) =>
      read(rel).includes("data-verification-authorized-scope"),
    );
    expect(emitters).toEqual([]);
  });

  it("the owner module emits EVERY §VII anchor — the ban is not vacuous", () => {
    const src = read(OWNER);
    for (const anchor of VERIFICATION_CORE_ANCHORS) {
      expect(
        src.includes(`data-verification-${anchor}`),
        `${OWNER} no longer emits data-verification-${anchor}`,
      ).toBe(true);
    }
  });

  it("NO other module in the tree emits a §VII anchor", () => {
    const emitters = collectFiles()
      .filter((rel) =>
        VERIFICATION_CORE_ANCHORS.some((a) => read(rel).includes(`data-verification-${a}`)),
      );
    expect(emitters).toEqual([OWNER]);
  });

  it("the review page MOUNTS the card and draws none of the core itself", () => {
    const src = read(VERIFICATION_VIEW);
    // It composes the one renderer…
    expect(src).toMatch(/<\s*VerificationSummaryCard\b/);
    // …under its own host declaration (R3's per-file rule)…
    expect(src).toMatch(/<\s*LifecycleCardSurfaceProvider\b/);
    // …and emits no §VII anchor of its own.
    for (const anchor of VERIFICATION_CORE_ANCHORS) {
      expect(src.includes(`data-verification-${anchor}`)).toBe(false);
    }
    // The page-only ADJUNCT survives — deleting it was never the ask.
    expect(src).toMatch(/<\s*ReviewPinnedCapture\b/);
    // …but the "Back to the review gate" link does NOT: plan §8.3(5) and §8.4
    // say it exists only because the reading lived on its own page, so it goes
    // when the card lands (cinatra#2861). Pinned here as well as in the view's
    // own suite, because this is the file the gate reads.
    expect(src).not.toContain("data-verification-back-to-gate");
    expect(src).not.toContain("Back to the review gate");
  });

  it("a second §VII drawing anywhere is an R2 violation, whatever it is called", () => {
    for (const anchor of VERIFICATION_CORE_ANCHORS) {
      const hits = scanModule(
        "src/app/some/new/surface.tsx",
        `return <div data-verification-${anchor}="">x</div>;`,
      );
      expect(hits.map((h) => h.rule), anchor).toContain("R2");
    }
  });

  // Named explicitly, NOT via the loop above, so this mutation check survives
  // the anchor being dropped from the list again: the revision pins are §VII
  // core (the page's own ruling now names exactly ONE adjunct, the pinned
  // VISUAL pair), so a second module drawing them must fail R2.
  it("a second emitter of the REVISION PINS fails R2 — they are core, not an adjunct", () => {
    const hits = scanModule(
      "src/app/agents/[vendor]/[packageName]/[instanceId]/review/revision-pins.tsx",
      'return <div data-verification-revisions="">{a} → {b}</div>;',
    );
    expect(hits.map((h) => h.rule)).toContain("R2");
    expect(hits.map((h) => h.detail).join(" ")).toMatch(/page-direct-verification-composition/);
  });

  it("the pinned VISUAL pair is NOT an anchor — the page may keep its one adjunct", () => {
    // The adjunct that stayed. It is not part of §VII's drawing, so composing
    // it around the card must not read as a second renderer.
    const hits = scanModule(VERIFICATION_VIEW, "return <ReviewPinnedCapture pair={pair} />;");
    expect(hits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The completeness rules — R5 to R9
// ---------------------------------------------------------------------------
//
// These are the rules that answer "is there ONE?" rather than "is there more
// than one?". Every fixture below is a way a kind could LOOK owned while
// drawing nothing, because that is precisely how the previous round passed with
// two undrawn cards.

/** A proper owner: it reads its validated body, and it draws its anchors. */
const PROPER_OWNER = [
  "export function ProperCard({ view }: { view: CardView }) {",
  "  const state = useCardState({ ref: view.ref });",
  "  if (state === null) return null;",
  "  return (",
  '    <div data-conformance-id="proper-card" data-lifecycle-card="fixture"',
  '      data-lifecycle-card-host={host} data-lifecycle-card-state={state.state}>',
  "      {state.title}",
  '      <div data-conformance-id="proper-floor">{state.actions}</div>',
  "    </div>",
  "  );",
  "}",
].join("\n");

const PROPER_CONTRACT = {
  status: "DRAWN",
  design: "§X (a fixture)",
  component: "ProperCard",
  wireCarriage: "data_part",
  owner: "packages/fixture/proper-card.tsx",
  composes: [],
  body: { validator: "useCardState", params: ["view"], fields: ["state", "title", "actions"] },
  anchors: ["proper-card", "proper-floor", '[data-lifecycle-card="fixture"]'],
  hosts: {
    chat_thread: [{ module: "packages/fixture/registry.tsx", adapter: "registry", region: "transcript", surface: "production", why: "the fixture transcript dispatch, named here" }],
    site_widget: null,
    run_card: [{ module: "packages/fixture/panel.tsx", adapter: "mount", region: "run_panel", surface: "production", why: "the fixture run card, named here so a second one is visible" }],
    page_gate_region: null,
  },
  hostGap: "The fixture declares two hosts only; the other two are out of the fixture's scope on purpose.",
  renderedProof: { file: "packages/fixture/__tests__/proper-card.test.tsx", testName: "draws" },
};

/** Two adapters on one host, with the picker that makes them exclusive. */
const TWO_ADAPTER_CONTRACT = {
  ...PROPER_CONTRACT,
  hosts: {
    ...PROPER_CONTRACT.hosts,
    run_card: [
      { module: "packages/fixture/panel.tsx", adapter: "mount", region: "run_panel", surface: "production", why: "the leaf-run panel branch of this host" },
      { module: "packages/fixture/screen.tsx", adapter: "mount", region: "run_panel", surface: "production", why: "the stepped-run screen branch of the same host" },
    ],
  },
  exclusions: {
    run_card: {
      selector: "pickPanel",
      module: "packages/fixture/screen.tsx",
      proof: { file: "packages/fixture/__tests__/pick.test.ts", testName: "covers every branch" },
    },
  },
};

const own = (source) => ({ [PROPER_CONTRACT.owner]: source });

describe("R5 — every kind has ONE named owner, and a placeholder says so", () => {
  it("the real contract covers exactly the protocol's closed set of kinds", () => {
    expect(Object.keys(LIFECYCLE_CARD_CONTRACTS).sort()).toEqual([...LIFECYCLE_CARD_KINDS].sort());
    // …and the mirrored list really is the protocol's list, which is the only
    // thing that keeps a fifth kind from being added there and forgotten here.
    const protocolSource = read(
      "packages/agent-ui-protocol/src/renderable-views/lifecycle-cards.ts",
    );
    const block = /export const LIFECYCLE_CARD_KINDS = \[([\s\S]*?)\] as const;/.exec(protocolSource);
    expect(block, "the protocol no longer declares LIFECYCLE_CARD_KINDS").not.toBeNull();
    const declared = [...block[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(declared.sort()).toEqual([...LIFECYCLE_CARD_KINDS].sort());
  });

  it("the typed-INTERRUPT recommendation kind is covered — a DATA_PART-keyed rule would miss it", () => {
    expect(LIFECYCLE_CARD_CONTRACTS.recommendation_hold.status).toBe("DRAWN");
    expect(LIFECYCLE_CARD_CONTRACTS.recommendation_hold.owner).toBeTruthy();
    expect(REGISTRY_KINDS).not.toContain("recommendation_hold");
  });

  it("REJECTS one component serving two kinds — the exact shape that passed before", () => {
    const shared = { ...PROPER_CONTRACT, status: "PLACEHOLDER", owner: null, gap: "x".repeat(60) };
    const hits = auditContracts({ a: PROPER_CONTRACT, b: shared });
    expect(hits.map((h) => h.detail).join(" ")).toMatch(/both name ProperCard/);
  });

  it("REJECTS a placeholder row that claims an owner", () => {
    const lying = { ...PROPER_CONTRACT, status: "PLACEHOLDER", gap: "x".repeat(60) };
    const hits = auditContracts({ trigger_schedule_proposal: lying });
    expect(hits.map((h) => h.detail).join(" ")).toMatch(/may not claim an owner/);
  });

  it("REJECTS a placeholder row with no sentence saying what is absent", () => {
    const silent = { ...PROPER_CONTRACT, status: "PLACEHOLDER", owner: null, gap: "todo" };
    const hits = auditContracts({ verification_summary: silent });
    expect(hits.map((h) => h.detail).join(" ")).toMatch(/must say what is absent/);
  });

  it("REJECTS a DRAWN row pointing at the S1 shell — the placeholder-as-owner trick", () => {
    const shell = {
      ...PROPER_CONTRACT,
      component: "LifecycleCard",
      owner: "packages/chat/src/renderable-views/lifecycle-card.tsx",
    };
    const hits = auditContracts({ verification_summary: shell });
    expect(hits.map((h) => h.detail).join(" ")).toMatch(/pointing at the S1 shell/);
  });

  it("the placeholder claim must be true the OTHER way too — a drawn card with a stale row fails", () => {
    const placeholder = {
      ...PROPER_CONTRACT,
      status: "PLACEHOLDER",
      owner: null,
      gap: "The card is not drawn; the registry still dispatches this kind to the shell.",
    };
    const files = ["packages/fixture/proper-card.tsx"];
    const sources = { "/repo/packages/fixture/proper-card.tsx": PROPER_OWNER };
    const hits = collectContractViolations({
      contracts: { trigger_schedule_proposal: placeholder },
      files,
      repoRoot: "/repo",
      readFileImpl: (p) => sources[p] ?? "",
    });
    expect(hits.map((h) => h.detail).join(" ")).toMatch(/flip the row, or delete the component/);
  });
});

describe("R6 — the owner consumes its authorized body", () => {
  it("PASSES a proper owner", () => {
    expect(scanOwnerModule("fixture", PROPER_CONTRACT, own(PROPER_OWNER))).toEqual([]);
  });

  it("REJECTS an UNUSED body parameter — the card would draw what nobody authorized", () => {
    const source = PROPER_OWNER.replace("useCardState({ ref: view.ref })", "useCardState({ ref: RUN_ID })");
    const hits = scanOwnerModule("fixture", PROPER_CONTRACT, own(source));
    expect(hits.map((h) => h.detail).join(" ")).toMatch(/body parameter 'view' and never reads it/);
  });

  it("REJECTS an owner that never validates the body it draws", () => {
    const source = PROPER_OWNER.replace(/useCardState/g, "JSON.parse");
    const hits = scanOwnerModule("fixture", PROPER_CONTRACT, own(source));
    expect(hits.map((h) => h.detail).join(" ")).toMatch(/never reads its authorized body through useCardState/);
  });

  it("REJECTS an owner that ignores a required body field", () => {
    const source = PROPER_OWNER.replace("{state.title}", "{\"a fixed string\"}");
    const hits = scanOwnerModule("fixture", PROPER_CONTRACT, own(source));
    expect(hits.map((h) => h.detail).join(" ")).toMatch(/body field 'title' is never consumed/);
  });
});

describe("R6 — a retired reading leaves the authorized list, and stays on the wire (cinatra#3174)", () => {
  // WHY THIS PAIR EXISTS. Fix leg 1 stopped keying any reading on `released`:
  // it marks the side-effect gate OPENING, not the firing, and §VI's five
  // readings — first shown, configured, expired, fired one-off, fired
  // recurring — are keyed on the phase and on whether the schedule has fired,
  // never on the gate. §VI is explicit that nothing else may stand in for a
  // reading ("No summary box is ever drawn, no status label, and nothing
  // stands between the reader and the form — the rows are the reading"), so the
  // status label that was the field's last reader is gone and no drawn reading
  // replaces it. An authorized body field is a field a drawing reads, so it
  // leaves the list — exactly the road `canRelease` took when the same section
  // withdrew Run now (cinatra#2972).
  //
  // The two tests below are the two ways that retirement could become a lie.
  // Delisting is honest only while the card really has stopped reading the
  // field, and only while the producer really goes on SENDING it: a stale
  // bundle's own copy of the settled schema declares `released` a REQUIRED key
  // and fails the parse without it, so dropping the emission would blank every
  // settled schedule card on such a tab — a wider harm than one dead boolean on the wire, and the
  // reason the pruning is a wire change with its own version story rather than
  // part of this leg.
  const SCHEDULE = LIFECYCLE_CARD_CONTRACTS.trigger_schedule_proposal;

  it("'released' is NOT an authorized body field — no §VI reading is keyed on the gate opening", () => {
    expect(SCHEDULE.body.fields).not.toContain("released");
  });

  it("it is delisted because the card REALLY stopped reading it — put it back and R6 fires", () => {
    // The matcher is the gate's own, over the live owner module, so this cannot
    // pass by agreeing with a list. If a reading ever comes back, this test
    // goes green-the-wrong-way and the field has to rejoin the list with it.
    const restored = {
      ...SCHEDULE,
      body: { ...SCHEDULE.body, fields: [...SCHEDULE.body.fields, "released"] },
    };
    const hits = scanOwnerModule("trigger_schedule_proposal", restored, {
      [SCHEDULE.owner]: read(SCHEDULE.owner),
    });
    expect(hits.map((h) => h.detail).join(" ")).toMatch(
      /body field 'released' is never consumed/,
    );
  });

  it("the producer still SENDS it — a retired reading may not blank a stale tab", () => {
    expect(
      read("packages/agent-ui-protocol/src/renderable-views/trigger-schedule-proposal-view.ts"),
    ).toMatch(/\n\s*released: z\.boolean\(\),/);
    expect(read("src/lib/lifecycle/trigger-schedule-proposal-card.ts")).toMatch(
      /\n\s*released: resolved\.released,/,
    );
  });
});

describe("R7 — the owner emits its ratified anchors, from code that runs", () => {
  it("REJECTS an EMPTY STUB owner", () => {
    const hits = scanOwnerModule("fixture", PROPER_CONTRACT, own("export function ProperCard() {}"));
    expect(hits.map((h) => h.rule)).toContain("R7");
  });

  it("REJECTS an owner that only ever returns null", () => {
    const source = [
      "export function ProperCard({ view }: { view: CardView }) {",
      "  const state = useCardState({ ref: view.ref });",
      "  void state.title; void state.actions; void state.state;",
      "  return null;",
      "}",
    ].join("\n");
    const hits = scanOwnerModule("fixture", PROPER_CONTRACT, own(source));
    expect(hits.map((h) => h.detail).join(" ")).toMatch(/never returns drawn DOM/);
  });

  it("REJECTS an anchor that only exists in a branch which can never run", () => {
    const source = PROPER_OWNER.replace(
      '<div data-conformance-id="proper-floor">{state.actions}</div>',
      '{false && (<div data-conformance-id="proper-floor">{state.actions}</div>)}',
    );
    const hits = scanOwnerModule("fixture", PROPER_CONTRACT, own(source));
    expect(hits.map((h) => h.detail).join(" ")).toMatch(
      /anchor 'proper-floor' is emitted only from a branch that can never run/,
    );
  });

  it("REJECTS a missing anchor outright", () => {
    const source = PROPER_OWNER.replace('data-conformance-id="proper-floor"', 'className="floor"');
    const hits = scanOwnerModule("fixture", PROPER_CONTRACT, own(source));
    expect(hits.map((h) => h.detail).join(" ")).toMatch(/ratified anchor 'proper-floor' is never emitted/);
  });

  it("the dead-branch stripper removes only what can never run", () => {
    expect(stripUnreachable('if (false) { a("x"); } b();')).toBe(" b();");
    expect(stripUnreachable("if (ready) { a(); } b();")).toBe("if (ready) { a(); } b();");
    // A brace inside a string does not end the block early.
    expect(stripUnreachable('if (false) { a("}"); } b();')).toBe(" b();");
  });

  it("reads a component body out of both declaration forms", () => {
    expect(extractComponentBody("export function A(p) { return 1; }", "A")).toContain("return 1;");
    expect(extractComponentBody("const A = (p) => { return 2; };", "A")).toContain("return 2;");
    expect(extractComponentBody("export function B() {}", "A")).toBeNull();
  });

  it("an anchor match is EXACT — a longer id that starts the same does not count", () => {
    expect(emitsAnchor('<i data-conformance-id="proper-card-skeleton" />', "proper-card")).toBe(false);
    expect(emitsAnchor('<i data-conformance-id="proper-card" />', "proper-card")).toBe(true);
  });

  it("every DRAWN kind names a rendered owner test that reads its anchors back", () => {
    for (const [kind, c] of Object.entries(LIFECYCLE_CARD_CONTRACTS)) {
      if (c.status !== "DRAWN") continue;
      const proof = read(c.renderedProof.file);
      expect(proof, `${kind}: the rendered owner test is gone`).toContain(c.renderedProof.testName);
      const open = openRequirements(c);
      for (const anchor of c.anchors) {
        // An anchor the contract records as an OPEN OBLIGATION is not emitted
        // yet, so no rendered test can read it back. The done-check carries it.
        if (open.has(anchor)) continue;
        expect(
          proofAssertsAnchor(proof, anchor),
          `${kind}: ${anchor} is never read back in the rendered test`,
        ).toBe(true);
      }
    }
  });

  it("a rendered proof may assert an anchor as a selector OR as rendered markup", () => {
    expect(proofAssertsAnchor('querySelector(\'[data-action="skip-x"]\')', '[data-action="skip-x"]')).toBe(true);
    expect(proofAssertsAnchor('toContain(\'data-action="skip-x"\')', '[data-action="skip-x"]')).toBe(true);
    expect(proofAssertsAnchor("it('renders')", '[data-action="skip-x"]')).toBe(false);
  });

  it("THE LIMIT: the anchor rule is lexical, and the GATE hands it only live text", () => {
    // Two readings, both recorded rather than assumed. On its own the rule is a
    // substring match, so raw text with the anchor in a comment satisfies it…
    const commentOnly = "it('renders', () => { /* [data-action=\"skip-x\"] is drawn elsewhere */ });";
    expect(proofAssertsAnchor(commentOnly, '[data-action="skip-x"]')).toBe(true);
    // …but the gate never hands it raw text. The window comes from
    // `extractTestBlock`, which searches and slices a comment-stripped copy, so
    // the commented anchor is gone before the rule ever sees it.
    expect(
      proofAssertsAnchor(extractTestBlock(commentOnly, "renders"), '[data-action="skip-x"]'),
    ).toBe(false);
    // What the strip cannot reach is an anchor named in a live string nothing
    // renders. That is why this rule is never the proof on its own: the same
    // named test is EXECUTED by vitest, and there the anchor must come back off
    // real DOM.
    const deadString = "it('renders', () => { const unused = '[data-action=\"skip-x\"]'; });";
    expect(
      proofAssertsAnchor(extractTestBlock(deadString, "renders"), '[data-action="skip-x"]'),
    ).toBe(true);
    // …and the fence that IS load-bearing still holds: a body that does not name
    // the anchor at all fails, however much the rest of the file names it.
    expect(proofAssertsAnchor("it('renders', () => { expect(1).toBe(1); });", '[data-action="skip-x"]')).toBe(false);
  });
});

describe("R8 — one declared mount set per host", () => {
  const registry = ["const M = {", "  fixture: ProperCard,", "};"].join("\n");

  it("PASSES the declared set", () => {
    const hits = scanHostMounts("fixture", PROPER_CONTRACT, ["packages/fixture/panel.tsx"], registry);
    expect(hits).toEqual([]);
  });

  it("REJECTS an UNENUMERATED callsite — a second rendered instance nobody chose", () => {
    const hits = scanHostMounts(
      "fixture",
      PROPER_CONTRACT,
      ["packages/fixture/panel.tsx", "packages/fixture/second-panel.tsx"],
      registry,
    );
    expect(hits.map((h) => h.detail).join(" ")).toMatch(/not an enumerated adapter/);
  });

  it("PASSES two adapters on one host when a proven picker chooses between them", () => {
    const sources = {
      "packages/fixture/screen.tsx": "export function pickPanel(x) { return 'leaf'; }",
      // The picker's proof has a BODY. The gate extracts this named test and
      // requires an assertion inside it, so the fixture that passes must be a
      // test that actually runs one.
      "packages/fixture/__tests__/pick.test.ts":
        "it('covers every branch', () => { expect(pickPanel('leaf')).toBe('leaf'); });",
    };
    const hits = scanHostMounts(
      "fixture",
      TWO_ADAPTER_CONTRACT,
      ["packages/fixture/panel.tsx", "packages/fixture/screen.tsx"],
      registry,
      (rel) => sources[rel] ?? null,
    );
    expect(hits).toEqual([]);
  });

  it("REJECTS an EMPTY exclusion proof — a test named after the picker that asserts nothing", () => {
    // The exact shape that passed before: the file contains the test name, so a
    // file-wide substring match was satisfied by a test with no body at all.
    const sources = {
      "packages/fixture/screen.tsx": "export function pickPanel(x) { return 'leaf'; }",
      "packages/fixture/__tests__/pick.test.ts": "it('covers every branch', () => {});",
    };
    const hits = scanHostMounts(
      "fixture",
      TWO_ADAPTER_CONTRACT,
      ["packages/fixture/panel.tsx", "packages/fixture/screen.tsx"],
      registry,
      (rel) => sources[rel] ?? null,
    );
    expect(hits.map((h) => h.detail).join(" ")).toMatch(/no live expectation that reads/);
  });

  it("REJECTS an exclusion proof whose only assertion is COMMENTED OUT", () => {
    // The lexical limit stated as a rule: comments are stripped before the
    // assertion is looked for, so a proof cannot be restored by describing one.
    const sources = {
      "packages/fixture/screen.tsx": "export function pickPanel(x) { return 'leaf'; }",
      "packages/fixture/__tests__/pick.test.ts":
        "it('covers every branch', () => { /* expect(pickPanel('leaf')).toBe('leaf'); */ });",
    };
    const hits = scanHostMounts(
      "fixture",
      TWO_ADAPTER_CONTRACT,
      ["packages/fixture/panel.tsx", "packages/fixture/screen.tsx"],
      registry,
      (rel) => sources[rel] ?? null,
    );
    expect(hits.map((h) => h.detail).join(" ")).toMatch(/no live expectation that reads/);
  });

  it("REJECTS an exclusion proof that borrows a NEIGHBOURING test's assertions", () => {
    // The named test is extracted, so assertions that live elsewhere in the
    // same file are not the named test's assertions.
    const sources = {
      "packages/fixture/screen.tsx": "export function pickPanel(x) { return 'leaf'; }",
      "packages/fixture/__tests__/pick.test.ts": [
        "it('some other case', () => { expect(pickPanel('stepped')).toBe('screen'); });",
        "it('covers every branch', () => {});",
      ].join("\n"),
    };
    const hits = scanHostMounts(
      "fixture",
      TWO_ADAPTER_CONTRACT,
      ["packages/fixture/panel.tsx", "packages/fixture/screen.tsx"],
      registry,
      (rel) => sources[rel] ?? null,
    );
    expect(hits.map((h) => h.detail).join(" ")).toMatch(/no live expectation that reads/);
  });

  it("REJECTS an exclusion proof whose only assertion is VACUOUS", () => {
    // `expect(true).toBe(true)` runs, passes and reads nothing. It satisfied the
    // old "asserts anything" rule, so two production adapters could be declared
    // exclusive by a test that touches no picker at all.
    const sources = {
      "packages/fixture/screen.tsx": "export function pickPanel(x) { return 'leaf'; }",
      "packages/fixture/__tests__/pick.test.ts":
        "it('covers every branch', () => { expect(true).toBe(true); });",
    };
    const hits = scanHostMounts(
      "fixture",
      TWO_ADAPTER_CONTRACT,
      ["packages/fixture/panel.tsx", "packages/fixture/screen.tsx"],
      registry,
      (rel) => sources[rel] ?? null,
    );
    expect(hits.map((h) => h.detail).join(" ")).toMatch(/no live expectation that reads/);
  });

  it("REJECTS an exclusion proof that asserts about ANOTHER function", () => {
    // The live shape this round found: the row named one picker and cited the
    // totality proof of a different one. Every assertion in the block runs and
    // passes; none of them reads the picker the row is claiming.
    const sources = {
      "packages/fixture/screen.tsx": "export function pickPanel(x) { return 'leaf'; }",
      "packages/fixture/__tests__/pick.test.ts":
        "it('covers every branch', () => { expect(screenHostsCard('leaf')).toBe(true); });",
    };
    const hits = scanHostMounts(
      "fixture",
      TWO_ADAPTER_CONTRACT,
      ["packages/fixture/panel.tsx", "packages/fixture/screen.tsx"],
      registry,
      (rel) => sources[rel] ?? null,
    );
    expect(hits.map((h) => h.detail).join(" ")).toMatch(/no live expectation that reads/);
  });

  it("REJECTS an exclusion proof whose assertion can never RUN", () => {
    const sources = {
      "packages/fixture/screen.tsx": "export function pickPanel(x) { return 'leaf'; }",
      "packages/fixture/__tests__/pick.test.ts":
        "it('covers every branch', () => { if (false) { expect(pickPanel('leaf')).toBe('leaf'); } });",
    };
    const hits = scanHostMounts(
      "fixture",
      TWO_ADAPTER_CONTRACT,
      ["packages/fixture/panel.tsx", "packages/fixture/screen.tsx"],
      registry,
      (rel) => sources[rel] ?? null,
    );
    expect(hits.map((h) => h.detail).join(" ")).toMatch(/no live expectation that reads/);
  });

  it("REJECTS two adapters on one host with NO named picker — two instances waiting to happen", () => {
    const noPicker = { ...TWO_ADAPTER_CONTRACT, exclusions: undefined };
    const hits = scanHostMounts(
      "fixture",
      noPicker,
      ["packages/fixture/panel.tsx", "packages/fixture/screen.tsx"],
      registry,
      () => null,
    );
    expect(hits.map((h) => h.detail).join(" ")).toMatch(/no named mutual-exclusion selector/);
  });

  it("REJECTS a picker that is not exported where the contract says it is", () => {
    const hits = scanHostMounts(
      "fixture",
      TWO_ADAPTER_CONTRACT,
      ["packages/fixture/panel.tsx", "packages/fixture/screen.tsx"],
      registry,
      (rel) => (rel.includes("__tests__") ? "it('covers every branch', () => {});" : "function pickPanel() {}"),
    );
    expect(hits.map((h) => h.detail).join(" ")).toMatch(/does not export the exclusion selector/);
  });

  it("REJECTS a picker whose proof test is gone — an unproven picker is an assumption", () => {
    const hits = scanHostMounts(
      "fixture",
      TWO_ADAPTER_CONTRACT,
      ["packages/fixture/panel.tsx", "packages/fixture/screen.tsx"],
      registry,
      (rel) => (rel.includes("__tests__") ? "it('something else', () => {});" : "export function pickPanel() {}"),
    );
    expect(hits.map((h) => h.detail).join(" ")).toMatch(/is not in packages\/fixture\/__tests__\/pick\.test\.ts/);
  });

  it("a DEV-PREVIEW adapter is enumerated and does not count as a production one", () => {
    const withPreview = {
      ...PROPER_CONTRACT,
      hosts: {
        ...PROPER_CONTRACT.hosts,
        run_card: [
          ...PROPER_CONTRACT.hosts.run_card,
          { module: "packages/fixture/dev-preview.tsx", adapter: "mount", region: "run_panel", surface: "dev_preview", why: "the dev preview row, which draws only inside an opened preview" },
        ],
      },
    };
    // Two adapters, but only ONE production adapter, so no picker is demanded…
    const hits = scanHostMounts(
      "fixture",
      withPreview,
      ["packages/fixture/panel.tsx", "packages/fixture/dev-preview.tsx"],
      registry,
      () => null,
    );
    expect(hits).toEqual([]);
    // …and it is still enumerated, so dropping it from the tree is a finding.
    const missing = scanHostMounts("fixture", withPreview, ["packages/fixture/panel.tsx"], registry, () => null);
    expect(missing.map((h) => h.detail).join(" ")).toMatch(/missing host adapter/);
  });

  it("REJECTS a MISSING host adapter — a declared module that stopped mounting", () => {
    const hits = scanHostMounts("fixture", PROPER_CONTRACT, [], registry);
    expect(hits.map((h) => h.detail).join(" ")).toMatch(/missing host adapter/);
  });

  it("REJECTS a registry-served host whose registry row points somewhere else", () => {
    const wrongRow = ["const M = {", "  fixture: LifecycleCard,", "};"].join("\n");
    const hits = scanHostMounts("fixture", PROPER_CONTRACT, ["packages/fixture/panel.tsx"], wrongRow);
    expect(hits.map((h) => h.detail).join(" ")).toMatch(/does not dispatch this kind to ProperCard/);
  });

  it("REJECTS an enumerated adapter that does not say what it is", () => {
    const vague = {
      ...PROPER_CONTRACT,
      hosts: {
        ...PROPER_CONTRACT.hosts,
        run_card: [{ module: "packages/fixture/panel.tsx", adapter: "mount", region: "run_panel", surface: "production", why: "" }],
      },
    };
    const hits = scanHostMounts("fixture", vague, ["packages/fixture/panel.tsx"], registry, () => null);
    expect(hits.map((h) => h.detail).join(" ")).toMatch(/does not say what it is/);
  });

  it("REJECTS an adapter that declares no surface", () => {
    const vague = {
      ...PROPER_CONTRACT,
      hosts: {
        ...PROPER_CONTRACT.hosts,
        run_card: [{ module: "packages/fixture/panel.tsx", adapter: "mount", region: "run_panel", why: "the fixture run card, named here" }],
      },
    };
    const hits = scanHostMounts("fixture", vague, ["packages/fixture/panel.tsx"], registry, () => null);
    expect(hits.map((h) => h.detail).join(" ")).toMatch(/declares no surface/);
  });

  it("every real host key is one of the protocol's four", () => {
    for (const c of Object.values(LIFECYCLE_CARD_CONTRACTS)) {
      expect(Object.keys(c.hosts).sort()).toEqual([...LIFECYCLE_CARD_HOSTS].sort());
    }
  });
});

// R9's RETIREMENT COMPLETED (cinatra#2789, reconciled onto S9a by cinatra#2861).
//
// S9a shipped R9 as a PENDING retirement: `VerificationView` banned by name, the
// two route modules allowlisted while the kind was a placeholder, and an expiry
// check that fired the moment the kind went DRAWN. The kind is now DRAWN, so the
// record and its expiry check are gone — that IS the mechanism working, not the
// rule being dropped.
//
// What replaced them is checked below: the ban now identifies the retired
// DRAWING by §VII's five region anchors instead of by an identifier, because
// `VerificationView` legitimately survives as the page's adjunct composition. So
// these tests pin the two properties that matter and that a name ban could never
// have proven — the route modules draw NONE of §VII any more, and the ban is not
// vacuous because the owner really emits every anchor it forbids elsewhere.
describe("R9 — the parallel core renderer is retired, and the ban outlived the record", () => {
  const ROUTE_MODULES = [
    "src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/verification-view.tsx",
    "src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/page.tsx",
  ];

  it("flags a NEW module drawing any §VII region, whatever it calls itself", () => {
    for (const anchor of VERIFICATION_CORE_ANCHORS) {
      const hits = scanModule(
        "src/app/somewhere/else/page.tsx",
        `return <div data-verification-${anchor}="">x</div>;`,
      );
      expect(hits.map((h) => h.rule), anchor).toContain("R2");
    }
  });

  it("the RETIREMENT really happened — neither route module draws a §VII region", () => {
    for (const rel of ROUTE_MODULES) {
      const src = read(rel);
      expect(src, rel).toBeTypeOf("string");
      expect(scanModule(rel, src), rel).toEqual([]);
      for (const anchor of VERIFICATION_CORE_ANCHORS) {
        expect(src.includes(`data-verification-${anchor}`), `${rel} still draws ${anchor}`).toBe(
          false,
        );
      }
    }
  });

  it("the route-module ALLOWLIST is empty — neither module is excepted any more", () => {
    const entry = RETIRED_PARALLELS.find((p) => p.id === "page-direct-verification-composition");
    expect(entry, "the §VII ban is gone entirely").toBeTypeOf("object");
    for (const rel of ROUTE_MODULES) expect(entry.allow, rel).not.toContain(rel);
    // What remains is the owner's own definition module, exactly as every other
    // entry in this table allows the module that defines the shipped thing.
    expect(entry.allow).toEqual([CARD_OWNERS.verification_summary.owner]);
  });

  it("the ban is NOT vacuous — the one owner really emits every anchor it forbids elsewhere", () => {
    const owner = read(CARD_OWNERS.verification_summary.owner);
    for (const anchor of VERIFICATION_CORE_ANCHORS) {
      expect(owner, anchor).toMatch(new RegExp(`data-verification-${anchor}\\b`));
    }
  });

  it("the page still mounts the ONE card — the retirement did not delete the reading", () => {
    const view = read(ROUTE_MODULES[0]);
    expect(view).toMatch(/<\s*VerificationSummaryCard\b/);
    expect(view).toMatch(/host="page_gate_region"/);
  });
});

// ---------------------------------------------------------------------------
// The RATIFIED contract, pinned
// ---------------------------------------------------------------------------
//
// The anchor sets are CLOSED. Pinning them here as literals is the point: a
// slice that finds an anchor inconvenient has to change this test on purpose,
// in a diff a reader can see, rather than quietly widening the set it must meet.

describe("the closed anchor sets are the ratified ones, verbatim", () => {
  const RATIFIED = {
    artifact_review_gate: [
      '[data-lifecycle-card="artifact_review_gate"]',
      "review-gate-card",
      "review-decision-bar",
      "review-decision-disabled",
    ],
    // The REDRAWN set (cinatra#2841): the decision affordances are per chip, and
    // scripts/audit/chat-hitl-anchor-contract.json ratifies these anchor names
    // for this owner. The row-level confirm/skip pair this table used to mirror
    // is not emitted on any host any more.
    recommendation_hold: [
      '[data-lifecycle-card="recommendation_hold"]',
      "[data-run-recommendation-chip-row]",
      '[data-conformance-id="run-chip-row"]',
      '[data-skill-action="confirm"]',
      '[data-skill-action="adjust"]',
      '[data-skill-action="skip"]',
    ],
    // ONE MEMBER JOINED when the plan added the control it names (cinatra#2788):
    // PLAN: Agents Lifecycle (A) §7.2 — "to change it you return to the card,
    // change the rows and press **Save changes**, which re-arms the trigger".
    // An armed card with no Save-changes control does not implement §7, so the
    // anchor set has to be able to say so. The other five are the placeholder's
    // verbatim; no `adjust` anchor was ever in the set, which is the one place
    // the placeholder was already right about the target.
    //
    // ONE MEMBER LEFT when the plan withdrew the control it named
    // (cinatra#2972): §7.2 as amended 2026-08-25 — "there is no Run now" — so
    // `[data-action="release-trigger-now"]` is gone from the ratified set. An
    // anchor no host may draw cannot be a requirement.
    trigger_schedule_proposal: [
      "schedule-option-rows",
      "schedule-proposal-floor",
      '[data-action="save-schedule-changes"]',
      '[data-action="cancel-trigger-schedule"]',
    ],
    // CORRECTED when the card landed (cinatra#2789, reconciled by
    // cinatra#2861), and the contract row says at length what may be corrected
    // and on whose authority — read it there. In short, and keeping the two
    // halves apart:
    //   · the REQUIREMENT is the drawing's. §VII names five regions in one
    //     sentence — "the Core analysis heading with its outcome pill, the scope
    //     sentence, the two revision pins, and the field-by-field before / after
    //     … It closes with Advisory comments." Five is checkable against
    //     design@92c1be7c §VII by anybody; the scope sentence is deliberately
    //     not among them, because §VII draws it as copy inside the chrome.
    //   · the NAMES are the repository's convention, because §VII gives those
    //     regions no ids of its own. They are NOT checkable against the drawing
    //     and this list does not claim they are.
    // What the placeholder pinned — `["verification-in-thread"]` — is neither:
    // it is the ARTBOARD id marking §VII's in-a-turn specimen, the same class of
    // id as `state-loading` and `review-target-in-thread`, neither of which this
    // table ratifies for the review card either.
    verification_summary: [
      "[data-verification-chrome]",
      "[data-verification-outcome]",
      "[data-verification-revisions]",
      "[data-verification-field-diff]",
      "[data-verification-advisory]",
    ],
  };

  for (const [kind, anchors] of Object.entries(RATIFIED)) {
    it(`'${kind}' requires exactly its ratified anchors`, () => {
      expect(LIFECYCLE_CARD_CONTRACTS[kind].anchors).toEqual(anchors);
    });
  }

  it("the ratified §VII set and the R2 ban read ONE list, from both ends", () => {
    expect(LIFECYCLE_CARD_CONTRACTS.verification_summary.anchors).toEqual(
      VERIFICATION_CORE_ANCHORS.map((a) => `[data-verification-${a}]`),
    );
  });

  // §VII's three outcomes are still required; they moved from three ids to the
  // VALUE of one anchor, because that is how the drawn card carries them —
  // `data-verification-outcome={body.outcome}` over a closed enum. "Exactly one
  // at a time" is then structural rather than a rule about three ids, and the
  // rendered suite drives all three. So there is no `anchorsOneOf` group left to
  // pin, and this test pins its ABSENCE so the removal cannot be silent.
  it("the outcome is one valued anchor, not a three-id one-of group", () => {
    expect(LIFECYCLE_CARD_CONTRACTS.verification_summary.anchorsOneOf).toBeUndefined();
    expect(LIFECYCLE_CARD_CONTRACTS.verification_summary.anchors).toContain(
      "[data-verification-outcome]",
    );
    const card = read(CARD_OWNERS.verification_summary.owner);
    expect(card).toMatch(/data-verification-outcome=\{body\.outcome\}/);
  });

  it("every owner root must carry its host and its state", () => {
    expect(REQUIRED_ROOT_ATTRIBUTES).toEqual([
      "data-lifecycle-card-host",
      "data-lifecycle-card-state",
    ]);
    const hits = scanOwnerModule(
      "fixture",
      PROPER_CONTRACT,
      own(PROPER_OWNER.replace("data-lifecycle-card-host={host} ", "")),
    );
    expect(hits.map((h) => h.detail).join(" ")).toMatch(/never emits 'data-lifecycle-card-host'/);
  });

  it("matches an attribute anchor with a value, and one without", () => {
    expect(emitsAnchor('<i data-lifecycle-card="recommendation_hold" />', '[data-lifecycle-card="recommendation_hold"]')).toBe(true);
    expect(emitsAnchor('<i data-lifecycle-card="artifact_review_gate" />', '[data-lifecycle-card="recommendation_hold"]')).toBe(false);
    expect(emitsAnchor("<i data-run-recommendation-chip-row />", "[data-run-recommendation-chip-row]")).toBe(true);
    expect(emitsAnchor("<i data-other />", "[data-run-recommendation-chip-row]")).toBe(false);
  });

  it("an OPEN OBLIGATION may only defer a ratified requirement, never invent one", () => {
    const invented = {
      ...PROPER_CONTRACT,
      openObligations: [
        { id: "x", requires: ["not-in-the-set"], why: "y".repeat(50), closedBy: "somebody else entirely" },
      ],
    };
    const hits = auditContracts({ artifact_review_gate: invented });
    expect(hits.map((h) => h.detail).join(" ")).toMatch(/never invent one/);
  });

  it("an OPEN OBLIGATION must name what is absent and who closes it", () => {
    const bare = {
      ...PROPER_CONTRACT,
      openObligations: [{ id: "x", requires: ["proper-floor"], why: "todo", closedBy: "" }],
    };
    const hits = auditContracts({ artifact_review_gate: bare }).map((h) => h.detail).join(" ");
    expect(hits).toMatch(/does not say what is absent/);
    expect(hits).toMatch(/does not say who closes it/);
  });

  it("a STALE open obligation fails — a requirement that started being met stops hiding", () => {
    const stale = {
      ...PROPER_CONTRACT,
      openObligations: [
        {
          id: "stale",
          requires: ["proper-floor"],
          why: "z".repeat(50),
          closedBy: "the slice that draws the floor",
        },
      ],
    };
    const sources = { "/repo/packages/fixture/proper-card.tsx": PROPER_OWNER };
    const hits = collectContractViolations({
      contracts: { artifact_review_gate: stale },
      files: ["packages/fixture/proper-card.tsx"],
      repoRoot: "/repo",
      readFileImpl: (p) => sources[p] ?? "",
    });
    expect(hits.map((h) => h.detail).join(" ")).toMatch(/strike the record here/);
  });

  it("the settled schedule control is NAMED now, so nothing is left open there", () => {
    const c = LIFECYCLE_CARD_CONTRACTS.trigger_schedule_proposal;
    expect(c.openAnchors ?? []).toEqual([]);
    expect(c.anchors).toContain('[data-action="cancel-trigger-schedule"]');
    // cinatra#2972 — the second control is withdrawn, not merely unnamed:
    // plan (A) §7.2 as amended 2026-08-25 says "there is no Run now".
    expect(c.anchors).not.toContain('[data-action="release-trigger-now"]');
  });
});

describe("a proof is tied to its NAMED test, and counts what it rendered", () => {
  const FILE = [
    'it("an unrelated case", async () => {',
    '  expect(c.querySelectorAll(\'[data-lifecycle-card="k"]\')).toHaveLength(1);',
    '  expect(root.getAttribute("data-lifecycle-card-host")).toBe(host);',
    "});",
    'it("the empty one", async () => {});',
    'it("the real one", async () => {',
    '  expect(c.querySelectorAll(\'[data-lifecycle-card="k"]\')).toHaveLength(1);',
    "});",
  ].join("\n");

  it("reads out ONLY the named test's body", () => {
    expect(extractTestBlock(FILE, "the empty one")).not.toContain("toHaveLength");
    expect(extractTestBlock(FILE, "the real one")).toContain("toHaveLength(1)");
    expect(extractTestBlock(FILE, "no such test")).toBeNull();
  });

  it("an EMPTY proof test can no longer borrow the file's other assertions", () => {
    const empty = extractTestBlock(FILE, "the empty one");
    expect(assertsExactlyOneInstance(empty, '[data-lifecycle-card="k"]')).toBe(false);
    expect(/getAttribute\(\s*["']data-lifecycle-card-host["']\s*\)/.test(empty)).toBe(false);
    // …while the file as a whole would have matched both, which is the hole.
    expect(assertsExactlyOneInstance(FILE, '[data-lifecycle-card="k"]')).toBe(true);
  });

  it("the window is a test DECLARATION, not any quoted mention of the name", () => {
    // The old reader took the FIRST quoted occurrence of the name and then
    // guessed the enclosing block from the nearest preceding `(`. A comment, a
    // `describe` title or a plain string repeating the name therefore selected
    // the wrong window — and a wrong window is a proof read off the wrong test.
    const decoys = [
      '// see it("the picked one") below for why this is the picker',
      'describe("the picked one", () => {',
      '  const note = "the picked one";',
      '  it("the picked one", () => {',
      '    expect(pick("a")).toBe(true);',
      "  });",
      "});",
    ].join("\n");
    const block = extractTestBlock(decoys, "the picked one");
    expect(block).toContain("expect(pick");
    // The `describe` window would have swallowed the note line as well.
    expect(block).not.toContain("const note");
  });

  it("two tests sharing one name read as the EARLIEST, whichever quote wrote it", () => {
    // Quote-type priority used to decide this: a later double-quoted test beat
    // an earlier single-quoted one. Position decides now.
    const file = [
      "it('same name', () => { expect(first).toBe(1); });",
      'it("same name", () => { expect(second).toBe(2); });',
    ].join("\n");
    expect(extractTestBlock(file, "same name")).toContain("first");
  });

  it("a PRESENCE check is not an instance proof — only a count is", () => {
    const presence = 'querySelector(\'[data-lifecycle-card="k"]\')).not.toBeNull()';
    expect(assertsExactlyOneInstance(presence, '[data-lifecycle-card="k"]')).toBe(false);
    const counted = 'querySelectorAll(\'[data-lifecycle-card="k"]\')).toHaveLength(1)';
    expect(assertsExactlyOneInstance(counted, '[data-lifecycle-card="k"]')).toBe(true);
    // …and a count of the WRONG root does not count for this kind.
    expect(assertsExactlyOneInstance(counted, "[data-run-recommendation-chip-row]")).toBe(false);
  });

  it("every DRAWN kind's instance proof counts its own root, inside its own test", () => {
    for (const [kind, c] of Object.entries(LIFECYCLE_CARD_CONTRACTS)) {
      if (c.status !== "DRAWN") continue;
      const block = extractTestBlock(read(c.instanceProof.file), c.instanceProof.testName);
      expect(block, `${kind}: the instance proof is gone`).not.toBeNull();
      expect(
        assertsExactlyOneInstance(block, c.instanceRootSelector),
        `${kind}: the instance proof does not count ${c.instanceRootSelector}`,
      ).toBe(true);
      for (const host of c.instanceProof.hosts) {
        expect(block, `${kind}: host ${host} is claimed and never driven`).toContain(host);
      }
    }
  });

  it("every host with a production adapter has a rendered instance proof", () => {
    for (const [kind, c] of Object.entries(LIFECYCLE_CARD_CONTRACTS)) {
      if (c.status !== "DRAWN") continue;
      const jsxHosts = LIFECYCLE_CARD_HOSTS.filter((h) =>
        (c.hosts[h] ?? []).some((e) => e.adapter !== "registry" && e.surface === "production"),
      );
      for (const host of jsxHosts) {
        expect(c.instanceProof.hosts, `${kind}: ${host}`).toContain(host);
      }
    }
  });
});

describe("an exclusion proof must assert something ABOUT the picker", () => {
  // The hole this closes. "The named test asserts SOMETHING" was satisfied by any
  // live `expect(` — `expect(true).toBe(true)`, an expectation parked in a branch
  // that never runs, or an assertion about a neighbouring function. Two
  // production adapters on one host could therefore be declared mutually
  // exclusive by a test that never read the picker at all. It is not a
  // hypothetical: the review-gate row cited the OTHER picker's totality proof.
  const named = 'it("proves it", () => { expect(pickPanel("a")).toBe(false); });';

  it("PASSES a live expectation that reads the selector", () => {
    expect(assertsAbout(extractTestBlock(named, "proves it"), "pickPanel")).toBe(true);
  });

  it("REJECTS a vacuous expect(true).toBe(true) — the shape a proof name hid", () => {
    const vacuous = 'it("proves it", () => { expect(true).toBe(true); });';
    expect(assertsAbout(extractTestBlock(vacuous, "proves it"), "pickPanel")).toBe(false);
    // …and the same for the other constant shapes.
    expect(assertsAbout("{ expect(1).toBe(1); }", "pickPanel")).toBe(false);
    expect(assertsAbout('{ expect("x").toBe("x"); }', "pickPanel")).toBe(false);
  });

  it("REJECTS an expectation that can never run", () => {
    expect(assertsAbout("{ if (false) { expect(pickPanel('a')).toBe(false); } }", "pickPanel")).toBe(
      false,
    );
  });

  it("REJECTS an assertion about something else entirely", () => {
    expect(assertsAbout("{ expect(otherThing('a')).toBe(false); }", "pickPanel")).toBe(false);
  });

  it("REJECTS an assertion that is only commented out, and an empty body", () => {
    expect(assertsAbout("{ /* expect(pickPanel('a')).toBe(false); */ }", "pickPanel")).toBe(false);
    expect(assertsAbout("{}", "pickPanel")).toBe(false);
  });

  it("counts the selector named in the MATCHER as well as in the subject", () => {
    expect(assertsAbout("{ expect(answer).toBe(pickPanel('a')); }", "pickPanel")).toBe(true);
  });

  it("every declared exclusion's proof really reads its own picker", () => {
    for (const [kind, c] of Object.entries(LIFECYCLE_CARD_CONTRACTS)) {
      for (const [host, ex] of Object.entries(c.exclusions ?? {})) {
        const block = extractTestBlock(read(ex.proof.file), ex.proof.testName);
        expect(block, `${kind}/${host}: the exclusion proof is gone`).not.toBeNull();
        expect(
          assertsAbout(block, ex.selector),
          `${kind}/${host}: the exclusion proof never reads ${ex.selector}`,
        ).toBe(true);
      }
    }
  });
});

describe("the contract mirrors the epic table's shape", () => {
  it("every row carries a component owner and a wire carriage", () => {
    for (const [kind, c] of Object.entries(LIFECYCLE_CARD_CONTRACTS)) {
      expect(c.component, kind).toBeTruthy();
      expect(["data_part", "interrupt"], kind).toContain(c.wireCarriage);
    }
  });

  it("the carriage is checked against the PROTOCOL, not against the prose", () => {
    const wrong = { ...PROPER_CONTRACT, wireCarriage: "interrupt" };
    const hits = auditContracts({ artifact_review_gate: wrong });
    expect(hits.map((h) => h.detail).join(" ")).toMatch(/the protocol says data_part/);
  });

  it("the recommendation kind rides a typed interrupt and the other three a data part", () => {
    expect(LIFECYCLE_CARD_CONTRACTS.recommendation_hold.wireCarriage).toBe("interrupt");
    for (const kind of ["artifact_review_gate", "verification_summary", "trigger_schedule_proposal"]) {
      expect(LIFECYCLE_CARD_CONTRACTS[kind].wireCarriage, kind).toBe("data_part");
    }
  });
});

describe("the two modes on the real tree", () => {
  // ONE kind, since the two slices that moved this list moved it in opposite
  // directions and both are recorded here. cinatra#2788 (S9d) DREW the schedule
  // card and struck `trigger_schedule_proposal`; cinatra#2928 (lifecycle-b W2a)
  // REGISTERED a fifth kind, `agent_hitl_screen`, without drawing it — that
  // slice changes no screen — so its row is an honest record of a card nobody
  // has drawn yet, struck by the slice that draws it (cinatra#2930). The list is
  // pinned rather than the mere presence of a placeholder, so a kind quietly
  // slipping BACK to placeholder is as visible as one being drawn.
  it("names the kinds that are still placeholders, and no others", () => {
    // EMPTY, and struck in the change that drew the last one: W3 (cinatra#2930)
    // draws `agent_hitl_screen` and mounts it on every host, so no kind is a
    // placeholder any more. The assertion is kept rather than deleted because
    // it is a red done-check in BOTH directions — a kind added without a card
    // fails here, and a card claimed without a drawn owner fails in the rules
    // above it.
    expect(placeholderKinds().map((p) => p.kind).sort()).toEqual([]);
  });

  it("the verification kind is DRAWN, with a real owner and a rendered proof", () => {
    const c = LIFECYCLE_CARD_CONTRACTS.verification_summary;
    expect(c.status).toBe("DRAWN");
    expect(c.owner).toBe("packages/agents/src/verification-summary-card.tsx");
    expect(c.gap).toBeUndefined();
    expect(c.renderedProof.file).toBeTypeOf("string");
    // §IX: every card appears on every host. This one now does.
    for (const host of LIFECYCLE_CARD_HOSTS) expect(c.hosts[host], host).not.toBeNull();
  });

  it("default mode is clean: no false claim, and the placeholders are recorded", () => {
    expect(collectContractViolations()).toEqual([]);
  });

  it("the REQUIRED gate — no flag at all — PASSES, now that the fifth kind has its card", () => {
    // The ordinary run is the done-check. This is the claim "the gate fails on
    // main": it has to be true of the run somebody actually makes, not of an
    // opt-in flag nobody passes. What it fails ON has moved twice — first the
    // undrawn kinds, then §IX's other half (`recommendation_hold` reaching two
    // of the four hosts), and now the fifth kind — and that is the point of
    // pinning it.
    //
    // BOTH HALVES ARE CLOSED NOW, and the pin says so rather than assuming it.
    // cinatra#2789 and cinatra#2788 drew §VII and §VI, cinatra#2790 (S9f)
    // mounted the recommendation card on the two hosts that carried a gap, and
    // W3 (cinatra#2930) draws the FIFTH kind and mounts it on all four. So the
    // done-check is green — and a green done-check is only worth reading while
    // the rules are still armed, which is what the two `not.toMatch` arms and
    // the lenient count below are for.
    const res = spawnSync(process.execPath, [GATE], { cwd: REPO_ROOT, encoding: "utf8" });
    const out = res.stdout + res.stderr;
    expect(res.status).toBe(0);
    // NO kind is missing a card, and the one that was is named in neither
    // direction: not as a gap, and not as a placeholder.
    expect(out).not.toMatch(/'agent_hitl_screen' has no card of its own/);
    // …and the host gap S9f closed is gone, in BOTH directions: a gate that went
    // green on a rule by dropping it would read the same as one that met it, so
    // the rule is re-read from the lenient arm below rather than assumed.
    expect(out).not.toMatch(/has no production mount on host/);
    // …and it names NEITHER of the two kinds that were drawn. A done-check that
    // kept reporting a drawn card as missing would be the mirror image of the
    // dishonesty this gate exists to end.
    expect(out).not.toMatch(/'verification_summary' has no card of its own/);
    expect(out).not.toMatch(/'trigger_schedule_proposal' has no card of its own/);
    // THE MOUNT RULE IS STILL ARMED, read off the gate's own lenient arm: it
    // counts the kinds it found a drawn owner for and states that every mount it
    // enumerated carries a host declaration. So the silence above is a
    // measurement of four hosts, not a table that stopped being consulted.
    const audit = spawnSync(process.execPath, [GATE, "--audit"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(audit.status).toBe(0);
    expect(audit.stdout + audit.stderr).toMatch(
      /5\/5 kinds drawn by a named owner, every mount host-declared/,
    );
  });

  it("the lenient read is the one that needs a flag, and counts the drawn kinds", () => {
    const res = spawnSync(process.execPath, [GATE, "--audit"], { cwd: REPO_ROOT, encoding: "utf8" });
    const out = res.stdout + res.stderr;
    expect(res.status).toBe(0);
    expect(out).toMatch(/no NEW false claim/);
    // 5 of 5 DRAWN, and the placeholder rider is GONE — which is the half that
    // has to be asserted now. W3 (cinatra#2930) drew the fifth kind, so a
    // lenient read that still named a gap would be reporting one that no longer
    // exists, and a count that stayed at four would be the same claim in
    // arithmetic.
    expect(out).toMatch(/5\/5 kinds drawn by a named owner/);
    expect(out).not.toMatch(/the REQUIRED gate \(no flag\) fails on these/);
    expect(out).not.toMatch(/STILL A PLACEHOLDER/);
  });

  it("--complete is the RULED name for the done-check and runs the same check", () => {
    // #2785 names the done-check `--complete`, and `package.json` ships a script
    // that passes it. The flag is recognised rather than swallowed, so the two
    // ways of asking for the done-check cannot drift apart.
    const bare = spawnSync(process.execPath, [GATE], { cwd: REPO_ROOT, encoding: "utf8" });
    const named = spawnSync(process.execPath, [GATE, "--complete"], { cwd: REPO_ROOT, encoding: "utf8" });
    expect(named.status).toBe(bare.status);
    expect(named.stdout + named.stderr).toBe(bare.stdout + bare.stderr);
    expect(named.status).toBe(0);
  });

  it("an UNRECOGNISED flag is refused, never read as a passing done-check", () => {
    const res = spawnSync(process.execPath, [GATE, "--audti"], { cwd: REPO_ROOT, encoding: "utf8" });
    expect(res.status).toBe(2);
    expect(res.stdout + res.stderr).toMatch(/unknown flag/);
  });

  it("the two modes may not be asked for at once", () => {
    const res = spawnSync(process.execPath, [GATE, "--audit", "--complete"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(res.status).toBe(2);
  });

  it("a REPEATED flag is refused, the same way an unknown one is", () => {
    // `--audti` exited 2 while `--complete --complete` was swallowed. One
    // argument reader, one answer: a mode word is passed once.
    for (const argv of [["--complete", "--complete"], ["--audit", "--audit"]]) {
      const res = spawnSync(process.execPath, [GATE, ...argv], { cwd: REPO_ROOT, encoding: "utf8" });
      expect(res.status, argv.join(" ")).toBe(2);
      expect(res.stdout + res.stderr).toMatch(/repeated flag/);
    }
  });

  it("the COMMITTED gate transcript is a fresh run of this gate, byte for byte", () => {
    // The fixture quotes a clean run verbatim. Without this test
    // nothing compares the quote to the gate: a finding could be reworded,
    // added or silenced and the committed transcript would still read as the
    // gate's own output. The comparison is the whole file, not a substring, so
    // a dropped line fails as loudly as a changed one.
    const res = spawnSync(process.execPath, [GATE], { cwd: REPO_ROOT, encoding: "utf8" });
    const fresh = `$ node ${GATE_REL}\n${res.stdout}${res.stderr}exit ${res.status}\n`;
    expect(fresh).toBe(read(TRANSCRIPT_REL));
  });

  it("package.json ships the ruled scripts for BOTH modes", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.scripts["gate:chat-hitl-one-card"]).toBe(
      "node scripts/audit/chat-hitl-one-card-gate.mjs",
    );
    expect(pkg.scripts["gate:chat-hitl-one-card:complete"]).toBe(
      "node scripts/audit/chat-hitl-one-card-gate.mjs --complete",
    );
    expect(pkg.scripts["gate:chat-hitl-one-card:audit"]).toBe(
      "node scripts/audit/chat-hitl-one-card-gate.mjs --audit",
    );
  });
});

describe("exemptions and the live tree", () => {
  it("tests, fixtures and docs are exempt — they may name anything", () => {
    for (const rel of [
      "packages/agents/src/__tests__/review-gate-card.test.tsx",
      "scripts/audit/__fixtures__/one-card-gate/clean-run-transcript.txt",
      "docs/internals/whatever.md",
      "tests/e2e/agents-run/fixtures.ts",
    ]) {
      expect(isExempt(rel), rel).toBe(true);
    }
    expect(isExempt("packages/agents/src/review-gate-card.tsx")).toBe(false);
  });

  it("the gate is CLEAN on the real tree", () => {
    expect(collectViolations()).toEqual([]);
  });

  it("the CLI's lenient read exits 0 on the real tree, counts the drawn kinds and still names the gap", () => {
    // THE COUNT IS THE SENTENCE THAT MATTERS NOW, and its absence of a rider is
    // the other half. It says how much of the tree the lenient read verified —
    // all five kinds — so a reader cannot mistake "exit 0" for a read that
    // skipped something; and the `STILL A PLACEHOLDER` rider is gone because
    // W3 (cinatra#2930) drew the last undrawn kind. cinatra#2788 struck the
    // schedule row and cinatra#2789 the verification one before it.
    const res = spawnSync(process.execPath, [GATE, "--audit"], { cwd: REPO_ROOT, encoding: "utf8" });
    const out = res.stdout + res.stderr;
    expect(out).toMatch(/no NEW false claim/);
    expect(out).toMatch(/5\/5 kinds drawn by a named owner/);
    expect(out).not.toMatch(/STILL A PLACEHOLDER/);
    expect(res.status).toBe(0);
  });
});
