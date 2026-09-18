// Path-guarded pull-request workflows — cinatra#3508.
//
// A pull-request workflow whose jobs read a bounded set of files runs those
// jobs only when the pull request touched something they read: a first
// `changes` job (the repository's own dorny/paths-filter pin) publishes one
// boolean per heavy job group, and every heavy job carries `needs:` on that
// job plus an `if:` on one of its outputs. A job skipped that way reports
// `skipped`, which branch protection counts as passing, so the required
// contexts keep concluding — unlike a `paths:` trigger filter, which leaves a
// required context "Expected" forever because the workflow never runs.
//
// This guard pins that SHAPE, file by file:
//
//   1. every conditional workflow carries a changed-path detector job at the
//      repository's own action pin, and every one of its filter lists covers a
//      change to the workflow files themselves, so editing a workflow always
//      runs it in full;
//   2. every other job in those workflows is gated on that detector — at job
//      level, at step level (the green-stub shape the required contexts use),
//      or transitively through a job that is — except the jobs listed here as
//      tree-wide, each with the reason its reading is the whole tree;
//   3. the four gates the `main` ruleset requires carry NO such guard: their
//      reading is the whole tree and they must run on every push.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseTriggers } from "../merge-group-coverage-guard.mjs";
// The workflow file the skills-drift check is called from is named through the
// derivation's own exported path constant ("exported so callers/tests need no
// literal"), so this file keeps no second copy of that name.
import { GATE_CALLER as SKILLS_DRIFT_GATE_CALLER } from "../skills-drift-watched-packages.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const WORKFLOWS_DIR = path.join(REPO_ROOT, ".github", "workflows");

/** The repository's OWN changed-files action pin — the only one allowed. */
const PATHS_FILTER_PIN = "dorny/paths-filter@ceb8a2b8f2d89434be7ff52d3de7ec3738c5cc9d";

/** Job ids that carry a workflow's changed-path detection. */
const DETECTOR_IDS = ["changes", "detect", "changed-paths"];

/**
 * The workflows whose heavy jobs are conditional on the changed paths. Each
 * must carry a detector job; every other job in it must be gated on that
 * detector unless it is listed in TREE_WIDE_JOBS below.
 */
const CONDITIONAL = [
  "build-image.yml",
  "codeql.yml",
  "crm-migration-gate.yml",
  "dashboard-live-verify.yml",
  "doc-code-value-gate.yml",
  "e2e-app-suites.yml",
  "gates.yml",
  "knip-report.yml",
  "mcp-route-gate.yml",
  "org-write-boundary-gate.yml",
  "works-after-proof.yml",
  "wp-drupal-rename-gate.yml",
  "wp-drupal-uat.yml",
];

/**
 * Jobs inside a conditional workflow that stay unconditional, and why. Each is
 * asserted to carry NO detector guard, so an exemption cannot be taken
 * silently: it is either listed here with its reason or it is guarded.
 */
const TREE_WIDE_JOBS = {
  "gates.yml": {
    gates: "pure-node micro-gates: the product-tree hygiene guard reads `git ls-files` and the docs-tree guard reads docs/ — the whole tracked tree is its input",
    "design-pin-drift": "reads the pull request's own touched-path set against the design pin maps — every path is its input",
    "design-pin-freshness": "sibling of design-pin-drift on the same touched-path set",
    "design-anchor-resolution": "sibling of design-pin-drift on the same touched-path set",
    "design-record-grammar": "sibling of design-pin-drift on the same touched-path set",
  },
};

/**
 * Workflows outside the ruleset four that stay unconditional too, each with the
 * reason the pull request's file set does not predict them. Asserted so an
 * omission from CONDITIONAL is a recorded decision, never an oversight.
 */
const CALLER_CONTEXT_REASON =
  "a reusable-workflow caller whose `<caller> / <called>` context branch protection requires: a SKIPPED caller posts no such check run at all, so a path guard here leaves the required context waiting forever";

const UNCONDITIONAL = {
  [path.basename(SKILLS_DRIFT_GATE_CALLER)]: CALLER_CONTEXT_REASON,
  "toast-banner-gate.yml": CALLER_CONTEXT_REASON,
  "ui-design-system-gate.yml": CALLER_CONTEXT_REASON,
  "secrets-required-gate.yml":
    "a live-config drift probe: it reads the repository's configured secrets against the pinned manifest, never a file in the diff, so no path list could predict when it must run",
  "truthful-attribution-gate.yml": "reads the candidate's commit records, not the tree",
  "merge-readiness.yml": "reads the candidate's own check runs, not the tree",
};

/** The gates the `main` ruleset requires: unconditional, whole-tree readers. */
const RULESET_GATES = [
  "actions-pinned-gate.yml",
  "gitignore-gate.yml",
  "source-leak-gate.yml",
  "secret-scan-gate.yml",
];

const read = (file) => fs.readFileSync(path.join(WORKFLOWS_DIR, file), "utf8");
const workflowFiles = () => fs.readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f));

/** Split a workflow's `jobs:` block into {job id -> the job's own lines}. */
function parseJobBlocks(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^jobs:\s*(#.*)?$/.test(l));
  const jobs = new Map();
  if (start === -1) return jobs;
  let current = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() !== "" && /^\S/.test(line)) break; // next top-level section
    const head = line.match(/^ {2}(['"]?)([A-Za-z_][\w-]*)\1:\s*(#.*)?$/);
    if (head) {
      current = [];
      jobs.set(head[2], current);
      continue;
    }
    if (current) current.push(line);
  }
  return new Map([...jobs].map(([id, body]) => [id, body.join("\n")]));
}

/** The job-level `if:` (jobs are two-space keys, so their own keys are four). */
const jobIf = (body) => body.match(/^ {4}if:\s*(.+)$/m)?.[1]?.trim() ?? null;

/** The job-level `needs:`, inline (`a`) or flow-list (`[a, b]`) form. */
function jobNeeds(body) {
  const inline = body.match(/^ {4}needs:\s*(.+)$/m);
  if (!inline) return [];
  const value = inline[1].trim().replace(/\s+#.*$/, "");
  const raw = value.startsWith("[") ? value.replace(/^\[|\]$/g, "").split(",") : [value];
  return raw.map((s) => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
}

/** The `filters: |` block of a detector job, as {key -> path globs}. */
function filterLists(body) {
  const head = body.match(/^( +)filters:\s*\|\s*$/m);
  if (!head) return null;
  const blockIndent = head[1].length;
  const rest = body.slice(head.index + head[0].length).split("\n").slice(1);
  const lists = new Map();
  let key = null;
  for (const line of rest) {
    if (line.trim() === "") continue;
    const indent = line.match(/^ */)[0].length;
    if (indent <= blockIndent) break;
    if (line.trim().startsWith("#")) continue;
    const keyLine = line.match(/^ +([A-Za-z_][\w-]*):\s*$/);
    if (keyLine) {
      key = keyLine[1];
      lists.set(key, []);
      continue;
    }
    const item = line.match(/^\s*-\s*'([^']*)'\s*$/) ?? line.match(/^\s*-\s*"([^"]*)"\s*$/);
    if (item && key) lists.get(key).push(item[1]);
  }
  return lists;
}

/**
 * A list covers a change to the workflow files when it names them explicitly
 * (`.github/workflows/**` or this workflow's own file) or is a catch-all whose
 * negations cannot exclude a workflow file.
 */
function coversWorkflowFiles(globs, file) {
  if (globs.includes(".github/workflows/**")) return true;
  if (globs.includes(`.github/workflows/${file}`)) return true;
  const negations = globs.filter((g) => g.startsWith("!"));
  return globs.includes("**") && !negations.some((g) => /\.github|\.ya?ml/.test(g));
}

/** The detector jobs of a workflow: a job id we know, running the pinned action. */
function detectorsOf(jobs) {
  return [...jobs]
    .filter(([id, body]) => DETECTOR_IDS.includes(id) && body.includes("dorny/paths-filter@"))
    .map(([id]) => id);
}

/** A job reads a detector's outputs (job-level `if:` or any step's own `if:`). */
const readsDetector = (body, detectors) =>
  detectors.some((d) => new RegExp(`needs(?:\\.${d}\\b|\\['${d}'\\]|\\["${d}"\\])`).test(body));

/** A job that only ever runs outside a pull request needs no path guard. */
function eventScoped(body) {
  const guard = jobIf(body);
  return Boolean(guard) && guard.includes("github.event_name") && !guard.includes("pull_request");
}

function isGuarded(id, jobs, detectors, seen = new Set()) {
  if (seen.has(id)) return false;
  seen.add(id);
  const body = jobs.get(id);
  if (body === undefined) return false;
  if (detectors.includes(id)) return true;
  if (eventScoped(body)) return true;
  const needs = jobNeeds(body);
  if (needs.some((n) => detectors.includes(n)) && readsDetector(body, detectors)) return true;
  // The transitive arm must not walk INTO a detector: a job that merely
  // declares `needs: [changes]` and reads none of its outputs runs on every
  // pull request, and the direct arm above already covers the real shape.
  return needs.some((n) => !detectors.includes(n) && isGuarded(n, jobs, detectors, seen));
}

describe("every conditional pull-request workflow carries its changed-path detector", () => {
  for (const file of CONDITIONAL) {
    const text = read(file);
    const jobs = parseJobBlocks(text);
    const detectors = detectorsOf(jobs);

    it(`${file} triggers on pull_request`, () => {
      expect(parseTriggers(text), `${file}: no parseable top-level on:`).toContain("pull_request");
    });

    it(`${file} has a changed-path detector job at the repository's action pin`, () => {
      expect(
        detectors,
        `${file}: no \`changes\` job running ${PATHS_FILTER_PIN} — its heavy jobs would run on every push`,
      ).not.toHaveLength(0);
      for (const id of detectors) {
        expect(jobs.get(id), `${file}: job \`${id}\` must use the repository's own pin`).toContain(
          PATHS_FILTER_PIN,
        );
      }
    });

    it(`${file} keeps every filter list covering a change to the workflow files`, () => {
      for (const id of detectors) {
        const lists = filterLists(jobs.get(id));
        expect(lists, `${file}: job \`${id}\` has no \`filters: |\` block`).not.toBeNull();
        expect([...lists.keys()], `${file}: job \`${id}\` declares no filter key`).not.toHaveLength(0);
        for (const [key, globs] of lists) {
          expect(
            coversWorkflowFiles(globs, file),
            `${file}: filter \`${key}\` does not cover a workflow-file change — editing ${file} would not run it`,
          ).toBe(true);
        }
      }
    });

    it(`${file} gates every other job on the detector`, () => {
      const exempt = TREE_WIDE_JOBS[file] ?? {};
      for (const [id] of jobs) {
        if (detectors.includes(id)) continue;
        if (id in exempt) {
          expect(
            readsDetector(jobs.get(id), detectors),
            `${file}: job \`${id}\` is listed as tree-wide (${exempt[id]}) but reads the detector — drop the exemption`,
          ).toBe(false);
          continue;
        }
        expect(
          isGuarded(id, jobs, detectors),
          `${file}: job \`${id}\` runs on every pull request — give it \`needs: [${detectors[0]}]\` and an \`if:\` on one of its outputs, or list it in TREE_WIDE_JOBS with the reason its reading is the whole tree`,
        ).toBe(true);
      }
    });
  }
});

describe("the gates the main ruleset requires stay unconditional", () => {
  for (const file of RULESET_GATES) {
    it(`${file} carries no changed-path guard`, () => {
      const text = read(file);
      expect(text, `${file}: reads the whole tree — it must not filter by path`).not.toContain(
        "dorny/paths-filter@",
      );
      const jobs = parseJobBlocks(text);
      for (const [id, body] of jobs) {
        expect(DETECTOR_IDS, `${file}: job \`${id}\` looks like a changed-path detector`).not.toContain(id);
        expect(
          /needs\.[A-Za-z_-]+\.outputs/.test(jobIf(body) ?? ""),
          `${file}: job \`${id}\` is gated on another job's output`,
        ).toBe(false);
      }
    });
  }
});

describe("the record and live-config readers stay unconditional", () => {
  for (const [file, reason] of Object.entries(UNCONDITIONAL)) {
    it(`${file} carries no changed-path guard (${reason})`, () => {
      const text = read(file);
      expect(text, `${file}: ${reason} — it must not filter by path`).not.toContain(
        "dorny/paths-filter@",
      );
      const jobs = parseJobBlocks(text);
      for (const [id, body] of jobs) {
        expect(DETECTOR_IDS, `${file}: job \`${id}\` looks like a changed-path detector`).not.toContain(id);
        expect(
          /needs\.[A-Za-z_-]+\.outputs/.test(jobIf(body) ?? ""),
          `${file}: job \`${id}\` is gated on another job's output`,
        ).toBe(false);
      }
    });
  }
});

describe("changed-path detection uses one pinned action", () => {
  it("every paths-filter in .github/workflows is the repository's own pin", () => {
    const offenders = [];
    for (const file of workflowFiles()) {
      const text = read(file);
      if (!text.includes("dorny/paths-filter@")) continue;
      for (const line of text.split("\n")) {
        const used = line.match(/dorny\/paths-filter@\S+/);
        if (used && used[0] !== PATHS_FILTER_PIN) offenders.push(`${file}: ${used[0]}`);
      }
    }
    expect(offenders, "a changed-files action must stay on the repository's own SHA pin").toEqual([]);
  });
});

/** The MCP route gate — the repository's own scanner of every tracked `.yml`. */
const MCP_ROUTE_GATE = path.join(
  REPO_ROOT,
  "scripts",
  "audit",
  "administration-mcp-machine-flow-banned.mjs",
);

/**
 * The MCP route gate's OWN banned-URL matcher, read out of the gate script
 * rather than copied: a second copy of that pattern here would itself be one of
 * the strings the gate bans (it opens every tracked `.mjs`), and it would drift
 * the day the gate's pattern changes.
 */
function mcpRouteGateBannedMatcher() {
  const source = fs.readFileSync(MCP_ROUTE_GATE, "utf8");
  const literal = source.match(/^const\s+BANNED_URL_RE\s*=\s*([\s\S]*?);\s*$/m)?.[1]?.trim();
  const parts = literal?.match(/^\/([\s\S]+)\/([a-z]*)$/);
  if (!parts) {
    throw new Error(
      `could not read BANNED_URL_RE out of ${path.relative(REPO_ROOT, MCP_ROUTE_GATE)} — the gate's pattern moved; re-point this guard at it`,
    );
  }
  return new RegExp(parts[1], parts[2]);
}

/** Every path glob of every detector job's filter lists, across the directory. */
function everyFilterGlob() {
  const out = [];
  for (const file of workflowFiles()) {
    const jobs = parseJobBlocks(read(file));
    for (const id of detectorsOf(jobs)) {
      for (const [key, globs] of filterLists(jobs.get(id)) ?? []) {
        for (const glob of globs) out.push({ file, job: id, key, glob });
      }
    }
  }
  return out;
}

describe("no changed-path list spells a route the repository's own gates ban", () => {
  it("every filter glob passes the MCP route gate's own matcher", () => {
    const banned = mcpRouteGateBannedMatcher();
    const globs = everyFilterGlob();
    expect(
      globs,
      "no detector job declares a filter list — this guard would pass vacuously",
    ).not.toHaveLength(0);
    const offenders = globs
      .filter(({ glob }) => banned.test(glob))
      .map(({ file, key, glob }) => `${file}: filter \`${key}\` names ${glob}`);
    expect(
      offenders,
      "a path list names what the workflow READS; it must not spell a route the MCP machine-flow gate bans — that gate scans .github/workflows too, so such a literal turns the gate red on the guard's own file. Name the namespace root instead.",
    ).toEqual([]);
  });
});
