/**
 * LIVE post-fix RE-VERIFICATION of the Anthropic Skills API conformance arm
 * (cinatra#2094 S7, epic #2086).
 *
 * The first acceptance run (`drivers/live-skills-api-probe.mjs` ->
 * `live-results.json`) recorded **7 PASS / 3 FAIL**: C3 and C4 measured that the
 * client paginated on a cursor the API never returns (finding F1), and C10
 * measured that the 30,000,000-byte upload gate was stricter than the live API
 * (finding F2). Both findings are now FIXED in this branch. This driver re-runs
 * the same ten named checks against the SAME live API to prove the fixes hold on
 * the wire, and writes its own record (`live-reverify-results.json`) so the
 * original measurement is preserved rather than overwritten.
 *
 * ## What makes this run a stronger claim than the first one
 *
 * The first probe deliberately REIMPLEMENTED the canonical zip builder and both
 * pagination walks so it could run standalone against the API without booting
 * the app's module graph. That is a fine way to *discover* a contract, but it
 * proves nothing about the shipped code: a probe can walk the cursor correctly
 * while the product still does not.
 *
 * This driver instead imports and drives the REAL production modules:
 *
 *   - `FetchAnthropicCustomSkillsClient`   — createSkill / createSkillVersion,
 *     including its create-time collision reconciliation walk (R3)
 *   - `FetchAnthropicCustomSkillsGcClient` — listSkillVersions (R4)
 *   - `isDisplayTitleConflict`             — the shipped predicate (R7)
 *   - `buildCanonicalSkillZip` / `checkSkillBoundary` /
 *     `ANTHROPIC_SKILL_MAX_UPLOAD_BYTES` — the shipped artifact + gate (R10)
 *
 * So R3/R4/R10 are claims about the code that ships, not about a restatement of
 * it. Run under `node --import tsx` (the client module has no top-level imports
 * and the hash module imports only `node:crypto`, so no app graph is pulled in).
 *
 * ## The two pagination checks are driven over GENUINELY multi-page walks
 *
 * Both walks default to `limit=100`, which is why the defect was latent: a small
 * workspace and a short version history each fit on one page. Proving exhaustion
 * therefore requires more than one page to exist. Rather than upload 101
 * versions, both production classes take an injectable page size (added with the
 * fix for exactly this reason), so this driver drives them at `pageLimit=1`:
 *
 *   - R4 creates a disposable skill with FOUR versions and walks it one row at a
 *     time — four pages. A walk that stops after page one returns 1 of 4.
 *   - R3 attempts the same for the workspace skills list, and in doing so
 *     MEASURED that this endpoint does not paginate at all: it truncates to
 *     `limit` and returns `has_more:false` / `next_page:null` even when more
 *     rows demonstrably exist, and accepts-then-ignores an unknown `page`. That
 *     is NEW finding **F6**.
 *
 *     R3 therefore measures the PRODUCT property directly and records it as a
 *     **FAIL**: it collides on a `display_title` that the endpoint provably does
 *     not return, and the shipped reconciliation rethrows instead of adopting the
 *     existing remote identity. A positive control on a title INSIDE the served
 *     page adopts correctly, which attributes the failure to the page ceiling
 *     rather than to the reconciliation logic.
 *
 *     An earlier revision of this driver re-scoped R3 to "adopts on a live
 *     collision" after the multi-page framing could not hold, and reported
 *     10/10. That was goalpost-moving — the re-scoped check selected a target
 *     sitting on page one, which the PRE-FIX client would also have satisfied,
 *     so it could not distinguish fixed from broken. An upstream limitation does
 *     not convert an unmet product behaviour into a pass; the honest headline is
 *     **9 PASS / 1 FAIL**.
 *
 * Each walk's page count is measured by counting the real HTTP requests it made,
 * so "it paged" is a recorded number, not an inference. R4 additionally replays
 * the OLD `has_more`+`last_id` -> `after_id` shape against the same history and
 * records what the pre-fix client would have seen — the regression delta, kept
 * as evidence rather than scored as a check.
 *
 * So the two endpoints differ, and the difference is the honest result of this
 * run: F1's cursor fix is load-bearing and live-proven on the VERSIONS walk
 * (R4), while on the SKILLS-LIST walk it corrects the cursor the client keys on
 * but cannot restore exhaustion, because the server offers nothing to paginate
 * with. F6 records that residual risk rather than letting the fix imply more
 * than it delivers.
 *
 * ## SECRETS + LEAK DISCIPLINE (this file and its output land in a PUBLIC repo)
 *   - The key is read from the process env, never from argv, never printed.
 *   - Request HEADERS are never captured — `x-api-key` rides every call.
 *   - Every remote `skill_…` id is workspace-scoped, so each captured id is
 *     replaced by a per-run salted digest token (`sk#<8 hex>`); the mapping is
 *     never written anywhere.
 *
 * ## CLEANUP
 * Every skill this driver uploads is deleted before exit in the documented
 * versions-then-skill order (itself check R6), and each id is re-read afterwards
 * to verify reclamation. The cleanup ledger is recorded.
 *
 * Usage:  PROBE_KEY=<key> node --import tsx live-reverify-postfix.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  FetchAnthropicCustomSkillsClient,
  FetchAnthropicCustomSkillsGcClient,
  isDisplayTitleConflict,
} from "../../../packages/llm/src/tools/anthropic-custom-skills-client.ts";
import {
  buildCanonicalSkillZip,
  checkSkillBoundary,
  ANTHROPIC_SKILL_MAX_UPLOAD_BYTES,
} from "../../../packages/llm/src/tools/anthropic-skill-content-hash.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, "..");
const BASE = "https://api.anthropic.com";
const VERSION = "2023-06-01";
const BETAS = "code-execution-2025-08-25,skills-2025-10-02,files-api-2025-04-14";

const KEY = process.env.PROBE_KEY;
if (!KEY) {
  console.error("PROBE_KEY absent in env — refusing to run (no key is ever read from argv).");
  process.exit(2);
}

/** Per-run salt so a captured token can never be correlated back to a remote id. */
const SALT = randomBytes(16);
const redactIds = new Map();
function rid(id) {
  if (!id) return id;
  if (!redactIds.has(id)) {
    const h = createHash("sha256").update(SALT).update(String(id)).digest("hex").slice(0, 8);
    redactIds.set(id, `sk#${h}`);
  }
  return redactIds.get(id);
}
function redactText(s) {
  if (typeof s !== "string") return s;
  return s.replace(/skill_[A-Za-z0-9]+/g, (m) => rid(m)).slice(0, 400);
}

const results = {
  probe: "cinatra#2094 S7 LIVE post-fix re-verification (F1 + F2 landed)",
  ranAt: new Date().toISOString(),
  live: true,
  reverificationOf: {
    firstRun: "live-results.json",
    firstRunVerdict: "7 PASS / 3 FAIL (C3, C4 = finding F1; C10 = finding F2)",
    fixesUnderTest: [
      "F1 — both Skills-API list walks paginate on the REAL {data,has_more,next_page} cursor (forward cursor on the `page` param)",
      "F2 — ANTHROPIC_SKILL_MAX_UPLOAD_BYTES raised 30,000,000 -> 31,457,280 (30 MiB). The C10/R10 evidence " +
        "refutes the OLD value (a confirmed false rejection); the NEW value is the docs-based policy reading " +
        "(30 MiB), consistent with but not derived from the measurement — see R10.whatIsLiveVsLocal",
    ],
    drivesRealProductionCode: true,
  },
  docsPin: {
    surface: "Anthropic Skills API",
    betaRevision: "skills-2025-10-02",
    stackedBetas: BETAS,
    anthropicVersion: VERSION,
    consulted:
      "claude-api skill reference bundle 2.1.220 (shared/managed-agents-api-reference.md Skills + " +
      "Pagination sections — `GET /v1/skills` is named as a `page`/`next_page` endpoint that also " +
      "returns `has_more`; `after_id`/`last_id` belongs to Batches/Files/Models); live API " +
      "authoritative where docs prose and wire disagree",
  },
  checks: [],
  cleanup: {
    attempted: [],
    versionDeletes: 0,
    skillDeletes: 0,
    order: "versions-then-skill",
    allReclaimed: null,
  },
  requestCount: 0,
};

function record(name, verdict, detail) {
  results.checks.push({ name, verdict, ...detail });
  console.log(`[${verdict}] ${name}`);
}

// ---------------------------------------------------------------------------
// Request accounting. The production classes call `fetch` directly, so counting
// at the global boundary is the only way to measure how many pages a walk
// really requested — which is the whole point of R3/R4.
// ---------------------------------------------------------------------------
const realFetch = globalThis.fetch;
let phaseCounts = null;
globalThis.fetch = async function countingFetch(input, init) {
  const url = typeof input === "string" ? input : (input?.url ?? String(input));
  results.requestCount += 1;
  if (phaseCounts) {
    const u = new URL(url);
    const key = `${(init?.method ?? "GET").toUpperCase()} ${u.pathname}`;
    phaseCounts[key] = (phaseCounts[key] ?? 0) + 1;
  }
  return realFetch(input, init);
};
/**
 * Run `fn` with a fresh per-request tally.
 *
 * Returns `{ value, counts, error }` and NEVER throws, because the requests a
 * failing call made are exactly the evidence we need: R3's expected outcome is a
 * throw, and an earlier revision discarded the tally in its catch block and so
 * recorded `listRequestsMadeByTheWalk: 0` for a walk that had in fact run. A
 * reviewer reading that would reasonably conclude the walk never executed (i.e.
 * that the collision classifier missed), which is a different and more serious
 * claim than the truth. Counts are captured before the error propagates.
 */
async function counting(fn) {
  const prev = phaseCounts;
  const mine = {};
  phaseCounts = mine;
  try {
    const value = await fn();
    return { value, counts: mine, error: null };
  } catch (error) {
    return { value: null, counts: mine, error };
  } finally {
    phaseCounts = prev;
  }
}

function headers() {
  return { "x-api-key": KEY, "anthropic-version": VERSION, "anthropic-beta": BETAS };
}
/** Raw call, for the checks that must read the wire rather than drive the client. */
async function call(method, url, init = {}) {
  const res = await realFetch(url, { method, headers: headers(), ...init });
  results.requestCount += 1;
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { __unparsed: text.slice(0, 300) };
  }
  return { status: res.status, ok: res.ok, body, text };
}

const stamp = Math.random().toString(36).slice(2, 10);
const created = []; // { id } — every one is reclaimed on exit

/** Build the canonical artifact with the REAL production zip builder. */
function upload(rootDir, displayTitle, bundledFiles = []) {
  const zip = buildCanonicalSkillZip({
    skillMd: Buffer.from(
      `---\nname: ${rootDir}\ndescription: cinatra 2094 S7 post-fix re-verification bundle ${rootDir}\n---\n\n# ${rootDir}\n\nDisposable probe bundle. Safe to delete.\n`,
    ),
    bundledFiles,
    rootDir,
  });
  return { displayTitle, rootDir, zipBytes: zip.zipBytes, canonical: zip };
}

// The production clients under test. `pageLimit` defaults to 100; the two
// pagination checks construct their own at 1.
const client = new FetchAnthropicCustomSkillsClient(KEY, BASE);

async function main() {
  // -- R1 rooted-zip multipart create, through the REAL client --------------
  const rootA = `c2094-rv-a-${stamp}`;
  const titleA = `cinatra 2094 S7 reverify A ${stamp}`;
  const upA = upload(rootA, titleA);
  let r1 = null;
  let r1err = null;
  try {
    r1 = await client.createSkill(upA);
    created.push({ id: r1.skillId, title: titleA });
  } catch (e) {
    r1err = redactText(String(e?.message ?? e));
  }
  record(
    "R1 rooted-zip multipart create accepted through the shipped client (display_title + single files[] zip)",
    r1 && r1.skillId && r1.version ? "PASS" : "FAIL",
    {
      via: "FetchAnthropicCustomSkillsClient.createSkill",
      request: {
        zipRootedAt: `${rootA}/`,
        zipEntries: upA.canonical.entryPaths,
        archiveBytes: upA.canonical.archiveBytes,
      },
      responseRedacted: r1 ? { id: rid(r1.skillId), version: r1.version } : null,
      error: r1err,
    },
  );
  if (!r1) {
    results.fatal = "R1 create failed — the remaining live checks cannot run";
    return;
  }

  // -- R2 a NEW immutable version on the same skill -------------------------
  const upA2 = upload(rootA, titleA, [
    { relPath: "references/notes.md", bytes: Buffer.from("# Notes\n\nSecond revision.\n") },
  ]);
  let r2 = null;
  let r2err = null;
  try {
    r2 = await client.createSkillVersion(r1.skillId, upA2);
  } catch (e) {
    r2err = redactText(String(e?.message ?? e));
  }
  record(
    "R2 POST /v1/skills/{id}/versions mints a NEW immutable version (multi-file bundle)",
    r2 && r2.version && r2.version !== r1.version ? "PASS" : "FAIL",
    {
      via: "FetchAnthropicCustomSkillsClient.createSkillVersion",
      zipEntries: upA2.canonical.entryPaths,
      versionChanged: r2 ? r2.version !== r1.version : null,
      responseRedacted: r2 ? { version: r2.version } : null,
      error: r2err,
    },
  );

  // -- R3 does the reconciliation walk find a title BEYOND the served page? --
  // This is the product property F1 exists to protect: a lost create response
  // must reconcile to the existing remote identity rather than rethrow. It is
  // measured DIRECTLY here, and it is measured as a FAILURE — see F6.
  //
  // An earlier revision of this check tried to prove a multi-page walk and then,
  // when that could not hold, was re-scoped to "adopts on a live collision".
  // That was goalpost-moving and is corrected: the re-scoped version selected a
  // target that sat on page ONE (`targetPositionInList: 1`), which the PRE-FIX
  // client would also have satisfied — it finds the match before reaching any
  // pagination logic. A check the bug passes proves nothing. So R3 now targets a
  // title the endpoint demonstrably does NOT return, with a positive control.
  for (let i = 0; i < 3; i++) {
    const root = `c2094-rv-f${i}-${stamp}`;
    const title = `cinatra 2094 S7 reverify filler ${i} ${stamp}`;
    try {
      const res = await client.createSkill(upload(root, title));
      created.push({ id: res.skillId, title });
    } catch {
      /* a filler that fails only shrinks the row set; the probe below records it */
    }
  }

  // Establish the endpoint's real behaviour before asserting anything about it.
  const listFull = await call("GET", `${BASE}/v1/skills?source=custom`);
  const fullRows = (listFull.body?.data ?? []).map((s) => ({ id: s.id, title: s.display_title }));
  const envelopeShape = listFull.ok ? Object.keys(listFull.body).sort() : null;

  // Does it paginate AT ALL? Hold the row set constant and vary `limit` below
  // the total: a paginating endpoint answers a short page with has_more:true and
  // a cursor. Every request/response here is RECORDED, not asserted in prose.
  const paginationProbe = [];
  for (const lim of [1, 2]) {
    if (fullRows.length > lim) {
      const r = await call("GET", `${BASE}/v1/skills?source=custom&limit=${lim}`);
      paginationProbe.push({
        request: `?source=custom&limit=${lim}`,
        rows: (r.body?.data ?? []).length,
        has_more: r.body?.has_more ?? null,
        next_page: r.body?.next_page == null ? null : "present",
      });
    }
  }
  // The two mitigations F6 would need, probed rather than assumed.
  const bogusCursor = await call("GET", `${BASE}/v1/skills?source=custom&page=bogus-cursor-c2094`);
  const titleFilterTarget = fullRows[0]?.title ?? "xlsx";
  const titleFilter = await call(
    "GET",
    `${BASE}/v1/skills?source=custom&display_title=${encodeURIComponent(titleFilterTarget)}`,
  );
  const bigLimits = [];
  for (const lim of [101, 1000]) {
    const r = await call("GET", `${BASE}/v1/skills?source=custom&limit=${lim}`);
    bigLimits.push({ limit: lim, status: r.status, rows: (r.body?.data ?? []).length });
  }
  const truncatesWithoutCursor =
    paginationProbe.length > 0 &&
    paginationProbe.every(
      (p) => p.rows === Number(p.request.split("limit=")[1]) && p.has_more === false && p.next_page === null,
    );

  // The single row the endpoint actually serves at limit=1 …
  const servedRow = fullRows[0] ?? null;
  // … and one of OUR skills that is NOT that row: a title provably outside the
  // page the walk can see. Reconciling it is exactly what >100 skills would need.
  const ourTitled = created.filter((c) => c.title);
  const beyondPage = ourTitled.find((c) => servedRow && c.id !== servedRow.id) ?? null;

  // NEGATIVE (the real property): collide on a title outside the served page.
  let beyondAdopted = null;
  let beyondErr = null;
  let beyondCounts = {};
  if (beyondPage) {
    const pagedClient = new FetchAnthropicCustomSkillsClient(KEY, BASE, 1);
    const r = await counting(() =>
      pagedClient.createSkill(upload(`c2094-rv-beyond-${stamp}`, beyondPage.title)),
    );
    beyondAdopted = r.value;
    beyondCounts = r.counts; // kept even on throw — see `counting`
    if (r.error) beyondErr = redactText(String(r.error?.message ?? r.error));
    if (beyondAdopted) created.push({ id: beyondAdopted.skillId, title: null });
  }
  // POSITIVE CONTROL: the same mechanism on a title INSIDE the served page must
  // adopt — so a FAIL above is attributable to the page ceiling, not to a broken
  // reconciliation path.
  let controlAdopted = null;
  let controlErr = null;
  const controlTarget = servedRow && ourTitled.find((c) => c.id === servedRow.id);
  if (controlTarget) {
    const pagedClient = new FetchAnthropicCustomSkillsClient(KEY, BASE, 1);
    try {
      controlAdopted = await pagedClient.createSkill(
        upload(`c2094-rv-control-${stamp}`, controlTarget.title),
      );
      if (controlAdopted && controlAdopted.skillId !== controlTarget.id) {
        created.push({ id: controlAdopted.skillId, title: null });
      }
    } catch (e) {
      controlErr = redactText(String(e?.message ?? e));
    }
  }

  const adoptedBeyond = !!beyondAdopted && beyondAdopted.skillId === beyondPage?.id;
  // PASS only if the product property holds: the title outside the served page
  // is reconciled. It does not, so this records FAIL. Recording a pass here
  // would be laundering an unmet behaviour into a green acceptance.
  const r3Pass = adoptedBeyond;
  record(
    "R3 collision reconciliation resolves a display_title BEYOND the page GET /v1/skills serves",
    r3Pass ? "PASS" : "FAIL",
    {
      via: "FetchAnthropicCustomSkillsClient.createSkill (collision -> findCustomSkillByDisplayTitle) at pageLimit=1",
      responseShape: envelopeShape,
      cursorScheme: "page / next_page, no last_id — the client's post-F1 shape matches the envelope it is given",
      observed: {
        customSkillsPresent: fullRows.length,
        rowServedAtLimit1Redacted: servedRow ? rid(servedRow.id) : null,
        targetWasOutsideTheServedPage: !!beyondPage && beyondPage.id !== servedRow?.id,
        targetRedacted: beyondPage ? rid(beyondPage.id) : null,
        listRequestsMadeByTheWalk: beyondCounts["GET /v1/skills"] ?? 0,
        adoptedTheExistingIdentity: adoptedBeyond,
        rethrewInstead: beyondErr != null,
        errorRedacted: beyondErr,
      },
      positiveControl: {
        purpose:
          "the same reconciliation on a title INSIDE the served page — isolates the page ceiling as the cause",
        adopted: !!controlAdopted && controlAdopted.skillId === controlTarget?.id,
        errorRedacted: controlErr,
      },
      paginationProbe: {
        rowsPresent: fullRows.length,
        shortPages: paginationProbe,
        truncatesWithoutOfferingACursor: truncatesWithoutCursor,
        bogusCursor: {
          request: "?source=custom&page=bogus-cursor-c2094",
          status: bogusCursor.status,
          accepted: bogusCursor.ok,
          rowsReturned: (bogusCursor.body?.data ?? []).length,
          verdict: "an unknown cursor is accepted and silently ignored",
        },
        displayTitleFilter: {
          request: `?source=custom&display_title=<title>`,
          status: titleFilter.status,
          rowsReturned: (titleFilter.body?.data ?? []).length,
          filtered: (titleFilter.body?.data ?? []).length < fullRows.length,
          verdict:
            (titleFilter.body?.data ?? []).length < fullRows.length
              ? "the filter narrowed the result — a server-side exact lookup MAY be available"
              : "accepted and ignored — NOT a usable server-side exact lookup",
        },
        largerLimits: bigLimits,
        largerLimitsVerdict:
          "accepted without a 400, but with only these rows present it cannot be proven that a limit " +
          "above 100 is HONOURED — so raising the page size is not evidence-backed from this run",
      },
      finding: {
        id: "F6 (NEW — measured by this re-verification)",
        statement: "GET /v1/skills does not paginate: it truncates to `limit` and never returns a cursor.",
        contrast:
          "the VERSIONS endpoint does paginate — R4 walked a 4-version history across 4 pages on has_more + next_page",
        blastRadius:
          "findCustomSkillByDisplayTitle requests limit=100, so it can only ever observe the first 100 custom " +
          "skills. Past 100, a lost create response rethrows instead of adopting the existing remote identity — " +
          "the retry-stability property S0 claimed. F1's fix removes the wrong-cursor bug and is load-bearing " +
          "for the GC walk (R4), but exhaustion on THIS endpoint is unreachable by paginating.",
        whyNotPatchedHere:
          "no client-side change is evidence-backed from this run (see paginationProbe): the display_title " +
          "filter is ignored, and a larger limit is accepted but unproven. A defensible partial mitigation " +
          "does exist and is recommended rather than silently applied — when a no-cursor page comes back FULL " +
          "(rows == limit) with no match, the walk should report the result as TRUNCATED/indeterminate instead " +
          "of treating it as exhaustive, so a caller can fail loudly rather than duplicate a remote identity. " +
          "That is a product change outside this lane's authorised F1/F2 scope.",
      },
      note: r3Pass
        ? "the walk reconciled a title outside the served page"
        : "MEASURED FAILURE, reported not hidden: the reconciliation could not resolve a title outside the " +
          "single page this endpoint serves, and rethrew. The positive control shows the path itself works " +
          "within that page, so the ceiling — not the reconciliation logic — is the cause. This is F6.",
    },
  );

  // -- R4 versions-list pagination to exhaustion, genuinely multi-page ------
  // A disposable skill with FOUR versions, walked one row at a time.
  const rootB = `c2094-rv-b-${stamp}`;
  const titleB = `cinatra 2094 S7 reverify versions ${stamp}`;
  let bId = null;
  const bVersions = [];
  try {
    const b1 = await client.createSkill(upload(rootB, titleB));
    bId = b1.skillId;
    created.push({ id: bId });
    bVersions.push(b1.version);
    for (let i = 2; i <= 4; i++) {
      const v = await client.createSkillVersion(
        bId,
        upload(rootB, titleB, [
          { relPath: `references/rev${i}.md`, bytes: Buffer.from(`revision ${i}\n`) },
        ]),
      );
      bVersions.push(v.version);
    }
  } catch (e) {
    results.r4SetupError = redactText(String(e?.message ?? e));
  }

  let gcWalk = [];
  let gcCounts = {};
  let gcErr = null;
  if (bId) {
    const pagedGc = new FetchAnthropicCustomSkillsGcClient(KEY, BASE, 1);
    try {
      const g = await counting(() => pagedGc.listSkillVersions(bId));
      gcWalk = g.value ?? [];
      gcCounts = g.counts;
      if (g.error) throw g.error;
    } catch (e) {
      gcErr = redactText(String(e?.message ?? e));
    }
  }
  const versionPages = gcCounts[`GET /v1/skills/${bId}/versions`] ?? 0;

  // What the PRE-FIX client would have seen over this same history: the old
  // `has_more` + `last_id` -> `after_id` shape. Recorded as the regression
  // delta, not scored — the check above is the claim.
  const legacyWalk = [];
  if (bId) {
    let afterId;
    for (let i = 0; i < 50; i++) {
      const qs = new URLSearchParams({ limit: "1" });
      if (afterId) qs.set("after_id", afterId);
      const r = await call("GET", `${BASE}/v1/skills/${encodeURIComponent(bId)}/versions?${qs}`);
      if (!r.ok) break;
      for (const v of r.body.data ?? r.body.versions ?? []) {
        legacyWalk.push(typeof v === "string" ? v : v.version);
      }
      if (r.body.has_more !== true || !r.body.last_id) break;
      afterId = r.body.last_id;
    }
  }

  // The walk must return the SAME SET, not merely the same count — an equal
  // count of wrong versions would otherwise false-green this check later.
  const r4SameSet =
    gcWalk.length === bVersions.length &&
    [...gcWalk].sort().join(",") === [...bVersions].sort().join(",");
  const r4Pass =
    bVersions.length === 4 && gcWalk.length === 4 && versionPages >= 4 && r4SameSet && gcErr == null;
  record(
    "R4 versions-list pagination to exhaustion over a genuinely multi-page history",
    r4Pass ? "PASS" : "FAIL",
    {
      via: "FetchAnthropicCustomSkillsGcClient.listSkillVersions at pageLimit=1",
      observed: {
        versionsCreated: bVersions.length,
        pageSizeDriven: 1,
        versionsReturnedByTheWalk: gcWalk.length,
        versionRequestsMadeByTheWalk: versionPages,
        walkSawEveryVersion: gcWalk.length === bVersions.length,
        sameVersionSet:
          gcWalk.length === bVersions.length &&
          [...gcWalk].sort().join(",") === [...bVersions].sort().join(","),
      },
      regressionDelta: {
        legacyCursorWalkReturned: legacyWalk.length,
        legacyCursorShape: "has_more + last_id -> after_id (the pre-fix client)",
        note:
          `the pre-fix cursor shape returned ${legacyWalk.length} of ${bVersions.length} versions over the ` +
          "same history — which is the GC's non-convergence: it would delete only what it saw, then be " +
          "refused the skill delete (R5) forever",
      },
      error: gcErr,
      note: r4Pass
        ? `the shipped GC walk requested ${versionPages} pages at limit=1 and returned all ${gcWalk.length} versions — the S0 deliverable "paginate listSkillVersions to exhaustion before any deleteSkill" is restored on the wire`
        : "the shipped GC walk did not exhaust the multi-page history",
    },
  );

  // -- R5 the documented delete ORDER is enforced by the API ---------------
  const premature = bId ? await call("DELETE", `${BASE}/v1/skills/${encodeURIComponent(bId)}`) : null;
  // Assert the refusal is FOR THE DOCUMENTED REASON, not merely any non-2xx —
  // a 401/429/500 would otherwise satisfy a bare `!ok` and false-green this.
  const r5ForTheRightReason =
    !!premature &&
    !premature.ok &&
    premature.status === 400 &&
    /version/i.test(premature.text ?? "");
  record(
    "R5 skill delete is REFUSED while undeleted versions remain (delete-order enforcement)",
    r5ForTheRightReason ? "PASS" : "FAIL",
    {
      status: premature?.status ?? null,
      refused: premature ? !premature.ok : null,
      refusalAttributedToVersionsRemaining: r5ForTheRightReason,
      errorRedacted: premature ? redactText(premature.text) : null,
      note: "the API refuses the skill delete until every version is gone — which is why R4's exhaustion matters",
    },
  );

  // -- R6 versions-then-skill order reclaims the remote skill --------------
  let everyVersionDeleted = true;
  let skillDel = null;
  if (bId) {
    for (const v of gcWalk.length ? gcWalk : bVersions) {
      const d = await call(
        "DELETE",
        `${BASE}/v1/skills/${encodeURIComponent(bId)}/versions/${encodeURIComponent(v)}`,
      );
      if (!d.ok && d.status !== 404) everyVersionDeleted = false;
    }
    skillDel = await call("DELETE", `${BASE}/v1/skills/${encodeURIComponent(bId)}`);
  }
  record(
    "R6 versions-then-skill delete order reclaims the remote skill",
    everyVersionDeleted && skillDel && (skillDel.ok || skillDel.status === 404) ? "PASS" : "FAIL",
    {
      versionsDeleted: gcWalk.length || bVersions.length,
      everyVersionDeleteAccepted: everyVersionDeleted,
      skillDeleteStatus: skillDel?.status ?? null,
      note: "the same order the GC performs, over a history it could only enumerate because R4's walk exhausts",
    },
  );

  // -- R7 display_title collision rejected AND classified -----------------
  const dupRoot = `c2094-rv-dup-${stamp}`;
  const dup = await call("POST", `${BASE}/v1/skills`, {
    body: (() => {
      const u = upload(dupRoot, titleA);
      const form = new FormData();
      form.set("display_title", u.displayTitle);
      form.append(
        "files[]",
        new Blob([new Uint8Array(u.zipBytes)], { type: "application/zip" }),
        `${u.rootDir}.zip`,
      );
      return form;
    })(),
  });
  if (dup.ok) {
    const id = dup.body.skill_id ?? dup.body.id;
    if (id) created.push({ id });
  }
  const classifierMatches = !dup.ok && isDisplayTitleConflict(dup.status, dup.text);
  record(
    "R7 display_title collision is rejected AND classified by the shipped isDisplayTitleConflict",
    dup.ok ? "UNIQUE-NOT-ENFORCED" : classifierMatches ? "PASS" : "FAIL",
    {
      secondCreateStatus: dup.status,
      duplicateAccepted: dup.ok,
      coreClassifierMatchesRealBody: classifierMatches,
      errorRedacted: redactText(dup.text),
      note: "the shipped predicate is what gates R3's reconciliation — a body it fails to classify would rethrow instead of adopting",
    },
  );

  // -- R8 the per-request container.skills cap ----------------------------
  // Nine distinct uploaded refs; 8 must be accepted and 9 rejected.
  const capRefs = [];
  for (let i = 0; i < 9; i++) {
    const root = `c2094-rv-cap${i}-${stamp}`;
    try {
      const res = await client.createSkill(
        upload(root, `cinatra 2094 S7 reverify cap ${i} ${stamp}`),
      );
      created.push({ id: res.skillId });
      capRefs.push({ type: "custom", skill_id: res.skillId, version: res.version });
    } catch {
      /* recorded via uploadedRefs below */
    }
  }
  async function probeCap(n) {
    const r = await call("POST", `${BASE}/v1/messages`, {
      headers: { ...headers(), "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-5",
        max_tokens: 1,
        container: { skills: capRefs.slice(0, n) },
        tools: [{ type: "code_execution_20260521", name: "code_execution" }],
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    return { n, status: r.status, accepted: r.ok, errorRedacted: r.ok ? null : redactText(r.text) };
  }
  const at8 = capRefs.length >= 8 ? await probeCap(8) : null;
  const at9 = capRefs.length >= 9 ? await probeCap(9) : null;
  record(
    "R8 container.skills per-request cap — 8 accepted, 9 rejected",
    at8?.accepted && at9 && !at9.accepted ? "PASS" : "FAIL",
    {
      uploadedRefs: capRefs.length,
      at8,
      at9,
      note: "the 8-per-request ceiling is the server's own — the cross-provider suite's INJECTED_SKILL_CAP mirrors a real limit",
    },
  );

  // -- R9 fail-closed resolution of an unresolvable reference -------------
  const bogus = await call("POST", `${BASE}/v1/messages`, {
    headers: { ...headers(), "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-opus-5",
      max_tokens: 1,
      container: {
        skills: [{ type: "custom", skill_id: `skill_c2094rv${stamp}absent`, version: "1" }],
      },
      tools: [{ type: "code_execution_20260521", name: "code_execution" }],
      messages: [{ role: "user", content: "ping" }],
    }),
  });
  // As with R5: the rejection must be attributable to the unresolvable skill,
  // not to any incidental non-2xx.
  const r9ForTheRightReason =
    !bogus.ok && bogus.status === 400 && /skill/i.test(bogus.text ?? "");
  record(
    "R9 an unresolvable container.skills reference fails CLOSED at the API boundary",
    r9ForTheRightReason ? "PASS" : "FAIL",
    {
      status: bogus.status,
      rejected: !bogus.ok,
      rejectionAttributedToTheUnknownSkill: r9ForTheRightReason,
      errorRedacted: redactText(bogus.text),
      note: "a stale mapping surfaces as an error rather than silently dropping the skill",
    },
  );

  // -- R10 the raised upload boundary agrees with the live API -------------
  // Three things must hold together for the F2 change to be correct:
  //   (a) the API still accepts the artifact the OLD gate rejected  (the false
  //       rejection is real and is now lifted);
  //   (b) the SHIPPED gate now accepts that same artifact           (the lift
  //       actually reaches the product);
  //   (c) the shipped gate still REJECTS at/above the new constant  (the gate
  //       was raised, not removed).
  const sizeRoot = `c2094-rv-size-${stamp}`;
  const filler = Buffer.alloc(30_000_000, 0x41);
  const sizeUp = upload(sizeRoot, `cinatra 2094 S7 reverify size ${stamp}`, [
    { relPath: "references/filler.txt", bytes: filler },
  ]);
  const gateOnObserved = checkSkillBoundary(sizeUp.canonical);
  const oldGate = checkSkillBoundary(sizeUp.canonical, 30_000_000);

  const sizeRes = await call("POST", `${BASE}/v1/skills`, {
    body: (() => {
      const form = new FormData();
      form.set("display_title", sizeUp.displayTitle);
      form.append(
        "files[]",
        new Blob([new Uint8Array(sizeUp.zipBytes)], { type: "application/zip" }),
        `${sizeUp.rootDir}.zip`,
      );
      return form;
    })(),
  });
  if (sizeRes.ok) {
    const id = sizeRes.body.skill_id ?? sizeRes.body.id;
    if (id) created.push({ id });
  }
  // (c) an artifact AT the new constant must still be refused by the gate.
  const atLimit = checkSkillBoundary({
    rootDir: sizeRoot,
    zipBytes: Buffer.alloc(0),
    archiveBytes: ANTHROPIC_SKILL_MAX_UPLOAD_BYTES,
    uncompressedTotal: 1,
    entryPaths: [],
  });

  const r10Pass =
    sizeRes.ok && gateOnObserved.exceeded === false && oldGate.exceeded === true && atLimit.exceeded === true;
  record(
    "R10 the upload gate agrees with the live API — the measured false rejection is lifted, the gate is not removed",
    r10Pass ? "PASS" : "FAIL",
    {
      shippedConstant: ANTHROPIC_SKILL_MAX_UPLOAD_BYTES,
      previousConstant: 30_000_000,
      archiveBytes: sizeUp.canonical.archiveBytes,
      uncompressedTotalBytes: sizeUp.canonical.uncompressedTotal,
      observed: {
        apiAcceptedTheArtifact: sizeRes.ok,
        apiStatus: sizeRes.status,
        shippedGateAcceptsIt: gateOnObserved.exceeded === false,
        oldGateWouldHaveRejectedIt: oldGate.exceeded === true,
        oldGateRejectionDimension: oldGate.exceeded ? oldGate.dimension : null,
        gateStillRejectsAtTheNewConstant: atLimit.exceeded === true,
      },
      whatIsLiveVsLocal: {
        live: "ONLY `apiAcceptedTheArtifact` — a real POST /v1/skills returned 200 for this artifact.",
        local:
          "`shippedGateAcceptsIt`, `oldGateWouldHaveRejectedIt` and `gateStillRejectsAtTheNewConstant` are " +
          "in-process checkSkillBoundary() calls, and the at-limit case is a SYNTHETIC object, not an upload. " +
          "They prove the gate's own arithmetic, not server agreement.",
        doNotSay:
          "'live-proven in all three directions' — that would be false. One direction is live; two are local.",
      },
      note: r10Pass
        ? "the API accepts an artifact the 30,000,000 gate refused (LIVE), and the shipped gate both accepts " +
          "that artifact and still rejects at/above its own constant (LOCAL) — the false rejection is lifted " +
          "and the gate was raised rather than removed"
        : "the boundary claim did not hold on this run",
      boundsCaveat:
        "this measures a LOWER bound only: the server's threshold is strictly greater than the largest " +
        "artifact it accepted (see archiveBytes/uncompressedTotalBytes above). An evidence-only constant " +
        "under `>=` semantics would be that value + 1. The shipped 31,457,280 is instead the docs-based " +
        "policy reading (30 MiB) — consistent with the measurement but NOT derived from it, since nothing " +
        "between the observed floor and 31,457,280 was probed in either direction. Probing near 31,457,280 " +
        "is the follow-up that would upgrade the top of that band from inference to evidence.",
    },
  );
}

async function cleanup() {
  for (const { id } of [...created]) {
    const versions = [];
    let page = null;
    for (let i = 0; i < 200; i++) {
      const qs = new URLSearchParams({ limit: "100" });
      if (page) qs.set("page", page);
      const r = await call("GET", `${BASE}/v1/skills/${encodeURIComponent(id)}/versions?${qs}`);
      if (!r.ok) break;
      for (const v of r.body.data ?? r.body.versions ?? []) {
        versions.push(typeof v === "string" ? v : v.version);
      }
      if (r.body.has_more !== true || r.body.next_page == null) break;
      page = r.body.next_page;
    }
    // Count only deletes the server ACCEPTED (2xx, or 404 = already gone).
    // Counting attempts would let a run report a clean reclamation it never
    // achieved.
    let versionsAccepted = 0;
    for (const v of versions) {
      const dv = await call(
        "DELETE",
        `${BASE}/v1/skills/${encodeURIComponent(id)}/versions/${encodeURIComponent(v)}`,
      );
      if (dv.ok || dv.status === 404) versionsAccepted += 1;
    }
    results.cleanup.versionDeletes += versionsAccepted;
    const d = await call("DELETE", `${BASE}/v1/skills/${encodeURIComponent(id)}`);
    if (d.ok || d.status === 404) results.cleanup.skillDeletes += 1;
    results.cleanup.attempted.push({
      skill: rid(id),
      versionsFound: versions.length,
      versionDeletesAccepted: versionsAccepted,
      skillDeleteStatus: d.status,
      skillDeleteAccepted: d.ok || d.status === 404,
    });
  }
  // Reclamation is verified ONLY by a definitive 404. A 401/429/5xx says nothing
  // about whether the skill is gone, so it must not be scored as reclaimed.
  let leftover = 0;
  let indeterminate = 0;
  for (const { id } of created) {
    const g = await call("GET", `${BASE}/v1/skills/${encodeURIComponent(id)}`);
    if (g.ok) leftover += 1;
    else if (g.status !== 404) indeterminate += 1;
  }
  results.cleanup.allReclaimed = leftover === 0 && indeterminate === 0;
  results.cleanup.leftoverCount = leftover;
  results.cleanup.indeterminateCount = indeterminate;
  if (indeterminate > 0) {
    results.cleanup.note =
      `${indeterminate} id(s) returned neither 200 nor 404 on the verification read — reclamation is ` +
      "INDETERMINATE for those, not confirmed. Re-run the reclamation before treating the workspace as clean.";
  }
}

let exitCode = 0;
try {
  await main();
} catch (err) {
  results.error = redactText(String(err?.message ?? err));
  exitCode = 1;
} finally {
  try {
    await cleanup();
  } catch (err) {
    results.cleanupError = redactText(String(err?.message ?? err));
  }
  results.summary = {
    total: results.checks.length,
    pass: results.checks.filter((c) => c.verdict === "PASS").length,
    fail: results.checks.filter((c) => c.verdict === "FAIL").length,
    other: results.checks
      .filter((c) => c.verdict !== "PASS" && c.verdict !== "FAIL")
      .map((c) => `${c.name} => ${c.verdict}`),
  };
  // A recorded FAIL, an unreclaimed upload, or an indeterminate reclamation must
  // make the PROCESS fail. Exiting 0 with FAILs in the JSON is exactly how a
  // "green" acceptance gets cited from a run that did not pass.
  if (results.summary.fail > 0) exitCode = 1;
  if (results.cleanup.allReclaimed !== true) exitCode = 1;
  if (results.cleanupError) exitCode = 1;
  results.exitCode = exitCode;
  results.headline =
    `${results.summary.pass} PASS / ${results.summary.fail} FAIL` +
    (results.summary.fail > 0 ? " — acceptance NOT complete (see the FAIL check's `finding`)" : "");

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    path.join(OUT_DIR, "live-reverify-results.json"),
    JSON.stringify(results, null, 2) + "\n",
  );
  console.log(
    `\n${results.summary.pass}/${results.summary.total} PASS, ${results.summary.fail} FAIL, ` +
      `${results.summary.other.length} other; ${results.requestCount} live requests; ` +
      `cleanup: ${results.cleanup.skillDeletes} skills / ${results.cleanup.versionDeletes} versions, ` +
      `allReclaimed=${results.cleanup.allReclaimed}`,
  );
  for (const o of results.summary.other) console.log(`  ! ${o}`);
}
process.exit(exitCode);
