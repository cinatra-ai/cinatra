// Per-job service-container port isolation (cinatra#3267).
//
// THE FAILURE CLASS. Every job in the two runner-heavy workflows that declares a
// postgres or a redis service container used to publish it on a FIXED host port
// (`- 5432:5432`, `- 6379:6379`) and read it back from a hard-coded
// `127.0.0.1:5432` / `127.0.0.1:6379` URL. On a hosted runner that is harmless —
// one job owns the whole machine. On a SELF-HOSTED runner it is not: two such
// jobs scheduled onto one box race for the same two host ports, the second
// container fails to bind, and the class can only ever be carried by a single
// runner. That is the ceiling this invariant removes.
//
// THE INVARIANT. A `services:` port entry names the CONTAINER port alone
// (`- "5432"`), which makes the runner publish a RANDOM free host port, and every
// consumer reads that mapped port out of the `job.services.<id>.ports` context.
// The `job` context is NOT available in a job-level `env:` block, so a job-level
// URL is exported to `$GITHUB_ENV` from the job's first step instead.
//
// This file is the guard. The pure helpers below are unit-tested on synthetic
// text; the LIVE enforcement block at the bottom runs them against THIS repo's
// two real workflow files inside the root Vitest suite (the gate of record), so
// re-pinning a fixed host port — or re-hard-coding a service URL — reds a
// required check instead of silently re-introducing the collision.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");

/** The two workflows that declare postgres/redis service containers. */
export const SERVICE_WORKFLOWS = [
  ".github/workflows/build-image.yml",
  ".github/workflows/e2e-app-suites.yml",
];

/**
 * Every entry inside a `services: ... ports:` list, classified.
 *
 * `fixed` entries are `HOST:CONTAINER` mappings (the collision shape).
 * `containerOnly` entries name the container port alone (the random-host-port
 * shape). Deliberately line-based rather than a YAML load: the guard has to be
 * able to point at the offending LINE, and these files carry expression syntax
 * a strict loader would have to be taught about anyway.
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
    if (raw.trim().startsWith("#") && /^\s*/.exec(raw)[0].length > portsIndent) return;

    const item = /^(\s*)-\s*(.*)$/.exec(raw);
    if (!item || item[1].length <= portsIndent) {
      portsIndent = -1;
      return;
    }

    const value = item[2].trim().replace(/^['"]|['"]$/g, "");
    const mapped = /^(\d+):(\d+)$/.exec(value);
    if (mapped) {
      fixed.push({ line: lineNumber, entry: value, hostPort: mapped[1], containerPort: mapped[2] });
      return;
    }
    if (/^\d+$/.test(value)) containerOnly.push({ line: lineNumber, entry: value });
  });

  return { fixed, containerOnly };
}

/**
 * `docker run -p [ADDR:]HOST:5432` (or `:6379`) — the same fixed publication,
 * one layer down. A step-run container is the documented escape hatch from
 * `services:` (a container that must bind-mount a checked-out file), so the
 * guard has to cover it too. `-p 127.0.0.1::5432` — an empty host port — is the
 * random-port form and is NOT a finding.
 */
export function findFixedDockerRunPublications(text) {
  const hits = [];
  text.split("\n").forEach((raw, index) => {
    const match = /-p\s+(?:\d+\.\d+\.\d+\.\d+:)?(\d+):(5432|6379)\b/.exec(raw);
    if (match) hits.push({ line: index + 1, hostPort: match[1], containerPort: match[2] });
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
          - 5432:5432
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
    expect(fixed[0]).toMatchObject({ entry: "5432:5432", hostPort: "5432", containerPort: "5432" });
    expect(containerOnly.map((e) => e.entry)).toEqual(["6379"]);
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

describe("LIVE enforcement (cinatra#3267)", () => {
  const read = (rel) => readFileSync(path.join(REPO_ROOT, rel), "utf8");

  it("no service container publishes a FIXED host port (concurrent jobs on one runner never share 5432 or 6379)", () => {
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
    for (const rel of SERVICE_WORKFLOWS) {
      const { containerOnly } = classifyServicePortEntries(read(rel));
      expect(containerOnly.length).toBeGreaterThan(0);
      for (const entry of containerOnly) {
        expect(["5432", "6379"]).toContain(entry.entry);
      }
    }
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
