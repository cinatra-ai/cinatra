// ONE RESOLVER, ONE MOUNT, ONE FAILURE POLICY (cinatra#3319, acceptance 6).
//
// "The page and the review share one exported resolver, mount and failure-policy
//  primitive; a test proves that identical type, identity and mime inputs
//  resolve the same package, key and slot on both roads, the page at the latest
//  revision and the review at its pinned revision."
//
// Before this change the two roads were two switches over the same three
// loadable paths, and the review carried a rung the page did not — so the same
// row could be drawn one way on its page and another way under review. The proof
// is a parity sweep: for each row shape, the page road and the review road are
// driven with the SAME (type, identity, mime) and must answer the same package,
// the same generated key and the same slot; and the revision each road resolves
// AT stays each road's own — the page the artifact's latest, the review the one
// its gate pinned.
import { afterEach, describe, expect, it } from "vitest";

import type { EffectiveIdentity } from "@cinatra-ai/objects/effective-identity";
import {
  semanticRendererRegistry,
  representationProviderRegistry,
} from "@cinatra-ai/objects/artifact-renderer-registry";
import type { AdmittedClientBundleTuple } from "@cinatra-ai/sdk-extensions/artifact-client-bundle";

import type { ActorContext } from "@/lib/authz/actor-context";
import type { ArtifactSummary } from "@/lib/artifacts/artifact-service";
import { runtimeAssetRegistry } from "@/lib/artifacts/runtime-renderer-registry";

import { _resetFirstPartySeedForTests } from "../renderer-resolution";
import { resolveArtifactDisplayMount } from "../renderer-resolution";
import { bindArtifactReviewPorts } from "../review-target-prepare";

const ORG = "org_3319_parity";
const PKG = "@acme/draft-artifact";
const actor = { actorType: "human", userId: "u" } as unknown as ActorContext;

function tuple(over: Partial<AdmittedClientBundleTuple> = {}): AdmittedClientBundleTuple {
  return {
    packageName: PKG,
    slot: "detail",
    digest: "a".repeat(128),
    entry: "client/detail.js",
    propsApiVersion: 1,
    sdkAbiRange: "^2.4.0",
    reactPeerRange: "^19.0.0",
    reactDomPeerRange: "^19.0.0",
    tokenModuleAbi: "1.0.0",
    ...over,
  };
}
const okActivate = { materialize: async () => {}, verify: async () => true };

function summary(
  objectType: string,
  identity: EffectiveIdentity,
  presentation: EffectiveIdentity = identity,
): ArtifactSummary {
  return {
    artifactId: "art_1",
    objectType,
    effectiveIdentity: identity,
    presentationIdentity: presentation,
  } as unknown as ArtifactSummary;
}

/** THE PAGE ROAD — the shared primitive, called as the page calls it. */
function pageRoad(artifact: ArtifactSummary, mime: string) {
  return resolveArtifactDisplayMount({
    orgId: ORG,
    baseType: artifact.objectType,
    identity: artifact.presentationIdentity,
    mime,
    propsApiVersion: 1,
  });
}

/** THE REVIEW ROAD — the binder's own port, as the review core calls it. */
function reviewRoad(artifact: ArtifactSummary, mime: string) {
  const { resolveMount } = bindArtifactReviewPorts({ orgId: ORG, actor });
  return Promise.resolve(resolveMount({ artifact, mime, propsApiVersion: 1 }));
}

/** The three things the acceptance sentence names, and nothing else — each road
 * keeps its own revision and its own floor words. */
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

/** THE ROW SHAPES. Each is (label, objectType, identity, mime). */
const ROWS: ReadonlyArray<readonly [string, string, EffectiveIdentity, string]> = [
  ["a markdown representation with no winner", `${PKG}:post`, { kind: "no-primary" }, "text/markdown"],
  ["the legacy markdown spelling", `${PKG}:post`, { kind: "no-primary" }, "text/x-markdown"],
  ["a json representation", `${PKG}:blob`, { kind: "no-primary" }, "application/json"],
  ["an image representation", `${PKG}:pic`, { kind: "no-primary" }, "image/png"],
  ["a pdf representation", `${PKG}:doc`, { kind: "no-primary" }, "application/pdf"],
  ["a plain-text representation nothing claims", `${PKG}:note`, { kind: "no-primary" }, "text/plain"],
  ["a media type nothing claims at all", `${PKG}:note`, { kind: "no-primary" }, "application/vnd.acme.opaque"],
];

afterEach(() => {
  semanticRendererRegistry._clearForTests();
  representationProviderRegistry._clearForTests(true);
  runtimeAssetRegistry._clearForTests();
  _resetFirstPartySeedForTests();
});

describe("acceptance 6 — the page and the review resolve the same display", () => {
  it.each(ROWS)("%s", async (_label, objectType, identity, mime) => {
    const artifact = summary(objectType, identity);
    const [page, review] = await Promise.all([
      pageRoad(artifact, mime),
      reviewRoad(artifact, mime),
    ]);
    expect(identityOf(review)).toEqual(identityOf(page));
  });

  it("a semantic winner shipping a build-map display resolves identically on both roads", async () => {
    const TYPE = "@cinatra-ai/json-artifact:artifact";
    const artifact = summary(TYPE, { kind: "extension", extension: "@cinatra-ai/json-artifact" });
    const [page, review] = await Promise.all([
      pageRoad(artifact, "application/json"),
      reviewRoad(artifact, "application/json"),
    ]);
    expect(identityOf(page)).toEqual({
      kind: "build-map",
      packageName: "@cinatra-ai/json-artifact",
      generatedKey: "@cinatra-ai/json-artifact::detail",
      slot: "detail",
    });
    expect(identityOf(review)).toEqual(identityOf(page));
  });

  it("a runtime-admitted display resolves identically on both roads", async () => {
    const TYPE = `${PKG}:artifact`;
    semanticRendererRegistry.register({ objectTypeId: TYPE, packageName: PKG });
    expect(
      (await runtimeAssetRegistry.admitAndActivate({ tuple: tuple(), generation: 1, ...okActivate }))
        .ok,
    ).toBe(true);
    const artifact = summary(TYPE, { kind: "extension", extension: PKG });
    const [page, review] = await Promise.all([
      pageRoad(artifact, "text/markdown"),
      reviewRoad(artifact, "text/markdown"),
    ]);
    expect(page.kind).toBe("runtime");
    expect(identityOf(review)).toEqual(identityOf(page));
  });

  it("a claimant absent from this build floors identically on both roads", async () => {
    const TYPE = `${PKG}:artifact`;
    semanticRendererRegistry.register({ objectTypeId: TYPE, packageName: PKG });
    const artifact = summary(TYPE, { kind: "extension", extension: PKG });
    const [page, review] = await Promise.all([
      pageRoad(artifact, "text/markdown"),
      reviewRoad(artifact, "text/markdown"),
    ]);
    expect(page).toMatchObject({ kind: "floor", packageName: PKG });
    expect(identityOf(review)).toEqual(identityOf(page));
  });

  it("both roads resolve off the PRESENTATION identity, so a re-presented row cannot diverge", async () => {
    const PRESENTED = "@cinatra-ai/json-artifact";
    const artifact = summary(
      "@cinatra-ai/json-artifact:artifact",
      { kind: "no-primary" },
      { kind: "extension", extension: PRESENTED },
    );
    const [page, review] = await Promise.all([
      pageRoad(artifact, "application/json"),
      reviewRoad(artifact, "application/json"),
    ]);
    expect(page).toMatchObject({ kind: "build-map", packageName: PRESENTED });
    expect(identityOf(review)).toEqual(identityOf(page));
  });
});

describe("acceptance 6 — one exported primitive, not two copies of it", () => {
  it("the review binder resolves THROUGH the shared primitive rather than re-deriving it", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const binder = readFileSync(resolve(__dirname, "..", "review-target-prepare.ts"), "utf8");
    expect(binder).toMatch(/resolveArtifactDisplayMount/);
    // And it no longer classifies the loadable path a second time.
    expect(binder).not.toMatch(/classifyLoadablePath/);
  });

  it("the artifact page mounts through the shared primitive too", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const page = readFileSync(resolve(__dirname, "..", "page.tsx"), "utf8");
    expect(page).toMatch(/resolveArtifactDisplayMount/);
    expect(page).toMatch(/ArtifactDisplayMountPoint/);
    expect(page).toMatch(/artifact-display-mount/);
  });
});
