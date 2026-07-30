// Shared plain-Node walker for agent skill registration. Used by the CLI and
// any other plain-Node context that cannot import @cinatra-ai/skills (server-only).
// Byte-identical skillId derivation with packages/agent-builder/src/mcp/handlers.ts:1446-1448 (Pitfall 4).
//
// Threat-model mitigations T-v7n-01 + T-v7n-04 mirrored from sync-packages.ts.

import pg from "pg";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const { Client } = pg;

export const AGENT_SKILL_NPM_PACKAGE_NAME_PATTERN = /^@?[a-zA-Z0-9._-]+(\/[a-zA-Z0-9._-]+)?$/;
export const AGENT_SKILL_MAX_AGENT_DIRS = 1000;
export const AGENT_SKILL_MAX_SKILLS_PER_AGENT = 100;

export function agentSkillSlugify(value) {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function agentSkillIsValidPackageName(name) {
  return typeof name === "string" && AGENT_SKILL_NPM_PACKAGE_NAME_PATTERN.test(name);
}

export function agentSkillIsValidDirectorySlug(slug) {
  if (!slug || slug === "." || slug === "..") return false;
  if (slug.includes("..") || slug.includes("/") || slug.includes("\\")) return false;
  return true;
}

export function agentSkillParseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { name: undefined, description: undefined };
  const attrs = {};
  for (const rawLine of match[1].split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line
      .slice(idx + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    attrs[key] = value;
  }
  return { name: attrs.name, description: attrs.description };
}

// ---------------------------------------------------------------------------
// CONTENT AUTHORITY for the compiled bundle (cinatra#2265, gap (a)).
//
// This writer stamps `packageId: "custom:<slug>"` on every catalog row it
// writes, and that prefix IS the canonical custom/personal predicate — the class
// whose content the DATABASE, not the disk, is authoritative for. Before this it
// wrote ONLY the payload: no lifecycle revision, no bundle head. So the row
// asserted an authority it never recorded, and the next
// `captureSkillBundleFromDisk` installed a DERIVED (`bundle:`) head over it with
// nothing saying why.
//
// The fix is to record what the claim implies: the lifecycle revision AND the
// bundle head for the bundle this function just compiled from disk — the WHOLE
// directory, never a bundle of one. Recording only the router would reproduce
// cinatra#2094 F7-A exactly: a router-only authority manifest that the one-hop
// packaging lint then refuses forever because the `references/*` it links to can
// never enter the stored bundle.
//
// The helpers below are faithful plain-Node twins of `normalizeBundledRelPath`
// and `computeBundleDigest` in `src/lib/skill-bundle-store.ts`. They cannot be
// imported: that module is `server-only` TypeScript and this file is the shared
// plain-Node walker for contexts that cannot load `@cinatra-ai/skills` at all.
// The two are pinned together by the drift test in
// `src/lib/__tests__/skill-bundle-cli-writer-drift.test.ts`, so the manifest this
// writer records can never frame to a different identity than the one the store
// recomputes from those same rows.
// ---------------------------------------------------------------------------

/** The canonical router path every bundle must carry exactly once. */
export const AGENT_SKILL_ROUTER_PATH = "SKILL.md";

/** Directories never walked into when reading a compiled skill bundle. */
const AGENT_SKILL_BUNDLE_SKIP_DIRS = new Set([".git", "node_modules"]);

/**
 * Prefix marking a lifecycle revision minted by THIS writer. Deliberately not
 * `bundle:` (the store's DERIVED marker): a revision recorded here is
 * authority-owned, which is the whole point of the fix.
 */
export const AGENT_SKILL_REVISION_PREFIX = "agent-compile:";

/** sha256 hex of raw bytes. */
function agentSkillSha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Normalize a bundled file's relative path: backslashes → `/`, `.` segments
 * dropped, and absolute / `..`-traversal / empty paths REJECTED (throws).
 * Twin of `normalizeBundledRelPath` (src/lib/skill-bundle-store.ts).
 */
export function agentSkillNormalizeBundledRelPath(relPath) {
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new Error(`[skills-cli] empty bundled file path`);
  }
  const posix = relPath.replaceAll("\\", "/");
  if (posix.startsWith("/")) {
    throw new Error(`[skills-cli] absolute bundled path rejected: ${relPath}`);
  }
  const segments = posix.split("/").filter((s) => s.length > 0 && s !== ".");
  if (segments.some((s) => s === "..")) {
    throw new Error(`[skills-cli] path traversal ('..') rejected: ${relPath}`);
  }
  if (segments.length === 0) {
    throw new Error(`[skills-cli] bundled path resolves to empty: ${relPath}`);
  }
  return segments.join("/");
}

/**
 * The deterministic bundle digest over a manifest's `(path, digest)` set.
 * Twin of `computeBundleDigest` (src/lib/skill-bundle-store.ts) — identical
 * framing, identical rejections, so both sides agree byte-for-byte.
 */
export function agentSkillComputeBundleDigest(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`[skills-cli] empty manifest — a bundle must carry at least ${AGENT_SKILL_ROUTER_PATH}`);
  }
  const normalized = entries.map((e) => {
    const p = agentSkillNormalizeBundledRelPath(e.path);
    if (typeof e.digest !== "string" || !/^[0-9a-f]{64}$/.test(e.digest)) {
      throw new Error(`[skills-cli] malformed content digest for ${p}: ${JSON.stringify(e.digest)}`);
    }
    return { path: p, digest: e.digest };
  });

  const seen = new Set();
  let routers = 0;
  for (const e of normalized) {
    if (seen.has(e.path)) {
      throw new Error(`[skills-cli] duplicate normalized path: ${e.path}`);
    }
    seen.add(e.path);
    if (e.path === AGENT_SKILL_ROUTER_PATH) routers++;
  }
  if (routers !== 1) {
    throw new Error(
      `[skills-cli] a bundle must carry exactly one ${AGENT_SKILL_ROUTER_PATH} router (found ${routers})`,
    );
  }

  normalized.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const hash = createHash("sha256");
  hash.update("anthropic-skill-bundle-digest:v1\0");
  hash.update(String(normalized.length));
  hash.update("\0");
  for (const e of normalized) {
    hash.update(e.path);
    hash.update("\0");
    hash.update(e.digest);
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * Read a compiled skill directory into manifest entries (raw bytes, so the
 * recorded blobs are byte-identical to what a later disk capture would hash).
 * Symlinks and `.git`/`node_modules` are excluded, mirroring
 * `readSkillDirectoryAsBundleFiles`.
 *
 * @throws when SKILL.md is absent, a path is unsafe, or any read fails —
 *   fail-closed, so a partial bundle can never be recorded as the authority.
 */
export function agentSkillReadBundleFiles(skillDir) {
  const root = path.resolve(skillDir);
  const out = [];
  const walk = (current) => {
    for (const e of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, e.name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (AGENT_SKILL_BUNDLE_SKIP_DIRS.has(e.name)) continue;
        walk(full);
        continue;
      }
      if (!e.isFile()) continue;
      const rel = agentSkillNormalizeBundledRelPath(
        path.relative(root, full).split(path.sep).join("/"),
      );
      const bytes = readFileSync(full);
      out.push({
        path: rel,
        // The raw snapshot. `bytes` is what every derived value below is framed
        // from; `b64` is only the bind shape for the `bytea` blob insert.
        bytes,
        digest: agentSkillSha256Hex(bytes),
        byteLength: bytes.length,
        mode: st.mode & 0o777,
        isRouter: rel === AGENT_SKILL_ROUTER_PATH,
        b64: bytes.toString("base64"),
      });
    }
  };
  walk(root);
  if (!out.some((f) => f.isRouter)) {
    throw new Error(`[skills-cli] no ${AGENT_SKILL_ROUTER_PATH} router found under ${root}`);
  }
  return out;
}

/**
 * The lifecycle revision id this writer records a compiled bundle under.
 * DETERMINISTIC and keyed by `(skillId, bundleDigest)` so a re-compile of
 * identical content is an exact no-op (`skill_revisions` is append-only and this
 * walker re-runs on every compile), and changed content mints a distinct
 * revision. Same idempotency reasoning as the `migration:`-prefixed seed in
 * `migrations/core/core__0029_skill-lifecycle.mjs`; keyed by the PAIR for the
 * same reason `derivedBundleRevisionId` is — two skills with byte-identical
 * bundles must never share one manifest.
 */
export function agentSkillBundleRevisionId(skillId, bundleDigest) {
  const keyed = createHash("sha256").update(String(skillId)).update("\0").update(String(bundleDigest)).digest("hex");
  return `${AGENT_SKILL_REVISION_PREFIX}${keyed}`;
}

/**
 * Walk <repoRoot>/agents/<slug>/skills and upsert every SKILL.md as a
 * level:"agent" row in the `skills` table (and the matching `skill_packages`
 * row). Returns `{ registered: string[], skipped: Array<{slug, reason}> }`.
 * Never throws — errors are collected per agent / per skill.
 *
 * Each skill's catalog row and its CONTENT AUTHORITY (lifecycle revision +
 * bundle manifest + bundle head) commit in ONE transaction (cinatra#2265): the
 * `custom:` class this writer stamps says the database owns the content, so the
 * row and the authority that backs it either both land or neither does. A skill
 * whose authority cannot be recorded is REFUSED (collected in `skipped`) rather
 * than registered as an unbacked custom-class claim.
 */
export async function compileAndRegisterAgentSkillsViaPg({ repoRoot, dbUrl, schemaName }) {
  const result = { registered: [], skipped: [] };

  // Whitelist-validate the schema identifier BEFORE any other work
  // (including filesystem checks). Mirrors
  // `drizzle-store.ts:buildUpsertSkillPackageQuery` (which quote-escapes via
  // `replaceAll('"', '""')`) and the cutover-gates script (which whitelists
  // against the same regex). Without this, every `${schemaName}.<table>`
  // interpolation below was an injection vector whose blast radius depended
  // on the operator's `SUPABASE_SCHEMA` env value. We reject invalid input
  // up-front so the function is fail-loud-on-bad-input regardless of repo
  // state.
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(String(schemaName ?? ""))) {
    return {
      registered: [],
      skipped: [{
        slug: "<schema>",
        reason: `invalid schemaName ${JSON.stringify(schemaName)} (must match ^[a-zA-Z_][a-zA-Z0-9_]*$)`,
      }],
    };
  }
  // Use a quoted identifier in every SQL string. This handles the validated-
  // but-still-reserved-word edge case (e.g. `select`) and matches
  // drizzle-store.ts's escape pattern.
  const schemaIdent = `"${schemaName.replaceAll('"', '""')}"`;

  const agentsDir = path.join(repoRoot, "agents");
  if (!existsSync(agentsDir)) return result;

  let agentEntries;
  try {
    agentEntries = readdirSync(agentsDir, { withFileTypes: true });
  } catch (err) {
    return {
      registered: [],
      skipped: [{ slug: "<agents-dir>", reason: err && err.message ? err.message : String(err) }],
    };
  }

  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  try {
    let agentsWalked = 0;
    for (const agentEntry of agentEntries) {
      if (!agentEntry.isDirectory()) continue;
      if (agentsWalked >= AGENT_SKILL_MAX_AGENT_DIRS) {
        result.skipped.push({ slug: agentEntry.name, reason: `agent count exceeded MAX_AGENT_DIRS=${AGENT_SKILL_MAX_AGENT_DIRS}` });
        continue;
      }
      agentsWalked += 1;

      const dirSlug = agentEntry.name;
      if (!agentSkillIsValidDirectorySlug(dirSlug)) {
        result.skipped.push({ slug: dirSlug, reason: `invalid directory slug "${dirSlug}"` });
        continue;
      }

      const agentDir = path.join(agentsDir, dirSlug);
      const pkgJsonPath = path.join(agentDir, "package.json");
      const skillsDir = path.join(agentDir, "skills");

      if (!existsSync(pkgJsonPath)) {
        result.skipped.push({ slug: dirSlug, reason: "missing package.json" });
        continue;
      }

      let pkgJson;
      try {
        pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
      } catch (err) {
        result.skipped.push({
          slug: dirSlug,
          reason: `package.json parse error: ${err && err.message ? err.message : String(err)}`,
        });
        continue;
      }

      if (!agentSkillIsValidPackageName(pkgJson.name)) {
        result.skipped.push({
          slug: dirSlug,
          reason: `invalid package.json#name "${String(pkgJson.name)}"`,
        });
        continue;
      }
      const agentPackageName = pkgJson.name;

      if (!existsSync(skillsDir)) {
        result.skipped.push({ slug: dirSlug, reason: "missing skills/ directory" });
        continue;
      }

      let skillEntries;
      try {
        skillEntries = readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
      } catch {
        result.skipped.push({ slug: dirSlug, reason: "unreadable skills/ directory" });
        continue;
      }

      if (skillEntries.length === 0) {
        result.skipped.push({ slug: dirSlug, reason: "skills/ directory is empty" });
        continue;
      }

      // Upsert the package row once per agent.
      const packageSlug = agentSkillSlugify(agentPackageName) || "custom-skills";
      const packageId = `custom:${agentSkillSlugify(dirSlug)}`;
      const packageRow = {
        id: packageId,
        packageId,
        name: agentPackageName,
        slug: packageSlug,
        description: `Agent skills for ${agentPackageName}.`,
        isCustom: true,
        level: "agent",
      };

      // Populate typed identity columns alongside payload. The schema can
      // enforce NOT NULL on owner_scope / binding_scope / source_kind /
      // skill_slug once every row has them set.
      // This writer must mirror buildUpsertSkillPackageQuery (src/lib/drizzle-
      // store.ts) — keep the column tuple in sync with deriveSkillPackageIdentity
      // in src/lib/database.ts. For agent-level packages: workspace-scoped,
      // owner-bound, user-authored (binding=agent is promoted post-publish
      // when agent_template_id is known).
      const ownerScope = "workspace";
      const ownerId = null;
      const bindingScope = "owner";
      const sourceKind = "user-authored";
      const skillSlug = agentSkillSlugify(dirSlug) || packageSlug;
      const agentTemplateId = null;
      // Vendor/package: cli.mjs only ever emits `custom:<slug>` packageIds —
      // map to vendor="custom", package=<slug> so the (vendor, package) pair
      // is non-NULL and the optional `skill_pkg_vendor_required_chk` CHECK
      // is satisfied even when source_kind upgrades to "installed".
      const vendor = "custom";
      const pkg = skillSlug;

      try {
        await client.query(
          `INSERT INTO ${schemaIdent}.skill_packages
             (id, payload, owner_scope, owner_id, binding_scope, source_kind,
              vendor, package, agent_template_id, skill_slug)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (id) DO UPDATE SET
             payload           = EXCLUDED.payload,
             owner_scope       = EXCLUDED.owner_scope,
             owner_id          = EXCLUDED.owner_id,
             binding_scope     = EXCLUDED.binding_scope,
             source_kind       = EXCLUDED.source_kind,
             vendor            = EXCLUDED.vendor,
             package           = EXCLUDED.package,
             agent_template_id = EXCLUDED.agent_template_id,
             skill_slug        = EXCLUDED.skill_slug`,
          [
            packageId,
            JSON.stringify(packageRow),
            ownerScope,
            ownerId,
            bindingScope,
            sourceKind,
            vendor,
            pkg,
            agentTemplateId,
            skillSlug,
          ],
        );
      } catch (err) {
        result.skipped.push({
          slug: dirSlug,
          reason: `skill_packages upsert failed: ${err && err.message ? err.message : String(err)}`,
        });
        continue;
      }

      let skillsWalked = 0;
      for (const skillEntry of skillEntries) {
        if (skillsWalked >= AGENT_SKILL_MAX_SKILLS_PER_AGENT) {
          result.skipped.push({
            slug: `${dirSlug}/${skillEntry.name}`,
            reason: `skill count exceeded MAX_SKILLS_PER_AGENT=${AGENT_SKILL_MAX_SKILLS_PER_AGENT}`,
          });
          continue;
        }
        skillsWalked += 1;

        const skillEntryName = skillEntry.name;
        if (!agentSkillIsValidDirectorySlug(skillEntryName)) {
          result.skipped.push({ slug: `${dirSlug}/${skillEntryName}`, reason: `invalid skill slug "${skillEntryName}"` });
          continue;
        }

        const skillMdPath = path.join(skillsDir, skillEntryName, "SKILL.md");
        if (!existsSync(skillMdPath)) {
          result.skipped.push({ slug: `${dirSlug}/${skillEntryName}`, reason: "missing SKILL.md" });
          continue;
        }

        // ONE SNAPSHOT of the compiled directory feeds EVERYTHING below — the
        // catalog payload, the lifecycle content blob and its digest, the
        // manifest, the bundle digest, and the deterministic revision id derived
        // from it (codex round-1 finding). Reading SKILL.md a second time for
        // the payload would let a concurrent edit commit an immutable revision
        // whose lifecycle content disagreed with its own bundle — and because
        // the revision insert is `ON CONFLICT (id) DO NOTHING`, no later compile
        // could ever heal that pairing. Deriving both from the same bytes makes
        // `revisionId -> (contentDigest, bundleDigest)` a total function: the
        // bundle digest covers the router's own digest, so equal ids imply equal
        // router bytes imply an equal content digest.
        //
        // The walk also fails closed on an unreadable file or an absent router,
        // which is why it replaces the old direct read.
        let bundleEntries;
        let bundleDigest;
        try {
          bundleEntries = agentSkillReadBundleFiles(path.join(skillsDir, skillEntryName));
          bundleDigest = agentSkillComputeBundleDigest(
            bundleEntries.map((f) => ({ path: f.path, digest: f.digest })),
          );
        } catch (err) {
          result.skipped.push({
            slug: `${dirSlug}/${skillEntryName}`,
            reason: `read failed: ${err && err.message ? err.message : String(err)}`,
          });
          continue;
        }
        // The router body as TEXT, decoded from the SAME bytes the manifest
        // recorded. (`skill_revision_contents` stores text and hashes
        // `convert_to(content,'UTF8')`; `skill_bundle_blobs` stores raw bytes —
        // two framings of one snapshot, never two reads.)
        const skillContent = bundleEntries.find((f) => f.isRouter).bytes.toString("utf8");

        const { name: frontName, description: frontDesc } = agentSkillParseFrontmatter(skillContent);
        const skillName = (frontName && frontName.trim()) || skillEntryName;
        const skillDesc = (frontDesc && frontDesc.trim()) || "";
        const skillIdSlug = agentSkillSlugify(skillName);
        const skillId = `${packageId}:${skillIdSlug}`;

        // Compose disk path matching the ownership-first layout:
        // `workspace/~agents/<vendor>/<package>/<skill>/SKILL.md`. The CLI
        // does NOT write the file (the Next.js app's
        // syncInstalledSkillsToDatabase discovers it via package scanning);
        // sourcePath is informational so the catalog row matches the shape
        // produced by upsertSkill at runtime.
        //
        // packageSlug may be npm-scoped ("cinatra/foo-agent") or flat
        // ("cinatra-foo-agent"); split at "/" or first "-" to derive
        // vendor + package. Matches getSkillDiskDir's "agent" branch.
        let vendor = "unknown";
        let pkg = packageSlug;
        if (packageSlug.includes("/")) {
          const ix = packageSlug.indexOf("/");
          vendor = packageSlug.slice(0, ix);
          pkg = packageSlug.slice(ix + 1);
        } else if (packageSlug.includes("-")) {
          const ix = packageSlug.indexOf("-");
          vendor = packageSlug.slice(0, ix);
          pkg = packageSlug.slice(ix + 1);
        }
        const sourcePath = path.join(
          repoRoot,
          "data",
          "skills",
          "workspace",
          "~agents",
          vendor,
          pkg,
          skillIdSlug,
          "SKILL.md",
        );

        const skillRow = {
          id: skillId,
          name: skillName,
          slug: skillIdSlug,
          description: skillDesc,
          content: skillContent,
          packageId,
          packageName: agentPackageName,
          packageSlug,
          sourcePath,
          usedBy: [],
          isCustom: true,
          level: "agent",
          scope: packageSlug,
          agentId: agentPackageName,
          prefillText: "-",
          updatedAt: new Date().toISOString(),
        };

        // CONTENT AUTHORITY (cinatra#2265 gap (a)), all of it derived from the
        // single directory snapshot read above — router plus every bundled
        // resource, so the manifest this writer records describes the skill's
        // real bundle. A bundle-of-one authority head under a multi-file skill
        // is the cinatra#2094 F7-A defect; it must not be reintroduced here.
        const revisionId = agentSkillBundleRevisionId(skillId, bundleDigest);
        // The lifecycle content blob is the router BODY as UTF-8 text (what the
        // `skill_revision_contents` CHECK hashes); the bundle blobs above carry
        // the RAW bytes. Both are recorded, so neither authority reader — the
        // pre-S1 content read or the bundle manifest read — resolves to nothing.
        const contentDigest = agentSkillSha256Hex(Buffer.from(skillContent, "utf8"));

        try {
          // ONE transaction: the class-asserting payload write and the authority
          // that backs it are inseparable. Any failure below (a schema without
          // the content-authority tables, a constraint violation) ROLLS BACK the
          // payload too — the writer refuses the custom class instead of
          // asserting one it cannot back.
          await client.query("BEGIN");
          await client.query(
            `INSERT INTO ${schemaIdent}.skills (id, payload) VALUES ($1, $2)
             ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload`,
            [skillId, JSON.stringify(skillRow)],
          );
          await client.query(
            `INSERT INTO ${schemaIdent}.skill_revision_contents (content_digest, content, byte_length)
             VALUES ($1, $2, octet_length($2))
             ON CONFLICT (content_digest) DO NOTHING`,
            [contentDigest, skillContent],
          );
          // `source='migration'` is the machine-provisioned class in the
          // `skill_revisions_source_check` value set (the same one core__0029's
          // backfill seeds under); widening that set would need a migration and
          // is out of scope. `bundle_digest` is STAMPED at INSERT — that is what
          // keeps this revision outside cinatra#2094's heal predicate, which
          // identifies the defective seed by a NULL identity.
          await client.query(
            `INSERT INTO ${schemaIdent}.skill_revisions
               (id, skill_id, content_digest, source, bundle_digest)
             VALUES ($1, $2, $3, 'migration', $4)
             ON CONFLICT (id) DO NOTHING`,
            [revisionId, skillId, contentDigest, bundleDigest],
          );
          await client.query(
            `UPDATE ${schemaIdent}.skills
                SET lifecycle_state = COALESCE(lifecycle_state, 'active'),
                    active_revision_id = $2
              WHERE id = $1`,
            [skillId, revisionId],
          );
          for (const f of bundleEntries) {
            await client.query(
              `INSERT INTO ${schemaIdent}.skill_bundle_blobs (content_digest, content, byte_length)
               VALUES ($1, decode($2, 'base64'), octet_length(decode($2, 'base64')))
               ON CONFLICT (content_digest) DO NOTHING`,
              [f.digest, f.b64],
            );
            await client.query(
              `INSERT INTO ${schemaIdent}.skill_revision_files
                 (revision_id, skill_id, path, content_digest, byte_length, mode, is_router)
               VALUES ($1, $2, $3, $4, $5, $6, $7)
               ON CONFLICT (revision_id, path) DO NOTHING`,
              [revisionId, skillId, f.path, f.digest, f.byteLength, f.mode, f.isRouter],
            );
          }
          // Unconditional head advance — the same guard the store calls
          // `"always"` and reserves for the LIFECYCLE write path. This writer IS
          // the authority speaking for the rows it just wrote: it overwrites
          // `skills.payload` (including the skill body) unconditionally, so a
          // head that disagreed with that payload would be the very
          // inconsistency this fix exists to remove.
          await client.query(
            `INSERT INTO ${schemaIdent}.skill_bundle_heads (skill_id, revision_id, bundle_digest, updated_at)
             VALUES ($1, $2, $3, now())
             ON CONFLICT (skill_id) DO UPDATE
               SET revision_id = EXCLUDED.revision_id,
                   bundle_digest = EXCLUDED.bundle_digest,
                   updated_at = now()`,
            [skillId, revisionId, bundleDigest],
          );
          await client.query("COMMIT");
          result.registered.push(skillId);
        } catch (err) {
          try {
            await client.query("ROLLBACK");
          } catch {
            // A rollback that itself fails leaves nothing committed either way;
            // the original error below is the one an operator needs.
          }
          result.skipped.push({
            slug: `${dirSlug}/${skillEntryName}`,
            reason: `skills upsert failed: ${err && err.message ? err.message : String(err)}`,
          });
        }
      }
    }
  } finally {
    await client.end();
  }

  return result;
}
