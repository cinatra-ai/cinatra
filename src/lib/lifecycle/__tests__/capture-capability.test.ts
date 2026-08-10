import { beforeEach, afterEach, describe, expect, it } from "vitest";

import {
  CAPTURE_CAPABILITY_MAX_LENGTH,
  CAPTURE_CAPABILITY_QUERY_PARAM,
  CAPTURE_CAPABILITY_ROUTE,
  CAPTURE_CAPABILITY_TTL_SECONDS,
  captureCapabilityUrl,
  mintCaptureCapability,
  verifyCaptureCapability,
  type CaptureCapabilityPayload,
} from "@/lib/lifecycle/capture-capability";
import {
  decodeLifecycleGateRef,
  encodeLifecycleGateRef,
} from "@/lib/lifecycle/lifecycle-card-ref";

// ---------------------------------------------------------------------------
// The capture capability is the ONE bearer in this epic that lives in a URL,
// because an `<img>` load can carry nothing else. These tests hold the line on
// what that costs and what it must never cost: it is opaque, tamper-evident,
// short-lived, key-separated from the (non-capability) card ref, and it can
// never be widened by its own caller.
// ---------------------------------------------------------------------------

const PAYLOAD: CaptureCapabilityPayload = {
  orgId: "org-1",
  userId: "user-1",
  jti: "jti-1",
  siteId: "site-1",
  client: "wordpress",
  instanceId: "inst-1",
  agentSlug: "wordpress-assistant",
  runId: "run-1",
  reviewTaskId: "gate-1",
  captureArtifactId: "cap-1",
  representationRevisionId: "png-1",
};

describe("capture capability codec", () => {
  const originalSecret = process.env.BETTER_AUTH_SECRET;

  beforeEach(() => {
    process.env.BETTER_AUTH_SECRET = "test-secret-for-capture-capability";
  });
  afterEach(() => {
    if (originalSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = originalSecret;
  });

  it("round-trips every sealed binding", () => {
    const sealed = mintCaptureCapability(PAYLOAD, { nowSeconds: 1_000 });
    expect(sealed).not.toBeNull();
    const opened = verifyCaptureCapability(sealed!, { nowSeconds: 1_000 });
    expect(opened).toMatchObject(PAYLOAD);
    expect(opened!.expiresAt).toBe(1_000 + CAPTURE_CAPABILITY_TTL_SECONDS);
  });

  it("is OPAQUE — no sealed identifier is readable from the encoded value", () => {
    const sealed = mintCaptureCapability(PAYLOAD, { nowSeconds: 1_000 })!;
    // A capability lands in CMS access logs, referrer chains and support
    // tickets. Nothing about the tenant, the person, the run or the gate may be
    // legible there.
    for (const secretish of Object.values(PAYLOAD)) {
      expect(sealed).not.toContain(secretish);
    }
    // Not accidentally base64 JSON either.
    expect(() => JSON.parse(Buffer.from(sealed, "base64url").toString("utf8"))).toThrow();
  });

  it("is non-deterministic — two mints of the same picture differ", () => {
    const a = mintCaptureCapability(PAYLOAD, { nowSeconds: 1_000 })!;
    const b = mintCaptureCapability(PAYLOAD, { nowSeconds: 1_000 })!;
    expect(a).not.toBe(b);
    expect(verifyCaptureCapability(a, { nowSeconds: 1_000 })).toMatchObject(PAYLOAD);
    expect(verifyCaptureCapability(b, { nowSeconds: 1_000 })).toMatchObject(PAYLOAD);
  });

  it("EXPIRES: alive one second before, dead on the second itself and after", () => {
    const sealed = mintCaptureCapability(PAYLOAD, { nowSeconds: 1_000 })!;
    const exp = 1_000 + CAPTURE_CAPABILITY_TTL_SECONDS;
    expect(verifyCaptureCapability(sealed, { nowSeconds: exp - 1 })).not.toBeNull();
    expect(verifyCaptureCapability(sealed, { nowSeconds: exp })).toBeNull();
    expect(verifyCaptureCapability(sealed, { nowSeconds: exp + 3600 })).toBeNull();
  });

  it("TTL is bounded WELL below the cwu_ token's own 15-minute life", () => {
    // The picture URL must never outlive the session that authorized it.
    expect(CAPTURE_CAPABILITY_TTL_SECONDS).toBeLessThan(15 * 60);
  });

  it("a caller may SHORTEN the life but never lengthen it", () => {
    const shorter = mintCaptureCapability(PAYLOAD, { nowSeconds: 1_000, ttlSeconds: 30 });
    expect(verifyCaptureCapability(shorter!, { nowSeconds: 1_031 })).toBeNull();
    expect(
      mintCaptureCapability(PAYLOAD, {
        nowSeconds: 1_000,
        ttlSeconds: CAPTURE_CAPABILITY_TTL_SECONDS + 1,
      }),
    ).toBeNull();
    expect(mintCaptureCapability(PAYLOAD, { nowSeconds: 1_000, ttlSeconds: 0 })).toBeNull();
  });

  it("TAMPERING is detected — a flipped byte is not one of ours", () => {
    const sealed = mintCaptureCapability(PAYLOAD, { nowSeconds: 1_000 })!;
    const raw = Buffer.from(sealed, "base64url");
    raw[raw.length - 20] ^= 0xff; // inside the ciphertext body
    const tampered = raw.toString("base64url");
    expect(verifyCaptureCapability(tampered, { nowSeconds: 1_000 })).toBeNull();
  });

  it("garbage, wrong alphabet, empty and oversized values all answer null", () => {
    for (const bad of [
      "",
      "not a capability",
      "!!!!",
      "a".repeat(CAPTURE_CAPABILITY_MAX_LENGTH + 1),
      Buffer.from("short").toString("base64url"),
    ]) {
      expect(verifyCaptureCapability(bad, { nowSeconds: 1_000 })).toBeNull();
    }
  });

  it("KEY SEPARATION: a lifecycle card ref never opens as a capability, and vice versa", () => {
    const ref = encodeLifecycleGateRef({ runId: "run-1", reviewTaskId: "gate-1" })!;
    expect(verifyCaptureCapability(ref, { nowSeconds: 1_000 })).toBeNull();
    const sealed = mintCaptureCapability(PAYLOAD, { nowSeconds: 1_000 })!;
    expect(decodeLifecycleGateRef(sealed)).toBeNull();
  });

  it("a ROTATED app secret retires outstanding capabilities", () => {
    const sealed = mintCaptureCapability(PAYLOAD, { nowSeconds: 1_000 })!;
    process.env.BETTER_AUTH_SECRET = "a-different-secret";
    expect(verifyCaptureCapability(sealed, { nowSeconds: 1_000 })).toBeNull();
  });

  it("FAILS CLOSED with no app secret — mints nothing and opens nothing", () => {
    const sealed = mintCaptureCapability(PAYLOAD, { nowSeconds: 1_000 })!;
    delete process.env.BETTER_AUTH_SECRET;
    expect(mintCaptureCapability(PAYLOAD, { nowSeconds: 1_000 })).toBeNull();
    expect(verifyCaptureCapability(sealed, { nowSeconds: 1_000 })).toBeNull();
  });

  it("refuses an out-of-bounds or empty field rather than sealing it", () => {
    for (const key of Object.keys(PAYLOAD) as Array<keyof CaptureCapabilityPayload>) {
      expect(mintCaptureCapability({ ...PAYLOAD, [key]: "" })).toBeNull();
      expect(mintCaptureCapability({ ...PAYLOAD, [key]: "x".repeat(129) })).toBeNull();
    }
  });

  it("the URL is same-origin, host-relative and carries the capability in one query param", () => {
    const sealed = mintCaptureCapability(PAYLOAD, { nowSeconds: 1_000 })!;
    const url = captureCapabilityUrl(sealed);
    expect(url.startsWith(`${CAPTURE_CAPABILITY_ROUTE}?`)).toBe(true);
    const parsed = new URL(url, "https://app.example.com");
    expect(parsed.pathname).toBe(CAPTURE_CAPABILITY_ROUTE);
    expect(parsed.searchParams.get(CAPTURE_CAPABILITY_QUERY_PARAM)).toBe(sealed);
    // No identifier is readable from the URL's own structure — the path is
    // constant and the only parameter is sealed.
    expect([...parsed.searchParams.keys()]).toEqual([CAPTURE_CAPABILITY_QUERY_PARAM]);
  });
});
