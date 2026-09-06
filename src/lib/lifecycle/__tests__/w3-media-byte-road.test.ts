import { describe, expect, it } from "vitest";

// The sealing key the capability codec derives from. Set BEFORE the module
// under test is imported, exactly as enabler 0.6's own suite does.
process.env.BETTER_AUTH_SECRET ??= "x3091-placeholder-not-a-credential";

// WAVE 3 OF `PLAN: Agents Lifecycle (D) — Review` (cinatra#3091, epic #3087) —
// THE BYTE ROAD, AND WHAT NEVER TRAVELS ON IT.
//
// The plan's own words, §6.7: "Inside a third-party application every media
// display paints nothing until wave 3 retrofits it: the byte capability and its
// serving route landed with the sibling epic's W3 ... and wave 3 is the
// displays' adoption of them, not their construction. Displays never fetch host
// routes on their own after wave 3."
//
// THIS FILE PINS THE ADOPTION AND ITS ONE INVARIANT: what crosses to a display,
// and to anything assembled from what crosses to a display, is a REFERENCE —
// two identifiers sealed into one address — and never a byte of the work.

import {
  REVIEW_ISLAND_BYTE_CAPABILITY_QUERY_PARAM,
  REVIEW_ISLAND_BYTE_ROUTE,
  verifyReviewIslandByteCapability,
} from "@/lib/lifecycle/review-island-byte-capability";
import {
  MEDIA_BYTE_ROAD_KINDS,
  buildIslandArtifactByteMinter,
  mediaByteRoadKindFor,
  type IslandBytePrincipal,
} from "@/lib/lifecycle/review-island-byte-road";

const PRINCIPAL: IslandBytePrincipal = {
  orgId: "org_w3",
  userId: "user_w3",
  jti: "jti_w3",
  siteId: "site_w3",
  client: "wordpress",
  instanceId: "inst_w3",
  agentSlug: "review-agent",
};

const GATE = { runId: "run_w3", reviewTaskId: "wayflow-w3" };

/** The nine kinds the plan enumerates for wave 3, by the form each display
 *  declares today, and which road the plan puts each on. */
const NINE_KINDS: ReadonlyArray<{
  extension: string;
  mime: string;
  road: "byte" | "content";
}> = [
  { extension: "image-artifact", mime: "image/png", road: "byte" },
  { extension: "video-artifact", mime: "video/mp4", road: "byte" },
  { extension: "audio-artifact", mime: "audio/mpeg", road: "byte" },
  { extension: "pdf-artifact", mime: "application/pdf", road: "byte" },
  {
    extension: "document-artifact",
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    road: "byte",
  },
  { extension: "zip-artifact", mime: "application/zip", road: "byte" },
  { extension: "json-artifact", mime: "application/json", road: "content" },
  {
    extension: "cms-snapshot-artifact",
    mime: "application/vnd.cinatra.cms-fields+json",
    road: "content",
  },
  { extension: "text-artifact", mime: "text/csv", road: "content" },
];

describe("wave 3 — the six media kinds take the byte road, the three fetchers do not", () => {
  it("names a media kind for each of the six and nothing for the three fetchers", () => {
    for (const kind of NINE_KINDS) {
      const resolved = mediaByteRoadKindFor(kind.mime);
      if (kind.road === "byte") {
        expect(resolved, `${kind.extension} must take the byte road`).not.toBeNull();
      } else {
        expect(resolved, `${kind.extension} draws from the content channel`).toBeNull();
      }
    }
  });

  it("covers the two new displays' forms too — the screenshot's picture and the deck's pdf", () => {
    expect(mediaByteRoadKindFor("image/png")).toBe("image");
    expect(mediaByteRoadKindFor("image/webp")).toBe("image");
    expect(mediaByteRoadKindFor("application/pdf")).toBe("pdf");
  });

  it("declares the six kinds and no more", () => {
    expect(Object.keys(MEDIA_BYTE_ROAD_KINDS).sort()).toEqual(
      ["archive", "audio", "document", "image", "pdf", "video"],
    );
  });
});

describe("wave 3 — the minter is enabler 0.6's first caller and emits only its route", () => {
  const mint = buildIslandArtifactByteMinter({ principal: PRINCIPAL, ...GATE });

  it("addresses every media kind through the island byte route, never a session route", () => {
    for (const kind of NINE_KINDS.filter((k) => k.road === "byte")) {
      const urls = mint({
        artifactId: `art_${kind.extension}`,
        representationRevisionId: `rev_${kind.extension}`,
        mime: kind.mime,
      });
      expect(urls, kind.extension).not.toBeNull();
      for (const url of [urls!.preview, urls!.download]) {
        expect(url, kind.extension).toBeTruthy();
        expect(url!.startsWith(`${REVIEW_ISLAND_BYTE_ROUTE}?`), kind.extension).toBe(true);
        expect(url).not.toContain("/api/artifacts/");
      }
    }
  });

  it("seals each address to the ONE artifact and the ONE revision it was minted for", () => {
    const urls = mint({
      artifactId: "art_one",
      representationRevisionId: "rev_one",
      mime: "image/png",
    })!;
    const encoded = new URL(urls.preview!, "https://example.invalid").searchParams.get(
      REVIEW_ISLAND_BYTE_CAPABILITY_QUERY_PARAM,
    );
    const opened = verifyReviewIslandByteCapability(encoded);
    expect(opened).not.toBeNull();
    expect(opened!.artifactId).toBe("art_one");
    expect(opened!.representationRevisionId).toBe("rev_one");
    expect(opened!.runId).toBe(GATE.runId);
    expect(opened!.reviewTaskId).toBe(GATE.reviewTaskId);
    expect(opened!.orgId).toBe(PRINCIPAL.orgId);
    expect(opened!.disposition).toBe("preview");
  });

  it("seals the disposition, so a preview address can never be read as a download one", () => {
    const urls = mint({
      artifactId: "art_two",
      representationRevisionId: "rev_two",
      mime: "application/pdf",
    })!;
    const dispositionOf = (url: string) =>
      verifyReviewIslandByteCapability(
        new URL(url, "https://example.invalid").searchParams.get(
          REVIEW_ISLAND_BYTE_CAPABILITY_QUERY_PARAM,
        ),
      )!.disposition;
    expect(dispositionOf(urls.preview!)).toBe("preview");
    expect(dispositionOf(urls.download!)).toBe("download");
    expect(urls.preview).not.toBe(urls.download);
  });

  it("fixes the principal and the gate in the closure — a list of targets cannot vary them", () => {
    const a = mint({
      artifactId: "art_a",
      representationRevisionId: "rev_a",
      mime: "image/png",
    })!;
    const b = mint({
      artifactId: "art_b",
      representationRevisionId: "rev_b",
      mime: "video/mp4",
    })!;
    const open = (url: string) =>
      verifyReviewIslandByteCapability(
        new URL(url, "https://example.invalid").searchParams.get(
          REVIEW_ISLAND_BYTE_CAPABILITY_QUERY_PARAM,
        ),
      )!;
    const openedA = open(a.preview!);
    const openedB = open(b.preview!);
    for (const field of [
      "orgId",
      "userId",
      "jti",
      "siteId",
      "client",
      "instanceId",
      "agentSlug",
      "runId",
      "reviewTaskId",
    ] as const) {
      expect(openedA[field]).toBe(openedB[field]);
    }
    expect(openedA.artifactId).not.toBe(openedB.artifactId);
  });
});

describe("wave 3 — nothing passes a byte through the road's own module", () => {
  it("takes two identifiers and answers with an address: no byte is an argument or a result", () => {
    const mint = buildIslandArtifactByteMinter({ principal: PRINCIPAL, ...GATE });
    const urls = mint({
      artifactId: "art_ref",
      representationRevisionId: "rev_ref",
      mime: "application/zip",
    })!;
    for (const url of [urls.preview, urls.download]) {
      expect(typeof url).toBe("string");
      // The address carries the capability and NOTHING else — no inline
      // payload, no data: URI, no base64 blob of the work.
      expect(url!.startsWith("data:")).toBe(false);
      const params = [
        ...new URL(url!, "https://example.invalid").searchParams.keys(),
      ];
      expect(params).toEqual([REVIEW_ISLAND_BYTE_CAPABILITY_QUERY_PARAM]);
    }
  });
});

describe("wave 3 — the minter ENFORCES the partition it describes", () => {
  const mint = buildIslandArtifactByteMinter({ principal: PRINCIPAL, ...GATE });

  it("mints for the six media kinds and refuses every form off the road", () => {
    for (const kind of NINE_KINDS) {
      const minted = mint({
        artifactId: `art_${kind.extension}`,
        representationRevisionId: `rev_${kind.extension}`,
        mime: kind.mime,
      });
      if (kind.road === "byte") {
        expect(minted, kind.extension).not.toBeNull();
      } else {
        // THE GRANT IS THE PLAN'S, NOT "every file". A fetcher's revision
        // travels the content channel under its cap; handing it a sealed
        // capability to the full raw bytes beside that projection would widen
        // the island reader's reach past the six kinds this wave authorizes.
        expect(minted, `${kind.extension} must not gain a byte capability`).toBeNull();
      }
    }
  });

  it("refuses a form it cannot classify at all, rather than defaulting onto the road", () => {
    for (const mime of [null, "", "application/octet-stream", "text/plain"]) {
      expect(
        mint({ artifactId: "art_x", representationRevisionId: "rev_x", mime }),
        String(mime),
      ).toBeNull();
    }
  });
});
