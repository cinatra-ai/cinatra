/**
 * The review-surface `resolveMount` REPRESENTATION FALLBACK (cinatra#2044 S6
 * L-A). Proves the artifact-side ports binder, when NO semantic renderer wins
 * for a review target, consults the org-scoped representation-provider dispatch
 * at the `detail` slot (exactly as the non-review detail route does) so an
 * EXTENSION representation renderer serves the review target instead of the
 * "review target unavailable" floor.
 *
 * The motivating case: a CMS-content-snapshot review target
 * (`@cinatra-ai/objects:cms-content-snapshot`, MIME
 * `application/vnd.cinatra.cms-fields+json`) has no semantic renderer, so before
 * this slice it floored; with a representation renderer registered for its MIME
 * it now MOUNTS. Keyed purely on `(orgId, mime)` + the opaque generatedKey —
 * never on an extension package identity (coupling-ban G1).
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
import { runtimeAssetRegistry } from "@/lib/artifacts/runtime-renderer-registry";
import { _resetFirstPartySeedForTests } from "../renderer-resolution";
import { bindArtifactReviewPorts } from "../review-target-prepare";

const ORG = "org_2044_s6_la";
const CMS_MIME = "application/vnd.cinatra.cms-fields+json";
const CMS_TYPE = "@cinatra-ai/objects:cms-content-snapshot";
const REP_PKG = "@acme/cms-rep-artifact";
const SEM_PKG = "@acme/cms-sem-artifact";

const actor = { actorType: "human", userId: "u" } as unknown as ActorContext;

function tuple(over: Partial<AdmittedClientBundleTuple> = {}): AdmittedClientBundleTuple {
  return {
    packageName: REP_PKG,
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

/** A minimal ArtifactSummary — resolveMount reads only objectType + identity. */
function summary(objectType: string, identity: EffectiveIdentity): ArtifactSummary {
  return { artifactId: "art_1", objectType, effectiveIdentity: identity } as unknown as ArtifactSummary;
}

function mountFor(objectType: string, identity: EffectiveIdentity, mime: string) {
  const { resolveMount } = bindArtifactReviewPorts({ orgId: ORG, actor });
  return resolveMount({ artifact: summary(objectType, identity), mime, propsApiVersion: 1 });
}

afterEach(() => {
  semanticRendererRegistry._clearForTests();
  representationProviderRegistry._clearForTests(true);
  runtimeAssetRegistry._clearForTests();
  _resetFirstPartySeedForTests();
});

describe("cinatra#2044 S6 L-A — resolveMount representation fallback", () => {
  it("no semantic renderer + a CMS-MIME representation provider → MOUNTS (not the floor)", async () => {
    // A representation renderer registered for the CMS-snapshot MIME at `detail`,
    // bound in the runtime asset registry (zero host rebuild).
    representationProviderRegistry.registerProvider(ORG, {
      packageName: REP_PKG,
      pattern: CMS_MIME,
      slot: "detail",
      generation: 1,
    });
    expect((await runtimeAssetRegistry.admitAndActivate({ tuple: tuple(), generation: 1, ...okActivate })).ok).toBe(true);

    // The snapshot type has NO semantic winner (identity floors to no-primary).
    const mount = await mountFor(CMS_TYPE, { kind: "no-primary" }, CMS_MIME);
    expect(mount.kind).toBe("runtime");
    if (mount.kind !== "runtime") return;
    expect(mount.packageName).toBe(REP_PKG);
    expect(mount.descriptor.tuple.packageName).toBe(REP_PKG);
  });

  it("no semantic renderer AND no representation provider → floor UNCHANGED (no-semantic-renderer)", async () => {
    const mount = await mountFor(CMS_TYPE, { kind: "no-primary" }, CMS_MIME);
    expect(mount).toEqual({ kind: "floor", packageName: null, reason: "no-semantic-renderer" });
  });

  it("a representation provider present but NOT built in this build → requires-rebuild floor (never blank)", async () => {
    // Provider registered but its runtime binding never activated → not loadable.
    representationProviderRegistry.registerProvider(ORG, {
      packageName: REP_PKG,
      pattern: CMS_MIME,
      slot: "detail",
      generation: 1,
    });
    const mount = await mountFor(CMS_TYPE, { kind: "no-primary" }, CMS_MIME);
    expect(mount).toEqual({ kind: "floor", packageName: REP_PKG, reason: "requires-rebuild" });
  });

  it("SEMANTIC precedence holds — a winning semantic renderer is used, the representation provider is NOT consulted", async () => {
    const TYPE = `${SEM_PKG}:artifact`;
    semanticRendererRegistry.register({ objectTypeId: TYPE, packageName: SEM_PKG });
    await runtimeAssetRegistry.admitAndActivate({
      tuple: tuple({ packageName: SEM_PKG }),
      generation: 1,
      ...okActivate,
    });
    // A representation provider ALSO covers the MIME — it must lose to the semantic winner.
    representationProviderRegistry.registerProvider(ORG, {
      packageName: REP_PKG,
      pattern: CMS_MIME,
      slot: "detail",
      generation: 1,
    });
    await runtimeAssetRegistry.admitAndActivate({ tuple: tuple(), generation: 1, ...okActivate });

    const mount = await mountFor(TYPE, { kind: "extension", extension: SEM_PKG }, CMS_MIME);
    expect(mount.kind).toBe("runtime");
    if (mount.kind !== "runtime") return;
    expect(mount.packageName).toBe(SEM_PKG);
  });
});
