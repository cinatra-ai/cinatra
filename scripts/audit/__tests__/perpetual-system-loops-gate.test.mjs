// Tests for scripts/audit/perpetual-system-loops-gate.mjs.
//
// Two layers:
//   1. Live smoke — run the gate against the actual repo files; expect 0
//      violations and all four canonicalized loops detected. This is the
//      regression guard that fails the moment one of the four boot-seeded
//      loops drifts off-pattern OR a fifth loop is added without doctrine
//      compliance.
//   2. Synthetic fixtures — well-formed inputs that satisfy every invariant
//      as a baseline; per-invariant tamperings then assert the matching
//      violation surfaces.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

import {
  defaultFilePaths,
  parseSystemJobs,
  parseBackgroundJobNames,
  parseLoopIdConstants,
  parseBootSeeds,
  parseHandlerCase,
  runGate,
} from "../perpetual-system-loops-gate.mjs";

function readReal() {
  const paths = defaultFilePaths();
  return {
    instrumentation: readFileSync(paths.instrumentation, "utf8"),
    backgroundJobs: readFileSync(paths.backgroundJobs, "utf8"),
    recipientPolicy: readFileSync(paths.recipientPolicy, "utf8"),
  };
}

// A minimal, well-formed fixture that should pass every invariant. Per-test
// tamperings derive failures from this baseline.
function buildFixture() {
  const instrumentation = `
const fn = async () => {
  await enqueueBackgroundJob(
    BACKGROUND_JOB_NAMES.FOO_LOOP,
    {},
    {
      jobId: FOO_LOOP_LOOP_JOB_ID,
      delay: 1000,
      overwriteIfStale: true,
      skipWorker: true,
      inheritActorContext: false,
    },
  );
};
`;
  const backgroundJobs = `
import { Queue, DelayedError } from "bullmq";

const BACKGROUND_JOB_NAMES = {
  FOO_LOOP: "foo-loop",
} as const;

export const FOO_LOOP_LOOP_JOB_ID = "foo-loop-id";

async function dispatch(job) {
  switch (job.name) {
    case BACKGROUND_JOB_NAMES.FOO_LOOP: {
      try {
        // cycle work
      } catch (err) {
        console.error("[foo] cycle failed:", err);
      }
      if (String(job.id ?? "") !== FOO_LOOP_LOOP_JOB_ID) {
        return;
      }
      try {
        await job.moveToDelayed(Date.now() + 1000, job.token);
      } catch (e) {
        console.warn("[foo] re-delay failed", e);
        return;
      }
      throw new DelayedError();
    }
  }
}
`;
  const recipientPolicy = `
const SYSTEM_JOBS = new Set<string>([
  "foo-loop",
]);
`;
  return { instrumentation, backgroundJobs, recipientPolicy };
}

describe("perpetual-system-loops-gate — parser primitives", () => {
  it("parseSystemJobs extracts the quoted entries", () => {
    const src = `const SYSTEM_JOBS = new Set<string>([\n  "a",\n  "b",\n]);`;
    expect([...parseSystemJobs(src)]).toEqual(["a", "b"]);
  });

  it("parseBackgroundJobNames maps KEY → value", () => {
    const src = `const BACKGROUND_JOB_NAMES = { A: "a-job", B: "b-job" } as const;`;
    const m = parseBackgroundJobNames(src);
    expect(m.get("A")).toBe("a-job");
    expect(m.get("B")).toBe("b-job");
  });

  it("parseLoopIdConstants finds exported *_LOOP_JOB_ID constants", () => {
    const src = `export const FOO_LOOP_JOB_ID = "foo-id";\nexport const BAR_LOOP_JOB_ID = "bar-id";`;
    const m = parseLoopIdConstants(src);
    expect(m.get("FOO_LOOP_JOB_ID")).toBe("foo-id");
    expect(m.get("BAR_LOOP_JOB_ID")).toBe("bar-id");
  });

  it("parseBootSeeds captures the 3rd-arg options block per call", () => {
    const src = `await enqueueBackgroundJob(\n  BACKGROUND_JOB_NAMES.X,\n  {},\n  { jobId: X_LOOP_JOB_ID, overwriteIfStale: true },\n);`;
    const seeds = parseBootSeeds(src);
    expect(seeds).toHaveLength(1);
    expect(seeds[0].name).toBe("X");
    expect(seeds[0].options).toContain("jobId: X_LOOP_JOB_ID");
    expect(seeds[0].options).toContain("overwriteIfStale: true");
  });

  it("parseHandlerCase returns the body of the matching switch case", () => {
    const src = `case BACKGROUND_JOB_NAMES.X: {\n  // marker body\n  return;\n}`;
    const h = parseHandlerCase(src, "X");
    expect(h).not.toBeNull();
    expect(h.body).toContain("// marker body");
  });
});

describe("perpetual-system-loops-gate — runGate against the real repo (live smoke)", () => {
  it("passes with 0 violations and detects all 4 canonicalized loops", () => {
    const sources = readReal();
    const result = runGate(sources);
    expect(result.violations).toEqual([]);
    expect(result.bootSeedNames).toEqual(
      expect.arrayContaining([
        "GRAPHITI_PROJECTION_REPAIR",
        "ARTIFACT_PROVIDER_CACHE_EVICT",
        "AUDIT_RETENTION_ENFORCE",
        "LITELLM_PRICING_SYNC",
      ]),
    );
  });
});

describe("perpetual-system-loops-gate — runGate against synthetic fixtures", () => {
  it("passes on a complete, canonical fixture", () => {
    const result = runGate(buildFixture());
    expect(result.violations).toEqual([]);
    expect(result.bootSeedNames).toEqual(["FOO_LOOP"]);
  });

  it("fails when SYSTEM_JOBS is missing the job name", () => {
    const fx = buildFixture();
    fx.recipientPolicy = `const SYSTEM_JOBS = new Set<string>([\n]);`;
    const result = runGate(fx);
    expect(result.violations.join("\n")).toMatch(
      /"foo-loop" missing from SYSTEM_JOBS/,
    );
  });

  it("fails when the *_LOOP_JOB_ID export is missing", () => {
    const fx = buildFixture();
    fx.backgroundJobs = fx.backgroundJobs.replace(
      `export const FOO_LOOP_LOOP_JOB_ID = "foo-loop-id";`,
      ``,
    );
    const result = runGate(fx);
    expect(result.violations.join("\n")).toMatch(
      /missing exported `FOO_LOOP_LOOP_JOB_ID`/,
    );
  });

  it("fails when the boot seed uses a raw literal instead of the constant", () => {
    const fx = buildFixture();
    fx.instrumentation = fx.instrumentation.replace(
      `jobId: FOO_LOOP_LOOP_JOB_ID`,
      `jobId: "foo-loop-id"`,
    );
    const result = runGate(fx);
    expect(result.violations.join("\n")).toMatch(
      /boot seed jobId must be the exported `FOO_LOOP_LOOP_JOB_ID` constant/,
    );
  });

  it("fails when the boot seed is missing `overwriteIfStale: true`", () => {
    const fx = buildFixture();
    fx.instrumentation = fx.instrumentation.replace(
      `overwriteIfStale: true,\n`,
      ``,
    );
    const result = runGate(fx);
    expect(result.violations.join("\n")).toMatch(
      /boot seed missing `overwriteIfStale: true`/,
    );
  });

  it("fails when the handler is missing the dup-guard", () => {
    const fx = buildFixture();
    fx.backgroundJobs = fx.backgroundJobs.replace(
      `if (String(job.id ?? "") !== FOO_LOOP_LOOP_JOB_ID) {\n        return;\n      }\n`,
      ``,
    );
    const result = runGate(fx);
    expect(result.violations.join("\n")).toMatch(/handler missing dup-guard/);
  });

  it("fails when the handler is missing `moveToDelayed`", () => {
    const fx = buildFixture();
    fx.backgroundJobs = fx.backgroundJobs.replace(
      `await job.moveToDelayed(Date.now() + 1000, job.token);`,
      `// removed`,
    );
    const result = runGate(fx);
    expect(result.violations.join("\n")).toMatch(
      /handler missing `job\.moveToDelayed/,
    );
  });

  it("fails when the handler is missing `throw new DelayedError()`", () => {
    const fx = buildFixture();
    fx.backgroundJobs = fx.backgroundJobs.replace(
      `throw new DelayedError();`,
      `// removed`,
    );
    const result = runGate(fx);
    expect(result.violations.join("\n")).toMatch(
      /handler missing `throw new DelayedError\(\)`/,
    );
  });

  it("fails on the same-name `enqueueBackgroundJob` antipattern (storm or HSETNX-drop)", () => {
    const fx = buildFixture();
    // Inject the forbidden self-reschedule shape into the handler. Catches BOTH
    // the anonymous-successor (storm) and stable-jobId (silent-drop) variants
    // because the rule is a same-name ban, not just an anonymous ban.
    fx.backgroundJobs = fx.backgroundJobs.replace(
      `throw new DelayedError();`,
      `await enqueueBackgroundJob(BACKGROUND_JOB_NAMES.FOO_LOOP, {}, { delay: 1000 });\n      throw new DelayedError();`,
    );
    const result = runGate(fx);
    expect(result.violations.join("\n")).toMatch(
      /handler calls `enqueueBackgroundJob\(BACKGROUND_JOB_NAMES\.FOO_LOOP/,
    );
  });

  it("fails closed when the boot-seed options block cannot be parsed", () => {
    const fx = buildFixture();
    // A call with no 3rd-arg `{...}` block. The header regex matches but the
    // brace walk finds no options literal — the parser MUST surface this as a
    // violation, not silently skip the loop (or a future weirdly-formatted
    // boot seed could land off-pattern undetected).
    fx.instrumentation += `\nawait enqueueBackgroundJob(BACKGROUND_JOB_NAMES.BAD, {});\n`;
    fx.backgroundJobs = fx.backgroundJobs.replace(
      `FOO_LOOP: "foo-loop",`,
      `FOO_LOOP: "foo-loop",\n  BAD: "bad-job",`,
    );
    const result = runGate(fx);
    expect(result.violations.join("\n")).toMatch(
      /BAD.*boot seed options block could not be parsed/,
    );
  });
});
