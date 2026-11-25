// THE REVIEW CARD'S IDENTITY LINE NAMES THE RENDERER AND THE PLATFORM, AS THE
// ARTIFACT'S OWN PAGE DOES (cinatra#3092).
//
// lifecycle-cards §XIII.7: "the extension's display draws on the card exactly
// what it draws on the artifact's own page … the platform the page lives on is
// carried in the identity line, which also names the one renderer both CMS
// extensions draw through … so a WordPress page and a Drupal page are told
// apart there and nowhere else." §XIII.8: a Drupal page is "drawn as §XIII.7
// draws it with Drupal in its identity line".
//
// The header composer reads the display's identity the way the artifact page
// reads it: the same build-map load decision and the same generic read of the
// module's two optional exports, over the PINNED revision's content. Fixture
// names stand in for the pack; core names no extension.

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-lifecycle-refs";

const RENDERER = "@fixture/pages:page-diff";
const PLATFORMS: Record<string, string> = { wordpress: "WordPress", drupal: "Drupal" };

const mocks = vi.hoisted(() => ({ identityFacts: vi.fn(), plainLoads: 0 }));

/** The page display's module: it names its renderer, and reads the platform and
 *  the address from the content it is handed, as the shipped pack does. */
const pageModule = {
  default: () => null,
  rendererName: RENDERER,
  identityFacts: (content: unknown) => mocks.identityFacts(content),
};

vi.mock("@/lib/generated/artifact-renderers", () => {
  const entry = (packageName: string, load: () => Promise<unknown>) => ({
    resolution: "guardedOptional",
    packageName,
    slot: "detail",
    representations: [],
    propsApiVersion: 5,
    load,
  });
  return {
    GENERATED_ARTIFACT_RENDERERS: {
      "@fixture/pages::detail": entry("@fixture/pages", async () => pageModule),
      "@fixture/dashboard::detail": entry("@fixture/dashboard", async () => {
        mocks.plainLoads += 1;
        return { default: () => null };
      }),
      "@fixture/hostile::detail": entry("@fixture/hostile", async () => ({
        default: () => null,
        rendererName: `<img src=x onerror=alert(1)>${"x".repeat(150)}`,
        identityFacts: () => ({ revision: ["WordPress"], closing: ["a‮b"] }),
      })),
      "@fixture/too-long::detail": entry("@fixture/too-long", async () => ({
        default: () => null,
        rendererName: "r".repeat(201),
        identityFacts: () => ({ revision: ["WordPress"], closing: ["x".repeat(201)] }),
      })),
    },
  };
});

const readReviewGate = vi.fn();
vi.mock("@cinatra-ai/agents/artifact-review-gate-store", () => ({
  readReviewGate: (...args: unknown[]) => readReviewGate(...args),
}));

const readArtifactForDetail = vi.fn();
const readArtifactForSettledReview = vi.fn();
vi.mock("@/lib/artifacts/artifact-service", () => ({
  readArtifactForDetail: (...args: unknown[]) => readArtifactForDetail(...args),
  readArtifactForSettledReview: (...args: unknown[]) => readArtifactForSettledReview(...args),
}));

vi.mock("@/lib/authz/build-actor-context", () => ({
  buildActorContextFromPrimitive: () => ({ actor: "actor", organizationId: "org-1", teamIds: ["team-1"] }),
}));

const revisionMember = vi.fn();
const revisionMemberHistorical = vi.fn();
const resolveMount = vi.fn();
const buildProps = vi.fn();
vi.mock("@/app/artifacts/[id]/review-target-prepare", () => ({
  bindArtifactReviewPorts: () => ({ revisionMember, revisionMemberHistorical, resolveMount, buildProps }),
}));

vi.mock("@/lib/owner-display-names", () => ({
  readOwnerDisplayName: async (level: string) => (level === "team" ? "Growth" : null),
}));

import {
  lifecycleTargetHeadersSchema,
  parseLifecycleResolveEnvelope,
  reviewTargetHeadersWire,
  type LifecycleCardState,
  type LifecycleTargetHeader,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";
import { ReviewTargetHeader } from "@cinatra-ai/agents/review-gate-card";

import { buildArtifactDetailHeader } from "@/app/artifacts/[id]/artifact-detail-header";
import {
  buildMapDisplayDecision,
  readArtifactDisplayIdentity,
} from "@/app/artifacts/[id]/artifact-display-identity";
import type { ArtifactSummary } from "@/lib/artifacts/artifact-service";

import { encodeLifecycleGateRef } from "../lifecycle-card-ref";
import { readReviewTargetHeadersReading } from "../lifecycle-target-headers";

const REF = encodeLifecycleGateRef({ runId: "run-1", reviewTaskId: "task-1" })!;
const ACTOR = { actor: { kind: "user", id: "usr_1" }, orgId: "org-1", roleHints: [] } as never;
const PENDING: LifecycleCardState = { state: "pending", canDecide: true, canComment: true };
const SETTLED: LifecycleCardState = { state: "settled", outcome: "approved" };

/** The pinned revision's content, as the content channel projects it. */
const pageContent = (system: string) => ({ kind: "json", system, address: "https://acme.example/pricing" });

function row(over: Partial<ArtifactSummary> = {}): ArtifactSummary {
  return {
    artifactId: "art-1",
    latestRepresentationRevisionId: "rev_c410a7",
    objectType: "@fixture/pages:page-snapshot",
    artifactType: "file",
    title: "Pricing — 2026 plans",
    mime: "application/json",
    originKind: "agent",
    createdAt: "2026-09-02T17:00:00.000Z",
    updatedAt: "2026-09-02T17:52:00.000Z",
    ownerLevel: "team",
    visibility: "private",
    ownerId: "team-1",
    organizationId: "org-1",
    projectId: null,
    eligibleExtensions: [],
    primaryExtension: "@fixture/pages",
    effectiveIdentity: { kind: "extension", extension: "@fixture/pages" },
    presentationIdentity: { kind: "extension", extension: "@fixture/pages" },
    presentationSuggestions: [],
    sourceUrl: null,
    ...over,
  } as ArtifactSummary;
}

const mounted = (packageName: string) => ({
  kind: "build-map",
  slot: "detail",
  packageName,
  generatedKey: `${packageName}::detail`,
  propsApiVersion: 5,
});

function seed(packageName: string, content: unknown, artifact: ArtifactSummary = row()) {
  readReviewGate.mockResolvedValue({
    id: "gate-1",
    runId: "run-1",
    reviewTaskId: "task-1",
    pinnedTargets: [{ artifactId: "art-1", representationRevisionId: "rev_c410a7" }],
  });
  readArtifactForDetail.mockReturnValue({ kind: "ok", artifact });
  readArtifactForSettledReview.mockReturnValue({ kind: "ok", artifact });
  revisionMember.mockReturnValue({ mime: "application/json", form: "file", historical: false });
  revisionMemberHistorical.mockReturnValue({ mime: "application/json", form: "file", historical: true });
  resolveMount.mockResolvedValue(mounted(packageName));
  buildProps.mockResolvedValue({ content });
}

async function header(state: LifecycleCardState = PENDING): Promise<LifecycleTargetHeader> {
  const reading = await readReviewTargetHeadersReading({
    viewType: "artifact_review_gate",
    ref: REF,
    state,
    actorCtx: ACTOR,
  });
  return reading.headers![0]!;
}

/** The card's drawn mono line, as text. */
function cardLine(h: LifecycleTargetHeader): string {
  const html = renderToStaticMarkup(ReviewTargetHeader({ header: h }));
  const meta = html.slice(html.indexOf("<p"), html.indexOf("</p>") + 4);
  return meta
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.plainLoads = 0;
  mocks.identityFacts.mockImplementation((content: unknown) => {
    const c = content as { system?: string; address?: string } | null;
    const platform = c?.system ? PLATFORMS[c.system] : undefined;
    if (!platform) return null;
    return { revision: [platform], closing: [new URL(c!.address!).host + new URL(c!.address!).pathname] };
  });
});

describe("a WordPress page and a Drupal page are told apart on the card, and only by the platform", () => {
  it("both name the renderer, and differ in the platform fact alone", async () => {
    seed("@fixture/pages", pageContent("wordpress"));
    const wordpress = await header();
    seed("@fixture/pages", pageContent("drupal"));
    const drupal = await header();

    expect(wordpress.drawnBy).toBe(RENDERER);
    expect(drupal.drawnBy).toBe(RENDERER);
    expect(wordpress.facts).toEqual(["WordPress", "Team: Growth", "Private", "acme.example/pricing"]);
    expect(drupal.facts).toEqual(["Drupal", "Team: Growth", "Private", "acme.example/pricing"]);
    expect({ ...wordpress, facts: null }).toEqual({ ...drupal, facts: null });
  });

  it("reads the identity from the PINNED revision's content, built as the card's display is handed it", async () => {
    seed("@fixture/pages", pageContent("wordpress"));
    await header();
    expect(buildProps).toHaveBeenCalledWith(
      expect.objectContaining({ representationRevisionId: "rev_c410a7", mime: "application/json", propsApiVersion: 5 }),
    );
    expect(mocks.identityFacts).toHaveBeenCalledWith(pageContent("wordpress"));
  });

  it("draws the same identity on a settled card, from the historical membership read", async () => {
    seed("@fixture/pages", pageContent("drupal"));
    const settled = await header(SETTLED);
    expect(settled.drawnBy).toBe(RENDERER);
    expect(settled.facts[0]).toBe("Drupal");
    expect(revisionMemberHistorical).toHaveBeenCalledTimes(1);
  });

  it("draws the line in the designed order on the card, for both platforms", async () => {
    seed("@fixture/pages", pageContent("wordpress"));
    expect(cardLine(await header())).toBe(
      "@fixture/pages:page-snapshot · drawn by @fixture/pages:page-diff · revision rev_c410a7 · pinned · WordPress · Team: Growth · Private · acme.example/pricing",
    );
    seed("@fixture/pages", pageContent("drupal"));
    expect(cardLine(await header())).toBe(
      "@fixture/pages:page-snapshot · drawn by @fixture/pages:page-diff · revision rev_c410a7 · pinned · Drupal · Team: Growth · Private · acme.example/pricing",
    );
  });
});

describe("a display that declares nothing composes today's header, byte for byte", () => {
  it("a dashboard revision: no renderer key, the MIME and the updated time, and its content is never read", async () => {
    const dashboard = row({ objectType: "@fixture/dashboard:dashboard", primaryExtension: "@fixture/dashboard" });
    seed("@fixture/dashboard", { kind: "json" }, dashboard);
    const composed = await header();
    expect(mocks.plainLoads).toBe(1);
    expect(buildProps).not.toHaveBeenCalled();
    expect("drawnBy" in composed).toBe(false);
    expect(JSON.stringify(composed)).toBe(
      JSON.stringify({
        title: "Pricing — 2026 plans",
        typeLabel: composed.typeLabel,
        objectType: "@fixture/dashboard:dashboard",
        revisionId: "rev_c410a7",
        facts: ["Team: Growth", "Private", "application/json", composed.facts[3]],
      }),
    );
    expect(composed.facts[3]).toMatch(/^updated /);
    // And on the wire: exactly the answer this route sent before the names.
    expect(reviewTargetHeadersWire([composed])).toEqual({ targetHeaders: [composed] });
  });

  it("a page display whose content it does not read as a page declares its renderer and no facts", async () => {
    seed("@fixture/pages", { kind: "json" });
    const composed = await header();
    expect(composed.drawnBy).toBe(RENDERER);
    expect(composed.facts.slice(2)).toEqual(["application/json", composed.facts[3]]);
  });

  it("a content read that throws costs the identity, never the header", async () => {
    seed("@fixture/pages", pageContent("wordpress"));
    buildProps.mockRejectedValue(new Error("store down"));
    const composed = await header();
    expect(composed.title).toBe("Pricing — 2026 plans");
    expect("drawnBy" in composed).toBe(false);
  });

  it("a runtime mount and a floor declare nothing and read no content", async () => {
    seed("@fixture/pages", pageContent("wordpress"));
    resolveMount.mockResolvedValue({ kind: "floor", slot: "detail", packageName: null, reason: "no-semantic-renderer" });
    expect("drawnBy" in (await header())).toBe(false);
    expect(buildProps).not.toHaveBeenCalled();
  });
});

describe("the identity is a pack's output: bounded and plain text", () => {
  it("a renderer name or a fact the identity leaf refuses declares nothing of that part", async () => {
    seed("@fixture/hostile", pageContent("wordpress"));
    const composed = await header();
    // A bidirectional control in a fact refuses the facts; the name is checked
    // apart and stands, as text.
    expect(composed.drawnBy).toBe(`<img src=x onerror=alert(1)>${"x".repeat(150)}`);
    expect(composed.facts.slice(2)).toEqual(["application/json", composed.facts[3]]);
    const html = renderToStaticMarkup(ReviewTargetHeader({ header: composed }));
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("a name or a fact past the leaf's bound is no cell, and the composed header still parses", async () => {
    seed("@fixture/too-long", pageContent("wordpress"));
    const composed = await header();
    expect("drawnBy" in composed).toBe(false);
    expect(lifecycleTargetHeadersSchema.safeParse(reviewTargetHeadersWire([composed]).targetHeaders).success).toBe(true);
  });
});

describe("the artifact page and the card draw one identity line for the same revision", () => {
  it("the page's cells and the card's line carry the same renderer and the same facts, in the same order", async () => {
    for (const system of ["wordpress", "drupal"]) {
      const content = pageContent(system);
      // The artifact page: its one decision and its identity read, over the
      // same content, through its own header builder.
      const pageIdentity = await readArtifactDisplayIdentity({
        decision: buildMapDisplayDecision(
          { generatedKey: "@fixture/pages::detail", packageName: "@fixture/pages", slot: "detail" },
          5,
        ),
        content,
        propsApiVersion: 5,
      });
      const pageCells = buildArtifactDetailHeader({
        artifact: row(),
        mime: "application/json",
        revisionId: "rev_c410a7",
        ownerName: "Growth",
        display: pageIdentity,
      }).metaCells;
      // The card: the composer over the pinned revision with the same content.
      seed("@fixture/pages", content);
      const cardCells = cardLine(await header()).split(" · ");
      // The card draws its revision marker and the pinned marker where the
      // page draws its revision cell; every other cell is the same cell.
      const withoutRevision = (cells: readonly string[]) =>
        cells.filter((cell) => !cell.startsWith("revision ") && cell !== "pinned");
      expect(withoutRevision(cardCells)).toEqual(withoutRevision(pageCells));
      expect(pageCells[1]).toBe(`drawn by ${RENDERER}`);
    }
  });
});

describe("the wire carries each renderer name beside its header", () => {
  it("an older client's strict header schema still reads the headers; a newer client folds the name back", async () => {
    seed("@fixture/pages", pageContent("drupal"));
    const composed = await header();
    const wire = reviewTargetHeadersWire([composed]);
    expect(wire.targetHeaderRenderers).toEqual([RENDERER]);
    expect(lifecycleTargetHeadersSchema.safeParse(wire.targetHeaders).success).toBe(true);
    const answer = parseLifecycleResolveEnvelope(
      "artifact_review_gate",
      JSON.parse(JSON.stringify({ kind: "artifact_review_gate", state: PENDING, body: null, ...wire, targetHeadersComplete: true })),
    );
    expect(answer!.targetHeaders![0]).toEqual(composed);
  });
});
