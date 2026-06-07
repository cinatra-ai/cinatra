/**
 * TableBackedAnthropicSkillSyncMap lease behavior.
 *
 *  - resolve() returning a ref takes a best-effort lease.
 *  - A lease.acquire() throw does NOT break dispatch (ref still returned) —
 *    GC correctness is anchored by the grace window, not the lease.
 *  - No ref (denied / stale / missing) ⇒ NO lease acquired.
 */
import { describe, it, expect, vi } from "vitest";
import {
  TableBackedAnthropicSkillSyncMap,
  type AnthropicSyncMapStatePort,
  type AnthropicSkillUsePermissionPort,
  type AnthropicSkillLeasePort,
} from "../tools/anthropic-skill-sync-map-table";
import { defaultAnthropicSkillUploadGate } from "../tools/anthropic-skill-upload-gate";

function state(
  row: null | { anthropicSkillId: string; anthropicVersion: string; stale: boolean },
): AnthropicSyncMapStatePort {
  return { readRow: async () => row };
}
function perms(globalEnabled: boolean, flag: unknown): AnthropicSkillUsePermissionPort {
  return { isGloballyEnabled: () => globalEnabled, readPerSkillFlag: () => flag };
}
const fresh = { anthropicSkillId: "skill_1", anthropicVersion: "v1", stale: false };

describe("TableBackedAnthropicSkillSyncMap lease behavior", () => {
  it("acquires a lease when a ref is resolved", async () => {
    const acquire = vi.fn(async () => {});
    const lease: AnthropicSkillLeasePort = { acquire };
    const map = new TableBackedAnthropicSkillSyncMap(
      state(fresh),
      defaultAnthropicSkillUploadGate,
      perms(true, true),
      lease,
    );
    const ref = await map.resolve("cat-a");
    expect(ref).toEqual({ skillId: "skill_1", version: "v1", catalogSkillId: "cat-a" });
    expect(acquire).toHaveBeenCalledWith({
      catalogSkillId: "cat-a",
      anthropicSkillId: "skill_1",
      anthropicVersion: "v1",
    });
  });

  it("a lease.acquire throw does NOT break dispatch (ref still returned)", async () => {
    const lease: AnthropicSkillLeasePort = {
      acquire: vi.fn(async () => {
        throw new Error("db down");
      }),
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const map = new TableBackedAnthropicSkillSyncMap(
      state(fresh),
      defaultAnthropicSkillUploadGate,
      perms(true, true),
      lease,
    );
    const ref = await map.resolve("cat-a");
    expect(ref).toEqual({ skillId: "skill_1", version: "v1", catalogSkillId: "cat-a" });
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("no ref (stale row) ⇒ no lease acquired", async () => {
    const acquire = vi.fn(async () => {});
    const map = new TableBackedAnthropicSkillSyncMap(
      state({ ...fresh, stale: true }),
      defaultAnthropicSkillUploadGate,
      perms(true, true),
      { acquire },
    );
    expect(await map.resolve("cat-a")).toBeNull();
    expect(acquire).not.toHaveBeenCalled();
  });

  it("no ref (governance denied) ⇒ no lease acquired", async () => {
    const acquire = vi.fn(async () => {});
    const map = new TableBackedAnthropicSkillSyncMap(
      state(fresh),
      defaultAnthropicSkillUploadGate,
      perms(false, true), // global OFF ⇒ gate denies ⇒ null
      { acquire },
    );
    expect(await map.resolve("cat-a")).toBeNull();
    expect(acquire).not.toHaveBeenCalled();
  });

  it("works with no lease port injected", async () => {
    const map = new TableBackedAnthropicSkillSyncMap(
      state(fresh),
      defaultAnthropicSkillUploadGate,
      perms(true, true),
    );
    expect(await map.resolve("cat-a")).toEqual({
      skillId: "skill_1",
      version: "v1",
      catalogSkillId: "cat-a",
    });
  });
});
