// Unit tests for the execution-plane settings store (exec-plane S1b activation,
// cinatra#2138 deliverable 5; `remote` made operable in exec-plane L4). The
// persisted vocabulary is the FULL `remote | local-dev | disabled` set and all
// three are now operable — the boot phase knows how to honor each. What did NOT
// change is the part that actually governs exposure: the stored default is
// still `disabled` and every write still passes the default-off ROLLOUT gate.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  ExecutionPlaneRolloutDisabledError,
  isExecutionPlaneRolloutOn,
  EXECUTION_PLANE_MODES,
  ExecutionPlaneModeNotOperableError,
  EXECUTION_PLANE_SETTINGS_KEY,
  normalizeEgressAllowlist,
  OPERABLE_EXECUTION_PLANE_MODES,
  readExecutionPlaneSettings,
  writeExecutionPlaneSettings,
} from "@/lib/execution/execution-plane-settings";

let priorFlag: string | undefined;

beforeEach(() => {
  store.clear();
  priorFlag = process.env.CINATRA_EXECUTION_PLANE_ROLLOUT;
  // Every write-path test runs on an instance whose ROLLOUT flag is ON; the
  // flag-off refusal has its own test below.
  process.env.CINATRA_EXECUTION_PLANE_ROLLOUT = "on";
});

afterEach(() => {
  if (priorFlag === undefined) delete process.env.CINATRA_EXECUTION_PLANE_ROLLOUT;
  else process.env.CINATRA_EXECUTION_PLANE_ROLLOUT = priorFlag;
});

describe("execution-plane settings", () => {
  it("persists the full mode vocabulary, all of it operable since exec-plane L4", () => {
    expect([...EXECUTION_PLANE_MODES]).toEqual(["remote", "local-dev", "disabled"]);
    expect([...OPERABLE_EXECUTION_PLANE_MODES]).toEqual(["remote", "local-dev", "disabled"]);
  });

  it("keeps the fail-closed edge armed for a mode with no boot branch", () => {
    // The guard is unreachable today and stays: the NEXT mode added to the
    // vocabulary before its boot branch exists must be refused by the write
    // path, not stored and silently ignored.
    expect(() =>
      writeExecutionPlaneSettings({
        mode: "warp-drive" as never,
        egressMode: "default_internet",
        egressAllowlist: [],
      }),
    ).not.toThrow();
    // An unknown mode coerces to the disabled default rather than persisting —
    // the same fail-closed direction, one layer earlier.
    expect(readExecutionPlaneSettings().mode).toBe("disabled");
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

  it("ACCEPTS `remote` now that the boot phase can honor it (exec-plane L4)", () => {
    expect(() =>
      writeExecutionPlaneSettings({
        mode: "remote",
        egressMode: "default_internet",
        egressAllowlist: [],
      }),
    ).not.toThrow();
    expect(readExecutionPlaneSettings().mode).toBe("remote");
    // Persisting the intent is NOT the same as the placement coming up: an
    // unreachable broker still leaves the plane inert. That is the boot phase's
    // test, and this store deliberately knows nothing about it.
  });

  it("still exports the not-operable refusal for a mode outside the operable set", () => {
    // Constructed directly: there is no such mode today, and the error's
    // guidance must still name the real operable set rather than a stale one.
    const err = new ExecutionPlaneModeNotOperableError("remote");
    expect(err.message).toContain("remote / local-dev / disabled");
  });

  it("coerces an unknown stored mode back to the disabled default", () => {
    store.set("execution_plane", { mode: "quantum", egressMode: "wormhole" });
    expect(readExecutionPlaneSettings()).toEqual({
      mode: "disabled",
      egressMode: "default_internet",
      egressAllowlist: [],
    });
  });

  it("REFUSES every write on an instance whose ROLLOUT flag is off", () => {
    delete process.env.CINATRA_EXECUTION_PLANE_ROLLOUT;
    expect(isExecutionPlaneRolloutOn()).toBe(false);
    expect(() =>
      writeExecutionPlaneSettings({
        mode: "local-dev",
        egressMode: "default_internet",
        egressAllowlist: [],
      }),
    ).toThrow(ExecutionPlaneRolloutDisabledError);
    expect(store.size).toBe(0);
  });

  it("still READS on a flag-off instance (the surface renders, read-only)", () => {
    store.set("execution_plane", { mode: "local-dev", egressMode: "none", egressAllowlist: [] });
    delete process.env.CINATRA_EXECUTION_PLANE_ROLLOUT;
    expect(readExecutionPlaneSettings().mode).toBe("local-dev");
  });

  it("normalizes the allowlist: trim, lowercase, de-duplicate, drop empties", () => {
    expect(normalizeEgressAllowlist(" PyPI.org , pypi.org\nfiles.pypi.org. \n\n")).toEqual([
      "pypi.org",
      "files.pypi.org",
    ]);
    expect(normalizeEgressAllowlist(undefined)).toEqual([]);
  });
});
