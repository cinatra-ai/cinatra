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
  REGISTRY_MODULE,
  REGISTRY_KINDS,
  HOST_PROVIDED_BY_PARENT,
  LIFECYCLE_CARD_CONTRACTS,
  LIFECYCLE_CARD_KINDS,
  LIFECYCLE_CARD_HOSTS,
  PENDING_RETIREMENT,
  auditContracts,
  collectContractViolations,
  collectViolations,
  emitsAnchor,
  extractComponentBody,
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
const GATE = join(REPO_ROOT, "scripts", "audit", "chat-hitl-one-card-gate.mjs");
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
        "verification-page-view": "return <VerificationView record={r} />;",
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
      "  trigger_schedule_proposal: LifecycleCard,",
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
    chat_thread: [{ module: "packages/fixture/registry.tsx", adapter: "registry", surface: "production", why: "the fixture transcript dispatch, named here" }],
    site_widget: null,
    run_card: [{ module: "packages/fixture/panel.tsx", adapter: "mount", surface: "production", why: "the fixture run card, named here so a second one is visible" }],
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
      { module: "packages/fixture/panel.tsx", adapter: "mount", surface: "production", why: "the leaf-run panel branch of this host" },
      { module: "packages/fixture/screen.tsx", adapter: "mount", surface: "production", why: "the stepped-run screen branch of the same host" },
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
      "packages/fixture/__tests__/pick.test.ts": "it('covers every branch', () => {});",
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
          { module: "packages/fixture/dev-preview.tsx", adapter: "mount", surface: "dev_preview", why: "the dev preview row, which draws only inside an opened preview" },
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
        run_card: [{ module: "packages/fixture/panel.tsx", adapter: "mount", surface: "production", why: "" }],
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
        run_card: [{ module: "packages/fixture/panel.tsx", adapter: "mount", why: "the fixture run card, named here" }],
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

describe("R9 — the parallel core renderer is banned, and its exception expires", () => {
  it("flags a NEW module drawing the retired verification view", () => {
    const hits = scanModule("src/app/somewhere/else/page.tsx", "return <VerificationView record={r} />;");
    expect(hits.map((h) => h.rule)).toContain("R2");
  });

  it("flags a second DEFINITION of it anywhere", () => {
    const hits = scanModule("packages/agents/src/x.tsx", "export function CompactVerificationView() { return null; }");
    expect(hits.map((h) => h.rule)).toContain("R2");
  });

  it("does NOT flag the unrelated identifiers that merely start the same way", () => {
    const src = "const isVerificationView = sp.view === 'verification';\nexport interface VerificationViewProps { a: 1 }";
    expect(scanModule("src/app/x/page.tsx", src)).toEqual([]);
  });

  it("the recorded modules really carry it — the exception is not vacuous", () => {
    for (const rel of PENDING_RETIREMENT.modules) {
      expect(read(rel), rel).toMatch(/VerificationView/);
    }
  });

  it("the exception EXPIRES the moment the verification kind is drawn", () => {
    const drawn = { ...PROPER_CONTRACT, component: "VerificationSummaryCard" };
    const hits = auditContracts({ verification_summary: drawn });
    expect(hits.map((h) => h.rule)).toContain("R9");
    expect(hits.find((h) => h.rule === "R9").detail).toMatch(/must be gone/);
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
    recommendation_hold: [
      '[data-lifecycle-card="recommendation_hold"]',
      "[data-run-recommendation-chip-row]",
      '[data-action="confirm-run-recommendation"]',
      '[data-action="skip-run-recommendation"]',
    ],
    trigger_schedule_proposal: [
      "schedule-option-rows",
      "schedule-proposal-floor",
      "scheduled-run-chrome",
      '[data-action="cancel-trigger-schedule"]',
      '[data-action="release-trigger-now"]',
    ],
    verification_summary: ["verification-in-thread"],
  };

  for (const [kind, anchors] of Object.entries(RATIFIED)) {
    it(`'${kind}' requires exactly its ratified anchors`, () => {
      expect(LIFECYCLE_CARD_CONTRACTS[kind].anchors).toEqual(anchors);
    });
  }

  it("the verification outcome pill is a one-of group, and all three are reachable", () => {
    expect(LIFECYCLE_CARD_CONTRACTS.verification_summary.anchorsOneOf.of).toEqual([
      "verification-verified",
      "verification-drift",
      "verification-findings-not-met",
    ]);
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

  it("the settled schedule controls are NAMED now, so nothing is left open there", () => {
    const c = LIFECYCLE_CARD_CONTRACTS.trigger_schedule_proposal;
    expect(c.openAnchors ?? []).toEqual([]);
    expect(c.anchors).toContain('[data-action="cancel-trigger-schedule"]');
    expect(c.anchors).toContain('[data-action="release-trigger-now"]');
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
  it("names the two kinds that are still placeholders", () => {
    expect(placeholderKinds().map((p) => p.kind).sort()).toEqual([
      "trigger_schedule_proposal",
      "verification_summary",
    ]);
  });

  it("default mode is clean: no false claim, and the placeholders are recorded", () => {
    expect(collectContractViolations()).toEqual([]);
  });

  it("the REQUIRED gate — no flag at all — FAILS today and NAMES both undrawn kinds", () => {
    // The ordinary run is the done-check. This is the claim "the gate fails on
    // main": it has to be true of the run somebody actually makes, not of an
    // opt-in flag nobody passes.
    const res = spawnSync(process.execPath, [GATE], { cwd: REPO_ROOT, encoding: "utf8" });
    const out = res.stdout + res.stderr;
    expect(res.status).toBe(1);
    expect(out).toMatch(/'trigger_schedule_proposal' has no card of its own/);
    expect(out).toMatch(/'verification_summary' has no card of its own/);
  });

  it("the lenient read is the one that needs a flag, and says so", () => {
    const res = spawnSync(process.execPath, [GATE, "--audit"], { cwd: REPO_ROOT, encoding: "utf8" });
    const out = res.stdout + res.stderr;
    expect(res.status).toBe(0);
    expect(out).toMatch(/no NEW false claim/);
    expect(out).toMatch(/the REQUIRED gate \(no flag\) fails on these/);
  });
});

describe("exemptions and the live tree", () => {
  it("tests, fixtures, evidence and docs are exempt — they may name anything", () => {
    for (const rel of [
      "packages/agents/src/__tests__/review-gate-card.test.tsx",
      "evidence/2566-s2/README.md",
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

  it("the CLI's lenient read exits 0 on the real tree and still names the gaps", () => {
    const res = spawnSync(process.execPath, [GATE, "--audit"], { cwd: REPO_ROOT, encoding: "utf8" });
    const out = res.stdout + res.stderr;
    expect(out).toMatch(/no NEW false claim/);
    expect(out).toMatch(/STILL A PLACEHOLDER/);
    expect(res.status).toBe(0);
  });
});
