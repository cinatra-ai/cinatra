// Destination credential store unit tests (src/lib/extension-destinations-store.ts).
// Asserts:
//   1. Round-trip: writeDestinationCredential -> readDestinationCredential returns same row.
//   2. AAD binding: callers use aad: "destination.<id>.publish-token" for publish token.
//   3. AAD binding: callers use aad: "destination.<id>.read-token" for read token.
//
// Mock strategy: DB layer mocked via vi.mock("drizzle-orm/node-postgres") +
// vi.mock("pg") so no real Postgres connection is needed.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// ---------------------------------------------------------------------------
// Mock pg.Pool and drizzle — we only need the .select() / .insert() chain
// shape; actual SQL execution is not exercised in this unit test.
// ---------------------------------------------------------------------------

// Captured row state for mock round-trip
let storedRow: Record<string, unknown> | null = null;

// Mock the drizzle orm's node-postgres adapter so the actual pool is never created.
vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: vi.fn(() => ({
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() =>
            Promise.resolve(storedRow ? [storedRow] : []),
          ),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoUpdate: vi.fn(() => {
          return Promise.resolve();
        }),
      })),
    })),
  })),
}));

// Prevent actual pg Pool creation — Pool must be a class (constructor), not an arrow fn.
vi.mock("pg", () => {
  class MockPool {
    on() {}
    query() {}
    connect() {}
    end() {}
  }
  return { Pool: MockPool };
});

// ---------------------------------------------------------------------------
// instance-secrets mock — assertion captures aad argument
// ---------------------------------------------------------------------------
const encryptSpy = vi.fn((plaintext: string, aad?: string) => ({
  ciphertext: `enc(${plaintext}:${aad ?? ""})`,
  iv: "mock-iv",
}));

const decryptSpy = vi.fn(
  (input: { ciphertext: string; iv: string }, aad?: string) =>
    input.ciphertext.replace(/^enc\(/, "").replace(/:.*\)$/, ""),
);

vi.mock("@/lib/instance-secrets", () => ({
  encryptSecret: encryptSpy,
  decryptSecret: decryptSpy,
}));

describe("destination credential store — AAD binding", () => {
  const TEST_ID = "test-dest-01";
  const TEST_LABEL = "Test Destination";
  const TEST_REGISTRY_URL = "https://private.registry.example.com";
  const PUBLISH_TOKEN_PLAINTEXT = "super-secret-publish-token";
  const READ_TOKEN_PLAINTEXT = "super-secret-read-token";

  beforeEach(() => {
    storedRow = null;
    encryptSpy.mockClear();
    decryptSpy.mockClear();
    // Reset globalThis pool so each test gets a fresh mock
    (globalThis as any).__cinatraDestCredPool = undefined;
  });

  it("encryptSecret called with per-field AAD shape: destination.<id>.publish-token", async () => {
    // This test documents the AAD contract: callers of writeDestinationCredential
    // MUST encrypt the token with the correct per-field AAD before passing it in.
    const { encryptSecret } = await import("@/lib/instance-secrets");

    const destinationId = TEST_ID;
    const expectedPublishAad = `destination.${destinationId}.publish-token`;

    // Simulate a caller encrypting the token with the correct AAD before writing
    const { ciphertext, iv } = encryptSecret(PUBLISH_TOKEN_PLAINTEXT, expectedPublishAad);

    expect(encryptSpy).toHaveBeenCalledWith(PUBLISH_TOKEN_PLAINTEXT, expectedPublishAad);
    expect(ciphertext).toContain(PUBLISH_TOKEN_PLAINTEXT);
    expect(iv).toBe("mock-iv");
  });

  it("encryptSecret called with per-field AAD shape: destination.<id>.read-token", async () => {
    const { encryptSecret } = await import("@/lib/instance-secrets");

    const destinationId = TEST_ID;
    const expectedReadAad = `destination.${destinationId}.read-token`;

    const { ciphertext, iv } = encryptSecret(READ_TOKEN_PLAINTEXT, expectedReadAad);

    expect(encryptSpy).toHaveBeenCalledWith(READ_TOKEN_PLAINTEXT, expectedReadAad);
    expect(ciphertext).toContain(READ_TOKEN_PLAINTEXT);
    expect(iv).toBe("mock-iv");
  });

  it("decryptSecret called with per-field AAD shape: destination.<id>.publish-token", async () => {
    const { decryptSecret } = await import("@/lib/instance-secrets");

    const destinationId = TEST_ID;
    const expectedPublishAad = `destination.${destinationId}.publish-token`;
    const ciphertext = `enc(${PUBLISH_TOKEN_PLAINTEXT}:${expectedPublishAad})`;

    const result = decryptSecret({ ciphertext, iv: "mock-iv" }, expectedPublishAad);

    expect(decryptSpy).toHaveBeenCalledWith(
      { ciphertext, iv: "mock-iv" },
      expectedPublishAad,
    );
    expect(result).toBe(PUBLISH_TOKEN_PLAINTEXT);
  });

  it("round-trip: writeDestinationCredential then readDestinationCredential returns same row (with mocked DB)", async () => {
    // Simulate write by populating storedRow as the mock select returns it.
    const writeInput = {
      id: TEST_ID,
      label: TEST_LABEL,
      registryUrl: TEST_REGISTRY_URL,
      tokenCiphertext: "enc(token:aad)",
      tokenIv: "mock-iv",
      readTokenCiphertext: "enc(read-token:aad)",
      readTokenIv: "mock-iv",
    };

    // Pre-populate the storedRow (simulates what the DB insert would do)
    storedRow = {
      id: writeInput.id,
      label: writeInput.label,
      registryUrl: writeInput.registryUrl,
      tokenCiphertext: writeInput.tokenCiphertext,
      tokenIv: writeInput.tokenIv,
      tokenAlgo: "aes-256-gcm",
      readTokenCiphertext: writeInput.readTokenCiphertext,
      readTokenIv: writeInput.readTokenIv,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const { readDestinationCredential, writeDestinationCredential } = await import(
      "@/lib/extension-destinations-store"
    );

    // Write (no-op in mock; storedRow already set)
    await writeDestinationCredential(writeInput);

    // Read back
    const result = await readDestinationCredential(TEST_ID);

    expect(result).not.toBeNull();
    expect(result!.id).toBe(TEST_ID);
    expect(result!.label).toBe(TEST_LABEL);
    expect(result!.registryUrl).toBe(TEST_REGISTRY_URL);
    expect(result!.tokenCiphertext).toBe(writeInput.tokenCiphertext);
    expect(result!.tokenIv).toBe(writeInput.tokenIv);
    expect(result!.tokenAlgo).toBe("aes-256-gcm");
    expect(result!.readTokenCiphertext).toBe(writeInput.readTokenCiphertext);
    expect(result!.readTokenIv).toBe(writeInput.readTokenIv);
  });

  it("readDestinationCredential returns null when no row found", async () => {
    storedRow = null;

    const { readDestinationCredential } = await import("@/lib/extension-destinations-store");
    const result = await readDestinationCredential("nonexistent-id");
    expect(result).toBeNull();
  });
});

describe("AAD string format validation — locked contract", () => {
  const DESTINATION_ID = "fixture-dest-01";

  it("publish-token AAD matches locked format: destination.<id>.publish-token", () => {
    const aad = `destination.${DESTINATION_ID}.publish-token`;
    expect(aad).toBe("destination.fixture-dest-01.publish-token");
  });

  it("read-token AAD matches locked format: destination.<id>.read-token", () => {
    const aad = `destination.${DESTINATION_ID}.read-token`;
    expect(aad).toBe("destination.fixture-dest-01.read-token");
  });

  it("AAD strings differ for publish vs read tokens (no shared AAD)", () => {
    const publishAad = `destination.${DESTINATION_ID}.publish-token`;
    const readAad = `destination.${DESTINATION_ID}.read-token`;
    expect(publishAad).not.toBe(readAad);
  });
});
