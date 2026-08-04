/**
 * Keyed credential fingerprints (cinatra#2388, epic #2385 S3).
 *
 * Pins the security-relevant properties of the host-owned reader:
 *  - the persisted value is a VERSIONED, HOST-SECRET-KEYED digest — never the
 *    raw credential, never an unkeyed hash of it;
 *  - fail-closed on every non-readable outcome (connector missing, no key
 *    reader, thrown read, missing host secret);
 *  - deletion/rotation detection: `absent` and a different key both MISMATCH;
 *  - the match helper accepts exactly {stored ∧ readable ∧ equal}.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CREDENTIAL_FINGERPRINT_VERSION_PREFIX,
  deriveKeyedCredentialFingerprint,
  liveCredentialFingerprintMatches,
  readLiveCredentialFingerprint,
} from "@/lib/llm-credential-fingerprint";

const HOST_SECRET =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const ORIGINAL_KEY = process.env.CINATRA_ENCRYPTION_KEY;

beforeEach(() => {
  process.env.CINATRA_ENCRYPTION_KEY = HOST_SECRET;
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.CINATRA_ENCRYPTION_KEY;
  else process.env.CINATRA_ENCRYPTION_KEY = ORIGINAL_KEY;
});

describe("deriveKeyedCredentialFingerprint", () => {
  it("is versioned, keyed, provider-bound, and never contains the raw credential", () => {
    const fp = deriveKeyedCredentialFingerprint("openai", "sk-SECRET-VALUE", HOST_SECRET);
    expect(fp.startsWith(CREDENTIAL_FINGERPRINT_VERSION_PREFIX)).toBe(true);
    expect(fp).not.toContain("SECRET");
    // KEYED: a different host secret yields a different digest for the same key.
    const otherSecret = deriveKeyedCredentialFingerprint(
      "openai",
      "sk-SECRET-VALUE",
      "another-host-secret-another-host-secret",
    );
    expect(otherSecret).not.toBe(fp);
    // PROVIDER-BOUND: the same key on another provider never cross-matches.
    const otherProvider = deriveKeyedCredentialFingerprint(
      "anthropic",
      "sk-SECRET-VALUE",
      HOST_SECRET,
    );
    expect(otherProvider).not.toBe(fp);
    // Deterministic for the same inputs (that is what makes it a fingerprint).
    expect(deriveKeyedCredentialFingerprint("openai", "sk-SECRET-VALUE", HOST_SECRET)).toBe(fp);
  });
});

describe("readLiveCredentialFingerprint — fail-closed outcomes", () => {
  it("reads a configured key through the connector's async surface", async () => {
    const result = await readLiveCredentialFingerprint("openai", {
      getConfiguredAPIKey: async () => "sk-live-key",
    });
    expect(result.status).toBe("readable");
    if (result.status !== "readable") return;
    expect(result.fingerprint).toBe(
      deriveKeyedCredentialFingerprint("openai", "sk-live-key", HOST_SECRET),
    );
  });

  it("absent connector ⇒ unreadable(connector-unavailable)", async () => {
    expect(await readLiveCredentialFingerprint("openai", null)).toEqual({
      status: "unreadable",
      reason: "connector-unavailable",
    });
  });

  it("a surface with no key reader ⇒ unreadable, never an authoritative 'no key'", async () => {
    expect(await readLiveCredentialFingerprint("openai", {})).toEqual({
      status: "unreadable",
      reason: "no-credential-reader",
    });
  });

  it("a THROWN credential read ⇒ unreadable (and the error is not propagated)", async () => {
    expect(
      await readLiveCredentialFingerprint("openai", {
        getConfiguredAPIKey: async () => {
          throw new Error("nango down; header x-api-key: sk-oops");
        },
      }),
    ).toEqual({ status: "unreadable", reason: "credential-read-failed" });
  });

  it("a missing host secret ⇒ unreadable (never an unkeyed digest fallback)", async () => {
    delete process.env.CINATRA_ENCRYPTION_KEY;
    expect(
      await readLiveCredentialFingerprint("openai", {
        getConfiguredAPIKey: async () => "sk-live-key",
      }),
    ).toEqual({ status: "unreadable", reason: "host-secret-unavailable" });
  });

  it("an empty/missing key ⇒ absent (deletion is a DEFINITE state, distinct from unreadable)", async () => {
    expect(
      await readLiveCredentialFingerprint("openai", {
        getConfiguredAPIKey: async () => null,
      }),
    ).toEqual({ status: "absent" });
    expect(
      await readLiveCredentialFingerprint("openai", {
        getConfiguredAPIKey: async () => "   ",
      }),
    ).toEqual({ status: "absent" });
  });
});

describe("liveCredentialFingerprintMatches — {stored ∧ readable ∧ equal} only", () => {
  const stored = deriveKeyedCredentialFingerprint("openai", "sk-live-key", HOST_SECRET);

  it("matches an identical live digest", () => {
    expect(
      liveCredentialFingerprintMatches(stored, { status: "readable", fingerprint: stored }),
    ).toBe(true);
  });

  it("MISMATCHES rotation, deletion, unreadable, no-stored, and un-versioned values (all fail closed)", () => {
    const rotated = deriveKeyedCredentialFingerprint("openai", "sk-NEW-key", HOST_SECRET);
    expect(
      liveCredentialFingerprintMatches(stored, { status: "readable", fingerprint: rotated }),
    ).toBe(false);
    expect(liveCredentialFingerprintMatches(stored, { status: "absent" })).toBe(false);
    expect(
      liveCredentialFingerprintMatches(stored, {
        status: "unreadable",
        reason: "connector-unavailable",
      }),
    ).toBe(false);
    expect(
      liveCredentialFingerprintMatches(null, { status: "readable", fingerprint: stored }),
    ).toBe(false);
    // An old, differently-derived (un-prefixed) stored value never matches.
    expect(
      liveCredentialFingerprintMatches("legacy-digest", {
        status: "readable",
        fingerprint: "legacy-digest",
      }),
    ).toBe(false);
  });
});
