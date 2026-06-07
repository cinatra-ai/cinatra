/**
 * Anthropic skill sync engine unit tests.
 *
 * Mocked client + in-memory state + the real upload gate. No live key; no
 * fabricated round-trip. Covers the sync engine contract:
 *  - first sync → createSkill; hash drift → createSkillVersion
 *    (new immutable version); unchanged hash → no-op; catalog is the only
 *    source read.
 *  - >30MB → structured preflight error naming skill+size,
 *    BEFORE any HTTP/state mutation; the 8-cap is a SEPARATE delivery-set
 *    preflight (not the catalog sync).
 *  - no DELETE verb anywhere; stale rows; immutable old versions.
 *  - Governance: opt-in OFF ⇒ fully inert (zero client calls, zero state
 *    writes); per-skill deny ⇒ skipped + marked stale.
 *  - namespace collision proven in the DAO test.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  AnthropicSkillSyncEngine,
  preflightAnthropicSkillSyncSizes,
  preflightSkillRequestSet,
  ANTHROPIC_SKILL_MAX_BYTES,
  type SyncCandidateSkill,
  type SyncRow,
  type AnthropicSkillSyncStatePort,
} from "../tools/anthropic-skill-sync-engine";
import { computeSkillContentHash } from "../tools/anthropic-skill-content-hash";
import { defaultAnthropicSkillUploadGate } from "../tools/anthropic-skill-upload-gate";
import { AnthropicSkillPreflightError } from "../errors";
import type { AnthropicCustomSkillsClient } from "../tools/anthropic-custom-skills-client";

function candidate(over: Partial<SyncCandidateSkill> = {}): SyncCandidateSkill {
  return {
    catalogSkillId: "skill-a",
    name: "Skill A",
    skillMd: Buffer.from("---\nname: A\n---\nbody"),
    bundledFiles: [{ relPath: "ref/x.md", bytes: Buffer.from("ref") }],
    allowAnthropicUpload: true,
    ...over,
  };
}

class FakeState implements AnthropicSkillSyncStatePort {
  rows = new Map<string, SyncRow>();
  markStaleForRemoved = vi.fn(async (_ids: string[]) => {});
  async readRow(id: string) {
    return this.rows.get(id) ?? null;
  }
  async upsertRow(r: {
    catalogSkillId: string;
    anthropicSkillId: string;
    anthropicVersion: string;
    contentHash: string;
  }) {
    this.rows.set(r.catalogSkillId, { ...r, stale: false });
  }
  async markStale(id: string) {
    const row = this.rows.get(id);
    if (row) row.stale = true;
  }
  async markStaleForRemovedCatalogSkills(ids: string[]) {
    await this.markStaleForRemoved(ids);
  }
}

function fakeClient() {
  let seq = 0;
  return {
    createSkill: vi.fn(async () => ({ skillId: `skill_${++seq}`, version: `v${seq}` })),
    createSkillVersion: vi.fn(async () => ({ version: `v-next-${++seq}` })),
  } satisfies AnthropicCustomSkillsClient;
}

describe("AnthropicSkillSyncEngine — governance inert when OFF", () => {
  it("global OFF ⇒ zero client calls, zero state writes", async () => {
    const client = fakeClient();
    const state = new FakeState();
    const engine = new AnthropicSkillSyncEngine(client, state, defaultAnthropicSkillUploadGate);

    const result = await engine.sync([candidate()], /* globalEnabled */ () => false);

    expect(result.ok).toBe(true);
    expect(result.outcomes).toEqual([]);
    expect(client.createSkill).not.toHaveBeenCalled();
    expect(client.createSkillVersion).not.toHaveBeenCalled();
    expect(state.rows.size).toBe(0);
    expect(state.markStaleForRemoved).not.toHaveBeenCalled();
  });

  it("non-true globalEnabled values are all inert (fail-closed)", async () => {
    const client = fakeClient();
    const engine = new AnthropicSkillSyncEngine(client, new FakeState(), defaultAnthropicSkillUploadGate);
    for (const bad of [undefined, null, 1, "true", {}] as unknown[]) {
      const r = await engine.sync([candidate()], () => bad as boolean);
      expect(r.outcomes).toEqual([]);
    }
    expect(client.createSkill).not.toHaveBeenCalled();
  });
});

describe("AnthropicSkillSyncEngine — first sync & drift", () => {
  it("first sync ⇒ createSkill, records skillId+version+hash", async () => {
    const client = fakeClient();
    const state = new FakeState();
    const engine = new AnthropicSkillSyncEngine(client, state, defaultAnthropicSkillUploadGate);
    const c = candidate();

    const result = await engine.sync([c], () => true);

    expect(client.createSkill).toHaveBeenCalledTimes(1);
    expect(client.createSkillVersion).not.toHaveBeenCalled();
    expect(result.outcomes).toEqual([{ catalogSkillId: "skill-a", action: "created" }]);
    const row = state.rows.get("skill-a")!;
    expect(row.anthropicSkillId).toBe("skill_1");
    expect(row.contentHash).toBe(computeSkillContentHash(c.skillMd, c.bundledFiles));
    expect(state.markStaleForRemoved).toHaveBeenCalledWith(["skill-a"]);
  });

  it("unchanged hash ⇒ no-op (no client call)", async () => {
    const client = fakeClient();
    const state = new FakeState();
    const c = candidate();
    state.rows.set("skill-a", {
      catalogSkillId: "skill-a",
      anthropicSkillId: "skill_existing",
      anthropicVersion: "v9",
      contentHash: computeSkillContentHash(c.skillMd, c.bundledFiles),
      stale: false,
    });
    const engine = new AnthropicSkillSyncEngine(client, state, defaultAnthropicSkillUploadGate);

    const result = await engine.sync([c], () => true);

    expect(client.createSkill).not.toHaveBeenCalled();
    expect(client.createSkillVersion).not.toHaveBeenCalled();
    expect(result.outcomes).toEqual([{ catalogSkillId: "skill-a", action: "unchanged" }]);
  });

  it("hash drift ⇒ createSkillVersion (NEW immutable version, old skillId kept)", async () => {
    const client = fakeClient();
    const state = new FakeState();
    state.rows.set("skill-a", {
      catalogSkillId: "skill-a",
      anthropicSkillId: "skill_existing",
      anthropicVersion: "v-old",
      contentHash: "STALE_OLD_HASH",
      stale: false,
    });
    const engine = new AnthropicSkillSyncEngine(client, state, defaultAnthropicSkillUploadGate);
    const c = candidate({ skillMd: Buffer.from("CHANGED CONTENT") });

    const result = await engine.sync([c], () => true);

    expect(client.createSkill).not.toHaveBeenCalled();
    expect(client.createSkillVersion).toHaveBeenCalledWith(
      "skill_existing",
      expect.objectContaining({ displayName: "Skill A" }),
    );
    const row = state.rows.get("skill-a")!;
    expect(row.anthropicSkillId).toBe("skill_existing"); // skill id never changes
    expect(row.anthropicVersion).not.toBe("v-old"); // NEW immutable version
    expect(row.contentHash).toBe(computeSkillContentHash(c.skillMd, c.bundledFiles));
    expect(result.outcomes).toEqual([{ catalogSkillId: "skill-a", action: "updated" }]);
  });

  it("bundled-file set change alone ⇒ drift", async () => {
    const a = candidate();
    const b = candidate({ bundledFiles: [...a.bundledFiles, { relPath: "ref/y.md", bytes: Buffer.from("y") }] });
    expect(computeSkillContentHash(a.skillMd, a.bundledFiles)).not.toBe(
      computeSkillContentHash(b.skillMd, b.bundledFiles),
    );
  });
});

describe("AnthropicSkillSyncEngine — size preflight before any mutation", () => {
  it(">30MB ⇒ structured error naming the exact skill + size, ZERO remote/state", async () => {
    const client = fakeClient();
    const state = new FakeState();
    const big = candidate({
      catalogSkillId: "big-skill",
      skillMd: Buffer.alloc(ANTHROPIC_SKILL_MAX_BYTES + 1, 0x61),
    });
    const engine = new AnthropicSkillSyncEngine(client, state, defaultAnthropicSkillUploadGate);

    const result = await engine.sync([candidate(), big], () => true);

    expect(result.ok).toBe(false);
    expect(result.preflightError).toBeInstanceOf(AnthropicSkillPreflightError);
    expect(result.preflightError!.kind).toBe("size");
    expect(result.preflightError!.offendingSkillIds).toEqual(["big-skill"]);
    expect(result.preflightError!.message).toContain("big-skill");
    expect(result.preflightError!.message).toContain("MB");
    // No remote calls, no state writes — not a mid-run partial failure.
    expect(client.createSkill).not.toHaveBeenCalled();
    expect(state.rows.size).toBe(0);
    expect(state.markStaleForRemoved).not.toHaveBeenCalled();
  });

  it("standalone size preflight returns null when all under limit", () => {
    expect(preflightAnthropicSkillSyncSizes([candidate()])).toBeNull();
  });
});

describe("preflightSkillRequestSet — delivery-set 8-cap is SEPARATE from sync", () => {
  it("≤8 ⇒ null; >8 ⇒ structured request_cap error", () => {
    expect(preflightSkillRequestSet(["a", "b"], 8)).toBeNull();
    const over = preflightSkillRequestSet(["1", "2", "3", "4", "5", "6", "7", "8", "9"], 8);
    expect(over).toBeInstanceOf(AnthropicSkillPreflightError);
    expect(over!.kind).toBe("request_cap");
    expect(over!.message).toContain("9");
    expect(over!.message).toContain("8");
  });
});

describe("AnthropicSkillSyncEngine — governance per-skill deny", () => {
  it("per-skill allowAnthropicUpload !== true ⇒ skipped (no HTTP) + prior row marked stale", async () => {
    const client = fakeClient();
    const state = new FakeState();
    state.rows.set("skill-a", {
      catalogSkillId: "skill-a",
      anthropicSkillId: "skill_existing",
      anthropicVersion: "v1",
      contentHash: "h",
      stale: false,
    });
    const engine = new AnthropicSkillSyncEngine(client, state, defaultAnthropicSkillUploadGate);

    const result = await engine.sync([candidate({ allowAnthropicUpload: false })], () => true);

    expect(client.createSkill).not.toHaveBeenCalled();
    expect(client.createSkillVersion).not.toHaveBeenCalled();
    expect(result.outcomes).toEqual([
      { catalogSkillId: "skill-a", action: "skipped", reason: "governance_denied" },
    ]);
    expect(state.rows.get("skill-a")!.stale).toBe(true); // stop referencing it
  });

  it("malformed allowAnthropicUpload denies without throwing", async () => {
    const client = fakeClient();
    const engine = new AnthropicSkillSyncEngine(client, new FakeState(), defaultAnthropicSkillUploadGate);
    for (const bad of [undefined, null, 1, "true", {}] as unknown[]) {
      const r = await engine.sync([candidate({ allowAnthropicUpload: bad })], () => true);
      expect(r.outcomes[0]).toMatchObject({ action: "skipped", reason: "governance_denied" });
    }
    expect(client.createSkill).not.toHaveBeenCalled();
  });
});

describe("AnthropicSkillSyncEngine — NO remote GC", () => {
  it("the client interface exposes ONLY create methods (no delete)", () => {
    const client = fakeClient();
    expect(Object.keys(client).sort()).toEqual(["createSkill", "createSkillVersion"]);
  });

  it("no DELETE verb appears in the SYNC engine OR SYNC client CODE (regression)", () => {
    // Scan only non-comment code lines — comment prose intentionally documents
    // the no-DELETE boundary and would otherwise be a false positive.
    const codeLines = (src: string) =>
      src
        .split("\n")
        .filter((l) => {
          const t = l.trim();
          return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
        })
        .join("\n");
    const rawClient = readFileSync(
      path.join(__dirname, "..", "tools", "anthropic-custom-skills-client.ts"),
      "utf8",
    );
    // The delete-capable GC client lives in the same
    // file but is a SEPARATE class used ONLY by the explicit/maintenance GC
    // engine, never the sync path. The no-DELETE structural boundary now
    // scopes to the SYNC portion before the GC client marker.
    const gcMarkerIdx = rawClient.indexOf(
      "The delete-capable GC client",
    );
    expect(gcMarkerIdx).toBeGreaterThan(0); // marker must exist (boundary anchor)
    // Robustness against a moved/duplicated marker:
    // the GC delete client class must appear ONLY after the marker (so the
    // scanned sync portion can never accidentally include delete code).
    const gcClassIdx = rawClient.indexOf(
      "class FetchAnthropicCustomSkillsGcClient",
    );
    expect(gcClassIdx).toBeGreaterThan(gcMarkerIdx);
    expect(
      rawClient.slice(0, gcMarkerIdx).includes("FetchAnthropicCustomSkillsGcClient"),
    ).toBe(false);
    const syncClientSrc = codeLines(rawClient.slice(0, gcMarkerIdx));
    const engineSrc = codeLines(
      readFileSync(
        path.join(__dirname, "..", "tools", "anthropic-skill-sync-engine.ts"),
        "utf8",
      ),
    );
    expect(/method:\s*["']DELETE["']/i.test(engineSrc)).toBe(false);
    expect(/method:\s*["']DELETE["']/i.test(syncClientSrc)).toBe(false);
    expect(/\bDELETE\b/.test(syncClientSrc)).toBe(false);
    expect(/\.delete\s*\(/i.test(engineSrc)).toBe(false);
  });

  it("the SYNC engine's client type cannot structurally accept delete methods (regression)", () => {
    // Stronger than "the named interface lacks DELETE": a delete* key added to
    // AnthropicCustomSkillsClient would make this exhaustive Record literal
    // miss a required key ⇒ tsgo build failure, so the GC delete client can
    // never be substituted for the sync client.
    type SyncClientKeys = keyof AnthropicCustomSkillsClient;
    const allowed: Record<SyncClientKeys, true> = {
      createSkill: true,
      createSkillVersion: true,
    };
    expect(Object.keys(allowed).sort()).toEqual([
      "createSkill",
      "createSkillVersion",
    ]);
  });

  it("catalog-removal ⇒ markStaleForRemovedCatalogSkills called, never a delete", async () => {
    const client = fakeClient();
    const state = new FakeState();
    const engine = new AnthropicSkillSyncEngine(client, state, defaultAnthropicSkillUploadGate);
    await engine.sync([candidate({ catalogSkillId: "still-here" })], () => true);
    expect(state.markStaleForRemoved).toHaveBeenCalledWith(["still-here"]);
  });
});

describe("AnthropicSkillSyncEngine — race-safe OFF flip", () => {
  /** A live reader that returns true for the first `n` calls, then false —
   *  simulates an admin toggling sync OFF mid-run at a precise boundary. */
  function flipAfter(n: number): () => boolean {
    let calls = 0;
    return () => ++calls <= n;
  }

  it("OFF flip before the governance-denied stale write ⇒ no markStale, no sweep", async () => {
    const client = fakeClient();
    const state = new FakeState();
    state.rows.set("skill-a", {
      catalogSkillId: "skill-a",
      anthropicSkillId: "skill_pre",
      anthropicVersion: "v1",
      contentHash: "old",
      stale: false,
    });
    const markStaleSpy = vi.spyOn(state, "markStale");
    const engine = new AnthropicSkillSyncEngine(client, state, defaultAnthropicSkillUploadGate);
    // calls: 1=entry, 2=loop-top → then gate-denied branch re-check is 3rd (OFF).
    const r = await engine.sync(
      [candidate({ allowAnthropicUpload: false })],
      flipAfter(2),
    );
    expect(r.ok).toBe(true);
    expect(markStaleSpy).not.toHaveBeenCalled();
    expect(state.rows.get("skill-a")?.stale).toBe(false);
    expect(state.markStaleForRemoved).not.toHaveBeenCalled();
  });

  it("OFF flip before remote create ⇒ no createSkill, no upsert, no sweep", async () => {
    const client = fakeClient();
    const state = new FakeState();
    const upsertSpy = vi.spyOn(state, "upsertRow");
    const engine = new AnthropicSkillSyncEngine(client, state, defaultAnthropicSkillUploadGate);
    // calls: 1=entry, 2=loop-top, gate ALLOWED (no denied re-check) → 3rd is the
    // pre-create guard (OFF).
    const r = await engine.sync([candidate()], flipAfter(2));
    expect(r.ok).toBe(true);
    expect(client.createSkill).not.toHaveBeenCalled();
    expect(client.createSkillVersion).not.toHaveBeenCalled();
    expect(upsertSpy).not.toHaveBeenCalled();
    expect(state.markStaleForRemoved).not.toHaveBeenCalled();
  });

  it("OFF flip before the final post-loop sweep ⇒ create persists, sweep skipped", async () => {
    const client = fakeClient();
    const state = new FakeState();
    const engine = new AnthropicSkillSyncEngine(client, state, defaultAnthropicSkillUploadGate);
    // calls: 1=entry, 2=loop-top, 3=pre-create (all ON) → create+upsert happen;
    // 4th call is the final-sweep guard (OFF). The completed create is correctly
    // recorded (real remote state, no orphan); the sweep is skipped.
    const r = await engine.sync([candidate()], flipAfter(3));
    expect(r.ok).toBe(true);
    expect(client.createSkill).toHaveBeenCalledTimes(1);
    expect(state.rows.get("skill-a")?.anthropicSkillId).toBe("skill_1");
    expect(state.markStaleForRemoved).not.toHaveBeenCalled();
  });
});
