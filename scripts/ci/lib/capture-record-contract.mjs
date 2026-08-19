#!/usr/bin/env node
// ---------------------------------------------------------------------------
// CAPTURE-RECORD CONTRACT — the evidence half of the chat-HITL anti-fraud gates
// (cinatra#2821, epic #2784 S9h).
//
// WHAT IT REFUSES. A screenshot filed under a host it does not show. #2794's
// first round filed pictures of the Agents page under chat-cell names, and
// nothing ever compared a capture's CLAIM to what was observed on the screen,
// because the claim lived in the FILENAME and a filename carries no authority.
//
// SO: a cell name is a claim, and a claim needs a record. Each record carries
// the cell it answers, the host it declares, the final URL, the screenshot with
// its SHA-256, and frame-scoped selector assertions with the counts observed on
// that screen. This contract checks the record against the claim:
//
//   - the cell name's host/kind/state tokens must equal the record's;
//   - the final URL must be of the host's URL class (a `/chat` claim answered by
//     an `/agents/...` URL is the exact #2794 defect);
//   - the host's required anchors must have been observed, IN THE SAME FRAME,
//     with counts >= 1 -- `[data-conversation-list]` alone does NOT identify
//     chat_thread, because the widget transcript ships the same list, so the
//     card root's own `data-lifecycle-card-host` declaration is required beside
//     it;
//   - a `pending` capture owes its decision controls; a `decided` capture owes
//     their ABSENCE and a decided summary, so the easier requirement set cannot
//     answer the harder claim;
//   - the screenshot must exist where it says, be repo-relative, and hash to
//     the recorded digest; and no two records may share a path or a digest, so
//     one picture cannot furnish a whole index.
//
// THE HONEST LIMIT, stated because a gate that overclaims is worse than none:
// these records are text, and text is forgeable. A person can hand-write a
// record with a real image and invented counts, and this contract will accept
// it. What it does catch is the accidental mislabel, the missing observation,
// the drifted hash, the re-used picture, and the cell that cites nothing at
// all -- which is every failure #2794's round actually produced. Binding pixels
// to assertions needs an attested capture run, which no committed evidence file
// in this repository has.
//
// Zero runtime dependencies (node builtins only).
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * THE ONE CANONICAL CAPTURE INDEX, named ONCE.
 *
 * Both halves read the same file, so both halves must compute the same path,
 * and the only way to guarantee that is to compute it in ONE place. Each reader
 * used to `join(__dirname, "chat-hitl-capture-index.json")` from its OWN
 * directory, which produced two different files that each called itself
 * canonical: the CI half's (populated) and the audit half's (empty). The empty
 * one was also the capture driver's default output, so an honest capture run
 * wrote its records where nothing would ever bind them.
 *
 * `CAPTURE_INDEX_PATH` is the absolute path every reader resolves;
 * `CAPTURE_INDEX_RELATIVE_PATH` is the same file as a repo-relative string, for
 * usage lines and messages. `scripts/ci/__tests__/capture-index-path.test.mjs`
 * pins that the CI gate, the audit gate and the driver all land on the one file.
 */
export const CAPTURE_INDEX_RELATIVE_PATH = "scripts/ci/chat-hitl-capture-index.json";
export const CAPTURE_INDEX_PATH = join(__dirname, "..", "chat-hitl-capture-index.json");

/**
 * THE ONE RECORDER IDENTITY, named ONCE, for the index header AND the per-record
 * `recordedBy` field.
 *
 * There were three: the CI index header said `chat-hitl-capture-recorder@1`, the
 * audit index header said `scripts/audit/lib/chat-hitl-capture-recorder.mjs@1`,
 * and every one of the eight committed records said this. This value wins
 * because it is the one already stamped on real records, and the same string is
 * mirrored in each lane's own `evidence/<slice>/capture-records.json` twin --
 * changing the index copies would silently desynchronize them from evidence
 * this branch does not own. Identity here is PROSE: neither validator hashes it
 * or derives anything from it, so the choice is about which committed text stays
 * true, not about what a check can verify.
 */
export const RECORDER_ID = "cinatra-lifecycle-capture-recorder@1";

/** The four hosts, mirroring `LIFECYCLE_CARD_HOSTS` in agent-ui-protocol. */
export const CAPTURE_HOSTS = [
  "chat_thread",
  "site_widget",
  "run_card",
  "page_gate_region",
];

/**
 * The URL classes. A claim about a host is a claim about WHERE the picture was
 * taken, so the class is checked against the recorded final URL rather than
 * against the requested one (a redirect is exactly how a capture ends up on the
 * wrong screen without anybody noticing).
 */
export const URL_CLASSES = {
  chat: /^\/chat(?:[/?#]|$)/,
  run_detail: /^\/agents\/[^/]+\/[^/]+\/[0-9a-fA-F-]{36}(?:[/?#]|$)/,
  review_page: /^\/agents\/reviews(?:[/?#]|$)/,
  embed_assistant: /^\/embed\/assistant(?:[/?#]|$)/,
};

/** Which URL class each host is photographed on. */
export const HOST_URL_CLASS = {
  chat_thread: "chat",
  run_card: "run_detail",
  page_gate_region: "review_page",
  site_widget: "embed_assistant",
};

/**
 * The card kinds, their cell-name tokens, their shipped root selector and the
 * decision controls a PENDING capture owes. Selectors are read off the shipped
 * components, not invented here:
 *   `packages/agents/src/review-gate-card.tsx`          (root + decision bar)
 *   `packages/agents/src/run-recommendation-chip-row.tsx` (per-chip confirm /
 *                                                        adjust / skip)
 */
export const CARD_KINDS = {
  artifact_review_gate: {
    cellTokens: ["review-card", "review-gate-card", "review"],
    root: '[data-lifecycle-card="artifact_review_gate"]',
    decisionControls: ['[data-conformance-id="review-decision-bar"]'],
  },
  recommendation_hold: {
    cellTokens: ["recommendation-hold", "recommendation-card", "recommendation"],
    root: '[data-lifecycle-card="recommendation_hold"]',
    // REDRAWN by cinatra#2841 to the ratified §V drawing: the card's decision
    // controls are PER CHIP (Confirm / Adjust / Skip on each skill), and the
    // row-level Confirm/Skip pair the previous selectors named no longer exists.
    // A pending capture owes at least one of the three; a decided capture owes
    // the absence of all three, which is exactly what a settled row draws.
    decisionControls: [
      '[data-skill-action="confirm"]',
      '[data-skill-action="adjust"]',
      '[data-skill-action="skip"]',
    ],
  },
  trigger_schedule_proposal: {
    cellTokens: ["trigger-card", "schedule-card", "trigger-schedule-proposal"],
    root: '[data-lifecycle-card="trigger_schedule_proposal"]',
    decisionControls: ["[data-action]"],
  },
  verification_summary: {
    cellTokens: ["verification-card", "audit-card", "verification"],
    root: '[data-lifecycle-card="verification_summary"]',
    decisionControls: ["[data-action]"],
  },
};

/** Cell-name state tokens, normalized to the two states evidence claims. */
export const STATE_ALIASES = {
  pending: "pending",
  held: "pending",
  open: "pending",
  "live-run": "pending",
  decided: "decided",
  settled: "decided",
  resolved: "decided",
  done: "decided",
};

/** The marker a decided capture owes -- the card says what was decided. */
export const DECIDED_SUMMARY_SELECTOR = "[data-lifecycle-card-state]";

/**
 * Parse a cell name into its claim. Returns null when the name carries no host
 * token -- an unclassifiable name is reported by the caller as its own finding,
 * never silently skipped.
 */
export function parseCellName(cellName) {
  if (typeof cellName !== "string" || cellName === "") return null;
  const base = cellName.replace(/\.[a-z0-9]+$/i, "");
  const tokens = base.split("__").filter(Boolean);
  const hostIndex = tokens.findIndex((t) => CAPTURE_HOSTS.includes(t));
  if (hostIndex < 0) return null;
  const host = tokens[hostIndex];
  const kindToken = hostIndex > 0 ? tokens[hostIndex - 1] : null;
  const kind =
    Object.entries(CARD_KINDS).find(([, spec]) =>
      spec.cellTokens.includes(kindToken ?? ""),
    )?.[0] ?? null;
  let state = null;
  for (const t of tokens.slice(hostIndex + 1)) {
    if (STATE_ALIASES[t]) {
      state = STATE_ALIASES[t];
      break;
    }
  }
  return { cell: base, host, kindToken, kind, state, tokens };
}

/**
 * The anchors a record must carry for its claim, each with the SCOPE it must
 * have been counted in:
 *   "frame" -- counted in the frame the picture was taken in;
 *   "root"  -- counted INSIDE the card's own root, so a marker borrowed from a
 *              different card on the same screen cannot answer for this one.
 */
export function requiredAssertionsFor({ host, kind, state }) {
  const spec = kind ? CARD_KINDS[kind] : null;
  const required = [];
  const forbidden = [];
  if (host === "chat_thread") {
    required.push({ selector: "[data-conversation-list]", scope: "frame" });
  }
  if (host === "site_widget") {
    required.push({ selector: ".cw-frame", scope: "page" });
    required.push({
      selector: '[data-embed-assistant][data-phase="active"]',
      scope: "frame",
    });
    required.push({ selector: "[data-conversation-list]", scope: "frame" });
  }
  required.push({
    selector: `[data-lifecycle-card-host="${host}"]`,
    scope: "frame",
  });
  if (spec) {
    required.push({ selector: spec.root, scope: "frame" });
    if (state === "pending") {
      for (const sel of spec.decisionControls) {
        required.push({ selector: sel, scope: "root", any: spec.decisionControls });
      }
    }
    if (state === "decided") {
      required.push({ selector: DECIDED_SUMMARY_SELECTOR, scope: "root" });
      for (const sel of spec.decisionControls) {
        forbidden.push({ selector: sel, scope: "root" });
      }
    }
  }
  return { required, forbidden };
}

function pathOf(url) {
  try {
    return new URL(url).pathname + (new URL(url).search || "");
  } catch {
    return typeof url === "string" && url.startsWith("/") ? url : null;
  }
}

/** sha256 of a file, read from DISK -- never re-derived from the record. */
export function sha256File(absPath) {
  return createHash("sha256").update(readFileSync(absPath)).digest("hex");
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Validate ONE record against its own claim.
 *
 * @param {object} record
 * @param {{repoRoot?: string, fileExists?: (p: string) => boolean, hashFile?: (p: string) => string}} [io]
 * @returns {Array<{code: string, detail: string}>}
 */
export function validateCaptureRecord(record, io = {}) {
  const repoRoot = io.repoRoot ?? process.cwd();
  const fileExists = io.fileExists ?? existsSync;
  const hashFile = io.hashFile ?? sha256File;
  const v = [];
  const push = (code, detail) => v.push({ code, detail });

  if (!record || typeof record !== "object") {
    return [{ code: "record/malformed", detail: "not an object" }];
  }
  const claim = parseCellName(record.cell);
  if (!claim) {
    push(
      "record/unclassifiable-cell",
      `cell "${record.cell}" carries no host token -- a name nobody can class is a claim nobody can check`,
    );
    return v;
  }
  if (record.declaredHost !== claim.host) {
    push(
      "record/host-claim-mismatch",
      `the cell name claims host "${claim.host}" but the record declares "${record.declaredHost}"`,
    );
  }
  if (claim.kind && record.declaredKind && record.declaredKind !== claim.kind) {
    push(
      "record/kind-claim-mismatch",
      `the cell name claims kind "${claim.kind}" but the record declares "${record.declaredKind}"`,
    );
  }
  if (claim.state && record.declaredState && record.declaredState !== claim.state) {
    push(
      "record/state-claim-mismatch",
      `the cell name claims state "${claim.state}" but the record declares "${record.declaredState}"`,
    );
  }

  // --- the URL class -------------------------------------------------------
  const host = record.declaredHost ?? claim.host;
  const wantedClass = HOST_URL_CLASS[host];
  const urlForClass =
    host === "site_widget" ? record.frameUrl ?? record.finalUrl : record.finalUrl;
  const p = pathOf(urlForClass);
  if (!p) {
    push("record/no-final-url", `no usable URL recorded for host "${host}"`);
  } else if (!URL_CLASSES[wantedClass]?.test(p)) {
    push(
      "record/url-class-mismatch",
      `host "${host}" is photographed on the ${wantedClass} URL class; this record was taken on "${p}"`,
    );
  }

  // --- the screenshot ------------------------------------------------------
  const shot = record.screenshot;
  if (typeof shot !== "string" || shot === "") {
    push("record/no-screenshot", "the record names no screenshot");
  } else if (shot.startsWith("/") || shot.includes("..")) {
    push(
      "record/screenshot-not-repo-relative",
      `"${shot}" is not a repo-relative path`,
    );
  } else {
    const abs = join(repoRoot, shot);
    if (!fileExists(abs)) {
      push("record/screenshot-missing", `"${shot}" does not exist in the tree`);
    } else if (!HEX64.test(String(record.sha256 ?? ""))) {
      push("record/sha256-malformed", `"${record.sha256}" is not a sha256 digest`);
    } else {
      const actual = hashFile(abs);
      if (actual !== record.sha256) {
        push(
          "record/sha256-mismatch",
          `"${shot}" hashes to ${actual}, the record says ${record.sha256}`,
        );
      }
    }
  }

  // --- the observations ----------------------------------------------------
  const assertions = Array.isArray(record.assertions) ? record.assertions : [];
  const observed = new Map();
  for (const a of assertions) {
    if (!a || typeof a.selector !== "string") {
      push("record/malformed-assertion", `assertion is not {selector, scope, count}`);
      continue;
    }
    if (!Number.isInteger(a.count) || a.count < 0) {
      push(
        "record/malformed-assertion",
        `"${a.selector}" carries no observed integer count`,
      );
      continue;
    }
    observed.set(`${a.scope ?? "frame"}::${a.selector}`, a.count);
  }
  const { required, forbidden } = requiredAssertionsFor({
    host,
    kind: record.declaredKind ?? claim.kind,
    state: record.declaredState ?? claim.state,
  });
  const satisfied = (sel, scope) => (observed.get(`${scope}::${sel}`) ?? 0) >= 1;
  for (const req of required) {
    // An `any` group is satisfied by any one of its members (Confirm OR Skip).
    if (req.any && req.any.some((s) => satisfied(s, req.scope))) continue;
    if (!observed.has(`${req.scope}::${req.selector}`)) {
      push(
        "record/anchor-never-observed",
        `"${req.selector}" (${req.scope}-scoped) was never looked for -- an unmeasured anchor counts as zero`,
      );
    } else if (!satisfied(req.selector, req.scope)) {
      push(
        "record/anchor-count-zero",
        `"${req.selector}" (${req.scope}-scoped) was observed 0 times on this screen`,
      );
    }
  }
  for (const f of forbidden) {
    if ((observed.get(`${f.scope}::${f.selector}`) ?? 0) > 0) {
      push(
        "record/decided-still-offers-decision",
        `a decided capture still shows "${f.selector}" -- it is not decided`,
      );
    }
  }
  return v;
}

/**
 * Validate a whole index: every record on its own terms, plus the two
 * index-level refusals that stop one picture from furnishing everything.
 *
 * @returns {{ byCell: Map<string, object>, violations: Array<{code: string, detail: string, cell?: string}> }}
 */
export function validateCaptureIndex(index, io = {}) {
  const violations = [];
  const byCell = new Map();
  const records = Array.isArray(index?.records) ? index.records : [];
  if (!Array.isArray(index?.records)) {
    violations.push({
      code: "index/malformed",
      detail: "the capture index has no `records` array",
    });
    return { byCell, violations };
  }
  const seenPath = new Map();
  const seenHash = new Map();
  for (const record of records) {
    const cell = record?.cell ?? "(unnamed)";
    for (const v of validateCaptureRecord(record, io)) {
      violations.push({ ...v, cell });
    }
    if (byCell.has(cell)) {
      violations.push({
        code: "index/duplicate-cell",
        detail: `cell "${cell}" is recorded twice`,
        cell,
      });
    } else {
      byCell.set(cell, record);
    }
    if (record?.screenshot) {
      const prev = seenPath.get(record.screenshot);
      if (prev) {
        violations.push({
          code: "index/duplicate-screenshot-path",
          detail: `"${record.screenshot}" already answers cell "${prev}"`,
          cell,
        });
      } else seenPath.set(record.screenshot, cell);
    }
    if (record?.sha256) {
      const prev = seenHash.get(record.sha256);
      if (prev) {
        violations.push({
          code: "index/duplicate-image",
          detail: `the same image already answers cell "${prev}" -- one picture cannot prove two screens`,
          cell,
        });
      } else seenHash.set(record.sha256, cell);
    }
  }
  return { byCell, violations };
}

/**
 * THE BINDING. Every cited cell whose name claims a BOUND host must resolve to
 * a VALID record. An unindexed screenshot counts as zero -- that is the whole
 * point: the filename stops being evidence.
 *
 * WHY chat_thread ALONE, today. cinatra#2821 rules the binding for the cells
 * that name `chat_thread`, because that is where the mislabel happened and
 * where the vocabulary is settled. The contract validates a record for ANY of
 * the four hosts already; what is scoped here is which citations are OBLIGED to
 * have one. A host joins `boundHosts` in the slice that produces its records --
 * widening it before then would only manufacture findings nobody can clear.
 *
 * @param {Array<{cell: string, citedBy: string}>} citedCells
 * @param {{byCell: Map<string, object>, violations: Array}} indexResult
 * @param {{boundHosts?: string[]}} [options]
 * @returns {Array<{code: string, detail: string, cell: string}>}
 */
export function bindEvidenceCells(citedCells, indexResult, options = {}) {
  const boundHosts = options.boundHosts ?? ["chat_thread"];
  const out = [];
  const invalidCells = new Set(
    indexResult.violations.filter((v) => v.cell).map((v) => v.cell),
  );
  for (const cited of citedCells) {
    const claim = parseCellName(cited.cell);
    if (!claim) continue; // reported by the caller's inventory arm
    if (!boundHosts.includes(claim.host)) continue;
    const record = indexResult.byCell.get(claim.cell);
    if (!record) {
      out.push({
        code: "evidence/unbound-cell",
        cell: claim.cell,
        detail: `${cited.citedBy} cites a "${claim.host}" capture that no index record answers -- an unindexed screenshot counts as zero`,
      });
      continue;
    }
    if (invalidCells.has(claim.cell)) {
      out.push({
        code: "evidence/invalid-record",
        cell: claim.cell,
        detail: `${cited.citedBy} cites a record that does not validate (see the record findings above)`,
      });
    }
  }
  return out;
}
