/**
 * REAL-DOCKER promotion rebuild battery — epic #1705 AC5, the clause
 * "promotion produces a rebuilt cached env".
 *
 * Real daemon, real L0 base image, real `pip install` from the real index, real
 * content-addressed layer cache. No scripted CLI double anywhere: the audit on
 * #1705 asked for this property on the real-Docker tier precisely because a
 * double can make cache identity look right while the built bytes are fiction.
 *
 * The walk:
 *   1. an agent's declared environment builds and caches (cache MISS);
 *   2. observed ad-hoc L2 installs produce ONE promotion candidate, and the
 *      human-approved proposal (`applyPromotion`) is the new declaration;
 *   3. the promoted declaration MISSES the cache and REBUILDS — a different
 *      recipe key over a different image, and the promoted package is importable
 *      inside the rebuilt layer while it is absent from the pre-promotion one;
 *   4. a second same-recipe agent HITS the rebuilt layer (no third build), and
 *      the pre-promotion layer is untouched.
 *
 * SCOPE. Build egress runs over the explicit local-dev escape hatch
 * (`allowInsecureLocalDevNetwork`), not the attributing gateway — the gateway
 * build posture is a separate contract with its own coverage, and the hatch is
 * a DISTINCT cache identity (`insecure-open-network`) that can never alias a
 * gateway-built layer. What is under test here is the promotion → rebuild →
 * cache-hit identity, end to end, on real bytes.
 *
 * NOT under test (it does not exist): the observation PRODUCER. No product code
 * records a run's ad-hoc installs — `src/lib/execution/agent-execution-config-load.ts`
 * defaults `readObservations` to `noObservations()` — so step 2's observations
 * are supplied here exactly as that injected seam would supply them. See the
 * AC5 disposition on #1705.
 *
 * Run with: pnpm test:e2e   (package: @cinatra-ai/execution-plane)
 * First run builds docker/sandbox/Dockerfile as cinatra-sandbox-l0:dev.
 * FAILS (never skips) when docker is unavailable.
 */
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runDocker, type DockerCli } from "../../docker-cli";
import { SANDBOX_RUNTIME_GID, SANDBOX_RUNTIME_UID } from "../../l0-profile";
import { EnvironmentLayerCache } from "../../environment/cache";
import { TrustedEnvironmentBuilder } from "../../environment/builder";
import {
  applyPromotion,
  computePromotionCandidates,
  type ObservedAdhocInstall,
} from "../../environment/promotion";

const IMAGE = "cinatra-sandbox-l0:dev";
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../..",
);

/** Pinned, tiny, pure-python wheels — the build is about identity, not payload. */
const DECLARED = { pip: ["six==1.16.0"] };
/** BARE identifier: that is what an observed ad-hoc install carries
 *  (`ObservedAdhocInstall.packageName` is documented as the bare id, no version
 *  constraint), and therefore what a promotion declares. */
const PROMOTED_PACKAGE = "tabulate";

/** `tabulate` on 6 of the last 10 runs (clears the 50% default); `rich` on 4. */
const OBSERVED: ObservedAdhocInstall[] = [
  ...Array.from({ length: 6 }, (_, i) => ({
    runId: `run-${i}`,
    manager: "pip" as const,
    packageName: PROMOTED_PACKAGE,
  })),
  ...Array.from({ length: 4 }, (_, i) => ({
    runId: `run-${i + 6}`,
    manager: "pip" as const,
    packageName: "rich",
  })),
];

const builtImages: string[] = [];

/** Counts real `docker build` invocations — the daemon is real, the seam only
 *  tallies, so "no further build" is asserted on what actually ran. */
let dockerBuilds = 0;
const countingDocker: DockerCli = async (args, opts) => {
  if (args[0] === "build") dockerBuilds += 1;
  return runDocker(args, opts);
};

function makeBuilder(cache: EnvironmentLayerCache) {
  return new TrustedEnvironmentBuilder({
    cache,
    provenanceKey: "e2e-promotion-provenance-key",
    docker: countingDocker,
    l0ImageRef: IMAGE,
    platform: { os: "linux", arch: process.arch === "x64" ? "amd64" : "arm64" },
    allowInsecureLocalDevNetwork: true,
    buildTimeoutMs: 240_000,
  });
}

/** Can this layer import the module, running as the fixed unprivileged UID? */
async function canImport(imageRef: string, module: string): Promise<boolean> {
  const outcome = await runDocker([
    "run", "--rm", "--network", "none",
    "--user", `${SANDBOX_RUNTIME_UID}:${SANDBOX_RUNTIME_GID}`,
    "--", imageRef, "python3", "-c", `import ${module}`,
  ]);
  return outcome.exitCode === 0;
}

beforeAll(async () => {
  // Docker must be present — the battery never skips (no stub-smoke).
  execFileSync("docker", ["info"], { stdio: "ignore" });
  execFileSync("docker", ["build", "-t", IMAGE, "docker/sandbox"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    timeout: 280_000,
  });
}, 300_000);

afterAll(async () => {
  for (const ref of builtImages) await runDocker(["rmi", "-f", ref]);
}, 120_000);

describe("promotion produces a rebuilt cached env — real docker (epic #1705 AC5)", () => {
  it("rebuilds on the approved promotion, materializes the promoted package, then serves it from cache", async () => {
    const cache = new EnvironmentLayerCache({ provenanceKey: "e2e-promotion-provenance-key" });
    const builder = makeBuilder(cache);

    // ---- 1. pre-promotion steady state: a real build -----------------------
    const before = await builder.ensureEnvironmentLayer({ raw: DECLARED, orgId: "org-a" });
    expect(before.kind).toBe("ready");
    if (before.kind !== "ready") return;
    expect(before.cacheHit).toBe(false);
    builtImages.push(before.entry.imageRef);
    expect(await canImport(before.entry.imageRef, "six")).toBe(true);
    // The promoted package is genuinely ABSENT before the promotion — without
    // this the rebuild proof below would be unfalsifiable.
    expect(await canImport(before.entry.imageRef, "tabulate")).toBe(false);

    // ---- 2. the affordance: observations → candidate → approved proposal ---
    const candidates = computePromotionCandidates(OBSERVED, DECLARED);
    expect(candidates).toEqual([
      { manager: "pip", packageName: PROMOTED_PACKAGE, runCount: 6, windowRuns: 10 },
    ]);
    const proposal = applyPromotion(DECLARED, candidates[0]!);
    expect(proposal.after.pip).toEqual(["six==1.16.0", PROMOTED_PACKAGE]);

    // ---- 3. the promotion REBUILDS (cache miss) ----------------------------
    const after = await builder.ensureEnvironmentLayer({
      raw: proposal.after,
      orgId: "org-a",
    });
    expect(after.kind).toBe("ready");
    if (after.kind !== "ready") return;
    expect(after.cacheHit).toBe(false);
    builtImages.push(after.entry.imageRef);
    expect(after.entry.recipeKey).not.toBe(before.entry.recipeKey);
    expect(after.entry.imageDigest).not.toBe(before.entry.imageDigest);
    // Real bytes: the rebuilt layer carries the promoted package…
    expect(await canImport(after.entry.imageRef, "tabulate")).toBe(true);
    expect(await canImport(after.entry.imageRef, "six")).toBe(true);
    // …and the resolution the recipe key binds actually changed with it.
    expect(after.entry.provenance.recipe.spec.pip).toContain(PROMOTED_PACKAGE);
    expect(after.entry.provenance.recipe.resolvedArtifacts.pip!.resolved).not.toBe(
      before.entry.provenance.recipe.resolvedArtifacts.pip!.resolved,
    );

    // ---- 4. the rebuild IS the cached env ---------------------------------
    // A second agent declaring the promoted set mounts the same layer with no
    // further build — assert on the daemon, not just on the return value: the
    // image id is unchanged and no new L1 image appeared.
    const buildsBeforeSecondAgent = dockerBuilds;
    const second = await builder.ensureEnvironmentLayer({
      raw: { pip: ["six==1.16.0", PROMOTED_PACKAGE] },
      orgId: "org-b",
    });
    expect(second.kind).toBe("ready");
    if (second.kind !== "ready") return;
    expect(second.cacheHit).toBe(true);
    expect(second.entry.recipeKey).toBe(after.entry.recipeKey);
    expect(second.entry.imageDigest).toBe(after.entry.imageDigest);
    expect(dockerBuilds).toBe(buildsBeforeSecondAgent);

    // …and the pre-promotion layer is untouched: an agent that did not take the
    // promotion still hits ITS layer rather than rebuilding.
    const unpromoted = await builder.ensureEnvironmentLayer({ raw: DECLARED, orgId: "org-c" });
    expect(unpromoted.kind === "ready" && unpromoted.cacheHit).toBe(true);
    expect(unpromoted.kind === "ready" && unpromoted.entry.imageDigest).toBe(
      before.entry.imageDigest,
    );
  }, 600_000);
});
