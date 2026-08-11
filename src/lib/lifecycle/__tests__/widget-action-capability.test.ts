import { beforeEach, afterEach, describe, expect, it } from "vitest";

import {
  ACTION_CAPABILITY_DECIDE_ROUTE_PATH,
  ACTION_CAPABILITY_HEADER,
  ACTION_CAPABILITY_MAX_LENGTH,
  ACTION_CAPABILITY_PURPOSE_DECIDE,
  ACTION_CAPABILITY_TTL_SECONDS,
  actionCapabilityBindingDigest,
  decisionPayloadDigest,
  mintActionCapability,
  pinnedTargetsDigest,
  reviewReferenceCode,
  verifyActionCapability,
  type ActionCapabilityPayload,
} from "@/lib/lifecycle/widget-action-capability";
import { mintCaptureCapability } from "@/lib/lifecycle/capture-capability";
import { encodeLifecycleGateRef } from "@/lib/lifecycle/lifecycle-card-ref";

// ---------------------------------------------------------------------------
// cinatra#2575 (epic #2564 S8b) — the ACTION CAPABILITY codec.
//
// This is the credential a website's own software must never be able to hold or
// forge. The suite is therefore written as the misuse matrix the issue asks for
// (expired, replayed, wrong-gate, wrong-site, wrong-audience, wrong-principal)
// plus the two properties that make the matrix meaningful at all: the seal is
// authenticated ENCRYPTION, so a capability discloses nothing and cannot be
// edited; and it is key-separated from its siblings, so no other sealed value in
// this epic can be presented as one.
//
// The single-use half is NOT here — it is a database CAS, and it is proven
// against a real Postgres in the store's integration suite. A codec cannot make
// a bearer un-replayable and this one does not pretend to.
// ---------------------------------------------------------------------------

const PAYLOAD: ActionCapabilityPayload = {
  capabilityId: "cap-1",
  purpose: ACTION_CAPABILITY_PURPOSE_DECIDE,
  audience: ACTION_CAPABILITY_DECIDE_ROUTE_PATH,
  orgId: "org-1",
  userId: "user-1",
  jti: "wjti-1",
  siteId: "site-1",
  client: "wordpress",
  instanceId: "inst-1",
  agentSlug: "wordpress-content-editor",
  runId: "run-1",
  reviewTaskId: "gate-1",
  disposition: "approve",
  targetsDigest: pinnedTargetsDigest([
    { artifactId: "art-1", representationRevisionId: "rev-1" },
  ]),
  decisionDigest: decisionPayloadDigest({ disposition: "approve", comment: null }),
};

const EXPECTED = {
  audience: ACTION_CAPABILITY_DECIDE_ROUTE_PATH,
  purpose: ACTION_CAPABILITY_PURPOSE_DECIDE,
};

describe("action capability codec", () => {
  const originalSecret = process.env.BETTER_AUTH_SECRET;

  beforeEach(() => {
    process.env.BETTER_AUTH_SECRET = "test-secret-for-action-capability";
  });
  afterEach(() => {
    if (originalSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = originalSecret;
  });

  it("round-trips every sealed axis", () => {
    const sealed = mintActionCapability(PAYLOAD);
    expect(sealed).toBeTruthy();
    const opened = verifyActionCapability(sealed as string, EXPECTED);
    expect(opened).toMatchObject(PAYLOAD);
    expect(opened?.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("is OPAQUE — nothing about the tenant, the person or the gate is legible", () => {
    const sealed = mintActionCapability(PAYLOAD) as string;
    for (const secretish of [
      PAYLOAD.orgId,
      PAYLOAD.userId,
      PAYLOAD.jti,
      PAYLOAD.siteId,
      PAYLOAD.runId,
      PAYLOAD.reviewTaskId,
      PAYLOAD.disposition,
    ]) {
      expect(sealed).not.toContain(secretish);
      expect(Buffer.from(sealed, "base64url").toString("latin1")).not.toContain(secretish);
    }
  });

  it("fits a header and is URL-safe base64 (it is never put in a URL, but it must not need escaping)", () => {
    const sealed = mintActionCapability(PAYLOAD) as string;
    expect(sealed.length).toBeLessThanOrEqual(ACTION_CAPABILITY_MAX_LENGTH);
    expect(sealed).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(ACTION_CAPABILITY_HEADER).toBe("X-Cinatra-Action-Capability");
  });

  // --- THE MISUSE MATRIX --------------------------------------------------

  it("EXPIRED — refused at the exact second, not merely after it", () => {
    const now = 1_800_000_000;
    const sealed = mintActionCapability(PAYLOAD, { nowSeconds: now }) as string;
    const exp = now + ACTION_CAPABILITY_TTL_SECONDS;
    expect(verifyActionCapability(sealed, EXPECTED, { nowSeconds: exp - 1 })).not.toBeNull();
    expect(verifyActionCapability(sealed, EXPECTED, { nowSeconds: exp })).toBeNull();
    expect(verifyActionCapability(sealed, EXPECTED, { nowSeconds: exp + 1 })).toBeNull();
  });

  it("TAMPERED — a single flipped byte is refused (AEAD, not a signature over cleartext)", () => {
    const sealed = mintActionCapability(PAYLOAD) as string;
    const bytes = Buffer.from(sealed, "base64url");
    bytes[bytes.length - 20] ^= 0x01;
    expect(verifyActionCapability(bytes.toString("base64url"), EXPECTED)).toBeNull();
  });

  it("WRONG AUDIENCE — a capability is a bearer for ONE door", () => {
    const sealed = mintActionCapability(PAYLOAD) as string;
    expect(
      verifyActionCapability(sealed, {
        ...EXPECTED,
        audience: "/api/lifecycle-views/decide",
      }),
    ).toBeNull();
  });

  it("WRONG PURPOSE — it cannot be spent on a different kind of act", () => {
    const sealed = mintActionCapability(PAYLOAD) as string;
    expect(verifyActionCapability(sealed, { ...EXPECTED, purpose: "lifecycle.read" })).toBeNull();
  });

  it("WRONG KEY — a rotated app secret retires every outstanding capability", () => {
    const sealed = mintActionCapability(PAYLOAD) as string;
    process.env.BETTER_AUTH_SECRET = "a-different-secret";
    expect(verifyActionCapability(sealed, EXPECTED)).toBeNull();
  });

  it("NO KEY — mint and verify both refuse rather than falling back", () => {
    delete process.env.BETTER_AUTH_SECRET;
    expect(mintActionCapability(PAYLOAD)).toBeNull();
    expect(verifyActionCapability("AAAA".repeat(20), EXPECTED)).toBeNull();
  });

  it("KEY SEPARATION — no other sealed value in this epic opens as one", () => {
    const capture = mintCaptureCapability({
      orgId: "org-1",
      userId: "user-1",
      jti: "wjti-1",
      siteId: "site-1",
      client: "wordpress",
      instanceId: "inst-1",
      agentSlug: "wordpress-content-editor",
      runId: "run-1",
      reviewTaskId: "gate-1",
      captureArtifactId: "cap-1",
      representationRevisionId: "rev-1",
    }) as string;
    expect(verifyActionCapability(capture, EXPECTED)).toBeNull();

    const ref = encodeLifecycleGateRef({ runId: "run-1", reviewTaskId: "gate-1" }) as string;
    expect(verifyActionCapability(ref, EXPECTED)).toBeNull();
  });

  it("REFUSES a mint whose purpose or audience this build does not itself mint", () => {
    expect(mintActionCapability({ ...PAYLOAD, purpose: "lifecycle.read" })).toBeNull();
    expect(
      mintActionCapability({ ...PAYLOAD, audience: "/api/lifecycle-views/decide" }),
    ).toBeNull();
  });

  it("REFUSES an out-of-bounds or blank field on BOTH sides", () => {
    expect(mintActionCapability({ ...PAYLOAD, runId: "" })).toBeNull();
    expect(mintActionCapability({ ...PAYLOAD, jti: "x".repeat(129) })).toBeNull();
    expect(
      mintActionCapability({
        ...PAYLOAD,
        // @ts-expect-error — a disposition outside the review floor
        disposition: "escalate",
      }),
    ).toBeNull();
  });

  it("a caller may SHORTEN a capability's life and may never lengthen it", () => {
    const now = 1_800_000_000;
    const short = mintActionCapability(PAYLOAD, { nowSeconds: now, ttlSeconds: 5 }) as string;
    expect(verifyActionCapability(short, EXPECTED, { nowSeconds: now + 4 })).not.toBeNull();
    expect(verifyActionCapability(short, EXPECTED, { nowSeconds: now + 5 })).toBeNull();
    expect(
      mintActionCapability(PAYLOAD, {
        nowSeconds: now,
        ttlSeconds: ACTION_CAPABILITY_TTL_SECONDS + 1,
      }),
    ).toBeNull();
    expect(mintActionCapability(PAYLOAD, { nowSeconds: now, ttlSeconds: 0 })).toBeNull();
  });

  it("refuses a capability whose sealed life exceeds this codec's ceiling", () => {
    // Not reachable through this mint; reachable through a mint at a build with
    // a longer ceiling, which this build must not honour.
    const now = 1_800_000_000;
    const sealed = mintActionCapability(PAYLOAD, { nowSeconds: now }) as string;
    // Verifying far in the PAST makes the remaining life exceed the ceiling.
    expect(
      verifyActionCapability(sealed, EXPECTED, { nowSeconds: now - ACTION_CAPABILITY_TTL_SECONDS }),
    ).toBeNull();
  });

  it("refuses junk: empty, oversized, and non-base64url values", () => {
    expect(verifyActionCapability("", EXPECTED)).toBeNull();
    expect(verifyActionCapability("a".repeat(ACTION_CAPABILITY_MAX_LENGTH + 1), EXPECTED)).toBeNull();
    expect(verifyActionCapability("not base64!", EXPECTED)).toBeNull();
    // @ts-expect-error — a non-string presented value
    expect(verifyActionCapability(null, EXPECTED)).toBeNull();
  });
});

describe("the pinned-targets digest", () => {
  const A = { artifactId: "art-a", representationRevisionId: "rev-a" };
  const B = { artifactId: "art-b", representationRevisionId: "rev-b" };

  it("is ORDER-INDEPENDENT — the pinned set is a set", () => {
    expect(pinnedTargetsDigest([A, B])).toBe(pinnedTargetsDigest([B, A]));
  });

  it("changes when a REVISION changes — this is the representation binding", () => {
    expect(pinnedTargetsDigest([A])).not.toBe(
      pinnedTargetsDigest([{ ...A, representationRevisionId: "rev-a2" }]),
    );
  });

  it("changes when a target joins or leaves the gate", () => {
    expect(pinnedTargetsDigest([A])).not.toBe(pinnedTargetsDigest([A, B]));
    expect(pinnedTargetsDigest([])).not.toBe(pinnedTargetsDigest([A]));
  });

  it("cannot be collided by moving characters across the field boundary", () => {
    expect(
      pinnedTargetsDigest([{ artifactId: "ab", representationRevisionId: "c" }]),
    ).not.toBe(pinnedTargetsDigest([{ artifactId: "a", representationRevisionId: "bc" }]));
  });
});

describe("the decision-payload digest", () => {
  const base = { disposition: "approve" as const, comment: null };

  it("treats an absent and an empty rationale as the same decision", () => {
    expect(decisionPayloadDigest(base)).toBe(decisionPayloadDigest({ ...base, comment: "" }));
  });

  it("distinguishes the act, and every change of rationale", () => {
    expect(decisionPayloadDigest(base)).not.toBe(
      decisionPayloadDigest({ ...base, disposition: "reject" }),
    );
    expect(decisionPayloadDigest({ ...base, comment: "ok" })).not.toBe(
      decisionPayloadDigest({ ...base, comment: "ok " }),
    );
  });

  it("cannot be collided by moving text across the field boundary", () => {
    // The separator is NUL, which no disposition or rationale this product
    // produces can contain, so "approve" + "" and "" + "approve" are distinct.
    expect(decisionPayloadDigest({ disposition: "approve", comment: "" })).not.toBe(
      decisionPayloadDigest({ disposition: "comment", comment: "approve" }),
    );
  });

  it("covers ONLY what the confirmation window can show (codex round 0, finding 1)", () => {
    // The digest is the contract between the sentence a person read and the
    // request that lands. Its shape is therefore a claim about the SCREEN: this
    // build's window renders the act, the subject and the rationale, so those
    // are what it binds. A per-item suggestion partition is deliberately absent
    // — both widget endpoints refuse one at their schema — because binding
    // something unrenderable would authorize invisible choices.
    const keys = Object.keys(
      { disposition: "approve", comment: null } satisfies Parameters<
        typeof decisionPayloadDigest
      >[0],
    ).sort();
    expect(keys).toEqual(["comment", "disposition"]);
  });
});

describe("the review reference code", () => {
  it("is stable for a gate and different for every other gate", () => {
    expect(reviewReferenceCode("run-1", "gate-1")).toBe(reviewReferenceCode("run-1", "gate-1"));
    expect(reviewReferenceCode("run-1", "gate-1")).not.toBe(
      reviewReferenceCode("run-1", "gate-2"),
    );
    expect(reviewReferenceCode("run-1", "gate-1")).not.toBe(
      reviewReferenceCode("run-2", "gate-1"),
    );
  });

  it("cannot be collided by moving characters across the field boundary", () => {
    expect(reviewReferenceCode("ab", "c")).not.toBe(reviewReferenceCode("a", "bc"));
  });

  it("is written in an alphabet a person can read back correctly", () => {
    // A code exists to be COMPARED by eye. Characters nobody can tell apart
    // would make two different gates read as one, which is the whole failure it
    // is there to prevent.
    const code = reviewReferenceCode("run-x", "gate-x");
    expect(code).toMatch(/^[2-9A-HJ-NP-TV-Z]{4}-[2-9A-HJ-NP-TV-Z]{4}$/);
    for (const confusable of ["0", "O", "1", "I", "L", "U"]) {
      expect(code).not.toContain(confusable);
    }
  });

  it("spreads across the alphabet — it is a hash, not a prefix", () => {
    const codes = new Set(
      Array.from({ length: 200 }, (_, i) => reviewReferenceCode("run-1", `gate-${i}`)),
    );
    expect(codes.size).toBe(200);
  });
});

describe("the binding digest", () => {
  it("changes on EVERY binding axis", () => {
    const base = actionCapabilityBindingDigest(PAYLOAD);
    const axes: Array<Partial<ActionCapabilityPayload>> = [
      { orgId: "org-2" },
      { userId: "user-2" },
      { jti: "wjti-2" },
      { siteId: "site-2" },
      { client: "drupal" },
      { instanceId: "inst-2" },
      { agentSlug: "drupal-content-editor" },
      { runId: "run-2" },
      { reviewTaskId: "gate-2" },
      { disposition: "reject" },
      { targetsDigest: "deadbeef" },
      { decisionDigest: "deadbeef" },
    ];
    for (const axis of axes) {
      expect(actionCapabilityBindingDigest({ ...PAYLOAD, ...axis }), JSON.stringify(axis)).not.toBe(
        base,
      );
    }
  });

  it("does NOT depend on the capability id — the row is keyed by it, not bound by it", () => {
    expect(actionCapabilityBindingDigest({ ...PAYLOAD, capabilityId: "cap-2" })).toBe(
      actionCapabilityBindingDigest(PAYLOAD),
    );
  });
});
