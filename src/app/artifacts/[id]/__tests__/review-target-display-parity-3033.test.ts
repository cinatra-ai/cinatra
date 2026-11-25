// THE DISPLAY THE REVIEW ANSWER NAMES IS THE DISPLAY THE PREVIEW MOUNTS
// (cinatra#3033).
//
// The review card claims a design reading from the display that draws its one
// target: the post's reading needs the markdown display, the picture's the image
// display. The server names that display beside the resolve answer
// (`onlyTargetDisplay`, sent as `targetDisplay`). A media type alone does not say
// which display draws a target: an extension artifact whose pack ships its own
// detail renderer is drawn by THAT renderer, whatever its media type.
//
// So each case below is driven twice, both times through the REAL dispatch and
// the REAL review binder, with only the stores beneath them answered by fakes:
//   - the EXPECTED side is the mount the preview's own resolution answers for the
//     target (the module that draws it, read off the mount);
//   - the ACTUAL side is the value the server's header reading names for the
//     same pinned target.
// The two must agree on every case.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-lifecycle-refs";

import type { EffectiveIdentity } from "@cinatra-ai/objects/effective-identity";

const store = vi.hoisted(() => ({
  artifact: null as Record<string, unknown> | null,
  mime: "text/markdown",
}));

vi.mock("@cinatra-ai/agents/artifact-review-gate-store", () => ({
  readReviewGate: async () => ({
    id: "gate-1",
    runId: "run-1",
    reviewTaskId: "task-1",
    pinnedTargets: [{ artifactId: "art_1", representationRevisionId: "rev_1" }],
  }),
}));

vi.mock("@/lib/artifacts/artifact-service", () => ({
  readArtifactForDetail: () => ({ kind: "ok", artifact: store.artifact }),
  readArtifactForSettledReview: () => ({ kind: "ok", artifact: store.artifact }),
}));

vi.mock("@/lib/artifacts/artifact-read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/artifacts/artifact-read")>()),
  resolveArtifactVersionForServe: () => ({ mime: store.mime }),
  resolveNonFileArtifactRevision: () => null,
}));

vi.mock("@/lib/authz/build-actor-context", () => ({
  buildActorContextFromPrimitive: () => ({ actorType: "human", userId: "u", organizationId: ORG }),
}));

vi.mock("@/lib/owner-display-names", () => ({ readOwnerDisplayName: async () => null }));

import {
  semanticRendererRegistry,
  representationProviderRegistry,
} from "@cinatra-ai/objects/artifact-renderer-registry";

import type { ActorContext } from "@/lib/authz/actor-context";
import type { ArtifactSummary } from "@/lib/artifacts/artifact-service";
import { ARTIFACT_RENDERER_PROPS_API_VERSION } from "@/lib/artifacts/artifact-renderer-props";
import { runtimeAssetRegistry } from "@/lib/artifacts/runtime-renderer-registry";
import { encodeLifecycleGateRef } from "@/lib/lifecycle/lifecycle-card-ref";
import { readReviewTargetHeadersReading } from "@/lib/lifecycle/lifecycle-target-headers";

import { _resetFirstPartySeedForTests } from "../renderer-resolution";
import { bindArtifactReviewPorts } from "../review-target-prepare";

const ORG = "org_3033_display";
const actor = { actorType: "human", userId: "u" } as unknown as ActorContext;
const NO_WINNER: EffectiveIdentity = { kind: "no-primary" };
const winner = (extension: string): EffectiveIdentity => ({ kind: "extension", extension });

function summary(objectType: string, identity: EffectiveIdentity): ArtifactSummary {
  return {
    artifactId: "art_1",
    title: "The target",
    objectType,
    effectiveIdentity: identity,
    presentationIdentity: identity,
    ownerLevel: "user",
    visibility: "private",
    mime: "application/octet-stream",
    updatedAt: "2026-11-25T00:00:00.000Z",
  } as unknown as ArtifactSummary;
}

/** THE MODULE THAT DRAWS THE TARGET, as the tests name it. Only the two host
 *  displays the readings depend on are named; everything else is another
 *  display. */
const DRAWN_BY: Record<string, "markdown" | "image"> = {
  "@cinatra-ai/markdown-artifact::detail": "markdown",
  "@cinatra-ai/image-artifact::detail": "image",
};

type Case = {
  label: string;
  objectType: string;
  identity: EffectiveIdentity;
  mime: string;
  /** A pack's own detail renderer, registered for the row's type. */
  semantic?: string;
  /** The module the real dispatch must mount (null = a floor). */
  mounts: string | null;
  display: "markdown" | "image" | "other";
};

const CASES: readonly Case[] = [
  {
    label: "an extension artifact with its own detail renderer and markdown content",
    objectType: "@cinatra-ai/website-artifacts:page",
    identity: winner("@cinatra-ai/website-artifacts"),
    mime: "text/markdown",
    semantic: "@cinatra-ai/website-artifacts",
    mounts: "@cinatra-ai/website-artifacts::detail",
    display: "other",
  },
  {
    label: "a plain markdown artifact",
    objectType: "@acme/x:row",
    identity: NO_WINNER,
    mime: "text/markdown",
    mounts: "@cinatra-ai/markdown-artifact::detail",
    display: "markdown",
  },
  {
    label: "a plain markdown artifact under the legacy spelling",
    objectType: "@acme/x:row",
    identity: NO_WINNER,
    mime: "text/x-markdown",
    mounts: "@cinatra-ai/markdown-artifact::detail",
    display: "markdown",
  },
  {
    label: "a markdown artifact typed by the markdown pack itself",
    objectType: "@cinatra-ai/markdown-artifact:artifact",
    identity: winner("@cinatra-ai/markdown-artifact"),
    mime: "text/markdown",
    semantic: "@cinatra-ai/markdown-artifact",
    mounts: "@cinatra-ai/markdown-artifact::detail",
    display: "markdown",
  },
  {
    label: "an image drawn by the image display",
    objectType: "@acme/x:row",
    identity: NO_WINNER,
    mime: "image/png",
    mounts: "@cinatra-ai/image-artifact::detail",
    display: "image",
  },
  {
    label: "an image drawn by a pack's own renderer",
    objectType: "@cinatra-ai/screenshot-artifact:screenshot",
    identity: winner("@cinatra-ai/screenshot-artifact"),
    mime: "image/png",
    semantic: "@cinatra-ai/screenshot-artifact",
    mounts: "@cinatra-ai/screenshot-artifact::detail",
    display: "other",
  },
  {
    label: "a PDF drawn by the PDF display",
    objectType: "@acme/x:row",
    identity: NO_WINNER,
    mime: "application/pdf",
    mounts: "@cinatra-ai/pdf-artifact::detail",
    display: "other",
  },
  {
    label: "a target nothing installed draws",
    objectType: "@acme/x:row",
    identity: NO_WINNER,
    mime: "application/octet-stream",
    mounts: null,
    display: "other",
  },
];

beforeEach(() => {
  store.artifact = null;
});

afterEach(() => {
  semanticRendererRegistry._clearForTests();
  representationProviderRegistry._clearForTests(true);
  runtimeAssetRegistry._clearForTests();
  _resetFirstPartySeedForTests();
});

describe("cinatra#3033 — the display the server names is the display the preview mounts", () => {
  it.each(CASES)("$label", async (c) => {
    if (c.semantic) semanticRendererRegistry.register({ objectTypeId: c.objectType, packageName: c.semantic });
    const artifact = summary(c.objectType, c.identity);
    store.artifact = artifact as unknown as Record<string, unknown>;
    store.mime = c.mime;

    // EXPECTED: what the preview's own resolution mounts for this target.
    const mount = (await bindArtifactReviewPorts({ orgId: ORG, actor }).resolveMount({
      artifact,
      mime: c.mime,
      propsApiVersion: ARTIFACT_RENDERER_PROPS_API_VERSION,
    })) as { kind: string; generatedKey?: string };
    expect(mount.kind === "floor" ? null : mount.generatedKey).toBe(c.mounts);
    const drawnBy = (mount.kind === "build-map" && mount.generatedKey && DRAWN_BY[mount.generatedKey]) || "other";
    expect(drawnBy).toBe(c.display);

    // ACTUAL: what the server's reading names for the same pinned target.
    const reading = await readReviewTargetHeadersReading({
      viewType: "artifact_review_gate",
      ref: encodeLifecycleGateRef({ runId: "run-1", reviewTaskId: "task-1" })!,
      state: { state: "pending", canDecide: true, canComment: true },
      actorCtx: { actor: { kind: "user", id: "u" }, orgId: ORG, roleHints: [] } as never,
    });
    expect(reading.complete).toBe(true);
    expect(reading.onlyTargetDisplay).toBe(drawnBy);
  });
});
