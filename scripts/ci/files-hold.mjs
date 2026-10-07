#!/usr/bin/env node
// files-hold: a labelled pull request that waits for review holds its files.
//
// WHY. A pull request can pass its checks and its verification and then wait
// for review. If another pull request that changes some of the same files
// merges in that time, the waiting pull request's verification no longer holds
// for the tree its own merge would make. Nothing said that the two shared
// files. This status says it.
//
// THE RULES (see docs/internals/workflows/files-hold.md):
//   - The label LABEL goes on a pull request whose verification is complete at
//     its head and that waits for review. Such a pull request holds its files.
//   - The commit status CONTEXT is set on the head of every open pull request.
//     It fails when the pull request changes a file that a labelled pull request
//     changes too, and its description names that pull request and the first
//     shared paths. It succeeds otherwise. The files are each pull request's
//     own changed files as the platform lists them, a renamed file under both
//     its names; no file is left out.
//   - Between two labelled pull requests the one labelled first holds its
//     files against the other (equal times: the lower number holds).
//   - A push to a labelled pull request ends its hold: its verification was
//     made at the head it had. The label comes off, with one comment.
//   - A closed or merged pull request holds nothing and gets no status.
//   - FAIL CLOSED: a file list that cannot be read in full fails the status of
//     the pull request it concerns and says why. A labelled pull request whose
//     own file list, or the time of its label, cannot be read holds nothing,
//     and its own status says so.
//
// HOW. Two pure functions and two commands.
//   - `decide` maps the listings to the statuses; `scope` maps an event and the
//     holders to the pull requests the event evaluates. Both are unit-tested
//     without the network.
//   - `end-hold` runs first, on a push: when the pushed pull request carried
//     the label from before the push, it takes the label off and writes the one
//     comment. It makes no request for any other push or event.
//   - `evaluate` runs after it, one evaluation at a time for the repository.
//     An event that changes no holder (a pull request opened, reopened, pushed
//     or made ready for review without the label, a label event of another
//     label) evaluates its own pull request alone, against the holders, and
//     writes its status only. An event that changes the holders (the label set
//     or taken off; a labelled pull request closed, merged, reopened or
//     pushed) and a run by hand evaluate every open pull request.
//   - Whatever the event, the evaluation also takes in each head whose status
//     is missing or no longer fits the holders, so that an evaluation a newer
//     event replaced before it ran leaves nothing behind: a head without a
//     status; a holder whose status was set against other holders (each
//     status's link names the holders it was set against, as a fingerprint);
//     a status held by a pull request that holds nothing now; a status set
//     while no pull request held files, when one does; a status that
//     disagrees with the label on its pull request.
//   - It reads the open pull requests; the record, the file list and the label
//     time of each labelled one; the status each open head carries (one
//     GraphQL query); the record and the file list of each pull request it
//     evaluates; and the open pull requests once more just before it writes.
//     The platform lists at most FILES_LISTED_AT_MOST files of a pull request,
//     so a list is complete only when the rows read equal the record's
//     `changed_files`. While no pull request carries the label, no file list
//     is read: nothing is held.
//   - A status is written only when it changes (for a holder: also when the
//     holders changed): the platform keeps at most 1000 statuses per commit and
//     context and limits how fast content is created. A pull request pushed
//     while it was evaluated is not written: the run for the push writes it.
// It never reads a pull request's code: only the platform's listings. Paths
// are data: they reach a description only with control and direction
// characters replaced, and the comment carries none.
//
// Run by .github/workflows/files-hold.yml. Local use, reading only:
//   GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/name GITHUB_EVENT_NAME=pull_request_target \
//   GITHUB_EVENT_PATH=event.json node scripts/ci/files-hold.mjs evaluate --dry-run
// A dry run reads and decides, and writes nothing.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** The label a pull request carries while it holds its files. */
export const LABEL = "holds-files";
/** The commit status set on every open head. */
export const CONTEXT = "files-hold";
/** The platform refuses a status description longer than this. */
export const DESCRIPTION_LIMIT = 140;
/** The platform lists at most this many files of one pull request. */
export const FILES_LISTED_AT_MOST = 3000;
/** How many shared paths a description names before "and N more". */
export const PATHS_NAMED = 3;
/** The REST API version every request asks for. */
export const API_VERSION = "2026-03-10";

const PAGE = 100;
const OPEN_PAGES_AT_MOST = 50;
const EVENT_PAGES_AT_MOST = 100;
const STATUS_READS_PER_QUERY = 100;
/** A label just set may not be listed in the events at once: read again after this pause. */
const LABEL_EVENT_RETRY_MS = 5000;

export const NOTHING_HELD = "No labelled pull request holds files now.";
export const SHARES_NOTHING = "Changes no file that a labelled pull request holds.";
export const HOLDS = `Labelled ${LABEL}: holds its files against the other open pull requests.`;
export const LABEL_TIME_UNREAD = `Holds nothing: the time its ${LABEL} label was set could not be read.`;
const CUT_SHORT = "Its file list could not be read in full: ";
const CUT_SHORT_LABELLED = "Holds nothing: its file list could not be read in full: ";

/* ------------------------------------------------------------------ *
 * Descriptions
 * ------------------------------------------------------------------ */

// C0 and C1 controls (a path can hold a newline), and the characters that
// change the direction of the text around them.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/** A text from the platform, made safe to show on one line. */
export const clean = (text) => String(text).replace(UNSAFE, "?");

/** The start of `text`, at most `room` UTF-16 units, never half a character. */
function keepStart(text, room) {
  let out = "";
  for (const ch of text) {
    if (out.length + ch.length > room) break;
    out += ch;
  }
  return out;
}

/** The end of `text`, at most `room` UTF-16 units, never half a character. */
function keepEnd(text, room) {
  const chars = Array.from(text);
  let out = "";
  for (let i = chars.length - 1; i >= 0; i--) {
    if (out.length + chars[i].length > room) break;
    out = chars[i] + out;
  }
  return out;
}

/** `text` cut to the limit, with an ellipsis when something was cut. */
const fit = (text) =>
  text.length <= DESCRIPTION_LIMIT ? text : `${keepStart(text, DESCRIPTION_LIMIT - 1)}…`;

const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * "Held by #N: a, b, c and K more": the holder always, then as many of the
 * first three shared paths (in order) as fit, then how many were left out. A
 * single path too long to fit keeps its end, where the file name is.
 */
export function heldDescription(holder, sharedPaths) {
  const paths = [...new Set(sharedPaths)].sort(byCodeUnit).map(clean);
  if (!Number.isSafeInteger(holder) || paths.length === 0) {
    throw new TypeError("files-hold: a held description needs the holder and at least one shared path");
  }
  const prefix = `Held by #${holder}: `;
  const more = (n) => (n > 0 ? ` and ${n} more` : "");
  for (let named = Math.min(PATHS_NAMED, paths.length); named >= 1; named--) {
    const text = prefix + paths.slice(0, named).join(", ") + more(paths.length - named);
    if (text.length <= DESCRIPTION_LIMIT) return text;
  }
  const tail = more(paths.length - 1);
  return `${prefix}…${keepEnd(paths[0], DESCRIPTION_LIMIT - prefix.length - 1 - tail.length)}${tail}`;
}

/** Why a file list is not complete, for the pull request it concerns. */
export function cutShortDescription(reason, { labelled = false } = {}) {
  return fit((labelled ? CUT_SHORT_LABELLED : CUT_SHORT) + clean(reason || "not read"));
}

/** The holder a description names, or null. */
const heldByIn = (description) => {
  const m = /^Held by #(\d+): /.exec(description);
  return m ? Number(m[1]) : null;
};

/** Whether a description says its pull request carries the label: true, false, or null for neither. */
function saysLabelled(description) {
  if (description === HOLDS || description === LABEL_TIME_UNREAD || description.startsWith(CUT_SHORT_LABELLED)) return true;
  if (description === NOTHING_HELD || description === SHARES_NOTHING || description.startsWith(CUT_SHORT)) return false;
  return null;
}

/* ------------------------------------------------------------------ *
 * The decision (pure)
 * ------------------------------------------------------------------ */

const HEAD = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const isLabel = (name) => typeof name === "string" && name.toLowerCase() === LABEL;

/** A time from the platform as milliseconds, or null when there is none. */
function toTime(value) {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

const success = (description) => ({ state: "success", description });
const failure = (description) => ({ state: "failure", description });

/**
 * The open pull requests of a listing, whether each holds, and the holders in
 * the order they hold: the first labelled first, equal times by number. A
 * push ends the hold of the labelled pull request it moved, unless the label
 * was provably set after it.
 */
function classify(listing) {
  if (listing === null || typeof listing !== "object" || !Array.isArray(listing.pullRequests)) {
    throw new TypeError("files-hold: the listing carries no pull requests");
  }
  const pushed = listing.pushed ?? null;
  const endHolds = [];
  const pulls = [];
  for (const pr of listing.pullRequests) {
    if (!pr || !Number.isSafeInteger(pr.number) || pr.number <= 0 || typeof pr.head !== "string" || !HEAD.test(pr.head)) {
      throw new TypeError(`files-hold: pull request ${JSON.stringify(pr?.number ?? null)} of the listing has no number or no head`);
    }
    // A closed or merged pull request holds nothing and gets no status.
    if (pr.state !== "open" || pr.merged === true) continue;
    const label = (Array.isArray(pr.labels) ? pr.labels : []).find((l) => isLabel(l?.name));
    let labelled = Boolean(label);
    const labelAt = label ? toTime(label.at) : null;
    if (labelled && pushed && pushed.number === pr.number) {
      const pushedAt = toTime(pushed.at);
      if (!(labelAt !== null && pushedAt !== null && labelAt > pushedAt)) {
        labelled = false;
        endHolds.push({ number: pr.number, label: label.name });
      }
    }
    const files = pr.filesComplete === true && Array.isArray(pr.files) ? new Set(pr.files) : null;
    pulls.push({ pr, labelled, labelAt, files, problem: pr.filesProblem });
  }
  const holders = pulls
    .filter((e) => e.labelled && e.labelAt !== null && e.files !== null)
    .sort((a, b) => a.labelAt - b.labelAt || a.pr.number - b.pr.number);
  return { pulls, holders, endHolds };
}

const holderRecord = (e) => ({ number: e.pr.number, at: new Date(e.labelAt).toISOString(), head: e.pr.head });

/** The pull requests that hold their files, as { number, at, head }. */
export function holdersOf(listing) {
  return classify(listing).holders.map(holderRecord);
}

/** A short fingerprint of the holders: each one's number, label time and head, in any order. */
export function fingerprint(holders) {
  const rows = holders.map((h) => [h.number, h.at, h.head]).sort((a, b) => a[0] - b[0]);
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 12);
}

/**
 * One status per open head, from the listings. No network.
 *
 * `listing.pullRequests`: [{ number, head, headNow?, draft, state, merged,
 *   labels: [{ name, at }], files, filesComplete, filesProblem? }]
 *   - `at` is the time the label was set, or null when it could not be read;
 *     only the time of LABEL is read.
 *   - `files` are the changed paths; they count only when `filesComplete` is
 *     true. `filesProblem` says why they are not complete.
 *   - `headNow` is the head the pull request has just before the write (null:
 *     it is closed by then). When it differs from `head`, the pull request was
 *     pushed while it was evaluated: it gets no status here, the run for the
 *     push writes it.
 *   - `draft` is carried and not judged: the rules name no exception for a
 *     draft, so it holds and is held as any other open pull request.
 * `listing.pushed`: { number, at } when this event moved that pull request's
 *   head (a push), at the time of the push; `at` null when it is not known.
 *
 * Returns { statuses: [{ number, head, state, description, holder? }],
 *           endHolds: [{ number, label }], skipped: [{ number, reason }],
 *           holders: [{ number, at, head }], fingerprint }: the statuses, one
 * per open head (two open pull requests on one head share it, and a failure
 * wins); the labelled pull requests whose hold a push ended, with the label's
 * name as it is on the pull request; the pull requests left to another run;
 * the holders and their fingerprint.
 */
export function decide(listing) {
  const { pulls, holders, endHolds } = classify(listing);

  const sharedWith = (holder, e) => [...e.files].filter((file) => holder.files.has(file));
  const heldBy = (holder, e) => ({
    ...failure(heldDescription(holder.pr.number, sharedWith(holder, e))),
    holder: holder.pr.number,
  });
  const judge = (e) => {
    if (e.labelled) {
      if (e.labelAt === null) return failure(LABEL_TIME_UNREAD);
      if (e.files === null) return failure(cutShortDescription(e.problem, { labelled: true }));
      const earlier = holders.slice(0, holders.indexOf(e));
      const holder = earlier.find((h) => sharedWith(h, e).length > 0);
      return holder ? heldBy(holder, e) : success(HOLDS);
    }
    if (holders.length === 0) return success(NOTHING_HELD);
    if (e.files === null) return failure(cutShortDescription(e.problem));
    const holder = holders.find((h) => sharedWith(h, e).length > 0);
    return holder ? heldBy(holder, e) : success(SHARES_NOTHING);
  };

  const byHead = new Map();
  const skipped = [];
  for (const e of [...pulls].sort((a, b) => a.pr.number - b.pr.number)) {
    if (e.pr.headNow !== undefined && e.pr.headNow !== e.pr.head) {
      skipped.push({
        number: e.pr.number,
        reason: e.pr.headNow === null ? "it was closed before the write" : "its head moved during the evaluation",
      });
      continue;
    }
    const status = { number: e.pr.number, head: e.pr.head, ...judge(e) };
    const kept = byHead.get(status.head);
    if (!kept || (kept.state !== "failure" && status.state === "failure")) byHead.set(status.head, status);
  }
  const records = holders.map(holderRecord);
  return {
    statuses: [...byHead.values()].sort((a, b) => a.number - b.number),
    endHolds,
    skipped,
    holders: records,
    fingerprint: fingerprint(records),
  };
}

const CHANGES_THE_HOLDERS = { opened: "opened", reopened: "reopened", synchronize: "pushed", closed: "closed" };

/**
 * Which open pull requests an event evaluates. No network.
 *
 * `open`: [{ number, head, labelled }] the open pull requests; `holders`: the
 * pull requests that hold now, as `holdersOf` gives them; `current`:
 * Map(head -> { state, description, fingerprint } | null), the status each
 * head carries (null or missing: none, or it could not be read).
 *
 * The event: a run by hand, the label set or taken off, or a labelled pull
 * request opened, reopened, pushed or closed evaluates every open pull
 * request. Any other event of a pull request evaluates that pull request
 * alone; a pull request without the label that closes, none. Whatever the
 * event, a head whose status is missing or no longer fits the holders is
 * evaluated too, and a holder whose status was set against other holders
 * makes every open pull request evaluated.
 *
 * Returns { all, numbers, why, stale }.
 */
export function scope({ eventName, payload, open, holders, current }) {
  const fp = fingerprint(holders);
  const numbers = new Set();
  let all = false;
  let why;
  if (eventName === "workflow_dispatch") {
    all = true;
    why = "a run by hand renews every status";
  } else {
    const pr = payload?.pull_request ?? {};
    const action = payload?.action;
    const carries = (Array.isArray(pr.labels) ? pr.labels : []).some((l) => isLabel(l?.name));
    if ((action === "labeled" || action === "unlabeled") && isLabel(payload?.label?.name)) {
      all = true;
      why = `the label ${LABEL} was ${action === "labeled" ? "set on" : "taken off"} #${pr.number}`;
    } else if (carries && typeof action === "string" && Object.hasOwn(CHANGES_THE_HOLDERS, action)) {
      all = true;
      why = `labelled #${pr.number} was ${CHANGES_THE_HOLDERS[action]}`;
    } else if (action !== "closed" && open.some((p) => p.number === pr.number)) {
      numbers.add(pr.number);
      why = `#${pr.number} alone`;
    } else {
      why = "nothing for this event itself";
    }
  }

  const unrecorded = holders.filter((h) => current.get(h.head)?.fingerprint !== fp);
  if (!all && unrecorded.length > 0) {
    all = true;
    why += `; the holders changed since the status of #${unrecorded[0].number} was set`;
  }
  const holding = new Set(holders.map((h) => h.number));
  const stale = [];
  for (const p of open) {
    const was = current.get(p.head);
    let reason = null;
    if (!was) reason = "carries no status";
    else if (heldByIn(was.description) !== null && !holding.has(heldByIn(was.description))) {
      reason = `is held by #${heldByIn(was.description)}, which holds nothing now`;
    } else if (was.description === NOTHING_HELD && holders.length > 0) {
      reason = "was set while no pull request held files";
    } else if (saysLabelled(was.description) !== null && saysLabelled(was.description) !== p.labelled) {
      reason = p.labelled ? "was set before its label" : "says it carries the label, and it does not";
    }
    if (reason) {
      numbers.add(p.number);
      stale.push(`#${p.number} ${reason}`);
    }
  }
  const everyNumber = open.map((p) => p.number).sort((a, b) => a - b);
  if (all || (open.length > 0 && everyNumber.every((n) => numbers.has(n)))) return { all: true, numbers: everyNumber, why, stale };
  return { all: false, numbers: everyNumber.filter((n) => numbers.has(n)), why, stale };
}

/* ------------------------------------------------------------------ *
 * The commands: reads, the decision, writes
 * ------------------------------------------------------------------ */

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const answer = (res) => (res.status ? `HTTP ${res.status}` : "no answer");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const labelNames = (labels) => (Array.isArray(labels) ? labels : []).map((l) => l?.name).filter((n) => typeof n === "string");

/** The parts of the event the commands use, checked. */
export function readEvent(eventName, payload) {
  if (eventName === "workflow_dispatch") {
    return { name: eventName, action: null, number: null, pushedAt: null, carriesLabel: false };
  }
  if (eventName !== "pull_request_target") {
    throw new Error(`files-hold: runs on pull_request_target and workflow_dispatch only, not on '${eventName}' (failing closed)`);
  }
  const pr = payload?.pull_request;
  if (!object(payload) || typeof payload.action !== "string" || !object(pr) || !Number.isSafeInteger(pr.number)) {
    throw new Error("files-hold: the event carries no pull request (failing closed)");
  }
  return {
    name: eventName,
    action: payload.action,
    number: pr.number,
    // On a push the pull request was updated by the push: that is its time.
    pushedAt: typeof pr.updated_at === "string" ? pr.updated_at : null,
    carriesLabel: labelNames(pr.labels).some(isLabel),
  };
}

/** Every open pull request, page by page. A page that cannot be read stops the run. */
async function readOpenPulls(request, base) {
  const byNumber = new Map();
  for (let page = 1; page <= OPEN_PAGES_AT_MOST; page++) {
    const res = await request("GET", `${base}/pulls?state=open&per_page=${PAGE}&page=${page}`);
    if (res.status !== 200 || !Array.isArray(res.body)) {
      throw new Error(`files-hold: the open pull requests could not be listed (${answer(res)}); no status was written`);
    }
    for (const row of res.body) {
      if (!object(row) || !Number.isSafeInteger(row.number) || typeof row.head?.sha !== "string") {
        throw new Error("files-hold: the open pull requests could not be listed (a row is malformed); no status was written");
      }
      byNumber.set(row.number, {
        number: row.number,
        head: row.head.sha,
        draft: row.draft === true,
        state: "open",
        merged: false,
        labels: labelNames(row.labels),
      });
    }
    if (res.body.length < PAGE) return [...byNumber.values()];
  }
  throw new Error(`files-hold: more than ${OPEN_PAGES_AT_MOST * PAGE} open pull requests could not be listed in full; no status was written`);
}

/**
 * One pull request's record and its file list. The list is complete only when
 * every page was read and the rows read equal the record's `changed_files`.
 */
async function readPull(request, base, row) {
  const detail = await request("GET", `${base}/pulls/${row.number}`);
  if (detail.status !== 200 || !object(detail.body) || typeof detail.body.head?.sha !== "string") {
    return { ...row, files: null, filesComplete: false, filesProblem: `the pull request could not be read (${answer(detail)})` };
  }
  const pr = detail.body;
  const out = {
    number: row.number,
    head: pr.head.sha,
    draft: pr.draft === true,
    state: pr.state === "open" ? "open" : "closed",
    merged: pr.merged === true,
    labels: labelNames(pr.labels),
  };
  const files = new Set();
  let rows = 0;
  let problem = null;
  for (let page = 1; page <= FILES_LISTED_AT_MOST / PAGE; page++) {
    const res = await request("GET", `${base}/pulls/${row.number}/files?per_page=${PAGE}&page=${page}`);
    if (res.status !== 200 || !Array.isArray(res.body)) {
      problem = `a page of the file list could not be read (${answer(res)})`;
      break;
    }
    for (const file of res.body) {
      rows++;
      if (typeof file?.filename !== "string" || file.filename === "") problem ??= "a row of the file list names no file";
      else files.add(file.filename);
      // A rename changes the old path too.
      if (typeof file?.previous_filename === "string" && file.previous_filename !== "") files.add(file.previous_filename);
    }
    if (res.body.length < PAGE) break;
  }
  const expected = pr.changed_files;
  if (problem === null && !(Number.isSafeInteger(expected) && rows === expected)) {
    problem = `${rows} of ${Number.isSafeInteger(expected) ? expected : "an unknown number of"} files listed`;
  }
  return problem === null
    ? { ...out, files: [...files], filesComplete: true }
    : { ...out, files: null, filesComplete: false, filesProblem: problem };
}

/** The time the label was last set on a pull request, from its issue events; null when unknown. */
async function readLabelTime(request, base, number, pause) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    let latest = null;
    let complete = false;
    for (let page = 1; page <= EVENT_PAGES_AT_MOST; page++) {
      const res = await request("GET", `${base}/issues/${number}/events?per_page=${PAGE}&page=${page}`);
      if (res.status !== 200 || !Array.isArray(res.body)) break;
      for (const event of res.body) {
        if (event?.event !== "labeled" || !isLabel(event.label?.name)) continue;
        const at = toTime(event.created_at);
        if (at !== null && (latest === null || at >= latest)) latest = at;
      }
      if (res.body.length < PAGE) {
        complete = true;
        break;
      }
    }
    if (!complete) return null;
    if (latest !== null) return new Date(latest).toISOString();
    if (attempt === 1) await pause(LABEL_EVENT_RETRY_MS);
  }
  return null;
}

/** A pull request as `decide` takes it: its record and files, and its label time when it carries the label. */
async function readForDecision(request, base, row, pause, withFiles) {
  const read = withFiles ? await readPull(request, base, row) : { ...row, files: null, filesComplete: false, filesProblem: "not read" };
  const at = read.labels.some(isLabel) ? await readLabelTime(request, base, row.number, pause) : null;
  return { ...read, labels: read.labels.map((name) => ({ name, at: isLabel(name) ? at : null })) };
}

/** The fingerprint a status's link carries, or null. */
const fingerprintIn = (targetUrl) => {
  const m = typeof targetUrl === "string" ? /#holders-([0-9a-f]{12})$/.exec(targetUrl) : null;
  return m ? m[1] : null;
};

/** The files-hold status each head carries now: Map(head -> { state, description, fingerprint } | null). */
async function readCurrentStatuses(request, repository, heads, log) {
  const current = new Map();
  const [owner, name] = repository.split("/");
  try {
    for (let i = 0; i < heads.length; i += STATUS_READS_PER_QUERY) {
      const chunk = heads.slice(i, i + STATUS_READS_PER_QUERY);
      const variables = { owner, name, context: CONTEXT };
      chunk.forEach((sha, k) => {
        variables[`h${k}`] = sha;
      });
      const query =
        `query($owner: String!, $name: String!, $context: String!, ${chunk.map((_, k) => `$h${k}: GitObjectID!`).join(", ")}) ` +
        `{ repository(owner: $owner, name: $name) { ${chunk
          .map((_, k) => `h${k}: object(oid: $h${k}) { ... on Commit { status { context(name: $context) { state description targetUrl } } } }`)
          .join(" ")} } }`;
      const res = await request("POST", "/graphql", { query, variables });
      const repo = res.body?.data?.repository;
      if (res.status !== 200 || res.body?.errors || !object(repo)) throw new Error(answer(res));
      chunk.forEach((sha, k) => {
        const found = repo[`h${k}`]?.status?.context;
        current.set(
          sha,
          found
            ? { state: String(found.state).toLowerCase(), description: found.description ?? "", fingerprint: fingerprintIn(found.targetUrl) }
            : null,
        );
      });
    }
    return current;
  } catch (err) {
    log(`files-hold: the batched read of the current statuses was refused (${clean(err.message)}); reading each head.`);
  }
  current.clear();
  for (const sha of heads) {
    const res = await request("GET", `/repos/${repository}/commits/${sha}/status?per_page=100`);
    if (res.status !== 200 || !Array.isArray(res.body?.statuses)) continue; // unknown: evaluated again
    const found = res.body.statuses.find((s) => typeof s?.context === "string" && s.context.toLowerCase() === CONTEXT);
    if (found) {
      current.set(sha, { state: found.state, description: found.description ?? "", fingerprint: fingerprintIn(found.target_url) });
    } else if (res.body.statuses.length === res.body.total_count) {
      current.set(sha, null);
    }
  }
  return current;
}

/** The one comment a push that ended a hold gets. */
const endComment = (head) =>
  `A push moved the head of this pull request to ${head.slice(0, 7)}, so the label \`${LABEL}\` came off. ` +
  "The label stood for a verification made at the earlier head, so this pull request no longer holds its files. " +
  "Put the label back when the new head is verified.";

/**
 * The first job: on a push to a pull request that carried the label, take the
 * label off and write the one comment, unless the label was set after the
 * push. No request for any other push or event. Returns { failures, endHolds }.
 */
export async function endHold({ request, repository, eventName, payload, dryRun = false, log = console.log, pause = sleep }) {
  const event = readEvent(eventName, payload);
  if (event.action !== "synchronize" || !event.carriesLabel) {
    log(`files-hold: no pull request carrying ${LABEL} was pushed: nothing to take off.`);
    return { failures: [], endHolds: [] };
  }
  const base = `/repos/${repository}`;
  const res = await request("GET", `${base}/pulls/${event.number}`);
  if (res.status !== 200 || !object(res.body) || typeof res.body.head?.sha !== "string") {
    return { failures: [`#${event.number} could not be read (${answer(res)})`], endHolds: [] };
  }
  const pr = res.body;
  const names = labelNames(pr.labels);
  const at = names.some(isLabel) ? await readLabelTime(request, base, event.number, pause) : null;
  const decision = decide({
    pullRequests: [
      {
        number: event.number,
        head: pr.head.sha,
        draft: pr.draft === true,
        state: pr.state === "open" ? "open" : "closed",
        merged: pr.merged === true,
        labels: names.map((name) => ({ name, at: isLabel(name) ? at : null })),
        files: null,
        filesComplete: false,
      },
    ],
    pushed: { number: event.number, at: event.pushedAt },
  });
  const failures = [];
  for (const end of decision.endHolds) {
    log(`files-hold: a push to #${end.number} ended its hold${dryRun ? " (dry run: the label stays)" : ""}.`);
    if (dryRun) continue;
    const off = await request("DELETE", `${base}/issues/${end.number}/labels/${encodeURIComponent(end.label)}`);
    if (off.status === 404) {
      log(`files-hold: the label of #${end.number} was already off.`);
      continue;
    }
    if (off.status !== 200) {
      failures.push(`the label ${clean(end.label)} could not be taken off #${end.number} (${answer(off)})`);
      continue;
    }
    const said = await request("POST", `${base}/issues/${end.number}/comments`, { body: endComment(pr.head.sha) });
    if (said.status !== 201) failures.push(`the comment on #${end.number} could not be written (${answer(said)})`);
  }
  if (decision.endHolds.length === 0) log(`files-hold: the label on #${event.number} was set after the push, or is off: it stays as it is.`);
  return { failures, endHolds: decision.endHolds };
}

/**
 * The evaluation: read, scope, decide and write. `request(method, route, body)`
 * answers { status, body }. Returns { target, decision, failures, written,
 * unchanged }: a failure is a write that did not land, and fails the job.
 */
export async function evaluate({
  request,
  repository,
  eventName,
  payload,
  dryRun = false,
  runUrl = null,
  log = console.log,
  pause = sleep,
}) {
  const event = readEvent(eventName, payload);
  const base = `/repos/${repository}`;
  let open = await readOpenPulls(request, base);
  // The listing may still show a pull request this very event closed.
  if (event.action === "closed") open = open.filter((row) => row.number !== event.number);
  const pushed = event.action === "synchronize" && event.carriesLabel ? { number: event.number, at: event.pushedAt } : null;

  // The holders: the record, the file list and the label time of each labelled pull request.
  const read = new Map();
  for (const row of open.filter((p) => p.labels.some(isLabel))) {
    read.set(row.number, await readForDecision(request, base, row, pause, true));
  }
  const withFiles = read.size > 0;
  const holders = holdersOf({ pullRequests: [...read.values()], pushed });
  for (const h of holders) log(`files-hold: #${h.number} holds its files, labelled ${h.at}.`);

  const current = open.length > 0 ? await readCurrentStatuses(request, repository, open.map((p) => p.head), log) : new Map();
  const target = scope({
    eventName,
    payload,
    open: open.map((p) => ({ number: p.number, head: p.head, labelled: p.labels.some(isLabel) })),
    holders,
    current,
  });
  log(
    `files-hold: evaluates ${target.all ? `every open pull request (${target.numbers.length})` : target.numbers.map((n) => `#${n}`).join(", ") || "nothing"}: ${target.why}.`,
  );
  for (const line of target.stale) log(`files-hold: ${line}.`);
  if (target.numbers.length === 0) return { target, decision: null, failures: [], written: 0, unchanged: 0 };

  for (const row of open) {
    if (!target.numbers.includes(row.number) || read.has(row.number)) continue;
    read.set(row.number, await readForDecision(request, base, row, pause, withFiles));
  }
  // The heads just before the write: a pull request pushed meanwhile is left to the run for its push.
  const now = new Map((await readOpenPulls(request, base)).map((row) => [row.number, row.head]));
  if (event.action === "closed") now.delete(event.number);
  const decision = decide({ pullRequests: [...read.values()].map((p) => ({ ...p, headNow: now.get(p.number) ?? null })), pushed });
  for (const skip of decision.skipped) log(`files-hold: #${skip.number} is not written: ${skip.reason}.`);

  const holding = new Set(decision.holders.map((h) => h.number));
  // The statuses of the heads evaluated (two open pull requests on one head share one).
  const targetHeads = new Set(target.numbers.map((n) => read.get(n)?.head).filter(Boolean));
  const statuses = decision.statuses.filter((s) => targetHeads.has(s.head));
  const toWrite = statuses
    .filter((s) => {
      const was = current.get(s.head);
      if (!was || was.state !== s.state || was.description !== s.description) return true;
      return holding.has(s.number) && was.fingerprint !== decision.fingerprint;
    })
    .sort((a, b) => (a.state === b.state ? a.number - b.number : a.state === "failure" ? -1 : 1));
  for (const status of statuses) {
    const verb = toWrite.includes(status) ? (dryRun ? "would write" : "writes") : "unchanged";
    log(`  #${status.number} ${status.head.slice(0, 7)} ${status.state} (${verb}): ${status.description}`);
  }
  const failures = [];
  if (!dryRun) {
    for (const status of toWrite) {
      const res = await request("POST", `${base}/statuses/${status.head}`, {
        state: status.state,
        context: CONTEXT,
        description: status.description,
        ...(runUrl ? { target_url: `${runUrl}#holders-${decision.fingerprint}` } : {}),
      });
      if (res.status !== 201) failures.push(`the status of #${status.number} could not be written (${answer(res)})`);
    }
  }
  return { target, decision, failures, written: dryRun ? 0 : toWrite.length, unchanged: statuses.length - toWrite.length };
}

/* ------------------------------------------------------------------ *
 * The platform's API, with the job's token
 * ------------------------------------------------------------------ */

/** A `request` over fetch; it counts the requests and keeps the last rate-limit reading per resource. */
export function makeRequest({ token, apiUrl, graphqlUrl, fetchImpl = fetch, timeoutMs = 30_000 }) {
  const counts = { rest: 0, graphql: 0 };
  const budget = new Map();
  const request = async (method, route, body) => {
    const graphql = route === "/graphql";
    counts[graphql ? "graphql" : "rest"]++;
    try {
      const res = await fetchImpl(graphql ? graphqlUrl : `${apiUrl}${route}`, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": API_VERSION,
          "user-agent": "files-hold",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const resource = res.headers.get("x-ratelimit-resource");
      if (resource) {
        budget.set(resource, `${res.headers.get("x-ratelimit-remaining")} of ${res.headers.get("x-ratelimit-limit")} left`);
      }
      const text = await res.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      return { status: res.status, body: parsed };
    } catch {
      return { status: 0, body: null };
    }
  };
  return { request, counts, budget };
}

const COMMANDS = { "end-hold": endHold, evaluate };

async function main() {
  const command = COMMANDS[process.argv[2]];
  const dryRun = process.argv.includes("--dry-run");
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repository, GITHUB_EVENT_PATH: eventPath } = process.env;
  if (!command) {
    console.error(`::error::files-hold: name a command: ${Object.keys(COMMANDS).join(" or ")}.`);
    return 1;
  }
  if (!token || typeof repository !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(repository) || !eventPath) {
    console.error("::error::files-hold: GITHUB_TOKEN, GITHUB_REPOSITORY and GITHUB_EVENT_PATH are required (failing closed).");
    return 1;
  }
  const apiUrl = process.env.GITHUB_API_URL || "https://api.github.com";
  const graphqlUrl = process.env.GITHUB_GRAPHQL_URL || `${apiUrl}/graphql`;
  const server = process.env.GITHUB_SERVER_URL;
  const runId = process.env.GITHUB_RUN_ID;
  const runUrl = server && runId ? `${server}/${repository}/actions/runs/${runId}` : null;
  const { request, counts, budget } = makeRequest({ token, apiUrl, graphqlUrl });
  try {
    const payload = JSON.parse(fs.readFileSync(eventPath, "utf8"));
    const result = await command({ request, repository, eventName: process.env.GITHUB_EVENT_NAME, payload, dryRun, runUrl });
    if (command === evaluate) {
      console.log(`files-hold: ${result.written} status(es) written, ${result.unchanged} unchanged.`);
    }
    console.log(
      `files-hold: ${counts.rest} REST and ${counts.graphql} GraphQL request(s) this run; the token's budget: ` +
        ([...budget].map(([resource, left]) => `${clean(resource)} ${clean(left)}`).join(", ") || "not reported") +
        ".",
    );
    for (const failure of result.failures) console.error(`::error::files-hold: ${failure}`);
    return result.failures.length === 0 ? 0 : 1;
  } catch (err) {
    console.error(`::error::${clean(err.message)}`);
    return 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await main();
