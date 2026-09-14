// Buildx cache-backend branching guard (cinatra#3267): unit tests over the pure
// reader/checker + the LIVE enforcement test. The live test at the bottom is the
// actual guard: it runs the check against THIS repo's .github/workflows inside
// the root Vitest suite (gate of record), so a build-push-action step that
// caches to `type=gha` unconditionally — which the self-hosted runner class
// cannot reach, and which killed three image builds on this branch — reds a
// required check instead of only failing at image-build time.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CACHE_DIR_ENV,
  checkCacheSite,
  checkWorkflow,
  countCacheDirPreparers,
  parseBuildPushSteps,
  runGuard,
} from "../build-push-cache-branching.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");

const HOSTED_FROM = "${{ runner.environment == 'github-hosted' && 'type=gha' || format('type=local,src={0}', env.LOCAL_BUILDX_CACHE_DIR) }}";
const HOSTED_TO = "${{ runner.environment == 'github-hosted' && 'type=gha,mode=max' || format('type=local,dest={0},mode=max', env.LOCAL_BUILDX_CACHE_DIR) }}";

const WORKFLOW = ({ from = HOSTED_FROM, to = HOSTED_TO, preparer = true } = {}) => `name: x

jobs:
  build-and-smoke:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@0000000000000000000000000000000000000000 # v7.0.1

      - uses: docker/setup-buildx-action@0000000000000000000000000000000000000000 # v4.3.0
${
  preparer
    ? `
      - name: Prepare the runner-local buildx cache (self-hosted only)
        if: \${{ runner.environment != 'github-hosted' }}
        shell: bash
        run: |
          set -euo pipefail
          dir="$HOME/.cache/buildx/exec-l0"
          echo "${CACHE_DIR_ENV}=$dir" >> "$GITHUB_ENV"
`
    : ""
}
      # a comment between steps
      - name: Build image
        uses: docker/build-push-action@0000000000000000000000000000000000000000 # v7.3.0
        with:
          context: .
          load: true
          build-args: |
            CI=true
          cache-from: ${from}
          cache-to: ${to}

      - name: Smoke-test
        run: |
          echo "cache-from: not a real key, inside a run block"
`;

describe("parseBuildPushSteps", () => {
  it("finds the build-push-action step and both of its cache lines, and nothing else", () => {
    const steps = parseBuildPushSteps(WORKFLOW());
    expect(steps).toHaveLength(1);
    expect(steps[0].name).toBe("Build image");
    expect(steps[0].cacheSites.map((s) => s.key)).toEqual(["cache-from", "cache-to"]);
    expect(steps[0].cacheSites[0].value).toBe(HOSTED_FROM);
  });

  it("does not read a `cache-from:` that lives inside another step's run block", () => {
    const steps = parseBuildPushSteps(WORKFLOW());
    expect(steps.flatMap((s) => s.cacheSites)).toHaveLength(2);
  });

  it("returns no steps for a workflow with no build-push-action", () => {
    expect(parseBuildPushSteps("jobs:\n  a:\n    steps:\n      - run: echo hi\n")).toEqual([]);
  });
});

describe("countCacheDirPreparers", () => {
  it("counts only the lines that export the cache dir into GITHUB_ENV", () => {
    expect(countCacheDirPreparers(WORKFLOW())).toBe(1);
    expect(countCacheDirPreparers(WORKFLOW({ preparer: false }))).toBe(0);
  });
});

describe("checkCacheSite", () => {
  const site = (over) => ({ file: "w.yml", step: "Build image", line: 1, ...over });

  it("accepts a two-armed cache-from and cache-to", () => {
    expect(checkCacheSite(site({ key: "cache-from", value: HOSTED_FROM }))).toEqual([]);
    expect(checkCacheSite(site({ key: "cache-to", value: HOSTED_TO }))).toEqual([]);
  });

  it("rejects the bare literal that broke the self-hosted builds", () => {
    const p = checkCacheSite(site({ key: "cache-from", value: "type=gha" }));
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/value is a literal/);
    expect(checkCacheSite(site({ key: "cache-to", value: "type=gha,mode=max" }))[0]).toMatch(/value is a literal/);
  });

  it("rejects an expression with only the hosted arm", () => {
    const p = checkCacheSite(site({ key: "cache-from", value: "${{ runner.environment == 'github-hosted' && 'type=gha' || '' }}" }));
    expect(p.join("\n")).toMatch(/no type=local arm/);
  });

  it("rejects an expression that drops the exact type=gha string", () => {
    const p = checkCacheSite(site({ key: "cache-from", value: "${{ runner.environment == 'github-hosted' && 'type=registry' || format('type=local,src={0}', env.LOCAL_BUILDX_CACHE_DIR) }}" }));
    expect(p.join("\n")).toMatch(/no quoted type=gha arm/);
  });

  it("rejects a local export arm without mode=max, and a local import arm without src=", () => {
    expect(
      checkCacheSite(site({ key: "cache-to", value: "${{ runner.environment == 'github-hosted' && 'type=gha,mode=max' || format('type=local,dest={0}', env.LOCAL_BUILDX_CACHE_DIR) }}" })).join("\n"),
    ).toMatch(/mode=max/);
    expect(
      checkCacheSite(site({ key: "cache-from", value: "${{ runner.environment == 'github-hosted' && 'type=gha' || format('type=local,dest={0}', env.LOCAL_BUILDX_CACHE_DIR) }}" })).join("\n"),
    ).toMatch(/src=/);
  });

  it("rejects a local arm that hardcodes a path instead of the preparer's env var", () => {
    expect(
      checkCacheSite(site({ key: "cache-from", value: "${{ runner.environment == 'github-hosted' && 'type=gha' || 'type=local,src=/tmp/buildx' }}" })).join("\n"),
    ).toMatch(new RegExp(`env\\.${CACHE_DIR_ENV}`));
  });
});

describe("checkWorkflow", () => {
  it("passes a workflow whose cache sites branch and whose preparer count matches", () => {
    expect(checkWorkflow({ file: "w.yml", text: WORKFLOW() })).toEqual([]);
  });

  it("flags a cached build step with no self-hosted preparer step", () => {
    const p = checkWorkflow({ file: "w.yml", text: WORKFLOW({ preparer: false }) });
    expect(p.join("\n")).toMatch(/every cached build needs its own self-hosted preparer step/);
  });

  it("fails closed when the reader cannot account for every build-push-action mention", () => {
    const text = `${WORKFLOW()}\n# uses: docker/build-push-action@0000000000000000000000000000000000000000\n`;
    expect(checkWorkflow({ file: "w.yml", text }).join("\n")).toMatch(/refusing to pass a file it cannot read/);
  });
});

describe("LIVE enforcement (the guard itself, cinatra#3267)", () => {
  it("every build-push-action cache site in THIS repo branches on runner.environment", () => {
    const r = runGuard(REPO_ROOT);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("covers the eight image-build cache sites the self-hosted runner class must not send to gha", () => {
    const files = ["build-image.yml", "build-exec-images.yml"].map((f) =>
      path.join(REPO_ROOT, ".github", "workflows", f),
    );
    const steps = files.flatMap((f) => parseBuildPushSteps(fs.readFileSync(f, "utf8")));
    expect(steps).toHaveLength(8);
    expect(steps.flatMap((s) => s.cacheSites)).toHaveLength(11);
  });
});
