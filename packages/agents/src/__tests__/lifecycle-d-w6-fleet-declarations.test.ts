/**
 * Lifecycle D W6 — the fifteen in-scope agents' declarations, as pinned.
 *
 * The adoption gate (`lifecycle-d-w6-adoption-gate.test.ts`) proves the RULE.
 * This file proves the FLEET: what each in-scope agent actually declares at the
 * pin this host carries, read from the synced extension tree — the real
 * manifests and the real service descriptions, never a stub.
 *
 * The border: an agent's declaration lives in that agent's own repository and
 * is changed by a pull request there. Nothing here edits an extension; this is
 * the host's read of the pinned result, so a pin bump that LOSES a declaration
 * reddens here instead of passing quietly.
 *
 * Every case names the acceptance sentence it pins. Several parts of the wave
 * are NOT here as assertions of presence but as pinned ABSENCES carrying their
 * reason — the same shape the previous slice used — the outreach parent's typed
 * produces and the transcript and feed-lister declarations among them, because
 * landing them under the now-blocking gate would refuse a package at its own
 * publish seam.
 *
 * Run `node scripts/ci/sync-dev-extensions.mjs --pinned` before this suite or
 * its first case fails by design.
 *
 * ONE PIN IS HELD at its previous sha, and the held part is recorded below as
 * a pinned absence carrying its reason. The wave's own change in that
 * repository also carries a defect the host refuses, and the border keeps the
 * remedy in the package's own repository rather than in a host special case:
 *
 *   - media-transcript-agent: its head declares a preferred model outside the
 *     host provider policy allowlist, which the L1 service-description check
 *     refuses. The model arrived in a later, unrelated change in
 *     that repository, not in the declaration itself.
 *
 * email-delivery-agent's pin is no longer held: its advanced head declares the
 * send screen under `@cinatra-ai/email-delivery-agent:send-confirmation` and
 * carries the consumer edge on the body kind, and the host's generated
 * field-renderer map resolves that id to the send-confirmation renderer, so
 * the surface the host serves is proven rather than assumed and this file
 * follows that declaration below instead of pinning the gap.
 *
 * company-discovery-agent's pin is no longer held: its corrected head names
 * the two fields a person supplies in `required`, which is how the host makes
 * a field visible, and this file follows that declaration below.
 *
 * list-curator-agent's pin is no longer held either: the EndNode invariant it
 * failed — an EndNode that specifies both inputs and outputs must have them
 * equal — was fixed in that repository, and its advanced head also turns the
 * two declared review screens into real pauses in the flow, so this file
 * follows that declaration below instead of pinning the gap.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, it, expect } from "vitest";

const extensionsRoot = path.resolve(__dirname, "../../../../extensions/cinatra-ai");

/** The host's OWN generated field-renderer map, regenerated with the pins. */
const FIELD_RENDERER_MAP = path.resolve(
  __dirname,
  "../../../../src/lib/generated/field-renderer-components.ts",
);

/** The fifteen agents of the wave, by their directory slug. */
const IN_SCOPE = [
  "apollo-prospecting-agent",
  "company-discovery-agent",
  "contact-discovery-agent",
  "email-delivery-agent",
  "email-drafting-agent",
  "email-follow-up-agent",
  "email-outreach-agent",
  "email-recipient-selection-agent",
  "email-test-delivery-agent",
  "lint-policy-agent",
  "list-curator-agent",
  "media-feed-lister-agent",
  "media-transcript-agent",
  "web-research-agent",
  "web-scrape-agent",
] as const;

type Slug = (typeof IN_SCOPE)[number];

type ProducesEntry = { extension: string; objectTypeId?: string };
type ArtifactEdge = { packageName: string; requirement: string; edgeType: string };
type Binding = {
  outputId: string;
  extension: string;
  objectTypeId?: string;
  titleFrom?: string;
  contentFrom?: string;
  membersAreArtifacts?: unknown;
};

type PinnedAgent = {
  slug: Slug;
  packageName: string;
  /** `cinatra.produces` on the manifest. */
  produces: ProducesEntry[];
  /** `metadata.cinatra.produces` on the service description — the MIRROR. */
  producesMirror: ProducesEntry[];
  /** Install-closure-guaranteed artifact edges: kind artifact, required, not peer. */
  artifactEdges: ArtifactEdge[];
  /** `metadata.cinatra.hitlScreens` — the pauses the manifest declares. */
  declaredPauses: string[];
  /** `cinatra.hasApprovalGates` — the gate claim. */
  gateClaim: boolean | undefined;
  /** Approval nodes the flow actually has. */
  approvalNodes: number;
  /** `metadata.cinatra.required` / `.hidden` on the start node — the host's own
   *  two lists (`packages/agents/src/input-schema-resolver.ts`). */
  requiredInputs: string[];
  hiddenInputs: string[];
  /** Terminal artifact bindings on end-node outputs. */
  bindings: Binding[];
};

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function producesOf(block: unknown): ProducesEntry[] {
  if (!Array.isArray(block)) return [];
  return block
    .map((e) => e as { extension?: unknown; objectTypeId?: unknown })
    .filter((e): e is { extension: string; objectTypeId?: unknown } =>
      typeof e?.extension === "string",
    )
    .map((e) => ({
      extension: e.extension,
      ...(typeof e.objectTypeId === "string" ? { objectTypeId: e.objectTypeId } : {}),
    }));
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((s): s is string => typeof s === "string") : [];
}

function readPinnedAgent(slug: Slug): PinnedAgent {
  const dir = path.join(extensionsRoot, slug);
  const pkg = readJson(path.join(dir, "package.json")) ?? {};
  const oas = readJson(path.join(dir, "cinatra", "oas.json")) ?? {};
  const cinatra = (pkg.cinatra ?? {}) as Record<string, unknown>;
  const meta = (((oas.metadata ?? {}) as Record<string, unknown>).cinatra ?? {}) as Record<
    string,
    unknown
  >;

  const artifactEdges = (Array.isArray(cinatra.dependencies) ? cinatra.dependencies : [])
    .map((d) => d as Record<string, unknown>)
    .filter(
      (d) =>
        d?.kind === "artifact" && d?.requirement === "required" && d?.edgeType !== "peer",
    )
    .map((d) => ({
      packageName: String(d.packageName),
      requirement: String(d.requirement),
      edgeType: String(d.edgeType),
    }));

  const refs = (oas.$referenced_components ?? {}) as Record<string, unknown>;
  const bindings: Binding[] = [];
  let approvalNodes = 0;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (obj.component_type === "InputMessageNode") approvalNodes += 1;
    if (obj.component_type === "EndNode" && Array.isArray(obj.outputs)) {
      for (const raw of obj.outputs) {
        const output = raw as Record<string, unknown>;
        const artifact = ((output.cinatra ?? {}) as Record<string, unknown>).artifact as
          | Record<string, unknown>
          | undefined;
        if (!artifact || typeof artifact.extension !== "string") continue;
        bindings.push({
          outputId: String(output.title),
          extension: artifact.extension,
          ...(typeof artifact.objectTypeId === "string"
            ? { objectTypeId: artifact.objectTypeId }
            : {}),
          ...(typeof artifact.titleFrom === "string" ? { titleFrom: artifact.titleFrom } : {}),
          ...(typeof artifact.contentFrom === "string"
            ? { contentFrom: artifact.contentFrom }
            : {}),
          ...(artifact.membersAreArtifacts !== undefined
            ? { membersAreArtifacts: artifact.membersAreArtifacts }
            : {}),
        });
      }
    }
    for (const value of Object.values(obj)) walk(value);
  };
  walk(oas);

  const startRef = ((oas.start_node ?? {}) as { $component_ref?: string }).$component_ref;
  const startNode = (startRef ? refs[startRef] : undefined) as
    | Record<string, unknown>
    | undefined;
  const startMeta = (((startNode?.metadata ?? {}) as Record<string, unknown>).cinatra ??
    {}) as Record<string, unknown>;

  return {
    slug,
    packageName: String(pkg.name ?? `@cinatra-ai/${slug}`),
    produces: producesOf(cinatra.produces),
    producesMirror: producesOf(meta.produces),
    artifactEdges,
    declaredPauses: stringList(meta.hitlScreens),
    gateClaim: typeof cinatra.hasApprovalGates === "boolean" ? cinatra.hasApprovalGates : undefined,
    approvalNodes,
    requiredInputs: stringList(startMeta.required),
    hiddenInputs: stringList(startMeta.hidden),
    bindings,
  };
}

const FLEET = new Map<Slug, PinnedAgent>();

describe("lifecycle D W6 — the in-scope fleet is read from the pinned tree", () => {
  it("all fifteen in-scope agents are materialized (run the dev-extension sync first)", () => {
    expect(fs.existsSync(extensionsRoot)).toBe(true);
    const missing = IN_SCOPE.filter(
      (slug) => !fs.existsSync(path.join(extensionsRoot, slug, "cinatra", "oas.json")),
    );
    expect(missing).toEqual([]);
    for (const slug of IN_SCOPE) FLEET.set(slug, readPinnedAgent(slug));
    expect(FLEET.size).toBe(15);
  });
});

function agent(slug: Slug): PinnedAgent {
  const found = FLEET.get(slug) ?? readPinnedAgent(slug);
  FLEET.set(slug, found);
  return found;
}

const EMAIL_ARTIFACTS = "@cinatra-ai/email-artifacts";
const EMAIL_BODY_TYPE = "@cinatra-ai/email:body";
const TEXT_ARTIFACT = "@cinatra-ai/text-artifact";
const TEXT_ARTIFACT_TYPE = "@cinatra-ai/text-artifact:artifact";
const JSON_ARTIFACT = "@cinatra-ai/json-artifact";

// ---------------------------------------------------------------------------
// Acceptance item 2 — a fixture per agent asserts its declared state.
// ---------------------------------------------------------------------------

describe("acceptance 2 — the drafting and follow-up agents' typed ids and pauses", () => {
  it("the drafting agent carries the typed body id on entry, mirror and binding", () => {
    const a = agent("email-drafting-agent");
    expect(a.produces).toEqual([
      { extension: EMAIL_ARTIFACTS, objectTypeId: EMAIL_BODY_TYPE },
    ]);
    expect(a.producesMirror).toEqual(a.produces);
    const bound = a.bindings.filter((b) => b.extension === EMAIL_ARTIFACTS);
    expect(bound).toHaveLength(1);
    expect(bound[0].objectTypeId).toBe(EMAIL_BODY_TYPE);
    expect(a.artifactEdges.map((e) => e.packageName)).toContain(EMAIL_ARTIFACTS);
  });

  it("the drafting agent declares the one pause its flow has", () => {
    const a = agent("email-drafting-agent");
    expect(a.declaredPauses).toEqual(["@cinatra-ai/email-drafting-agent:email-drafts-review"]);
    expect(a.approvalNodes).toBe(1);
  });

  it("the follow-up agent carries the typed body id on entry, mirror and binding", () => {
    const a = agent("email-follow-up-agent");
    expect(a.produces).toEqual([
      { extension: EMAIL_ARTIFACTS, objectTypeId: EMAIL_BODY_TYPE },
    ]);
    expect(a.producesMirror).toEqual(a.produces);
    const bound = a.bindings.filter((b) => b.extension === EMAIL_ARTIFACTS);
    expect(bound).toHaveLength(1);
    expect(bound[0].objectTypeId).toBe(EMAIL_BODY_TYPE);
    expect(a.artifactEdges.map((e) => e.packageName)).toContain(EMAIL_ARTIFACTS);
  });

  it("the follow-up agent declares no pause, and its flow has none", () => {
    const a = agent("email-follow-up-agent");
    expect(a.declaredPauses).toEqual([]);
    expect(a.approvalNodes).toBe(0);
  });
});

describe("acceptance 2 — the delivery agent's consumer edge on the body kind", () => {
  // The consumer edge is written and merged in cinatra-ai/email-delivery-agent,
  // and this host now carries that head: the edge is PRESENT below. The same
  // head names one screen in `hitlScreens` instead of two, and the host's own
  // generated field-renderer map still resolves the send screen under that id,
  // so the file follows the declaration rather than holding the pin.
  it("the delivery agent's consumer edge on the body kind is present at this pin", () => {
    const a = agent("email-delivery-agent");
    expect(a.artifactEdges).toEqual([
      {
        packageName: "@cinatra-ai/email-artifacts",
        requirement: "required",
        edgeType: "runtime",
      },
    ]);
    // It reads the kind; it does not file one — that half already holds.
    expect(a.produces).toEqual([]);
    expect(a.producesMirror).toEqual([]);
  });

  it("the delivery agent declares the send confirmation screen", () => {
    const a = agent("email-delivery-agent");
    expect(a.declaredPauses).toEqual([
      "@cinatra-ai/email-delivery-agent:send-confirmation",
    ]);
    expect(a.approvalNodes).toBe(1);
  });

  // The surface the host serves, read from the host's OWN regenerated map:
  // the declared id resolves to a renderer, so nothing is advertised that the
  // host cannot draw.
  it("the regenerated field-renderer map resolves the send screen under the declared id", () => {
    const generated = fs.readFileSync(FIELD_RENDERER_MAP, "utf8");
    const declared = agent("email-delivery-agent").declaredPauses[0];
    expect(declared).toBe("@cinatra-ai/email-delivery-agent:send-confirmation");
    const row = generated
      .split("\n")
      .find((line) => line.includes(`"${declared}":`));
    expect(row).toBeDefined();
    expect(row).toContain("@cinatra-ai/email-artifacts/src/renderers/send-confirmation");
  });
});

describe("acceptance 2 — the outreach parent's typed produces and five declared pauses", () => {
  it("the outreach parent declares the five pauses its flow has, in run order", () => {
    const a = agent("email-outreach-agent");
    expect(a.declaredPauses).toEqual([
      "@cinatra-ai/email-outreach-agent:list-picker",
      "@cinatra-ai/email-recipient-selection-agent:campaign-recipients-review",
      "@cinatra-ai/context-selection-agent:context-selector",
      "@cinatra-ai/email-drafting-agent:email-drafts-review",
      "@cinatra-ai/email-delivery-agent:send-confirmation",
    ]);
    expect(a.declaredPauses).toHaveLength(5);
  });

  // The absence, pinned WITH its reason. The composite's bodies are written
  // mid-run by its embedded drafting step; no materialization road resolves a
  // typed entry on the parent today (a subflow end node cannot bind, the
  // inlined copy carries no binding of its own, and there is no materialize
  // node), so under the now-blocking gate the entry would refuse this package
  // at its own republish. The entry travels with the ledgered mid-run write.
  it("the outreach parent's typed produces is ABSENT, and that absence is the wave's own deferral", () => {
    const a = agent("email-outreach-agent");
    expect(a.produces).toEqual([]);
    expect(a.producesMirror).toEqual([]);
    expect(a.bindings).toEqual([]);
  });
});

describe("acceptance 2 — the transcript agent's typed id, binding, dependency edge and gate claim", () => {
  // All four parts are written and merged in cinatra-ai/media-transcript-agent,
  // and the same head carries a preferred model the host provider policy does
  // not allow, which the L1 check refuses outright. The pin is therefore held
  // and every part below is a pinned absence: it reddens the moment a follow-up
  // in that repository brings the head back inside the allowlist and the pin
  // advances.
  it("the transcript agent's typed id is ABSENT at this pin, and the absence carries its reason", () => {
    const a = agent("media-transcript-agent");
    expect(a.produces.map((e) => e.objectTypeId)).not.toContain(TEXT_ARTIFACT_TYPE);
    expect(a.producesMirror).toEqual([]);
    expect(a.bindings.filter((b) => b.extension === TEXT_ARTIFACT)).toEqual([]);
  });

  it("the transcript agent still names the retired target and carries no dependency edge", () => {
    const a = agent("media-transcript-agent");
    expect(a.artifactEdges).toEqual([]);
    // The retired target the pinned manifest names is exactly the grandfathered
    // pair the produced-artifact ratchet still tolerates for this package.
    expect(a.produces.map((p) => p.extension)).toEqual(["@cinatra-ai/default-artifact"]);
  });

  it("the transcript agent's gate claim is still the untrue one — its flow has no pause", () => {
    const a = agent("media-transcript-agent");
    expect(a.approvalNodes).toBe(0);
    expect(a.declaredPauses).toEqual([]);
    expect(a.gateClaim).toBe(true);
  });
});

describe("acceptance 2 — the feed lister's episode edge, produces entry and fan-out binding", () => {
  // All three parts travel together and none is on the pinned head: a typed
  // entry ahead of a binding is a publish refusal under the flipped gate, and a
  // single-value binding over `episodes` would file ONE artifact per run rather
  // than one per episode. The host fan-out grammar the third part needs now
  // exists on this branch's base; the declaration itself is a pull request in
  // cinatra-ai/media-feed-lister-agent, which the border keeps out of this one.
  it("the feed lister declares none of the three parts, and the absence is pinned with its reason", () => {
    const a = agent("media-feed-lister-agent");
    expect(a.produces).toEqual([]);
    expect(a.producesMirror).toEqual([]);
    expect(a.artifactEdges).toEqual([]);
    expect(a.bindings).toEqual([]);
  });

  it("the `episodes` output a fan-out binding will name is on the pinned flow", () => {
    const dir = path.join(extensionsRoot, "media-feed-lister-agent", "cinatra", "oas.json");
    const raw = fs.readFileSync(dir, "utf8");
    expect(raw).toContain("episodes");
  });
});

describe("acceptance 2 — the research agent's and the scraper's consumer edges", () => {
  it("the research agent declares the rows kind it reads", () => {
    const a = agent("web-research-agent");
    expect(a.artifactEdges).toEqual([
      { packageName: JSON_ARTIFACT, requirement: "required", edgeType: "runtime" },
    ]);
    expect(a.produces).toEqual([]);
  });

  it("the scraper declares the schema kind it reads", () => {
    const a = agent("web-scrape-agent");
    expect(a.artifactEdges).toEqual([
      { packageName: JSON_ARTIFACT, requirement: "required", edgeType: "runtime" },
    ]);
    expect(a.produces).toEqual([]);
  });

  it("the scraper's gate claim is corrected — its flow has no pause", () => {
    const a = agent("web-scrape-agent");
    expect(a.approvalNodes).toBe(0);
    expect(a.declaredPauses).toEqual([]);
    expect(a.gateClaim).toBe(false);
  });
});

describe("acceptance 2 — inputs: no required-and-hidden, and the visible picks", () => {
  it("the drafting agent lists no input as required AND hidden", () => {
    const a = agent("email-drafting-agent");
    expect(a.requiredInputs.filter((n) => a.hiddenInputs.includes(n))).toEqual([]);
  });

  it("the recipient-selection agent lists no input as required AND hidden", () => {
    const a = agent("email-recipient-selection-agent");
    expect(a.requiredInputs.filter((n) => a.hiddenInputs.includes(n))).toEqual([]);
  });

  it("the follow-up agent shows the campaign as a visible pick", () => {
    const a = agent("email-follow-up-agent");
    expect(a.requiredInputs).toContain("campaignId");
    expect(a.hiddenInputs).not.toContain("campaignId");
  });

  it("the test-delivery agent shows the campaign as a visible pick", () => {
    const a = agent("email-test-delivery-agent");
    expect(a.requiredInputs).toContain("campaignId");
    expect(a.hiddenInputs).not.toContain("campaignId");
  });

  // The corrected head names the two fields a person supplies — the company
  // name and the domain — in `required`, and leaves only the derived lookup
  // flag and the run id in `hidden`. The host has two lists and no third, so
  // naming the field in `required` is how it is shown AND prompted.
  it("company discovery shows the name and the domain as the fields a person sets", () => {
    const a = agent("company-discovery-agent");
    expect(a.requiredInputs).toEqual(["companyName", "domain"]);
    expect(a.hiddenInputs).toEqual(["apolloLookup", "cinatra_run_id"]);
    expect(a.requiredInputs.filter((n) => a.hiddenInputs.includes(n))).toEqual([]);
  });
});

describe("acceptance 2 — the curator's two declared pauses", () => {
  it("the curator declares its two review screens", () => {
    const a = agent("list-curator-agent");
    expect(a.declaredPauses).toEqual([
      "@cinatra-ai/list-curator-agent:scrape-schema-review",
      "@cinatra-ai/list-curator-agent:final-list-review",
    ]);
  });

  // At the advanced pin the two declared screens ARE pauses in the flow, and
  // the manifest's gate claim is true beside them — the pair the host reads
  // together, so a later pin that loses either one reddens here.
  it("the curator's declared screens are real pauses in its flow, and its gate claim is true", () => {
    const a = agent("list-curator-agent");
    expect(a.approvalNodes).toBe(2);
    expect(a.gateClaim).toBe(true);
  });
});

describe("acceptance 2 — nothing declared by the six data agents and the lint agent", () => {
  const DECLARE_NOTHING: Slug[] = [
    "apollo-prospecting-agent",
    "company-discovery-agent",
    "contact-discovery-agent",
    "email-recipient-selection-agent",
    "email-test-delivery-agent",
    "list-curator-agent",
    "lint-policy-agent",
  ];

  it("the seven declare no artifact kind at all", () => {
    const declaring = DECLARE_NOTHING.map((slug) => agent(slug)).filter(
      (a) => a.produces.length > 0 || a.artifactEdges.length > 0 || a.bindings.length > 0,
    );
    expect(declaring.map((a) => a.packageName)).toEqual([]);
    expect(DECLARE_NOTHING).toHaveLength(7);
  });
});

// ---------------------------------------------------------------------------
// 6d, fleet-wide — a manifest never claims a gate its flow lacks.
// ---------------------------------------------------------------------------

describe("acceptance 2 — a manifest never claims a gate its flow lacks", () => {
  it("every in-scope agent claiming an approval gate really has one, but for the one held pin", () => {
    const lying = IN_SCOPE.map((slug) => agent(slug))
      .filter((a) => a.gateClaim === true && a.approvalNodes === 0)
      .map((a) => a.packageName);
    // The scraper's claim is corrected at its advanced pin; the transcript
    // agent's correction rides the head this leg holds back, so it is the one
    // remaining untrue claim and it is named here rather than tolerated
    // silently.
    expect(lying).toEqual(["@cinatra-ai/media-transcript-agent"]);
  });
});

// ---------------------------------------------------------------------------
// Acceptance item 5 — eight agents carry a declaration and seven declare nothing.
// ---------------------------------------------------------------------------

describe("acceptance 5 — the declaring count at this pin", () => {
  /** Carrying a declaration = an artifact-class statement: a `produces` entry,
   *  or a required artifact-kind dependency edge (the consumer edge). */
  const carriesADeclaration = (a: PinnedAgent): boolean =>
    a.produces.length > 0 || a.artifactEdges.length > 0;

  /** The eight the wave's row names. */
  const THE_EIGHT: Slug[] = [
    "email-delivery-agent",
    "email-drafting-agent",
    "email-follow-up-agent",
    "email-outreach-agent",
    "media-feed-lister-agent",
    "media-transcript-agent",
    "web-research-agent",
    "web-scrape-agent",
  ];

  /** The one the held pin keeps short of the row, with its own reason. */
  const HELD: Slug[] = ["media-feed-lister-agent"];

  it("seven of the eight carry a declaration at this pin", () => {
    const declaring = IN_SCOPE.map((slug) => agent(slug))
      .filter(carriesADeclaration)
      .map((a) => a.slug)
      .sort();
    expect(declaring).toEqual(THE_EIGHT.filter((s) => !HELD.includes(s)).sort());
    expect(declaring).toHaveLength(7);
  });

  it("the eight are short exactly the feed lister, one pull request in its own repository", () => {
    const declaring = new Set(
      IN_SCOPE.map((slug) => agent(slug))
        .filter(carriesADeclaration)
        .map((a) => a.slug),
    );
    expect(THE_EIGHT.filter((slug) => !declaring.has(slug))).toEqual(HELD);
  });

  it("the remaining eight of the fifteen declare nothing", () => {
    const silent = IN_SCOPE.map((slug) => agent(slug))
      .filter((a) => !carriesADeclaration(a))
      .map((a) => a.slug);
    expect(silent).toHaveLength(8);
    expect(silent).toContain("media-feed-lister-agent");
    expect(silent).not.toContain("email-delivery-agent");
  });
});
