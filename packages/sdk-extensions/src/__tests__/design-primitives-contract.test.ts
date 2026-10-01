/**
 * The HOST-SHARED DESIGN-PRIMITIVES contract (cinatra#3471 slice 2, epic #2926 —
 * decision 407 of 2026-09-13): the host-neutral module id declared in the SDK
 * leaf next to the React allowlist, the frozen export list it serves, the
 * versioned contract, and the load-time fail-closed major check. Pure; no DOM.
 */
import { describe, expect, it } from "vitest";

import {
  CLIENT_BUNDLE_EXTERNAL_ALLOWLIST,
  checkClientBundleExternals,
  isAllowedClientBundleExternal,
} from "../artifact-client-bundle";
import {
  DESIGN_PRIMITIVES_CONTRACT_MISMATCH,
  HOST_DESIGN_PRIMITIVES_CONTRACT_MAJOR,
  HOST_DESIGN_PRIMITIVES_CONTRACT_VERSION,
  HOST_DESIGN_PRIMITIVES_EXPORTS,
  HOST_DESIGN_PRIMITIVES_MODULE,
  checkDesignPrimitivesContract,
  designPrimitivesContractMajorOf,
  isHostDesignPrimitivesModule,
  missingDesignPrimitiveExports,
} from "../design-primitives-contract";

/** The sixteen product components the border floor records as byte copies, each
 * anchored by an export only that component provides. */
const PRIMITIVE_ANCHORS: ReadonlyArray<[string, string]> = [
  ["alert", "Alert"],
  ["badge", "Badge"],
  ["button", "Button"],
  ["card", "Card"],
  ["checkbox", "Checkbox"],
  ["dialog", "Dialog"],
  ["field", "Field"],
  ["input", "Input"],
  ["input-group", "InputGroup"],
  ["label", "Label"],
  ["paginated-table", "PaginatedTable"],
  ["pagination", "Pagination"],
  ["select", "Select"],
  ["separator", "Separator"],
  ["table", "Table"],
  ["textarea", "Textarea"],
];

describe("the shared primitives module id", () => {
  it("is host-neutral and follows the design registry's own package naming", () => {
    expect(HOST_DESIGN_PRIMITIVES_MODULE).toBe("@cinatra-ai/design-primitives");
    // Never a product-internal path — that coupling is what decision 407 removes.
    expect(HOST_DESIGN_PRIMITIVES_MODULE.startsWith("@/")).toBe(false);
    expect(HOST_DESIGN_PRIMITIVES_MODULE.startsWith("@cinatra-ai/")).toBe(true);
  });

  it("carries a versioned contract whose MAJOR is the declared one", () => {
    expect(HOST_DESIGN_PRIMITIVES_CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(designPrimitivesContractMajorOf(HOST_DESIGN_PRIMITIVES_CONTRACT_VERSION)).toBe(
      HOST_DESIGN_PRIMITIVES_CONTRACT_MAJOR,
    );
  });
});

describe("the FROZEN export list", () => {
  it("is frozen, non-empty and free of duplicates", () => {
    expect(Object.isFrozen(HOST_DESIGN_PRIMITIVES_EXPORTS)).toBe(true);
    expect(HOST_DESIGN_PRIMITIVES_EXPORTS.length).toBeGreaterThan(0);
    expect(new Set(HOST_DESIGN_PRIMITIVES_EXPORTS).size).toBe(
      HOST_DESIGN_PRIMITIVES_EXPORTS.length,
    );
  });

  it("names an export of every primitive the border floor records", () => {
    for (const [primitive, anchor] of PRIMITIVE_ANCHORS) {
      expect(
        (HOST_DESIGN_PRIMITIVES_EXPORTS as readonly string[]).includes(anchor),
        `the frozen list must carry ${anchor} (src/components/ui/${primitive}.tsx)`,
      ).toBe(true);
    }
  });

  it("names no export of a component the host does not own", () => {
    // external-link / link / text-link appear in the border floor but are the
    // extensions' OWN components — there is no src/components/ui file for them,
    // so the host cannot serve them.
    for (const absent of ["Link", "TextLink", "ExternalLink"]) {
      expect((HOST_DESIGN_PRIMITIVES_EXPORTS as readonly string[]).includes(absent)).toBe(false);
    }
  });
});

describe("the externals allowlist admits the id", () => {
  it("sanctions the primitives module exactly like React and the token module", () => {
    expect(CLIENT_BUNDLE_EXTERNAL_ALLOWLIST).toContain(HOST_DESIGN_PRIMITIVES_MODULE);
    expect(isAllowedClientBundleExternal(HOST_DESIGN_PRIMITIVES_MODULE)).toBe(true);
  });

  it("accepts a bundle that leaves ONLY host peers external, primitives included", () => {
    expect(
      checkClientBundleExternals({
        externals: ["react", "react/jsx-runtime", HOST_DESIGN_PRIMITIVES_MODULE],
        inputBasePackages: ["@cinatra-ai/json-artifact"],
      }),
    ).toBeNull();
  });

  it("keeps the EXACT-tuple discipline — a near-miss specifier is still refused", () => {
    for (const nearMiss of [
      "@cinatra-ai/design-primitives/button",
      "@cinatra-ai/design-primitive",
      "design-primitives",
    ]) {
      expect(isAllowedClientBundleExternal(nearMiss)).toBe(false);
      expect(
        checkClientBundleExternals({ externals: [nearMiss], inputBasePackages: [] }),
      ).toMatch(/un-sanctioned external/);
    }
  });
});

describe("the load-time contract check fails closed", () => {
  it("passes a bundle built against the major the host serves", () => {
    expect(
      checkDesignPrimitivesContract({ builtAgainst: HOST_DESIGN_PRIMITIVES_CONTRACT_VERSION }),
    ).toBeNull();
    // A MINOR/PATCH ahead or behind inside the same major is still served.
    expect(checkDesignPrimitivesContract({ builtAgainst: "1.4.2" })).toBeNull();
  });

  it("REFUSES a bundle built against a major the host does not serve", () => {
    const refusal = checkDesignPrimitivesContract({ builtAgainst: "2.0.0" });
    expect(refusal).toMatch(/contract major 2 \(2\.0\.0\) but this host serves major 1/);
  });

  it("REFUSES an unreadable version on either side (never treated as compatible)", () => {
    expect(checkDesignPrimitivesContract({ builtAgainst: "^1.0.0" })).toMatch(/unreadable/);
    expect(checkDesignPrimitivesContract({ builtAgainst: "" })).toMatch(/unreadable/);
    expect(
      checkDesignPrimitivesContract({ builtAgainst: "1.0.0", hostServes: "next" }),
    ).toMatch(/the host declares an unreadable/);
    expect(designPrimitivesContractMajorOf("1.0")).toBeNull();
  });

  it("names the refusal so a caller matches on a name, not on prose", () => {
    expect(DESIGN_PRIMITIVES_CONTRACT_MISMATCH).toBe("DesignPrimitivesContractMajorMismatch");
  });
});

describe("the typed contract shape", () => {
  it("reports every missing export of a partial module, in frozen-list order", () => {
    const partial: Record<string, unknown> = {};
    for (const name of HOST_DESIGN_PRIMITIVES_EXPORTS) partial[name] = () => null;
    delete partial.Button;
    delete partial.Textarea;
    expect(missingDesignPrimitiveExports(partial)).toEqual(["Button", "Textarea"]);
    expect(isHostDesignPrimitivesModule(partial)).toBe(false);
  });

  it("accepts a module carrying the whole frozen list", () => {
    const whole: Record<string, unknown> = {};
    for (const name of HOST_DESIGN_PRIMITIVES_EXPORTS) whole[name] = () => null;
    expect(missingDesignPrimitiveExports(whole)).toEqual([]);
    expect(isHostDesignPrimitivesModule(whole)).toBe(true);
  });

  it("treats a non-object as missing everything (fail-closed)", () => {
    expect(missingDesignPrimitiveExports(null)).toEqual([...HOST_DESIGN_PRIMITIVES_EXPORTS]);
    expect(isHostDesignPrimitivesModule(undefined)).toBe(false);
  });
});
