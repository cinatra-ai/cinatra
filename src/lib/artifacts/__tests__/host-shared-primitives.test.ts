/**
 * The HOST-SHARED DESIGN-PRIMITIVES module (cinatra#3471 slice 2, epic #2926 —
 * decision 407 of 2026-09-13: "the host shares its primitives with extension
 * bundles at run time like React does"):
 *  - the host serves EXACTLY the frozen export list, built from the product's
 *    own components under src/components/ui;
 *  - a bundle that leaves the id EXTERNAL resolves, through the shim, to the
 *    host's ONE instance — a second copy is never mounted;
 *  - a bundle built against a contract major the host does not serve fails
 *    closed with a NAMED error.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  DESIGN_PRIMITIVES_CONTRACT_MISMATCH,
  HOST_DESIGN_PRIMITIVES_CONTRACT_VERSION,
  HOST_DESIGN_PRIMITIVES_EXPORTS,
  HOST_DESIGN_PRIMITIVES_MODULE,
  missingDesignPrimitiveExports,
} from "@cinatra-ai/sdk-extensions/design-primitives-contract";
import { afterEach, describe, expect, it } from "vitest";

import {
  HOST_DESIGN_PRIMITIVES,
  HOST_DESIGN_PRIMITIVES_SERVED_VERSION,
} from "../host-shared-primitives";
import {
  _resetHostModuleRegistryForTests,
  assertDesignPrimitivesContractServed,
  assertSingleDesignPrimitivesIdentity,
  getHostModule,
  initHostModuleRegistry,
  isAllowedSharedSpecifier,
} from "../host-module-registry";

/** The sixteen product components the module is built from. */
const PRIMITIVE_FILES = [
  "alert",
  "badge",
  "button",
  "card",
  "checkbox",
  "dialog",
  "field",
  "input",
  "input-group",
  "label",
  "paginated-table",
  "pagination",
  "select",
  "separator",
  "table",
  "textarea",
];

function initWithHost() {
  initHostModuleRegistry({
    react: { __id: "host-react" },
    "react/jsx-runtime": { __id: "jsx-runtime" },
    "react-dom": { __id: "host-react-dom" },
    "react-dom/client": { __id: "react-dom-client" },
    designTokens: { __id: "design-tokens" },
    designPrimitives: HOST_DESIGN_PRIMITIVES,
  });
}

afterEach(() => _resetHostModuleRegistryForTests());

describe("the module serves EXACTLY the frozen export list", () => {
  it("carries every frozen export and nothing beyond the list", () => {
    expect(missingDesignPrimitiveExports(HOST_DESIGN_PRIMITIVES)).toEqual([]);
    expect(Object.keys(HOST_DESIGN_PRIMITIVES).sort()).toEqual(
      [...HOST_DESIGN_PRIMITIVES_EXPORTS].sort(),
    );
  });

  it("is frozen, so a renderer cannot mutate the host's shared surface", () => {
    expect(Object.isFrozen(HOST_DESIGN_PRIMITIVES)).toBe(true);
  });

  it("serves the declared contract version", () => {
    expect(HOST_DESIGN_PRIMITIVES_SERVED_VERSION).toBe(HOST_DESIGN_PRIMITIVES_CONTRACT_VERSION);
  });

  it("is built from the product's OWN components under src/components/ui", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/lib/artifacts/host-shared-primitives.ts"),
      "utf8",
    );
    for (const file of PRIMITIVE_FILES) {
      expect(source, `must re-export @/components/ui/${file}`).toContain(
        `from "@/components/ui/${file}"`,
      );
    }
    // No import may reach a vendored byte copy inside an extension subtree —
    // the whole point of decision 407 is that the host's own files are the
    // single instance.
    expect(source).not.toMatch(/from "[^"]*\/extensions\/[^"]*"/);
    expect(source).not.toMatch(/from "\.[^"]*\/ui\/[^"]*"/);
  });
});

describe("a bundle leaving the id external resolves to the host's instance", () => {
  it("the shim serves the id from the closed allowlist", () => {
    expect(isAllowedSharedSpecifier(HOST_DESIGN_PRIMITIVES_MODULE)).toBe(true);
  });

  it("resolves to the EXACT host object (reference identity, not a copy)", () => {
    initWithHost();
    const resolved = getHostModule(HOST_DESIGN_PRIMITIVES_MODULE);
    expect(resolved).toBe(HOST_DESIGN_PRIMITIVES);
    // Component identity, not only module identity.
    expect((resolved as Record<string, unknown>).Button).toBe(HOST_DESIGN_PRIMITIVES.Button);
  });

  it("a SECOND copy is never mounted — the identity assertion throws on one", () => {
    initWithHost();
    expect(assertSingleDesignPrimitivesIdentity(HOST_DESIGN_PRIMITIVES)).toBe(
      HOST_DESIGN_PRIMITIVES,
    );
    // A SECOND COPY is a second set of COMPONENTS — what a package that bundled
    // its own `src/components/ui` byte copies would mount. A spread of the host
    // barrel is NOT that: its members are the host's own components, exactly what
    // the façade's ESM namespace re-export looks like, and it is one copy.
    const secondCopy = { ...HOST_DESIGN_PRIMITIVES, Button: () => null };
    expect(() => assertSingleDesignPrimitivesIdentity(secondCopy)).toThrow(
      /a second copy of the design primitives was mounted/,
    );
  });

  it("accepts the façade's NAMESPACE re-export (same components, a new wrapper)", () => {
    initWithHost();
    // `import * as p from "@cinatra-ai/design-primitives"` gives the renderer a
    // fresh namespace object over the host's registered module — one copy, not
    // two, so the identity assertion must NOT refuse it.
    const facadeNamespace = { ...HOST_DESIGN_PRIMITIVES };
    expect(assertSingleDesignPrimitivesIdentity(facadeNamespace)).toBe(HOST_DESIGN_PRIMITIVES);
  });

  it("refuses the identity check before the shim is initialized", () => {
    expect(() => assertSingleDesignPrimitivesIdentity(HOST_DESIGN_PRIMITIVES)).toThrow(
      /before the shim was initialized/,
    );
  });
});

describe("the contract version is checked at bundle load", () => {
  it("admits a bundle built against the major the host serves", () => {
    expect(() =>
      assertDesignPrimitivesContractServed(HOST_DESIGN_PRIMITIVES_CONTRACT_VERSION),
    ).not.toThrow();
  });

  it("FAILS CLOSED with a NAMED error on a major the host does not serve", () => {
    let caught: unknown;
    try {
      assertDesignPrimitivesContractServed("2.0.0");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe(DESIGN_PRIMITIVES_CONTRACT_MISMATCH);
    expect((caught as Error).message).toMatch(/rebuild the bundle against the host's contract/);
  });

  it("FAILS CLOSED on an unreadable declared version", () => {
    expect(() => assertDesignPrimitivesContractServed("^1.0.0")).toThrow(/unreadable/);
  });
});
