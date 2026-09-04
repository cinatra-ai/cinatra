// ---------------------------------------------------------------------------
// extension-package-manifest-version.test.ts — the version rule of the shared
// package-identity reader (cinatra#3204).
//
// The version pattern is applied to bytes an OPERATOR supplied, so it is an
// untrusted-input surface: it has to decide in bounded time, not merely decide
// correctly. The first shape of it was ambiguous — the same character both
// opened an optional group and belonged to the unbounded class inside that
// group, and the whole group repeated — so a version built out of many
// repeated separators forced exponential backtracking before the refusal came
// back.
//
// Three things are pinned here: the ACCEPTANCE set (canonical SemVer 2.0.0,
// which is what a package.json version is), its EQUIVALENCE with the product's
// own semver layer, and the BOUND (a pathological string is refused in
// milliseconds, not minutes).
//
// The equivalence is the load-bearing one. An admitted version is later read
// by `semver` (the update check in screens.tsx, the orchestrator's range
// check), so admitting a shape `semver` cannot parse installs an extension
// that is permanently uncomparable — no update is ever offered for it. Whether
// the reader here and `semver.valid` agree is therefore a product rule, not a
// stylistic one, and it is asserted directly rather than approximated.
// ---------------------------------------------------------------------------

import semver from "semver";
import { describe, expect, it } from "vitest";

import { readExtensionPackageIdentity } from "../extension-package-manifest";

function identityFor(version: unknown) {
  return readExtensionPackageIdentity(
    JSON.stringify({ name: "@acme/thing-skill", version, cinatra: { kind: "skill" } }),
    "archive",
  );
}

function versionAccepted(version: string): boolean {
  try {
    return identityFor(version).packageVersion === version;
  } catch {
    return false;
  }
}

describe("the supplied package version", () => {
  it.each([
    "1.0.0",
    "0.0.0",
    "10.20.30",
    "1.2.3-alpha",
    "1.2.3-alpha.1",
    "1.2.3-0.3.7",
    "1.2.3-x-y-z",
    "1.2.3+build",
    "1.2.3+build.7",
    "1.2.3+21AF26D3-117B344092BD",
    "1.2.3-alpha+build",
    "1.2.3-rc.1+exp.sha.5114f85",
  ])("accepts %s", (version) => {
    expect(versionAccepted(version)).toBe(true);
  });

  it.each([
    "1.2",
    "1.2.3.4",
    "v1.2.3",
    "1.2.3-",
    "1.2.3+",
    "1.2.3 ",
    "",
    "not-a-version",
    // Leading zeros. SemVer forbids them in every numeric position, and so
    // does `semver.valid`, so admitting one would hand the rest of the
    // product a version it cannot compare.
    "01.2.3",
    "1.02.3",
    "1.2.03",
    "1.2.3-01",
    // Empty identifiers, which a run of separators would produce.
    "1.2.3-a..b",
    "1.2.3+a..b",
  ])("refuses %s", (version) => {
    expect(versionAccepted(version)).toBe(false);
  });

  it("names the version in the refusal", () => {
    // The refusal has to quote back what was actually supplied — an operator
    // reading it needs to see the string that was refused, not only the rule.
    expect(() => identityFor("nope")).toThrow(/missing a valid "version"/);
    expect(() => identityFor("nope")).toThrow(/got "nope"/);
  });

  // THE EQUIVALENCE, stated in the direction that carries the product rule:
  // an ADMITTED version must be one `semver` can READ, because the rest of the
  // product reads the stored version with `semver` and nothing else. A version
  // admitted here that `semver.valid` answers null for installs an extension
  // that is permanently uncomparable — no update is ever offered for it and it
  // satisfies no range. That is the defect the leading-zero shapes below
  // caused, and this is the assertion that keeps it from coming back.
  it.each([
    "1.0.0",
    "0.0.0",
    "10.20.30",
    "1.2.3-alpha",
    "1.2.3-alpha.1",
    "1.2.3-0.3.7",
    "1.2.3-x-y-z",
    "1.2.3+build",
    "1.2.3+build.7",
    "1.2.3+21AF26D3-117B344092BD",
    "1.2.3-alpha+build",
    "1.2.3-rc.1+exp.sha.5114f85",
    "1.2.3+a-b",
  ])("admits %s, which semver can read", (version) => {
    expect(versionAccepted(version)).toBe(true);
    expect(semver.valid(version)).not.toBeNull();
  });

  // The other half: nothing `semver` cannot read is ever admitted. The leading
  // zeros all land here — each one would previously have installed as an
  // uncomparable version.
  it.each([
    "01.2.3",
    "1.02.3",
    "1.2.03",
    "1.2.3-01",
    "1.2.3-a..b",
    "1.2.3+a..b",
    "1.2.3+a+b",
    "1.2.3.4",
    "1.2",
    "not-a-version",
  ])("refuses %s, which semver cannot read either", (version) => {
    expect(semver.valid(version)).toBeNull();
    expect(versionAccepted(version)).toBe(false);
  });

  // The reader is deliberately STRICTER than `semver.valid` in exactly one
  // respect, pinned here so it is never "fixed" into leniency. `semver.valid`
  // coerces: it trims surrounding space and strips a leading "v", answering
  // "1.2.3" for all three of these. The string admitted here is the string
  // STORED, and it is later used verbatim as a package spec as well as
  // compared, so a non-canonical spelling would be a version the comparisons
  // can read but the lookups cannot match. Refusing it is correct; only being
  // LOOSER than the reader is the defect.
  it.each(["v1.2.3", "1.2.3 ", " 1.2.3"])(
    "refuses %s even though semver would coerce it",
    (version) => {
      expect(semver.valid(version)).not.toBeNull();
      expect(versionAccepted(version)).toBe(false);
    },
  );

  // THE BOUND. Each of these is a shape a backtracking engine can be made to
  // blow up on if the pattern is ambiguous, and each is refused, so the whole
  // cost is backtracking rather than a fast early match.
  //
  //   - "0.0.0+" then many "--" pairs is what the ORIGINAL pattern backtracked
  //     exponentially on: every extra pair doubled the work. The same string
  //     measured over two minutes against that pattern.
  //   - a long run of digits in a prerelease identifier is the shape the
  //     current pattern's alternation could in principle be slow on, since
  //     three of its branches all begin by matching digits. They differ only
  //     in a fixed suffix, so the cost stays linear — pinned here so a future
  //     edit to the alternation cannot quietly make it otherwise.
  //
  // The budget is deliberately generous: a linear decision returns in well
  // under a millisecond, so a whole second still separates pass from fail by
  // orders of magnitude while leaving room for CI descheduling and GC.
  it.each([
    ["repeated separators", `0.0.0+${"--".repeat(40)}!`],
    ["a long numeric prerelease run", `1.2.3-${"9".repeat(4000)}!`],
    ["a long numeric core run", `${"9".repeat(4000)}!.2.3`],
  ])("refuses %s in bounded time", (_name, pathological) => {
    const started = performance.now();
    expect(versionAccepted(pathological)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
