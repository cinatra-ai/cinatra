/**
 * skill-autosave config write/read round-trip (cinatra#808).
 *
 * The admin "Autosave" form desynced after save — the checkbox visually reset to
 * unchecked even though the value persisted — because the server action returned
 * nothing, so the client form had no authoritative saved value to re-seed from
 * after the server-action route refresh. The fix makes `writeSkillAutosaveConfig`
 * RETURN the persisted merged config, which the action returns and the form uses
 * to re-sync its controlled state. These tests lock that return contract: the
 * value returned by a write equals what a subsequent read yields, and a partial
 * write merges over (never drops) the untouched fields.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/database", () => {
  let stored: Record<string, unknown> | undefined;
  return {
    readConnectorConfigFromDatabase: vi.fn(<T>(_key: string, fallback: T): T =>
      (stored as T) ?? fallback,
    ),
    writeConnectorConfigToDatabase: vi.fn((_key: string, value: Record<string, unknown>) => {
      stored = value;
    }),
    __reset: () => {
      stored = undefined;
    },
  };
});

import { readSkillAutosaveConfig, writeSkillAutosaveConfig } from "@/lib/skill-autosave";
import * as db from "@/lib/database";

beforeEach(() => {
  (db as unknown as { __reset: () => void }).__reset();
  vi.clearAllMocks();
});

describe("writeSkillAutosaveConfig return contract (cinatra#808)", () => {
  it("returns the persisted merged config (merged over defaults)", () => {
    const returned = writeSkillAutosaveConfig({ enabled: true });
    expect(returned).toEqual({
      enabled: true,
      userCanConfigure: false,
      userCanSeeIndicator: true,
    });
  });

  it("returns exactly what a subsequent read yields (authoritative round-trip)", () => {
    const returned = writeSkillAutosaveConfig({ enabled: true, userCanSeeIndicator: true });
    expect(returned).toEqual(readSkillAutosaveConfig());
  });

  it("merges a partial write over existing values (does not drop untouched fields)", () => {
    writeSkillAutosaveConfig({ enabled: true });
    const returned = writeSkillAutosaveConfig({ userCanSeeIndicator: false });
    // enabled stays true; userCanConfigure forced false because indicator hidden
    // is enforced at the action layer, but the lib merge itself preserves it as-is.
    expect(returned).toEqual({
      enabled: true,
      userCanConfigure: false,
      userCanSeeIndicator: false,
    });
  });

  it("persists the merged value (write then read reflects the change without a reload)", () => {
    writeSkillAutosaveConfig({ enabled: true });
    expect(readSkillAutosaveConfig().enabled).toBe(true);
  });
});
