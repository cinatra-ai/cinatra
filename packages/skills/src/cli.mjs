// Shared plain-Node walker for agent skill registration. Used by the CLI and
// any other plain-Node context that cannot import @cinatra-ai/skills (server-only).
// Byte-identical skillId derivation with packages/agent-builder/src/mcp/handlers.ts:1446-1448 (Pitfall 4).
//
// Threat-model mitigations T-v7n-01 + T-v7n-04 mirrored from sync-packages.ts.

import pg from "pg";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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

/**
 * Walk <repoRoot>/agents/<slug>/skills and upsert every SKILL.md as a
 * level:"agent" row in the `skills` table (and the matching `skill_packages`
 * row). Returns `{ registered: string[], skipped: Array<{slug, reason}> }`.
 * Never throws — errors are collected per agent / per skill.
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

        let skillContent;
        try {
          skillContent = readFileSync(skillMdPath, "utf8");
        } catch (err) {
          result.skipped.push({
            slug: `${dirSlug}/${skillEntryName}`,
            reason: `read failed: ${err && err.message ? err.message : String(err)}`,
          });
          continue;
        }

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

        try {
          await client.query(
            `INSERT INTO ${schemaIdent}.skills (id, payload) VALUES ($1, $2)
             ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload`,
            [skillId, JSON.stringify(skillRow)],
          );
          result.registered.push(skillId);
        } catch (err) {
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
