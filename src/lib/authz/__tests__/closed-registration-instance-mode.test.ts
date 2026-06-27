/**
 * Closed-registration instance-mode helpers (D8).
 *
 * Covers the is/set round-trip + default false + the read-modify-write that
 * preserves sibling instance_identity keys (singleOrg), and the config-read
 * failure → FAIL OPEN contract (D5).
 *
 * `@/lib/database` is replaced with an in-memory connector_config store so the
 * helpers' read-modify-write (`readConnectorConfigFromDatabase` /
 * `writeConnectorConfigToDatabase`) is exercised without a real Postgres.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const store = new Map<string, unknown>();
let throwOnRead = false;

vi.mock("@/lib/database", () => ({
  readConnectorConfigFromDatabase: <T,>(connectorId: string, fallback: T): T => {
    if (throwOnRead) throw new Error("db unavailable");
    return (store.has(connectorId) ? (store.get(connectorId) as T) : fallback);
  },
  writeConnectorConfigToDatabase: (connectorId: string, value: unknown) => {
    store.set(connectorId, value);
  },
}));

import {
  isRegistrationClosed,
  setRegistrationClosed,
  isSingleOrgMode,
  setSingleOrgMode,
} from "../instance-mode";

beforeEach(() => {
  store.clear();
  throwOnRead = false;
});

describe("closed-registration instance-mode", () => {
  it("defaults to false (open) when nothing is stored", async () => {
    expect(await isRegistrationClosed()).toBe(false);
  });

  it("round-trips set/is for closed=true then closed=false", async () => {
    await setRegistrationClosed(true);
    expect(await isRegistrationClosed()).toBe(true);
    await setRegistrationClosed(false);
    expect(await isRegistrationClosed()).toBe(false);
  });

  it("only a stored primitive `true` resolves closed (fail-soft on garbage)", async () => {
    store.set("instance_identity", { closedRegistration: "true" });
    expect(await isRegistrationClosed()).toBe(false);
    store.set("instance_identity", { closedRegistration: 1 });
    expect(await isRegistrationClosed()).toBe(false);
  });

  it("setRegistrationClosed preserves a sibling singleOrg key (D8 RMW)", async () => {
    await setSingleOrgMode(true);
    await setRegistrationClosed(true);
    const stored = store.get("instance_identity") as Record<string, unknown>;
    expect(stored.singleOrg).toBe(true);
    expect(stored.closedRegistration).toBe(true);
    // and reading each back still works
    expect(await isSingleOrgMode()).toBe(true);
    expect(await isRegistrationClosed()).toBe(true);
  });

  it("setSingleOrgMode preserves a sibling closedRegistration key (D8 RMW)", async () => {
    await setRegistrationClosed(true);
    await setSingleOrgMode(true);
    const stored = store.get("instance_identity") as Record<string, unknown>;
    expect(stored.closedRegistration).toBe(true);
    expect(stored.singleOrg).toBe(true);
  });

  it("config-read failure → FAIL OPEN (returns false, never throws) — D5", async () => {
    throwOnRead = true;
    await expect(isRegistrationClosed()).resolves.toBe(false);
  });
});
