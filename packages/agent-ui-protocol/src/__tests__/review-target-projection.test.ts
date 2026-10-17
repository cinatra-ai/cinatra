// cinatra#4129 — THE REVIEW TARGET'S PROJECTIONS, IN ONE PLACE.
//
// Every form of a pinned target id that any surface draws (a path segment of
// the version-pinned byte routes, the island's `target` selector, the island
// address a card frames, the identity and the keys the card gives its frames,
// the revision a target header carries, and pairs versus the one aggregate
// island) is made by the `review-target-projection` section of the lifecycle
// cards. Each form is the projected value or a NAMED refusal. This suite pins
// each refusal by name, proves each form by reading it back the way its
// consumer reads it (URL resolution, the island's query read), and bounds the
// FINAL address a card frames, whatever answer it was composed from. A target's
// identity leaves the section as a `ReviewTargetKey`, a compile-time label whose
// runtime value is the revision id. The type-level cases below pin the slips
// that label turns into type errors; a deliberate string operation (a cast,
// `String(key)`, a join, `Object.keys`, a widening to `unknown`) still compiles,
// and is not what this suite claims to stop.

import { describe, expect, it } from "vitest";

import {
  LIFECYCLE_ISLAND_SRC_MAX_LENGTH,
  LIFECYCLE_ISLAND_TARGET_KEY_MAX_LENGTH,
  LIFECYCLE_TARGET_HEADER_MAX_TEXT,
  REVIEW_TARGET_ISLAND_PATH,
  composeReviewIslandAddress,
  lifecycleTargetHeaderSchema,
  mintReviewTargetIslandAddresses,
  projectReviewIslandTargetSelector,
  projectReviewTargetHeaderRevision,
  projectReviewTargetKey,
  projectReviewTargetPathSegment,
  readReviewIslandTargetSelector,
  readReviewTargetIslandAddresses,
  reviewGateTargetDrawing,
  reviewGateTargetPairKeys,
  reviewIslandAddressCredential,
  reviewIslandAddressIdentity,
  reviewIslandComposedCredential,
  reviewIslandFrameKey,
  reviewTargetHeaderKey,
  reviewTargetIdRefusal,
  reviewTargetIslandAddressOf,
  reviewTargetIslandAddressesWire,
  reviewTargetPairKey,
  reviewTargetRevisionMarker,
  reviewTargetStreamKey,
  reviewTargetVersionPath,
  sameReviewTargetIslandAddresses,
  selectReviewIslandTargets,
  withReviewIslandTarget,
  type LifecycleTargetHeader,
  type ReviewTargetKey,
} from "../renderable-views/lifecycle-cards";

const LONE_HIGH = "rev_\uD800";
const LONE_LOW = "\uDC00rev";
/** Ids every form carries exactly: reserved characters, dots that are not a
 *  whole segment, an escape sequence and an astral character. */
const CARRIED = ["rev_1", "a/b", "a?b", "a#b", "a%2Fb", "a b+c&d=e", "...", ".a", "a.", "%2e%2e", "😀"];
const FRAME = { assistant: "wordpress", instanceId: "inst-1" };
const REF = "ref-4129";

const header = (revisionId: string, objectType = "doc"): LifecycleTargetHeader => ({
  title: "t",
  typeLabel: "Doc",
  objectType,
  revisionId,
  facts: [],
});

/** The two ids the version route reads back out of an address, resolved the
 *  way a browser resolves a link. */
const versionRouteReads = (path: string) => {
  const segments = new URL(path, "https://app.example").pathname.split("/");
  expect(segments).toHaveLength(7);
  expect(segments[4]).toBe("versions");
  return [decodeURIComponent(segments[3]!), decodeURIComponent(segments[5]!), segments[6]];
};

/** The query of an island address, read the way the island page reads it. */
const islandQuery = (src: string) => new URL(src, "https://app.example").searchParams;

/** The key of a revision id the section accepts. */
const key = (revisionId: string): ReviewTargetKey => {
  const projected = projectReviewTargetKey(revisionId);
  if (!projected.ok) throw new Error(projected.refusal);
  return projected.value;
};

/** A wire set of per-target addresses, read back the way the answer's parser
 *  reads it. */
const addressesOf = (wire: Record<string, string | null>) => {
  const read = readReviewTargetIslandAddresses(wire, (raw) => (typeof raw === "string" ? raw : undefined));
  if (read === null || read === undefined) throw new Error("refused");
  return read;
};

describe("the shared refusal: the ids no form can carry", () => {
  it("names each refusal", () => {
    expect(reviewTargetIdRefusal("")).toBe("empty-id");
    expect(reviewTargetIdRefusal(".")).toBe("dot-segment-id");
    expect(reviewTargetIdRefusal("..")).toBe("dot-segment-id");
    expect(reviewTargetIdRefusal(LONE_HIGH)).toBe("ill-formed-id");
    expect(reviewTargetIdRefusal(LONE_LOW)).toBe("ill-formed-id");
    expect(reviewTargetIdRefusal("\uD800")).toBe("ill-formed-id");
    for (const id of CARRIED) expect(reviewTargetIdRefusal(id)).toBeNull();
  });
});

describe("a path segment of the version-pinned byte routes", () => {
  it("carries every other id as ONE segment the route reads back exactly", () => {
    for (const id of CARRIED) {
      const path = reviewTargetVersionPath("art-1", id, "preview");
      expect(path.ok).toBe(true);
      if (!path.ok) continue;
      expect(versionRouteReads(path.value)).toEqual(["art-1", id, "preview"]);
      const artifact = reviewTargetVersionPath(id, "rev-1", "content");
      expect(artifact.ok && versionRouteReads(artifact.value)).toEqual([id, "rev-1", "content"]);
    }
  });

  it("refuses an empty id, a dot segment and ill-formed text, by name, in either place", () => {
    // What a dot segment does to a composed link: URL resolution removes it.
    expect(new URL("/api/artifacts/a/versions/../preview", "https://app.example").pathname).toBe(
      "/api/artifacts/a/preview",
    );
    expect(new URL("/api/artifacts/a/versions//preview", "https://app.example").pathname).not.toMatch(
      /\/versions\/[^/]+\/preview$/,
    );
    for (const [id, refusal] of [
      ["", "empty-id"],
      [".", "dot-segment-id"],
      ["..", "dot-segment-id"],
      [LONE_HIGH, "ill-formed-id"],
      [LONE_LOW, "ill-formed-id"],
    ] as const) {
      expect(projectReviewTargetPathSegment(id)).toEqual({ ok: false, refusal });
      expect(reviewTargetVersionPath("art-1", id, "preview")).toEqual({ ok: false, refusal });
      expect(reviewTargetVersionPath(id, "rev-1", "content")).toEqual({ ok: false, refusal });
    }
  });
});

describe("the island's `target` selector", () => {
  it("carries an id the island reads back exactly, within the key bound", () => {
    for (const id of CARRIED) {
      const selector = projectReviewIslandTargetSelector(id);
      expect(selector.ok).toBe(true);
      if (selector.ok) expect(islandQuery(`/x?target=${selector.value}`).get("target")).toBe(id);
    }
    const atBound = "r".repeat(LIFECYCLE_ISLAND_TARGET_KEY_MAX_LENGTH);
    expect(projectReviewIslandTargetSelector(atBound)).toEqual({ ok: true, value: atBound });
  });

  it("refuses by name: the shared refusals, a raw id past the bound, an ENCODED value past it", () => {
    expect(projectReviewIslandTargetSelector("")).toEqual({ ok: false, refusal: "empty-id" });
    expect(projectReviewIslandTargetSelector("..")).toEqual({ ok: false, refusal: "dot-segment-id" });
    expect(projectReviewIslandTargetSelector(LONE_HIGH)).toEqual({ ok: false, refusal: "ill-formed-id" });
    expect(projectReviewIslandTargetSelector("r".repeat(LIFECYCLE_ISLAND_TARGET_KEY_MAX_LENGTH + 1))).toEqual({
      ok: false,
      refusal: "selector-over-bound",
    });
    // 43 characters whose form encoding is six characters each (258).
    expect(projectReviewIslandTargetSelector("é".repeat(43))).toEqual({
      ok: false,
      refusal: "selector-over-bound",
    });
  });
});

describe("the island address a card frames: the bound is read on the FINAL address", () => {
  /** The credential length at which `compose` makes an address of exactly
   *  `length` characters. */
  const credentialFor = (compose: (credential: string) => string, length: number) =>
    "c".repeat(length - (compose("c").length - 1));

  const shapes = {
    // The route's current answer: a per-target grant, recomposed with the
    // card's own frame selectors and palette, naming its target.
    "a current per-target answer": (credential: string) =>
      composeReviewIslandAddress({ ref: REF, credential, frame: FRAME, colorScheme: "dark", target: key("rev_1") }),
    // An older server's answer: the gate-wide grant, no target.
    "an older server's gate-wide answer": (credential: string) =>
      composeReviewIslandAddress({ ref: REF, credential, frame: FRAME, colorScheme: "light" }),
    // A held (cached) answer recomposed in the palette asked for since.
    "a held answer recomposed in a new palette": (credential: string) =>
      composeReviewIslandAddress({ ref: REF, credential, frame: null, colorScheme: "light" }),
  } as const;

  for (const [name, compose] of Object.entries(shapes)) {
    it(`${name}: 2048 characters is framed, 2049 is refused by name`, () => {
      const value = (credential: string) => {
        const address = compose(credential);
        if (!address.ok) throw new Error(address.refusal);
        return address.value;
      };
      const at = credentialFor(value, LIFECYCLE_ISLAND_SRC_MAX_LENGTH);
      const framed = compose(at);
      expect(framed.ok && framed.value.length).toBe(LIFECYCLE_ISLAND_SRC_MAX_LENGTH);
      expect(compose(`${at}c`)).toEqual({ ok: false, refusal: "address-over-bound" });
    });
  }

  it("composes the island's own path, the fields in their order, and the target exactly", () => {
    const address = composeReviewIslandAddress({
      ref: "a ref/with=chars",
      credential: "sealed",
      frame: FRAME,
      colorScheme: "dark",
      target: key("a b+c&d=e"),
    });
    expect(address.ok).toBe(true);
    if (!address.ok) return;
    expect(address.value.startsWith(`${REVIEW_TARGET_ISLAND_PATH}?`)).toBe(true);
    const query = islandQuery(address.value);
    expect([...query.keys()]).toEqual(["ref", "ic", "assistant", "instanceId", "scheme", "target"]);
    expect(query.get("ref")).toBe("a ref/with=chars");
    expect(query.get("target")).toBe("a b+c&d=e");
    expect(reviewIslandComposedCredential(address.value)).toBe("sealed");
  });

  it("a target the selector refuses has no key, by the selector's name, so no address names it", () => {
    expect(projectReviewTargetKey("")).toEqual({ ok: false, refusal: "empty-id" });
    expect(projectReviewTargetKey(".")).toEqual({ ok: false, refusal: "dot-segment-id" });
    expect(projectReviewTargetKey(LONE_LOW)).toEqual({ ok: false, refusal: "ill-formed-id" });
    expect(projectReviewTargetKey("r".repeat(LIFECYCLE_ISLAND_TARGET_KEY_MAX_LENGTH + 1))).toEqual({
      ok: false,
      refusal: "selector-over-bound",
    });
    expect(projectReviewTargetKey("é".repeat(43))).toEqual({ ok: false, refusal: "selector-over-bound" });
  });
});

describe("a server-minted address with its target added (the route's per-target addresses)", () => {
  const minted = (credentialLength: number) => `${REVIEW_TARGET_ISLAND_PATH}?ref=${REF}&ic=${"c".repeat(credentialLength)}`;
  it("adds the target the island reads back, and is bounded at 2048", () => {
    const id = "rev_8f3a1c2d4e5f6a7b";
    const fits = 2048 - minted(0).length - "&target=".length - id.length;
    const at = withReviewIslandTarget(minted(fits), key(id));
    expect(at.ok && at.value.length).toBe(2048);
    expect(at.ok && islandQuery(at.value).get("target")).toBe(id);
    expect(withReviewIslandTarget(minted(fits + 1), key(id))).toEqual({ ok: false, refusal: "address-over-bound" });
  });
});

describe("the credential out of an answer's address — never the address", () => {
  it("is taken only from the island's own path, this ref, and the target it was minted for", () => {
    const src = `${REVIEW_TARGET_ISLAND_PATH}?ref=${REF}&ic=sealed&target=rev_1`;
    expect(reviewIslandAddressCredential(src, REF)).toBe("sealed");
    expect(reviewIslandAddressCredential(src, REF, key("rev_1"))).toBe("sealed");
    expect(reviewIslandAddressCredential(src, REF, key("rev_2"))).toBeNull();
    expect(reviewIslandAddressCredential(src, "another-ref")).toBeNull();
    expect(reviewIslandAddressCredential(`/elsewhere?ref=${REF}&ic=sealed`, REF)).toBeNull();
    expect(reviewIslandAddressCredential(`https://evil.example/elsewhere?ref=${REF}&ic=x`, REF)).toBeNull();
    expect(reviewIslandAddressCredential(`${REVIEW_TARGET_ISLAND_PATH}?ref=${REF}&ic=`, REF)).toBeNull();
    expect(reviewIslandAddressCredential(null, REF)).toBeNull();
  });
});

describe("the identity and the keys a card gives its frames", () => {
  it("the document identity drops the palette alone, so two targets never share one", () => {
    const at = (target: string, colorScheme: string) => {
      const address = composeReviewIslandAddress({ ref: REF, frame: FRAME, colorScheme, target: key(target) });
      if (!address.ok) throw new Error(address.refusal);
      return address.value;
    };
    expect(reviewIslandAddressIdentity(at("rev_1", "dark"))).toBe(reviewIslandAddressIdentity(at("rev_1", "light")));
    expect(reviewIslandAddressIdentity(at("rev_1", "dark"))).not.toBe(reviewIslandAddressIdentity(at("rev_2", "dark")));
    expect(islandQuery(reviewIslandAddressIdentity(at("a b+c", "dark"))).get("target")).toBe("a b+c");
    const identity = reviewIslandAddressIdentity(at("rev_1", "dark"));
    expect(reviewIslandFrameKey(identity, 0)).not.toBe(reviewIslandFrameKey(identity, 1));
  });

  it("a header key is apart for two pins that share a revision and a type", () => {
    const shared = header("rev_1");
    expect(reviewTargetHeaderKey(0, shared)).not.toBe(reviewTargetHeaderKey(1, shared));
    expect(reviewTargetPairKey(key("rev_1"), 1)).not.toBe(reviewTargetPairKey(key("rev_1"), 2));
    expect(reviewTargetPairKey(key("rev_1"), 1)).not.toBe(reviewTargetPairKey(key("rev_2"), 1));
  });

  it("an island stream's key is WHOLE: apart by position, and for two targets whose ids join alike", () => {
    const first = { artifactId: "a:b", representationRevisionId: "c" };
    const second = { artifactId: "a", representationRevisionId: "b:c" };
    expect(reviewTargetStreamKey(0, first)).not.toBe(reviewTargetStreamKey(0, second));
    expect(reviewTargetStreamKey(0, first)).not.toBe(reviewTargetStreamKey(1, first));
    expect(reviewTargetStreamKey(0, first)).toBe(reviewTargetStreamKey(0, { ...first }));
  });
});

describe("a target's key: a compile-time label the section mints", () => {
  it("is minted from an id the selector accepts, and two keys of one id are the same key", () => {
    for (const id of CARRIED) expect(projectReviewTargetKey(id).ok).toBe(true);
    expect(key("rev_1") === key("rev_1")).toBe(true);
    expect(key("rev_1") === key("rev_2")).toBe(false);
    expect(new Set([key("rev_1"), key("rev_1"), key("rev_2")]).size).toBe(2);
  });

  it("the type refuses the common slips: a template, `+`, a comparison or text in a key's place", () => {
    const target = key("rev_1");
    // @ts-expect-error the type refuses a template over a key
    const composed = `${target}:1`;
    // @ts-expect-error the type refuses `+` on a key
    const joined = "pair:" + target;
    // @ts-expect-error the type refuses comparing a key with text
    const compared = target === "rev_1";
    // @ts-expect-error the type refuses text as a key
    const fromText: ReviewTargetKey = "rev_1";
    // @ts-expect-error the type refuses a key as a URL parameter value
    new URLSearchParams().set("target", target);
    // @ts-expect-error the type refuses a key where an encoder takes text
    const encoded = encodeURIComponent(target);
    // @ts-expect-error the type refuses text where an address asks a key
    const byText = composeReviewIslandAddress({ ref: REF, target: "rev_1" });
    // @ts-expect-error the type refuses text where a lookup asks a key
    const lookedUp = reviewTargetIslandAddressOf(addressesOf({ rev_1: "/a" }), "rev_1");
    expect([composed, joined, compared, fromText, encoded, byText, lookedUp]).toHaveLength(7);
  });
});

describe("the island's `target` parameter, read back by the section", () => {
  it("an absent parameter names no target; one accepted value names its key", () => {
    expect(readReviewIslandTargetSelector({})).toEqual({ ok: true, target: null });
    expect(readReviewIslandTargetSelector({ ref: "r" })).toEqual({ ok: true, target: null });
    const named = readReviewIslandTargetSelector({ target: "a b+c" });
    expect(named.ok && named.target === key("a b+c")).toBe(true);
  });

  it("refuses by name: a repeated parameter and every id the selector refuses", () => {
    expect(readReviewIslandTargetSelector({ target: ["rev_1", "rev_2"] })).toEqual({
      ok: false,
      refusal: "repeated-selector",
    });
    expect(readReviewIslandTargetSelector({ target: "" })).toEqual({ ok: false, refusal: "empty-id" });
    expect(readReviewIslandTargetSelector({ target: ".." })).toEqual({ ok: false, refusal: "dot-segment-id" });
    expect(readReviewIslandTargetSelector({ target: LONE_HIGH })).toEqual({ ok: false, refusal: "ill-formed-id" });
    expect(
      readReviewIslandTargetSelector({ target: "r".repeat(LIFECYCLE_ISLAND_TARGET_KEY_MAX_LENGTH + 1) }),
    ).toEqual({ ok: false, refusal: "selector-over-bound" });
  });

  it("draws the whole set for no target, and EXACTLY ONE pinned target for a key", () => {
    const stream = (artifactId: string, representationRevisionId: string) => ({
      target: { artifactId, representationRevisionId },
    });
    const streams = [stream("a1", "rev-shared"), stream("a2", "rev-shared"), stream("a3", "rev-own")];
    expect(selectReviewIslandTargets(null, streams)).toEqual({ ok: true, value: streams });
    expect(selectReviewIslandTargets(key("rev-own"), streams)).toEqual({ ok: true, value: [streams[2]] });
    expect(selectReviewIslandTargets(key("rev-shared"), streams)).toEqual({
      ok: false,
      refusal: "ambiguous-selector",
    });
    expect(selectReviewIslandTargets(key("rev-none"), streams)).toEqual({
      ok: false,
      refusal: "unmatched-selector",
    });
  });
});

describe("the per-target island addresses: built, carried, read back and looked up by the section", () => {
  const minted = `${REVIEW_TARGET_ISLAND_PATH}?ref=${REF}&ic=sealed`;

  it("mints one address per target, each naming its own target, and carries it on the wire", () => {
    let calls = 0;
    const addresses = mintReviewTargetIslandAddresses([key("rev_1"), key("a b+c")], () => {
      calls += 1;
      return `${minted}-${calls}`;
    });
    expect(calls).toBe(2);
    expect(addresses).not.toBeNull();
    const wire = reviewTargetIslandAddressesWire(addresses!);
    expect(Object.keys(wire)).toEqual(["rev_1", "a b+c"]);
    expect(islandQuery(wire["rev_1"]!).get("target")).toBe("rev_1");
    expect(islandQuery(wire["a b+c"]!).get("ic")).toBe("sealed-2");
    expect(islandQuery(reviewTargetIslandAddressOf(addresses!, key("a b+c"))!).get("target")).toBe("a b+c");
    expect(reviewTargetIslandAddressOf(addresses!, key("rev_9"))).toBeNull();
  });

  it("a failed mint is null for that target alone; a target named twice is no set at all", () => {
    const one = mintReviewTargetIslandAddresses([key("rev_1"), key("rev_2")], () => null);
    expect(one && reviewTargetIslandAddressesWire(one)).toEqual({ rev_1: null, rev_2: null });
    expect(mintReviewTargetIslandAddresses([key("rev_1"), key("rev_1")], () => minted)).toBeNull();
    const tooLong = `${minted}${"c".repeat(LIFECYCLE_ISLAND_SRC_MAX_LENGTH)}`;
    expect(mintReviewTargetIslandAddresses([key("rev_1")], () => tooLong)).toBeNull();
  });

  it("reads the wire back as ONE bounded shape whose every key the section accepts", () => {
    const wire = { rev_1: "/a", rev_2: null };
    expect(reviewTargetIslandAddressesWire(addressesOf(wire))).toEqual(wire);
    const read = (raw: unknown) =>
      readReviewTargetIslandAddresses(raw, (value) => (typeof value === "string" ? value : undefined));
    expect(read(undefined)).toBeNull();
    expect(read(null)).toBeNull();
    for (const bad of [[], { "": "/a" }, { "..": "/a" }, { [LONE_HIGH]: "/a" }, { rev_1: 7 }]) {
      expect(read(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it("two sets are the same only with the same targets, in the same order, at the same addresses", () => {
    const a = addressesOf({ rev_1: "/a", rev_2: null });
    expect(sameReviewTargetIslandAddresses(a, addressesOf({ rev_1: "/a", rev_2: null }))).toBe(true);
    expect(sameReviewTargetIslandAddresses(a, addressesOf({ rev_2: null, rev_1: "/a" }))).toBe(false);
    expect(sameReviewTargetIslandAddresses(a, addressesOf({ rev_1: "/b", rev_2: null }))).toBe(false);
    expect(sameReviewTargetIslandAddresses(a, null)).toBe(false);
    expect(sameReviewTargetIslandAddresses(null, null)).toBe(true);
  });
});

describe("the revision a target header shows", () => {
  it("keeps a short id whole and cuts a long one by whole characters, with the exact id kept", () => {
    expect(reviewTargetRevisionMarker("rev_1")).toEqual({ short: "rev_1", full: "rev_1" });
    expect(reviewTargetRevisionMarker("r".repeat(14))).toEqual({ short: "r".repeat(14), full: "r".repeat(14) });
    expect(reviewTargetRevisionMarker("r".repeat(15))).toEqual({ short: `${"r".repeat(12)}…`, full: "r".repeat(15) });
    const astral = "😀".repeat(15);
    const marker = reviewTargetRevisionMarker(astral);
    expect(marker.full).toBe(astral);
    expect(marker.short).toBe(`${"😀".repeat(12)}…`);
  });
});

describe("the revision a target header carries", () => {
  it("is the exact id, or names its target and the refusal by name", () => {
    expect(projectReviewTargetHeaderRevision("rev_1")).toEqual({ revisionId: "rev_1", exact: true });
    expect(projectReviewTargetHeaderRevision("")).toEqual({
      revisionId: "—",
      exact: false,
      refusal: "header-empty",
    });
    expect(projectReviewTargetHeaderRevision("..")).toEqual({
      revisionId: "..",
      exact: false,
      refusal: "dot-segment-id",
    });
    expect(projectReviewTargetHeaderRevision(LONE_HIGH)).toEqual({
      revisionId: "rev_\uFFFD",
      exact: false,
      refusal: "header-substituted",
    });
    expect(projectReviewTargetHeaderRevision(LONE_LOW)).toEqual({
      revisionId: "\uFFFDrev",
      exact: false,
      refusal: "header-substituted",
    });
    const long = "r".repeat(LIFECYCLE_TARGET_HEADER_MAX_TEXT + 1);
    expect(projectReviewTargetHeaderRevision(long)).toEqual({
      revisionId: long.slice(0, LIFECYCLE_TARGET_HEADER_MAX_TEXT),
      exact: false,
      refusal: "header-cut",
    });
  });

  it("is exact AT the bound, also when its last character is astral", () => {
    const atBound = `${"r".repeat(LIFECYCLE_TARGET_HEADER_MAX_TEXT - 2)}😀`;
    expect(atBound).toHaveLength(LIFECYCLE_TARGET_HEADER_MAX_TEXT);
    expect(projectReviewTargetHeaderRevision(atBound)).toEqual({ revisionId: atBound, exact: true });
  });

  it("cuts on a CHARACTER boundary: an astral character across the bound is dropped whole", () => {
    // 199 units, then one astral character of two units: the bound falls
    // between its two halves.
    const across = `${"r".repeat(LIFECYCLE_TARGET_HEADER_MAX_TEXT - 1)}😀`;
    const projected = projectReviewTargetHeaderRevision(across);
    expect(projected).toEqual({
      revisionId: "r".repeat(LIFECYCLE_TARGET_HEADER_MAX_TEXT - 1),
      exact: false,
      refusal: "header-cut",
    });
    expect(projectReviewTargetPathSegment(projected.revisionId).ok).toBe(true);
  });

  it("every header it shows is one the wire's header schema accepts", () => {
    for (const id of [
      "",
      "..",
      LONE_HIGH,
      LONE_LOW,
      `${"r".repeat(LIFECYCLE_TARGET_HEADER_MAX_TEXT - 1)}😀`,
      "😀".repeat(LIFECYCLE_TARGET_HEADER_MAX_TEXT),
      "r".repeat(LIFECYCLE_TARGET_HEADER_MAX_TEXT + 1),
    ]) {
      const shown = projectReviewTargetHeaderRevision(id).revisionId;
      expect(reviewTargetIdRefusal(shown), JSON.stringify(id)).not.toBe("ill-formed-id");
      expect(lifecycleTargetHeaderSchema.safeParse(header(shown)).success, JSON.stringify(id)).toBe(true);
    }
  });
});

describe("pairs or the one aggregate island, read from the headers AND the transport", () => {
  const TWO = [header("rev_1"), header("rev_2")];
  const map = addressesOf({ rev_1: "/a", rev_2: null });

  it("the pairs' keys are one per header, in the headers' order", () => {
    expect(reviewGateTargetPairKeys(TWO, true)).toEqual([key("rev_1"), key("rev_2")]);
    expect(reviewGateTargetPairKeys(TWO, false)).toBeNull();
    expect(reviewGateTargetPairKeys([header("rev_1"), header("rev_1", "other")], true)).toBeNull();
  });

  it("per-target addresses draw pairs; no credential at all (the reader's cookie) draws pairs", () => {
    expect(
      reviewGateTargetDrawing({ targetHeaders: TWO, targetHeadersComplete: true, islandSrcByRevision: map, gateWideCredential: false }),
    ).toBe("pairs");
    expect(
      reviewGateTargetDrawing({ targetHeaders: TWO, targetHeadersComplete: true, islandSrcByRevision: null, gateWideCredential: false }),
    ).toBe("pairs");
  });

  it("a gate-wide grant with NO per-target addresses draws the ONE aggregate island (the route's over-budget fallback)", () => {
    expect(
      reviewGateTargetDrawing({ targetHeaders: TWO, targetHeadersComplete: true, islandSrcByRevision: null, gateWideCredential: true }),
    ).toBe("aggregate");
  });

  it("headers that are not the whole set, or not exact distinct selectors, draw the aggregate on every transport", () => {
    for (const [targetHeaders, targetHeadersComplete] of [
      [TWO, false],
      [TWO, undefined],
      [[header("rev_1")], true],
      [[header("rev_1"), header("rev_1", "other")], true],
      [[header("rev_1"), header("..")], true],
      [[header("rev_1"), header("")], true],
      [[header("rev_1"), header(LONE_HIGH)], true],
      [null, true],
    ] as const) {
      for (const islandSrcByRevision of [map, null]) {
        for (const gateWideCredential of [true, false]) {
          expect(
            reviewGateTargetDrawing({ targetHeaders, targetHeadersComplete, islandSrcByRevision, gateWideCredential }),
          ).toBe("aggregate");
        }
      }
    }
  });
});
