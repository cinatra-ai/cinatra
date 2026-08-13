// @vitest-environment jsdom
//
// cinatra#2577 (epic #2564 S8d) — HOW the review card addresses the §III island.
//
// The island's framing wall is computed per request from what the card puts in
// that URL, so this is the client half of the same contract the server half
// (`src/lib/__tests__/review-island-frame-ancestors.test.ts`) pins:
//   • a first-party host asks for the ref and nothing else — the island's wall
//     stays `frame-ancestors 'self'`;
//   • an embedded host also names its OWN two frame disambiguators, so the
//     server can re-derive the one registered origin that is genuinely an
//     ancestor there. Without them the island returns 200 and paints nothing,
//     which is the defect this slice fixes.
// What is deliberately NOT here: an origin. The card cannot put one in the URL,
// so nothing it writes can widen a policy.

import { describe, expect, it } from "vitest";

import { REVIEW_TARGET_ISLAND_PATH, reviewTargetIslandSrc } from "../review-gate-card";

const REF = "ref/with+chars=&and space";

describe("first party — the ref, and nothing else", () => {
  it("carries only the ref when the host declares no frame", () => {
    const src = reviewTargetIslandSrc(REF, null);
    const url = new URL(src, "https://app.example");
    expect(url.pathname).toBe(REVIEW_TARGET_ISLAND_PATH);
    expect([...url.searchParams.keys()]).toEqual(["ref"]);
    expect(url.searchParams.get("ref")).toBe(REF);
  });
});

describe("embedded — the ref plus the host's own frame selectors", () => {
  const FRAME = { assistant: "wordpress", instanceId: "inst-1" };

  it("names the SAME two disambiguators the embed page itself carries", () => {
    const url = new URL(reviewTargetIslandSrc(REF, FRAME), "https://app.example");
    expect(url.pathname).toBe(REVIEW_TARGET_ISLAND_PATH);
    expect(url.searchParams.get("ref")).toBe(REF);
    expect(url.searchParams.get("assistant")).toBe("wordpress");
    expect(url.searchParams.get("instanceId")).toBe("inst-1");
  });

  it("stays a RELATIVE first-party path — the island is never fetched cross-origin", () => {
    expect(reviewTargetIslandSrc(REF, FRAME).startsWith("/")).toBe(true);
  });

  it("adds NOTHING else — no origin, no token, no third key", () => {
    const url = new URL(reviewTargetIslandSrc(REF, FRAME), "https://app.example");
    expect([...url.searchParams.keys()].sort()).toEqual(["assistant", "instanceId", "ref"]);
  });

  it("escapes every value it carries", () => {
    const url = new URL(
      reviewTargetIslandSrc(REF, { assistant: "a&b=c", instanceId: "i d" }),
      "https://app.example",
    );
    expect(url.searchParams.get("ref")).toBe(REF);
    expect(url.searchParams.get("assistant")).toBe("a&b=c");
    expect(url.searchParams.get("instanceId")).toBe("i d");
  });
});
