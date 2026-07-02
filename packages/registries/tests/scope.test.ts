import { describe, expect, it } from "vitest";
import {
  FIRST_PARTY_PACKAGE_SCOPE,
  dependencyScopePrefixesFor,
  parsePackageId,
  isSafePathSegment,
  assertSafePathSegment,
  vendorScopeOfPackage,
} from "@cinatra-ai/registries";

describe("vendorScopeOfPackage", () => {
  it("extracts the scope from a scoped package name", () => {
    expect(vendorScopeOfPackage("@cinatra-ai/contract-artifact")).toBe("@cinatra-ai");
    expect(vendorScopeOfPackage("@acme/widget")).toBe("@acme");
  });

  it("returns null for unscoped names", () => {
    expect(vendorScopeOfPackage("lodash")).toBeNull();
  });

  it("returns null for malformed inputs", () => {
    expect(vendorScopeOfPackage("@foo")).toBeNull(); // no slash
    expect(vendorScopeOfPackage("@/foo")).toBeNull(); // empty scope
    expect(vendorScopeOfPackage("")).toBeNull();
  });
});

describe("parsePackageId — canonical @vendor/name splitter (cinatra#537)", () => {
  it("splits a hyphenated SCOPE on the first '/' only — never on '-'", () => {
    // The exact #537 regression: the hyphen in the scope must NOT be treated
    // as a vendor/name boundary.
    expect(parsePackageId("@marcushorndt-local/page-summarizer-agent")).toEqual({
      vendor: "marcushorndt-local",
      name: "page-summarizer-agent",
    });
  });

  it("parses a first-party scoped name", () => {
    expect(parsePackageId("@cinatra-ai/foo")).toEqual({ vendor: "cinatra-ai", name: "foo" });
  });

  it("keeps every hyphen in a multi-hyphen scope inside the vendor", () => {
    expect(parsePackageId("@a-b-c-d/my-cool-agent")).toEqual({
      vendor: "a-b-c-d",
      name: "my-cool-agent",
    });
  });

  it("strips the leading '@' from the returned vendor (usable as a path segment)", () => {
    const parsed = parsePackageId("@acme/widget");
    expect(parsed?.vendor).toBe("acme"); // no leading "@"
    expect(parsed?.name).toBe("widget");
  });

  it("rejects (returns null) extra '/' segments in the name part (path-safety)", () => {
    // A scoped name must be a single path segment; an extra '/' is malformed and
    // must never be carried into a nested on-disk path. (See the path-traversal
    // rejection cases below.)
    expect(parsePackageId("@acme/sub/deep")).toBeNull();
  });

  it("returns vendor=null for an unscoped name (caller decides its own fallback)", () => {
    // The repo convention: unscoped → no vendor, name is the whole input. We
    // deliberately do NOT guess a vendor by splitting on '-' (that was the bug).
    expect(parsePackageId("page-summarizer-agent")).toEqual({
      vendor: null,
      name: "page-summarizer-agent",
    });
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(parsePackageId("  @acme/widget  ")).toEqual({ vendor: "acme", name: "widget" });
  });

  it("returns null for malformed scoped inputs (mirrors vendorScopeOfPackage)", () => {
    expect(parsePackageId("@foo")).toBeNull(); // no slash
    expect(parsePackageId("@/foo")).toBeNull(); // empty scope
    expect(parsePackageId("@acme/")).toBeNull(); // empty name
    expect(parsePackageId("@")).toBeNull();
    expect(parsePackageId("")).toBeNull();
  });

  it("agrees with vendorScopeOfPackage on the vendor for every well-formed scoped name", () => {
    for (const name of ["@cinatra-ai/foo", "@marcushorndt-local/page-summarizer-agent", "@acme/widget"]) {
      const parsed = parsePackageId(name);
      const scope = vendorScopeOfPackage(name);
      expect(scope).toBe(`@${parsed?.vendor}`);
    }
  });

  it("treats separator-injection as MALFORMED — never silently keeps a multi-segment name (cinatra#537 hardening)", () => {
    // A second "/" after the first must NOT be preserved in `name` (that would
    // land as nested path segments at the writer). The whole input is rejected.
    expect(parsePackageId("@acme/foo/bar")).toBeNull();
    expect(parsePackageId("@acme/foo/bar/baz")).toBeNull();
  });

  it("rejects traversal / separator / absolute forms in either segment", () => {
    expect(parsePackageId("@acme/../../etc")).toBeNull();
    expect(parsePackageId("@acme/..")).toBeNull(); // name is ".."
    expect(parsePackageId("@../x")).toBeNull(); // vendor is ".."
    expect(parsePackageId("@../foo")).toBeNull(); // vendor ".." (the bypass case)
    expect(parsePackageId("@/foo")).toBeNull(); // empty scope (the bypass case)
    expect(parsePackageId("@~evil/foo")).toBeNull(); // leading-~ vendor (the bypass case)
    expect(parsePackageId("@..")).toBeNull(); // scoped, no slash → null (the bypass case)
    expect(parsePackageId("@.")).toBeNull(); // scoped, no slash → null (the bypass case)
    expect(parsePackageId("@acme/foo\\bar")).toBeNull(); // backslash
    expect(parsePackageId("@acme/~evil")).toBeNull(); // leading-~ name
    expect(parsePackageId("../etc")).toBeNull(); // unscoped traversal
    expect(parsePackageId("foo/bar")).toBeNull(); // unscoped with separator
    expect(parsePackageId("..")).toBeNull(); // unscoped dotdot
  });

  it("rejects a NUL / control char in the name", () => {
    expect(parsePackageId("@acme/a" + String.fromCharCode(0) + "b")).toBeNull();
    expect(parsePackageId("@acme/a\nb")).toBeNull();
  });
});

describe("isSafePathSegment / assertSafePathSegment — positive allowlist (cinatra#537)", () => {
  // A POSITIVE ALLOWLIST: a segment is safe ONLY if it is a bare post-parse
  // name component — starts ASCII-alnum, interior `.`/`_`/`-`, ENDS alnum OR
  // hyphen. It is a TRUE SUPERSET of the repo's canonical package shape
  // `^[a-z0-9][a-z0-9-]*$` (which permits a trailing `-`), and subsumes every
  // prior denylist rule (traversal, @, ~, separators, control, drive,
  // whitespace) while still rejecting a trailing `.`/`_`.
  it("accepts normal single segments (and single-char alnum)", () => {
    expect(isSafePathSegment("a")).toBe(true);
    expect(isSafePathSegment("cinatra-ai")).toBe(true);
    expect(isSafePathSegment("marcushorndt-local")).toBe(true);
    expect(isSafePathSegment("page-summarizer-agent")).toBe(true);
    expect(isSafePathSegment("a.b_c-d")).toBe(true);
    // real canonical names that must never regress
    expect(isSafePathSegment("agent-ui-protocol")).toBe(true);
    expect(isSafePathSegment("drupal-content-editor")).toBe(true);
    expect(isSafePathSegment("unknown")).toBe(true);
  });

  it("accepts a TRAILING hyphen — true superset of canonical ^[a-z0-9][a-z0-9-]*$ (cinatra#537)", () => {
    // The canonical PACKAGE_NAME_RE / PACKAGE_DIR_RE permit a trailing `-`, so
    // the guard must too — else a real (if rare) name like "foo-" would fail to
    // write. (Trailing `.`/`_` stay rejected; see below.)
    expect(isSafePathSegment("foo-")).toBe(true);
    expect(isSafePathSegment("a-")).toBe(true);
    expect(isSafePathSegment("x9-")).toBe(true);
  });

  it("rejects whitespace anywhere (the denylist gap the allowlist closes)", () => {
    expect(isSafePathSegment(" @..")).toBe(false); // leading space + scoped
    expect(isSafePathSegment(".. ")).toBe(false); // trailing space
    expect(isSafePathSegment(" foo")).toBe(false); // leading space
    expect(isSafePathSegment("foo ")).toBe(false); // trailing space
    expect(isSafePathSegment("a b")).toBe(false); // interior space
    expect(isSafePathSegment("\tfoo")).toBe(false); // tab
    expect(isSafePathSegment("foo\n")).toBe(false); // newline
  });

  it("rejects traversal, separators, @, ~, drive, bad punctuation, control, non-string", () => {
    expect(isSafePathSegment("")).toBe(false);
    expect(isSafePathSegment(".")).toBe(false);
    expect(isSafePathSegment("..")).toBe(false);
    expect(isSafePathSegment("a/b")).toBe(false);
    expect(isSafePathSegment("a\\b")).toBe(false);
    expect(isSafePathSegment("@x")).toBe(false);
    expect(isSafePathSegment("@..")).toBe(false);
    expect(isSafePathSegment("@~evil")).toBe(false);
    expect(isSafePathSegment("@cinatra-ai")).toBe(false); // even a real scope is invalid AS A SEGMENT
    expect(isSafePathSegment("~x")).toBe(false);
    expect(isSafePathSegment("C:")).toBe(false);
    expect(isSafePathSegment("C:foo")).toBe(false);
    expect(isSafePathSegment("-foo")).toBe(false); // leading "-"
    expect(isSafePathSegment(".foo")).toBe(false); // leading "."
    expect(isSafePathSegment("_foo")).toBe(false); // leading "_"
    expect(isSafePathSegment("foo.")).toBe(false); // trailing "." (Windows footgun)
    expect(isSafePathSegment("foo_")).toBe(false); // trailing "_"
    expect(isSafePathSegment("a" + String.fromCharCode(0) + "b")).toBe(false); // NUL
    expect(isSafePathSegment("a" + String.fromCharCode(127) + "b")).toBe(false); // DEL
    expect(isSafePathSegment(42 as unknown)).toBe(false);
    expect(isSafePathSegment(null as unknown)).toBe(false);
  });

  it("is a true superset of the canonical ^[a-z0-9][a-z0-9-]*$ shape", () => {
    // Exhaustive up to length 3 across [a-z0-9-]: every canonical string passes.
    const canonical = /^[a-z0-9][a-z0-9-]*$/;
    const chars = "abz09-".split("");
    for (const a of "abz09".split("")) {
      for (const b of ["", ...chars]) {
        for (const c of ["", ...chars]) {
          const s = a + b + c;
          if (canonical.test(s)) expect(isSafePathSegment(s)).toBe(true);
        }
      }
    }
  });

  it("assertSafePathSegment throws on unsafe and is a no-op on safe (incl. trailing-hyphen)", () => {
    expect(() => assertSafePathSegment("..")).toThrow(/unsafe/);
    expect(() => assertSafePathSegment("a/b")).toThrow(/unsafe/);
    expect(() => assertSafePathSegment("~x")).toThrow(/unsafe/);
    expect(() => assertSafePathSegment("@x")).toThrow(/unsafe/);
    expect(() => assertSafePathSegment("@..")).toThrow(/unsafe/);
    expect(() => assertSafePathSegment(" foo")).toThrow(/unsafe/);
    expect(() => assertSafePathSegment("foo.")).toThrow(/unsafe/);
    expect(() => assertSafePathSegment("ok-seg")).not.toThrow();
    expect(() => assertSafePathSegment("foo-")).not.toThrow();
  });
});

describe("dependencyScopePrefixesFor", () => {
  it("returns own scope + first-party for a third-party root", () => {
    expect(dependencyScopePrefixesFor("@acme/widget").sort()).toEqual(
      [`${FIRST_PARTY_PACKAGE_SCOPE}/`, "@acme/"].sort(),
    );
  });

  it("deduplicates for a first-party root", () => {
    expect(dependencyScopePrefixesFor("@cinatra-ai/blog-idea-generator-agent")).toEqual([
      `${FIRST_PARTY_PACKAGE_SCOPE}/`,
    ]);
  });

  it("yields only the first-party prefix for an unscoped root (which the resolver then rejects)", () => {
    expect(dependencyScopePrefixesFor("lodash")).toEqual([`${FIRST_PARTY_PACKAGE_SCOPE}/`]);
  });

  it("never derives the allowlist from anything but the root package name", () => {
    // Regression contract for issue #103: the instance namespace must not
    // appear here. The function signature only accepts the root name, so this
    // simply pins the first-party constant's value.
    expect(FIRST_PARTY_PACKAGE_SCOPE).toBe("@cinatra-ai");
  });
});
