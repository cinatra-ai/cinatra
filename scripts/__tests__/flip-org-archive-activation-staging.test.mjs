// cinatra#1942 V5 — the STAGING/TEST-ONLY org_archive_activation flip.
// Pins: the explicit opt-in fence (refuses without CINATRA_ORG_ARCHIVE_
// STAGING_FLIP=allow — this script must never be the production activation),
// the independent host-affirmation fence (PR #2273 hardening — a
// caller-controlled env var alone is not a trustworthy staging/production
// boundary), the idempotent on/off write + CACHE-BYPASSING read-back
// verification (PR #2273 hardening — a write-through cache must not be able
// to mask a durable-storage divergence), and the usage error. The core is
// dependency-injected; no database module is ever imported here.

import { describe, it, expect } from "vitest";
import {
  runStagingArchiveGateFlip,
  parseStagingHostFlag,
  resolveConnectionHost,
  describeHostMismatch,
  STAGING_FLIP_OPTIN_ENV,
  STAGING_FLIP_OPTIN_VALUE,
  STAGING_HOST_FLAG,
} from "../ops/flip-org-archive-activation-staging.mjs";

const HOST = "staging-db.internal";

function fakeStore(initial = null) {
  const rows = new Map();
  if (initial !== null) rows.set("org_archive_activation", initial);
  return {
    rows,
    read: (key) => rows.get(key) ?? null,
    readPersisted: (key) => rows.get(key) ?? null,
    write: (key, value) => rows.set(key, value),
  };
}

/**
 * Models a write-through cache that diverges from durable storage: `write`
 * only updates the cache map, never the durable map, so a verification read
 * that goes through `read` (the cache) sees the intended value while a
 * verification read that goes through `readPersisted` (durable) does not.
 */
function fakeCacheDivergentStore(initial = null) {
  const durable = new Map();
  const cache = new Map();
  if (initial !== null) {
    durable.set("org_archive_activation", initial);
    cache.set("org_archive_activation", initial);
  }
  return {
    durable,
    cache,
    read: (key) => cache.get(key) ?? null,
    readPersisted: (key) => durable.get(key) ?? null,
    write: (key, value) => {
      cache.set(key, value); // the write-through cache "sees" the write...
      // ...but durable storage silently does not (the bug this test pins).
    },
  };
}

const OPTIN = { [STAGING_FLIP_OPTIN_ENV]: STAGING_FLIP_OPTIN_VALUE };
const HOST_ARGS = { affirmedHost: HOST, actualHost: HOST };

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
      readPersisted: store.readPersisted,
      write: store.write,
      ...HOST_ARGS,
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
      readPersisted: store.readPersisted,
      write: store.write,
      ...HOST_ARGS,
    });
    expect(result.ok).toBe(false);
    expect(result.usage).toBe(true);
    expect(store.rows.size).toBe(0);
  });
});

describe("runStagingArchiveGateFlip — host-affirmation fence (PR #2273)", () => {
  it("refuses when the actual connection host cannot be resolved, and writes NOTHING", async () => {
    const store = fakeStore();
    const result = await runStagingArchiveGateFlip({
      mode: "on",
      env: OPTIN,
      read: store.read,
      readPersisted: store.readPersisted,
      write: store.write,
      affirmedHost: HOST,
      actualHost: null,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("could not determine the target database host");
    expect(store.rows.size).toBe(0);
  });

  it("refuses when --i-verified-staging-host is missing, and writes NOTHING", async () => {
    const store = fakeStore();
    const result = await runStagingArchiveGateFlip({
      mode: "on",
      env: OPTIN,
      read: store.read,
      readPersisted: store.readPersisted,
      write: store.write,
      affirmedHost: null,
      actualHost: HOST,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain(STAGING_HOST_FLAG);
    expect(store.rows.size).toBe(0);
  });

  it("refuses when the affirmed host does not match the actual connection host, and writes NOTHING", async () => {
    const store = fakeStore();
    const result = await runStagingArchiveGateFlip({
      mode: "on",
      env: OPTIN,
      read: store.read,
      readPersisted: store.readPersisted,
      write: store.write,
      affirmedHost: "wrong-host.example",
      actualHost: HOST,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("does not match the actual connection host");
    expect(store.rows.size).toBe(0);
  });

  it("passes when the affirmed host matches case-insensitively", async () => {
    const store = fakeStore();
    const result = await runStagingArchiveGateFlip({
      mode: "on",
      env: OPTIN,
      read: store.read,
      readPersisted: store.readPersisted,
      write: store.write,
      affirmedHost: HOST.toUpperCase(),
      actualHost: HOST,
    });
    expect(result.ok).toBe(true);
  });
});

describe("describeHostMismatch / parseStagingHostFlag / resolveConnectionHost — pure helpers", () => {
  it("parseStagingHostFlag extracts the flag value from argv", () => {
    expect(
      parseStagingHostFlag(["node", "script.mjs", "--on", `${STAGING_HOST_FLAG}db.example`]),
    ).toBe("db.example");
  });

  it("parseStagingHostFlag returns null when absent or blank", () => {
    expect(parseStagingHostFlag(["node", "script.mjs", "--on"])).toBeNull();
    expect(parseStagingHostFlag(["node", "script.mjs", `${STAGING_HOST_FLAG}`])).toBeNull();
  });

  it("resolveConnectionHost parses the hostname out of a postgres URL", () => {
    expect(resolveConnectionHost("postgresql://user@db.example:5432/postgres")).toBe(
      "db.example",
    );
  });

  it("resolveConnectionHost returns null for missing/unparseable input", () => {
    expect(resolveConnectionHost(undefined)).toBeNull();
    expect(resolveConnectionHost("")).toBeNull();
    expect(resolveConnectionHost("not a url")).toBeNull();
  });

  it("describeHostMismatch returns null (pass) only on an exact case-insensitive match", () => {
    expect(describeHostMismatch("Db.Example", "db.example")).toBeNull();
    expect(describeHostMismatch("other", "db.example")).not.toBeNull();
  });
});

describe("runStagingArchiveGateFlip — idempotent on/off with cache-bypassing read-back verify", () => {
  it("--on writes {enabled:true} and verifies against persisted storage", async () => {
    const store = fakeStore();
    const result = await runStagingArchiveGateFlip({
      mode: "on",
      env: OPTIN,
      read: store.read,
      readPersisted: store.readPersisted,
      write: store.write,
      ...HOST_ARGS,
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
      readPersisted: store.readPersisted,
      write: store.write,
      ...HOST_ARGS,
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
      readPersisted: store.readPersisted,
      write: store.write,
      ...HOST_ARGS,
    });
    expect(result.ok).toBe(true);
    expect(store.read("org_archive_activation")).toEqual({ enabled: true });
  });

  it("fails when the cache-bypassing read-back does not reflect the write (store broken)", async () => {
    const result = await runStagingArchiveGateFlip({
      mode: "on",
      env: OPTIN,
      read: () => ({ enabled: false }),
      readPersisted: () => ({ enabled: false }),
      write: () => {},
      ...HOST_ARGS,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("did not verify against persisted storage");
  });

  it("fails when the connector-config cache diverges from durable storage — a write-through cache must not mask this (PR #2273)", async () => {
    const store = fakeCacheDivergentStore();
    const result = await runStagingArchiveGateFlip({
      mode: "on",
      env: OPTIN,
      read: store.read,
      readPersisted: store.readPersisted,
      write: store.write,
      ...HOST_ARGS,
    });
    // The cache "saw" the write (this is what a cache-through `read` would
    // have reported, which is exactly why verification must NOT use `read`).
    expect(store.cache.get("org_archive_activation")).toEqual({ enabled: true });
    // Durable storage never actually changed.
    expect(store.durable.get("org_archive_activation") ?? null).toBeNull();
    // The cache-bypassing verification catches the divergence and refuses.
    expect(result.ok).toBe(false);
    expect(result.message).toContain("did not verify against persisted storage");
  });
});
