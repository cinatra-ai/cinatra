/**
 * ENABLER 0.6 — the island-scoped byte capability and its serving route. The
 * contract-level acceptance test (cinatra#3027 / epic #3023).
 *
 * THE ENABLER'S OWN SENTENCE: "The island-scoped byte capability and its serving
 * route, sealed to the exact gate, artifact and revision the gate pinned" —
 * fixing that "both artifact byte routes are cookie-only, so inside a
 * third-party application every media display paints nothing and the fallback's
 * links are dead ends."
 *
 * The route itself is a thin shell over `decideIslandByteServe`; the whole
 * admission matrix is therefore proved here, without a database or a browser.
 */
import { beforeAll, describe, expect, it } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "x3027-placeholder-not-a-credential";

import {
  mintReviewIslandByteCapability,
  reviewIslandByteUrl,
  REVIEW_ISLAND_BYTE_CAPABILITY_TTL_SECONDS,
  verifyReviewIslandByteCapability,
  type ReviewIslandByteCapabilityPayload,
} from "@/lib/lifecycle/review-island-byte-capability";
import {
  decideIslandByteServe,
  isSameOriginDisplaySubresourceFetch,
  ISLAND_BYTE_SERVE_MAX_BYTES,
  type IslandByteServePorts,
} from "@/lib/lifecycle/review-island-byte-serving";
import { verifyReviewIslandCredential } from "@/lib/lifecycle/review-island-credential";
import { verifyReviewIslandDataCapability } from "@/lib/lifecycle/review-island-data-capability";

const PAYLOAD: ReviewIslandByteCapabilityPayload = {
  orgId: "org-1",
  userId: "user-1",
  jti: "jti-1",
  siteId: "site-1",
  client: "wordpress",
  instanceId: "instance-1",
  agentSlug: "assistant",
  runId: "run-1",
  reviewTaskId: "wayflow-task-1",
  artifactId: "artifact-1",
  representationRevisionId: "rev-1",
  disposition: "preview",
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

function subresourceHeaders(dest = "image"): Headers {
  return new Headers({ "sec-fetch-dest": dest, "sec-fetch-site": "same-origin" });
}

function ports(overrides: Partial<IslandByteServePorts> = {}): IslandByteServePorts {
  return {
    readLivePrincipal: () => LIVE,
    runReadAccess: async () => true,
    readGatePinnedTargets: async () => [
      { artifactId: PAYLOAD.artifactId, representationRevisionId: PAYLOAD.representationRevisionId },
    ],
    resolveServe: () => ({ mime: "image/png", storageKey: "k", sizeBytes: 1_000 }),
    ...overrides,
  };
}

let capability: string;
beforeAll(() => {
  const minted = mintReviewIslandByteCapability(PAYLOAD);
  if (!minted) throw new Error("the fixture capability did not mint");
  capability = minted;
});

describe("enabler 0.6 — what the capability seals", () => {
  it("round-trips every sealed field, and its own expiry", () => {
    const opened = verifyReviewIslandByteCapability(capability);
    expect(opened).toMatchObject(PAYLOAD);
    expect(opened?.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("refuses a tampered, truncated or foreign string", () => {
    expect(verifyReviewIslandByteCapability(`${capability}a`)).toBeNull();
    expect(verifyReviewIslandByteCapability(capability.slice(0, -4))).toBeNull();
    expect(verifyReviewIslandByteCapability("not a capability!")).toBeNull();
    expect(verifyReviewIslandByteCapability("")).toBeNull();
    expect(verifyReviewIslandByteCapability(null)).toBeNull();
  });

  it("is dead the instant its second arrives, and cannot be minted longer than the ceiling", () => {
    const now = 1_000_000;
    const short = mintReviewIslandByteCapability(PAYLOAD, { nowSeconds: now, ttlSeconds: 30 });
    expect(verifyReviewIslandByteCapability(short, { nowSeconds: now + 29 })).not.toBeNull();
    expect(verifyReviewIslandByteCapability(short, { nowSeconds: now + 30 })).toBeNull();
    expect(
      mintReviewIslandByteCapability(PAYLOAD, {
        ttlSeconds: REVIEW_ISLAND_BYTE_CAPABILITY_TTL_SECONDS + 1,
      }),
    ).toBeNull();
  });

  it("KEY SEPARATION — no sibling bearer can open it, and it can open no sibling", () => {
    // The island credential and the data capability hang off the same app secret
    // under DIFFERENT labels. That must be structural, not remembered.
    expect(verifyReviewIslandCredential(capability)).toBeNull();
    expect(verifyReviewIslandDataCapability(capability)).toBeNull();
  });

  it("seals the DISPOSITION, so a preview address cannot be edited into a download", () => {
    const download = mintReviewIslandByteCapability({ ...PAYLOAD, disposition: "download" });
    expect(verifyReviewIslandByteCapability(download)?.disposition).toBe("download");
    // The URL carries the capability and NOTHING else — there is no other
    // identifier in the address to edit.
    const url = reviewIslandByteUrl(capability);
    expect(url).toContain("bc=");
    expect(url).not.toContain(PAYLOAD.artifactId);
    expect(url).not.toContain(PAYLOAD.runId);
  });
});

describe("enabler 0.6 — the transport-shape rung", () => {
  it("admits the destinations a display paints with, and refuses a navigation", () => {
    for (const dest of ["image", "video", "audio", "object", "embed", "empty"]) {
      expect(isSameOriginDisplaySubresourceFetch(subresourceHeaders(dest))).toBe(true);
    }
    // The pasted-link case.
    expect(isSameOriginDisplaySubresourceFetch(subresourceHeaders("document"))).toBe(false);
    expect(isSameOriginDisplaySubresourceFetch(subresourceHeaders("iframe"))).toBe(false);
    // A foreign page mounting the address.
    expect(
      isSameOriginDisplaySubresourceFetch(
        new Headers({ "sec-fetch-dest": "image", "sec-fetch-site": "cross-site" }),
      ),
    ).toBe(false);
    // Absence fails CLOSED.
    expect(isSameOriginDisplaySubresourceFetch(new Headers())).toBe(false);
    // A contradiction is refused rather than resolved in either direction.
    expect(
      isSameOriginDisplaySubresourceFetch(
        new Headers({
          "sec-fetch-dest": "image",
          "sec-fetch-site": "same-origin",
          "sec-fetch-mode": "navigate",
        }),
      ),
    ).toBe(false);
  });
});

describe("enabler 0.6 — sealed to the EXACT gate, artifact and revision", () => {
  const decide = (overrides: Partial<IslandByteServePorts> = {}, cap = capability) =>
    decideIslandByteServe({
      encodedCapability: cap,
      headers: subresourceHeaders(),
      ports: ports(overrides),
    });

  it("serves the pinned bytes when every rung passes", async () => {
    const decision = await decide();
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.serve.storageKey).toBe("k");
    expect(decision.disposition).toBe("preview");
  });

  it("refuses when the gate never pinned this (artifact, revision) pair", async () => {
    // Another gate's target.
    expect(
      (await decide({ readGatePinnedTargets: async () => [{ artifactId: "other", representationRevisionId: "rev-1" }] })).ok,
    ).toBe(false);
    // The RIGHT artifact at a LATER revision — the walk this rung forbids.
    expect(
      (await decide({ readGatePinnedTargets: async () => [{ artifactId: PAYLOAD.artifactId, representationRevisionId: "rev-2" }] })).ok,
    ).toBe(false);
    // A gate that is gone.
    expect((await decide({ readGatePinnedTargets: async () => null })).ok).toBe(false);
    expect((await decide({ readGatePinnedTargets: async () => [] })).ok).toBe(false);
  });

  it("refuses when the live principal is dead or its binding moved underneath", async () => {
    expect((await decide({ readLivePrincipal: () => null })).ok).toBe(false);
    for (const moved of [
      { ...LIVE, userId: "someone-else" },
      { ...LIVE, orgId: "another-org" },
      { ...LIVE, siteId: "another-site" },
      { ...LIVE, client: "drupal" },
      { ...LIVE, instanceId: "another-instance" },
      { ...LIVE, agentSlug: "another-agent" },
    ]) {
      expect((await decide({ readLivePrincipal: () => moved })).ok).toBe(false);
    }
  });

  it("refuses when run read access was withdrawn between the mint and the fetch", async () => {
    expect((await decide({ runReadAccess: async () => false })).ok).toBe(false);
  });

  it("refuses bytes that cannot be resolved, or that exceed the serve cap", async () => {
    expect((await decide({ resolveServe: () => null })).ok).toBe(false);
    expect(
      (await decide({
        resolveServe: () => ({ mime: "image/png", storageKey: "k", sizeBytes: ISLAND_BYTE_SERVE_MAX_BYTES + 1 }),
      })).ok,
    ).toBe(false);
    expect((await decide({ resolveServe: () => ({ mime: "", storageKey: "k", sizeBytes: 1 }) })).ok).toBe(false);
  });

  it("never reaches a store on behalf of a caller that failed an earlier rung", async () => {
    const touched: string[] = [];
    const spy = ports({
      readLivePrincipal: () => {
        touched.push("principal");
        return LIVE;
      },
      readGatePinnedTargets: async () => {
        touched.push("gate");
        return [];
      },
      resolveServe: () => {
        touched.push("bytes");
        return { mime: "image/png", storageKey: "k", sizeBytes: 1 };
      },
    });
    // A navigation never reaches ANY port.
    await decideIslandByteServe({
      encodedCapability: capability,
      headers: subresourceHeaders("document"),
      ports: spy,
    });
    expect(touched).toEqual([]);
    // A capability that fails the gate rung never reaches the byte resolver.
    await decideIslandByteServe({
      encodedCapability: capability,
      headers: subresourceHeaders(),
      ports: spy,
    });
    expect(touched).toEqual(["principal", "gate"]);
  });

  it("turns a throwing port into the same refusal, never a distinguishable error", async () => {
    const decision = await decideIslandByteServe({
      encodedCapability: capability,
      headers: subresourceHeaders(),
      ports: ports({
        runReadAccess: async () => {
          throw new Error("store down");
        },
      }),
    });
    expect(decision).toEqual({ ok: false });
  });
});

describe("enabler 0.6 — a DOWNLOAD capability is fetched, never navigated to", () => {
  it("admits the download disposition at a display's own fetch, and refuses it as a link click", () => {
    // THE CONTRACT IS EASY TO READ THE OTHER WAY ROUND, so it is written down
    // here as a case rather than only as prose: a plain `<a href download>`
    // click IS a navigation — `Sec-Fetch-Dest: document`,
    // `Sec-Fetch-Mode: navigate` — so it would have received the common 404 and
    // the advertised affordance would have been dead on arrival.
    //
    // The rung does not widen: admitting `document` for one disposition reopens
    // the top-level rendering of artifact bytes it exists to close. A display
    // FETCHES the bytes (`Sec-Fetch-Dest: empty`) and hands the reader the save.
    // This case pins that rule so the wiring in the sibling plan cannot get it
    // wrong silently.
    const fetched = new Headers({
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
    });
    expect(isSameOriginDisplaySubresourceFetch(fetched)).toBe(true);

    const linkClick = new Headers({
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
      "sec-fetch-user": "?1",
    });
    expect(isSameOriginDisplaySubresourceFetch(linkClick)).toBe(false);
  });
});
