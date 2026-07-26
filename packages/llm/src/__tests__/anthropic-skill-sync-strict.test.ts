/**
 * Strict-mode orchestration tests (S0).
 *
 * `syncStrict` THROWS on any config failure so a durable caller can retry
 * (the plain `sync` swallows failures into `{ ok:false }` and treats an
 * all-governance-skipped run as `ok:true`). The expected-set verification mode
 * asserts every expected injectable revision ended with a non-stale matching
 * remote row — an all-governance-skipped run is NOT success.
 */
import { describe, it, expect, vi } from "vitest";
import {
  AnthropicSkillSyncEngine,
  AnthropicSkillSyncFailedError,
  AnthropicSkillExpectedSetError,
  ANTHROPIC_SKILL_MAX_BYTES,
  type SyncCandidateSkill,
  type SyncRow,
  type AnthropicSkillSyncStatePort,
} from "../tools/anthropic-skill-sync-engine";
import { computeSkillContentHash } from "../tools/anthropic-skill-content-hash";
import { defaultAnthropicSkillUploadGate } from "../tools/anthropic-skill-upload-gate";
import type { AnthropicCustomSkillsClient } from "../tools/anthropic-custom-skills-client";

function candidate(over: Partial<SyncCandidateSkill> = {}): SyncCandidateSkill {
  return {
    catalogSkillId: "skill-a",
    name: "Skill A",
    skillMd: Buffer.from("---\nname: a\n---\nbody"),
    bundledFiles: [],
    allowAnthropicUpload: true,
    ...over,
  };
}

class FakeState implements AnthropicSkillSyncStatePort {
  rows = new Map<string, SyncRow>();
  async readRow(id: string) {
    return this.rows.get(id) ?? null;
  }
  async upsertRow(r: { catalogSkillId: string; anthropicSkillId: string; anthropicVersion: string; contentHash: string }) {
    this.rows.set(r.catalogSkillId, { ...r, stale: false });
  }
  async markStale(id: string) {
    const row = this.rows.get(id);
    if (row) row.stale = true;
  }
  async markStaleForRemovedCatalogSkills() {}
}

function fakeClient(): AnthropicCustomSkillsClient {
  let seq = 0;
  return {
    createSkill: vi.fn(async () => ({ skillId: `skill_${++seq}`, version: `v${seq}` })),
    createSkillVersion: vi.fn(async () => ({ version: `v-next-${++seq}` })),
  };
}

describe("syncStrict — throw-on-failure", () => {
  it("throws AnthropicSkillSyncFailedError on a preflight (size) failure, carrying the result", async () => {
    const engine = new AnthropicSkillSyncEngine(fakeClient(), new FakeState(), defaultAnthropicSkillUploadGate);
    const big = candidate({
      catalogSkillId: "big",
      skillMd: Buffer.alloc(ANTHROPIC_SKILL_MAX_BYTES + 1, 0x61),
    });
    await expect(engine.syncStrict([big], () => true)).rejects.toBeInstanceOf(
      AnthropicSkillSyncFailedError,
    );
    try {
      await engine.syncStrict([big], () => true);
    } catch (err) {
      const e = err as AnthropicSkillSyncFailedError;
      expect(e.result.ok).toBe(false);
      expect(e.result.preflightError?.kind).toBe("size");
    }
  });

  it("returns the result when sync succeeds and no expected set is required", async () => {
    const engine = new AnthropicSkillSyncEngine(fakeClient(), new FakeState(), defaultAnthropicSkillUploadGate);
    const r = await engine.syncStrict([candidate()], () => true);
    expect(r.ok).toBe(true);
    expect(r.outcomes).toEqual([{ catalogSkillId: "skill-a", action: "created" }]);
  });
});

describe("syncStrict — expected-set verification", () => {
  it("all-governance-skipped is NOT success for an expected injectable id", async () => {
    const engine = new AnthropicSkillSyncEngine(fakeClient(), new FakeState(), defaultAnthropicSkillUploadGate);
    // governance-denied ⇒ skipped, no row written ⇒ expected id is `missing`.
    await expect(
      engine.syncStrict([candidate({ allowAnthropicUpload: false })], () => true, {
        expectedInjectableIds: ["skill-a"],
      }),
    ).rejects.toBeInstanceOf(AnthropicSkillExpectedSetError);
  });

  it("passes when every expected id ended with a non-stale matching row", async () => {
    const engine = new AnthropicSkillSyncEngine(fakeClient(), new FakeState(), defaultAnthropicSkillUploadGate);
    const r = await engine.syncStrict([candidate()], () => true, {
      expectedInjectableIds: ["skill-a"],
    });
    expect(r.ok).toBe(true);
  });
});

describe("verifyExpectedSet — read-only categorization", () => {
  it("classifies missing / stale / mismatched / satisfied", async () => {
    const state = new FakeState();
    const c = candidate();
    const good = computeSkillContentHash(c.skillMd, c.bundledFiles);
    state.rows.set("skill-a", {
      catalogSkillId: "skill-a",
      anthropicSkillId: "skill_1",
      anthropicVersion: "v1",
      contentHash: good,
      stale: false,
    });
    state.rows.set("skill-stale", {
      catalogSkillId: "skill-stale",
      anthropicSkillId: "skill_2",
      anthropicVersion: "v1",
      contentHash: good,
      stale: true,
    });
    state.rows.set("skill-drift", {
      catalogSkillId: "skill-drift",
      anthropicSkillId: "skill_3",
      anthropicVersion: "v1",
      contentHash: "OLD",
      stale: false,
    });
    const engine = new AnthropicSkillSyncEngine(fakeClient(), state, defaultAnthropicSkillUploadGate);
    const cands = [
      c,
      candidate({ catalogSkillId: "skill-stale" }),
      candidate({ catalogSkillId: "skill-drift", skillMd: Buffer.from("changed") }),
    ];
    const v = await engine.verifyExpectedSet(
      ["skill-a", "skill-stale", "skill-drift", "skill-never-offered"],
      cands,
    );
    expect(v.ok).toBe(false);
    expect(v.missing).toEqual(["skill-never-offered"]);
    expect(v.stale).toEqual(["skill-stale"]);
    expect(v.mismatched).toEqual(["skill-drift"]);
  });
});
