import { describe, expect, it, beforeEach } from "vitest";

import {
  createTokenBroker,
  normalizeOriginStrict,
  sha256Hex,
  type TokenBroker,
  type TokenBrokerStore,
  type TokenRow,
  type StoredTokenRow,
} from "../token-broker";

// In-memory store — the host's Postgres-backed store is injected in prod; here
// we prove the broker mechanics with no DB. `expiresAt` is computed app-side
// (in prod the DB clock owns it; the broker passes ttlSeconds for that).
function makeMemoryStore(): TokenBrokerStore & {
  rows: Map<string, TokenRow & { expiresAt: number }>;
} {
  const rows = new Map<string, TokenRow & { expiresAt: number }>();
  return {
    rows,
    insert(row, ttlSeconds) {
      rows.set(row.tokenHash, { ...row, expiresAt: Date.now() + ttlSeconds * 1000 });
    },
    lookupByHash(tokenHash): StoredTokenRow | null {
      const r = rows.get(tokenHash);
      if (!r) return null;
      const { tokenHash: _omit, expiresAt, ...rest } = r;
      void _omit;
      return { ...rest, notExpired: expiresAt > Date.now() };
    },
    deleteByHash(tokenHash) {
      rows.delete(tokenHash);
    },
    sweepExpired() {
      const now = Date.now();
      for (const [k, v] of rows) if (v.expiresAt <= now) rows.delete(k);
    },
  };
}

const CONFIGURED_ORIGIN = "https://site.example";
const LONG_LIVED_KEY = "11111111-1111-1111-1111-111111111111-22222222-2222-2222-2222-222222222222";

function makeBroker(over?: {
  store?: TokenBrokerStore;
  longLivedKey?: () => string;
  isConfiguredOrigin?: (o: string) => boolean;
  ttlSeconds?: number;
}): TokenBroker {
  return createTokenBroker({
    store: over?.store ?? makeMemoryStore(),
    config: {
      readLongLivedKey: over?.longLivedKey ?? (() => LONG_LIVED_KEY),
      isConfiguredOrigin:
        over?.isConfiguredOrigin ?? ((o) => normalizeOriginStrict(o) === CONFIGURED_ORIGIN),
    },
    prefix: "cst_",
    ttlSeconds: over?.ttlSeconds ?? 300,
    keyFingerprintSalt: "cinatra:streams:test:key-fingerprint:v1",
    keyFingerprintInfo: "rotation-fingerprint",
  });
}

const SUBJECT = "x-content-editor";
const AUD = "/api/streams/x-content-editor";
const SCOPE = "x-content-editor.stream";

function mintHappy(broker: TokenBroker) {
  return broker.mint({
    subject: SUBJECT,
    aud: AUD,
    scope: SCOPE,
    origin: CONFIGURED_ORIGIN,
    issuerBaseUrl: "https://issuer.example",
  });
}

describe("token-broker", () => {
  describe("normalizeOriginStrict", () => {
    it("returns scheme://host[:port] only", () => {
      expect(normalizeOriginStrict("https://a.example/path?x=1#h")).toBe("https://a.example");
      expect(normalizeOriginStrict("http://a.example:8080")).toBe("http://a.example:8080");
    });
    it("rejects non-http(s) and garbage", () => {
      expect(normalizeOriginStrict("ftp://a.example")).toBe("");
      expect(normalizeOriginStrict("not a url")).toBe("");
      expect(normalizeOriginStrict("")).toBe("");
      expect(normalizeOriginStrict(null)).toBe("");
    });
  });

  it("mint → consume happy path", () => {
    const broker = makeBroker();
    const minted = mintHappy(broker);
    expect(minted).not.toBeNull();
    expect(minted!.token).toMatch(/^cst_/);
    expect(minted!.tokenType).toBe("Bearer");
    expect(minted!.expiresIn).toBe(300);
    expect(minted!.scope).toBe(SCOPE);

    const result = broker.consume({
      token: minted!.token,
      subject: SUBJECT,
      routePath: AUD,
      expectedScope: SCOPE,
      requestOrigin: CONFIGURED_ORIGIN,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.origin).toBe(CONFIGURED_ORIGIN);
  });

  it("hash-at-rest: stored key is SHA-256(token), the raw token is never stored", () => {
    const store = makeMemoryStore();
    const broker = makeBroker({ store });
    const minted = mintHappy(broker)!;
    const keys = [...store.rows.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toBe(sha256Hex(minted.token));
    // The raw token string appears nowhere as a stored value.
    for (const v of store.rows.values()) {
      expect(JSON.stringify(v)).not.toContain(minted.token);
    }
  });

  it("mint returns null when origin does not normalize", () => {
    const broker = makeBroker();
    expect(
      broker.mint({
        subject: SUBJECT,
        aud: AUD,
        scope: SCOPE,
        origin: "not-a-url",
        issuerBaseUrl: "https://issuer.example",
      }),
    ).toBeNull();
  });

  it("mint returns null when no long-lived key is configured", () => {
    const broker = makeBroker({ longLivedKey: () => "" });
    expect(mintHappy(broker)).toBeNull();
  });

  it("consume rejects a non-prefix token (not_broker_token)", () => {
    const broker = makeBroker();
    const r = broker.consume({
      token: "Bearer abc",
      subject: SUBJECT,
      routePath: AUD,
      expectedScope: SCOPE,
      requestOrigin: CONFIGURED_ORIGIN,
    });
    expect(r).toEqual({ ok: false, reason: "not_broker_token" });
  });

  it("consume rejects an unknown token (not_found)", () => {
    const broker = makeBroker();
    const r = broker.consume({
      token: "cst_unknownunknownunknown",
      subject: SUBJECT,
      routePath: AUD,
      expectedScope: SCOPE,
      requestOrigin: CONFIGURED_ORIGIN,
    });
    expect(r).toEqual({ ok: false, reason: "not_found" });
  });

  it("consume rejects expired (and deletes the row)", () => {
    const store = makeMemoryStore();
    const broker = makeBroker({ store, ttlSeconds: 0 });
    const minted = mintHappy(broker)!;
    // ttlSeconds 0 → expiresAt == now → notExpired false on the next tick.
    const r = broker.consume({
      token: minted.token,
      subject: SUBJECT,
      routePath: AUD,
      expectedScope: SCOPE,
      requestOrigin: CONFIGURED_ORIGIN,
    });
    expect(r).toEqual({ ok: false, reason: "expired" });
    expect(store.rows.has(sha256Hex(minted.token))).toBe(false);
  });

  it("consume rejects subject_mismatch", () => {
    const broker = makeBroker();
    const minted = mintHappy(broker)!;
    const r = broker.consume({
      token: minted.token,
      subject: "other-agent",
      routePath: AUD,
      expectedScope: SCOPE,
      requestOrigin: CONFIGURED_ORIGIN,
    });
    expect(r).toEqual({ ok: false, reason: "subject_mismatch" });
  });

  it("consume rejects aud_mismatch", () => {
    const broker = makeBroker();
    const minted = mintHappy(broker)!;
    const r = broker.consume({
      token: minted.token,
      subject: SUBJECT,
      routePath: "/api/streams/other",
      expectedScope: SCOPE,
      requestOrigin: CONFIGURED_ORIGIN,
    });
    expect(r).toEqual({ ok: false, reason: "aud_mismatch" });
  });

  it("consume rejects scope_mismatch", () => {
    const broker = makeBroker();
    const minted = mintHappy(broker)!;
    const r = broker.consume({
      token: minted.token,
      subject: SUBJECT,
      routePath: AUD,
      expectedScope: "wrong.scope",
      requestOrigin: CONFIGURED_ORIGIN,
    });
    expect(r).toEqual({ ok: false, reason: "scope_mismatch" });
  });

  it("consume rejects origin_mismatch (request Origin differs from bound)", () => {
    const broker = makeBroker();
    const minted = mintHappy(broker)!;
    const r = broker.consume({
      token: minted.token,
      subject: SUBJECT,
      routePath: AUD,
      expectedScope: SCOPE,
      requestOrigin: "https://evil.example",
    });
    expect(r).toEqual({ ok: false, reason: "origin_mismatch" });
  });

  it("consume rejects origin_unconfigured (bound origin no longer configured)", () => {
    let configured = true;
    const broker = makeBroker({ isConfiguredOrigin: () => configured });
    const minted = mintHappy(broker)!;
    configured = false; // instance removed after mint
    const r = broker.consume({
      token: minted.token,
      subject: SUBJECT,
      routePath: AUD,
      expectedScope: SCOPE,
      requestOrigin: CONFIGURED_ORIGIN,
    });
    expect(r).toEqual({ ok: false, reason: "origin_unconfigured" });
  });

  it("consume rejects key_rotated (long-lived key changed after mint)", () => {
    let key = LONG_LIVED_KEY;
    const broker = makeBroker({ longLivedKey: () => key });
    const minted = mintHappy(broker)!;
    key = "rotated-rotated-rotated-rotated-rotated-rotated-rotated-key"; // rotated
    const r = broker.consume({
      token: minted.token,
      subject: SUBJECT,
      routePath: AUD,
      expectedScope: SCOPE,
      requestOrigin: CONFIGURED_ORIGIN,
    });
    expect(r).toEqual({ ok: false, reason: "key_rotated" });
  });

  it("isAuthorizedLongLivedKey: constant-time equality with the configured key", () => {
    const broker = makeBroker();
    expect(broker.isAuthorizedLongLivedKey(LONG_LIVED_KEY)).toBe(true);
    expect(broker.isAuthorizedLongLivedKey("wrong")).toBe(false);
    expect(broker.isAuthorizedLongLivedKey("")).toBe(false);
  });

  describe("rotation fingerprint", () => {
    let broker: TokenBroker;
    beforeEach(() => {
      broker = makeBroker();
    });
    it("is deterministic for the same key and differs across keys", () => {
      const a = broker.keyFingerprintHex(LONG_LIVED_KEY);
      const b = broker.keyFingerprintHex(LONG_LIVED_KEY);
      const c = broker.keyFingerprintHex(LONG_LIVED_KEY + "x");
      expect(a).toBe(b);
      expect(a).not.toBe(c);
      expect(a).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});
