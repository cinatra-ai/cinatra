import { describe, it, expect } from "vitest";
import { joinPath } from "../runtime-loader";

// ---------------------------------------------------------------------------
// LOADER-PARITY: the linear `joinPath` slash trims must be byte-for-byte
// equivalent to the retired anchored regexes
//   first segment:  p.replace(/\/+$/, "")
//   other segments: p.replace(/^\/+|\/+$/g, "")
// which CodeQL flagged as polynomial-ReDoS (js/polynomial-redos) on
// slash-heavy segment input. This proves the rewrite preserves behaviour.
// ---------------------------------------------------------------------------

// The EXACT pre-fix implementation, kept here only as the parity oracle.
function legacyJoinPath(...parts: string[]): string {
  return parts
    .map((p, i) => (i === 0 ? p.replace(/\/+$/, "") : p.replace(/^\/+|\/+$/g, "")))
    .filter((p) => p.length > 0)
    .join("/");
}

const CASES: string[][] = [
  ["a", "b", "c"],
  ["/a/", "/b/", "/c/"],
  ["//a//", "//b//"],
  ["root", "./register"],
  ["", "x", ""],
  ["/", "x"],
  ["x", "/"],
  ["/data/extensions/packages", "my-ext", "package.json"],
  ["/data/extensions/packages/", "/my-ext/", "/package.json/"],
  ["only"],
  [],
  // adversarial: long slash runs that would blow up an anchored greedy regex
  ["/".repeat(2000), "y"],
  ["a", "/".repeat(2000) + "b"],
  ["/x/", "/".repeat(2000)],
  ["/".repeat(2000) + "a" + "/".repeat(2000), "b"],
];

describe("runtime-loader joinPath ReDoS-parity", () => {
  it("matches the retired anchored slash-trim regexes on representative inputs", () => {
    for (const parts of CASES) {
      expect(joinPath(...parts)).toBe(legacyJoinPath(...parts));
    }
  });

  it("produces the expected canonical POSIX joins", () => {
    expect(joinPath("/data/extensions/packages", "my-ext")).toBe(
      "/data/extensions/packages/my-ext",
    );
    expect(joinPath("/data/extensions/packages/", "/my-ext/", "/package.json/")).toBe(
      "/data/extensions/packages/my-ext/package.json",
    );
    expect(joinPath("a", "", "b")).toBe("a/b");
  });

  it("stays linear on pathological slash-heavy input (completes well under a timeout)", () => {
    const evil = "/".repeat(200_000);
    const started = Date.now();
    // The retired regexes would exhibit super-linear blow-up here.
    expect(joinPath(evil, evil)).toBe("");
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
