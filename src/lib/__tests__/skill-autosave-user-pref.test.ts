/**
 * Per-user chat-capture preference beneath the admin master switch
 * (cinatra#1367): null follows the admin default; an explicit boolean
 * overrides for that user only; the master switch is a hard gate either way.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/database", () => {
  const stored = new Map<string, unknown>();
  return {
    readConnectorConfigFromDatabase: vi.fn(<T>(key: string, fallback: T): T =>
      stored.has(key) ? (stored.get(key) as T) : fallback,
    ),
    writeConnectorConfigToDatabase: vi.fn((key: string, value: unknown) => {
      stored.set(key, value);
    }),
    __reset: () => {
      stored.clear();
    },
  };
});

import {
  isChatCaptureEnabledForUser,
  readSkillAutosaveUserPref,
  writeSkillAutosaveConfig,
  writeSkillAutosaveUserPref,
} from "@/lib/skill-autosave";
import * as db from "@/lib/database";

beforeEach(() => {
  (db as unknown as { __reset: () => void }).__reset();
  vi.clearAllMocks();
});

describe("per-user chat-capture preference (cinatra#1367)", () => {
  it("defaults to null (follow the admin default)", () => {
    expect(readSkillAutosaveUserPref("user-1")).toEqual({ chatCaptureEnabled: null });
  });

  it("round-trips a boolean and is keyed PER USER", () => {
    writeSkillAutosaveUserPref("user-1", { chatCaptureEnabled: false });
    expect(readSkillAutosaveUserPref("user-1")).toEqual({ chatCaptureEnabled: false });
    expect(readSkillAutosaveUserPref("user-2")).toEqual({ chatCaptureEnabled: null });
  });

  it("null write resets to follow-default", () => {
    writeSkillAutosaveUserPref("user-1", { chatCaptureEnabled: false });
    writeSkillAutosaveUserPref("user-1", { chatCaptureEnabled: null });
    expect(readSkillAutosaveUserPref("user-1")).toEqual({ chatCaptureEnabled: null });
  });

  it("master switch OFF is a hard gate regardless of the user preference", () => {
    writeSkillAutosaveConfig({ enabled: false });
    writeSkillAutosaveUserPref("user-1", { chatCaptureEnabled: true });
    expect(isChatCaptureEnabledForUser("user-1")).toBe(false);
  });

  it("master ON + unset pref follows the admin default (enabled)", () => {
    writeSkillAutosaveConfig({ enabled: true });
    expect(isChatCaptureEnabledForUser("user-1")).toBe(true);
  });

  it("master ON + explicit opt-out disables capture for that user only", () => {
    writeSkillAutosaveConfig({ enabled: true });
    writeSkillAutosaveUserPref("user-1", { chatCaptureEnabled: false });
    expect(isChatCaptureEnabledForUser("user-1")).toBe(false);
    expect(isChatCaptureEnabledForUser("user-2")).toBe(true);
  });
});
