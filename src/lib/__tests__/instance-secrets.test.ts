// Tests verify the encrypt/decrypt contract: round-trip, key validation,
// and auth-tag tamper detection. Implementation uses AES-256-GCM via Node
// `crypto`.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encryptSecret, decryptSecret } from "@/lib/instance-secrets";

// 32-byte hex key for AES-256-GCM. Hex-encoded 32 bytes = 64 hex chars.
const VALID_KEY_HEX =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
// 16-byte hex key (intentionally short — should be rejected).
const SHORT_KEY_HEX = "0123456789abcdef0123456789abcdef";

const ORIGINAL_KEY = process.env.CINATRA_ENCRYPTION_KEY;

beforeEach(() => {
  process.env.CINATRA_ENCRYPTION_KEY = VALID_KEY_HEX;
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) {
    delete process.env.CINATRA_ENCRYPTION_KEY;
  } else {
    process.env.CINATRA_ENCRYPTION_KEY = ORIGINAL_KEY;
  }
});

describe("encryptSecret / decryptSecret round-trip and key validation", () => {
  it("decryptSecret(encryptSecret(plaintext)) returns the original plaintext", () => {
    const plaintext = "hello world";
    const encrypted = encryptSecret(plaintext);
    expect(decryptSecret(encrypted)).toBe(plaintext);
  });

  it("encryptSecret throws when CINATRA_ENCRYPTION_KEY is missing", () => {
    delete process.env.CINATRA_ENCRYPTION_KEY;
    expect(() => encryptSecret("x")).toThrow(/CINATRA_ENCRYPTION_KEY/);
  });

  it("encryptSecret throws when CINATRA_ENCRYPTION_KEY is the wrong length", () => {
    process.env.CINATRA_ENCRYPTION_KEY = SHORT_KEY_HEX;
    expect(() => encryptSecret("x")).toThrow(/32 bytes/);
  });

  it("encryptSecret produces base64-shaped ciphertext", () => {
    const { ciphertext } = encryptSecret("hello");
    expect(ciphertext).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it("encryptSecret produces base64-shaped iv", () => {
    const { iv } = encryptSecret("hello");
    expect(iv).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });
});

describe("decryptSecret auth-tag tamper detection", () => {
  it("decryptSecret throws when the ciphertext byte-tail is mutated (auth-tag mismatch)", () => {
    const { ciphertext, iv } = encryptSecret("sensitive value");
    // Decode → flip last byte → re-encode. The auth-tag is concatenated into
    // the ciphertext blob, so any single-byte mutation invalidates GCM
    // authentication.
    const decoded = Buffer.from(ciphertext, "base64");
    decoded[decoded.length - 1] = decoded[decoded.length - 1] ^ 0x01;
    const tampered = decoded.toString("base64");
    expect(() => decryptSecret({ ciphertext: tampered, iv })).toThrow();
  });
});
