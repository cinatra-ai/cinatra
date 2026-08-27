/**
 * THE FORM-RENDERING RUNG ON THE REVIEW CARD (cinatra#2931, epic #2926 W4;
 * plan `PLAN: Agents Lifecycle (B)` §5, acceptance §6 "The card includes the
 * artifact's renderer").
 *
 * The defect this pins shut: the card decided its renderer by the same ladder
 * the artifact page uses MINUS the ladder's last rung — the first-party renderer
 * for declared text forms — so the same markdown draft that renders on its own
 * page showed "cannot render" under review.
 *
 * What is proved here, without a browser:
 *   1. a declared text form (markdown, plain text) resolves to the FORM rung
 *      instead of the floor;
 *   2. the rung sits BELOW every package renderer and ABOVE the fallback;
 *   3. the card and the page resolve the SAME tier for the same row — one
 *      resolution, called rather than copied;
 *   4. the card resolves off the PRESENTATION identity, the identity the page
 *      resolves off, so the two can no longer diverge per row;
 *   5. the floor is reached only when nothing renders the row at all.
 */
import { afterEach, describe, expect, it } from "vitest";

import type { EffectiveIdentity } from "@cinatra-ai/objects/effective-identity";
import {
  semanticRendererRegistry,
  representationProviderRegistry,
} from "@cinatra-ai/objects/artifact-renderer-registry";
import type { AdmittedClientBundleTuple } from "@cinatra-ai/sdk-extensions/artifact-client-bundle";

import type { ActorContext } from "@/lib/authz/actor-context";
import type { ArtifactSummary } from "@/lib/artifacts/artifact-service";
import type { ResolvedRendererMount } from "@/lib/artifacts/artifact-review-preparation";
import { PREVIEW_INLINE_MIME_ALLOWLIST_FOR_TESTS } from "@/lib/artifacts/artifact-read";
import { runtimeAssetRegistry } from "@/lib/artifacts/runtime-renderer-registry";

import { pickHandler } from "../pick-handler";
import { pickArtifactRenderer } from "../renderer-dispatch";
import {
  resolveArtifactDispatchInputs,
  _resetFirstPartySeedForTests,
} from "../renderer-resolution";
import { bindArtifactReviewPorts } from "../review-target-prepare";
import { provenanceFromResolvedMount } from "../review-gate-ports";

const ORG = "org_2931_w4";
const MARKDOWN = "text/markdown";
const PLAIN = "text/plain";
/** A MIME no host handler and no bundled provider covers — the genuine floor. */
const OPAQUE = "application/vnd.acme.opaque";
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

/** A minimal ArtifactSummary. `presentationIdentity` defaults to the effective
 * one, exactly as `artifact-service` projects it when no assertion re-presents
 * the row. */
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

function mountFor(artifact: ArtifactSummary, mime: string): Promise<ResolvedRendererMount> {
  const { resolveMount } = bindArtifactReviewPorts({ orgId: ORG, actor });
  return Promise.resolve(resolveMount({ artifact, mime, propsApiVersion: 1 }));
}

/** The PAGE's own composition, for the parity comparison. */
function pageDispatch(artifact: ArtifactSummary, mime: string) {
  return pickArtifactRenderer(
    resolveArtifactDispatchInputs({
      orgId: ORG,
      baseType: artifact.objectType,
      identity: artifact.presentationIdentity,
      mime,
    }),
  );
}

afterEach(() => {
  semanticRendererRegistry._clearForTests();
  representationProviderRegistry._clearForTests(true);
  runtimeAssetRegistry._clearForTests();
  _resetFirstPartySeedForTests();
});

describe("cinatra#2931 W4 — the form rung's first-party arm", () => {
  it("a markdown draft under review resolves to the FORM rung, not the floor", async () => {
    const mount = await mountFor(summary(`${PKG}:post`, { kind: "no-primary" }), MARKDOWN);
    expect(mount).toEqual({ kind: "form", arm: "first-party", form: "markdown" });
  });

  it("a plain-text target resolves to the form rung's text arm", async () => {
    const mount = await mountFor(summary(`${PKG}:note`, { kind: "no-primary" }), PLAIN);
    expect(mount).toEqual({ kind: "form", arm: "first-party", form: "text" });
  });

  it("the rung is consumed BEFORE the fallback and AFTER every package renderer", async () => {
    // A semantic winner for the row's type — the package renderer wins over the
    // rung, which is what keeps the rung a floor rather than a ceiling.
    const TYPE = `${PKG}:artifact`;
    semanticRendererRegistry.register({ objectTypeId: TYPE, packageName: PKG });
    expect(
      (await runtimeAssetRegistry.admitAndActivate({ tuple: tuple(), generation: 1, ...okActivate }))
        .ok,
    ).toBe(true);

    const withWinner = await mountFor(
      summary(TYPE, { kind: "extension", extension: PKG }),
      MARKDOWN,
    );
    expect(withWinner.kind).toBe("runtime");

    // The same MIME with no package renderer lands on the rung — never the floor.
    const withoutWinner = await mountFor(summary(`${PKG}:post`, { kind: "no-primary" }), MARKDOWN);
    expect(withoutWinner.kind).toBe("form");
  });

  it("an extension REPRESENTATION provider for the same MIME still beats the rung", async () => {
    representationProviderRegistry.registerProvider(ORG, {
      packageName: PKG,
      pattern: MARKDOWN,
      slot: "detail",
      generation: 1,
    });
    await runtimeAssetRegistry.admitAndActivate({ tuple: tuple(), generation: 1, ...okActivate });

    const mount = await mountFor(summary(`${PKG}:post`, { kind: "no-primary" }), MARKDOWN);
    expect(mount.kind).toBe("runtime");
  });

  it("the floor is reached ONLY when nothing renders the row — no package, no declared form", async () => {
    const mount = await mountFor(summary(`${PKG}:blob`, { kind: "no-primary" }), OPAQUE);
    expect(mount).toEqual({ kind: "floor", packageName: null, reason: "no-semantic-renderer" });
  });
});

describe("cinatra#2931 W4 — one resolution, card and page", () => {
  const rows: ReadonlyArray<{ name: string; mime: string }> = [
    { name: "a markdown draft", mime: MARKDOWN },
    { name: "a plain-text note", mime: PLAIN },
    { name: "an opaque binary", mime: OPAQUE },
  ];

  for (const row of rows) {
    it(`${row.name}: the card mounts iff the page renders`, async () => {
      const artifact = summary(`${PKG}:row`, { kind: "no-primary" });
      const dispatch = pageDispatch(artifact, row.mime);
      const mount = await mountFor(artifact, row.mime);

      const pageRenders = dispatch.kind !== "fallback";
      const cardRenders = !(mount.kind === "floor" && mount.reason === "no-semantic-renderer");
      expect(cardRenders).toBe(pageRenders);
    });
  }

  it("the card resolves off the PRESENTATION identity — the identity the page resolves off", async () => {
    // The row is FILED under one extension and PRESENTED as another (epic #1883
    // A6): the presented extension ships the renderer, the filed one does not.
    // The page has always drawn the presented renderer; before this slice the
    // card resolved off the EFFECTIVE identity and drew the floor for the very
    // same row.
    const PRESENTED = "@acme/presented-artifact";
    const TYPE = `${PRESENTED}:artifact`;
    semanticRendererRegistry.register({ objectTypeId: TYPE, packageName: PRESENTED });
    await runtimeAssetRegistry.admitAndActivate({
      tuple: tuple({ packageName: PRESENTED }),
      generation: 1,
      ...okActivate,
    });

    const artifact = summary(
      TYPE,
      { kind: "extension", extension: PKG },
      { kind: "extension", extension: PRESENTED },
    );

    // The page: the presented extension's semantic renderer.
    const dispatch = pageDispatch(artifact, OPAQUE);
    expect(dispatch.kind).toBe("semantic");

    // The card: the SAME renderer, mounted through the runtime seam.
    const mount = await mountFor(artifact, OPAQUE);
    expect(mount.kind).toBe("runtime");
    if (mount.kind !== "runtime") return;
    expect(mount.packageName).toBe(PRESENTED);
  });
});

describe("cinatra#2931 W4 — the decision row records a rendered target as rendered", () => {
  it("the submit-time provenance of the form rung is first-party, never floor", () => {
    expect(provenanceFromResolvedMount({ kind: "form", arm: "first-party", form: "markdown" })).toEqual({
      kind: "first-party",
      packageName: null,
      digest: null,
    });
    expect(provenanceFromResolvedMount({ kind: "form", arm: "first-party", form: "text" })).toEqual({
      kind: "first-party",
      packageName: null,
      digest: null,
    });
  });

  it("a genuine floor is still recorded as a floor — the gate's count stays honest", () => {
    expect(
      provenanceFromResolvedMount({ kind: "floor", packageName: null, reason: "no-semantic-renderer" }),
    ).toEqual({ kind: "floor", packageName: null, digest: null });
  });
});

describe("cinatra#2931 W4 — the arm names exactly what the host still renders", () => {
  it("every non-fallback handler `pickHandler` can return is an arm of the rung", () => {
    const arms = new Set(["markdown", "text"]);
    const reachable = new Set<string>();
    for (const mime of PREVIEW_INLINE_MIME_ALLOWLIST_FOR_TESTS) {
      const handler = pickHandler(mime);
      if (handler !== "fallback") reachable.add(handler);
    }
    expect([...reachable].sort()).toEqual([...arms].sort());
  });
});
