// Hosted e2e production builds run ONE page-data worker.
//
// Every job in .github/workflows/*.yml that (a) can run on a GitHub-hosted
// runner and (b) has a step that runs the production app build must set
// CINATRA_BUILD_CPUS: "1" in that build step's own `env:`, with or without
// job-level service containers. The knob maps to experimental.cpus in
// next.config.ts and bounds the page-data worker fan-out; each worker is a
// whole extra Node process with its own heap.
//
// Why: the hosted runner has about 15.6 GiB of RAM, and the measured whole-tree
// peak of this build with 3 page-data workers is about 15.5 GiB (see
// docs/internals/workflows/constrained-host-builds.md). The service containers
// and the runner's own processes come on top. The e2e build jobs that kept the
// default fan-out (3 workers on the 4-vCPU hosted runner) hung in "Build app
// (production)" until the job timeout, with the runner no longer responding:
// the step's own timeout never fired and the job log was never uploaded. The
// hosted /agents smoke build, which already runs 1 worker next to the same
// services, did not hang in the same window.
//
// The same holds for every hosted job that builds the repository-root
// Dockerfile with docker/build-push-action (services or not): its `pnpm build`
// RUN reads the knob from `ARG CINATRA_BUILD_CPUS`, so such a step must pass
// `CINATRA_BUILD_CPUS=1` in its `build-args`. The build-image.yml `image` job
// lost its runner in that build the same way, with no services at all.
//
// A hosted build with NO services is not exempt either. The build-image.yml
// `presence-degraded-build` job runs `pnpm build` directly on the runner with
// no service containers; it kept the default fan-out and lost its runner in
// that step on a main push (the job cap fired late, no job log was uploaded,
// and the main run ended cancelled).
//
// The jobs are DISCOVERED from the real workflow files, not listed by hand, so
// a new hosted build is covered the day it is added.
//
// What counts, read from the workflows as they are:
// - Hosted: every `runs-on` here is a literal `ubuntu-*` label or an expression
//   that falls back to `ubuntu-latest`. A job is left out only when its
//   runs-on is a literal `self-hosted` label with no hosted fallback. A runs-on
//   that cannot be classified counts as hosted (fail closed).
// - Production build: a `run:` line (a comment line does not count) that calls
//   `pnpm build` (also `npm|yarn|bun [run] build`, with or without options
//   before `build`), `next build` or `scripts/next-build.mjs`, including when
//   wrapped as in `bash scripts/ci/design-build-host-lock.sh pnpm build` or
//   `... bash -c 'pnpm build || ...'`.
// - The cap: `CINATRA_BUILD_CPUS` set to 1 (quoted or not) in the build step's
//   own `env:` block. Job-level and workflow-level `env:` are not accepted: no
//   workflow here uses them for this knob, and a step-level value cannot be
//   shadowed.
// - Step lists: both layouts the workflows use are read, `- name:` indented
//   under `steps:` and `- name:` at the same column as `steps:`.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(
  fileURLToPath(import.meta.url),
  "..",
  "..",
  "..",
  "..",
);
const WORKFLOW_DIR = path.join(REPO_ROOT, ".github", "workflows");

// ---- a small reader for the workflow layout (no YAML dependency) ----

const indentOf = (line) => line.length - line.trimStart().length;
const isSkippable = (line) => line.trim() === "" || line.trim().startsWith("#");
const unquote = (value) => {
  const v = value.trim();
  const quoted = /^(["'])(.*)\1(?:\s+#.*)?$/.exec(v);
  return quoted ? quoted[2] : v.replace(/\s+#.*$/, "");
};

/**
 * The nested lines of the key `key` that sits at column `keyIndent` inside
 * `lines`: { inline, body } or null. `allowDash` also takes `- ` items at the
 * key's own column (the compact sequence layout).
 */
function readKey(lines, keyIndent, key, allowDash = false) {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (isSkippable(line) || indentOf(line) !== keyIndent) continue;
    const m = new RegExp(`^ {${keyIndent}}${key}:(.*)$`).exec(line);
    if (!m) continue;
    const body = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j];
      if (isSkippable(next)) {
        body.push(next);
        continue;
      }
      const ind = indentOf(next);
      if (ind > keyIndent || (allowDash && ind === keyIndent && next.trimStart().startsWith("- "))) {
        body.push(next);
      } else {
        break;
      }
    }
    return { inline: m[1].trim(), body };
  }
  return null;
}

/** The jobs of one workflow file: [{ key, runsOn, steps }]. */
function parseJobs(text) {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (at === -1) return [];
  const jobsLines = [];
  for (let i = at + 1; i < lines.length; i += 1) {
    if (!isSkippable(lines[i]) && indentOf(lines[i]) === 0) break;
    jobsLines.push(lines[i]);
  }
  const first = jobsLines.find((l) => !isSkippable(l));
  if (!first) return [];
  const jobIndent = indentOf(first);
  const marks = jobsLines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => !isSkippable(l) && indentOf(l) === jobIndent && /^\s*[\w.-]+:\s*(#.*)?$/.test(l));
  return marks.map(({ l, i }, n) => {
    const end = n + 1 < marks.length ? marks[n + 1].i : jobsLines.length;
    const body = jobsLines.slice(i + 1, end);
    const firstBody = body.find((b) => !isSkippable(b));
    const keyIndent = firstBody ? indentOf(firstBody) : jobIndent + 2;
    const runsOn = readKey(body, keyIndent, "runs-on");
    const stepsBlock = readKey(body, keyIndent, "steps", true);
    return {
      key: l.trim().replace(/:.*$/, ""),
      runsOn: runsOn ? [runsOn.inline, ...runsOn.body].join(" ").trim() : null,
      steps: stepsBlock ? parseSteps(stepsBlock.body) : [],
    };
  });
}

/** The steps of a `steps:` body: [{ name, env, run }]. */
function parseSteps(stepLines) {
  const first = stepLines.find((l) => !isSkippable(l));
  if (!first) return [];
  const itemIndent = indentOf(first);
  const items = [];
  for (const line of stepLines) {
    if (!isSkippable(line) && indentOf(line) === itemIndent && line.trimStart().startsWith("- ")) {
      // the `- ` opens a mapping whose first key sits two columns in
      items.push([`${" ".repeat(itemIndent)}  ${line.trimStart().slice(2)}`]);
    } else if (items.length > 0) {
      items[items.length - 1].push(line);
    }
  }
  const keyIndent = itemIndent + 2;
  return items.map((item, n) => {
    const name = readKey(item, keyIndent, "name");
    const env = readKey(item, keyIndent, "env");
    const run = readKey(item, keyIndent, "run");
    const vars = {};
    if (env) {
      for (const line of env.body) {
        const m = /^\s*([A-Za-z_]\w*):\s*(.*)$/.exec(line);
        if (m && !isSkippable(line)) vars[m[1]] = unquote(m[2]);
      }
    }
    const uses = readKey(item, keyIndent, "uses");
    return {
      name: name ? unquote(name.inline) : `(unnamed step ${n + 1})`,
      env: vars,
      run: run ? [run.inline, ...run.body].join("\n") : "",
      uses: uses ? unquote(uses.inline) : "",
      with: readWith(readKey(item, keyIndent, "with")),
    };
  });
}

/**
 * A step's `with:` block: { context, file, buildArgs } where buildArgs maps
 * each `KEY=VALUE` line of a `build-args: |` block scalar (comment lines
 * skipped). Absent keys read as null / {}.
 */
function readWith(withBlock) {
  const out = { context: null, file: null, buildArgs: {} };
  if (!withBlock) return out;
  const first = withBlock.body.find((l) => !isSkippable(l));
  if (!first) return out;
  const ind = indentOf(first);
  const context = readKey(withBlock.body, ind, "context");
  const file = readKey(withBlock.body, ind, "file");
  const args = readKey(withBlock.body, ind, "build-args");
  if (context) out.context = unquote(context.inline);
  if (file) out.file = unquote(file.inline);
  if (args) {
    for (const line of args.body) {
      if (isSkippable(line)) continue;
      const m = /^\s*([A-Za-z_]\w*)=(.*)$/.exec(line);
      if (m) out.buildArgs[m[1]] = m[2].trim();
    }
  }
  return out;
}

// ---- the three conditions ----

/** Hosted unless runs-on is a literal self-hosted label with no hosted fallback. */
function isHosted(runsOn) {
  if (runsOn === null) return true; // cannot be classified: counts as hosted
  const selfHostedOnly =
    /self-hosted/.test(runsOn) && !/\$\{\{|ubuntu-|windows-|macos-/.test(runsOn);
  return !selfHostedOnly;
}

const BUILD_COMMAND = [
  // pnpm build, pnpm --filter x build, pnpm run build, npm run build, ...
  /(?:^|[\s'"`(])(?:pnpm|npm|yarn|bun)(?:\s+\S+)*?\s+build(?=$|[\s'"`);])/,
  /(?:^|[\s'"`(])next\s+build(?=$|[\s'"`);])/,
  /scripts\/next-build\.mjs/,
];

/** True when a `run:` text invokes the production app build (comment lines skipped). */
function runsProductionBuild(run) {
  return run
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .some((line) =>
      line
        .split(/&&|\|\||;|\|/)
        .some((segment) => BUILD_COMMAND.some((re) => re.test(segment))),
    );
}

/** Every hosted job with a production build step, as { file, job, step }. */
function discover(files) {
  const found = [];
  for (const file of files) {
    for (const job of parseJobs(file.text)) {
      if (!isHosted(job.runsOn)) continue;
      for (const step of job.steps) {
        if (runsProductionBuild(step.run)) found.push({ file: file.name, job: job.key, step });
      }
    }
  }
  return found;
}

/** True when a step builds the repository-root Dockerfile with docker/build-push-action. */
function buildsRootDockerfile(step) {
  if (!/^docker\/build-push-action@/.test(step.uses)) return false;
  const context = step.with.context;
  const file = step.with.file;
  const rootContext = context === "." || context === "./";
  const rootFile = file === null || file === "Dockerfile" || file === "./Dockerfile";
  return rootContext && rootFile;
}

/**
 * Every hosted job step that builds the root Dockerfile (whose `pnpm build`
 * RUN reads CINATRA_BUILD_CPUS from a build-arg), as { file, job, step }. No
 * services condition: the image job has none and still lost its runner.
 */
function discoverImageBuilds(files) {
  const found = [];
  for (const file of files) {
    for (const job of parseJobs(file.text)) {
      if (!isHosted(job.runsOn)) continue;
      for (const step of job.steps) {
        if (buildsRootDockerfile(step)) found.push({ file: file.name, job: job.key, step });
      }
    }
  }
  return found;
}

const workflowFiles = () =>
  fs
    .readdirSync(WORKFLOW_DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((name) => ({ name, text: fs.readFileSync(path.join(WORKFLOW_DIR, name), "utf8") }));

const label = ({ file, job, step }) => `${file} / ${job} / ${step.name}`;

// The jobs this fix was made for, and the other hosted builds that already set
// the cap. Discovery must find at least these, so a reader that stops finding
// jobs cannot pass by asserting nothing.
const KNOWN_FLOOR = [
  "build-image.yml / e2e-rbac / Build app (production)",
  "e2e-app-suites.yml / notifications-e2e / Build app (production)",
  "e2e-app-suites.yml / render-smoke-e2e / Build app (production)",
  "dashboard-live-verify.yml / smoke / Build app (production)",
  "design-baselines-refresh.yml / refresh / Build (standalone production server)",
  // No services: discovered since the services condition was dropped. The step
  // name reads as the reader cuts it at the ` #` of "(the #109 class ...)".
  "build-image.yml / presence-degraded-build / Build against the shrunk maps (the",
];

describe("hosted production app builds run one page-data worker", () => {
  const discovered = discover(workflowFiles());

  it("discovers every known hosted build (the floor)", () => {
    const names = discovered.map(label);
    for (const known of KNOWN_FLOOR) {
      expect(names, `discovery lost "${known}"`).toContain(known);
    }
  });

  it('sets CINATRA_BUILD_CPUS: "1" on every discovered build step', () => {
    const uncapped = discovered.filter(({ step }) => step.env.CINATRA_BUILD_CPUS !== "1").map(label);
    expect(uncapped, "hosted production build steps without the cap").toEqual([]);
  });

  for (const hit of discovered) {
    it(`caps ${label(hit)}`, () => {
      expect(hit.step.env.CINATRA_BUILD_CPUS).toBe("1");
    });
  }
});

// The image builds. The root Dockerfile's `pnpm build` RUN takes the knob as
// `ARG CINATRA_BUILD_CPUS`, so a docker build sets it through `build-args`, not
// through the step's env. Inside buildkit Next sizes its fan-out from
// os.cpus().length, so on the 4-vCPU hosted runner the uncapped image build
// runs the same 3 page-data workers. The build-image.yml `image` job lost its
// runner in "Build image (load for prod-boot e2e)" the same way the e2e builds
// did: the step never completed, the 45-minute job cap fired late and the job
// log was never uploaded.
const KNOWN_IMAGE_FLOOR = [
  "build-image.yml / image / Build image (load for prod-boot e2e)",
  "build-image.yml / publish-nonrelease-image / Push image",
  "build-image.yml / upgrade-proof / Load candidate image from the build cache",
  "build-image.yml / publish-release-image / Push image",
];

// Left uncapped on purpose. Each entry must still be discovered, so an
// exemption that no longer matches a step fails instead of going stale.
const IMAGE_EXEMPT = {
  // Dispatch-only measurement workflow: it measures the image build as the
  // runner shape gives it, including the 8-core cohort.
  "hosted-build-size-trial.yml / image / Build image (load for prod-boot e2e)":
    "dispatch-only build-size measurement",
};

describe("hosted root-Dockerfile image builds run one page-data worker", () => {
  const discovered = discoverImageBuilds(workflowFiles());
  const names = discovered.map(label);

  it("discovers every known root-Dockerfile image build (the floor)", () => {
    for (const known of KNOWN_IMAGE_FLOOR) {
      expect(names, `discovery lost "${known}"`).toContain(known);
    }
  });

  it("every exemption still names a discovered build", () => {
    for (const exempt of Object.keys(IMAGE_EXEMPT)) {
      expect(names, `stale exemption "${exempt}"`).toContain(exempt);
    }
  });

  it("passes CINATRA_BUILD_CPUS=1 as a build-arg on every non-exempt image build", () => {
    const uncapped = discovered
      .filter((hit) => !(label(hit) in IMAGE_EXEMPT))
      .filter(({ step }) => step.with.buildArgs.CINATRA_BUILD_CPUS !== "1")
      .map(label);
    expect(uncapped, "hosted root-Dockerfile builds without the cap").toEqual([]);
  });

  it("keeps the build-image.yml build-args identical so the publish jobs hit the image job's cache", () => {
    const sets = discovered
      .filter(({ file }) => file === "build-image.yml")
      .map(({ step }) => JSON.stringify(Object.entries(step.with.buildArgs).sort()));
    expect(sets.length).toBeGreaterThanOrEqual(KNOWN_IMAGE_FLOOR.length);
    expect(new Set(sets).size, sets.join(" | ")).toBe(1);
  });

  for (const hit of discovered.filter((h) => !(label(h) in IMAGE_EXEMPT))) {
    it(`caps ${label(hit)}`, () => {
      expect(hit.step.with.buildArgs.CINATRA_BUILD_CPUS).toBe("1");
    });
  }
});

describe("the workflow reader the cap test relies on", () => {
  const wrap = (runsOn, steps) =>
    `name: t\njobs:\n  a:\n    runs-on: ${runsOn}\n    services:\n      db:\n        image: x\n${steps}\n  b:\n    runs-on: ubuntu-latest\n    steps:\n      - name: other\n        run: pnpm build\n`;
  const SPACED = [
    "    steps:",
    "      - name: pre",
    "        run: echo hi",
    "      - name: Build",
    "        env:",
    "          CINATRA_BUILD_CPUS: '1'",
    "        run: pnpm build",
  ].join("\n");
  const COMPACT = [
    "    steps:",
    "    - name: pre",
    "      run: echo hi",
    "    - name: Build",
    "      env:",
    "        CINATRA_BUILD_CPUS: \"1\"",
    "      run: bash scripts/ci/design-build-host-lock.sh pnpm build",
  ].join("\n");
  const run = (text) => discover([{ name: "t.yml", text }]);

  it("reads the indented and the compact step layout, and the step env", () => {
    for (const steps of [SPACED, COMPACT]) {
      const hits = run(wrap("${{ fromJSON(vars.CI_RUNNER_E2E || '\"ubuntu-latest\"') }}", steps));
      expect(hits.map(label)).toEqual(["t.yml / a / Build", "t.yml / b / other"]);
      expect(hits[0].step.env.CINATRA_BUILD_CPUS).toBe("1");
      expect(hits[1].step.env.CINATRA_BUILD_CPUS).toBeUndefined();
    }
  });

  it("leaves out a self-hosted-only job and keeps a hosted job with no services", () => {
    // job b above is hosted with a build step and no services: still discovered
    expect(run(wrap("[self-hosted, linux]", SPACED)).map((h) => h.job)).toEqual(["b"]);
    expect(run(wrap("ubuntu-latest", SPACED)).map((h) => h.job)).toEqual(["a", "b"]);
  });

  it("counts a runs-on it cannot classify as hosted", () => {
    expect(isHosted(null)).toBe(true);
    expect(isHosted("${{ inputs.runner }}")).toBe(true);
    expect(isHosted("[self-hosted, linux]")).toBe(false);
  });

  it("finds a root-Dockerfile build-push-action step, with or without services, and reads its build-args", () => {
    const image = [
      "name: t",
      "jobs:",
      "  img:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Build image",
      "        uses: docker/build-push-action@abc # v7",
      "        with:",
      "          context: .",
      "          load: true",
      "          # a comment inside with",
      "          build-args: |",
      "            CI=true",
      "            CINATRA_BUILD_CPUS=1",
      "          cache-from: type=gha",
      "      - name: Sandbox image",
      "        uses: docker/build-push-action@abc # v7",
      "        with:",
      "          context: docker/sandbox",
      "      - name: Worker image",
      "        uses: docker/build-push-action@abc # v7",
      "        with:",
      "          context: .",
      "          file: docker/exec-worker/Dockerfile",
      "  self:",
      "    runs-on: [self-hosted, linux]",
      "    steps:",
      "      - name: Build image",
      "        uses: docker/build-push-action@abc # v7",
      "        with:",
      "          context: .",
    ].join("\n");
    const hits = discoverImageBuilds([{ name: "t.yml", text: image }]);
    expect(hits.map(label)).toEqual(["t.yml / img / Build image"]);
    expect(hits[0].step.with.buildArgs).toEqual({ CI: "true", CINATRA_BUILD_CPUS: "1" });
  });

  it("reads an uncapped image build as uncapped", () => {
    const image = [
      "jobs:",
      "  img:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Build image",
      "        uses: docker/build-push-action@abc",
      "        with:",
      "          context: .",
      "          build-args: |",
      "            CI=true",
      "        env:",
      "          CINATRA_BUILD_CPUS: \"1\"",
    ].join("\n");
    const [hit] = discoverImageBuilds([{ name: "t.yml", text: image }]);
    // a step env does not reach the docker build: only a build-arg counts
    expect(hit.step.with.buildArgs.CINATRA_BUILD_CPUS).toBeUndefined();
  });

  it("finds the build in the forms the workflows use and ignores comments", () => {
    for (const text of [
      "pnpm build",
      "pnpm run build",
      "pnpm --filter app build",
      "bash scripts/ci/design-build-host-lock.sh bash -c 'pnpm build || bash x rebuild \"$?\"'",
      "set -eu\n  pnpm build\n  kill 1",
      "next build",
      "node scripts/next-build.mjs",
    ]) {
      expect(runsProductionBuild(text), text).toBe(true);
    }
    for (const text of ["# pnpm build", "pnpm install --frozen-lockfile", "pnpm list a | node -e 'x'", "bash scripts/ci/design-build-cache.sh rebuild 1", ""]) {
      expect(runsProductionBuild(text), text).toBe(false);
    }
  });

  it("does not take a cap from a step it does not belong to", () => {
    const text = wrap(
      "ubuntu-latest",
      "    steps:\n      - name: Build\n        run: pnpm build\n      - name: other\n        env:\n          CINATRA_BUILD_CPUS: \"1\"\n        run: echo hi",
    );
    expect(run(text)[0].step.env.CINATRA_BUILD_CPUS).toBeUndefined();
  });
});
