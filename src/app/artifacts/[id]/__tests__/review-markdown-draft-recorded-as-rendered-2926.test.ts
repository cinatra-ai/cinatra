/**
 * A MARKDOWN DRAFT IN REVIEW IS DRAWN BY ITS EXTENSION AND RECORDED AS RENDERED,
 * NEVER AS A FALLBACK (cinatra#2926, plan section 6 row 25).
 *
 * The plan's sentence: "a markdown draft in review is rendered through its text
 * rung on all four hosts, recorded as rendered, never a fallback". Since the text
 * rung retired (cinatra#3319), a markdown draft resolves to the markdown
 * extension's own `detail` display, so the sentence reads: the review road
 * resolves that display, the display draws the draft, and the audit row a
 * decision commits records the draft as drawn by it.
 *
 * WHAT WAS MISSING. `w4-dispatch-matrix.test.ts` pins the resolve-time half (the
 * review road answers `build-map` and the markdown package for a typed and a
 * representation-only markdown row), and the gate store suite pins that the audit
 * table accepts a row. Nothing drove a markdown target through
 * `provenanceFromResolvedMount` into the row a decision writes.
 *
 * WHAT THIS FILE DRIVES, ALL OF IT REAL:
 *   1. the review road's `resolveMount` over the installed fleet (the matrix's own);
 *   2. the markdown extension's display, loaded THROUGH the build map by the key
 *      the mount names and drawn with the props the host itself builds, on the
 *      read-only review surface;
 *   3. `submitReviewDecision`: the actual port binder, whose `deriveProvenance`
 *      re-resolves the mount at submit time and maps it with
 *      `provenanceFromResolvedMount`, and the decision core that builds the commit
 *      plan around it.
 * The audit row is read off that commit plan. `commitReviewDecision` writes
 * `plan.auditRows[].rendererProvenance` into `renderer_kind`, `renderer_package`
 * and `renderer_digest` as they stand (packages/agents/src/artifact-review-gate-
 * store.ts), so the plan IS the row; the real table accepting it is the gate
 * store integration suite's "APPROVE: a markdown draft ..." arm, which runs
 * against a real database.
 *
 * THE SEAMS REPLACED are the ones with no bearing on the claim: the gate store
 * (run access, the pending gate, the commit, which is captured), and the two
 * artifact reads that need a database (the artifact row and the revision's
 * member). The resolution, the display, the binder and the core are not.
 *
 * "ON ALL FOUR HOSTS" IS NOT PROVED HERE. Which host draws a card is a rendered
 * observation, owned by cinatra#2936; this file proves the part a fixture can
 * show: the resolution, the drawing and the recording are one chain.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolve as resolvePath } from "node:path";

import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import type { EffectiveIdentity } from "@cinatra-ai/objects/effective-identity";
import { registerArtifactExtensionDir } from "@cinatra-ai/objects/register-artifact-extensions";
import { matcherManifestRegistry, objectTypeRegistry } from "@cinatra-ai/objects/registry";
import {
  semanticRendererRegistry,
  representationProviderRegistry,
} from "@cinatra-ai/objects/artifact-renderer-registry";
import { ARTIFACT_CONTENT_CHANNEL_CAPS } from "@cinatra-ai/sdk-extensions/artifact-content-channel";

import type { ArtifactSummary } from "@/lib/artifacts/artifact-service";
import {
  ARTIFACT_CONTENT_CHANNEL_VERSION,
  ARTIFACT_RENDERER_PROPS_API_VERSION,
  buildArtifactRendererProps,
  readOnlyArtifactEdit,
  type ArtifactRendererProps,
} from "@/lib/artifacts/artifact-renderer-props";
import { artifactReviewGateSchemaQueries } from "@/lib/artifacts/artifact-review-gate-schema";
import {
  ARTIFACT_REVIEW_DECISION_API_VERSION,
  type ArtifactReviewDecision,
  type ReviewDecisionCommitPlan,
  type ReviewDisposition,
} from "@/lib/artifacts/artifact-review-decision";
import { runtimeAssetRegistry } from "@/lib/artifacts/runtime-renderer-registry";
import { GENERATED_ARTIFACT_RENDERERS } from "@/lib/generated/artifact-renderers";

import { _resetFirstPartySeedForTests } from "../renderer-resolution";
import { bindArtifactReviewPorts } from "../review-target-prepare";
import { submitReviewDecision, type ReviewActorContext } from "../review-gate-ports";

// The gate store is the one seam this file replaces wholesale: run access, the
// pending gate the decision is taken against, and the atomic commit, whose plan
// is what the assertions read.
vi.mock("@cinatra-ai/agents/artifact-review-gate-store", () => ({
  readGatePinnedTargets: vi.fn(),
  readReviewGate: vi.fn(),
  readReviewGateState: vi.fn(),
  commitReviewDecision: vi.fn(),
  enforceReviewRunAccess: vi.fn(),
}));
vi.mock("@cinatra-ai/agents/lifecycle-repair-store", () => ({
  readRepairBySuccessorGateId: vi.fn(),
}));
vi.mock("@/lib/artifacts/cms-preview-capture-store", () => ({
  readPinnedPreviewCaptures: vi.fn(),
}));

// The two artifact reads that need a database. Everything else in those two
// modules stays as it is.
const reads = vi.hoisted(() => ({
  readArtifactForDetail: vi.fn(),
  resolveArtifactVersionForServe: vi.fn(),
}));
vi.mock("@/lib/artifacts/artifact-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/artifacts/artifact-service")>()),
  readArtifactForDetail: reads.readArtifactForDetail,
}));
vi.mock("@/lib/artifacts/artifact-read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/artifacts/artifact-read")>()),
  resolveArtifactVersionForServe: reads.resolveArtifactVersionForServe,
  resolveNonFileArtifactRevision: () => null,
}));

import {
  commitReviewDecision,
  enforceReviewRunAccess,
  readReviewGateState,
} from "@cinatra-ai/agents/artifact-review-gate-store";

const REPO_ROOT = resolvePath(__dirname, "..", "..", "..", "..", "..");

/** The installed fleet the dispatch matrix registers: the typed rows resolve
 *  through the semantic rung, which reads the registry the installed fleet
 *  writes, so this file registers the same real packs rather than inventing
 *  registrations. */
const FLEET = [
  "text-artifact",
  "markdown-artifact",
  "json-artifact",
  "binary-artifact",
  "image-artifact",
  "pdf-artifact",
  "dashboard-artifact",
  "drupal-artifacts",
  "blog-post-artifact",
  "linkedin-artifacts",
  "blog-idea-artifact",
] as const;

function registerFleet(): void {
  for (const slug of FLEET) {
    registerArtifactExtensionDir(resolvePath(REPO_ROOT, "extensions/cinatra-ai", slug));
  }
}

const MARKDOWN_PACKAGE = "@cinatra-ai/markdown-artifact";
const MARKDOWN_DETAIL_KEY = `${MARKDOWN_PACKAGE}::detail`;

const ORG = "org_2926_row25";
const RUN_ID = "run_2926_row25";
const REVIEW_TASK_ID = "wayflow-2926-row25";
const ARTIFACT_ID = "art_md_draft_1";
const REVISION_ID = "rev_md_draft_1";
const TARGET = { artifactId: ARTIFACT_ID, representationRevisionId: REVISION_ID };

const actor = { actorType: "human", userId: "u_reviewer", source: "route" } as unknown as PrimitiveActorContext;
const actorCtx: ReviewActorContext = { actor, orgId: ORG };

const NO_WINNER: EffectiveIdentity = { kind: "no-primary" };
const winner = (extension: string): EffectiveIdentity => ({ kind: "extension", extension });

const DOCUMENT = "# Launch notes\n\nThe **bold claim** ships with `inline code`.\n";

function draft(objectType: string, identity: EffectiveIdentity, mime: string): ArtifactSummary {
  return {
    artifactId: ARTIFACT_ID,
    latestRepresentationRevisionId: REVISION_ID,
    objectType,
    artifactType: objectType,
    title: "launch-notes.md",
    mime,
    size: new TextEncoder().encode(DOCUMENT).byteLength,
    originKind: "upload",
    createdAt: "2026-11-18T10:00:00.000Z",
    updatedAt: "2026-11-18T10:00:00.000Z",
    ownerLevel: "organization",
    ownerId: null,
    organizationId: ORG,
    projectId: null,
    visibility: "organization",
    eligibleExtensions: [],
    primaryExtension: null,
    effectiveIdentity: identity,
    presentationIdentity: identity,
    presentationSuggestions: [],
    sourceUrl: null,
  };
}

/** The markdown drafts a review meets: typed by the markdown pack, typed by the
 *  legacy spelling's pack, filed with no winner at all (the media type alone has
 *  to find a display), and a blog post, which is a markdown draft whose own pack
 *  ships no display. All four answer the markdown extension's display. */
const DRAFTS: ReadonlyArray<{
  label: string;
  objectType: string;
  identity: EffectiveIdentity;
  mime: string;
}> = [
  {
    label: "a typed text/markdown draft",
    objectType: `${MARKDOWN_PACKAGE}:artifact`,
    identity: winner(MARKDOWN_PACKAGE),
    mime: "text/markdown",
  },
  {
    label: "a typed text/x-markdown draft",
    objectType: `${MARKDOWN_PACKAGE}:artifact`,
    identity: winner(MARKDOWN_PACKAGE),
    mime: "text/x-markdown",
  },
  {
    label: "a representation-only text/markdown draft",
    objectType: "@acme/x:row",
    identity: NO_WINNER,
    mime: "text/markdown",
  },
  {
    label: "a blog post draft (typed by a pack that ships no display)",
    objectType: "@cinatra-ai/blog-post-artifact:post",
    identity: winner("@cinatra-ai/blog-post-artifact"),
    mime: "text/markdown",
  },
];

/** The audit table's own vocabulary, read from the bootstrap DDL. */
function admittedRendererKinds(): string[] {
  const bootstrap = artifactReviewGateSchemaQueries("cinatra")
    .map((q) => q.text)
    .join("\n");
  const check = /renderer_kind\s+text NOT NULL CHECK \(renderer_kind IN \(([^)]*)\)\)/.exec(bootstrap);
  expect(check).not.toBeNull();
  return check![1].split(",").map((s) => s.trim().replace(/'/g, ""));
}

/** What the review road resolves for the draft at the host's ceiling. */
function reviewRoadMount(artifact: ArtifactSummary) {
  const { resolveMount } = bindArtifactReviewPorts({ orgId: ORG, actor: {} as never });
  return Promise.resolve(
    resolveMount({
      artifact,
      mime: artifact.mime,
      propsApiVersion: ARTIFACT_RENDERER_PROPS_API_VERSION,
    }),
  );
}

/** The markup the markdown display draws for the draft on the review surface:
 *  loaded through the build map by the key the mount names, with the props the
 *  host builds at the version the display declared. A review target is read-only,
 *  and the display opens on its rendered Preview there. */
async function drawnBy(generatedKey: string, artifact: ArtifactSummary): Promise<string> {
  const entry = GENERATED_ARTIFACT_RENDERERS[generatedKey];
  expect(entry?.resolution).toBe("required");
  const mod = (await entry!.load()) as { default?: unknown };
  expect(typeof mod.default).toBe("function");
  const Display = mod.default as ComponentType<ArtifactRendererProps>;
  const byteLength = new TextEncoder().encode(DOCUMENT).byteLength;
  const props = buildArtifactRendererProps({
    artifact,
    representation: { revisionId: REVISION_ID, mime: artifact.mime },
    previewHref: null,
    downloadHref: `/api/artifacts/${ARTIFACT_ID}/versions/${REVISION_ID}/content`,
    propsApiVersion: entry!.propsApiVersion,
    content: {
      kind: "text",
      channelVersion: ARTIFACT_CONTENT_CHANNEL_VERSION,
      representationRevisionId: REVISION_ID,
      text: DOCUMENT,
      encoding: "utf-8",
      byteLength,
      projectedByteLength: byteLength,
      cap: ARTIFACT_CONTENT_CHANNEL_CAPS.text,
      truncated: false,
    },
    edit: readOnlyArtifactEdit("read-only-surface"),
    review: { reading: "pending", openLive: null },
  });
  return renderToStaticMarkup(createElement(Display, props));
}

function decisionFor(disposition: ReviewDisposition): ArtifactReviewDecision {
  return {
    decisionApiVersion: ARTIFACT_REVIEW_DECISION_API_VERSION,
    runId: RUN_ID,
    reviewTaskId: REVIEW_TASK_ID,
    disposition,
    comment: disposition === "comment" ? "Tighten the opening." : null,
    reviewedTargets: [TARGET],
  };
}

/** The one commit the decision made, as the store would have received it. */
function committedPlan(): ReviewDecisionCommitPlan {
  const calls = vi.mocked(commitReviewDecision).mock.calls;
  expect(calls).toHaveLength(1);
  return calls[0]![0];
}

beforeEach(() => {
  vi.mocked(enforceReviewRunAccess).mockResolvedValue({ ok: true });
  vi.mocked(readReviewGateState).mockResolvedValue({ status: "pending", targets: [TARGET] });
  vi.mocked(commitReviewDecision).mockResolvedValue({ status: "committed" });
});

afterEach(() => {
  for (const slug of FLEET) {
    objectTypeRegistry.removeByPackage("@cinatra-ai/" + slug);
    matcherManifestRegistry.removeByPackage("@cinatra-ai/" + slug);
  }
  semanticRendererRegistry._clearForTests();
  representationProviderRegistry._clearForTests(true);
  runtimeAssetRegistry._clearForTests();
  _resetFirstPartySeedForTests();
  vi.mocked(enforceReviewRunAccess).mockReset();
  vi.mocked(readReviewGateState).mockReset();
  vi.mocked(commitReviewDecision).mockReset();
  reads.readArtifactForDetail.mockReset();
  reads.resolveArtifactVersionForServe.mockReset();
});

/** Make the draft the row the artifact reads answer, at the mime it carries. */
function seedDraft(artifact: ArtifactSummary): void {
  reads.readArtifactForDetail.mockReturnValue({ kind: "ok", artifact });
  reads.resolveArtifactVersionForServe.mockReturnValue({
    storageKey: "blobs/draft",
    mime: artifact.mime,
    sizeBytes: artifact.size,
    originKind: "upload",
  });
}

describe("cinatra#2926 row 25 — a markdown draft is resolved, drawn and recorded as rendered", () => {
  it.each(DRAFTS)("$label", async ({ objectType, identity, mime }) => {
    registerFleet();
    const artifact = draft(objectType, identity, mime);
    seedDraft(artifact);

    // 1. THE REVIEW ROAD RESOLVES THE EXTENSION'S DISPLAY, not a floor.
    const mount = await reviewRoadMount(artifact);
    expect(mount.kind).toBe("build-map");
    if (mount.kind !== "build-map") return;
    expect(mount.packageName).toBe(MARKDOWN_PACKAGE);
    expect(mount.generatedKey).toBe(MARKDOWN_DETAIL_KEY);

    // 2. THE DISPLAY THE MOUNT NAMES DRAWS THE DRAFT, as rendered markdown.
    const markup = await drawnBy(mount.generatedKey, artifact);
    expect(markup).toContain('data-artifact-renderer="markdown"');
    // On the review surface: read-only, opening on the rendered document.
    expect(markup).toContain('data-read-only-reason="read-only-surface"');
    expect(markup).toContain('data-panel="preview"');
    // The heading's level is the display's own business (it demotes the
    // document's headings under the page shell), so the level is not pinned.
    expect(markup).toMatch(/<h([1-6])[^>]*>\s*Launch notes\s*<\/h\1>/);
    expect(markup).toContain("<strong>bold claim</strong>");
    expect(markup).not.toContain("**bold claim**");

    // 3. THE DECISION RECORDS THE DRAFT AS DRAWN BY THAT DISPLAY.
    const result = await submitReviewDecision({ decision: decisionFor("approve"), actorCtx });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.idempotent).toBe(false);

    const plan = committedPlan();
    expect(plan.disposition).toBe("approve");
    expect(plan.auditRows).toHaveLength(1);
    const row = plan.auditRows[0]!;
    expect(row.artifactId).toBe(ARTIFACT_ID);
    expect(row.representationRevisionId).toBe(REVISION_ID);
    expect(row.disposition).toBe("approve");

    // RECORDED AS RENDERED, NEVER A FALLBACK: the kind the extension's display
    // earns, the package that drew it, and no digest (a runtime load's alone).
    expect(row.rendererProvenance).toStrictEqual({
      kind: "build-map",
      packageName: MARKDOWN_PACKAGE,
      digest: null,
    });
    expect(row.rendererProvenance.kind).not.toBe("floor");
    expect(row.rendererProvenance.kind).not.toBe("first-party");

    // The row records the display the card drew: the one package, end to end.
    expect(row.rendererProvenance.packageName).toBe(mount.packageName);

    // And it is a kind the audit table's own CHECK admits, so the commit does
    // not roll the decision back.
    expect(admittedRendererKinds()).toContain(row.rendererProvenance.kind);
  });

  it("a comment on the draft records it as rendered too: every disposition's audit row carries the provenance", async () => {
    registerFleet();
    const artifact = draft(`${MARKDOWN_PACKAGE}:artifact`, winner(MARKDOWN_PACKAGE), "text/markdown");
    seedDraft(artifact);

    const result = await submitReviewDecision({ decision: decisionFor("comment"), actorCtx });
    expect(result.ok).toBe(true);

    const plan = committedPlan();
    expect(plan.disposition).toBe("comment");
    expect(plan.terminal).toBe(false);
    expect(plan.auditRows.map((r) => r.rendererProvenance)).toStrictEqual([
      { kind: "build-map", packageName: MARKDOWN_PACKAGE, digest: null },
    ]);
  });
});

describe("cinatra#2926 row 25 — the fixture tells a drawn draft from a fallback", () => {
  // THE CONTROL. A markdown draft can never be the floor on this road: the
  // markdown pack is a build-time SYSTEM extension (its build-map entry is
  // `resolution: "required"`), and the host binds every system base's
  // representation provider for every org each time it resolves, with the
  // installed fleet registered or not. So "no installed pack" cannot turn a
  // markdown draft into a floor, and a control that asked for that would be
  // asserting something the product rightly never does. What the floor gate
  // counts is a draft NOTHING draws: the row the dispatch matrix pins, an untyped
  // row whose media type no system base binds a provider for
  // (`application/octet-stream` is not a safe-transport form). It resolves to a
  // floor that names the package its type names. If the recording did not follow
  // the resolution (always build-map, or always a fixed package) the cases above
  // would pass for the wrong reason, and this one would not.
  it("a draft nothing draws is recorded as a floor, and is not the markdown extension's display", async () => {
    registerFleet();
    const artifact = draft("@acme/x:row", NO_WINNER, "application/octet-stream");
    seedDraft(artifact);

    const mount = await reviewRoadMount(artifact);
    expect(mount.kind).toBe("floor");

    const result = await submitReviewDecision({ decision: decisionFor("approve"), actorCtx });
    expect(result.ok).toBe(true);

    const [row] = committedPlan().auditRows;
    expect(row!.rendererProvenance).toStrictEqual({
      kind: "floor",
      packageName: "@acme/x",
      digest: null,
    });
    expect(row!.rendererProvenance.packageName).not.toBe(MARKDOWN_PACKAGE);
  });
});
