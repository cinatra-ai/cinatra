/**
 * TableBackedAnthropicSkillSyncMap resolves persisted Anthropic skill upload
 * state only when the upload gate and permission ports allow use.
 */
import { describe, it, expect } from "vitest";
import {
  TableBackedAnthropicSkillSyncMap,
  type AnthropicSyncMapStatePort,
  type AnthropicSkillUsePermissionPort,
} from "../tools/anthropic-skill-sync-map-table";
import { defaultAnthropicSkillUploadGate } from "../tools/anthropic-skill-upload-gate";

function state(row: Parameters<AnthropicSyncMapStatePort["readRow"]> extends never ? never : null | {
  anthropicSkillId: string;
  anthropicVersion: string;
  stale: boolean;
}): AnthropicSyncMapStatePort {
  return { readRow: async () => row };
}

function perms(globalEnabled: boolean, flag: unknown): AnthropicSkillUsePermissionPort {
  return { isGloballyEnabled: () => globalEnabled, readPerSkillFlag: () => flag };
}

const freshRow = { anthropicSkillId: "skill_1", anthropicVersion: "v1", stale: false };

describe("TableBackedAnthropicSkillSyncMap.resolve", () => {
  it("resolves a fresh row when gate permits", async () => {
    const map = new TableBackedAnthropicSkillSyncMap(
      state(freshRow),
      defaultAnthropicSkillUploadGate,
      perms(true, true),
    );
    expect(await map.resolve("skill-a")).toEqual({
      skillId: "skill_1",
      version: "v1",
      catalogSkillId: "skill-a",
    });
  });

  it("returns null when global opt-in OFF — even for a fresh, unstale row", async () => {
    const map = new TableBackedAnthropicSkillSyncMap(
      state(freshRow),
      defaultAnthropicSkillUploadGate,
      perms(false, true),
    );
    expect(await map.resolve("skill-a")).toBeNull();
  });

  it("returns null when per-skill flag denied — even for a fresh, unstale row", async () => {
    const map = new TableBackedAnthropicSkillSyncMap(
      state(freshRow),
      defaultAnthropicSkillUploadGate,
      perms(true, false),
    );
    expect(await map.resolve("skill-a")).toBeNull();
  });

  it("returns null for a stale row even when gate permits", async () => {
    const map = new TableBackedAnthropicSkillSyncMap(
      state({ ...freshRow, stale: true }),
      defaultAnthropicSkillUploadGate,
      perms(true, true),
    );
    expect(await map.resolve("skill-a")).toBeNull();
  });

  it("returns null when no row exists", async () => {
    const map = new TableBackedAnthropicSkillSyncMap(
      state(null),
      defaultAnthropicSkillUploadGate,
      perms(true, true),
    );
    expect(await map.resolve("skill-a")).toBeNull();
  });

  it("fails closed when the permission port throws", async () => {
    const throwing: AnthropicSkillUsePermissionPort = {
      isGloballyEnabled: () => {
        throw new Error("boom");
      },
      readPerSkillFlag: () => true,
    };
    const map = new TableBackedAnthropicSkillSyncMap(
      state(freshRow),
      defaultAnthropicSkillUploadGate,
      throwing,
    );
    expect(await map.resolve("skill-a")).toBeNull();
  });
});
