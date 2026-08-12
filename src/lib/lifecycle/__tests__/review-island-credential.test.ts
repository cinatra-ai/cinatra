// cinatra#2674 scope addition (recorded 2026-08-12) — THE ISLAND CREDENTIAL.
//
// "A short-lived, ref-bound island credential derived from the widget principal
// (never the parent), so the island paints on true third-party sites exactly as
// it does same-site."
//
// The mint/verify half is here. The serving half — live principal, live site
// binding, live org standing, and the ref↔credential agreement — is in
// `review-island-serving.test.ts`.

import { beforeEach, describe, expect, it } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-island-credential";

import {
  REVIEW_ISLAND_CREDENTIAL_MAX_LENGTH,
  REVIEW_ISLAND_CREDENTIAL_QUERY_PARAM,
  REVIEW_ISLAND_CREDENTIAL_TTL_SECONDS,
  mintReviewIslandCredential,
  reviewIslandUrl,
  verifyReviewIslandCredential,
  type ReviewIslandCredentialPayload,
} from "../review-island-credential";

const PAYLOAD: ReviewIslandCredentialPayload = {
  orgId: "org-A",
  userId: "user-1",
  jti: "jti-1",
  siteId: "site-1",
  client: "wordpress",
  instanceId: "inst-1",
  agentSlug: "wordpress-content-editor",
  runId: "run-1",
  reviewTaskId: "task-1",
};

let now = 1_800_000_000;
beforeEach(() => {
  now = 1_800_000_000;
});

describe("mint + verify round trip", () => {
  it("opens to exactly what was sealed, plus its own expiry", () => {
    const encoded = mintReviewIslandCredential(PAYLOAD, { nowSeconds: now })!;
    expect(encoded).toBeTruthy();
    const verified = verifyReviewIslandCredential(encoded, { nowSeconds: now });
    expect(verified).toMatchObject(PAYLOAD);
    expect(verified!.expiresAt).toBe(now + REVIEW_ISLAND_CREDENTIAL_TTL_SECONDS);
  });

  it("is OPAQUE — nothing about the org, the run or the gate is readable from it", () => {
    const encoded = mintReviewIslandCredential(PAYLOAD, { nowSeconds: now })!;
    for (const value of Object.values(PAYLOAD)) {
      expect(encoded).not.toContain(value);
    }
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encoded.length).toBeLessThanOrEqual(REVIEW_ISLAND_CREDENTIAL_MAX_LENGTH);
  });

  it("two mints of the same payload differ (fresh IV) and both verify", () => {
    const a = mintReviewIslandCredential(PAYLOAD, { nowSeconds: now })!;
    const b = mintReviewIslandCredential(PAYLOAD, { nowSeconds: now })!;
    expect(a).not.toBe(b);
    expect(verifyReviewIslandCredential(a, { nowSeconds: now })).toBeTruthy();
    expect(verifyReviewIslandCredential(b, { nowSeconds: now })).toBeTruthy();
  });
});

describe("it is SHORT-LIVED, and the life cannot be stretched", () => {
  it("dies the instant its second arrives", () => {
    const encoded = mintReviewIslandCredential(PAYLOAD, { nowSeconds: now })!;
    const expiry = now + REVIEW_ISLAND_CREDENTIAL_TTL_SECONDS;
    expect(verifyReviewIslandCredential(encoded, { nowSeconds: expiry - 1 })).toBeTruthy();
    expect(verifyReviewIslandCredential(encoded, { nowSeconds: expiry })).toBeNull();
    expect(verifyReviewIslandCredential(encoded, { nowSeconds: expiry + 1 })).toBeNull();
  });

  it("a caller may SHORTEN the life but never lengthen it", () => {
    const short = mintReviewIslandCredential(PAYLOAD, { nowSeconds: now, ttlSeconds: 30 })!;
    expect(verifyReviewIslandCredential(short, { nowSeconds: now + 29 })).toBeTruthy();
    expect(verifyReviewIslandCredential(short, { nowSeconds: now + 30 })).toBeNull();
    expect(
      mintReviewIslandCredential(PAYLOAD, {
        nowSeconds: now,
        ttlSeconds: REVIEW_ISLAND_CREDENTIAL_TTL_SECONDS + 1,
      }),
    ).toBeNull();
  });

  it("REFUSES a credential whose sealed life exceeds the ceiling, however it was made", () => {
    // Minted far in the future: its remaining life is longer than this codec
    // would ever issue, so it is refused rather than honoured.
    const encoded = mintReviewIslandCredential(PAYLOAD, { nowSeconds: now + 10_000 })!;
    expect(verifyReviewIslandCredential(encoded, { nowSeconds: now })).toBeNull();
  });
});

describe("it is not one of ours unless it is exactly one of ours", () => {
  it("refuses tampered bytes, a foreign string, and the empty value", () => {
    const encoded = mintReviewIslandCredential(PAYLOAD, { nowSeconds: now })!;
    const flipped = encoded.slice(0, -2) + (encoded.endsWith("A") ? "B" : "A");
    expect(verifyReviewIslandCredential(flipped, { nowSeconds: now })).toBeNull();
    expect(verifyReviewIslandCredential("not-a-credential", { nowSeconds: now })).toBeNull();
    expect(verifyReviewIslandCredential("", { nowSeconds: now })).toBeNull();
    expect(
      verifyReviewIslandCredential("x".repeat(REVIEW_ISLAND_CREDENTIAL_MAX_LENGTH + 1), {
        nowSeconds: now,
      }),
    ).toBeNull();
    // NEGATIVE CONTROL — the untampered original still verifies.
    expect(verifyReviewIslandCredential(encoded, { nowSeconds: now })).toBeTruthy();
  });

  it("refuses one sealed under a rotated secret", () => {
    const encoded = mintReviewIslandCredential(PAYLOAD, { nowSeconds: now })!;
    const original = process.env.BETTER_AUTH_SECRET;
    process.env.BETTER_AUTH_SECRET = "a-different-secret";
    try {
      expect(verifyReviewIslandCredential(encoded, { nowSeconds: now })).toBeNull();
    } finally {
      process.env.BETTER_AUTH_SECRET = original;
    }
    expect(verifyReviewIslandCredential(encoded, { nowSeconds: now })).toBeTruthy();
  });

  it("KEY SEPARATION: a capture capability does not open as an island credential", async () => {
    const { mintCaptureCapability } = await import("../capture-capability");
    const capture = mintCaptureCapability(
      {
        ...PAYLOAD,
        captureArtifactId: "cap-1",
        representationRevisionId: "rev-1",
      },
      { nowSeconds: now },
    )!;
    expect(capture).toBeTruthy();
    expect(verifyReviewIslandCredential(capture, { nowSeconds: now })).toBeNull();
  });

  it("mints NOTHING when a field is missing, blank or over-long", () => {
    for (const field of Object.keys(PAYLOAD) as Array<keyof ReviewIslandCredentialPayload>) {
      expect(
        mintReviewIslandCredential({ ...PAYLOAD, [field]: "" }, { nowSeconds: now }),
      ).toBeNull();
      expect(
        mintReviewIslandCredential(
          { ...PAYLOAD, [field]: "x".repeat(129) },
          { nowSeconds: now },
        ),
      ).toBeNull();
    }
  });

  it("mints NOTHING with no signing key — a surface that cannot express one renders none", () => {
    const original = process.env.BETTER_AUTH_SECRET;
    delete process.env.BETTER_AUTH_SECRET;
    try {
      expect(mintReviewIslandCredential(PAYLOAD, { nowSeconds: now })).toBeNull();
    } finally {
      process.env.BETTER_AUTH_SECRET = original;
    }
  });
});

describe("the island URL", () => {
  it("carries the ref and the credential, both encoded", () => {
    const url = reviewIslandUrl({ ref: "a ref/with=chars", credential: "cred-value" });
    expect(url).toBe(
      `/lifecycle/review-island?ref=a%20ref%2Fwith%3Dchars&${REVIEW_ISLAND_CREDENTIAL_QUERY_PARAM}=cred-value`,
    );
  });
});
