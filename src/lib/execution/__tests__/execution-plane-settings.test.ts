// Unit tests for the execution-plane settings store (exec-plane S1b activation,
// cinatra#2138 deliverable 5). The persisted vocabulary is the FULL
// `remote | local-dev | disabled` set; only `local-dev` and `disabled` are
// operable in this slice, and the write path refuses the rest fail-closed.

import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, unknown>();

vi.mock("@/lib/database", () => ({
  readConnectorConfigFromDatabase: <T,>(key: string, fallback: T): T =>
    (store.has(key) ? (store.get(key) as T) : fallback),
  writeConnectorConfigToDatabase: (key: string, value: unknown) => {
    store.set(key, value);
  },
}));

import {
  DEFAULT_EXECUTION_PLANE_SETTINGS,
  EXECUTION_PLANE_MODES,
  ExecutionPlaneModeNotOperableError,
  EXECUTION_PLANE_SETTINGS_KEY,
  normalizeEgressAllowlist,
  OPERABLE_EXECUTION_PLANE_MODES,
  readExecutionPlaneSettings,
  writeExecutionPlaneSettings,
} from "@/lib/execution/execution-plane-settings";

beforeEach(() => {
  store.clear();
});

describe("execution-plane settings", () => {
  it("persists the full mode vocabulary but marks only two operable", () => {
    expect([...EXECUTION_PLANE_MODES]).toEqual(["remote", "local-dev", "disabled"]);
    expect([...OPERABLE_EXECUTION_PLANE_MODES]).toEqual(["local-dev", "disabled"]);
  });

  it("defaults to disabled when nothing is stored (fail-closed)", () => {
    expect(readExecutionPlaneSettings()).toEqual(DEFAULT_EXECUTION_PLANE_SETTINGS);
    expect(DEFAULT_EXECUTION_PLANE_SETTINGS.mode).toBe("disabled");
  });

  it("round-trips an operable mode through the metadata key", () => {
    writeExecutionPlaneSettings({
      mode: "local-dev",
      egressMode: "allowlist",
      egressAllowlist: "pypi.org\nregistry.npmjs.org",
    });
    expect(store.has(`${EXECUTION_PLANE_SETTINGS_KEY}`) || store.size === 1).toBe(true);
    expect(readExecutionPlaneSettings()).toEqual({
      mode: "local-dev",
      egressMode: "allowlist",
      egressAllowlist: ["pypi.org", "registry.npmjs.org"],
    });
  });

  it("REFUSES `remote` — it renders in the vocabulary but cannot be persisted here", () => {
    expect(() =>
      writeExecutionPlaneSettings({
        mode: "remote",
        egressMode: "default_internet",
        egressAllowlist: [],
      }),
    ).toThrow(ExecutionPlaneModeNotOperableError);
    // Nothing was written — the previous (default) posture stands.
    expect(readExecutionPlaneSettings().mode).toBe("disabled");
  });

  it("coerces an unknown stored mode back to the disabled default", () => {
    store.set("execution_plane", { mode: "quantum", egressMode: "wormhole" });
    expect(readExecutionPlaneSettings()).toEqual({
      mode: "disabled",
      egressMode: "default_internet",
      egressAllowlist: [],
    });
  });

  it("normalizes the allowlist: trim, lowercase, de-duplicate, drop empties", () => {
    expect(normalizeEgressAllowlist(" PyPI.org , pypi.org\nfiles.pypi.org. \n\n")).toEqual([
      "pypi.org",
      "files.pypi.org",
    ]);
    expect(normalizeEgressAllowlist(undefined)).toEqual([]);
  });
});
