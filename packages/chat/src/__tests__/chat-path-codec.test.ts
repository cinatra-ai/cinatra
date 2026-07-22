// Path-codec round-trip + grammar tests (cinatra#1878 W3, AC#1/#6). Exhaustive +
// randomized property coverage over all four legal path shapes, both launch
// kinds, and every redirect/invalid verdict — no boundary stubs (the codec is
// pure).
import { describe, expect, it } from "vitest";
import {
  CHAT_ROOT,
  DEFAULT_ASSISTANT_PACKAGE,
  DEFAULT_CHAT_PATH,
  DEFAULT_CHAT_ROUTE,
  assertChatRoute,
  buildChatPath,
  chatSegmentsFromPathname,
  disambiguateRest,
  isChatPathname,
  packageNameToVendorSlug,
  parseChatPath,
  routeIsThread,
  routePackageName,
  splitChatSegments,
  threadSlugFromPathname,
  vendorSlugToPackageName,
  type ChatRoute,
} from "../chat-path-codec";

// A tiny seeded PRNG so the "property" sweeps are deterministic across runs.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const TOKEN_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789-_.";
function randToken(rng: () => number, minLen = 1, maxLen = 24): string {
  const len = minLen + Math.floor(rng() * (maxLen - minLen + 1));
  let s = "";
  // First/last char kept alnum so we never generate a leading/trailing separator
  // that a stricter slug normalizer would reject (the codec accepts them, but
  // realistic vendor/slug/instance/titleSlug tokens are alnum-bounded).
  for (let i = 0; i < len; i++) {
    const pool = i === 0 || i === len - 1 ? TOKEN_CHARS.slice(0, 36) : TOKEN_CHARS;
    s += pool[Math.floor(rng() * pool.length)];
  }
  return s;
}

const pathToSegments = (path: string): string[] =>
  path.startsWith(CHAT_ROOT) ? path.slice(CHAT_ROOT.length).split("/").filter(Boolean) : [];

describe("chat-path-codec — constants", () => {
  it("the default route maps to the builtin Cinatra assistant package", () => {
    expect(routePackageName(DEFAULT_CHAT_ROUTE)).toBe(DEFAULT_ASSISTANT_PACKAGE);
    // Pins agreement with BUILTIN_ASSISTANT_ALIAS.packageName (see the host
    // registry-schema pin test) — the redirect target must be the builtin.
    expect(DEFAULT_ASSISTANT_PACKAGE).toBe("@cinatra-ai/cinatra-assistant");
  });
  it("the default path is /chat/<vendor>/<slug> for the builtin", () => {
    expect(DEFAULT_CHAT_PATH).toBe("/chat/cinatra-ai/cinatra-assistant");
  });
});

describe("chat-path-codec — package ⇔ vendor/slug", () => {
  it("round-trips a scoped package name", () => {
    const vs = packageNameToVendorSlug("@cinatra-ai/wordpress-assistant");
    expect(vs).toEqual({ vendor: "cinatra-ai", slug: "wordpress-assistant" });
    expect(vendorSlugToPackageName(vs!.vendor, vs!.slug)).toBe(
      "@cinatra-ai/wordpress-assistant",
    );
  });
  it("rejects non-scoped / malformed package names", () => {
    for (const bad of ["cinatra-ai/x", "@only-vendor", "@a/b/c", "@/x", "@a/", "", "@a/ b"]) {
      expect(packageNameToVendorSlug(bad)).toBeNull();
    }
  });
  it("vendorSlugToPackageName throws on an invalid segment", () => {
    expect(() => vendorSlugToPackageName("a/b", "x")).toThrow();
    expect(() => vendorSlugToPackageName("a", "")).toThrow();
  });
});

describe("chat-path-codec — build validation", () => {
  it("builds the four legal shapes", () => {
    expect(buildChatPath({ vendor: "v", slug: "s" })).toBe("/chat/v/s");
    expect(buildChatPath({ vendor: "v", slug: "s", titleSlug: "hello-world" })).toBe(
      "/chat/v/s/hello-world",
    );
    expect(buildChatPath({ vendor: "v", slug: "s", instance: "inst-1" })).toBe(
      "/chat/v/s/inst-1",
    );
    expect(
      buildChatPath({ vendor: "v", slug: "s", instance: "inst-1", titleSlug: "hi" }),
    ).toBe("/chat/v/s/inst-1/hi");
  });
  it("throws on a segment containing a slash or whitespace", () => {
    expect(() => buildChatPath({ vendor: "v", slug: "a/b" })).toThrow();
    expect(() => buildChatPath({ vendor: "v", slug: "s", titleSlug: "a b" })).toThrow();
  });
  it("assertChatRoute enforces the kind invariants", () => {
    expect(() =>
      assertChatRoute({ vendor: "v", slug: "s", instance: "i" }, { remoteCapable: false }),
    ).toThrow(/must not carry an instance/);
    expect(() =>
      assertChatRoute({ vendor: "v", slug: "s", titleSlug: "t" }, { remoteCapable: true }),
    ).toThrow(/must be instance-scoped/);
    // Legal shapes pass through untouched.
    expect(
      assertChatRoute({ vendor: "v", slug: "s", titleSlug: "t" }, { remoteCapable: false }),
    ).toEqual({ vendor: "v", slug: "s", titleSlug: "t" });
    expect(
      assertChatRoute(
        { vendor: "v", slug: "s", instance: "i", titleSlug: "t" },
        { remoteCapable: true },
      ),
    ).toEqual({ vendor: "v", slug: "s", instance: "i", titleSlug: "t" });
  });
});

describe("chat-path-codec — parse verdicts", () => {
  it("bare /chat redirects to the canonical default", () => {
    expect(parseChatPath([], { remoteCapable: false })).toEqual({
      kind: "redirect",
      to: DEFAULT_CHAT_PATH,
    });
    expect(parseChatPath(undefined, { remoteCapable: true })).toEqual({
      kind: "redirect",
      to: DEFAULT_CHAT_PATH,
    });
  });
  it("a single legacy /chat/<uuid> segment is intentionally dead (invalid)", () => {
    expect(
      parseChatPath(["3f2504e0-4f89-11d3-9a0c-0305e82c3301"], { remoteCapable: false }),
    ).toEqual({ kind: "invalid" });
    expect(parseChatPath(["anything"], { remoteCapable: true })).toEqual({ kind: "invalid" });
  });
  it("a local kind: 1 tail = thread, 2 tail = invalid", () => {
    expect(parseChatPath(["v", "s", "my-thread"], { remoteCapable: false })).toEqual({
      kind: "route",
      route: { vendor: "v", slug: "s", titleSlug: "my-thread" },
    });
    expect(parseChatPath(["v", "s", "a", "b"], { remoteCapable: false })).toEqual({
      kind: "invalid",
    });
  });
  it("a remote kind: 1 tail = instance, 2 tail = instance+thread, 3 tail = invalid", () => {
    expect(parseChatPath(["v", "s", "inst"], { remoteCapable: true })).toEqual({
      kind: "route",
      route: { vendor: "v", slug: "s", instance: "inst" },
    });
    expect(parseChatPath(["v", "s", "inst", "thr"], { remoteCapable: true })).toEqual({
      kind: "route",
      route: { vendor: "v", slug: "s", instance: "inst", titleSlug: "thr" },
    });
    expect(parseChatPath(["v", "s", "a", "b", "c"], { remoteCapable: true })).toEqual({
      kind: "invalid",
    });
  });
  it("rejects an empty or slashy vendor/slug", () => {
    expect(splitChatSegments(["", "s"])).toEqual({ kind: "invalid" });
    expect(disambiguateRest({ vendor: "v", slug: "s" }, ["ok"], { remoteCapable: false })).toEqual(
      { kind: "route", route: { vendor: "v", slug: "s", titleSlug: "ok" } },
    );
  });
});

describe("chat-path-codec — pathname helpers", () => {
  it("threadSlugFromPathname returns the thread slug or null (kind-aware)", () => {
    expect(threadSlugFromPathname("/chat/v/s/hello", { remoteCapable: false })).toBe("hello");
    // For a remote kind the 3rd segment is the INSTANCE, not a thread slug.
    expect(threadSlugFromPathname("/chat/v/s/hello", { remoteCapable: true })).toBeNull();
    expect(threadSlugFromPathname("/chat/v/s/inst/hello", { remoteCapable: true })).toBe("hello");
    expect(threadSlugFromPathname("/chat/v/s", { remoteCapable: false })).toBeNull();
    expect(threadSlugFromPathname("/agents/x", { remoteCapable: false })).toBeNull();
  });
  it("chatSegmentsFromPathname strips the mount and empties", () => {
    expect(chatSegmentsFromPathname("/chat/v/s/thr")).toEqual(["v", "s", "thr"]);
    expect(chatSegmentsFromPathname("/chat")).toEqual([]);
    expect(chatSegmentsFromPathname("/chat/")).toEqual([]);
    expect(chatSegmentsFromPathname("/other")).toEqual([]);
  });
  it("isChatPathname matches the mount and below only", () => {
    expect(isChatPathname("/chat")).toBe(true);
    expect(isChatPathname("/chat/v/s")).toBe(true);
    expect(isChatPathname("/chatty")).toBe(false);
    expect(isChatPathname("/personal")).toBe(false);
  });
  it("routeIsThread reflects titleSlug presence", () => {
    expect(routeIsThread({ vendor: "v", slug: "s" })).toBe(false);
    expect(routeIsThread({ vendor: "v", slug: "s", instance: "i" })).toBe(false);
    expect(routeIsThread({ vendor: "v", slug: "s", titleSlug: "t" })).toBe(true);
  });
});

describe("chat-path-codec — PROPERTY: build∘parse round-trip over all shapes", () => {
  it("round-trips every legal route for both kinds (2000 random cases)", () => {
    const rng = mulberry32(0xc1a7);
    for (let i = 0; i < 2000; i++) {
      const remoteCapable = rng() < 0.5;
      const vendor = randToken(rng);
      const slug = randToken(rng);
      // Choose a legal shape for the kind.
      const shape = Math.floor(rng() * (remoteCapable ? 3 : 2));
      let route: ChatRoute;
      if (!remoteCapable) {
        route = shape === 0 ? { vendor, slug } : { vendor, slug, titleSlug: randToken(rng) };
      } else if (shape === 0) {
        route = { vendor, slug };
      } else if (shape === 1) {
        route = { vendor, slug, instance: randToken(rng) };
      } else {
        route = { vendor, slug, instance: randToken(rng), titleSlug: randToken(rng) };
      }
      assertChatRoute(route, { remoteCapable });
      const path = buildChatPath(route);
      const parsed = parseChatPath(pathToSegments(path), { remoteCapable });
      expect(parsed.kind).toBe("route");
      if (parsed.kind === "route") {
        expect(parsed.route).toEqual(route);
        // And re-building the parsed route is a fixed point.
        expect(buildChatPath(parsed.route)).toBe(path);
      }
    }
  });

  it("parse∘build round-trip: a parsed path re-builds to the same path", () => {
    const rng = mulberry32(0x5eed);
    for (let i = 0; i < 1000; i++) {
      const remoteCapable = rng() < 0.5;
      const segs = [randToken(rng), randToken(rng)];
      const tail = Math.floor(rng() * (remoteCapable ? 3 : 2));
      for (let k = 0; k < tail; k++) segs.push(randToken(rng));
      const parsed = parseChatPath(segs, { remoteCapable });
      expect(parsed.kind).toBe("route");
      if (parsed.kind === "route") {
        expect(pathToSegments(buildChatPath(parsed.route))).toEqual(segs);
      }
    }
  });
});
