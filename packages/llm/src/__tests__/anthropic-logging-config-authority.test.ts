/**
 * Anthropic logging enabled-flag authority (#1715 D2).
 *
 * Regression pin: the Anthropic log WRITER must gate on the PERSISTED
 * connector-config authority, NOT on core module state. Module state is
 * realm-local, so once the adapter relocates into its connector an admin toggle
 * would never reach a connector-realm writer. These tests prove the writer
 * (and telemetry's settings reader) honor the persisted value even when the
 * legacy module-state cache says otherwise.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Persisted-authority stand-in: a mutable flag the mocked host reader returns.
const persisted = vi.hoisted(() => ({ enabled: true }));

vi.mock("@/lib/database", () => ({
  readAnthropicLoggingEnabledFromDatabase: vi.fn(() => persisted.enabled),
}));
// telemetry.ts imports this for the openai/gemini surface writers (unused on
// the anthropic path) — resolve it to the degraded (null) surface.
vi.mock("@/lib/llm-provider-surfaces", () => ({
  getLlmProviderSurface: vi.fn(() => null),
}));

// Mock the fs surface writeAnthropicLogFile touches so nothing hits disk.
const fsMocks = vi.hoisted(() => ({
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
  readdir: vi.fn(async () => [] as string[]),
  rm: vi.fn(async () => undefined),
}));
vi.mock("node:fs/promises", () => fsMocks);

import {
  writeAnthropicLogFile,
  getAnthropicLoggingSettings,
  setAnthropicLoggingEnabled,
} from "../telemetry";

beforeEach(() => {
  persisted.enabled = true;
  fsMocks.mkdir.mockClear();
  fsMocks.writeFile.mockClear();
  fsMocks.readdir.mockClear();
  fsMocks.rm.mockClear();
});

describe("writeAnthropicLogFile — persisted-authority gate (#1715 D2)", () => {
  it("does NOT write when the persisted flag is disabled — even if module-state cache says enabled", async () => {
    persisted.enabled = false;
    // Legacy module-state cache disagrees (this is exactly the connector-realm
    // split-brain the fix closes): the writer must ignore it.
    setAnthropicLoggingEnabled(true);

    await writeAnthropicLogFile({ label: "unit", kind: "request", body: { hello: "world" } });

    expect(fsMocks.writeFile).not.toHaveBeenCalled();
    expect(fsMocks.mkdir).not.toHaveBeenCalled();
  });

  it("DOES write when the persisted flag is enabled — even if module-state cache says disabled", async () => {
    persisted.enabled = true;
    setAnthropicLoggingEnabled(false);

    await writeAnthropicLogFile({ label: "unit", kind: "request", body: { hello: "world" } });

    expect(fsMocks.writeFile).toHaveBeenCalledTimes(1);
    expect(fsMocks.mkdir).toHaveBeenCalledTimes(1);
  });
});

describe("getAnthropicLoggingSettings (telemetry) — reflects the persisted authority", () => {
  it("returns the persisted enabled value, not the module-state cache", () => {
    persisted.enabled = false;
    setAnthropicLoggingEnabled(true);
    expect(getAnthropicLoggingSettings().enabled).toBe(false);

    persisted.enabled = true;
    setAnthropicLoggingEnabled(false);
    expect(getAnthropicLoggingSettings().enabled).toBe(true);
  });
});
