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

// ---------------------------------------------------------------------------
// cinatra#2754 — the SERVER-MINTED credential
// ---------------------------------------------------------------------------
//
// A frame load on a third-party page carries no cookie, so the credential is
// sealed into the URL by the resolve route and travels back on its answer. The
// card takes the CREDENTIAL out of that answer and rebuilds the address from
// its own constant: an answer can supply a value the island will re-check, and
// never an address the card will frame.

describe("cross-site — the credential the server sealed", () => {
  const FRAME = { assistant: "wordpress", instanceId: "inst-1" };
  const SEALED = "AAAA-sealed_value-BBBB";
  const served = (ref: string, credential: string, path = REVIEW_TARGET_ISLAND_PATH) =>
    `${path}?ref=${encodeURIComponent(ref)}&ic=${encodeURIComponent(credential)}`;

  it("carries it beside the ref and the frame selectors", () => {
    const url = new URL(
      reviewTargetIslandSrc(REF, FRAME, served(REF, SEALED)),
      "https://app.example",
    );
    expect(url.pathname).toBe(REVIEW_TARGET_ISLAND_PATH);
    expect(url.searchParams.get("ref")).toBe(REF);
    expect(url.searchParams.get("ic")).toBe(SEALED);
    expect([...url.searchParams.keys()].sort()).toEqual(["assistant", "ic", "instanceId", "ref"]);
  });

  it("adds it to a FIRST-PARTY src too — the credential and the selectors are separate concerns", () => {
    const url = new URL(reviewTargetIslandSrc(REF, null, served(REF, SEALED)), "https://app.example");
    expect([...url.searchParams.keys()].sort()).toEqual(["ic", "ref"]);
  });

  it("composes exactly the pre-credential src when the answer carried none", () => {
    for (const none of [null, undefined, ""]) {
      expect(reviewTargetIslandSrc(REF, FRAME, none)).toBe(reviewTargetIslandSrc(REF, FRAME));
    }
  });

  it("DROPS a credential minted for another ref — an answer to another question", () => {
    const url = new URL(
      reviewTargetIslandSrc(REF, FRAME, served("another-ref", SEALED)),
      "https://app.example",
    );
    expect(url.searchParams.get("ic")).toBeNull();
    expect(url.searchParams.get("ref")).toBe(REF);
  });

  it("DROPS an answer that points at another path", () => {
    const url = new URL(
      reviewTargetIslandSrc(REF, FRAME, served(REF, SEALED, "/somewhere/else")),
      "https://app.example",
    );
    expect(url.pathname).toBe(REVIEW_TARGET_ISLAND_PATH);
    expect(url.searchParams.get("ic")).toBeNull();
  });

  it("never frames a foreign ORIGIN, even one wearing the island's own path", () => {
    const hostile = `https://evil.example${REVIEW_TARGET_ISLAND_PATH}?ref=${encodeURIComponent(REF)}&ic=${SEALED}`;
    const src = reviewTargetIslandSrc(REF, FRAME, hostile);
    expect(src.startsWith("/")).toBe(true);
    expect(src).not.toContain("evil.example");
    expect(new URL(src, "https://app.example").pathname).toBe(REVIEW_TARGET_ISLAND_PATH);
  });

  it("takes nothing else out of the answer — an extra key is not a card input", () => {
    const url = new URL(
      reviewTargetIslandSrc(
        REF,
        FRAME,
        `${served(REF, SEALED)}&assistant=elsewhere&instanceId=other&extra=1`,
      ),
      "https://app.example",
    );
    expect(url.searchParams.get("assistant")).toBe("wordpress");
    expect(url.searchParams.get("instanceId")).toBe("inst-1");
    expect(url.searchParams.get("extra")).toBeNull();
  });

  it("survives a malformed answer without composing a broken frame", () => {
    for (const junk of ["%%%", "javascript:alert(1)", "not a url at all"]) {
      expect(reviewTargetIslandSrc(REF, FRAME, junk)).toBe(reviewTargetIslandSrc(REF, FRAME));
    }
  });
});

// ---------------------------------------------------------------------------
// cinatra#2931 — the HOST's colour scheme
// ---------------------------------------------------------------------------
//
// The island is a nested document that cannot see the surface around it, so the
// card names the palette its own document is painting in. The composer's job is
// only to carry it: WHICH palette is read is the runtime hook's, and that every
// host reads it is `review-island-host-color-scheme.test.tsx`'s.

describe("the host's colour scheme rides the same address", () => {
  const FRAME = { assistant: "wordpress", instanceId: "inst-1" };

  it("names the palette beside the ref, on a first-party address", () => {
    const url = new URL(reviewTargetIslandSrc(REF, null, null, "dark"), "https://app.example");
    expect(url.searchParams.get("scheme")).toBe("dark");
    expect(url.searchParams.get("ref")).toBe(REF);
    expect([...url.searchParams.keys()].sort()).toEqual(["ref", "scheme"]);
  });

  it("names it beside the credential and the frame selectors too", () => {
    const url = new URL(
      reviewTargetIslandSrc(
        REF,
        FRAME,
        `${REVIEW_TARGET_ISLAND_PATH}?ref=${encodeURIComponent(REF)}&ic=sealed-value`,
        "light",
      ),
      "https://app.example",
    );
    expect(url.searchParams.get("scheme")).toBe("light");
    expect(url.searchParams.get("ic")).toBe("sealed-value");
    expect([...url.searchParams.keys()].sort()).toEqual([
      "assistant",
      "ic",
      "instanceId",
      "ref",
      "scheme",
    ]);
  });

  it("composes exactly the pre-scheme src when the host declares no palette", () => {
    for (const none of [null, undefined]) {
      expect(reviewTargetIslandSrc(REF, FRAME, null, none)).toBe(
        reviewTargetIslandSrc(REF, FRAME),
      );
    }
  });
});
