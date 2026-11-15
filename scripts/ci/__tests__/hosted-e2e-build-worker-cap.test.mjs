// Hosted e2e production builds run ONE page-data worker.
//
// Every job in .github/workflows/*.yml that (a) can run on a GitHub-hosted
// runner, (b) declares job-level service containers (postgres/redis) and (c) has
// a step that runs the production app build must set CINATRA_BUILD_CPUS: "1" in
// that build step's own `env:`. The knob maps to experimental.cpus in
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
// The jobs are DISCOVERED from the real workflow files, not listed by hand, so
// a new hosted build next to services is covered the day it is added.
//
// What counts, read from the workflows as they are:
// - Hosted: every `runs-on` here is a literal `ubuntu-*` label or an expression
//   that falls back to `ubuntu-latest`. A job is left out only when its
//   runs-on is a literal `self-hosted` label with no hosted fallback. A runs-on
//   that cannot be classified counts as hosted (fail closed).
// - Services: a job-level `services:` key.
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
//
// The worker cap does not bound the Turbopack compile, which holds the hosted
// runner at its memory size on its own (a green /agents smoke build: one build
// process at 14.6 GB resident, under 500 MB available for about four minutes).
// So the last part of this file also requires the memory cap of
// scripts/ci/hosted-build-memory-cap.sh on EVERY hosted production build,
// services or not: a `run:` build goes through `hosted-build-memory-cap.sh run`,
// and a root-Dockerfile image build takes the cap on its buildkit container
// (`driver-opts` from a `hosted-build-memory-cap.sh buildx-opts` step). The
// script itself is run here against a stand-in cgroup tree.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

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

/** The jobs of one workflow file: [{ key, runsOn, hasServices, steps }]. */
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
      hasServices: readKey(body, keyIndent, "services") !== null,
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
    const id = readKey(item, keyIndent, "id");
    return {
      name: name ? unquote(name.inline) : `(unnamed step ${n + 1})`,
      id: id ? unquote(id.inline) : "",
      env: vars,
      run: run ? [run.inline, ...run.body].join("\n") : "",
      uses: uses ? unquote(uses.inline) : "",
      with: readWith(readKey(item, keyIndent, "with")),
    };
  });
}

/**
 * A step's `with:` block: { context, file, buildArgs, driverOpts } where
 * buildArgs maps each `KEY=VALUE` line of a `build-args: |` block scalar
 * (comment lines skipped) and driverOpts is the inline `driver-opts:` value.
 * Absent keys read as null / {}.
 */
function readWith(withBlock) {
  const out = { context: null, file: null, buildArgs: {}, driverOpts: null };
  if (!withBlock) return out;
  const first = withBlock.body.find((l) => !isSkippable(l));
  if (!first) return out;
  const ind = indentOf(first);
  const context = readKey(withBlock.body, ind, "context");
  const file = readKey(withBlock.body, ind, "file");
  const args = readKey(withBlock.body, ind, "build-args");
  const driverOpts = readKey(withBlock.body, ind, "driver-opts");
  if (driverOpts) out.driverOpts = unquote(driverOpts.inline);
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

/** Every hosted job with services and a production build step, as { file, job, step }. */
function discover(files) {
  const found = [];
  for (const file of files) {
    for (const job of parseJobs(file.text)) {
      if (!job.hasServices || !isHosted(job.runsOn)) continue;
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
];

describe("hosted e2e builds next to service containers run one page-data worker", () => {
  const discovered = discover(workflowFiles());

  it("discovers every known hosted build next to services (the floor)", () => {
    const names = discovered.map(label);
    for (const known of KNOWN_FLOOR) {
      expect(names, `discovery lost "${known}"`).toContain(known);
    }
  });

  it('sets CINATRA_BUILD_CPUS: "1" on every discovered build step', () => {
    const uncapped = discovered.filter(({ step }) => step.env.CINATRA_BUILD_CPUS !== "1").map(label);
    expect(uncapped, "hosted build steps next to services without the cap").toEqual([]);
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
      expect(hits.map(label)).toEqual(["t.yml / a / Build"]);
      expect(hits[0].step.env.CINATRA_BUILD_CPUS).toBe("1");
    }
  });

  it("leaves out a job with no services and a self-hosted-only job", () => {
    expect(run(wrap("[self-hosted, linux]", SPACED))).toEqual([]);
    // job b above has a build step but no services: never discovered
    expect(run(wrap("ubuntu-latest", SPACED)).map((h) => h.job)).toEqual(["a"]);
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

// ---- the memory cap on every hosted production build ----

const MEMCAP_SCRIPT = path.join(REPO_ROOT, "scripts", "ci", "hosted-build-memory-cap.sh");
const MEMCAP_RUN = /(?:^|[\s'"`(])bash\s+scripts\/ci\/hosted-build-memory-cap\.sh\s+run\s+/;
const MEMCAP_BUILDX = /(?:^|\s)bash\s+scripts\/ci\/hosted-build-memory-cap\.sh\s+buildx-opts\s*$/m;

/** Every hosted job step that runs the production app build, services or not. */
function discoverHostedBuilds(files) {
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

/**
 * The lines of a `run:` text that run the production build outside the cap:
 * a build line passes only when `bash scripts/ci/hosted-build-memory-cap.sh run`
 * comes first on it and every build on it is inside the one command it wraps
 * (a quoted `bash -c '...'` counts as part of that command; a build after an
 * unquoted `&&`, `||`, `;` or `|` does not).
 */
function uncappedBuildLines(run) {
  const hasBuild = (text) => runsProductionBuild(text) || /\bQUOTED_BUILD\b/.test(text);
  return run
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .filter((line) => runsProductionBuild(line))
    .filter((line) => {
      const m = MEMCAP_RUN.exec(line);
      if (!m) return true;
      const before = line.slice(0, m.index + m[0].length);
      const wrapped = line
        .slice(m.index + m[0].length)
        .replace(/'[^']*'|"[^"]*"/g, (q) => (runsProductionBuild(q.slice(1, -1)) ? " QUOTED_BUILD " : " QUOTED "));
      const [first, ...later] = wrapped.split(/&&|\|\||;|\|/);
      return runsProductionBuild(before) || !hasBuild(first) || later.some(hasBuild);
    })
    .map((line) => line.trim());
}

/** Every hosted root-Dockerfile build with its job's steps and its index there. */
function discoverImageBuildSteps(files) {
  const found = [];
  for (const file of files) {
    for (const job of parseJobs(file.text)) {
      if (!isHosted(job.runsOn)) continue;
      job.steps.forEach((step, index) => {
        if (buildsRootDockerfile(step)) found.push({ file: file.name, job: job.key, step, steps: job.steps, index });
      });
    }
  }
  return found;
}

/**
 * Null when the image build's buildkit container takes the cap: the last
 * docker/setup-buildx-action step before the build sets `driver-opts` to the
 * `driver_opts` output of an earlier step that runs
 * `hosted-build-memory-cap.sh buildx-opts`. Otherwise the reason.
 */
function imageCapProblem({ steps, index }) {
  const buildx = steps
    .slice(0, index)
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => /^docker\/setup-buildx-action@/.test(s.uses));
  if (buildx.length === 0) return "no docker/setup-buildx-action step before the build";
  const { s: bx, i: at } = buildx[buildx.length - 1];
  const m = /^\$\{\{\s*steps\.([\w-]+)\.outputs\.driver_opts\s*\}\}$/.exec(bx.with.driverOpts ?? "");
  if (!m) return `setup-buildx driver-opts is ${JSON.stringify(bx.with.driverOpts)}, not a cap step's driver_opts output`;
  const sizing = steps.slice(0, at).find((s) => s.id === m[1]);
  if (!sizing) return `no step with id "${m[1]}" before setup-buildx`;
  if (!MEMCAP_BUILDX.test(sizing.run)) return `step "${m[1]}" does not run hosted-build-memory-cap.sh buildx-opts`;
  return null;
}

// The hosted `run:` builds the cap is made for. Discovery must find at least
// these, so a reader that stops finding builds cannot pass by asserting nothing.
const KNOWN_MEMCAP_FLOOR = [
  "build-image.yml / e2e-rbac / Build app (production)",
  // The step's name is "... (the #109 class is a build error)"; YAML reads the
  // " #109 ..." part as a comment, so GitHub (and this reader) name it "... (the".
  "build-image.yml / presence-degraded-build / Build against the shrunk maps (the",
  "e2e-app-suites.yml / notifications-e2e / Build app (production)",
  "e2e-app-suites.yml / render-smoke-e2e / Build app (production)",
  "dashboard-live-verify.yml / smoke / Build app (production)",
  "design-baselines-refresh.yml / refresh / Build (standalone production server)",
  "design-visual-verify.yml / pixel-diff / Build (standalone production server)",
  "hosted-build-size-trial.yml / design / Build (standalone production server)",
  "hosted-build-size-trial.yml / dashboard / Build app (production)",
];

describe("every hosted production build runs inside the memory cap", () => {
  const files = workflowFiles();
  const builds = discoverHostedBuilds(files);
  const images = discoverImageBuildSteps(files);

  it("discovers every known hosted build, services or not (the floor)", () => {
    const names = builds.map(label);
    for (const known of KNOWN_MEMCAP_FLOOR) {
      expect(names, `discovery lost "${known}"`).toContain(known);
    }
    const imageNames = images.map(label);
    for (const known of [...KNOWN_IMAGE_FLOOR, ...Object.keys(IMAGE_EXEMPT)]) {
      expect(imageNames, `discovery lost "${known}"`).toContain(known);
    }
  });

  it("runs every hosted `run:` build through hosted-build-memory-cap.sh run", () => {
    const uncapped = builds
      .filter(({ step }) => uncappedBuildLines(step.run).length > 0)
      .map((hit) => `${label(hit)}: ${uncappedBuildLines(hit.step.run).join(" ;; ")}`);
    expect(uncapped, "hosted production builds outside the memory cap").toEqual([]);
  });

  it("caps the buildkit container of every hosted root-Dockerfile image build", () => {
    const uncapped = images
      .map((hit) => [label(hit), imageCapProblem(hit)])
      .filter(([, problem]) => problem !== null)
      .map(([name, problem]) => `${name}: ${problem}`);
    expect(uncapped, "hosted image builds without the memory cap").toEqual([]);
  });

  for (const hit of builds) {
    it(`caps ${label(hit)}`, () => {
      expect(uncappedBuildLines(hit.step.run)).toEqual([]);
    });
  }
  for (const hit of images) {
    it(`caps the buildkit container of ${label(hit)}`, () => {
      expect(imageCapProblem(hit)).toBeNull();
    });
  }
});

describe("the memory-cap readers", () => {
  it("accepts a build only behind the wrapper, in the forms the workflows use", () => {
    for (const ok of [
      "bash scripts/ci/hosted-build-memory-cap.sh run pnpm build",
      "bash scripts/ci/design-build-host-lock.sh bash scripts/ci/hosted-build-memory-cap.sh run pnpm build",
      "bash scripts/ci/design-build-host-lock.sh bash scripts/ci/hosted-build-memory-cap.sh run bash -c 'pnpm build || bash scripts/ci/design-build-cache.sh rebuild \"$?\"'",
      "set -eu\n# pnpm build\necho hi",
    ]) {
      expect(uncappedBuildLines(ok), ok).toEqual([]);
    }
    for (const bad of [
      "pnpm build",
      "bash scripts/ci/design-build-host-lock.sh pnpm build",
      "pnpm build && bash scripts/ci/hosted-build-memory-cap.sh run pnpm build",
      "bash scripts/ci/hosted-build-memory-cap.sh run echo hi && pnpm build",
      "bash scripts/ci/hosted-build-memory-cap.sh buildx-opts; pnpm build",
    ]) {
      expect(uncappedBuildLines(bad), bad).not.toEqual([]);
    }
  });

  it("finds the cap step behind setup-buildx, and refuses a missing or foreign one", () => {
    const job = (sizing, opts) =>
      [
        "jobs:",
        "  img:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        ...sizing,
        "      - uses: docker/setup-buildx-action@abc # v4",
        ...(opts === null ? [] : ["        with:", `          driver-opts: ${opts}`]),
        "      - name: Build image",
        "        uses: docker/build-push-action@abc",
        "        with:",
        "          context: .",
      ].join("\n");
    const SIZING = [
      "      - name: Size the build memory cap (GitHub-hosted only)",
      "        id: memcap",
      "        run: bash scripts/ci/hosted-build-memory-cap.sh buildx-opts",
    ];
    const OPTS = "${{ steps.memcap.outputs.driver_opts }}";
    const read = (text) => discoverImageBuildSteps([{ name: "t.yml", text }]).map(imageCapProblem);
    expect(read(job(SIZING, OPTS))).toEqual([null]);
    expect(read(job(SIZING, null))[0]).toMatch(/driver-opts/);
    expect(read(job([], OPTS))[0]).toMatch(/no step with id "memcap"/);
    expect(read(job(["      - name: other", "        id: memcap", "        run: echo memory=1g"], OPTS))[0]).toMatch(
      /does not run/,
    );
    expect(read(job(SIZING, "memory=13g"))[0]).toMatch(/driver-opts/);
  });
});

// ---- the script, run against a stand-in cgroup tree ----

const MIB = 1024 * 1024;
const folders = [];
const temporary = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memcap-"));
  folders.push(dir);
  return dir;
};

/**
 * A stand-in machine: a meminfo file and a cgroup v2 root with plain files
 * (the script writes through `tee`, so plain files take the same writes).
 */
function machine({ memTotalKb = 16365568, controllers = "cpuset cpu io memory pids", subtree = "cpu io memory pids" } = {}) {
  const dir = temporary();
  const cg = path.join(dir, "cgroup");
  fs.mkdirSync(cg);
  fs.writeFileSync(path.join(dir, "meminfo"), `MemTotal:       ${memTotalKb} kB\nMemFree:         1000 kB\n`);
  if (controllers !== null) fs.writeFileSync(path.join(cg, "cgroup.controllers"), `${controllers}\n`);
  fs.writeFileSync(path.join(cg, "cgroup.subtree_control"), `${subtree}\n`);
  fs.writeFileSync(path.join(cg, "cgroup.procs"), "");
  const output = path.join(dir, "github-output");
  fs.writeFileSync(output, "");
  return { dir, cg, output, meminfo: path.join(dir, "meminfo") };
}

function capScript(m, args, env = {}) {
  const all = {
    // never the CI job's own environment: RUNNER_ENVIRONMENT is set per case
    PATH: process.env.PATH,
    HOME: m.dir,
    CINATRA_MEMCAP_MEMINFO: m.meminfo,
    CINATRA_MEMCAP_CGROUP_ROOT: m.cg,
    CINATRA_MEMCAP_SUDO: "",
    GITHUB_OUTPUT: m.output,
    RUNNER_ENVIRONMENT: "github-hosted",
    ...env,
  };
  // a null value leaves the variable unset
  for (const [k, v] of Object.entries(all)) if (v === null) delete all[k];
  return spawnSync("bash", [MEMCAP_SCRIPT, ...args], { encoding: "utf8", env: all });
}

const buildCgroups = (m) => fs.readdirSync(m.cg).filter((n) => n.startsWith("cinatra-build-"));

/**
 * A stand-in for sudo on the stand-in tree. It refuses one root action when
 * FAKE_SUDO_REFUSE is set: the whole command line (for example `mkdir -p <dir>`
 * or `tee <file>`) is matched against that glob. With FAKE_SUDO_DROP it
 * instead reports success for a matching action without doing it (a write the
 * kernel did not take). `rmdir` removes the folder with its plain files, as
 * rmdir removes a real cgroup with its interface files. Every other action
 * runs as asked.
 */
function fakeSudo(m) {
  const file = path.join(m.dir, "fake-sudo");
  fs.writeFileSync(
    file,
    '#!/usr/bin/env bash\nif [ -n "${FAKE_SUDO_REFUSE:-}" ]; then case "$*" in $FAKE_SUDO_REFUSE) exit 1 ;; esac; fi\n' +
      'if [ -n "${FAKE_SUDO_DROP:-}" ]; then case "$*" in $FAKE_SUDO_DROP) cat >/dev/null; exit 0 ;; esac; fi\n' +
      'if [ "$1" = rmdir ]; then shift; exec rm -r "$@"; fi\nexec "$@"\n',
    { mode: 0o755 },
  );
  return file;
}

/** The one ::error line of a fail-closed refusal, checked for its reason. */
function expectOneRefusal(r, reason) {
  expect(r.status, reason + r.stdout + r.stderr).toBe(REFUSED_RC);
  const errors = r.stdout.split("\n").filter((l) => l.startsWith("::error"));
  expect(errors, reason).toHaveLength(1);
  expect(errors[0]).toContain("::error title=build memory cap::cannot cap the build memory: ");
  expect(errors[0]).toContain(reason);
  expect(r.stdout).not.toContain("::warning");
}

const REFUSED_RC = 125;
const MARKER = "build-ran";
// A stand-in build that leaves a marker file, so a test can tell it never ran.
const markerBuild = (m) => ["bash", "-c", `touch "${path.join(m.dir, MARKER)}"; exit 5`];
const capOf = (memTotalKb, reserveMib = 2048) => Math.floor(memTotalKb / 1024) - reserveMib;

describe("scripts/ci/hosted-build-memory-cap.sh, run against a stand-in cgroup tree", () => {
  afterEach(() => {
    for (const dir of folders.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("runs the build in its own cgroup capped at RAM minus the reserve, and returns its exit code", () => {
    const m = machine();
    const r = capScript(m, ["run", "bash", "-c", 'echo "cg=$CINATRA_BUILD_CGROUP"; exit 3']);
    expect(r.status, r.stderr).toBe(3);
    const made = buildCgroups(m);
    expect(made).toHaveLength(1);
    const cg = path.join(m.cg, made[0]);
    expect(fs.readFileSync(path.join(cg, "memory.max"), "utf8")).toBe(`${capOf(16365568) * MIB}\n`);
    // swap stays as the job set it up unless a swap cap is asked for
    expect(fs.existsSync(path.join(cg, "memory.swap.max"))).toBe(false);
    // the script moved itself in before the build, and back out after it
    expect(fs.readFileSync(path.join(cg, "cgroup.procs"), "utf8")).toMatch(/^\d+\n$/);
    expect(fs.readFileSync(path.join(m.cg, "cgroup.procs"), "utf8")).toMatch(/^\d+\n$/);
    expect(r.stdout).toContain(`cg=${cg}`);
    expect(r.stdout).toContain(`::notice title=build memory cap::the build runs capped at ${capOf(16365568)} MiB of RAM`);
    expect(r.stdout).toContain("build memory cap: exit 3;");
  });

  it("turns an out-of-memory kill inside the cap into a red step with a clear error", () => {
    const m = machine();
    const r = capScript(m, [
      "run",
      "bash",
      "-c",
      'printf "low 0\\nhigh 0\\nmax 7\\noom 1\\noom_kill 1\\n" >"$CINATRA_BUILD_CGROUP/memory.events"; echo 15000000000 >"$CINATRA_BUILD_CGROUP/memory.peak"; exit 137',
    ]);
    expect(r.status).toBe(137);
    expect(r.stdout).toContain("peak RAM 14305 MiB");
    expect(r.stdout).toContain("reached the cap 7 times; out-of-memory kills 1");
    expect(r.stdout).toContain("::error title=build memory cap::the build was killed for memory");
  });

  it("reports no memory error for a failure that was not an out-of-memory kill", () => {
    const m = machine();
    const r = capScript(m, ["run", "bash", "-c", "exit 1"]);
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain("::error");
  });

  it("caps swap as well when CINATRA_BUILD_SWAP_MAX_MIB is set", () => {
    const m = machine();
    const r = capScript(m, ["run", "true"], { CINATRA_BUILD_SWAP_MAX_MIB: "8192" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const cg = path.join(m.cg, buildCgroups(m)[0]);
    expect(fs.readFileSync(path.join(cg, "memory.swap.max"), "utf8")).toBe(`${8192 * MIB}\n`);
  });

  it("leaves a build on any other runner, or with the cap turned off, unchanged", () => {
    for (const env of [{ RUNNER_ENVIRONMENT: "self-hosted" }, { RUNNER_ENVIRONMENT: "" }, { CINATRA_BUILD_MEMORY_CAP: "0" }]) {
      const m = machine();
      const r = capScript(m, ["run", "bash", "-c", "exit 4"], env);
      expect(r.status, JSON.stringify(env)).toBe(4);
      expect(buildCgroups(m), JSON.stringify(env)).toEqual([]);
      expect(r.stdout).toContain("build memory cap: not applied:");
      expect(r.stdout).not.toContain("::warning");
    }
  });

  it("fails closed on a GitHub-hosted runner when the cap cannot be set: one error line, no build", () => {
    for (const [shape, env, refuse, reason] of [
      [{ controllers: "cpu io pids" }, {}, null, "memory controller is not available"],
      [{ memTotalKb: 4 * 1024 * 1024 }, {}, null, "under 4096 MiB"],
      [{}, { CINATRA_BUILD_MEMORY_RESERVE_MIB: "2g" }, null, "is not a whole number of MiB"],
      [{}, { CINATRA_MEMCAP_MEMINFO: "/nonexistent/meminfo" }, null, "cannot read MemTotal"],
      [{ subtree: "cpu io pids" }, {}, "tee */cgroup.subtree_control", "cannot enable the memory controller"],
      [{}, {}, "mkdir *", "cannot set up the cgroup"],
      [{}, {}, "tee */memory.max", "cannot set up the cgroup"],
      [{}, {}, "tee */cinatra-build-*/cgroup.procs", "cannot set up the cgroup"],
      [{}, { CINATRA_BUILD_SWAP_MAX_MIB: "8192" }, "tee */memory.swap.max", "cannot set up the cgroup"],
      [{ controllers: null }, {}, null, "no cgroup v2 hierarchy"],
    ]) {
      const m = machine(shape);
      const extra = { CINATRA_MEMCAP_SUDO: fakeSudo(m), ...(refuse ? { FAKE_SUDO_REFUSE: refuse } : {}) };
      const r = capScript(m, ["run", ...markerBuild(m)], { ...env, ...extra });
      expect(r.status, reason + r.stdout + r.stderr).toBe(REFUSED_RC);
      expect(fs.existsSync(path.join(m.dir, MARKER)), reason).toBe(false);
      expect(buildCgroups(m), reason).toEqual([]);
      const errors = r.stdout.split("\n").filter((l) => l.startsWith("::error"));
      expect(errors, reason).toHaveLength(1);
      expect(errors[0]).toContain("::error title=build memory cap::cannot cap the build memory: ");
      expect(errors[0]).toContain(reason);
      expect(errors[0]).toContain("set CINATRA_BUILD_MEMORY_CAP=0 to build uncapped");
      expect(r.stdout).not.toContain("::warning");
    }
  });

  it("fails closed when a cgroup write reports success but did not take (read back), with no build", () => {
    for (const [env, drop] of [
      [{}, "tee */memory.max"],
      [{ CINATRA_BUILD_SWAP_MAX_MIB: "8192" }, "tee */memory.swap.max"],
      [{}, "tee */cinatra-build-*/cgroup.procs"],
    ]) {
      const m = machine();
      const r = capScript(m, ["run", ...markerBuild(m)], { ...env, CINATRA_MEMCAP_SUDO: fakeSudo(m), FAKE_SUDO_DROP: drop });
      expectOneRefusal(r, "cannot set up the cgroup");
      expect(fs.existsSync(path.join(m.dir, MARKER)), drop).toBe(false);
      expect(buildCgroups(m), drop).toEqual([]);
    }
  });

  it("builds uncapped on a hosted runner only when the cap is explicitly turned off", () => {
    const m = machine({ controllers: "cpu io pids" });
    const r = capScript(m, ["run", ...markerBuild(m)], { CINATRA_BUILD_MEMORY_CAP: "0" });
    expect(r.status, r.stdout + r.stderr).toBe(5);
    expect(fs.existsSync(path.join(m.dir, MARKER))).toBe(true);
    expect(r.stdout).toContain("build memory cap: not applied: turned off (CINATRA_BUILD_MEMORY_CAP=0)");
  });

  it("removes its cgroup and ends with the signal's code when the step is cancelled", () => {
    const m = machine();
    const r = capScript(m, ["run", "bash", "-c", "kill -TERM $PPID; sleep 0.3; exit 0"], { CINATRA_MEMCAP_SUDO: fakeSudo(m) });
    expect(r.signal, r.stdout + r.stderr).toBe(null);
    expect(r.status, r.stdout + r.stderr).toBe(143);
    expect(buildCgroups(m)).toEqual([]);
    expect(fs.readFileSync(path.join(m.cg, "cgroup.procs"), "utf8")).toMatch(/^\d+\n$/);
    expect(r.stdout).toContain("build memory cap: stopped by a signal");
  });

  it("enables the memory controller for child cgroups when the root does not yet", () => {
    const m = machine({ subtree: "cpu io pids" });
    const r = capScript(m, ["run", "true"]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(fs.readFileSync(path.join(m.cg, "cgroup.subtree_control"), "utf8")).toBe("+memory\n");
    expect(buildCgroups(m)).toHaveLength(1);
  });

  it("refuses a call without a command", () => {
    const m = machine();
    expect(capScript(m, ["run"]).status).toBe(2);
    expect(capScript(m, []).status).toBe(2);
  });

  it("writes the buildkit driver options for a hosted image build", () => {
    const m = machine();
    expect(capScript(m, ["buildx-opts"]).status).toBe(0);
    // no swap cap asked for: swap stays as the job set it up (Docker's default
    // would allow only as much swap as the memory cap)
    expect(fs.readFileSync(m.output, "utf8")).toBe(
      `driver_opts<<CINATRA_MEMCAP_EOF\nmemory=${capOf(16365568)}m\nmemory-swap=-1\nCINATRA_MEMCAP_EOF\n`,
    );
    const s = machine();
    expect(capScript(s, ["buildx-opts"], { CINATRA_BUILD_SWAP_MAX_MIB: "8192" }).status).toBe(0);
    expect(fs.readFileSync(s.output, "utf8")).toBe(
      `driver_opts<<CINATRA_MEMCAP_EOF\nmemory=${capOf(16365568)}m\nmemory-swap=${capOf(16365568) + 8192}m\nCINATRA_MEMCAP_EOF\n`,
    );
  });

  it("writes empty driver options on any other runner, or with the cap turned off", () => {
    for (const [shape, env] of [
      [{}, { RUNNER_ENVIRONMENT: "self-hosted" }],
      [{ memTotalKb: 2 * 1024 * 1024 }, { RUNNER_ENVIRONMENT: "self-hosted" }],
      [{}, { CINATRA_BUILD_MEMORY_CAP: "0" }],
    ]) {
      const m = machine(shape);
      expect(capScript(m, ["buildx-opts"], env).status).toBe(0);
      expect(fs.readFileSync(m.output, "utf8")).toBe("driver_opts<<CINATRA_MEMCAP_EOF\nCINATRA_MEMCAP_EOF\n");
    }
  });

  it("fails closed when the driver options cannot reach GITHUB_OUTPUT: unset, empty, missing or not a file", () => {
    for (const [value, reason] of [
      [null, "GITHUB_OUTPUT is not set"],
      ["", "GITHUB_OUTPUT is not set"],
      ["missing", "is not an existing regular file"],
      ["folder", "is not an existing regular file"],
    ]) {
      const m = machine();
      const out = value === "missing" ? path.join(m.dir, "no-such-output") : value === "folder" ? m.dir : value;
      const r = capScript(m, ["buildx-opts"], { GITHUB_OUTPUT: out });
      expectOneRefusal(r, reason);
      expect(r.stdout, reason).not.toContain("driver_opts<<");
      expect(fs.existsSync(path.join(m.dir, "no-such-output")), reason).toBe(false);
      expect(fs.readFileSync(m.output, "utf8"), reason).toBe("");
    }
  });

  it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
    "fails closed when GITHUB_OUTPUT cannot be written (a root user could write it, so not run as root)",
    () => {
      const m = machine();
      fs.chmodSync(m.output, 0o444);
      const r = capScript(m, ["buildx-opts"]);
      expectOneRefusal(r, "cannot write the driver options to GITHUB_OUTPUT");
      expect(fs.readFileSync(m.output, "utf8")).toBe("");
      expect(r.stdout).not.toContain("::notice");
    },
  );

  it("fails closed when a hosted image build cannot be sized: one error line, no driver options", () => {
    for (const [shape, env, reason] of [
      [{ memTotalKb: 2 * 1024 * 1024 }, {}, "under 4096 MiB"],
      [{}, { CINATRA_BUILD_SWAP_MAX_MIB: "lots" }, "is not a whole number of MiB"],
      [{}, { CINATRA_MEMCAP_MEMINFO: "/nonexistent/meminfo" }, "cannot read MemTotal"],
    ]) {
      const m = machine(shape);
      const r = capScript(m, ["buildx-opts"], env);
      expect(r.status, reason + r.stdout + r.stderr).toBe(REFUSED_RC);
      expect(fs.readFileSync(m.output, "utf8"), reason).toBe("");
      const errors = r.stdout.split("\n").filter((l) => l.startsWith("::error"));
      expect(errors, reason).toHaveLength(1);
      expect(errors[0]).toContain("::error title=build memory cap::cannot cap the build memory: ");
      expect(errors[0]).toContain(reason);
    }
  });
});
