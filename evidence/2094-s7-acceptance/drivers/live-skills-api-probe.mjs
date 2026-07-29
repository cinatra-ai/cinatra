/**
 * LIVE Anthropic Skills API conformance probe (cinatra#2094 S7).
 *
 * This is the live `container.skills` acceptance every prior stage of epic #2086
 * honestly deferred to S7. Every check below is a REAL round trip to
 * `api.anthropic.com` with the org key; nothing here is stubbed and nothing is
 * asserted from the docs alone. Each check is named, and its captured
 * request/response shape is written to `live-results.json`.
 *
 * WHAT IS PINNED
 * The conformance target is the Skills API as documented for the
 * `skills-2025-10-02` beta: `POST /v1/skills` (multipart, one `files[]` zip
 * rooted at a common directory, workspace-unique `display_title`),
 * `POST /v1/skills/{id}/versions` for a new immutable version, list endpoints
 * with a documented cursor scheme, "delete every version before the skill", and
 * request-time delivery via `container.skills` alongside the code-execution
 * tool. The docs revision consulted is recorded in `live-results.json` as
 * `docsPin`.
 *
 * SECRETS + LEAK DISCIPLINE (this file and its output land in a PUBLIC repo)
 *   - The key is read from the process env, never from argv, never printed.
 *   - Request HEADERS are never captured — `x-api-key` rides every call.
 *   - Remote `skill_…` ids are workspace-scoped identifiers, so every captured
 *     id is replaced by a stable salted digest token (`sk#<8 hex>`). The
 *     mapping is not written anywhere.
 *
 * CLEANUP
 * Every skill this probe uploads is deleted before exit, in the documented
 * versions-then-skill order — which is itself one of the conformance checks
 * (C8). The cleanup ledger is recorded so the report can state it as a fact.
 *
 * Usage:  PROBE_KEY=<key> node live-skills-api-probe.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
/** Redact any skill id appearing inside a free-text error body. */
function redactText(s) {
  if (typeof s !== "string") return s;
  let out = s.replace(/skill_[A-Za-z0-9]+/g, (m) => rid(m));
  return out.slice(0, 400);
}

const results = {
  probe: "cinatra#2094 S7 live Anthropic Skills API conformance",
  ranAt: new Date().toISOString(),
  live: true,
  docsPin: {
    surface: "Anthropic Skills API",
    betaRevision: "skills-2025-10-02",
    stackedBetas: BETAS,
    anthropicVersion: VERSION,
    consulted:
      "claude-api skill reference bundle 2.1.220 (shared/managed-agents-api-reference.md " +
      "Skills + Pagination sections; shared/tool-use-concepts.md Agent Skills (Messages API)); " +
      "live API treated as authoritative where docs prose and wire disagree",
  },
  checks: [],
  cleanup: { attempted: [], versionDeletes: 0, skillDeletes: 0, order: "versions-then-skill", allReclaimed: null },
  requestCount: 0,
};

function record(name, verdict, detail) {
  results.checks.push({ name, verdict, ...detail });
  const mark = verdict === "PASS" ? "PASS" : verdict === "FAIL" ? "FAIL" : verdict;
  console.log(`[${mark}] ${name}`);
}

function headers() {
  return { "x-api-key": KEY, "anthropic-version": VERSION, "anthropic-beta": BETAS };
}

async function call(method, url, init = {}) {
  results.requestCount += 1;
  const res = await fetch(url, { method, headers: headers(), ...init });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { __unparsed: text.slice(0, 300) };
  }
  return { status: res.status, ok: res.ok, body, text };
}

// ---------------------------------------------------------------------------
// Canonical rooted STORE zip — the same single-artifact shape the core client
// uploads (sorted paths, fixed 1980 DOS date, STORE, rooted at the frontmatter
// name). Reimplemented here deliberately: this probe must be able to run
// standalone against the API without booting the app's module graph. The
// COMMITTED regression suite asserts the same contract against the real
// production client classes (see the live-conformance vitest file).
// ---------------------------------------------------------------------------
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}
function buildRootedZip(rootDir, files) {
  const entries = files
    .map((f) => ({ path: `${rootDir}/${f.rel}`, bytes: f.bytes, crc: crc32(f.bytes) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const DOS_DATE = 0x0021;
  const DOS_TIME = 0x0000;
  const UTF8 = 0x0800;
  const local = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.path, "utf8");
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(10, 4);
    lh.writeUInt16LE(UTF8, 6);
    lh.writeUInt16LE(0, 8); // STORE
    lh.writeUInt16LE(DOS_TIME, 10);
    lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(e.crc, 14);
    lh.writeUInt32LE(e.bytes.length, 18);
    lh.writeUInt32LE(e.bytes.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    local.push(lh, name, e.bytes);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(10, 6);
    ch.writeUInt16LE(UTF8, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(DOS_TIME, 12);
    ch.writeUInt16LE(DOS_DATE, 14);
    ch.writeUInt32LE(e.crc, 16);
    ch.writeUInt32LE(e.bytes.length, 20);
    ch.writeUInt32LE(e.bytes.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + e.bytes.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, eocd]);
}

function skillMd(name, description) {
  return Buffer.from(`---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nProbe bundle for cinatra#2094 S7 live acceptance. Safe to delete.\n`);
}

function multipart(displayTitle, rootDir, zipBytes) {
  const form = new FormData();
  form.set("display_title", displayTitle);
  form.append("files[]", new Blob([new Uint8Array(zipBytes)], { type: "application/zip" }), `${rootDir}.zip`);
  return form;
}

const created = []; // { id, rootDir } — every one is cleaned up

async function createSkill(rootDir, displayTitle, extraFiles = []) {
  const zip = buildRootedZip(rootDir, [
    { rel: "SKILL.md", bytes: skillMd(rootDir, `cinatra 2094 S7 probe bundle ${rootDir}`) },
    ...extraFiles,
  ]);
  const r = await call("POST", `${BASE}/v1/skills`, { body: multipart(displayTitle, rootDir, zip) });
  if (r.ok) {
    const id = r.body.skill_id ?? r.body.id;
    if (id) created.push({ id, rootDir });
  }
  return { ...r, zipBytes: zip.length };
}

async function main() {
  const stamp = Date.now().toString(36);

  // -- C1 rooted-zip multipart create is accepted on the wire ---------------
  const rootA = `c2094-probe-a-${stamp}`;
  const titleA = `cinatra 2094 S7 probe A ${stamp}`;
  const c1 = await createSkill(rootA, titleA);
  const c1Id = c1.body?.skill_id ?? c1.body?.id;
  record("C1 rooted-zip multipart create accepted (display_title + single files[] zip)", c1.ok ? "PASS" : "FAIL", {
    status: c1.status,
    request: {
      method: "POST",
      path: "/v1/skills",
      contentType: "multipart/form-data",
      fields: ["display_title", "files[]"],
      filesPartCount: 1,
      filesPartType: "application/zip",
      zipRootedAt: `${rootA}/`,
      zipEntries: [`${rootA}/SKILL.md`],
      zipBytes: c1.zipBytes,
    },
    responseShape: c1.ok ? Object.keys(c1.body).sort() : null,
    responseRedacted: c1.ok
      ? { id: rid(c1Id), latest_version: c1.body.latest_version, type: c1.body.type ?? null }
      : { error: redactText(c1.text) },
  });
  if (!c1.ok) {
    results.fatal = "C1 create failed — remaining live checks cannot run";
    return;
  }

  // -- C2 new immutable version on the same skill ---------------------------
  const zipA2 = buildRootedZip(rootA, [
    { rel: "SKILL.md", bytes: skillMd(rootA, `cinatra 2094 S7 probe bundle ${rootA} rev2`) },
    { rel: "references/notes.md", bytes: Buffer.from("# routed reference\n\nsecond revision adds a one-hop reference file.\n") },
  ]);
  const c2 = await call("POST", `${BASE}/v1/skills/${encodeURIComponent(c1Id)}/versions`, {
    body: multipart(titleA, rootA, zipA2),
  });
  record("C2 POST /v1/skills/{id}/versions mints a NEW immutable version (multi-file bundle)", c2.ok ? "PASS" : "FAIL", {
    status: c2.status,
    request: { zipRootedAt: `${rootA}/`, zipEntries: [`${rootA}/SKILL.md`, `${rootA}/references/notes.md`], zipBytes: zipA2.length },
    responseShape: c2.ok ? Object.keys(c2.body).sort() : null,
    versionChanged: c2.ok ? (c2.body.version ?? c2.body.latest_version) !== c1.body.latest_version : null,
    responseRedacted: c2.ok ? { version: c2.body.version ?? c2.body.latest_version } : { error: redactText(c2.text) },
  });

  // -- C3 the REAL list-pagination contract for GET /v1/skills -------------
  // The core client walks `has_more` + `last_id` -> `after_id`. This check does
  // not assume that is right; it reads the wire and reports which cursor the
  // API actually returns.
  const listRaw = await call("GET", `${BASE}/v1/skills?source=custom&limit=1`);
  const listKeys = listRaw.ok ? Object.keys(listRaw.body).sort() : null;
  const hasLastId = listRaw.ok && typeof listRaw.body.last_id === "string";
  const hasNextPage = listRaw.ok && listRaw.body.next_page != null;
  // Does the cursor the CLIENT sends actually advance the page?
  let afterIdAdvances = null;
  let pageAdvances = null;
  if (listRaw.ok && listRaw.body.has_more === true) {
    const firstId = listRaw.body.data?.[0]?.id ?? null;
    if (firstId) {
      const viaAfterId = await call("GET", `${BASE}/v1/skills?source=custom&limit=1&after_id=${encodeURIComponent(firstId)}`);
      afterIdAdvances = viaAfterId.ok && viaAfterId.body.data?.[0]?.id !== firstId;
    }
    if (hasNextPage) {
      const viaPage = await call("GET", `${BASE}/v1/skills?source=custom&limit=1&page=${encodeURIComponent(listRaw.body.next_page)}`);
      pageAdvances = viaPage.ok && viaPage.body.data?.[0]?.id !== (listRaw.body.data?.[0]?.id ?? null);
    }
  }
  record("C3 GET /v1/skills real cursor contract (client assumes has_more+last_id -> after_id)", hasLastId ? "PASS" : "FAIL", {
    status: listRaw.status,
    responseShape: listKeys,
    observed: {
      has_more: listRaw.ok ? listRaw.body.has_more : null,
      last_id_present: hasLastId,
      next_page_present: hasNextPage,
      after_id_advances_page: afterIdAdvances,
      page_param_advances_page: pageAdvances,
    },
    note: hasLastId
      ? "wire returns last_id — the client's cursor is correct"
      : "wire does NOT return last_id; the client's paginated walk terminates after page 1",
  });

  // -- C4 versions-list pagination over a genuinely MULTI-PAGE history ------
  // Third version so the history is 3 rows; limit=1 forces >1 page.
  const zipA3 = buildRootedZip(rootA, [{ rel: "SKILL.md", bytes: skillMd(rootA, `cinatra 2094 S7 probe bundle ${rootA} rev3`) }]);
  await call("POST", `${BASE}/v1/skills/${encodeURIComponent(c1Id)}/versions`, { body: multipart(titleA, rootA, zipA3) });

  const vPage1 = await call("GET", `${BASE}/v1/skills/${encodeURIComponent(c1Id)}/versions?limit=1`);
  const vKeys = vPage1.ok ? Object.keys(vPage1.body).sort() : null;
  const vHasLastId = vPage1.ok && typeof vPage1.body.last_id === "string";
  const vHasNextPage = vPage1.ok && vPage1.body.next_page != null;
  // Walk to exhaustion using WHICHEVER cursor the API actually returns, so we
  // learn the true version count independent of the client's assumption.
  const trueVersions = [];
  {
    let page = null;
    for (let i = 0; i < 50; i++) {
      const qs = new URLSearchParams({ limit: "1" });
      if (page) qs.set("page", page);
      const r = await call("GET", `${BASE}/v1/skills/${encodeURIComponent(c1Id)}/versions?${qs}`);
      if (!r.ok) break;
      for (const v of r.body.data ?? r.body.versions ?? []) {
        trueVersions.push(typeof v === "string" ? v : v.version);
      }
      if (r.body.has_more !== true) break;
      if (r.body.next_page == null) break;
      page = r.body.next_page;
    }
  }
  // Now the client's own walk shape (has_more + last_id -> after_id), replayed
  // verbatim, to show what the production GC would have seen.
  const clientWalk = [];
  {
    let afterId;
    for (let i = 0; i < 50; i++) {
      const qs = new URLSearchParams({ limit: "100" });
      if (afterId) qs.set("after_id", afterId);
      const r = await call("GET", `${BASE}/v1/skills/${encodeURIComponent(c1Id)}/versions?${qs}`);
      if (!r.ok) break;
      for (const v of r.body.data ?? r.body.versions ?? []) {
        clientWalk.push(typeof v === "string" ? v : v.version);
      }
      if (r.body.has_more !== true || !r.body.last_id) break;
      afterId = r.body.last_id;
    }
  }
  record("C4 versions-list pagination to exhaustion over a multi-page history", vHasLastId ? "PASS" : "FAIL", {
    status: vPage1.status,
    responseShape: vKeys,
    observed: {
      limit_requested: 1,
      rows_on_page_1: (vPage1.body?.data ?? vPage1.body?.versions ?? []).length,
      has_more: vPage1.ok ? vPage1.body.has_more : null,
      last_id_present: vHasLastId,
      next_page_present: vHasNextPage,
      trueVersionCount: trueVersions.length,
      clientWalkVersionCount: clientWalk.length,
      clientWalkSawEveryVersion: trueVersions.length > 0 && clientWalk.length === trueVersions.length,
    },
    note: vHasLastId
      ? "wire returns last_id — the GC walk exhausts the history"
      : "wire returns next_page, not last_id: the client's walk reads only page 1. With limit=100 " +
        "a <=100-version history still fits one page, so the GC is correct today and becomes " +
        "wrong past 100 versions.",
  });

  // -- C5 documented delete ORDER is enforced by the API -------------------
  // Delete the skill while versions are still present; the documented contract
  // is that this is refused until every version is deleted.
  const premature = await call("DELETE", `${BASE}/v1/skills/${encodeURIComponent(c1Id)}`);
  record("C5 skill delete is REFUSED while undeleted versions remain (delete-order enforcement)", !premature.ok ? "PASS" : "FAIL", {
    status: premature.status,
    refused: !premature.ok,
    errorRedacted: redactText(premature.text),
    note: premature.ok
      ? "API ACCEPTED a skill delete with versions still present — the ordering is not server-enforced; " +
        "the core GC's versions-first ordering is therefore a client-side invariant only"
      : "API refused, matching the documented versions-before-skill ordering",
  });

  // -- C6 versions-then-skill delete order succeeds -----------------------
  let orderOk = true;
  const remaining = trueVersions.length ? trueVersions : clientWalk;
  for (const v of remaining) {
    const d = await call("DELETE", `${BASE}/v1/skills/${encodeURIComponent(c1Id)}/versions/${encodeURIComponent(v)}`);
    results.cleanup.versionDeletes += 1;
    if (!d.ok && d.status !== 404 && d.status !== 410) orderOk = false;
  }
  const skillDel = await call("DELETE", `${BASE}/v1/skills/${encodeURIComponent(c1Id)}`);
  results.cleanup.skillDeletes += 1;
  results.cleanup.attempted.push({ skill: rid(c1Id), versions: remaining.length, finalStatus: skillDel.status });
  if (skillDel.ok || skillDel.status === 404 || skillDel.status === 410) {
    const i = created.findIndex((c) => c.id === c1Id);
    if (i >= 0) created.splice(i, 1);
  }
  record("C6 versions-then-skill delete order reclaims the remote skill", orderOk && (skillDel.ok || skillDel.status === 404) ? "PASS" : "FAIL", {
    versionsDeleted: remaining.length,
    skillDeleteStatus: skillDel.status,
    everyVersionDeleteAccepted: orderOk,
  });

  // -- C7 display_title collision handling --------------------------------
  const rootB = `c2094-probe-b-${stamp}`;
  const titleB = `cinatra 2094 S7 probe B ${stamp}`;
  const b1 = await createSkill(rootB, titleB);
  const rootB2 = `c2094-probe-b2-${stamp}`;
  const b2 = await createSkill(rootB2, titleB); // same display_title, different bundle
  const collisionDetail = redactText(b2.text);
  // Replay the core client's own conflict classifier against the REAL body.
  const lower = collisionDetail.toLowerCase();
  const classifierMatches =
    (b2.status === 400 || b2.status === 409) &&
    lower.includes("display_title") &&
    (lower.includes("unique") ||
      lower.includes("already") ||
      lower.includes("exist") ||
      lower.includes("taken") ||
      lower.includes("conflict"));
  record("C7 display_title collision is rejected AND classified by isDisplayTitleConflict", b2.ok ? "UNIQUE-NOT-ENFORCED" : classifierMatches ? "PASS" : "FAIL", {
    firstCreateStatus: b1.status,
    secondCreateStatus: b2.status,
    duplicateAccepted: b2.ok,
    errorRedacted: collisionDetail,
    coreClassifierMatchesRealBody: classifierMatches,
    note: b2.ok
      ? "the API accepted a DUPLICATE display_title — workspace-uniqueness is not enforced server-side, " +
        "so the client's create-time collision reconciliation never triggers in practice"
      : classifierMatches
        ? "real 4xx body is matched by the shipped isDisplayTitleConflict predicate"
        : "collision rejected, but the shipped predicate does NOT match the real body — reconciliation would rethrow",
  });

  // -- C8 the per-request container.skills cap ----------------------------
  // Upload enough distinct skills to probe the boundary at 8/9.
  const capRefs = [];
  if (b1.ok) capRefs.push({ id: b1.body.skill_id ?? b1.body.id, version: b1.body.latest_version });
  if (b2.ok) capRefs.push({ id: b2.body.skill_id ?? b2.body.id, version: b2.body.latest_version });
  for (let i = capRefs.length; i < 9; i++) {
    const r = await createSkill(`c2094-probe-cap${i}-${stamp}`, `cinatra 2094 S7 probe cap ${i} ${stamp}`);
    if (r.ok) capRefs.push({ id: r.body.skill_id ?? r.body.id, version: r.body.latest_version });
  }
  async function probeCap(n) {
    const body = {
      model: "claude-opus-5",
      max_tokens: 16,
      container: {
        skills: capRefs.slice(0, n).map((r) => ({ type: "custom", skill_id: r.id, version: r.version })),
      },
      tools: [{ type: "code_execution_20260521", name: "code_execution" }],
      messages: [{ role: "user", content: "Reply with the single word ok." }],
    };
    const r = await call("POST", `${BASE}/v1/messages`, {
      body: JSON.stringify(body),
      headers: { ...headers(), "content-type": "application/json" },
    });
    return { n, status: r.status, accepted: r.ok, errorRedacted: r.ok ? null : redactText(r.text) };
  }
  const cap8 = capRefs.length >= 8 ? await probeCap(8) : { n: 8, skipped: "not enough uploaded skills" };
  const cap9 = capRefs.length >= 9 ? await probeCap(9) : { n: 9, skipped: "not enough uploaded skills" };
  record(
    "C8 container.skills per-request cap — 8 accepted, 9 rejected",
    cap8.accepted === true && cap9.accepted === false
      ? "PASS"
      : cap8.accepted === true && cap9.accepted === true
        ? "CAP-NOT-8"
        : "FAIL",
    {
      uploadedRefs: capRefs.length,
      at8: cap8,
      at9: cap9,
      requestShape: {
        container: { skills: [{ type: "custom", skill_id: "<redacted>", version: "<version>" }] },
        tools: [{ type: "code_execution_20260521", name: "code_execution" }],
        betas: BETAS,
      },
      note:
        cap8.accepted === true && cap9.accepted === true
          ? "the API accepted NINE skills in one request — cinatra's hard cap of 8 is a self-imposed " +
            "conservative limit, not the API's own ceiling"
          : cap8.accepted === true && cap9.accepted === false
            ? "the 8-per-request ceiling is real and server-enforced"
            : "the 8-skill request itself did not succeed — see at8.errorRedacted",
    },
  );

  // -- C9 fail-closed resolution of an UNSYNCED skill ---------------------
  // Reference a syntactically-valid but non-existent remote skill id. The
  // point is that an unresolvable reference is a hard error at the boundary,
  // never a silent degrade to a function tool.
  const bogus = await call("POST", `${BASE}/v1/messages`, {
    body: JSON.stringify({
      model: "claude-opus-5",
      max_tokens: 16,
      container: { skills: [{ type: "custom", skill_id: "skill_01thisdoesnotexist2094", version: "1" }] },
      tools: [{ type: "code_execution_20260521", name: "code_execution" }],
      messages: [{ role: "user", content: "Reply with the single word ok." }],
    }),
    headers: { ...headers(), "content-type": "application/json" },
  });
  record("C9 an unresolvable container.skills reference fails CLOSED at the API boundary", !bogus.ok ? "PASS" : "FAIL", {
    status: bogus.status,
    rejected: !bogus.ok,
    errorRedacted: redactText(bogus.text),
    note: bogus.ok
      ? "the API ACCEPTED a non-existent skill id — a stale local mapping would silently deliver nothing"
      : "unknown skill id is rejected, so a stale mapping surfaces rather than silently dropping the skill",
  });

  // -- C10 the size boundary rule -----------------------------------------
  // The core gate rejects at >= 30,000,000 bytes on EITHER dimension. Probe
  // the live API just OVER that boundary with a single request so the local
  // constant is grounded in the real limit rather than in docs prose.
  const overRoot = `c2094-probe-size-${stamp}`;
  const filler = Buffer.alloc(30_000_000, 0x41); // incompressible-by-STORE payload
  const overZip = buildRootedZip(overRoot, [
    { rel: "SKILL.md", bytes: skillMd(overRoot, "size boundary probe") },
    { rel: "references/filler.txt", bytes: filler },
  ]);
  const over = await call("POST", `${BASE}/v1/skills`, {
    body: multipart(`cinatra 2094 S7 probe size ${stamp}`, overRoot, overZip),
  });
  if (over.ok) {
    const id = over.body.skill_id ?? over.body.id;
    if (id) created.push({ id, rootDir: overRoot });
  }
  record("C10 an upload at/over the 30,000,000-byte boundary is rejected by the API", !over.ok ? "PASS" : "FAIL", {
    localGateConstant: 30_000_000,
    archiveBytes: overZip.length,
    uncompressedTotalBytes: filler.length + skillMd(overRoot, "size boundary probe").length,
    status: over.status,
    rejected: !over.ok,
    errorRedacted: redactText(over.text),
    note: !over.ok
      ? "the live API refuses the over-boundary artifact, so the local >=30,000,000 gate is not stricter than reality"
      : "the live API ACCEPTED an artifact at/over 30,000,000 bytes — the documented 'under 30 MB' limit is " +
        "either higher or measured differently; the local gate is conservative, not wrong",
  });
}

async function cleanup() {
  for (const { id } of [...created]) {
    // Documented order: every version first, then the skill.
    const versions = [];
    let page = null;
    for (let i = 0; i < 50; i++) {
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
    for (const v of versions) {
      await call("DELETE", `${BASE}/v1/skills/${encodeURIComponent(id)}/versions/${encodeURIComponent(v)}`);
      results.cleanup.versionDeletes += 1;
    }
    const d = await call("DELETE", `${BASE}/v1/skills/${encodeURIComponent(id)}`);
    results.cleanup.skillDeletes += 1;
    results.cleanup.attempted.push({ skill: rid(id), versions: versions.length, finalStatus: d.status });
  }
  // Verify nothing this run uploaded is left behind.
  let leftover = 0;
  for (const { id } of created) {
    const g = await call("GET", `${BASE}/v1/skills/${encodeURIComponent(id)}`);
    if (g.ok) leftover += 1;
  }
  results.cleanup.allReclaimed = leftover === 0;
  results.cleanup.leftoverCount = leftover;
}

let exitCode = 0;
try {
  await main();
} catch (err) {
  results.error = redactText(String(err && err.message ? err.message : err));
  exitCode = 1;
} finally {
  try {
    await cleanup();
  } catch (err) {
    results.cleanupError = redactText(String(err && err.message ? err.message : err));
  }
  results.summary = {
    total: results.checks.length,
    pass: results.checks.filter((c) => c.verdict === "PASS").length,
    fail: results.checks.filter((c) => c.verdict === "FAIL").length,
    other: results.checks.filter((c) => c.verdict !== "PASS" && c.verdict !== "FAIL").map((c) => `${c.name} => ${c.verdict}`),
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(path.join(OUT_DIR, "live-results.json"), JSON.stringify(results, null, 2) + "\n");
  console.log(
    `\n${results.summary.pass}/${results.summary.total} PASS, ${results.summary.fail} FAIL, ` +
      `${results.summary.other.length} other; ${results.requestCount} live requests; ` +
      `cleanup: ${results.cleanup.skillDeletes} skills / ${results.cleanup.versionDeletes} versions, ` +
      `allReclaimed=${results.cleanup.allReclaimed}`,
  );
  for (const o of results.summary.other) console.log(`  ! ${o}`);
}
process.exit(exitCode);
