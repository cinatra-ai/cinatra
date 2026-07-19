// Type-driven projection-disposition resolver (epic #1785).
//
// THE single shared resolver the retirement cuts the projector / rebuild /
// recall / effective-type-catalog over to, replacing the per-org DB-claim
// arbitration. This is the resolver MATRIX: the exact contract for every
// (installed?, declared?) combination — installed exact definer → its declared
// disposition; installed-but-undeclared → artifact-safe; missing/uninstalled
// definer → none, NEVER raw; an invalid declared projection fails closed DOWN to
// artifact-safe, never up to raw.

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";

import {
  objectTypeRegistry,
  resolveTypeProjectionDisposition,
  isDispositionGovernedType,
} from "../registry";
import type { TypeDispositions } from "../types";

const TYPE = "@acme/pack:thing";

function register(dispositions?: TypeDispositions, type = TYPE, pkg?: string) {
  objectTypeRegistry.register(
    {
      type,
      category: "report",
      schema: z.record(z.string(), z.unknown()),
      lifecycle: { sources: ["agent"], mutableBy: ["agent"] },
      renderers: { listRow: null, card: null, detail: null },
      ...(dispositions ? { dispositions } : {}),
    },
    pkg,
  );
}

beforeEach(() => {
  objectTypeRegistry._clearForTests();
});

describe("resolveTypeProjectionDisposition — the resolver matrix", () => {
  it("missing / uninstalled definer (unregistered) → 'none' (fail closed, NEVER raw)", () => {
    expect(resolveTypeProjectionDisposition(TYPE)).toBe("none");
    expect(resolveTypeProjectionDisposition("@nobody/pkg:x")).toBe("none");
  });

  it("installed + declares projection 'raw' → 'raw'", () => {
    register({ projection: "raw" });
    expect(resolveTypeProjectionDisposition(TYPE)).toBe("raw");
  });

  it("installed + declares projection 'artifact-safe' → 'artifact-safe'", () => {
    register({ projection: "artifact-safe" });
    expect(resolveTypeProjectionDisposition(TYPE)).toBe("artifact-safe");
  });

  it("installed + declares projection 'none' → 'none'", () => {
    register({ projection: "none" });
    expect(resolveTypeProjectionDisposition(TYPE)).toBe("none");
  });

  it("installed but declares NO disposition → 'artifact-safe' (the default)", () => {
    register(undefined);
    expect(resolveTypeProjectionDisposition(TYPE)).toBe("artifact-safe");
  });

  it("installed + INVALID declared projection → 'artifact-safe' (fail closed DOWN, never UP to raw)", () => {
    register({ projection: "totally-bogus" as unknown as TypeDispositions["projection"] });
    expect(resolveTypeProjectionDisposition(TYPE)).toBe("artifact-safe");
    // Explicitly: an invalid value NEVER escalates to raw.
    expect(resolveTypeProjectionDisposition(TYPE)).not.toBe("raw");
  });

  it("carries only the projection — the rest of the payload does not change the result", () => {
    register({ projection: "none", pinnable: false, sensitivity: "sensitive", mutability: "record" });
    expect(resolveTypeProjectionDisposition(TYPE)).toBe("none");
  });

  it("an uninstall (removeByPackage) flips a declared type back to 'none' (fail closed)", () => {
    register({ projection: "artifact-safe" }, TYPE, "@acme/pack");
    expect(resolveTypeProjectionDisposition(TYPE)).toBe("artifact-safe");
    objectTypeRegistry.removeByPackage("@acme/pack");
    expect(resolveTypeProjectionDisposition(TYPE)).toBe("none");
  });
});

describe("isDispositionGovernedType — governance predicate", () => {
  it("true only when installed AND a disposition is declared", () => {
    register({ projection: "artifact-safe" });
    expect(isDispositionGovernedType(TYPE)).toBe(true);
  });

  it("false for an installed data type that declares no disposition", () => {
    register(undefined);
    expect(isDispositionGovernedType(TYPE)).toBe(false);
  });

  it("false for an uninstalled / unregistered type", () => {
    expect(isDispositionGovernedType(TYPE)).toBe(false);
    expect(isDispositionGovernedType("@nobody/pkg:x")).toBe(false);
  });

  it("a governed 'none' type is still governed (the projector must skip it, not treat it as ungoverned)", () => {
    register({ projection: "none" });
    expect(isDispositionGovernedType(TYPE)).toBe(true);
    expect(resolveTypeProjectionDisposition(TYPE)).toBe("none");
  });
});
