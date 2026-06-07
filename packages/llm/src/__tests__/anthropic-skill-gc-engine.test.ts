/**
 * AnthropicSkillGcEngine unit tests.
 *
 * Mocked delete client + in-memory state + injected clock. No live key; no
 * fabricated round-trip. Covers the destructive-GC invariants:
 *  - a version referenced by an active lease is NEVER deleted; the
 *    delete-all-versions-first race is contained because the lease blocks GC.
 *  - stale + aged-past-grace + unleased skills have all versions deleted BEFORE
 *    the skill; the grace window protects in-flight runs independent of any
 *    lease.
 *  - locally-stale rows are reconciled away after remote reclaim; remote orphan
 *    versions the local table never recorded are still deleted because
 *    listSkillVersions is remote-authoritative.
 *  - opt-in OFF is fully inert; a mid-loop flip stops further destructive calls
 *    with local rows intact.
 *  - any non-stale catalog row skips the whole skill.
 *  - 404 idempotency and per-skill failure isolation are preserved.
 */
import { describe, it, expect, vi } from "vitest";
import {
  AnthropicSkillGcEngine,
  type AnthropicSkillGcStatePort,
  type AnthropicSkillGcClientPort,
  type GcSyncRow,
} from "../tools/anthropic-skill-gc-engine";

const GRACE = 30 * 60 * 1000;
const NOW = 1_000_000_000_000;

function row(over: Partial<GcSyncRow> = {}): GcSyncRow {
  return {
    catalogSkillId: "cat-a",
    anthropicSkillId: "skill_1",
    anthropicVersion: "v1",
    stale: true,
    staleAtMs: NOW - GRACE - 1, // aged past grace by default
    ...over,
  };
}

class FakeState implements AnthropicSkillGcStatePort {
  rows: GcSyncRow[];
  leaseCounts: Map<string, number>;
  /** Successive lease counts per skill (for TOCTOU). */
  leaseSeq?: Map<string, number[]>;
  deletedRowsFor: string[] = [];
  constructor(rows: GcSyncRow[], leaseCounts: Record<string, number> = {}) {
    this.rows = rows;
    this.leaseCounts = new Map(Object.entries(leaseCounts));
  }
  async listAllRows() {
    return this.rows;
  }
  async countActiveLeasesForSkill(id: string) {
    const seq = this.leaseSeq?.get(id);
    if (seq && seq.length > 0) return seq.shift()!;
    return this.leaseCounts.get(id) ?? 0;
  }
  async deleteSyncRowsForSkill(id: string) {
    this.deletedRowsFor.push(id);
  }
}

function fakeClient(
  versions: Record<string, string[]>,
  calls: string[],
  opts: {
    throwOnDeleteSkill?: string;
    notFoundVersion?: string;
  } = {},
): AnthropicSkillGcClientPort {
  return {
    async listSkillVersions(id) {
      calls.push(`list:${id}`);
      return versions[id] ?? [];
    },
    async deleteSkillVersion(id, v) {
      if (opts.notFoundVersion === v) {
        // simulate 404 handled as idempotent success at the client boundary
        calls.push(`delV:${id}:${v}:404ok`);
        return;
      }
      calls.push(`delV:${id}:${v}`);
    },
    async deleteSkill(id) {
      if (opts.throwOnDeleteSkill === id) {
        calls.push(`delS:${id}:THROW`);
        throw new Error("boom");
      }
      calls.push(`delS:${id}`);
    },
  };
}

const ON = () => true;
const OFF = () => false;

describe("AnthropicSkillGcEngine.collect", () => {
  it("active lease blocks GC of every version (zero deletes)", async () => {
    const calls: string[] = [];
    const state = new FakeState([row()], { skill_1: 1 });
    const client = fakeClient({ skill_1: ["v1"] }, calls);
    const res = await new AnthropicSkillGcEngine(
      state,
      client,
      GRACE,
      () => NOW,
    ).collect(ON);
    expect(res.reclaimed).toEqual([]);
    expect(res.skipped).toEqual([
      { anthropicSkillId: "skill_1", reason: "active_lease" },
    ]);
    expect(calls).toEqual([]); // no list, no delete
    expect(state.deletedRowsFor).toEqual([]);
  });

  it("stale + aged + unleased => all versions deleted before the skill", async () => {
    const calls: string[] = [];
    const state = new FakeState(
      [
        row({ anthropicVersion: "v1" }),
        row({ anthropicVersion: "v2", catalogSkillId: "cat-a2" }),
      ],
      {},
    );
    // Remote has a 3rd version the local table never recorded (reconcile orphan).
    const client = fakeClient({ skill_1: ["v1", "v2", "v3-orphan"] }, calls);
    const res = await new AnthropicSkillGcEngine(
      state,
      client,
      GRACE,
      () => NOW,
    ).collect(ON);
    expect(res.ok).toBe(true);
    expect(res.reclaimed).toEqual([
      { anthropicSkillId: "skill_1", versions: ["v1", "v2", "v3-orphan"] },
    ]);
    // All version deletes before the skill delete (Anthropic ordering).
    expect(calls).toEqual([
      "list:skill_1",
      "delV:skill_1:v1",
      "delV:skill_1:v2",
      "delV:skill_1:v3-orphan",
      "delS:skill_1",
    ]);
    // Locally-stale rows are reconciled away after remote reclaim.
    expect(state.deletedRowsFor).toEqual(["skill_1"]);
  });

  it("within grace => skipped, zero deletes (in-flight-run protection)", async () => {
    const calls: string[] = [];
    const state = new FakeState([row({ staleAtMs: NOW - GRACE + 1 })], {});
    const res = await new AnthropicSkillGcEngine(
      state,
      fakeClient({ skill_1: ["v1"] }, calls),
      GRACE,
      () => NOW,
    ).collect(ON);
    expect(res.skipped).toEqual([
      { anthropicSkillId: "skill_1", reason: "within_grace" },
    ]);
    expect(calls).toEqual([]);
  });

  it("null stale_at (legacy) => skipped fail-closed", async () => {
    const calls: string[] = [];
    const state = new FakeState([row({ staleAtMs: null })], {});
    const res = await new AnthropicSkillGcEngine(
      state,
      fakeClient({ skill_1: ["v1"] }, calls),
      GRACE,
      () => NOW,
    ).collect(ON);
    expect(res.skipped).toEqual([
      { anthropicSkillId: "skill_1", reason: "missing_stale_at" },
    ]);
    expect(calls).toEqual([]);
  });

  it("catalog source of truth: any non-stale row => whole skill skipped", async () => {
    const calls: string[] = [];
    const state = new FakeState(
      [
        row({ anthropicVersion: "v1", stale: true }),
        row({ anthropicVersion: "v2", stale: false, staleAtMs: null }),
      ],
      {},
    );
    const res = await new AnthropicSkillGcEngine(
      state,
      fakeClient({ skill_1: ["v1", "v2"] }, calls),
      GRACE,
      () => NOW,
    ).collect(ON);
    expect(res.skipped).toEqual([
      { anthropicSkillId: "skill_1", reason: "non_stale_row" },
    ]);
    expect(calls).toEqual([]);
  });

  it("opt-in OFF => fully inert (zero list, zero delete, zero state)", async () => {
    const calls: string[] = [];
    const state = new FakeState([row()], {});
    const listSpy = vi.spyOn(state, "listAllRows");
    const res = await new AnthropicSkillGcEngine(
      state,
      fakeClient({ skill_1: ["v1"] }, calls),
      GRACE,
      () => NOW,
    ).collect(OFF);
    expect(res).toEqual({ ok: true, reclaimed: [], skipped: [], errors: [] });
    expect(listSpy).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("mid-version-loop OFF flip => stops, local rows NOT dropped", async () => {
    const calls: string[] = [];
    const state = new FakeState([row()], {});
    const client = fakeClient({ skill_1: ["v1", "v2"] }, calls);
    // ON for entry + per-skill + after-version-loop checks, OFF before 2nd
    // version delete: entry, per-skill-pre-mut, first-version, then OFF.
    let n = 0;
    const flip = () => {
      n += 1;
      return n < 4; // first 3 reads ON, 4th (before 2nd delete) OFF
    };
    const res = await new AnthropicSkillGcEngine(
      state,
      client,
      GRACE,
      () => NOW,
    ).collect(flip);
    expect(res.reclaimed).toEqual([]);
    expect(res.skipped).toEqual([
      { anthropicSkillId: "skill_1", reason: "global_off" },
    ]);
    // Only v1 deleted; no deleteSkill; local rows NOT reconciled (resume next run).
    expect(calls).toEqual(["list:skill_1", "delV:skill_1:v1"]);
    expect(state.deletedRowsFor).toEqual([]);
  });

  it("TOCTOU: a lease appearing between scan and pre-delete recheck aborts", async () => {
    const calls: string[] = [];
    const state = new FakeState([row()], {});
    // First count (eligibility scan) = 0, second count (pre-delete recheck) = 1.
    state.leaseSeq = new Map([["skill_1", [0, 1]]]);
    const res = await new AnthropicSkillGcEngine(
      state,
      fakeClient({ skill_1: ["v1"] }, calls),
      GRACE,
      () => NOW,
    ).collect(ON);
    expect(res.skipped).toEqual([
      { anthropicSkillId: "skill_1", reason: "active_lease_recheck" },
    ]);
    expect(calls).toEqual([]); // never listed/deleted
  });

  it("lease appearing during the version-delete loop aborts the skill delete", async () => {
    const calls: string[] = [];
    const state = new FakeState([row()], {});
    // scan=0, pre-delete-recheck=0, FINAL-recheck (after version deletes)=1.
    state.leaseSeq = new Map([["skill_1", [0, 0, 1]]]);
    const res = await new AnthropicSkillGcEngine(
      state,
      fakeClient({ skill_1: ["v1", "v2"] }, calls),
      GRACE,
      () => NOW,
    ).collect(ON);
    expect(res.reclaimed).toEqual([]);
    expect(res.skipped).toEqual([
      { anthropicSkillId: "skill_1", reason: "active_lease_recheck" },
    ]);
    // Versions were deleted, but the SKILL delete is aborted and local rows
    // are NOT reconciled (a later run resumes once the lease expires).
    expect(calls).toEqual([
      "list:skill_1",
      "delV:skill_1:v1",
      "delV:skill_1:v2",
    ]);
    expect(state.deletedRowsFor).toEqual([]);
  });

  it("per-skill failure isolation: skill A throws => skill B still reclaimed", async () => {
    const calls: string[] = [];
    const state = new FakeState(
      [
        row({ anthropicSkillId: "skill_A", catalogSkillId: "cat-A" }),
        row({ anthropicSkillId: "skill_B", catalogSkillId: "cat-B" }),
      ],
      {},
    );
    const client = fakeClient(
      { skill_A: ["v1"], skill_B: ["v1"] },
      calls,
      { throwOnDeleteSkill: "skill_A" },
    );
    const res = await new AnthropicSkillGcEngine(
      state,
      client,
      GRACE,
      () => NOW,
    ).collect(ON);
    expect(res.ok).toBe(false);
    expect(res.errors).toEqual([
      { anthropicSkillId: "skill_A", message: "boom" },
    ]);
    expect(res.reclaimed).toEqual([
      { anthropicSkillId: "skill_B", versions: ["v1"] },
    ]);
    // A's local rows NOT dropped (failed); B's reconciled.
    expect(state.deletedRowsFor).toEqual(["skill_B"]);
  });

  it("404 on a version delete is idempotent (GC still completes)", async () => {
    const calls: string[] = [];
    const state = new FakeState([row()], {});
    const client = fakeClient({ skill_1: ["v1"] }, calls, {
      notFoundVersion: "v1",
    });
    const res = await new AnthropicSkillGcEngine(
      state,
      client,
      GRACE,
      () => NOW,
    ).collect(ON);
    expect(res.reclaimed).toEqual([
      { anthropicSkillId: "skill_1", versions: ["v1"] },
    ]);
    expect(calls).toEqual([
      "list:skill_1",
      "delV:skill_1:v1:404ok",
      "delS:skill_1",
    ]);
    expect(state.deletedRowsFor).toEqual(["skill_1"]);
  });
});
