// Thread title-slug allocator — pure normalization + collision policy
// (cinatra#1878 W3, AC#2). The store seam proves DB atomicity; this proves the
// normalization + suffix + candidate-stream contracts the seam relies on.
import { describe, expect, it } from "vitest";
import {
  FALLBACK_THREAD_SLUG,
  THREAD_SLUG_MAX_LEN,
  ThreadSlugExhaustedError,
  allocateSlug,
  shortSlugSuffix,
  slugCandidates,
  slugWithUniqueTail,
  slugifyTitle,
  withSlugSuffix,
} from "../thread-slug";

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

describe("slugifyTitle", () => {
  it("normalizes a normal title", () => {
    expect(slugifyTitle("Hello, World!")).toBe("hello-world");
    expect(slugifyTitle("  Quarterly   Report  2026  ")).toBe("quarterly-report-2026");
  });
  it("folds accents to ASCII", () => {
    expect(slugifyTitle("Café Déjà Vu")).toBe("cafe-deja-vu");
  });
  it("falls back for empty / non-latin-only titles", () => {
    expect(slugifyTitle("")).toBe(FALLBACK_THREAD_SLUG);
    expect(slugifyTitle(null)).toBe(FALLBACK_THREAD_SLUG);
    expect(slugifyTitle(undefined)).toBe(FALLBACK_THREAD_SLUG);
    expect(slugifyTitle("   ")).toBe(FALLBACK_THREAD_SLUG);
    expect(slugifyTitle("🙂🙂🙂")).toBe(FALLBACK_THREAD_SLUG);
  });
  it("caps length and never ends on a hyphen", () => {
    const long = "word ".repeat(50);
    const s = slugifyTitle(long);
    expect(s.length).toBeLessThanOrEqual(THREAD_SLUG_MAX_LEN);
    expect(s.endsWith("-")).toBe(false);
    expect(s.startsWith("-")).toBe(false);
  });
  it("produces a valid flat token (matches the codec segment shape)", () => {
    for (const t of ["A B C", "under_score", "dot.dot", "多 lang test", "!!!weird!!!"]) {
      const s = slugifyTitle(t);
      expect(s).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });
});

describe("suffix + unique tail", () => {
  it("shortSlugSuffix is 4 base36 chars and deterministic under a seed", () => {
    const a = shortSlugSuffix(mulberry32(1));
    const b = shortSlugSuffix(mulberry32(1));
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-z0-9]{4}$/);
  });
  it("withSlugSuffix respects the length cap", () => {
    const base = "x".repeat(200);
    const out = withSlugSuffix(base, "abcd");
    expect(out.length).toBeLessThanOrEqual(THREAD_SLUG_MAX_LEN);
    expect(out.endsWith("-abcd")).toBe(true);
  });
  it("slugWithUniqueTail sanitizes and caps the tail", () => {
    expect(slugWithUniqueTail("report", "3f2504e0-4f89-11d3")).toBe("report-3f2504e04f89");
    expect(slugWithUniqueTail("report", "!!!")).toBe("report-id");
  });
});

describe("slugCandidates", () => {
  it("yields the bare base first, then suffixed variants", () => {
    const gen = slugCandidates("meeting-notes", mulberry32(7));
    const first = gen.next().value;
    expect(first).toBe("meeting-notes");
    const second = gen.next().value as string;
    const third = gen.next().value as string;
    expect(second).toMatch(/^meeting-notes-[a-z0-9]{4}$/);
    expect(third).not.toBe(second);
  });
});

describe("allocateSlug (pure twin of the DB retry)", () => {
  it("returns the bare base when the container is empty", () => {
    expect(allocateSlug("agenda", () => false)).toBe("agenda");
  });
  it("suffixes on a container collision — a DIFFERENT thread, same title", () => {
    const taken = new Set(["agenda"]);
    const s = allocateSlug("agenda", (x) => taken.has(x), { rng: mulberry32(3) });
    expect(s).not.toBe("agenda");
    expect(s).toMatch(/^agenda-[a-z0-9]{4}$/);
  });
  it("keeps suffixing until it finds a free slug", () => {
    // First N random candidates are all taken; only an unseen one is free.
    const taken = new Set<string>(["agenda"]);
    // Pre-seed the taken set with several suffixed forms from the same rng stream.
    const probe = slugCandidates("agenda", mulberry32(99));
    probe.next(); // skip the bare base
    for (let i = 0; i < 3; i++) taken.add(probe.next().value as string);
    const s = allocateSlug("agenda", (x) => taken.has(x), { rng: mulberry32(99) });
    expect(taken.has(s)).toBe(false);
    expect(s).toMatch(/^agenda-[a-z0-9]{4}$/);
  });
  it("falls back to the guaranteed-unique tail when random tries exhaust", () => {
    // isTaken rejects every random-suffixed candidate but accepts the id tail.
    const uniqueTail = "abcdef123456";
    const s = allocateSlug("agenda", (x) => x !== `agenda-${uniqueTail}`, {
      rng: mulberry32(5),
      maxTries: 8,
      uniqueTail,
    });
    expect(s).toBe(`agenda-${uniqueTail}`);
  });
  it("throws when exhausted and no unique tail is available", () => {
    expect(() => allocateSlug("agenda", () => true, { maxTries: 5 })).toThrow(
      ThreadSlugExhaustedError,
    );
  });
});
