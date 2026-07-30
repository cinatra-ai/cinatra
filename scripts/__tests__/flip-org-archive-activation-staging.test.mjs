// cinatra#1942 V5 — the STAGING/TEST-ONLY org_archive_activation flip.
// Pins: the explicit opt-in fence (refuses without CINATRA_ORG_ARCHIVE_
// STAGING_FLIP=allow — this script must never be the production activation),
// the idempotent on/off write + read-back verification, and the usage error.
// The core is dependency-injected; no database module is ever imported here.

import { describe, it, expect } from "vitest";
import {
  runStagingArchiveGateFlip,
  STAGING_FLIP_OPTIN_ENV,
  STAGING_FLIP_OPTIN_VALUE,
} from "../ops/flip-org-archive-activation-staging.mjs";

function fakeStore(initial = null) {
  const rows = new Map();
  if (initial !== null) rows.set("org_archive_activation", initial);
  return {
    rows,
    read: (key) => rows.get(key) ?? null,
    write: (key, value) => rows.set(key, value),
  };
}

const OPTIN = { [STAGING_FLIP_OPTIN_ENV]: STAGING_FLIP_OPTIN_VALUE };

describe("runStagingArchiveGateFlip — opt-in fence", () => {
  it.each([
    ["missing env", {}],
    ["wrong value", { [STAGING_FLIP_OPTIN_ENV]: "yes" }],
    ["empty value", { [STAGING_FLIP_OPTIN_ENV]: "" }],
  ])("refuses without the explicit opt-in (%s) and writes NOTHING", async (_label, env) => {
    const store = fakeStore();
    const result = await runStagingArchiveGateFlip({
      mode: "on",
      env,
      read: store.read,
      write: store.write,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("owner-gated V6");
    expect(store.rows.size).toBe(0);
  });

  it("rejects an unknown mode as a usage error before touching the store", async () => {
    const store = fakeStore();
    const result = await runStagingArchiveGateFlip({
      mode: "--sideways",
      env: OPTIN,
      read: store.read,
      write: store.write,
    });
    expect(result.ok).toBe(false);
    expect(result.usage).toBe(true);
    expect(store.rows.size).toBe(0);
  });
});

describe("runStagingArchiveGateFlip — idempotent on/off with read-back verify", () => {
  it("--on writes {enabled:true} and verifies", async () => {
    const store = fakeStore();
    const result = await runStagingArchiveGateFlip({
      mode: "on",
      env: OPTIN,
      read: store.read,
      write: store.write,
    });
    expect(result.ok).toBe(true);
    expect(store.read("org_archive_activation")).toEqual({ enabled: true });
  });

  it("--off writes {enabled:false} and verifies (the staging rollback half)", async () => {
    const store = fakeStore({ enabled: true });
    const result = await runStagingArchiveGateFlip({
      mode: "off",
      env: OPTIN,
      read: store.read,
      write: store.write,
    });
    expect(result.ok).toBe(true);
    expect(store.read("org_archive_activation")).toEqual({ enabled: false });
    expect(result.message).toContain("Unarchive");
  });

  it("re-running the same direction is an idempotent success", async () => {
    const store = fakeStore({ enabled: true });
    const result = await runStagingArchiveGateFlip({
      mode: "on",
      env: OPTIN,
      read: store.read,
      write: store.write,
    });
    expect(result.ok).toBe(true);
    expect(store.read("org_archive_activation")).toEqual({ enabled: true });
  });

  it("fails when the read-back does not reflect the write (store broken)", async () => {
    const result = await runStagingArchiveGateFlip({
      mode: "on",
      env: OPTIN,
      read: () => ({ enabled: false }),
      write: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("did not verify");
  });
});
