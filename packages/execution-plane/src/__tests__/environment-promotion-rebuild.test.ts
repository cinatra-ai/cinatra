/**
 * "Promotion produces a rebuilt cached env" — epic #1705 AC5's last clause,
 * executed rather than argued.
 *
 * `promotion.ts`'s docblock states the property "falls out of cache identity".
 * That is a claim about a composition nobody had ever run: observed ad-hoc L2
 * installs → `computePromotionCandidates` → `applyPromotion` → the trusted
 * builder → the layer cache. Each half is covered on its own
 * (`environment-promotion.test.ts` for the candidate maths,
 * `environment-builder.test.ts` for build-once/cache-hit); the JOIN — that an
 * approved promotion actually forces a REBUILD, that the rebuild is what later
 * same-recipe agents then HIT, and that it does not clobber the layer an
 * unpromoted agent still mounts — is what this file proves.
 *
 * The docker seam is a RESOLVING double: it reads the Dockerfile the builder
 * actually rendered and answers the lock/integrity extraction from the packages
 * that Dockerfile installs, so a promoted spec resolves a different artifact set
 * rather than a constant that would make the key comparison vacuous. It is a
 * control-flow and cache-identity model ONLY — it fabricates image ids and
 * manifests, and proves nothing about built bytes. The real-daemon arm, which
 * builds over the real L0 image and imports the promoted package inside the
 * rebuilt layer, is `e2e/environment-promotion-rebuild.e2e.test.ts`.
 *
 * NOT covered here (and not coverable): the OBSERVATION PRODUCER. Nothing in
 * the product records a run's ad-hoc installs yet — `agent-execution-config-load.ts`
 * defaults `readObservations` to `noObservations()` — so the observations below
 * are the test's own input, exactly as the app's injected seam would supply
 * them. See the AC5 disposition on #1705.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { DockerCli, DockerRunOutcome } from "../docker-cli";
import { EnvironmentLayerCache } from "../environment/cache";
import { TrustedEnvironmentBuilder } from "../environment/builder";
import {
  applyPromotion,
  computePromotionCandidates,
  type ObservedAdhocInstall,
} from "../environment/promotion";

const ok = (stdout = ""): DockerRunOutcome => ({
  exitCode: 0,
  stdout,
  stderr: "",
  stdioOverflow: false,
  timedOut: false,
});

const bare = (entry: string) => entry.split(/[=<>~!\[]/, 1)[0]!;

/**
 * Scripted docker CLI that RESOLVES: on `build` it parses the rendered
 * Dockerfile for the pip set and remembers it under the build's unique temp
 * tag; the later lock/integrity extraction answers from that set. A promoted
 * spec therefore freezes different resolved artifacts than its predecessor —
 * the same asymmetry a real `pip install --report` would produce — instead of
 * a constant that would make the recipe-key comparison vacuous.
 */
function resolvingDocker() {
  const calls: string[][] = [];
  const pipByTag = new Map<string, string[]>();

  const cli: DockerCli = async (args) => {
    calls.push(args);
    if (args[0] === "image" && args[1] === "inspect") {
      const ref = args[args.length - 1]!;
      const pkgs = pipByTag.get(ref);
      // Distinct image identity per built layer; the L0 base is constant.
      return ok(pkgs ? `sha256:img-${pkgs.map(bare).join("+")}` : "sha256:l0base");
    }
    if (args[0] === "build") {
      const tag = args[args.indexOf("--tag") + 1]!;
      const dockerfile = readFileSync(args[args.indexOf("--file") + 1]!, "utf8");
      const line = dockerfile.split("\n").find((l) => l.includes("pip install")) ?? "";
      const between = line.slice(
        line.indexOf("pip.report.json") + "pip.report.json".length,
        line.indexOf("&& pip freeze"),
      );
      const pkgs = between
        .split(/\s+/)
        .map((t) => t.replace(/'/g, "").trim())
        .filter(Boolean);
      pipByTag.set(tag, pkgs);
      return ok();
    }
    if (args[0] === "run") {
      const path = args[args.length - 1]!;
      const tag = args[args.length - 3]!;
      const pkgs = pipByTag.get(tag) ?? [];
      return ok(
        path.endsWith(".integrity")
          ? pkgs.map((p) => `${bare(p)}==1.0.0 sha256:${bare(p)}-bytes`).join("\n") + "\n"
          : pkgs.map((p) => `${bare(p)}==1.0.0`).join("\n") + "\n",
      );
    }
    if (args[0] === "tag" || args[0] === "rmi") return ok();
    return ok();
  };
  return { cli, calls, pipByTag };
}

function makeStack() {
  const docker = resolvingDocker();
  const cache = new EnvironmentLayerCache({ provenanceKey: "promotion-pk" });
  const builder = new TrustedEnvironmentBuilder({
    cache,
    provenanceKey: "promotion-pk",
    docker: docker.cli,
    l0ImageRef: "cinatra-sandbox-l0:dev",
    platform: { os: "linux", arch: "arm64" },
    allowInsecureLocalDevNetwork: true,
  });
  const builds = () => docker.calls.filter((c) => c[0] === "build").length;
  return { builder, cache, docker, builds };
}

/** The declared recipe BEFORE the promotion — one agent, one pinned package. */
const DECLARED = { pip: ["six==1.16.0"] };

/**
 * What an observation producer would feed the affordance: `tabulate` installed
 * ad hoc on 6 of the last 10 runs (clears the 50% default), `rich` on 4 (does
 * not).
 */
const OBSERVED: ObservedAdhocInstall[] = [
  ...Array.from({ length: 6 }, (_, i) => ({
    runId: `run-${i}`,
    manager: "pip" as const,
    packageName: "tabulate",
  })),
  ...Array.from({ length: 4 }, (_, i) => ({
    runId: `run-${i + 6}`,
    manager: "pip" as const,
    packageName: "rich",
  })),
];

describe("promotion produces a rebuilt cached env (epic #1705 AC5)", () => {
  it("an APPROVED promotion busts the recipe and forces a real rebuild — which later same-recipe agents then HIT", async () => {
    const { builder, builds } = makeStack();

    // 1. The agent's declared environment is built and cached (the pre-promotion
    //    steady state).
    const before = await builder.ensureEnvironmentLayer({ raw: DECLARED, orgId: "org-a" });
    expect(before.kind).toBe("ready");
    if (before.kind !== "ready") return;
    expect(before.cacheHit).toBe(false);
    expect(builds()).toBe(1);

    // 2. The affordance's data layer turns observed ad-hoc installs into ONE
    //    candidate, and the human-approved proposal is the new declaration.
    const candidates = computePromotionCandidates(OBSERVED, DECLARED);
    expect(candidates).toEqual([
      { manager: "pip", packageName: "tabulate", runCount: 6, windowRuns: 10 },
    ]);
    const proposal = applyPromotion(DECLARED, candidates[0]!);
    expect(proposal.after.pip).toEqual(["six==1.16.0", "tabulate"]);
    // PURE: the reviewed `before` is the untouched input, so the review surface
    // diffs a real pair.
    expect(proposal.before).toEqual(DECLARED);

    // 3. The promoted declaration MISSES the cache — it is a rebuild, never an
    //    alias onto the pre-promotion layer.
    const after = await builder.ensureEnvironmentLayer({
      raw: proposal.after,
      orgId: "org-a",
    });
    expect(after.kind).toBe("ready");
    if (after.kind !== "ready") return;
    expect(after.cacheHit).toBe(false);
    expect(builds()).toBe(2);
    expect(after.entry.recipeKey).not.toBe(before.entry.recipeKey);
    expect(after.entry.specKey).not.toBe(before.entry.specKey);
    expect(after.entry.imageDigest).not.toBe(before.entry.imageDigest);

    // The promoted package is bound into the layer's IDENTITY: it is in the
    // signed recipe, and the frozen artifact resolution moved with it. (That the
    // built BYTES actually contain it is not something a scripted daemon can
    // show — the real-docker sibling imports the package inside the rebuilt
    // image to prove that half.)
    expect(after.entry.provenance.recipe.spec.pip).toContain("tabulate");
    expect(after.entry.provenance.recipe.resolvedArtifacts.pip!.resolved).not.toBe(
      before.entry.provenance.recipe.resolvedArtifacts.pip!.resolved,
    );

    // 4. …and the rebuild is now the CACHED env: a second agent (another org,
    //    instance-shared partition) declaring the promoted set mounts it with
    //    no further build.
    const secondAgent = await builder.ensureEnvironmentLayer({
      raw: { pip: ["six==1.16.0", "tabulate"] },
      orgId: "org-b",
    });
    expect(secondAgent.kind === "ready" && secondAgent.cacheHit).toBe(true);
    expect(secondAgent.kind === "ready" && secondAgent.entry.recipeKey).toBe(
      after.entry.recipeKey,
    );
    expect(builds()).toBe(2);
  });

  it("the rebuild is ADDITIVE — an agent that did not take the promotion keeps hitting its own layer", async () => {
    const { builder, builds } = makeStack();
    const before = await builder.ensureEnvironmentLayer({ raw: DECLARED, orgId: "org-a" });
    const proposal = applyPromotion(DECLARED, computePromotionCandidates(OBSERVED, DECLARED)[0]!);
    await builder.ensureEnvironmentLayer({ raw: proposal.after, orgId: "org-a" });
    expect(builds()).toBe(2);

    // The unpromoted declaration still resolves to ITS layer — a promotion
    // rebuilds a new environment, it never invalidates the old one (a pinned
    // run mounting the pre-promotion recipe must not start rebuilding).
    const unpromoted = await builder.ensureEnvironmentLayer({
      raw: DECLARED,
      orgId: "org-c",
    });
    expect(unpromoted.kind).toBe("ready");
    if (unpromoted.kind !== "ready" || before.kind !== "ready") return;
    expect(unpromoted.cacheHit).toBe(true);
    expect(unpromoted.entry.recipeKey).toBe(before.entry.recipeKey);
    expect(builds()).toBe(2);
  });

  it("nothing to promote ⇒ nothing to rebuild (an already-declared package is never a candidate)", async () => {
    const { builder, builds } = makeStack();
    const declared = { pip: ["six==1.16.0", "tabulate"] };
    const first = await builder.ensureEnvironmentLayer({ raw: declared, orgId: "org-a" });
    expect(first.kind === "ready" && first.cacheHit).toBe(false);
    expect(builds()).toBe(1);

    // The same six-of-ten observations against a spec that ALREADY declares
    // tabulate yield no candidate at all…
    expect(computePromotionCandidates(OBSERVED, declared)).toEqual([]);
    // …so the declaration is unchanged and the next resolution is a cache hit,
    // not a spurious rebuild.
    const again = await builder.ensureEnvironmentLayer({ raw: declared, orgId: "org-a" });
    expect(again.kind === "ready" && again.cacheHit).toBe(true);
    expect(builds()).toBe(1);
  });

  it("a version-constrained declaration still shadows the bare candidate (no duplicate declaration, no rebuild)", async () => {
    const { builder, builds } = makeStack();
    // `tabulate` is already declared, pinned. The candidate is the BARE name;
    // the membership comparison strips constraints, so it is not proposed —
    // promoting it would have produced a second, conflicting entry and an
    // unnecessary rebuild.
    const declared = { pip: ["six==1.16.0", "tabulate>=0.9"] };
    expect(computePromotionCandidates(OBSERVED, declared)).toEqual([]);
    await builder.ensureEnvironmentLayer({ raw: declared, orgId: "org-a" });
    expect(builds()).toBe(1);
  });
});
