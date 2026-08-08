// #2481. `packages/sdk-extensions` declared `zod: "^4.0.0"` in
// `peerDependencies` while its own `ExtensionStandardSchema` (in
// `mcp-connector-contract.ts`) requires the `~standard.jsonSchema` member
// that only exists from zod **4.2** onward — the declared range was looser
// than the contract the package itself defines.
//
// Measured directly (not inferred from release notes), the same way
// drupal-mcp-connector#84 first surfaced this: `tsc` against real zod
// releases with `ExtensionStandardSchema` as the assignment target.
//
//   zod 4.0.0  -> TS2322 ("Property 'jsonSchema' is missing")
//   zod 4.1.12 -> TS2322 (same)
//   zod 4.2.0  -> clean
//
// `devDependencies` carries `zod-4-2-0-floor` (an `npm:zod@4.2.0` alias) SO
// THIS FILE type-checks against the exact floor, independent of whatever the
// host's own `zod` range floats to over time (today `^4.4.3`, resolving
// `4.4.3`). Aliasing rather than bumping the package's own `zod` also means
// every other `zod`-importing file in this package keeps resolving the
// regular, current copy — only this regression lock is pinned old.
//
// The `const` assignment below is a real COMPILE proof: it participates in
// the monorepo's wholesale `tsc`/`tsgo` typecheck exactly like the other
// `-contract.test.ts` compile-proofs in this directory, so a future change
// that re-loosens the peer range, or that widens `ExtensionStandardSchema`
// past what 4.2.0 exposes, reds the build here — not silently, behind
// whatever newer zod happens to be hoisted at the time. The `it()` blocks
// below are a runtime smoke of the same claim (manifest tripwire + a real
// `jsonSchema` conversion, not just a type-shape check).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { z as zFloor } from "zod-4-2-0-floor";

import type { ExtensionStandardSchema } from "../mcp-connector-contract";

// COMPILE PROOF: a real schema built with the exactly-pinned zod@4.2.0 floor
// satisfies `ExtensionStandardSchema`. This is the assignment
// `mcp-connector-contract.ts` promises works for "Zod v4 / Valibot /
// ArkType" — exercised here at the declared floor version specifically.
const floorSchema = zFloor.object({ foo: zFloor.string() });
const floorAssigned: ExtensionStandardSchema = floorSchema;
void floorAssigned;

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
) as { peerDependencies?: Record<string, string> };

describe("zod peer range meets the measured ExtensionStandardSchema type floor (#2481)", () => {
  it("declares the peer range at the measured floor, not looser", () => {
    // Exact equality on purpose: a looser assertion would re-admit `^4.0.0`,
    // which resolves fine at runtime but stops any consumer that assigns a
    // real zod schema to `ExtensionStandardSchema` from typechecking.
    expect(manifest.peerDependencies?.zod).toBe("^4.2.0");
  });

  it("resolves the pinned floor alias to exactly 4.2.0", () => {
    // Tripwire on the alias itself: if `zod-4-2-0-floor` ever drifts off
    // 4.2.0 (a typo'd bump, a `^` accidentally added to the alias spec), the
    // compile proof above would silently stop proving the FLOOR and start
    // proving whatever newer version snuck in instead.
    expect(zFloor.core.version).toEqual({ major: 4, minor: 2, patch: 0 });
  });

  it("the floor-pinned schema's jsonSchema converter actually runs, not just type-satisfies", () => {
    // Behavioral, not just structural: calling the real `~standard.jsonSchema`
    // converter proves 4.2.0 doesn't just have a `jsonSchema` property of the
    // right shape, it has one that WORKS.
    const out = floorSchema["~standard"].jsonSchema.output({ target: "draft-2020-12" });
    expect(out).toMatchObject({
      type: "object",
      properties: { foo: { type: "string" } },
      required: ["foo"],
    });
  });
});
