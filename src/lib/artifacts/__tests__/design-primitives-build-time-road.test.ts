/**
 * The BUILD-TIME road for the host-shared design primitives (cinatra#3512,
 * slice 2b of #3471, epic #2926 — decision 407 of 2026-09-13).
 *
 * Slice 2 built the RUN-TIME road: a dynamically loaded renderer leaves
 * `@cinatra-ai/design-primitives` external and the host module registry resolves
 * it. Most self-rendering packages are not loaded that way — a connector's setup
 * page and an artifact package's server parts are compiled FROM SOURCE into the
 * host build through the tsconfig path map. This suite pins the road they take:
 *
 *  - the bare id RESOLVES in the host's own compiler/bundler resolution, and
 *  - what it serves is the host's ONE instance, per export — never a copy, and
 *  - the served surface is EXACTLY the frozen export list.
 */
import {
  HOST_DESIGN_PRIMITIVES_EXPORTS,
  missingDesignPrimitiveExports,
} from "@cinatra-ai/sdk-extensions/design-primitives-contract";
import { describe, expect, it } from "vitest";

// THE IMPORT UNDER TEST — the bare, virtual module id written exactly as a
// source-compiled package writes it, resolved exactly as the host build
// resolves it: through `compilerOptions.paths` in the root tsconfig (vitest
// reads that map, `resolve.tsconfigPaths: true`). On a head without the
// build-time path this specifier resolves to nothing and the whole file fails
// to collect — that is this suite's red.
import * as servedByTheBuildTimeRoad from "@cinatra-ai/design-primitives";

import {
  HOST_DESIGN_PRIMITIVES,
  HOST_DESIGN_PRIMITIVES_SERVED_VERSION,
} from "../host-shared-primitives";
import { FIXTURE_IMPORTED_PRIMITIVES } from "../../../../tests/fixtures/design-primitives-build-time-import";

/**
 * The two HOST-SIDE constants the module already exported on the run-time road
 * (they are the host runtime's door onto the frozen object and the served
 * contract version, read by `src/lib/artifacts/host-module-registry.ts`'s
 * callers and by the slice-2 suite). Everything else the module exports must be
 * a primitive on the frozen list.
 */
const HOST_SIDE_CONSTANTS = ["HOST_DESIGN_PRIMITIVES", "HOST_DESIGN_PRIMITIVES_SERVED_VERSION"];

const served = servedByTheBuildTimeRoad as unknown as Record<string, unknown>;
const hostInstance = HOST_DESIGN_PRIMITIVES as unknown as Record<string, unknown>;

describe("the id resolves at BUILD time for a source-compiled package", () => {
  it("hands back the HOST's own binding for every export on the frozen list", () => {
    for (const name of HOST_DESIGN_PRIMITIVES_EXPORTS) {
      expect(served[name], `${name} must be the host's own binding, not a copy`).toBe(
        hostInstance[name],
      );
    }
  });

  it("is the same module as src/lib/artifacts/host-shared-primitives.ts", () => {
    expect(served.HOST_DESIGN_PRIMITIVES).toBe(HOST_DESIGN_PRIMITIVES);
    expect(served.HOST_DESIGN_PRIMITIVES_SERVED_VERSION).toBe(
      HOST_DESIGN_PRIMITIVES_SERVED_VERSION,
    );
  });

  it("a fixture package's own `import { Alert } from \"@cinatra-ai/design-primitives\"` gets that instance", () => {
    // The fixture is a separate compilation unit that writes the import the way
    // a connector setup page writes it; it must land on the same objects.
    const imported = FIXTURE_IMPORTED_PRIMITIVES as unknown as Record<string, unknown>;
    expect(Object.keys(imported).length).toBeGreaterThan(0);
    for (const [name, value] of Object.entries(imported)) {
      expect(value, `the fixture's ${name} must be the host's own binding`).toBe(
        hostInstance[name],
      );
    }
  });
});

describe("the served module carries EXACTLY the frozen export list", () => {
  it("misses no name on the list", () => {
    expect(missingDesignPrimitiveExports(servedByTheBuildTimeRoad)).toEqual([]);
  });

  it("carries nothing beyond the list but the two host-side constants", () => {
    expect(Object.keys(servedByTheBuildTimeRoad).sort()).toEqual(
      [...HOST_DESIGN_PRIMITIVES_EXPORTS, ...HOST_SIDE_CONSTANTS].sort(),
    );
  });

  it("serves each name as a defined value (a package never reads undefined off it)", () => {
    for (const name of HOST_DESIGN_PRIMITIVES_EXPORTS) {
      expect(served[name], `${name} must not be undefined`).toBeDefined();
    }
  });
});
