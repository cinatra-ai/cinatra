/**
 * ENABLER 0.12 — the data capability inside the island. The contract-level
 * acceptance test (cinatra#3027 / epic #3023).
 *
 * THE ENABLER'S OWN SENTENCE: "The data capability inside the island: a
 * separate, short-lived capability sealed to the actor, the run, the gate, the
 * artifact, the representation and the pinned configuration digest, which a
 * display's data road accepts with a live access re-check on every call; the
 * one-use island credential is never reused for data; a refused capability
 * yields the named no-data state."
 *
 * FIXING: "the island paints under a one-use credential consumed by the paint,
 * while a display's data route requires a session cookie — on a third-party host
 * the chrome paints and the data does not."
 */
import { beforeAll, describe, expect, it } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "x3027-placeholder-not-a-credential";

import {
  mintReviewIslandDataCapability,
  REVIEW_ISLAND_DATA_CAPABILITY_HEADER,
  REVIEW_ISLAND_DATA_CAPABILITY_TTL_SECONDS,
  verifyReviewIslandDataCapability,
  type ReviewIslandDataCapabilityPayload,
} from "@/lib/lifecycle/review-island-data-capability";
import {
  admitIslandDataCall,
  ISLAND_NO_DATA_STATE,
  type IslandDataServePorts,
} from "@/lib/lifecycle/review-island-data-serving";
import {
  mintReviewIslandCredential,
  type ReviewIslandCredentialPayload,
} from "@/lib/lifecycle/review-island-credential";
import { verifyReviewIslandByteCapability } from "@/lib/lifecycle/review-island-byte-capability";

const DIGEST = "0f".repeat(32);

const PAYLOAD: ReviewIslandDataCapabilityPayload = {
  orgId: "org-1",
  userId: "user-1",
  jti: "jti-1",
  siteId: "site-1",
  client: "wordpress",
  instanceId: "instance-1",
  agentSlug: "assistant",
  runId: "run-1",
  reviewTaskId: "wayflow-task-1",
  artifactId: "dashboard-1",
  representationRevisionId: "rev-1",
  configurationDigest: DIGEST,
};

const LIVE = {
  userId: PAYLOAD.userId,
  orgId: PAYLOAD.orgId,
  siteId: PAYLOAD.siteId,
  client: PAYLOAD.client,
  instanceId: PAYLOAD.instanceId,
  agentSlug: PAYLOAD.agentSlug,
  siteOrigin: "https://example.test",
};

function ports(overrides: Partial<IslandDataServePorts> = {}): IslandDataServePorts {
  return {
    readLivePrincipal: () => LIVE,
    runReadAccess: async () => true,
    readGatePinnedTargets: async () => [
      { artifactId: PAYLOAD.artifactId, representationRevisionId: PAYLOAD.representationRevisionId },
    ],
    readPinnedConfigurationDigest: () => DIGEST,
    ...overrides,
  };
}

let capability: string;
beforeAll(() => {
  const minted = mintReviewIslandDataCapability(PAYLOAD);
  if (!minted) throw new Error("the fixture capability did not mint");
  capability = minted;
});

describe("enabler 0.12 — a SEPARATE, short-lived capability", () => {
  it("seals the actor, the run, the gate, the artifact, the representation and the configuration digest", () => {
    expect(verifyReviewIslandDataCapability(capability)).toMatchObject(PAYLOAD);
  });

  it("is short-lived, and cannot be minted beyond its ceiling", () => {
    const now = 2_000_000;
    const short = mintReviewIslandDataCapability(PAYLOAD, { nowSeconds: now, ttlSeconds: 10 });
    expect(verifyReviewIslandDataCapability(short, { nowSeconds: now + 9 })).not.toBeNull();
    expect(verifyReviewIslandDataCapability(short, { nowSeconds: now + 10 })).toBeNull();
    expect(
      mintReviewIslandDataCapability(PAYLOAD, {
        ttlSeconds: REVIEW_ISLAND_DATA_CAPABILITY_TTL_SECONDS + 1,
      }),
    ).toBeNull();
  });

  it("THE ONE-USE ISLAND CREDENTIAL IS NEVER REUSED FOR DATA — the seals cannot open each other", () => {
    const credentialPayload: ReviewIslandCredentialPayload = {
      orgId: PAYLOAD.orgId,
      userId: PAYLOAD.userId,
      jti: PAYLOAD.jti,
      siteId: PAYLOAD.siteId,
      client: PAYLOAD.client,
      instanceId: PAYLOAD.instanceId,
      agentSlug: PAYLOAD.agentSlug,
      runId: PAYLOAD.runId,
      reviewTaskId: PAYLOAD.reviewTaskId,
    };
    const credential = mintReviewIslandCredential(credentialPayload);
    expect(credential).not.toBeNull();
    // An island credential presented on the data road does not decode …
    expect(verifyReviewIslandDataCapability(credential)).toBeNull();
    // … and a data capability is not a byte capability either.
    expect(verifyReviewIslandByteCapability(capability)).toBeNull();
  });

  it("travels on a HEADER, so it never has to enter a URL, a log or a referrer chain", () => {
    expect(REVIEW_ISLAND_DATA_CAPABILITY_HEADER).toBe("x-cinatra-island-data-capability");
  });
});

describe("enabler 0.12 — the live re-check, ON EVERY CALL", () => {
  it("admits when every rung passes", async () => {
    const admitted = await admitIslandDataCall({ encodedCapability: capability, ports: ports() });
    expect(admitted.ok).toBe(true);
  });

  it("re-runs run access on EVERY call, so a withdrawal between two calls stops the second", async () => {
    let allowed = true;
    let calls = 0;
    const p = ports({
      runReadAccess: async () => {
        calls += 1;
        return allowed;
      },
    });
    expect((await admitIslandDataCall({ encodedCapability: capability, ports: p })).ok).toBe(true);
    allowed = false;
    const second = await admitIslandDataCall({ encodedCapability: capability, ports: p });
    expect(second).toEqual({ ok: false, state: ISLAND_NO_DATA_STATE });
    expect(calls).toBe(2);
  });

  it("refuses a capability the gate did not pin", async () => {
    expect(
      (await admitIslandDataCall({
        encodedCapability: capability,
        ports: ports({ readGatePinnedTargets: async () => [{ artifactId: "other", representationRevisionId: "rev-1" }] }),
      })).ok,
    ).toBe(false);
  });

  it("refuses when the pinned configuration has moved under the sealed digest", async () => {
    // The chrome a display drew and the numbers it fetches must be on ONE
    // revision — a capability minted against an earlier configuration is refused
    // rather than served against a later one.
    expect(
      (await admitIslandDataCall({
        encodedCapability: capability,
        ports: ports({ readPinnedConfigurationDigest: () => "ff".repeat(32) }),
      })).ok,
    ).toBe(false);
    expect(
      (await admitIslandDataCall({
        encodedCapability: capability,
        ports: ports({ readPinnedConfigurationDigest: () => null }),
      })).ok,
    ).toBe(false);
  });

  it("refuses a dead or moved principal", async () => {
    expect(
      (await admitIslandDataCall({ encodedCapability: capability, ports: ports({ readLivePrincipal: () => null }) })).ok,
    ).toBe(false);
    expect(
      (await admitIslandDataCall({
        encodedCapability: capability,
        ports: ports({ readLivePrincipal: () => ({ ...LIVE, agentSlug: "another-agent" }) }),
      })).ok,
    ).toBe(false);
  });

  it("yields the ONE named no-data state for every refusal — a name, never a taxonomy", async () => {
    const refusals = await Promise.all([
      admitIslandDataCall({ encodedCapability: null, ports: ports() }),
      admitIslandDataCall({ encodedCapability: "forged", ports: ports() }),
      admitIslandDataCall({ encodedCapability: capability, ports: ports({ runReadAccess: async () => false }) }),
      admitIslandDataCall({ encodedCapability: capability, ports: ports({ readGatePinnedTargets: async () => null }) }),
      admitIslandDataCall({
        encodedCapability: capability,
        ports: ports({
          readPinnedConfigurationDigest: () => {
            throw new Error("store down");
          },
        }),
      }),
    ]);
    for (const refusal of refusals) {
      expect(refusal).toEqual({ ok: false, state: ISLAND_NO_DATA_STATE });
    }
  });
});
