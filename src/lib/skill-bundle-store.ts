import "server-only";

// Bundle-aware skill content authority — the store PRIMITIVES (cinatra#2088,
// epic #2086 S1). Sits on the schema from src/lib/skill-bundle-schema.ts:
//   - skill_bundle_blobs  — raw-byte content-addressable blobs (text + binary)
//   - skill_revision_files — the immutable per-revision file manifest
//   - skill_revisions.bundle_digest — the revision identity cache
//
// The MANIFEST is authoritative for a revision's bundle identity: this module
// ALWAYS recomputes the bundle digest from the manifest rows (the pure
// `computeBundleDigest` over the sorted (path, digest) set) and, when the
// cached `skill_revisions.bundle_digest` column is present, ASSERTS they agree
// (fail-closed — never return a bundle whose stored identity disagrees with its
// manifest). The column is a convenience populated at revision-INSERT time
// (`skill_revisions` is append-only, so it can never be UPDATED afterward); a
// legacy revision ingested by backfill leaves it NULL and relies on the
// recomputed identity.
//
// bytea crosses the synchronous pg worker (src/lib/postgres-sync) as base64
// TEXT in BOTH directions — a Node Buffer does not survive the worker's
// JSON-file result marshaling as a Buffer, and a structured-cloned Uint8Array
// is not a reliable bytea bind — so writes bind `decode($n,'base64')` and reads
// project `encode(content,'base64')`. Digests are computed in JS and re-verified
// by the table's DB CHECK (content_digest = encode(sha256(content),'hex')), so a
// wrong blob can never be stored.

import { createHash } from "node:crypto";
import { mkdir, writeFile, rm, rename, readFile, readdir, lstat } from "node:fs/promises";
import path from "node:path";

import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";

/** One file entering a bundle write: a bundle-relative path + its raw bytes. */
export interface BundleFileInput {
  /** Path relative to the bundle root (POSIX or native — normalized on write). */
  path: string;
  /** Raw file bytes. */
  bytes: Buffer;
  /** Unix file mode (default 0o644 = 420). */
  mode?: number;
  /** Whether this is the SKILL.md router (defaulted from the path when absent). */
  isRouter?: boolean;
}

/** One file resolved FROM the authority: manifest metadata + the durable bytes. */
export interface BundleFile {
  path: string;
  digest: string;
  byteLength: number;
  mode: number;
  isRouter: boolean;
  bytes: Buffer;
}

/** A revision's full bundle read atomically from the authority. */
export interface RevisionBundle {
  revisionId: string;
  skillId: string;
  /** The revision identity — recomputed from the manifest (authoritative). */
  bundleDigest: string;
  files: BundleFile[];
}

/** A single bundle write: a revision id, its owning skill, and its file set. */
export interface RevisionBundleWrite {
  revisionId: string;
  skillId: string;
  files: BundleFileInput[];
}

// ---------------------------------------------------------------------------
// PURE BUNDLE-IDENTITY HELPERS — inlined here on purpose (cinatra#2088).
//
// They are NOT imported from `@cinatra-ai/llm`: `src/lib/database.ts` imports
// this store, the llm barrel re-exports `packages/llm/src/registry.ts`, and that
// module imports `@/lib/database` — so a package import here closes a CIRCULAR
// import through the app's central store hub. In the Next production bundle that
// cycle left an unrelated module namespace undefined and prod boot never
// answered /api/health.
//
// They also do not live in a separate `src/lib` leaf: this store is reachable
// from every locked route, so a new module would add +1 to every route's
// first-party graph count and push the route-graph ratchet over its ceilings.
// Inlining keeps the graph flat (narrow, don't absorb).
//
// `normalizeBundledRelPath` is a faithful twin of the identically named function
// in `packages/llm/src/tools/anthropic-skill-content-hash.ts` (the canonical-zip
// builder needs it package-side). The two are pinned together by the drift test
// in `src/lib/__tests__/skill-bundle-digest.test.ts`, so a bundle can never
// normalize one way for the stored manifest and another for the uploaded zip.
// ---------------------------------------------------------------------------

/**
 * Normalize a bundled file's relative path: backslashes → `/`, `.` segments
 * dropped, and absolute / `..`-traversal / empty paths REJECTED (throws).
 */
export function normalizeBundledRelPath(relPath: string): string {
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new Error(`[skill-bundle-digest] empty bundled file path`);
  }
  const posix = relPath.replaceAll("\\", "/");
  if (posix.startsWith("/")) {
    throw new Error(
      `[skill-bundle-digest] absolute bundled path rejected: ${relPath}`,
    );
  }
  const segments = posix.split("/").filter((s) => s.length > 0 && s !== ".");
  if (segments.some((s) => s === "..")) {
    throw new Error(
      `[skill-bundle-digest] path traversal ('..') rejected: ${relPath}`,
    );
  }
  if (segments.length === 0) {
    throw new Error(
      `[skill-bundle-digest] bundled path resolves to empty: ${relPath}`,
    );
  }
  return segments.join("/");
}

// ===========================================================================
// Bundle digest — the REVISION IDENTITY over a bundle's manifest (cinatra#2088,
// epic #2086 S1). Where `computeSkillContentHash` frames the raw BYTES inline,
// the bundle digest is computed over the sorted `(path, content_digest)` set —
// so it can be recomputed from the immutable revision-file manifest ALONE
// (path + per-file sha256), with no need to re-read the bytes. That is what
// lets byte-bound sync bind a remote upload to the exact stored revision:
// the manifest's digest travels with the candidate and IS the drift signal,
// and materialized directory ⇄ DB manifest ⇄ canonical zip all agree on it
// because each is framed from the same `(path, digest)` pairs.
// ===========================================================================

/** One manifest entry as it enters the bundle digest: a normalized path + the
 * sha256 hex digest of that file's raw bytes. `isRouter` marks the single
 * `SKILL.md` router; it is NOT part of the digest (the router is identified by
 * its canonical path, so router-ness can never silently change the identity). */
export type BundleManifestEntry = {
  /** Path relative to the bundle root (POSIX or native — normalized here). */
  path: string;
  /** sha256 hex digest of the file's raw bytes. */
  digest: string;
};

/** The canonical `SKILL.md` router path every bundle must carry exactly once. */
export const SKILL_ROUTER_PATH = "SKILL.md";

/**
 * Compute the deterministic bundle digest over a manifest's `(path, digest)`
 * set. Pure + order-independent (sorted internally by normalized path). Paths
 * are normalized + rejected exactly as {@link normalizeBundledRelPath} (throws
 * on absolute / `..` / duplicate) so a manifest can never frame to the same
 * bytes as a different file set, and can never carry a path the drift hash or
 * the canonical zip would refuse.
 *
 * @throws on an empty manifest, an absent/duplicate router, an invalid path, a
 *   duplicate normalized path, or a malformed digest.
 */
export function computeBundleDigest(entries: BundleManifestEntry[]): string {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`[skill-bundle-digest] empty manifest — a bundle must carry at least SKILL.md`);
  }
  const normalized = entries.map((e) => {
    const path = normalizeBundledRelPath(e.path);
    if (typeof e.digest !== "string" || !/^[0-9a-f]{64}$/.test(e.digest)) {
      throw new Error(`[skill-bundle-digest] malformed content digest for ${path}: ${JSON.stringify(e.digest)}`);
    }
    return { path, digest: e.digest };
  });

  const seen = new Set<string>();
  let routers = 0;
  for (const e of normalized) {
    if (seen.has(e.path)) {
      throw new Error(`[skill-bundle-digest] duplicate normalized path: ${e.path}`);
    }
    seen.add(e.path);
    if (e.path === SKILL_ROUTER_PATH) routers++;
  }
  if (routers !== 1) {
    throw new Error(
      `[skill-bundle-digest] a bundle must carry exactly one ${SKILL_ROUTER_PATH} router (found ${routers})`,
    );
  }

  normalized.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const hash = createHash("sha256");
  hash.update("anthropic-skill-bundle-digest:v1\0");
  hash.update(String(normalized.length));
  hash.update("\0");
  for (const e of normalized) {
    // path\0digest\0 — both are already delimiter-free (normalized path has no
    // NUL; digest is 64 hex chars), so this framing is unambiguous.
    hash.update(e.path);
    hash.update("\0");
    hash.update(e.digest);
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** Outcome of the one-hop router reference lint. */
export type RouterReferenceLint = {
  ok: boolean;
  /** Relative references in SKILL.md that resolve to no manifest path. */
  missing: string[];
};

/**
 * Lint the SKILL.md router's ONE-HOP references: every relative file reference
 * the router names must resolve to a path present in the bundle manifest. This
 * catches a router that points at a `references/foo.md` that was never bundled
 * (a dangling one-hop link) BEFORE the bundle is stored or uploaded.
 *
 * Conservative by construction — only flags references that unambiguously name
 * a bundled file:
 *  - markdown links / images `[..](target)` and `![..](target)`,
 *  - inline-code paths `` `references/x` `` that contain a `/`.
 * Skips absolute URLs (`scheme:`), root-absolute paths, in-page anchors
 * (`#...`), and bare tokens with no `/` (prose, not a path). References are
 * normalized with {@link normalizeBundledRelPath}; anything that fails to
 * normalize (e.g. `../escape`) is reported as missing (never silently passed).
 */
export function lintBundleRouterReferences(
  skillMd: string,
  manifestPaths: string[],
): RouterReferenceLint {
  const present = new Set<string>();
  /** The bundle's own top-level directory names — see `fromInlineCode` below. */
  const bundleDirs = new Set<string>();
  for (const p of manifestPaths) {
    try {
      const norm = normalizeBundledRelPath(p);
      present.add(norm);
      const slash = norm.indexOf("/");
      if (slash > 0) bundleDirs.add(norm.slice(0, slash));
    } catch {
      // A malformed manifest path is a caller bug caught elsewhere; ignore here.
    }
  }
  const missing: string[] = [];
  const seen = new Set<string>();
  const consider = (raw: string, fromInlineCode: boolean) => {
    let target = raw.trim();
    if (!target) return;
    // Strip an optional markdown link title: `path "Title"`.
    const sp = target.search(/\s/);
    if (sp >= 0) target = target.slice(0, sp);
    // Skip anchors, absolute URLs, protocol-relative, mailto, root-absolute.
    if (target.startsWith("#")) return;
    if (target.startsWith("/")) return;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return; // scheme:  (http:, mailto:, data:)
    if (target.startsWith("//")) return;
    // A `{placeholder}` / `<placeholder>` TEMPLATE is not a file.
    if (/[{}<>]/.test(target)) return;
    // Drop an in-target anchor/query.
    target = target.split("#")[0].split("?")[0];
    if (!target || !target.includes("/")) return; // no `/` ⇒ not a bundled path
    if (fromInlineCode) {
      // An inline-code span is the WEAKEST signal. A SKILL.md legitimately
      // shows JSON-RPC method names (`message/send`), IANA timezones
      // (`"Europe/Vienna"`), URL paths, and — for the authoring skills — paths
      // in the OTHER repo it teaches you to write (`cinatra/oas.json`,
      // `packages/agents/src/a2a-actions.ts`). None of those are bundled files.
      // S1 reported this lint as a diagnostic; S2 (cinatra#2089) makes it FAIL
      // CLOSED, so it must not reject a correct skill: an inline-code reference
      // counts as a BUNDLED path only when it is unquoted, its last segment
      // carries a dotted extension, AND its FIRST segment is a directory THIS
      // BUNDLE actually ships. A markdown link target keeps the stricter
      // treatment (an explicit `[text](path)` link is a reference by
      // construction). Pinned as a faithful twin of
      // `lintRouterOneHopReferences` in
      // scripts/audit/_lib/skill-packaging-verdict.mjs by the agreement test in
      // scripts/audit/__tests__/skill-packaging-gate.test.mjs.
      if (/["'`]/.test(target)) return;
      const last = target.slice(target.lastIndexOf("/") + 1);
      if (!/^[^.].*\.[A-Za-z0-9]+$/.test(last)) return;
      if (!bundleDirs.has(target.slice(0, target.indexOf("/")))) return;
    }
    let norm: string;
    try {
      norm = normalizeBundledRelPath(target);
    } catch {
      if (!seen.has(target)) {
        seen.add(target);
        missing.push(target);
      }
      return;
    }
    if (!present.has(norm) && !seen.has(norm)) {
      seen.add(norm);
      missing.push(norm);
    }
  };

  const md = typeof skillMd === "string" ? skillMd : "";
  // Markdown links/images `[text](target)` / `![alt](target)` and inline-code
  // spans, extracted by a SINGLE LEFT-TO-RIGHT PASS — deliberately not by regex.
  // The obvious patterns (`\[[^\]]*\]\(([^)]+)\)`) are polynomial-time on
  // adversarial input (a router body full of `[` or `((`), and SKILL.md content
  // is attacker-influenced in the sense that it arrives from an installed
  // extension. Here every `indexOf` result advances the SAME cursor it searched
  // from, so no character is ever re-scanned and the whole pass is linear.
  // An UNTERMINATED span must not abort the pass (cinatra#2089): a stray "[x("
  // earlier in the body used to `break`, hiding every later reference and
  // failing the lint OPEN — harmless while it was a diagnostic, wrong now that
  // it is enforcement. When a terminator is not found, none exists in the rest
  // of the document either — record that once and skip the branch from then on,
  // so the scan continues without ever re-searching (still exactly one pass).
  let i = 0;
  let openBracket = -1;
  let noMoreCloseParen = false;
  let noMoreBacktick = false;
  while (i < md.length) {
    const ch = md[i];
    if (ch === "[") {
      openBracket = i;
      i += 1;
      continue;
    }
    if (ch === "]" && openBracket >= 0 && md[i + 1] === "(" && !noMoreCloseParen) {
      const close = md.indexOf(")", i + 2);
      if (close === -1) {
        noMoreCloseParen = true;
        i += 1;
        continue;
      }
      consider(md.slice(i + 2, close), false);
      i = close + 1;
      openBracket = -1;
      continue;
    }
    if (ch === "`" && !noMoreBacktick) {
      const close = md.indexOf("`", i + 1);
      if (close === -1) {
        noMoreBacktick = true;
        i += 1;
        continue;
      }
      const inner = md.slice(i + 1, close).trim();
      if (inner.includes("/")) consider(inner, true);
      i = close + 1;
      continue;
    }
    i += 1;
  }

  return { ok: missing.length === 0, missing };
}

const DEFAULT_FILE_MODE = 0o644;

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Normalize + validate a bundle write into content-addressed manifest entries.
 * Rejects (throws) an absolute / `..` / duplicate path, a missing or duplicated
 * SKILL.md router, or an empty bundle — the same shape rules the DB CHECK and
 * `computeBundleDigest` enforce, caught here BEFORE any query so a bad bundle is
 * a clean config error, never a mid-write partial.
 */
function normalizeBundleWrite(write: RevisionBundleWrite): {
  entries: Array<{ path: string; digest: string; byteLength: number; mode: number; isRouter: boolean; b64: string }>;
  bundleDigest: string;
} {
  if (!Array.isArray(write.files) || write.files.length === 0) {
    throw new Error(`[skill-bundle-store] empty bundle for revision ${write.revisionId} — a bundle must carry SKILL.md`);
  }
  const seen = new Set<string>();
  const entries = write.files.map((f) => {
    if (!Buffer.isBuffer(f.bytes)) {
      throw new Error(`[skill-bundle-store] bundle file ${JSON.stringify(f.path)} bytes must be a Buffer`);
    }
    const p = normalizeBundledRelPath(f.path);
    if (seen.has(p)) {
      throw new Error(`[skill-bundle-store] duplicate normalized bundle path: ${p}`);
    }
    seen.add(p);
    const isRouter = f.isRouter ?? p === SKILL_ROUTER_PATH;
    if (isRouter && p !== SKILL_ROUTER_PATH) {
      throw new Error(`[skill-bundle-store] is_router set on a non-router path: ${p}`);
    }
    const digest = sha256Hex(f.bytes);
    return {
      path: p,
      digest,
      byteLength: f.bytes.length,
      mode: typeof f.mode === "number" ? f.mode : DEFAULT_FILE_MODE,
      isRouter,
      b64: f.bytes.toString("base64"),
    };
  });
  // Exactly-one-router invariant (mirrors computeBundleDigest + the DB CHECK).
  const routers = entries.filter((e) => e.isRouter || e.path === SKILL_ROUTER_PATH);
  if (routers.length !== 1) {
    throw new Error(
      `[skill-bundle-store] a bundle must carry exactly one ${SKILL_ROUTER_PATH} router (found ${routers.length}) for revision ${write.revisionId}`,
    );
  }
  const bundleDigest = computeBundleDigest(entries.map((e) => ({ path: e.path, digest: e.digest })));
  return { entries, bundleDigest };
}

/**
 * How a bundle write may move the CURRENT-BUNDLE POINTER (`skill_bundle_heads`).
 *
 * Every variant is enforced INSIDE the head UPSERT, over the head row's OWN
 * columns only, so the decision is atomic with the write (see the comment on the
 * head statement in {@link buildRevisionBundleQueries} for why a correlated
 * subquery could not be).
 *
 *  - `"always"` — unconditional. The LIFECYCLE write path: the authority itself
 *    is speaking, so it owns the pointer outright.
 *  - `"only-derived"` — advance only while the incumbent head is itself
 *    disk-derived (`bundle:` prefix). The CAPTURE path's default: an
 *    authority-owned (lifecycle/rollback) head installed concurrently — between
 *    capture's head read and its write — can never be clobbered by disk bytes.
 *  - `"only-if-absent"` — INSERT a head only when the skill has none at all
 *    (`ON CONFLICT DO NOTHING`). The pre-S1 re-baseline SEED: it exists to give a
 *    head-less skill a starting pointer, so a head that appeared concurrently
 *    (a lifecycle write racing the seed) must win, never be overwritten.
 *  - `{ cas: { revisionId, bundleDigest, skillPayload } }` — COMPARE-AND-SWAP on
 *    the exact rows the caller read and classified. Used by the router-only-seed
 *    heal, where the decision to replace an authority-owned head depends on facts
 *    that must be read before the write. It covers BOTH mutable inputs:
 *      * the head row's own `(revision_id, bundle_digest)`;
 *      * the classified `skills.payload` — locked and re-checked with `FOR UPDATE`
 *        in the SAME statement, because a raw catalog writer can flip a skill into
 *        the custom/personal class with a bare `UPDATE ... SET payload` that
 *        touches no revision and no head (`packages/skills/src/cli.mjs`
 *        `compileAndRegisterAgentSkillsViaPg`), which a head-only CAS would miss.
 *    Comparing the payload TEXT (not a parsed projection) keeps the guard free of
 *    a `payload::jsonb` cast that a malformed row could abort the write on.
 */
export type BundleHeadGuard =
  | "always"
  | "only-derived"
  | "only-if-absent"
  | { cas: { revisionId: string; bundleDigest: string; skillPayload: string } };

/**
 * Build the query list that persists a revision's bundle — content-addressed
 * blob upserts (ON CONFLICT DO NOTHING; a blob is a pure function of its digest)
 * + the immutable manifest rows (ON CONFLICT DO NOTHING so a concurrent/idempotent
 * re-ingest of the SAME revision is a safe no-op, never an append-only-trigger
 * UPDATE) + the current-bundle head upsert. Returned as a list so a caller can
 * APPEND it to the same transaction as a catalog/lifecycle write. Does NOT set
 * skill_revisions.bundle_digest (that column is written only at revision
 * INSERT, since skill_revisions is append-only); the read path recomputes the
 * identity from the manifest.
 */
export function buildRevisionBundleQueries(
  schemaName: string,
  write: RevisionBundleWrite,
  options?: {
    /** How the CURRENT-BUNDLE POINTER may move — see {@link BundleHeadGuard}. */
    headGuard?: BundleHeadGuard;
  },
): Array<{ text: string; values?: unknown[] }> {
  const s = schemaName.replaceAll('"', '""');
  const { entries, bundleDigest } = normalizeBundleWrite(write);
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  for (const e of entries) {
    queries.push({
      text: `INSERT INTO "${s}"."skill_bundle_blobs" (content_digest, content, byte_length)
        VALUES ($1, decode($2, 'base64'), octet_length(decode($2, 'base64')))
        ON CONFLICT (content_digest) DO NOTHING`,
      values: [e.digest, e.b64],
    });
    queries.push({
      text: `INSERT INTO "${s}"."skill_revision_files"
        (revision_id, skill_id, path, content_digest, byte_length, mode, is_router)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (revision_id, path) DO NOTHING`,
      values: [write.revisionId, write.skillId, e.path, e.digest, e.byteLength, e.mode, e.isRouter],
    });
  }
  // The CURRENT-BUNDLE POINTER. Written in the SAME batch as the manifest so a
  // skill's head can never advance to a revision whose files are not durable
  // yet. `skill_bundle_heads` is the authority's own pointer — the lifecycle
  // `skills.active_revision_id` covers custom/personal skills ONLY, so a derived
  // (extension) skill would otherwise have no resolvable current bundle at all.
  //
  // EVERY guard predicate below reads ONLY the head row's OWN columns. That is
  // deliberate and load-bearing (cinatra#2094, codex round-1 finding #2): under
  // READ COMMITTED an `ON CONFLICT DO UPDATE` that waits on a concurrent
  // transaction re-evaluates its `WHERE` against the LATEST COMMITTED VERSION of
  // the conflicting row, so a predicate over that row's own columns is a true
  // compare-and-swap. A correlated SUBQUERY over another table (e.g. "does the
  // incumbent head's revision have any non-router manifest row?") is NOT: the
  // subquery still runs in this statement's snapshot, so it can see the
  // concurrent transaction's new head row while that transaction's manifest rows
  // are still invisible — and then pass, clobbering a freshly installed
  // authority head. No guard here may take that shape.
  const head = options?.headGuard ?? "always";
  const headValues: unknown[] = [write.skillId, write.revisionId, bundleDigest];
  if (typeof head === "object") {
    // CAS. The `ownership` CTE runs FIRST (the INSERT selects from it): it takes a
    // ROW LOCK on the catalog row and re-checks the classified payload against the
    // row's LATEST version. A concurrent payload write either lands before the
    // lock (the equality then fails and the CTE is empty, so nothing is inserted
    // at all) or is blocked behind us until this transaction commits — so the
    // ownership fact cannot go stale while the head upsert waits on the head-row
    // lock. Lock order is skills → skill_bundle_heads, matching the lifecycle
    // write and the rollback CTE, so the two can never deadlock.
    headValues.push(head.cas.revisionId, head.cas.bundleDigest, head.cas.skillPayload);
    queries.push({
      text: `WITH ownership AS (
        SELECT 1 FROM "${s}"."skills" WHERE id = $1 AND payload = $6 FOR UPDATE
      )
      INSERT INTO "${s}"."skill_bundle_heads" (skill_id, revision_id, bundle_digest, updated_at)
      SELECT $1, $2, $3, now() FROM ownership
      ON CONFLICT (skill_id) DO UPDATE
        SET revision_id = EXCLUDED.revision_id,
            bundle_digest = EXCLUDED.bundle_digest,
            updated_at = now()
        WHERE "${s}"."skill_bundle_heads".revision_id = $4
          AND "${s}"."skill_bundle_heads".bundle_digest = $5`,
      values: headValues,
    });
    return queries;
  }
  const headConflictClause =
    head === "only-if-absent"
      ? "ON CONFLICT (skill_id) DO NOTHING"
      : `ON CONFLICT (skill_id) DO UPDATE
        SET revision_id = EXCLUDED.revision_id,
            bundle_digest = EXCLUDED.bundle_digest,
            updated_at = now()${
              head === "only-derived"
                ? `\n        WHERE "${s}"."skill_bundle_heads".revision_id LIKE '${DERIVED_REVISION_PREFIX}%'`
                : ""
            }`;
  queries.push({
    text: `INSERT INTO "${s}"."skill_bundle_heads" (skill_id, revision_id, bundle_digest, updated_at)
      VALUES ($1, $2, $3, now())
      ${headConflictClause}`,
    values: headValues,
  });
  return queries;
}

/** The bundle digest a set of bundle files would produce — pure, no DB. Used by
 * the write path to seed `skill_revisions.bundle_digest` at revision INSERT. */
export function bundleDigestForFiles(files: BundleFileInput[]): string {
  const { bundleDigest } = normalizeBundleWrite({ revisionId: "<compute>", skillId: "<compute>", files });
  return bundleDigest;
}

/**
 * Persist a revision's bundle in its OWN transaction (backfill / re-baseline
 * path). Idempotent: blob + manifest inserts are ON CONFLICT DO NOTHING, so a
 * re-run is a no-op. Returns the bundle digest.
 */
export function writeRevisionBundleToDatabase(
  write: RevisionBundleWrite,
  options?: { headGuard?: BundleHeadGuard },
): string {
  ensurePostgresSchema();
  const { bundleDigest } = normalizeBundleWrite(write);
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    transaction: true,
    queries: buildRevisionBundleQueries(postgresSchema, write, options),
  });
  return bundleDigest;
}

/**
 * Read a revision's complete bundle atomically from the authority, scoped to
 * its owning skill (fail-closed: a revision that does not belong to `skillId`
 * resolves to null, never another skill's bytes). Returns null when the
 * revision has no manifest yet (a legacy/un-ingested revision). The bundle
 * digest is RECOMPUTED from the manifest and cross-checked against the cached
 * `skill_revisions.bundle_digest` when present (a disagreement throws —
 * never return a bundle whose stored identity contradicts its manifest).
 */
export function readRevisionBundleFromDatabase(
  skillId: string,
  revisionId: string,
): RevisionBundle | null {
  ensurePostgresSchema();
  const s = postgresSchema.replaceAll('"', '""');
  const results = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    transaction: true,
    queries: [
      {
        text: `SELECT bundle_digest, skill_id FROM "${s}"."skill_revisions" WHERE id = $1 AND skill_id = $2`,
        values: [revisionId, skillId],
      },
      {
        text: `SELECT f.path, f.content_digest, f.byte_length, f.mode, f.is_router,
                      encode(b.content, 'base64') AS content_b64
                 FROM "${s}"."skill_revision_files" f
                 JOIN "${s}"."skill_bundle_blobs" b ON b.content_digest = f.content_digest
                WHERE f.revision_id = $1 AND f.skill_id = $2
                ORDER BY f.path ASC`,
        values: [revisionId, skillId],
      },
    ],
  });
  // The MANIFEST is authoritative. A `skill_revisions` row is looked up only for
  // its cached identity cross-check and is OPTIONAL: a derived (extension) skill
  // never gets a lifecycle revision, so its bundle is recorded under a
  // content-addressed bundle revision id with no `skill_revisions` row at all.
  const revRow = results[0]?.rows?.[0] as { bundle_digest?: string | null; skill_id?: string } | undefined;
  const fileRows = (results[1]?.rows ?? []) as Array<{
    path?: unknown;
    content_digest?: unknown;
    byte_length?: unknown;
    mode?: unknown;
    is_router?: unknown;
    content_b64?: unknown;
  }>;
  if (fileRows.length === 0) return null; // no manifest yet (legacy revision)

  const files: BundleFile[] = fileRows.map((r) => {
    const bytes = Buffer.from(String(r.content_b64 ?? ""), "base64");
    const digest = String(r.content_digest);
    // Defence-in-depth: the DB CHECK already guarantees content_digest ==
    // sha256(content); re-verify the bytes we decoded actually hash to it.
    if (sha256Hex(bytes) !== digest) {
      throw new Error(
        `[skill-bundle-store] blob integrity violation for revision ${revisionId} path ${String(r.path)}: decoded bytes do not hash to ${digest}`,
      );
    }
    return {
      path: String(r.path),
      digest,
      byteLength: Number(r.byte_length),
      mode: Number(r.mode),
      isRouter: r.is_router === true,
      bytes,
    };
  });

  const bundleDigest = computeBundleDigest(files.map((f) => ({ path: f.path, digest: f.digest })));
  const cached = typeof revRow?.bundle_digest === "string" ? revRow.bundle_digest : null;
  if (cached && cached !== bundleDigest) {
    throw new Error(
      `[skill-bundle-store] bundle identity mismatch for revision ${revisionId}: manifest=${bundleDigest} cached=${cached}`,
    );
  }
  return { revisionId, skillId, bundleDigest, files };
}

/**
 * Materialize a revision's bundle into `destDir` (the mounted delivery
 * directory) ATOMICALLY: the file set is written into a sibling temp dir and
 * then renamed into place, so a delivery consumer never observes a half-written
 * bundle. An existing `destDir` is replaced. File modes from the manifest are
 * applied. Returns the materialized bundle digest.
 *
 * @throws when the revision has no bundle in the authority (fail-closed — never
 *   materialize a partial/empty skill directory).
 */
export async function materializeRevisionBundleToDirectory(
  skillId: string,
  revisionId: string,
  destDir: string,
): Promise<{ bundleDigest: string; fileCount: number }> {
  const bundle = readRevisionBundleFromDatabase(skillId, revisionId);
  if (!bundle) {
    throw new Error(
      `[skill-bundle-store] cannot materialize revision ${revisionId} (skill ${skillId}): no bundle in the content authority`,
    );
  }
  const dest = path.resolve(destDir);
  const tmp = `${dest}.tmp-${revisionId}-${process.pid}`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  try {
    for (const f of bundle.files) {
      // Path already normalized (forward-slash, no `..`) by the manifest CHECK
      // and computeBundleDigest; join under the temp root and re-confine.
      const target = path.resolve(tmp, f.path);
      if (target !== tmp && !target.startsWith(tmp + path.sep)) {
        throw new Error(`[skill-bundle-store] refused to write outside bundle root: ${f.path}`);
      }
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, f.bytes, { mode: f.mode });
    }
    // Swap into place: remove the old dir, rename temp → dest.
    await rm(dest, { recursive: true, force: true });
    await mkdir(path.dirname(dest), { recursive: true });
    await rename(tmp, dest);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  return { bundleDigest: bundle.bundleDigest, fileCount: bundle.files.length };
}

const SKIP_DIR_NAMES = new Set([".git", "node_modules"]);

/**
 * Read a skill directory off disk into bundle files (SKILL.md router + every
 * bundled resource), excluding symlinks and `.git`/`node_modules`. The ingest
 * primitive that turns an on-disk skill into an authority bundle. Modes are
 * captured from the filesystem.
 *
 * @throws when SKILL.md is absent or any read fails (fail-closed — never ingest
 *   a partial bundle).
 */
export async function readSkillDirectoryAsBundleFiles(
  skillMdPath: string,
): Promise<BundleFileInput[]> {
  const dir = path.dirname(path.resolve(skillMdPath));
  const routerReal = path.resolve(skillMdPath);
  const out: BundleFileInput[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(current, e.name);
      const st = await lstat(full);
      if (st.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (SKIP_DIR_NAMES.has(e.name)) continue;
        await walk(full);
        continue;
      }
      if (!e.isFile()) continue;
      const rel = path.relative(dir, full).split(path.sep).join("/");
      const bytes = await readFile(full);
      out.push({
        path: rel,
        bytes,
        mode: st.mode & 0o777,
        isRouter: path.resolve(full) === routerReal,
      });
    }
  }
  await walk(dir);
  if (!out.some((f) => f.isRouter || f.path === SKILL_ROUTER_PATH)) {
    throw new Error(`[skill-bundle-store] no SKILL.md router found under ${dir}`);
  }
  return out;
}

/**
 * Whether a skill's catalog payload marks it CUSTOM or PERSONAL — the class for
 * which the DATABASE, not the disk, is the content authority.
 *
 * A faithful twin of `isCustomOrPersonalSkillPayload` in
 * `packages/skills/src/skill-source.ts` and of the `CUSTOM_PREDICATE` SQL in
 * `migrations/core/core__0029_skill-lifecycle.mjs` — the predicate that decided
 * which skills got a lifecycle revision in the first place. Inlined here for the
 * same reason `normalizeBundledRelPath` above is (this store is reachable from
 * every locked route, so a new first-party import would push the route-graph
 * ratchet), and pinned to the canonical implementation by a drift test in
 * `src/lib/__tests__/skill-bundle-router-only-seed-heal.test.ts`.
 *
 * FAIL-CLOSED: an unparseable payload counts as custom/personal, so an
 * unreadable row can never license a disk write over a DB-owned head.
 */
function isCustomOrPersonalSkillPayloadJson(payloadText: unknown): boolean {
  if (typeof payloadText !== "string") return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadText);
  } catch {
    return true;
  }
  if (!parsed || typeof parsed !== "object") return true;
  const p = parsed as Record<string, unknown>;
  if (typeof p.packageId === "string" && p.packageId.startsWith("custom:")) return true;
  return p.isCustomSkill === true || p.isPersonal === true;
}

/** A skill's current-bundle pointer row. */
export interface SkillBundleHead {
  skillId: string;
  revisionId: string;
  bundleDigest: string;
}

/** Read a skill's current-bundle pointer, or null when it has never been captured. */
export function readSkillBundleHeadFromDatabase(skillId: string): SkillBundleHead | null {
  ensurePostgresSchema();
  const s = postgresSchema.replaceAll('"', '""');
  const results = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT skill_id, revision_id, bundle_digest FROM "${s}"."skill_bundle_heads" WHERE skill_id = $1`,
        values: [skillId],
      },
    ],
  });
  const row = results[0]?.rows?.[0] as
    | { skill_id?: unknown; revision_id?: unknown; bundle_digest?: unknown }
    | undefined;
  if (!row) return null;
  return {
    skillId: String(row.skill_id),
    revisionId: String(row.revision_id),
    bundleDigest: String(row.bundle_digest),
  };
}

/**
 * Resolve a skill's CURRENT bundle purely from the authority — the head pointer
 * then its manifest + blobs. ZERO disk access: this is the read the byte-bound
 * sync candidate builder and the agent preflight use, so what they hand to the
 * uploader is provably the stored bytes. Returns null when the skill has never
 * been captured.
 *
 * @throws when the head points at a revision whose manifest is missing, or at a
 *   bundle whose recomputed identity disagrees with the pointer (fail-closed).
 */
export function readCurrentSkillBundleFromDatabase(skillId: string): RevisionBundle | null {
  const head = readSkillBundleHeadFromDatabase(skillId);
  if (!head) return null;
  const bundle = readRevisionBundleFromDatabase(skillId, head.revisionId);
  if (!bundle) {
    throw new Error(
      `[skill-bundle-store] bundle head for skill ${skillId} points at revision ${head.revisionId} with no manifest`,
    );
  }
  if (bundle.bundleDigest !== head.bundleDigest) {
    throw new Error(
      `[skill-bundle-store] bundle head identity mismatch for skill ${skillId}: manifest=${bundle.bundleDigest} head=${head.bundleDigest}`,
    );
  }
  return bundle;
}

/** Prefix marking a revision id minted by CAPTURE (disk-owned), as opposed to a
 * lifecycle revision id (authority-owned, minted by the custom/personal write
 * path). */
const DERIVED_REVISION_PREFIX = "bundle:";

/**
 * The deterministic, content-addressed revision id a CAPTURED (derived) bundle
 * is recorded under. A derived/extension skill never gets a lifecycle revision
 * (core__0029's revision layer is custom/personal-only), so its bundle identity
 * IS its revision identity: identical bytes ⇒ identical revision id, so a
 * re-capture is a no-op and a revert to earlier content resolves back to the
 * same immutable manifest.
 *
 * The id is keyed by `(skillId, bundleDigest)`, NOT by the digest alone: the
 * manifest's primary key is `(revision_id, path)`, so two DIFFERENT skills whose
 * bundles are byte-identical would otherwise share one revision id — the second
 * skill's manifest insert would be swallowed by ON CONFLICT DO NOTHING while its
 * head advanced, leaving it with a head pointing at rows it can never read
 * (every read is skill-scoped). Hashing the pair keeps ids collision-free.
 */
export function derivedBundleRevisionId(skillId: string, bundleDigest: string): string {
  const keyed = createHash("sha256").update(skillId).update("\0").update(bundleDigest).digest("hex");
  return `${DERIVED_REVISION_PREFIX}${keyed}`;
}

/** Outcome of a capture: the resolved head + whether disk content had changed. */
export interface SkillBundleCapture {
  skillId: string;
  revisionId: string;
  bundleDigest: string;
  /**
   * True when the head resolves to THIS capture's revision after the guarded
   * write — i.e. new or changed disk content landed.
   *
   * A REPORTING signal, not an authority fact: the sync service uses it only to
   * bucket a skill as `captured` vs `unchanged`. Under two concurrent captures of
   * the SAME disk content both derive the same content-addressed revision, so the
   * one whose guarded write wrote no rows still finds that revision installed and
   * reports `true`. Over-reporting costs a redundant re-sync consideration and
   * never loses or overwrites authority (codex round-3 warning).
   */
  changed: boolean;
  /** True when the head is AUTHORITY-OWNED (a lifecycle revision) and disagrees
   * with what is on disk — capture deliberately left it alone. */
  authorityOwnedDivergence: boolean;
  /** One-hop router-reference lint over the captured manifest (diagnostic). */
  lint: RouterReferenceLint;
}

/**
 * CAPTURE a skill's on-disk bundle into the content authority — the single
 * disk→authority boundary. Reads the skill directory, content-addresses it, and
 * (only when the bytes differ from the current head) records the immutable
 * manifest + blobs and advances the head. Idempotent: unchanged content writes
 * nothing.
 *
 * A custom/personal skill's head is normally written already, in the same
 * transaction as its lifecycle revision; capture then finds a matching digest
 * and no-ops. A derived (extension) skill is captured under
 * {@link derivedBundleRevisionId}.
 *
 * The one-hop router-reference lint runs here (over the captured manifest, the
 * only place the full file set and the router body are both in hand) and is
 * returned as a DIAGNOSTIC — a dangling reference does not block capture at S1
 * (fail-closed packaging enforcement is S2's gate); it is surfaced so the
 * caller can report it.
 */
/**
 * ONE-TIME RE-BASELINE for a pre-S1 skill: when a skill has no bundle head yet
 * but DOES carry a lifecycle head (`skills.active_revision_id` — a custom or
 * personal skill written before this slice), seed the bundle head FROM that
 * authoritative revision instead of letting capture mint a disk-owned one. The
 * revision's stored SKILL.md blob becomes its bundle-of-one manifest, so the
 * skill stays authority-owned across the upgrade and a divergent on-disk copy
 * (e.g. after a rollback that did not rewrite disk) can never win.
 *
 * No-ops when a head already exists, when the skill has no lifecycle head, or
 * when that revision has no durable blob (nothing authoritative to seed from) —
 * in which case capture proceeds and records the disk bundle.
 */
function seedBundleHeadFromLifecycleRevision(
  skillId: string,
  /**
   * How many files the skill's on-disk bundle actually ships (cinatra#2094 F7).
   * A bundle-of-ONE seed is only a faithful re-baseline for a skill whose whole
   * bundle IS its router; see the multi-file guard below.
   */
  diskFileCount: number,
): SkillBundleHead | null {
  // Every head write below is `only-if-absent`: this is a SEED, reached only
  // because the skill had no head a moment ago. If a lifecycle write installed
  // one in the meantime, that head is the authority's own and must win.
  const existing = readSkillBundleHeadFromDatabase(skillId);
  if (existing) return existing;
  ensurePostgresSchema();
  const s = postgresSchema.replaceAll('"', '""');
  const results = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT sk.active_revision_id, sk.payload, c.content
                 FROM "${s}"."skills" sk
                 LEFT JOIN "${s}"."skill_revisions" r
                        ON r.id = sk.active_revision_id AND r.skill_id = sk.id
                 LEFT JOIN "${s}"."skill_revision_contents" c
                        ON c.content_digest = r.content_digest
                WHERE sk.id = $1`,
        values: [skillId],
      },
    ],
  });
  const row = results[0]?.rows?.[0] as
    | { active_revision_id?: unknown; payload?: unknown; content?: unknown }
    | undefined;
  const revisionId = typeof row?.active_revision_id === "string" ? row.active_revision_id : null;
  if (!revisionId) return null;
  // Already has a manifest (a post-S1 lifecycle write) → just point the head at it.
  const stored = readRevisionBundleFromDatabase(skillId, revisionId);
  if (stored) {
    writeRevisionBundleToDatabase(
      {
        revisionId,
        skillId,
        files: stored.files.map((f) => ({ path: f.path, bytes: f.bytes, mode: f.mode, isRouter: f.isRouter })),
      },
      { headGuard: "only-if-absent" },
    );
    return readSkillBundleHeadFromDatabase(skillId);
  }
  const content = typeof row?.content === "string" ? row.content : null;
  if (content == null) return null; // no durable blob — nothing authoritative to seed
  // MULTI-FILE GUARD (cinatra#2094 F7-A). A pre-S1 lifecycle revision stores
  // ONLY the router body, so seeding from it mints a bundle-of-ONE manifest.
  // That manifest is AUTHORITY-OWNED (its revision id carries no `bundle:`
  // prefix), so `captureSkillBundleFromDisk` below then classifies the skill as
  // an `authorityOwnedDivergence` and NEVER advances the head — permanently, on
  // every subsequent capture.
  //
  // For a skill whose on-disk bundle is a router PLUS one-hop `references/*`,
  // that outcome is not a conservative re-baseline; it is a manifest the
  // router provably dead-ends against, which S2's fail-closed one-hop lint
  // (cinatra#2089) then REFUSES as an upload candidate. Measured consequence
  // (cinatra#2094 S7): every multi-file skill — including 3 of the 5 the Cinatra
  // assistant itself requires — was silently absent from the Anthropic mirror
  // after a readiness saga that reported "22 skill(s) uploaded", so the first
  // /chat turn failed loud on skills the wizard claimed to have synced.
  //
  // The re-baseline exists for a CUSTOM/PERSONAL skill written before this
  // slice (its whole bundle IS one SKILL.md, and a rollback must not be
  // clobbered by a stale disk projection). Skipping the seed lets capture record
  // the real bundle under a derived (`bundle:`) revision, which stays disk-owned
  // and re-capturable exactly as intended.
  //
  // THE SKIP IS ITSELF GATED ON OWNERSHIP (codex round-4 finding). Disk file
  // count alone is not a licence to skip: `core__0029` seeded a NULL-stamped
  // `migration` revision for exactly the pre-S1 CUSTOM/PERSONAL skills, and a
  // pre-S1 `upsertSkill` recorded no file set either — so such a skill DOES reach
  // this seed, and any stray sibling in its directory (an old reference, editor
  // residue) makes it look multi-file. Skipping there would leave it head-less,
  // and the capture below would then INSERT a disk-derived head over its
  // DB-authoritative revision with no head to compare against — an authority
  // violation on the FIRST capture, with no race involved. For that class the
  // bundle-of-one re-baseline is always the right answer, so the seed always
  // runs. Fail-closed: an unreadable payload counts as custom/personal.
  if (diskFileCount > 1 && !isCustomOrPersonalSkillPayloadJson(row?.payload)) return null;
  writeRevisionBundleToDatabase(
    {
      revisionId,
      skillId,
      files: [{ path: SKILL_ROUTER_PATH, bytes: Buffer.from(content, "utf8"), isRouter: true }],
    },
    { headGuard: "only-if-absent" },
  );
  return readSkillBundleHeadFromDatabase(skillId);
}

/**
 * Whether a skill's CURRENT head is provably one minted by the pre-guard
 * bundle-of-ONE branch of {@link seedBundleHeadFromLifecycleRevision}
 * (cinatra#2094 F7-A) — the head the heal below is allowed to replace.
 *
 * The discriminator is DURABLE ROW PROVENANCE, not file counts (codex round-1
 * finding #1: manifest CARDINALITY cannot tell the defective seed apart from a
 * custom/personal skill that is a DELIBERATE bundle of one, whose disk write
 * rewrites only `SKILL.md` and leaves siblings in place).
 *
 * WHAT MAKES THE READ-THEN-WRITE SAFE (codex round-2 + round-3 findings). Every
 * condition is either (a) a row in a table that raises on UPDATE/DELETE
 * (`skill_revisions`, `skill_revision_files`), or (b) a fact whose only way to
 * change is a write that ALSO replaces the head row — which the target-row CAS
 * detects. Specifically:
 *   - conditions 2–5 read append-only rows. New manifest PATHS could in principle
 *     be INSERTed under an existing revision (the PK is `(revision_id, path)`),
 *     but every shipped writer mints a FRESH revision id for a new file set: the
 *     lifecycle write, the rollback, and capture all do, and the seed writes only
 *     when the skill has no head. Nothing appends to a legacy lifecycle revision;
 *   - condition 0 reads the MUTABLE `skills.payload`. That is safe in the
 *     direction that matters: a skill ENTERS the custom/personal class through
 *     `upsertSkill`, whose write path records a bundle-of-one revision and
 *     performs an UNCONDITIONAL head write in the same transaction — so the head
 *     row changes and this heal's CAS misses.
 * The classifier deliberately does NOT read `skills.active_revision_id`: a
 * lifecycle "pure state re-record" (no `bundleFiles`) moves that pointer WITHOUT
 * touching the head, so it is mutable state the CAS could not protect.
 *
 *  0. the skill is NOT custom/personal. This is the one that decides WHOSE
 *     content authority is at stake, and it is checked first for that reason.
 *     For a custom/personal skill the DATABASE is the authority and the on-disk
 *     copy is a projection a rollback does not rewrite — a bundle-of-one head is
 *     the seed's CORRECT re-baseline there, not a defect, and healing it would be
 *     the authority violation. It has to be an explicit condition rather than a
 *     consequence of the others: `core__0029` seeded a NULL-stamped `migration`
 *     revision for exactly the pre-S1 custom/personal skills, and a pre-S1
 *     `upsertSkill` recorded no file set either, so such a skill reaches the seed
 *     with the same row shape a derived one does. Any stray sibling left in its
 *     directory (an old reference, editor residue) would then make it look
 *     multi-file. Predicate: the canonical custom/personal marker set — the same
 *     one `core__0029`'s backfill used to decide who gets a lifecycle revision;
 *  1. the head is AUTHORITY-OWNED (no `bundle:` prefix) — a derived head takes
 *     the ordinary capture path and never reaches the heal at all;
 *  2. a `skill_revisions` row for the head's revision EXISTS (scoped to the
 *     skill) — the seed only ever points a head at a real lifecycle revision;
 *  3. **that revision's `bundle_digest` is NULL.** This is the load-bearing
 *     fact. `skill_revisions` is APPEND-ONLY, so the column can only ever be
 *     written at INSERT — and the lifecycle write path stamps it at INSERT for
 *     EVERY write that records a file set (`buildSkillLifecycleRevisionQueries`:
 *     `bundle_digest = bundleDigestForFiles(...)` whenever `bundleFiles` is
 *     present, and it emits the manifest rows in the SAME transaction). So a
 *     manifest sitting under a NULL-stamped lifecycle revision CANNOT have come
 *     from the lifecycle path. Conversely the defective seed can only fire when
 *     the revision had NO manifest — i.e. was written without `bundleFiles` — so
 *     its `bundle_digest` is NULL by construction. A deliberate custom/personal
 *     bundle-of-one is therefore excluded outright: `buildUpsertRevisionWrite`
 *     always passes the one-file bundle, so its revision is stamped;
 *  4. the revision's `source` is NOT `'rollback'`. A rollback revision legitimately
 *     carries a NULL `bundle_digest` when it restores a pre-S1 target (the column
 *     is copied from that target), while its manifest is written by the rollback
 *     CTE / the pre-S1 bundle-of-one arm in `applySkillRollbackInDatabase`. A
 *     rollback head is a deliberate authority decision and is NEVER healed;
 *  5. the manifest is EXACTLY the router: one row, and that row is `SKILL.md`.
 *     ZERO manifest rows is deliberately NOT a match (codex round-1 finding #2,
 *     second half): a head pointing at an empty manifest is an unresolvable head
 *     that every read already fails closed on, not a seed to heal.
 *
 * Together 1–5 identify the WRITER of that manifest by elimination — only three
 * paths ever write manifest rows under a non-`bundle:` revision id: the lifecycle
 * write (excluded by 3), the rollback (excluded by 4), and this seed; `core__0084`
 * ships no backfill, so there is no fourth — and condition 0 establishes that
 * healing that seed's head is the RIGHT thing to do for this skill.
 */
function readLifecycleSeedHeadProvenance(skillId: string): {
  head: SkillBundleHead;
  isLifecycleSeedHead: boolean;
  /** The catalog payload condition 0 was decided on — CAS'd by the head write. */
  skillPayload: string;
} | null {
  const head = readSkillBundleHeadFromDatabase(skillId);
  if (!head) return null;
  if (head.revisionId.startsWith(DERIVED_REVISION_PREFIX)) {
    return { head, isLifecycleSeedHead: false, skillPayload: "" };
  }
  ensurePostgresSchema();
  const s = postgresSchema.replaceAll('"', '""');
  const results = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    transaction: true,
    queries: [
      {
        // No row at all (no such lifecycle revision for this skill, or no catalog
        // row) ⇒ not a seed head. Fail closed. The ownership class is decided in
        // JS over the raw payload rather than by a `payload::jsonb` cast, so a
        // malformed payload degrades to "custom/personal" instead of aborting
        // capture with a cast error.
        text: `SELECT r.bundle_digest AS revision_bundle_digest,
                      r.source        AS revision_source,
                      sk.payload      AS skill_payload,
                      (SELECT count(*) FROM "${s}"."skill_revision_files" f
                        WHERE f.revision_id = $2 AND f.skill_id = $1) AS manifest_file_count,
                      (SELECT count(*) FROM "${s}"."skill_revision_files" f
                        WHERE f.revision_id = $2 AND f.skill_id = $1 AND f.path = $3) AS router_file_count
                 FROM "${s}"."skill_revisions" r
                 JOIN "${s}"."skills" sk ON sk.id = r.skill_id
                WHERE r.id = $2 AND r.skill_id = $1`,
        values: [skillId, head.revisionId, SKILL_ROUTER_PATH],
      },
    ],
  });
  const row = results[0]?.rows?.[0] as
    | {
        revision_bundle_digest?: unknown;
        revision_source?: unknown;
        skill_payload?: unknown;
        manifest_file_count?: unknown;
        router_file_count?: unknown;
      }
    | undefined;
  if (!row) return { head, isLifecycleSeedHead: false, skillPayload: "" };
  const isLifecycleSeedHead =
    !isCustomOrPersonalSkillPayloadJson(row.skill_payload) &&
    row.revision_bundle_digest == null &&
    row.revision_source !== "rollback" &&
    Number(row.manifest_file_count) === 1 &&
    Number(row.router_file_count) === 1;
  // `skill_payload` is `text NOT NULL`; the String() is defensive only.
  return { head, isLifecycleSeedHead, skillPayload: String(row.skill_payload ?? "") };
}

export async function captureSkillBundleFromDisk(
  skillId: string,
  skillMdPath: string,
): Promise<SkillBundleCapture> {
  const files = await readSkillDirectoryAsBundleFiles(skillMdPath);
  const bundleDigest = bundleDigestForFiles(files);
  const router = files.find((f) => f.isRouter) ?? files.find((f) => f.path === SKILL_ROUTER_PATH);
  const lint = lintBundleRouterReferences(
    router ? router.bytes.toString("utf8") : "",
    files.map((f) => normalizeBundledRelPath(f.path)),
  );

  // Pre-S1 re-baseline: adopt an existing LIFECYCLE head before considering the
  // disk copy, so an upgraded deployment never lets stale disk bytes override
  // the authoritative stored revision.
  const head = seedBundleHeadFromLifecycleRevision(skillId, files.length);
  if (head && head.bundleDigest === bundleDigest) {
    return {
      skillId,
      revisionId: head.revisionId,
      bundleDigest,
      changed: false,
      authorityOwnedDivergence: false,
      lint,
    };
  }
  // HEAL an instance already pinned by the pre-guard seed (cinatra#2094 F7-A).
  // The seed above no longer mints a bundle-of-ONE head for a multi-file skill,
  // but an instance provisioned before this fix already carries one, and every
  // later capture would keep reporting `authorityOwnedDivergence` forever — so
  // its stored manifest could never gain the `references/*` the router needs and
  // the skill stayed permanently unpublishable to Anthropic.
  //
  // The heal fires ONLY on a head whose DURABLE ROW PROVENANCE proves it was
  // minted by that seed — see `readLifecycleSeedHeadProvenance` for each
  // condition and why it holds. It is deliberately NOT keyed on manifest
  // cardinality: a custom/personal skill is a DELIBERATE bundle of one whose disk
  // write rewrites only `SKILL.md`, so it presents the same file counts and would
  // otherwise have its genuine lifecycle/rollback head replaced by a derived disk
  // head (codex round-1 finding #1).
  //
  // Narrowed further by `files.length > 1`: the heal exists because the stored
  // manifest can never gain the `references/*` the router links to. A single-file
  // disk bundle diverging from a single-file authority head is an ordinary
  // authority divergence (a rollback disk did not rewrite) and stays untouched.
  const provenance = head ? readLifecycleSeedHeadProvenance(skillId) : null;
  /** The exact head row the CAS below is licensed to replace, or null. */
  const healableSeedHead =
    head != null &&
    files.length > 1 &&
    provenance != null &&
    provenance.isLifecycleSeedHead &&
    provenance.head.revisionId === head.revisionId
      ? provenance
      : null;
  if (head && !healableSeedHead && !head.revisionId.startsWith(DERIVED_REVISION_PREFIX)) {
    // AUTHORITY-OWNED head (a lifecycle revision written by the custom/personal
    // write path, or by a rollback). For those skills the DB — not the disk — is
    // the content authority: the disk copy is a projection that a rollback does
    // not rewrite. Clobbering the head here would silently re-upload the
    // rolled-back content. Leave the head alone and report the divergence; a
    // real content change arrives through the lifecycle write path, which
    // advances the head transactionally.
    return {
      skillId,
      revisionId: head.revisionId,
      bundleDigest: head.bundleDigest,
      changed: false,
      authorityOwnedDivergence: true,
      lint,
    };
  }
  const revisionId = derivedBundleRevisionId(skillId, bundleDigest);
  // `only-derived` closes the read-then-write window: if a lifecycle/rollback
  // write installed an authority-owned head since the read above, the head
  // advance is skipped atomically (the manifest rows are still recorded — they
  // are immutable history, harmless to keep).
  writeRevisionBundleToDatabase(
    { revisionId, skillId, files },
    // Healing a provenance-confirmed seed head is the ONLY case that may replace
    // an authority-owned head, and it does so as a TARGET-ROW CAS against the
    // exact `(revision_id, bundle_digest)` that was classified — so if a
    // lifecycle/rollback write installed a real authority head since that read,
    // the swap is atomically a NO-OP rather than a clobber (cinatra#2094, codex
    // round-1 finding #2). Every other capture keeps the strict `only-derived`
    // guard.
    {
      headGuard: healableSeedHead
        ? {
            cas: {
              revisionId: healableSeedHead.head.revisionId,
              bundleDigest: healableSeedHead.head.bundleDigest,
              skillPayload: healableSeedHead.skillPayload,
            },
          }
        : "only-derived",
    },
  );
  // Report the head as it ACTUALLY stands after the guarded write.
  const after = readSkillBundleHeadFromDatabase(skillId);
  if (!after || after.revisionId !== revisionId) {
    return {
      skillId,
      revisionId: after?.revisionId ?? revisionId,
      bundleDigest: after?.bundleDigest ?? bundleDigest,
      changed: false,
      authorityOwnedDivergence: after != null,
      lint,
    };
  }
  return { skillId, revisionId, bundleDigest, changed: true, authorityOwnedDivergence: false, lint };
}
