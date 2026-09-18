/**
 * A REVIEW TARGET OF A TEXT/MARKDOWN REPRESENTATION IS DRAWN BY THE MARKDOWN
 * DISPLAY (cinatra#2934, fix leg 12 — the maintainer's finding 5).
 *
 * WHAT THE DEV-BOOT ROUND MEASURED, AND WHAT THIS LANE RE-MEASURED. The round of
 * 2026-09-04 read a review target that drew one bordered box over an empty
 * panel: role=tab controls 0, tabpanels 0, no Code and no Preview. Re-measured
 * on this head against a real produced post (a run of the blog draft writer,
 * the review opened through the run), the mount resolves to
 *
 *   dispatch { kind: "representation",
 *              packageName: "@cinatra-ai/markdown-artifact",
 *              generatedKey: "@cinatra-ai/markdown-artifact::detail",
 *              pattern: "text/markdown" }
 *
 * for objectType "@cinatra-ai/blog-post-artifact:post" — whose own package
 * ships no display — and the island then draws that package's `detail`
 * renderer, which is documented in its own source as "READ-ONLY … with no tabs
 * and no editing affordance". The panel therefore CANNOT carry the two tabs, and
 * did not: tabs 0, tablists 0, tabpanels 0.
 *
 * WHAT THE DRAWING FIXES. Artifact review §IV: "For a text/markdown target the
 * renderer that mounts here is the markdown display, drawn on a target exactly
 * as §V.1 fixes it." And §V.1: "Markdown is drawn by a display of its own, and
 * that display carries two tabs — Code and Preview … On a review target the same
 * display is drawn read-only — both tabs, neither editable … A review target
 * opens on Preview, with Code one press away. That holds wherever the target is
 * drawn."
 *
 * THE RULE THIS PINS, AND ITS EDGE. The rung that loses is the MIME-BOUND one: a
 * representation provider is bound to a media type, not to the artifact's type,
 * and on a review target the host's own declared text form — the markdown
 * display, whose two tabs are pinned in `handlers/__tests__/markdown-display.
 * test.tsx` — is what the drawing puts in that slot. A SEMANTIC renderer, the
 * display a type's OWN package ships, is untouched: that is the email body of
 * Lifecycle cards §XIII.1, drawn as a mail reading pane on its own review card,
 * and it still wins. And a MIME with no declared host text form still reaches
 * its representation provider exactly as before.
 *
 * THE BORDER. Nothing here is fixed inside a package and no package is named by
 * the rule: the host owns the display map that resolves a DECLARED
 * representation to a display, and this is that map, keyed on the host's own
 * declared text form. That `@cinatra-ai/markdown-artifact`'s `detail`/`preview`
 * renderers draw no tab strip is a defect of THAT package against §V.1, to be
 * fixed in its own repository; the host neither re-implements them nor patches
 * around them by name.
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
import { runtimeAssetRegistry } from "@/lib/artifacts/runtime-renderer-registry";

import { pickArtifactRenderer } from "../renderer-dispatch";
import {
  resolveArtifactDispatchInputs,
  _resetFirstPartySeedForTests,
} from "../renderer-resolution";
import { bindArtifactReviewPorts } from "../review-target-prepare";

const ORG = "org_2934_leg12";
const MARKDOWN = "text/markdown";
const PLAIN = "text/plain";
/** The measured row: a post whose own package ships no display. */
const POST_TYPE = "@cinatra-ai/blog-post-artifact:post";
const REP_PKG = "@acme/mime-bound-markdown";
/** A MIME no host text form covers — the representation rung keeps it. */
const CMS_MIME = "application/vnd.cinatra.cms-fields+json";

const actor = { actorType: "human", userId: "u" } as unknown as ActorContext;

function tuple(over: Partial<AdmittedClientBundleTuple> = {}): AdmittedClientBundleTuple {
  return {
    packageName: REP_PKG,
    slot: "detail",
    digest: "b".repeat(128),
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

function summary(objectType: string, identity: EffectiveIdentity): ArtifactSummary {
  return {
    artifactId: "art_leg12",
    objectType,
    effectiveIdentity: identity,
    presentationIdentity: identity,
  } as unknown as ArtifactSummary;
}

function mountFor(artifact: ArtifactSummary, mime: string): Promise<ResolvedRendererMount> {
  const { resolveMount } = bindArtifactReviewPorts({ orgId: ORG, actor });
  return Promise.resolve(resolveMount({ artifact, mime, propsApiVersion: 1 }));
}

afterEach(() => {
  semanticRendererRegistry._clearForTests();
  representationProviderRegistry._clearForTests(true);
  runtimeAssetRegistry._clearForTests();
  _resetFirstPartySeedForTests();
});

describe("the review target's markdown display (§IV, §V.1)", () => {
  it("THE MEASURED ROW: a produced post's text/markdown target mounts the markdown display", async () => {
    // Exactly the row the dev-boot round read — a post whose package ships no
    // display, so the bundled markdown pack's MIME-bound `detail` renderer used
    // to win and draw a panel with no tab strip in it.
    const mount = await mountFor(
      summary(POST_TYPE, { kind: "extension", extension: "@cinatra-ai/blog-post-artifact" }),
      MARKDOWN,
    );
    expect(mount).toEqual({ kind: "form", arm: "first-party", form: "markdown" });
  });

  it("a MIME-bound representation provider never displaces the markdown display on a target", async () => {
    representationProviderRegistry.registerProvider(ORG, {
      packageName: REP_PKG,
      pattern: MARKDOWN,
      slot: "detail",
      generation: 1,
    });
    await runtimeAssetRegistry.admitAndActivate({ tuple: tuple(), generation: 1, ...okActivate });

    const mount = await mountFor(summary(POST_TYPE, { kind: "no-primary" }), MARKDOWN);
    expect(mount).toEqual({ kind: "form", arm: "first-party", form: "markdown" });
  });

  it("PLAIN TEXT is NOT redirected — a registered text/plain viewer keeps its slot", async () => {
    // THE EDGE THE CONVERGENCE ROUND NARROWED. The drawing's two-tab sentence is
    // about MARKDOWN — "Markdown is drawn by a display of its own, and that
    // display carries two tabs" (§V.1) — and says nothing of the kind for plain
    // text. A host that displaced a registered text/plain viewer here would be
    // asserting a precedence the drawing has not fixed, so it does not.
    representationProviderRegistry.registerProvider(ORG, {
      packageName: REP_PKG,
      pattern: PLAIN,
      slot: "detail",
      generation: 1,
    });
    await runtimeAssetRegistry.admitAndActivate({ tuple: tuple(), generation: 1, ...okActivate });

    const mount = await mountFor(summary(`${REP_PKG}:note`, { kind: "no-primary" }), PLAIN);
    expect(mount.kind).toBe("runtime");
  });

  it("a plain-text target with NO viewer still reaches the form rung's text arm", async () => {
    // The unchanged road: nothing above the rung claims the row, so the host's
    // own text arm draws it exactly as it did before this rule existed.
    const mount = await mountFor(summary(`${REP_PKG}:note`, { kind: "no-primary" }), PLAIN);
    expect(mount).toEqual({ kind: "form", arm: "first-party", form: "text" });
  });

  it("a TYPE's own display still wins — the email body of §XIII.1 keeps its reading", async () => {
    const EMAIL = "@cinatra-ai/email-artifacts";
    const TYPE = `${EMAIL}:body`;
    semanticRendererRegistry.register({ objectTypeId: TYPE, packageName: EMAIL });
    await runtimeAssetRegistry.admitAndActivate({
      tuple: tuple({ packageName: EMAIL }),
      generation: 1,
      ...okActivate,
    });

    const mount = await mountFor(
      summary(TYPE, { kind: "extension", extension: EMAIL }),
      MARKDOWN,
    );
    expect(mount.kind).toBe("runtime");
    if (mount.kind !== "runtime") return;
    expect(mount.packageName).toBe(EMAIL);
  });

  it("a MIME with no declared host text form keeps its representation provider", async () => {
    representationProviderRegistry.registerProvider(ORG, {
      packageName: REP_PKG,
      pattern: CMS_MIME,
      slot: "detail",
      generation: 1,
    });
    await runtimeAssetRegistry.admitAndActivate({ tuple: tuple(), generation: 1, ...okActivate });

    const mount = await mountFor(summary(`${REP_PKG}:snapshot`, { kind: "no-primary" }), CMS_MIME);
    expect(mount.kind).toBe("runtime");
  });

  it("the ARTIFACT PAGE's own ladder is untouched — this rule is the review target's", async () => {
    // §V.1 says the markdown display is drawn on the artifact's own page too,
    // and editably there; what that page resolves is not this leg's subject and
    // is left exactly as it was.
    const artifact = summary(POST_TYPE, { kind: "no-primary" });
    const dispatch = pickArtifactRenderer(
      resolveArtifactDispatchInputs({
        orgId: ORG,
        baseType: artifact.objectType,
        identity: artifact.presentationIdentity,
        mime: MARKDOWN,
      }),
    );
    expect(dispatch.kind).toBe("representation");
  });
});
