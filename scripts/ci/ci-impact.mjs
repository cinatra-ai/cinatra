#!/usr/bin/env node
/** Conservative CI impact selection. Unknown inputs retain the full gate set. */
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function selectCiImpact({ event, draft = false, files }) {
  const all = { unit: true, runtime: true, notifications: true, agents: true };
  const none = { unit: false, runtime: false, notifications: false, agents: false };
  let selected = { ...all };
  let reason = "non-PR events always retain every gate";
  if (event === "pull_request" && Array.isArray(files) && files.length > 0 && files.every((p) => typeof p === "string" && p.length > 0)) {
    selected = { ...none };
    reason = "only documented test or documentation paths changed";
    for (const path of files) {
      if (path.startsWith("docs/") || path.endsWith(".md")) continue;
      // These suites are independently wired, and are absent from the runtime
      // image's production build inputs. Configs/helpers outside these exact
      // roots deliberately fall through to all gates.
      if (/^tests\/e2e\/design\//.test(path)) continue;
      if (/^tests\/e2e\/notifications\//.test(path)) { selected.notifications = true; continue; }
      if (/^scripts\/(?:audit|ci)\/__tests__\/.*\.test\.mjs$/.test(path)) { selected.unit = true; continue; }
      selected = { ...all };
      reason = `full gates: runtime, shared, or unclassified input ${path}`;
      break;
    }
  } else if (event === "pull_request") {
    reason = "changed-file inventory missing or malformed; full gates";
  }
  return {
    skip: event === "pull_request" && (draft || !Object.values(selected).some(Boolean)),
    skip_unit: event === "pull_request" && (draft || !selected.unit),
    skip_feedback: !selected.unit,
    skip_runtime: event === "pull_request" && (draft || !selected.runtime),
    skip_notifications: event === "pull_request" && (draft || !selected.notifications),
    skip_agents: !selected.agents,
    reason,
  };
}

/** Read all changed paths at the event's frozen head, including rename sources.
 * GitHub caps this endpoint at 3000 files. Missing/truncated/stale inventories
 * deliberately return undefined, which selects every gate.
 */
export async function changedPrPaths({ event, repository, request }) {
  const pr = event?.pull_request;
  if (!pr || !Number.isInteger(pr.number) || !pr.head?.sha || !pr.base?.sha || !/^[^/]+\/[^/]+$/.test(repository ?? "")) return undefined;
  const url = `/repos/${repository}/pulls/${pr.number}`;
  const before = await request(url);
  if (before.head?.sha !== pr.head.sha || before.base?.sha !== pr.base.sha || !Number.isInteger(before.changed_files) || before.changed_files < 1 || before.changed_files > 3000) return undefined;
  const paths = [];
  let seen = 0;
  for (let page = 1; seen < before.changed_files; page += 1) {
    const rows = await request(`${url}/files?per_page=100&page=${page}`);
    if (!Array.isArray(rows) || rows.length === 0 || rows.length > 100) return undefined;
    for (const row of rows) {
      if (typeof row.filename !== "string" || !row.filename || !["added", "modified", "removed", "renamed", "copied", "changed", "unchanged"].includes(row.status)) return undefined;
      paths.push(row.filename);
      if (row.status === "renamed") {
        if (typeof row.previous_filename !== "string" || !row.previous_filename) return undefined;
        paths.push(row.previous_filename);
      }
    }
    seen += rows.length;
  }
  const after = await request(url);
  if (seen !== before.changed_files || after.head?.sha !== pr.head.sha || after.base?.sha !== pr.base.sha || after.changed_files !== before.changed_files) return undefined;
  return [...new Set(paths)];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let files;
  if (process.env.GITHUB_EVENT_NAME === "pull_request") {
    try {
      const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
      files = await changedPrPaths({ event, repository: process.env.GITHUB_REPOSITORY, request: async (path) => {
        const response = await fetch(`${process.env.GITHUB_API_URL ?? "https://api.github.com"}${path}`, {
          headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: "application/vnd.github+json" },
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) throw new Error(`changed-file request failed (${response.status})`);
        return response.json();
      } });
    } catch { console.warn("Changed-file inventory unavailable; selecting full verification."); }
  }
  const plan = selectCiImpact({ event: process.env.GITHUB_EVENT_NAME, draft: process.env.CI_PR_DRAFT === "true", files });
  for (const [key, value] of Object.entries(plan)) {
    if (key !== "reason" && process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
  console.log(JSON.stringify(plan));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `CI selection: ${JSON.stringify(plan)}\n`);
}
