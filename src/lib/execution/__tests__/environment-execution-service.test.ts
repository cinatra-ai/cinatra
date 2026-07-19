// Unit tests for the A2 execution-environment service (exec-plane S3,
// cinatra#1708). Proves the tri-state readiness resolution + the ready-slot
// composition (declared-env resolver + at-use reference write, the impossible
// "no-environment" refusal, the durable delete-then-rmi reaper, the teardown
// participant, and the org-scoped archive reference drop). Uses hand-rolled
// in-memory fakes so the app-vitest env never loads the heavy execution-plane
// graph (the composition core takes only TYPE-erased execution-plane imports).

import { describe, expect, it, vi } from "vitest";

import type {
  EnvironmentLayerCache,
  EnvironmentLayerCacheEntry,
  EnvironmentLayerPartition,
  EnvironmentRecipeReference,
  ReferenceMatch,
} from "@cinatra-ai/execution-plane";
import type { SandboxExecutor } from "@cinatra-ai/llm";
import {
  buildReadyExecutionEnvironmentSlot,
  resolveExecutionEnvironmentReadiness,
  PROVENANCE_KEY_ENV,
  type EnvironmentServiceDeps,
} from "@/lib/execution/environment-execution-service";
import type { DurableEnvironmentLayerStore } from "@/lib/execution/environment-layer-store.pg";

const fakeExecutor: SandboxExecutor = async () => [];

function makeEntry(overrides: Partial<EnvironmentLayerCacheEntry> = {}): EnvironmentLayerCacheEntry {
  const recipeKey = overrides.recipeKey ?? "recipe-abc";
  const partition: EnvironmentLayerPartition = overrides.partition ?? "instance";
  return {
    recipeKey,
    specKey: overrides.specKey ?? "spec-abc",
    imageRef: overrides.imageRef ?? `cinatra-sandbox-l1:${recipeKey}`,
    imageDigest: overrides.imageDigest ?? "sha256:img",
    partition,
    provenance: overrides.provenance ?? ({ recipeKey, imageDigest: "sha256:img" } as never),
    builtAtMs: overrides.builtAtMs ?? 0,
    lastUsedAtMs: overrides.lastUsedAtMs ?? 0,
  };
}

const refMatches = (r: EnvironmentRecipeReference, m: ReferenceMatch): boolean =>
  (m.recipeKey === undefined || r.recipeKey === m.recipeKey) &&
  (m.orgId === undefined || r.orgId === m.orgId) &&
  (m.packageName === undefined || r.holder.packageName === m.packageName) &&
  (m.templateId === undefined || r.holder.templateId === m.templateId) &&
  (m.versionId === undefined || r.holder.versionId === m.versionId);

/** A hand-rolled in-memory store + cache that avoid the execution-plane import. */
function makeFakes() {
  const layers = new Map<string, EnvironmentLayerCacheEntry>();
  const refs: EnvironmentRecipeReference[] = [];
  const key = (r: string, p: string) => `${p} ${r}`;

  const store: DurableEnvironmentLayerStore = {
    listByRecipeKey: async (r) => [...layers.values()].filter((l) => l.recipeKey === r),
    listBySpecKey: async (s) => [...layers.values()].filter((l) => l.specKey === s),
    listAll: async () => [...layers.values()],
    put: async (e) => void layers.set(key(e.recipeKey, e.partition), e),
    delete: async (r, p) => void layers.delete(key(r, p)),
    listReferences: async () => [...refs],
    addReference: async (ref) => {
      if (!refs.some((r) => refMatches(r, { recipeKey: ref.recipeKey, orgId: ref.orgId, packageName: ref.holder.packageName, templateId: ref.holder.templateId, versionId: ref.holder.versionId })))
        refs.push(ref);
    },
    removeReferences: async (m) => {
      let n = 0;
      for (let i = refs.length - 1; i >= 0; i--)
        if (refMatches(refs[i], m)) (refs.splice(i, 1), n++);
      return n;
    },
    countReferences: async (r) => refs.filter((x) => x.recipeKey === r).length,
    listReapableLayers: async (cutoff) => {
      const out: Array<{ recipeKey: string; partition: EnvironmentLayerPartition; imageRef: string }> = [];
      for (const l of layers.values()) {
        if (l.lastUsedAtMs >= cutoff) continue;
        if (refs.some((x) => x.recipeKey === l.recipeKey)) continue;
        out.push({ recipeKey: l.recipeKey, partition: l.partition, imageRef: l.imageRef });
      }
      return out;
    },
    reapCandidateUnderLock: async (r, p, cutoff) => {
      const l = layers.get(key(r, p));
      if (!l || l.lastUsedAtMs >= cutoff) return null;
      if (refs.some((x) => x.recipeKey === r)) return null;
      layers.delete(key(r, p));
      return { removedImageDigest: l.imageDigest };
    },
  };
  const cache = {
    addReference: (ref: EnvironmentRecipeReference) => store.addReference(ref),
    dropReferences: (m: ReferenceMatch) => store.removeReferences(m),
    referenceCount: (r: string) => store.countReferences(r),
  } as unknown as EnvironmentLayerCache;
  return { store, cache };
}

function deps(over: Partial<EnvironmentServiceDeps>): EnvironmentServiceDeps {
  const { store, cache } = makeFakes();
  return {
    store,
    cache,
    builder: { ensureEnvironmentLayer: vi.fn() },
    executor: fakeExecutor,
    removeImage: async () => {},
    ...over,
  };
}

describe("resolveExecutionEnvironmentReadiness (tri-state)", () => {
  it("disabled when the instance is not opted into the plane", () => {
    expect(resolveExecutionEnvironmentReadiness({}, () => fakeExecutor)).toEqual({ state: "disabled" });
  });

  it("unavailable (opted in) when the provenance key is missing — fail closed", () => {
    const r = resolveExecutionEnvironmentReadiness({ EXECUTION_PLANE_REQUIRED: "1" }, () => fakeExecutor);
    expect(r.state).toBe("unavailable");
    expect(r.state === "unavailable" && r.reason).toContain(PROVENANCE_KEY_ENV);
  });

  it("unavailable when opted in + provenance present but NO executor wiring", () => {
    const r = resolveExecutionEnvironmentReadiness(
      { EXECUTION_PLANE_REQUIRED: "1", [PROVENANCE_KEY_ENV]: "hmac" },
      undefined,
    );
    expect(r.state).toBe("unavailable");
    expect(r.state === "unavailable" && r.reason).toContain("broker-executor");
  });

  it("ready when opted in + provenance key + executor factory present", () => {
    const r = resolveExecutionEnvironmentReadiness(
      { EXECUTION_PLANE_REQUIRED: "1", [PROVENANCE_KEY_ENV]: "hmac" },
      () => fakeExecutor,
    );
    expect(r.state).toBe("ready");
    expect(r.state === "ready" && r.provenanceKey).toBe("hmac");
  });
});

describe("buildReadyExecutionEnvironmentSlot", () => {
  it("resolveRunExecutionMount builds, writes the at-use reference, and projects the mount", async () => {
    const entry = makeEntry();
    const d = deps({
      builder: { ensureEnvironmentLayer: vi.fn(async () => ({ kind: "ready", entry, cacheHit: false }) as const) },
    });
    const slot = buildReadyExecutionEnvironmentSlot(d);
    const mount = await slot.resolveRunExecutionMount!({
      spec: { pip: ["pandas"] },
      orgId: "org-a",
      holder: { packageName: "@cinatra-ai/x-agent", versionId: "v1" },
    });
    expect(mount).toEqual({ imageRef: entry.imageRef, provenance: entry.provenance });
    expect(await d.store.countReferences(entry.recipeKey)).toBe(1);
    expect(d.builder.ensureEnvironmentLayer).toHaveBeenCalledWith({
      raw: { pip: ["pandas"] },
      orgId: "org-a",
      visibility: undefined,
    });
  });

  it("resolveRunExecutionMount returns undefined on the IMPOSSIBLE no-environment state", async () => {
    const d = deps({
      builder: { ensureEnvironmentLayer: vi.fn(async () => ({ kind: "no-environment" }) as const) },
    });
    const slot = buildReadyExecutionEnvironmentSlot(d);
    expect(
      await slot.resolveRunExecutionMount!({ spec: { pip: ["x"] }, orgId: "org-a", holder: {} }),
    ).toBeUndefined();
  });

  it("reapEnvironmentLayers reaps zero-reference layers past the window (delete-then-rmi)", async () => {
    let clock = 0;
    const removed: string[] = [];
    const d = deps({ removeImage: async (ref) => void removed.push(ref), now: () => clock });
    const slot = buildReadyExecutionEnvironmentSlot(d);
    const entry = makeEntry({ lastUsedAtMs: 0, imageDigest: "sha256:reapme" });
    await d.store.put(entry);
    await d.cache.addReference({ recipeKey: entry.recipeKey, orgId: "org-a", holder: {} });
    clock = 1_000;
    expect(await slot.reapEnvironmentLayers!({ retentionMs: 100 })).toEqual({ reaped: [] });
    await d.cache.dropReferences({ recipeKey: entry.recipeKey });
    expect(await slot.reapEnvironmentLayers!({ retentionMs: 100 })).toEqual({ reaped: [entry.recipeKey] });
    // Reaped by the IMMUTABLE digest, not the content-addressed tag.
    expect(removed).toEqual([entry.imageDigest]);
    expect(await d.store.listByRecipeKey(entry.recipeKey)).toEqual([]);
  });

  it("reapEnvironmentLayers still counts a reap whose rmi FAILS (benign orphan; row gone)", async () => {
    let clock = 0;
    const d = deps({
      removeImage: async () => {
        throw new Error("docker down");
      },
      now: () => clock,
    });
    const slot = buildReadyExecutionEnvironmentSlot(d);
    const entry = makeEntry({ lastUsedAtMs: 0 });
    await d.store.put(entry);
    clock = 1_000;
    expect(await slot.reapEnvironmentLayers!({ retentionMs: 100 })).toEqual({ reaped: [entry.recipeKey] });
    expect(await d.store.listByRecipeKey(entry.recipeKey)).toEqual([]);
  });

  it("teardown participant drops all orgs' refs; archive drop is org-scoped", async () => {
    const d = deps({});
    const slot = buildReadyExecutionEnvironmentSlot(d);
    const entry = makeEntry();
    await d.store.put(entry);
    await d.cache.addReference({ recipeKey: entry.recipeKey, orgId: "org-a", holder: { packageName: "@cinatra-ai/x-agent" } });
    await d.cache.addReference({ recipeKey: entry.recipeKey, orgId: "org-b", holder: { packageName: "@cinatra-ai/x-agent" } });
    expect(await slot.dropEnvironmentReferences!({ orgId: "org-a", packageName: "@cinatra-ai/x-agent" })).toBe(1);
    expect(await d.store.countReferences(entry.recipeKey)).toBe(1);
    const participant = slot.getEnvironmentTeardownParticipant!();
    expect(await participant!("@cinatra-ai/x-agent")).toEqual({ droppedReferences: 1 });
    expect(await d.store.countReferences(entry.recipeKey)).toBe(0);
  });

  it("exposes the executor only through the ready slot", () => {
    const slot = buildReadyExecutionEnvironmentSlot(deps({}));
    expect(slot.state).toBe("ready");
    expect(slot.getRunExecutionExecutor!()).toBe(fakeExecutor);
  });
});
