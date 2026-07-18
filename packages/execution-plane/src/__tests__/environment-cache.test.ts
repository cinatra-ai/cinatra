import { describe, expect, it } from "vitest";

import {
  EnvironmentLayerCache,
  makeEnvironmentTeardownParticipant,
  type EnvironmentLayerCacheEntry,
  type EnvironmentLayerPartition,
} from "../environment/cache";
import {
  computeEnvironmentRecipeKey,
  computeEnvironmentSpecKey,
  ENVIRONMENT_BUILDER_VERSION,
  type EnvironmentBuildRecipe,
} from "../environment/recipe";
import { signEnvironmentProvenance } from "../environment/provenance";

const KEY = "test-provenance-key";

function makeRecipe(pipDigest: string): EnvironmentBuildRecipe {
  return {
    spec: { pip: ["pandas==2.2.1"] },
    l0BaseDigest: "sha256:l0",
    builderVersion: ENVIRONMENT_BUILDER_VERSION,
    platform: { os: "linux", arch: "arm64" },
    buildPolicy: { networkPolicy: "registry-allowlist", registryAllowlist: ["pypi.org"] },
    resolvedArtifacts: { pip: pipDigest },
  };
}

function makeEntry(opts: {
  pipDigest?: string;
  partition?: EnvironmentLayerPartition;
  now?: number;
  signingKey?: string;
}): EnvironmentLayerCacheEntry {
  const recipe = makeRecipe(opts.pipDigest ?? "abc");
  const recipeKey = computeEnvironmentRecipeKey(recipe);
  const partition = opts.partition ?? "instance";
  const now = opts.now ?? 1_000;
  return {
    recipeKey,
    specKey: computeEnvironmentSpecKey(recipe),
    imageRef: `cinatra-sandbox-l1:${recipeKey}`,
    imageDigest: "sha256:l1img",
    partition,
    provenance: signEnvironmentProvenance(
      {
        recipeKey,
        recipe,
        imageDigest: "sha256:l1img",
        partition,
        builderIdentity: ENVIRONMENT_BUILDER_VERSION,
        builtAtMs: now,
      },
      opts.signingKey ?? KEY,
    ),
    builtAtMs: now,
    lastUsedAtMs: now,
  };
}

describe("EnvironmentLayerCache lookup", () => {
  it("instance-shared layers hit for every org (single build across agents)", () => {
    const cache = new EnvironmentLayerCache({ provenanceKey: KEY });
    const entry = makeEntry({});
    cache.put(entry);
    expect(cache.lookup(entry.recipeKey, { orgId: "org-a" }).hit).toBe(true);
    expect(cache.lookup(entry.recipeKey, { orgId: "org-b" }).hit).toBe(true);
  });

  it("org-partitioned layers stay private by default; share toggle opens them", () => {
    const entry = makeEntry({ partition: "org:org-a" });
    const closed = new EnvironmentLayerCache({ provenanceKey: KEY });
    closed.put(entry);
    expect(closed.lookup(entry.recipeKey, { orgId: "org-a" }).hit).toBe(true);
    expect(closed.lookup(entry.recipeKey, { orgId: "org-b" })).toEqual({
      hit: false,
      reason: "partition_denied",
    });

    const shared = new EnvironmentLayerCache({ provenanceKey: KEY, sharePrivateLayers: true });
    shared.put(entry);
    expect(shared.lookup(entry.recipeKey, { orgId: "org-b" }).hit).toBe(true);
  });

  it("two orgs' private layers for the SAME recipe coexist (no clobbering)", () => {
    const cache = new EnvironmentLayerCache({ provenanceKey: KEY });
    const a = makeEntry({ partition: "org:org-a" });
    const b = makeEntry({ partition: "org:org-b" });
    cache.put(a);
    cache.put(b);
    const hitA = cache.lookup(a.recipeKey, { orgId: "org-a" });
    const hitB = cache.lookup(b.recipeKey, { orgId: "org-b" });
    expect(hitA.hit && hitA.entry.partition).toBe("org:org-a");
    expect(hitB.hit && hitB.entry.partition).toBe("org:org-b");
  });

  it("verifies provenance BEFORE returning a hit (tamper ⇒ rebuild, never mount)", () => {
    const cache = new EnvironmentLayerCache({ provenanceKey: KEY });
    const entry = makeEntry({ signingKey: "wrong-key" });
    cache.put(entry);
    expect(cache.lookup(entry.recipeKey, { orgId: "org-a" })).toEqual({
      hit: false,
      reason: "provenance_invalid",
    });
  });

  it("lookupBySpecKey returns a verified admitted layer for the spec fast path", () => {
    const cache = new EnvironmentLayerCache({ provenanceKey: KEY });
    const entry = makeEntry({});
    cache.put(entry);
    const result = cache.lookupBySpecKey(entry.specKey, { orgId: "org-a" });
    expect(result.hit && result.entry.recipeKey).toBe(entry.recipeKey);
    expect(cache.lookupBySpecKey("absent-spec-key", { orgId: "org-a" }).hit).toBe(false);
  });

  it("a poisoned spec-key index row can never redirect to a sibling entry of a DIFFERENT spec", () => {
    // codex S3-r1 finding 1: seed a VALID entry, then a tampered sibling row
    // that carries the victim's specKey in its unsigned index field but whose
    // SIGNED recipe derives a different spec key. The fast path must not
    // resolve the tampered nomination through the recipe-key lookup onto the
    // valid sibling of the WRONG spec.
    const cache = new EnvironmentLayerCache({ provenanceKey: KEY });
    const victimSpecKey = "victim-spec-key";
    const other = makeEntry({ pipDigest: "other-recipe" }); // valid, different spec
    cache.put(other);
    const tampered = makeEntry({ pipDigest: "other-recipe", partition: "org:org-a" });
    tampered.specKey = victimSpecKey; // unsigned index field poisoned
    cache.put(tampered);
    const result = cache.lookupBySpecKey(victimSpecKey, { orgId: "org-a" });
    expect(result.hit).toBe(false);
  });

  it("requiredPartition admits ONLY the exact partition (org-private requests)", () => {
    const cache = new EnvironmentLayerCache({ provenanceKey: KEY });
    const instance = makeEntry({});
    cache.put(instance);
    // An org-private request must NOT resolve to the instance-shared layer.
    expect(
      cache.lookup(instance.recipeKey, { orgId: "org-a", requiredPartition: "org:org-a" }),
    ).toEqual({ hit: false, reason: "partition_denied" });
    const priv = makeEntry({ partition: "org:org-a" });
    cache.put(priv);
    const hit = cache.lookup(priv.recipeKey, { orgId: "org-a", requiredPartition: "org:org-a" });
    expect(hit.hit && hit.entry.partition).toBe("org:org-a");
  });

  it("unsigned entry fields must MATCH the signed provenance (binding checks)", () => {
    const cache = new EnvironmentLayerCache({ provenanceKey: KEY });
    // imageDigest drifted from the signed record: refused.
    const drifted = makeEntry({});
    drifted.imageDigest = "sha256:swapped";
    cache.put(drifted);
    expect(cache.lookup(drifted.recipeKey, { orgId: "org-a" })).toEqual({
      hit: false,
      reason: "provenance_invalid",
    });
    // partition re-labeled (private -> instance) without re-signing: refused.
    const relabeled = makeEntry({ partition: "org:org-a" });
    relabeled.partition = "instance";
    const cache2 = new EnvironmentLayerCache({ provenanceKey: KEY });
    cache2.put(relabeled);
    expect(cache2.lookup(relabeled.recipeKey, { orgId: "org-b" })).toEqual({
      hit: false,
      reason: "provenance_invalid",
    });
    // specKey drifted (would satisfy the wrong spec lookup): refused.
    const wrongSpec = makeEntry({});
    wrongSpec.specKey = "some-other-spec-key";
    const cache3 = new EnvironmentLayerCache({ provenanceKey: KEY });
    cache3.put(wrongSpec);
    expect(cache3.lookup(wrongSpec.recipeKey, { orgId: "org-a" })).toEqual({
      hit: false,
      reason: "provenance_invalid",
    });
  });
});

describe("references + retention GC (lifecycle doctrine)", () => {
  const setup = () => {
    let clock = 0;
    const cache = new EnvironmentLayerCache({
      provenanceKey: KEY,
      retentionMs: 100,
      now: () => clock,
    });
    const entry = makeEntry({ now: 0 });
    cache.put(entry);
    cache.addReference({
      recipeKey: entry.recipeKey,
      orgId: "org-a",
      holder: { packageName: "@cinatra-ai/x-agent", versionId: "v1" },
    });
    cache.addReference({
      recipeKey: entry.recipeKey,
      orgId: "org-b",
      holder: { packageName: "@cinatra-ai/x-agent", versionId: "v1" },
    });
    return { cache, entry, advance: (ms: number) => (clock += ms) };
  };

  it("archive (org-scoped reference drop) PRESERVES the layer; restore = cache hit", async () => {
    const { cache, entry, advance } = setup();
    // org-a admin archives: only org-a's references drop.
    expect(cache.dropReferences({ orgId: "org-a", packageName: "@cinatra-ai/x-agent" })).toBe(1);
    expect(cache.referenceCount(entry.recipeKey)).toBe(1);
    // Layer still present and mountable (restore = cache hit, no rebuild).
    advance(1_000);
    const gc = await cache.reapUnreferencedLayers({ removeImage: async () => {} });
    expect(gc.reaped).toEqual([]); // org-b's reference still pins it
    expect(cache.lookup(entry.recipeKey, { orgId: "org-a" }).hit).toBe(true);
  });

  it("fully-unreferenced layers are reaped ONLY after the retention window", async () => {
    const { cache, entry, advance } = setup();
    cache.dropReferences({ packageName: "@cinatra-ai/x-agent" }); // hard removal: all orgs
    expect(cache.referenceCount(entry.recipeKey)).toBe(0);
    // Inside the retention window: preserved.
    let gc = await cache.reapUnreferencedLayers({ removeImage: async () => {} });
    expect(gc.reaped).toEqual([]);
    // Beyond retention: reaped.
    advance(1_000);
    const removed: string[] = [];
    gc = await cache.reapUnreferencedLayers({
      removeImage: async (ref) => {
        removed.push(ref);
      },
    });
    expect(gc.reaped).toEqual([entry.recipeKey]);
    expect(removed).toEqual([entry.imageRef]);
    expect(cache.lookup(entry.recipeKey, { orgId: "org-a" })).toEqual({
      hit: false,
      reason: "absent",
    });
  });

  it("a failing image removal keeps the entry for the next sweep (best-effort)", async () => {
    const { cache, entry, advance } = setup();
    cache.dropReferences({ packageName: "@cinatra-ai/x-agent" });
    advance(1_000);
    const gc = await cache.reapUnreferencedLayers({
      removeImage: async () => {
        throw new Error("docker down");
      },
    });
    expect(gc.reaped).toEqual([]);
    expect(cache.lookup(entry.recipeKey, { orgId: "org-a" }).hit).toBe(true);
  });

  it("side-by-side version removal drops only that version's references", () => {
    const { cache, entry } = setup();
    cache.addReference({
      recipeKey: entry.recipeKey,
      orgId: "org-a",
      holder: { packageName: "@cinatra-ai/x-agent", versionId: "v2" },
    });
    expect(
      cache.dropReferences({ packageName: "@cinatra-ai/x-agent", versionId: "v2" }),
    ).toBe(1);
    expect(cache.referenceCount(entry.recipeKey)).toBe(2); // both v1 refs intact
  });

  it("teardown participant is idempotent (double-fire safe) and drops all orgs' refs", async () => {
    const { cache, entry } = setup();
    const participant = makeEnvironmentTeardownParticipant(cache);
    expect(await participant("@cinatra-ai/x-agent")).toEqual({ droppedReferences: 2 });
    expect(await participant("@cinatra-ai/x-agent")).toEqual({ droppedReferences: 0 });
    expect(cache.referenceCount(entry.recipeKey)).toBe(0);
  });
});
