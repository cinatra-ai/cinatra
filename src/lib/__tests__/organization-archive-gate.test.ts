// cinatra#1937 (archive S1) — the default-OFF activation gate + refusing
// archive stub. Pins: fail-CLOSED gate reads (error/absent/non-true → OFF —
// the deliberate inversion of the fail-open instance-mode toggles), the stub
// refusing with `activation-gate-off` while off, and refusing as
// `not-implemented` even when the gate is on (no S1 code path archives).

import { describe, it, expect, vi, beforeEach } from "vitest";

const readConnectorConfigFromDatabase = vi.fn();
vi.mock("@/lib/database", () => ({
  readConnectorConfigFromDatabase: (...a: unknown[]) =>
    readConnectorConfigFromDatabase(...a),
}));

import {
  archiveOrganization,
  isArchiveActivationEnabled,
  ORG_ARCHIVE_ACTIVATION_CONFIG_KEY,
} from "@/lib/organization-archive";

beforeEach(() => {
  readConnectorConfigFromDatabase.mockReset();
});

describe("isArchiveActivationEnabled — fail-closed gate", () => {
  it("only a stored literal true enables", async () => {
    readConnectorConfigFromDatabase.mockReturnValue({ enabled: true });
    await expect(isArchiveActivationEnabled()).resolves.toBe(true);
    expect(readConnectorConfigFromDatabase).toHaveBeenCalledWith(
      ORG_ARCHIVE_ACTIVATION_CONFIG_KEY,
      null,
    );
  });

  it.each([
    ["absent row", null],
    ["empty config", {}],
    ["explicit false", { enabled: false }],
    ["truthy non-true string", { enabled: "true" }],
    ["truthy number", { enabled: 1 }],
  ])("OFF for %s", async (_label, cfg) => {
    readConnectorConfigFromDatabase.mockReturnValue(cfg);
    await expect(isArchiveActivationEnabled()).resolves.toBe(false);
  });

  it("OFF when the config read throws (fail closed — never activate on error)", async () => {
    readConnectorConfigFromDatabase.mockImplementation(() => {
      throw new Error("db down");
    });
    await expect(isArchiveActivationEnabled()).resolves.toBe(false);
  });
});

describe("archiveOrganization — S1 refusing stub", () => {
  it("refuses with activation-gate-off while the gate is off", async () => {
    readConnectorConfigFromDatabase.mockReturnValue(null);
    await expect(archiveOrganization("org_1", "user_1")).resolves.toEqual({
      ok: false,
      reason: "activation-gate-off",
    });
  });

  it("refuses as not-implemented even with the gate on — no S1 path archives", async () => {
    readConnectorConfigFromDatabase.mockReturnValue({ enabled: true });
    await expect(archiveOrganization("org_1", "user_1")).resolves.toEqual({
      ok: false,
      reason: "not-implemented",
    });
  });
});
