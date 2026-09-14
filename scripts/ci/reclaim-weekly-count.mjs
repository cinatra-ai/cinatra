#!/usr/bin/env node
// The weekly reclaim count (cinatra#3316, item 3).
//
// WHY: the guarded re-run watcher (scripts/ci/hosted-reclaim-rerun.mjs) turns a
// reclaimed build job green again on its own. That silence is the point — and
// the reason the reclaim rate would otherwise stop being visible. The routing
// of the build class is meant to be decided on numbers, so the count has to be
// written down somewhere a person reads.
//
// WHERE THE NUMBERS COME FROM: the watcher's OWN records, never a scrape of run
// logs. Every re-run the watcher issues uploads one ledger artifact whose NAME
// carries the whole record (see `ledgerArtifactName` in the watcher module), so
// a count needs the artifacts LISTING alone — no download, no unzip, and no
// dependency on an artifact's retention having kept its bytes.
//
// THE WINDOW is fixed and in UTC: Monday 00:00 through Sunday 24:00, i.e. the
// last COMPLETE week before the scheduled run. Half-open [start, end): the
// Sunday-24:00 instant belongs to the next week, so no record is ever counted
// twice by two consecutive postings.
//
// ONE ENTRY PER JOB ID, SECOND ATTEMPTS COUNTED SEPARATELY: the deduplication
// key is job id plus attempt. A watcher run that uploaded the same record twice
// (a re-delivered event) collapses; a genuine second attempt of the same job
// does not.
//
// It posts ONE comment on the tracking issue. When the count is zero it posts
// the single line 'no reclaimed jobs this week' and nothing else.
//
// Pre-install-safe: node builtins only.

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  LEDGER_NAME_PREFIX,
  parseLedgerArtifactName,
} from "./hosted-reclaim-rerun.mjs";

/** The issue the count is appended to. */
export const TRACKING_ISSUE = 3267;

/** The line posted when the window holds no reclaimed job at all. */
export const EMPTY_WEEK_LINE = "no reclaimed jobs this week";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The last COMPLETE Monday-00:00 → Sunday-24:00 UTC week before `now`.
 *
 * @param {Date|string|number} now
 * @returns {{start: Date, end: Date}} half-open [start, end)
 */
export function lastCompleteWeek(now) {
  const at = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(at.getTime())) {
    throw new Error(`lastCompleteWeek: unusable instant ${String(now)}`);
  }
  // getUTCDay: 0 = Sunday. Monday-based index: Monday -> 0 ... Sunday -> 6.
  const mondayIndex = (at.getUTCDay() + 6) % 7;
  const thisMonday = Date.UTC(
    at.getUTCFullYear(),
    at.getUTCMonth(),
    at.getUTCDate(),
  ) - mondayIndex * DAY_MS;
  return {
    start: new Date(thisMonday - 7 * DAY_MS),
    end: new Date(thisMonday),
  };
}

/** `2026-09-01T00:00:00Z` -> `2026-09-01`. */
export const isoDay = (d) => new Date(d).toISOString().slice(0, 10);

/**
 * Count the watcher's ledger records that fall in [start, end).
 *
 * @param {object} input
 * @param {{name: string, created_at: string}[]} input.artifacts the artifacts
 *        listing as the API returns it (foreign artifacts are ignored).
 * @param {Date|string} input.start
 * @param {Date|string} input.end
 * @param {string} [input.runner] when given, only records made on that runner
 *        label are counted (the larger-runner trial reads the same records).
 * @returns {{total: number, perWorkflow: {workflow: string, count: number}[],
 *            entries: {workflow: string, jobId: string, attempt: number,
 *                      runner: string, at: string}[]}}
 */
export function countReclaims({ artifacts, start, end, runner }) {
  const from = new Date(start).getTime();
  const to = new Date(end).getTime();
  if (Number.isNaN(from) || Number.isNaN(to)) {
    throw new Error("countReclaims: the window bounds must be readable instants");
  }

  const seen = new Set();
  const entries = [];
  for (const artifact of Array.isArray(artifacts) ? artifacts : []) {
    const record = parseLedgerArtifactName(artifact && artifact.name);
    if (!record) continue;
    const at = new Date(artifact.created_at).getTime();
    if (Number.isNaN(at) || at < from || at >= to) continue;
    if (runner && record.runner !== runner) continue;
    // One entry per job id; a second attempt is a record of its own.
    const key = `${record.jobId}.${record.attempt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ ...record, at: new Date(at).toISOString() });
  }

  entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  const byWorkflow = new Map();
  for (const entry of entries) {
    byWorkflow.set(entry.workflow, (byWorkflow.get(entry.workflow) ?? 0) + 1);
  }
  const perWorkflow = [...byWorkflow.entries()]
    .map(([workflow, count]) => ({ workflow, count }))
    .sort((a, b) => b.count - a.count || a.workflow.localeCompare(b.workflow));

  return { total: entries.length, perWorkflow, entries };
}

/**
 * The comment body. Zero reclaims posts one line and nothing else.
 *
 * @param {{start: Date|string, end: Date|string,
 *          counted: ReturnType<typeof countReclaims>}} input
 * @returns {string}
 */
export function renderWeeklyComment({ start, end, counted }) {
  if (counted.total === 0) return EMPTY_WEEK_LINE;
  const lines = [
    `**Hosted-runner reclaims, ${isoDay(start)} Monday 00:00 UTC through ${isoDay(
      new Date(new Date(end).getTime() - DAY_MS),
    )} Sunday 24:00 UTC:** ${counted.total}`,
    "",
    "| workflow | reclaimed jobs |",
    "| --- | --- |",
  ];
  for (const row of counted.perWorkflow) {
    lines.push(`| ${row.workflow} | ${row.count} |`);
  }
  lines.push("", "One entry per job id; a second attempt is counted separately.");
  lines.push(
    "Counted from the re-run watcher's own records, not from run logs.",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The thin runner: list the artifacts, count the window, post one comment.
// ---------------------------------------------------------------------------

const API = process.env.GITHUB_API_URL || "https://api.github.com";
const REPOSITORY = "cinatra-ai/cinatra";

const headers = (token) => ({
  accept: "application/vnd.github+json",
  authorization: `Bearer ${token}`,
  "x-github-api-version": "2022-11-28",
  "user-agent": "cinatra-reclaim-weekly-count",
});

/**
 * Every artifact of the repository, paged. The listing is the ledger, so this
 * reads names and creation instants only.
 */
export async function listArtifacts(token, doFetch = fetch) {
  const out = [];
  for (let page = 1; page <= 20; page += 1) {
    const url = `${API}/repos/${REPOSITORY}/actions/artifacts?per_page=100&page=${page}`;
    const res = await doFetch(url, { headers: headers(token) });
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
    const body = await res.json();
    const batch = Array.isArray(body.artifacts) ? body.artifacts : [];
    for (const artifact of batch) {
      if (typeof artifact.name === "string" && artifact.name.startsWith(LEDGER_NAME_PREFIX)) {
        out.push({ name: artifact.name, created_at: artifact.created_at });
      }
    }
    if (batch.length < 100) break;
  }
  return out;
}

export async function main({ now = new Date(), doFetch = fetch } = {}) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is not set");

  const { start, end } = lastCompleteWeek(now);
  const artifacts = await listArtifacts(token, doFetch);
  const counted = countReclaims({ artifacts, start, end });
  const body = renderWeeklyComment({ start, end, counted });

  process.stdout.write(`${body}\n`);

  const url = `${API}/repos/${REPOSITORY}/issues/${TRACKING_ISSUE}/comments`;
  const res = await doFetch(url, {
    method: "POST",
    headers: { ...headers(token), "content-type": "application/json" },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`POST ${url} -> ${res.status} ${text.slice(0, 400)}`);
  }
  return { start, end, counted, body };
}

const invoked =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch((error) => {
    console.error(
      `::error::reclaim-weekly-count: ${error && error.message ? error.message : error}`,
    );
    process.exit(1);
  });
}
