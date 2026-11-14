// EACH ROAD RESOLVES AT ITS OWN REVISION (cinatra#3319, acceptance 6).
//
// "The page and the review share one exported resolver, mount and failure-policy
//  primitive; a test proves that identical type, identity and mime inputs
//  resolve the same package, key and slot on both roads, the page at the latest
//  revision and the review at its pinned revision."
//
// `w4-shared-display-primitive.test.ts` proves the first half: the same
// (type, identity, mime) answers the same package, key and slot on both roads.
// This file proves the second half, which that sweep names but does not assert:
// the mime each road hands the shared resolver comes from its OWN revision. The
// review is driven through its real preparation core with the real binder's
// resolve port, for an artifact whose latest revision and pinned revision carry
// different media types that resolve to different packs; the review must answer
// what the shared resolver answers at the PINNED revision's mime, never at the
// latest one's. The page half is pinned at its source: the mime it resolves at
// is the latest revision's.
import { afterEach, describe, expect, it, vi } from "vitest";

import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import type { EffectiveIdentity } from "@cinatra-ai/objects/effective-identity";
import { registerArtifactExtensionDir } from "@cinatra-ai/objects/register-artifact-extensions";
import { matcherManifestRegistry, objectTypeRegistry } from "@cinatra-ai/objects/registry";
import {
  semanticRendererRegistry,
  representationProviderRegistry,
} from "@cinatra-ai/objects/artifact-renderer-registry";

import type { ActorContext } from "@/lib/authz/actor-context";
import type { ArtifactSummary } from "@/lib/artifacts/artifact-service";
import {
  ARTIFACT_RENDERER_PROPS_API_VERSION,
  type ArtifactRendererProps,
} from "@/lib/artifacts/artifact-renderer-props";
import {
  prepareReviewTargetsCore,
  type PrepareReviewPorts,
} from "@/lib/artifacts/artifact-review-preparation";
import { runtimeAssetRegistry } from "@/lib/artifacts/runtime-renderer-registry";

import { _resetFirstPartySeedForTests } from "../renderer-resolution";
import { resolveArtifactDisplayMount } from "../renderer-resolution";
import { bindArtifactReviewPorts } from "../review-target-prepare";

const REPO_ROOT = resolvePath(__dirname, "..", "..", "..", "..", "..");

/** The two packs whose media types tell the revisions apart. */
const FLEET = ["text-artifact", "markdown-artifact"] as const;

function registerFleet(): void {
  for (const slug of FLEET) {
    registerArtifactExtensionDir(resolvePath(REPO_ROOT, "extensions/cinatra-ai", slug));
  }
}

const ORG = "org_3319_revision_legs";
const actor = { actorType: "human", userId: "u" } as unknown as ActorContext;
const NO_WINNER: EffectiveIdentity = { kind: "no-primary" };

const ARTIFACT_ID = "art_1";
const LATEST_REVISION = "rev_latest";
const PINNED_REVISION = "rev_pinned";
/** The latest revision is plain text; the revision the gate pinned is markdown. */
const LATEST_MIME = "text/plain";
const PINNED_MIME = "text/markdown";

function artifactRow(): ArtifactSummary {
  return {
    artifactId: ARTIFACT_ID,
    objectType: "@acme/x:row",
    mime: LATEST_MIME,
    latestRepresentationRevisionId: LATEST_REVISION,
    effectiveIdentity: NO_WINNER,
    presentationIdentity: NO_WINNER,
  } as unknown as ArtifactSummary;
}

/** The page road at a given mime: the shared primitive, called as the page calls it. */
function sharedResolverAt(artifact: ArtifactSummary, mime: string) {
  return resolveArtifactDisplayMount({
    orgId: ORG,
    baseType: artifact.objectType,
    identity: artifact.presentationIdentity,
    mime,
    propsApiVersion: ARTIFACT_RENDERER_PROPS_API_VERSION,
  });
}

function identityOf(mount: {
  kind: string;
  slot?: unknown;
  packageName?: string | null;
  generatedKey?: string;
}) {
  return {
    kind: mount.kind,
    packageName: mount.packageName ?? null,
    generatedKey: mount.generatedKey ?? null,
    slot: mount.slot ?? null,
  };
}

afterEach(() => {
  for (const slug of FLEET) {
    objectTypeRegistry.removeByPackage("@cinatra-ai/" + slug);
    matcherManifestRegistry.removeByPackage("@cinatra-ai/" + slug);
  }
  semanticRendererRegistry._clearForTests();
  representationProviderRegistry._clearForTests(true);
  runtimeAssetRegistry._clearForTests();
  _resetFirstPartySeedForTests();
});

describe("acceptance 6 - the review resolves at its pinned revision", () => {
  it("the review answers what the shared resolver answers at the PINNED mime, not the latest", async () => {
    registerFleet();
    const artifact = artifactRow();

    // PRECONDITION: the two revisions' media types resolve to two different
    // packs, so a review that read the latest revision could not pass below.
    const atLatest = await sharedResolverAt(artifact, LATEST_MIME);
    const atPinned = await sharedResolverAt(artifact, PINNED_MIME);
    expect(identityOf(atLatest)).toEqual({
      kind: "build-map",
      packageName: "@cinatra-ai/text-artifact",
      generatedKey: "@cinatra-ai/text-artifact::detail",
      slot: "detail",
    });
    expect(identityOf(atPinned)).toEqual({
      kind: "build-map",
      packageName: "@cinatra-ai/markdown-artifact",
      generatedKey: "@cinatra-ai/markdown-artifact::detail",
      slot: "detail",
    });

    // THE REVIEW ROAD: the real preparation core, with the real binder's resolve
    // port. Only the store reads are stubbed, and they answer each revision's
    // own media type.
    const binder = bindArtifactReviewPorts({ orgId: ORG, actor });
    const resolveMount = vi.fn(binder.resolveMount);
    const revisionMember = vi.fn((_artifactId: string, revisionId: string) =>
      revisionId === PINNED_REVISION
        ? { mime: PINNED_MIME }
        : revisionId === LATEST_REVISION
          ? { mime: LATEST_MIME }
          : null,
    );
    const target = { artifactId: ARTIFACT_ID, representationRevisionId: PINNED_REVISION };
    const ports: PrepareReviewPorts = {
      verifyRunAccess: async () => ({ ok: true }),
      readGatePinnedTargets: async () => ({ status: "pending", targets: [target] }),
      readArtifact: () => ({ kind: "ok", artifact }),
      revisionMember,
      resolveMount,
      buildProps: () => ({ propsApiVersion: 1 }) as unknown as ArtifactRendererProps,
    };

    const result = await prepareReviewTargetsCore(
      { runId: "run", reviewTaskId: "wayflow-t", targets: [target] },
      ports,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [prepared] = result.prepared;

    // The review read the pinned revision and never the latest one ...
    expect(revisionMember).toHaveBeenCalledWith(ARTIFACT_ID, PINNED_REVISION);
    expect(revisionMember).not.toHaveBeenCalledWith(ARTIFACT_ID, LATEST_REVISION);
    // ... handed the shared resolver the pinned revision's mime ...
    expect(resolveMount).toHaveBeenCalledTimes(1);
    expect(resolveMount.mock.calls[0][0].mime).toBe(PINNED_MIME);
    // ... and mounts exactly what the shared resolver answers at that mime.
    expect(identityOf(prepared.mount)).toEqual(identityOf(atPinned));
    expect(identityOf(prepared.mount)).not.toEqual(identityOf(atLatest));
  });
});

describe("acceptance 6 - the page resolves at the latest revision", () => {
  function stripComments(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  }
  const page = stripComments(
    readFileSync(resolvePath(REPO_ROOT, "src/app/artifacts/[id]/page.tsx"), "utf8"),
  );

  it("the page's revision is the artifact's latest, and its mime is that revision's", () => {
    expect(page).toMatch(
      /const revisionId = await resolveEditorRevisionId\(\s*orgId,\s*id,\s*artifact\.latestRepresentationRevisionId,?\s*\)/,
    );
    expect(page).toMatch(/const mime = resolved\?\.mime\b/);
  });

  it("the page hands the shared resolver that mime, and reads no gate-pinned revision", () => {
    const call = page.match(/resolveArtifactDisplayMount\(\{[\s\S]*?\}\)/);
    expect(call, "the page calls the shared resolver").not.toBeNull();
    expect(call![0]).toMatch(/\bmime\b/);
    expect(call![0]).not.toMatch(/\bmime\s*:/);
    expect(page).not.toMatch(/\breadGatePinnedTargets\b/);
    expect(page).not.toMatch(/\brevisionMemberHistorical\b/);
  });
});
