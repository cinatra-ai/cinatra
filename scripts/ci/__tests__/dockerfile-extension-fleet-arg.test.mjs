// The image's extension-fleet build argument, pinned as a Dockerfile SHAPE test.
//
// Two roads have to stay true at once and neither is expressible as a unit test
// of a module:
//
//   1. the REQUIRED road (the default) is the road of today, unchanged — the
//      same three install/acquire lines in the same order, reading the same
//      required lock, with no flag and no new tool grafted onto them;
//   2. the DEV road exists, is selected ONLY by the `CINATRA_EXTENSION_FLEET`
//      argument, and materializes its fleet in the one window where it is
//      useful: AFTER the required acquisition and BEFORE the second frozen
//      install, so the OAS seed, the presence-aware manifest regeneration and
//      the bundled-digest record that follow all read the materialized set as
//      it is.
//
// The argument's NAME is asserted verbatim because a second, independent piece
// of tooling passes it (`--fleet dev` on the preview-instance commands); a
// rename on either side that this test did not see would leave the two halves
// unable to meet.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
const lines = dockerfile.split("\n");

const indexOfLine = (exact) => lines.findIndex((l) => l === exact);
const indicesOfLine = (exact) =>
  lines.reduce((acc, l, i) => (l === exact ? [...acc, i] : acc), /** @type {number[]} */ ([]));
const indexOfMatch = (re) => lines.findIndex((l) => re.test(l));

const FROZEN_INSTALL = "RUN pnpm install --frozen-lockfile";
const ACQUIRE_PROD = "RUN pnpm exec cinatra extensions acquire-prod";

describe("Dockerfile — the CINATRA_EXTENSION_FLEET build argument", () => {
  it("declares the argument by its exact agreed name, defaulting to the required set", () => {
    const declarations = lines.filter((l) => /^ARG\s+CINATRA_EXTENSION_FLEET\b/.test(l));
    expect(declarations).toEqual(["ARG CINATRA_EXTENSION_FLEET=required"]);
  });

  it("keeps the required road's three lines verbatim and in order", () => {
    const installs = indicesOfLine(FROZEN_INSTALL);
    expect(installs).toHaveLength(2);
    const acquire = indexOfLine(ACQUIRE_PROD);
    expect(acquire).toBeGreaterThan(-1);
    expect(installs[0]).toBeLessThan(acquire);
    expect(acquire).toBeLessThan(installs[1]);
  });

  it("never passes a fleet selector or an alternate lock to the required acquisition", () => {
    const acquireLines = lines.filter((l) => l.includes("extensions acquire-prod"));
    expect(acquireLines).toEqual([ACQUIRE_PROD]);
  });

  it("materializes the dev fleet AFTER the required acquisition and BEFORE the second frozen install", () => {
    const installs = indicesOfLine(FROZEN_INSTALL);
    const acquire = indexOfLine(ACQUIRE_PROD);
    const devStep = indexOfMatch(/^RUN\s+node\s+scripts\/extensions\/acquire-dev-fleet\.mjs\b/);
    expect(devStep).toBeGreaterThan(acquire);
    expect(devStep).toBeLessThan(installs[1]);
  });

  it("selects the dev road ONLY by the build argument", () => {
    const devStep = lines[indexOfMatch(/^RUN\s+node\s+scripts\/extensions\/acquire-dev-fleet\.mjs\b/)];
    expect(devStep).toContain("--fleet");
    expect(devStep).toContain("$CINATRA_EXTENSION_FLEET");
  });

  it("copies the dev lock in its own layer, after the required acquisition", () => {
    const copy = indexOfMatch(/^COPY\s+cinatra-dev-extensions\.lock\.json\b/);
    expect(copy).toBeGreaterThan(indexOfLine(ACQUIRE_PROD));
    expect(copy).toBeLessThan(indexOfMatch(/^RUN\s+node\s+scripts\/extensions\/acquire-dev-fleet\.mjs\b/));
    // The required road's own COPY layer never learns about the dev lock.
    const requiredCopy = lines.find((l) => l.includes("cinatra-required-extensions.lock.json") && l.startsWith("COPY"));
    expect(requiredCopy).toBeDefined();
    expect(requiredCopy).not.toContain("cinatra-dev-extensions.lock.json");
  });

  it("keeps git out of the build stage on BOTH roads", () => {
    expect(dockerfile).not.toMatch(/apk\s+add[^\n]*\bgit\b/);
  });

  it("lets the seed, the manifest regeneration and the digest record read the materialized set as it is", () => {
    const devStep = indexOfMatch(/^RUN\s+node\s+scripts\/extensions\/acquire-dev-fleet\.mjs\b/);
    expect(indexOfMatch(/build-required-oas-seed\.mjs/)).toBeGreaterThan(devStep);
    expect(indexOfMatch(/generate-extension-manifest\.mjs/)).toBeGreaterThan(devStep);
    expect(indexOfMatch(/record-bundled-digests\.mjs/)).toBeGreaterThan(devStep);
  });

  it("still bakes the OAS seed into the runtime stage (the road the packs ride to first boot)", () => {
    expect(dockerfile).toContain(
      "COPY --from=build /app/.cinatra-required-oas-seed ./.cinatra-required-oas-seed",
    );
  });

  it("says in the file itself that the dev road is never a real deployment's road", () => {
    const comments = lines.filter((l) => l.trimStart().startsWith("#")).join("\n");
    expect(comments).toMatch(/dev ROAD IS NEVER A REAL DEPLOYMENT'S ROAD/);
  });
});
