// Per-job service-container port isolation (cinatra#3267).
//
// THE FAILURE CLASS. Every job that declares a postgres or a redis service
// container used to publish it on a FIXED host port (`- 5432:5432`,
// `- 5434:5432`, `- 127.0.0.1:6379:6379`) and read it back from a hard-coded
// `127.0.0.1:5434` / `127.0.0.1:6379` URL; two `docker run` steps pinned a
// loopback port the same way. On a hosted runner that is harmless — one job
// owns the whole machine. On a SELF-HOSTED runner it is not: two such jobs
// scheduled onto one box race for the same host ports, the second container
// fails to bind at "Initialize containers" with "port is already allocated",
// and the class can only ever be carried by a single runner. That is the
// ceiling this invariant removes.
//
// THE INVARIANT. A `services:` port entry names the CONTAINER port alone
// (`- "5432"`), which makes the runner publish a RANDOM free host port, and every
// consumer reads that mapped port out of the `job.services.<id>.ports` context.
// The `job` context is NOT available in a job-level `env:` block, so a job-level
// URL is exported to `$GITHUB_ENV` from the job's first step instead. A
// step-run container takes the same shape one layer down: `-p 127.0.0.1::4873`
// publishes a random host port, read back with `docker port <name> 4873/tcp`.
//
// THE SAME CLASS, ONE FIELD OVER (cinatra#3332). A step-run container also
// carries a NAME, and a name can exist exactly once per MACHINE: two jobs
// starting `docker run --name agents-it-verdaccio` on one self-hosted box made
// the second die with `Conflict. The container name "/agents-it-verdaccio" is
// already in use` and exit 125, before it reached a single test. The invariant
// is the port one's twin: the name is DERIVED from the job's own identity (the
// run, the job and the attempt, with a random fallback off CI) by the single
// shared helper scripts/ci/job-scoped-name.sh, and every reference in the job —
// the run, the port read-back, the diagnostics dump and the cleanup — reads
// that one derived value, so a job removes only the container it created.
//
// This file is the guard. The pure helpers below are unit-tested on synthetic
// text; the LIVE enforcement block at the bottom runs them against EVERY
// workflow file in this repository inside the root Vitest suite (the gate of
// record), so re-pinning a fixed host port — or re-hard-coding a service URL —
// reds a required check instead of silently re-introducing the collision.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");

const WORKFLOWS_DIR = ".github/workflows";

/**
 * EVERY workflow file in this repository, enumerated from disk.
 *
 * Deliberately not a hand-kept list of "the files that have services today":
 * the collision class belongs to any job that publishes a container port, and
 * a hand-kept list silently stops guarding the moment someone adds a service
 * block to a sixth workflow (cinatra#3267).
 */
export const SERVICE_WORKFLOWS = readdirSync(path.join(REPO_ROOT, WORKFLOWS_DIR))
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .sort()
  .map((name) => `${WORKFLOWS_DIR}/${name}`);

/**
 * Every entry inside a `services: ... ports:` list, classified.
 *
 * `fixed` entries are `[ADDRESS:]HOST:CONTAINER` mappings (the collision
 * shape). `containerOnly` entries name the container port alone (the
 * random-host-port shape). Deliberately line-based rather than a YAML load:
 * the guard has to be able to point at the offending LINE, and these files
 * carry expression syntax a strict loader would have to be taught about
 * anyway.
 *
 * A YAML sequence may be indented one level in from its key or sit at the SAME
 * column as it — both styles are in this repository — so an entry ends the
 * list only when it is indented LESS than the `ports:` key itself.
 */
export function classifyServicePortEntries(text) {
  const fixed = [];
  const containerOnly = [];
  let portsIndent = -1;

  text.split("\n").forEach((raw, index) => {
    const lineNumber = index + 1;
    const portsHeader = /^(\s*)ports:\s*$/.exec(raw);
    if (portsHeader) {
      portsIndent = portsHeader[1].length;
      return;
    }
    if (portsIndent < 0) return;
    if (raw.trim() === "") return;
    // A comment nested inside the list belongs to the list, and must not be
    // read as the end of it — every entry these workflows carry is commented.
    if (raw.trim().startsWith("#") && /^\s*/.exec(raw)[0].length >= portsIndent) return;

    const item = /^(\s*)-\s*(.*)$/.exec(raw);
    if (!item || item[1].length < portsIndent) {
      portsIndent = -1;
      return;
    }

    const value = item[2].trim().replace(/^['"]|['"]$/g, "");
    const mapped = /^(?:(\d+\.\d+\.\d+\.\d+):)?(\d+):(\d+)$/.exec(value);
    if (mapped) {
      fixed.push({
        line: lineNumber,
        entry: value,
        hostAddress: mapped[1] ?? null,
        hostPort: mapped[2],
        containerPort: mapped[3],
      });
      return;
    }
    if (/^\d+$/.test(value)) containerOnly.push({ line: lineNumber, entry: value });
  });

  return { fixed, containerOnly };
}

/**
 * `docker run -p [ADDR:]HOST:CONTAINER` — the same fixed publication, one
 * layer down. A step-run container is the documented escape hatch from
 * `services:` (a container that must bind-mount a checked-out file), so the
 * guard has to cover it too, for EVERY container port and not just the two
 * database ones. `-p 127.0.0.1::4873` — an empty host port — is the
 * random-port form and is NOT a finding.
 */
export function findFixedDockerRunPublications(text) {
  const hits = [];
  text.split("\n").forEach((raw, index) => {
    const match = /-p\s+(?:\d+\.\d+\.\d+\.\d+:)?(\d+):(\d+)\b/.exec(raw);
    if (match) hits.push({ line: index + 1, hostPort: match[1], containerPort: match[2] });
  });
  return hits;
}

/**
 * `docker run ... --name <value>` — the NAME half of the collision class
 * (cinatra#3332).
 *
 * A literal value is a finding: it can be started once per machine, so the
 * second concurrent job dies at `docker run` with exit 125. A value carrying a
 * `$` is DERIVED (a shell variable holding the job-scoped name, or an Actions
 * `${{ }}` expression) and is not.
 *
 * `docker run`'s flags routinely wrap over several backslash-continued lines and
 * `--name` may sit on any of them, so the scan joins a continuation run and
 * reports the `docker run` line itself. Line-based, like every helper here: the
 * guard has to be able to point at the offending line.
 */
export function findFixedDockerRunNames(text) {
  const lines = text.split("\n");
  const hits = [];
  lines.forEach((raw, index) => {
    if (raw.trim().startsWith("#")) return;
    if (!/\bdocker\s+run\b/.test(raw)) return;
    let block = raw;
    let cursor = index;
    while (/\\\s*$/.test(lines[cursor] ?? "") && cursor + 1 < lines.length) {
      cursor += 1;
      block += `\n${lines[cursor]}`;
    }
    const match = /--name[=\s]+(\S+)/.exec(block);
    if (!match) return;
    const name = match[1].replace(/^['"]|['"]$/g, "");
    hits.push({ line: index + 1, name, derived: name.includes("$") });
  });
  return hits;
}

/**
 * Assignments of the three service URLs that point at a SERVICE container, with
 * whether they read the mapped port out of the `job.services` context.
 *
 * Matches both YAML (`REDIS_URL: redis://...`) and the `$GITHUB_ENV` export
 * shape (`echo "REDIS_URL=redis://..." >> "$GITHUB_ENV"`). Comment lines are
 * skipped — these files carry a lot of prose about this exact wiring. Only
 * SERVICE URLs are collected: build-only placeholder URLs (a `build:build`
 * credential naming a database no container ever serves) never touch a
 * container and are out of scope.
 */
export function findServiceUrlAssignments(text) {
  const found = [];
  text.split("\n").forEach((raw, index) => {
    if (raw.trim().startsWith("#")) return;
    // The rest of the LINE, not the next whitespace-delimited token: the
    // `$GITHUB_ENV` export shape carries spaces inside its `${{ }}` expression.
    const match = /\b(SUPABASE_DB_URL|CINATRA_TEST_DB_URL|REDIS_URL)\s*[:=]\s*(.+)$/.exec(raw);
    if (!match) return;
    const [, name, value] = match;
    const isService = value.includes("postgres:postgres@") || value.startsWith("redis://");
    if (!isService) return;
    found.push({
      line: index + 1,
      name,
      value,
      readsMappedPort: value.includes("job.services."),
    });
  });
  return found;
}

describe("classifyServicePortEntries", () => {
  it("flags a HOST:CONTAINER mapping and accepts a bare container port", () => {
    const text = `    services:
      postgres:
        image: postgres:18
        ports:
          - 5434:5432
        options: >-
          --health-cmd pg_isready
      redis:
        image: redis:8
        ports:
          - "6379"
        options: >-
          --health-cmd "redis-cli ping"
`;
    const { fixed, containerOnly } = classifyServicePortEntries(text);
    expect(fixed).toHaveLength(1);
    expect(fixed[0]).toMatchObject({ entry: "5434:5432", hostPort: "5434", containerPort: "5432" });
    expect(containerOnly.map((e) => e.entry)).toEqual(["6379"]);
  });

  it("flags an ADDRESS-prefixed mapping in the same-column sequence style", () => {
    // design-baselines-refresh.yml's generated style: the sequence sits at the
    // SAME column as its `ports:` key, and the entry carries a bind address.
    const text = `    services:
      postgres:
        image: postgres:18
        ports:
        - 127.0.0.1:5434:5432
        options: "--health-cmd pg_isready"
`;
    const { fixed } = classifyServicePortEntries(text);
    expect(fixed).toHaveLength(1);
    expect(fixed[0]).toMatchObject({
      entry: "127.0.0.1:5434:5432",
      hostAddress: "127.0.0.1",
      hostPort: "5434",
      containerPort: "5432",
    });
  });

  it("accepts a bare container port in the same-column sequence style", () => {
    const text = `        ports:
        - "5432"
        options: "--health-cmd pg_isready"
`;
    const { fixed, containerOnly } = classifyServicePortEntries(text);
    expect(fixed).toEqual([]);
    expect(containerOnly.map((e) => e.entry)).toEqual(["5432"]);
  });

  it("reads past a comment nested inside the ports list", () => {
    const text = `        ports:
          # the runner picks a free host port
          - "5432"
        options: >-
          --health-cmd pg_isready
`;
    const { fixed, containerOnly } = classifyServicePortEntries(text);
    expect(fixed).toEqual([]);
    expect(containerOnly.map((e) => e.entry)).toEqual(["5432"]);
  });

  it("stops reading at the end of the ports list (a later mapping-shaped line is not an entry)", () => {
    const text = `        ports:
          - "5432"
    env:
      SOME_RANGE: 5432:5432
`;
    expect(classifyServicePortEntries(text).fixed).toEqual([]);
  });
});

describe("findFixedDockerRunPublications", () => {
  it("flags a pinned host port and accepts the empty-host-port form", () => {
    expect(findFixedDockerRunPublications("docker run -d -p 5432:5432 postgres:18\n")).toHaveLength(1);
    expect(findFixedDockerRunPublications("docker run -d -p 127.0.0.1:6379:6379 redis:8\n")).toHaveLength(1);
    expect(findFixedDockerRunPublications("docker run -d -p 127.0.0.1::5432 postgres:18\n")).toEqual([]);
  });

  it("covers container ports beyond the two database ones", () => {
    expect(findFixedDockerRunPublications("docker run -d -p 127.0.0.1:4873:4873 verdaccio\n")).toHaveLength(1);
    expect(findFixedDockerRunPublications("docker run -d -p 127.0.0.1:3010:3010 runtime\n")).toHaveLength(1);
    expect(findFixedDockerRunPublications("docker run -d -p 127.0.0.1::4873 verdaccio\n")).toEqual([]);
    expect(findFixedDockerRunPublications("docker run -d -p 127.0.0.1::3010 runtime\n")).toEqual([]);
  });
});

describe("findServiceUrlAssignments", () => {
  it("collects service URLs, skips comments and build-only placeholders", () => {
    const text = `      # SUPABASE_DB_URL: postgresql://postgres:postgres@127.0.0.1:5432/postgres
      SUPABASE_DB_URL: postgresql://build:build@127.0.0.1:5432/build
      REDIS_URL: redis://127.0.0.1:6379
`;
    const found = findServiceUrlAssignments(text);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ name: "REDIS_URL", readsMappedPort: false });
  });

  it("recognises the $GITHUB_ENV export shape as reading the mapped port", () => {
    const text = `          echo "REDIS_URL=redis://127.0.0.1:\${{ job.services.redis.ports['6379'] }}" >> "$GITHUB_ENV"\n`;
    expect(findServiceUrlAssignments(text)[0].readsMappedPort).toBe(true);
  });
});

describe("findFixedDockerRunNames", () => {
  it("flags a literal name and accepts a derived one", () => {
    expect(findFixedDockerRunNames("docker run -d --name agents-it-verdaccio verdaccio\n")).toMatchObject([
      { line: 1, name: "agents-it-verdaccio", derived: false },
    ]);
    expect(findFixedDockerRunNames('docker run -d --name "$VERDACCIO_CONTAINER" verdaccio\n')).toMatchObject([
      { line: 1, name: "$VERDACCIO_CONTAINER", derived: true },
    ]);
  });

  it("finds --name on a backslash-continued line and reports the docker run line", () => {
    const text = ['docker run -d \\', '  --name agents-it-verdaccio \\', '  verdaccio:6', ''].join("\n");
    expect(findFixedDockerRunNames(text)).toMatchObject([{ line: 1, name: "agents-it-verdaccio", derived: false }]);
  });

  it("ignores a commented-out example and a docker run with no name at all", () => {
    expect(findFixedDockerRunNames("          # docker run --name agents-it-verdaccio\n")).toEqual([]);
    expect(findFixedDockerRunNames("docker run --rm postgres:18 psql\n")).toEqual([]);
  });
});

describe("scripts/ci/job-scoped-name.sh (cinatra#3332)", () => {
  const helper = path.join(REPO_ROOT, "scripts/ci/job-scoped-name.sh");
  // Executed DIRECTLY, not through `bash <file>`: the workflow invokes it as a
  // program, so the executable bit is part of the contract under test.
  const run = (env, base = "agents-it-verdaccio") =>
    execFileSync(helper, [base], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } }).trim();

  it("derives the name from the run, the job and the attempt", () => {
    expect(run({ GITHUB_RUN_ID: "42", GITHUB_JOB: "agents-integration-db", GITHUB_RUN_ATTEMPT: "2" })).toBe(
      "agents-it-verdaccio-42-agents-integration-db-2",
    );
    // A re-run of the SAME job is a different attempt — the collision the
    // default branch actually hit was two attempts of one run on one box.
    expect(run({ GITHUB_RUN_ID: "42", GITHUB_JOB: "agents-integration-db", GITHUB_RUN_ATTEMPT: "3" })).not.toBe(
      run({ GITHUB_RUN_ID: "42", GITHUB_JOB: "agents-integration-db", GITHUB_RUN_ATTEMPT: "2" }),
    );
  });

  it("separates two concurrent legs of ONE matrix job (they share run, job and attempt)", () => {
    // GITHUB_JOB is the job's YAML id, not the matrix leg, so run+job+attempt
    // is identical across the legs of one matrix. RUNNER_NAME is what differs:
    // a runner executes one job at a time, so two jobs running at the same
    // moment are always on two different runners.
    const identity = { GITHUB_RUN_ID: "42", GITHUB_JOB: "works-after", GITHUB_RUN_ATTEMPT: "1" };
    const legA = run({ ...identity, RUNNER_NAME: "cinatra-ci-1" });
    const legB = run({ ...identity, RUNNER_NAME: "cinatra-ci-2" });
    expect(legA).not.toBe(legB);
    expect(legA).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
    expect(legB).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
  });

  it("falls back to a random suffix when there is no job identity", () => {
    const first = run({});
    const second = run({});
    expect(first).toMatch(/^agents-it-verdaccio-local-\d+-\d+$/);
    expect(second).not.toBe(first);
  });

  it("prints a name docker accepts, whatever the environment carries", () => {
    expect(run({ GITHUB_RUN_ID: "42", GITHUB_JOB: "a/b c", GITHUB_RUN_ATTEMPT: "1" })).toMatch(
      /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/,
    );
  });
});

describe("LIVE enforcement (cinatra#3267)", () => {
  const read = (rel) => readFileSync(path.join(REPO_ROOT, rel), "utf8");

  it("enumerates every workflow file in the repository", () => {
    expect(SERVICE_WORKFLOWS.length).toBeGreaterThan(10);
    expect(SERVICE_WORKFLOWS).toContain(".github/workflows/build-image.yml");
    expect(SERVICE_WORKFLOWS).toContain(".github/workflows/e2e-app-suites.yml");
  });

  it("no service container publishes a FIXED host port (concurrent jobs on one runner never share a port)", () => {
    const problems = [];
    for (const rel of SERVICE_WORKFLOWS) {
      const text = read(rel);
      for (const hit of classifyServicePortEntries(text).fixed) {
        problems.push(`${rel}:${hit.line} publishes a fixed host port (${hit.entry})`);
      }
      for (const hit of findFixedDockerRunPublications(text)) {
        problems.push(`${rel}:${hit.line} docker run pins host port ${hit.hostPort} for container port ${hit.containerPort}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("every declared service still publishes its container port", () => {
    const declared = [];
    for (const rel of SERVICE_WORKFLOWS) {
      for (const entry of classifyServicePortEntries(read(rel)).containerOnly) {
        declared.push({ rel, ...entry });
      }
    }
    // The repository does declare service containers — a guard that passes
    // because it found nothing to guard is not a guard.
    expect(declared.length).toBeGreaterThan(0);
    for (const entry of declared) {
      expect(["5432", "6379"]).toContain(entry.entry);
    }
  });

  // The `docker run --name` values in this repository that are still fixed. A
  // RATCHET, not an exemption: the assertion below fails when a listed name is
  // no longer there, so a fix must delete its row, and a NEW fixed name can
  // never be added without editing this list in the same diff.
  //
  // validate-agents.yml's `wayflow-mount-guard` is the same class on the same
  // self-hosted pool and is left to its own change: its name is threaded
  // through a dozen `docker exec` steps across that job, which is a bigger
  // edit than the disposable-Verdaccio one this guard was written for
  // (cinatra#3332 scopes itself to the Verdaccio step).
  const KNOWN_FIXED_CONTAINER_NAMES = [
    { workflow: ".github/workflows/validate-agents.yml", name: "wayflow-mount-guard" },
  ];

  it("no docker run pins a fixed container name (concurrent jobs on one runner never share a name)", () => {
    const problems = [];
    const matchedKnown = new Set();
    for (const rel of SERVICE_WORKFLOWS) {
      for (const hit of findFixedDockerRunNames(read(rel))) {
        if (hit.derived) continue;
        const knownIndex = KNOWN_FIXED_CONTAINER_NAMES.findIndex((e) => e.workflow === rel && e.name === hit.name);
        if (knownIndex >= 0) {
          matchedKnown.add(knownIndex);
          continue;
        }
        problems.push(`${rel}:${hit.line} docker run pins the fixed container name ${hit.name}`);
      }
    }
    expect(problems).toEqual([]);
    // The carve-out may only shrink.
    expect(matchedKnown.size).toBe(KNOWN_FIXED_CONTAINER_NAMES.length);
  });

  it("the disposable Verdaccio is named per job and every reference reads that one name (cinatra#3332)", () => {
    const rel = ".github/workflows/build-image.yml";
    const text = read(rel);

    // The name comes from the ONE shared derivation, not a second copy of it.
    expect(text).toContain('VERDACCIO_CONTAINER="$("${GITHUB_WORKSPACE}/scripts/ci/job-scoped-name.sh" agents-it-verdaccio)"');
    // …and reaches the separate always() cleanup step through $GITHUB_ENV.
    expect(text).toContain('echo "AGENTS_IT_VERDACCIO_CONTAINER=${VERDACCIO_CONTAINER}" >> "$GITHUB_ENV"');
    expect(text).toContain('docker rm -fv "${AGENTS_IT_VERDACCIO_CONTAINER}"');

    // The variable the docker commands read is assigned ONCE, by the helper:
    // a later `VERDACCIO_CONTAINER=agents-it-verdaccio` would satisfy every
    // assertion above ("the value carries a $") while restoring the collision.
    const assignments = text
      .split("\n")
      .map((raw, index) => ({ line: index + 1, raw }))
      .filter(({ raw }) => !raw.trim().startsWith("#"))
      .filter(({ raw }) => /\b(AGENTS_IT_)?VERDACCIO_CONTAINER=/.test(raw))
      .filter(
        ({ raw }) =>
          !raw.includes('VERDACCIO_CONTAINER="$("${GITHUB_WORKSPACE}/scripts/ci/job-scoped-name.sh" agents-it-verdaccio)"') &&
          !raw.includes('echo "AGENTS_IT_VERDACCIO_CONTAINER=${VERDACCIO_CONTAINER}" >> "$GITHUB_ENV"'),
      )
      .map(({ line, raw }) => `${rel}:${line} ${raw.trim()}`);
    expect(assignments).toEqual([]);

    // No docker COMMAND anywhere in the file addresses the container by the
    // bare literal any more (the prose and the helper argument may still name
    // it — a comment cannot collide with anything).
    const literalCommands = text
      .split("\n")
      .map((raw, index) => ({ line: index + 1, raw }))
      .filter(({ raw }) => !raw.trim().startsWith("#"))
      .filter(({ raw }) => /\bdocker\s+(run|port|logs|rm|exec|inspect|stop)\b/.test(raw))
      .filter(({ raw }) => /(^|[\s"'])agents-it-verdaccio([\s"']|$)/.test(raw))
      .map(({ line }) => `${rel}:${line}`);
    expect(literalCommands).toEqual([]);
  });

  it("every service URL reads the mapped port out of the job.services context", () => {
    const problems = [];
    for (const rel of SERVICE_WORKFLOWS) {
      for (const hit of findServiceUrlAssignments(read(rel))) {
        if (!hit.readsMappedPort) problems.push(`${rel}:${hit.line} ${hit.name} hard-codes a port (${hit.value})`);
      }
    }
    expect(problems).toEqual([]);
  });
});
