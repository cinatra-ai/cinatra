import { revalidatePath } from "next/cache";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "fs";
import { mkdir, writeFile, rm } from "fs/promises";
import path from "path";
import { readConnectorConfigFromDatabase, writeConnectorConfigToDatabase, readSkillCatalogFromDatabase, replaceSkillCatalogInDatabase, getPostgresConnectionString, postgresSchema } from "@/lib/database";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { installedSkillPackages } from "./skill-packages";
import { commitSkillChange } from "./storage/git-commit";
import { buildSkillSourceForWrite, isSkillSource, resolveSkillSource, type SkillSource } from "./skill-source";

// Auto-sync the configured GitHub repository once per process lifetime.
// After the first call (success or failure), the flag stays true so subsequent
// catalog reads skip the network check entirely.
// Dynamic import avoids a circular dependency with ./github (which imports from here).
let githubAutoSyncAttempted = false;

async function tryAutoSyncConfiguredRepository() {
  try {
    const { ensureConfiguredRepositorySynced } = await import("./github");
    await ensureConfiguredRepositorySynced();
  } catch {
    // Fail silently — GitHub may not be configured yet.
  }
}

export type SkillLevel = "personal" | "team" | "organization" | "workspace" | "project" | "system" | "agent";

// ---------------------------------------------------------------------------
// SkillWriteContext + deriveContextFromLegacy bridge
// ---------------------------------------------------------------------------
// Identity tuple required by the ownership-aware resolver (`resolveSkillDir`). Every
// write path is migrated to pass a `SkillWriteContext` so the file lands in
// the new ownership-first layout. The bridge `deriveContextFromLegacy` keeps
// callers that haven't been rewired yet working — it derives a best-effort
// context from the legacy `SkillLevel` enum + packageSlug + ownerUserId.

import type { OwnerScope, BindingScope, SourceKind } from "./skill-paths";

export interface SkillWriteContext {
  owner_scope: OwnerScope;
  owner_id: string | null;
  binding_scope: BindingScope;
  source_kind: SourceKind;
  vendor: string | null;
  package: string | null;
  agent_template_id: string | null;
  /** Stable per-skill slug — leaf directory name. */
  skill_slug: string;
}

/**
 * Derive a best-effort SkillWriteContext from the legacy (type, packageSlug,
 * ownerUserId) shape. Used by upsertSkill when a caller hasn't been rewired
 * yet. This bridge can be removed once every caller passes context explicitly.
 * The mapping aims for the closest semantic equivalent:
 *
 *   personal  → (personal, ownerUserId, owner, user-authored, vendor=null, package=null)
 *   team      → (team, owner_id=unknown, owner, user-authored) — caller MUST
 *               pass explicit context for team-scoped writes; the bridge
 *               falls back to workspace if the team_id can't be inferred
 *   organization → (workspace, null, owner, user-authored) until explicit
 *   workspace → (workspace, null, owner, installed)
 *   project   → (workspace, null, owner, user-authored)
 *   system    → (workspace, null, owner, installed)
 *   agent     → (workspace, null, agent, bundled) — vendor/package derived
 *               from packageSlug; agent_template_id may be null pending
 *               explicit caller-supplied context
 */
export function deriveContextFromLegacy(
  type: SkillLevel,
  packageSlug: string,
  ownerUserId: string | undefined,
  skill_slug: string,
): SkillWriteContext {
  const base: Omit<SkillWriteContext, "owner_scope" | "owner_id" | "binding_scope" | "source_kind" | "vendor" | "package" | "agent_template_id"> = {
    skill_slug,
  };
  switch (type) {
    case "personal":
      return {
        ...base,
        owner_scope: "personal",
        owner_id: ownerUserId ?? "unknown",
        binding_scope: "owner",
        source_kind: "user-authored",
        vendor: null,
        package: null,
        agent_template_id: null,
      };
    case "team":
      // Without an explicit team_id, fall back to workspace to avoid the
      // resolver throwing on a missing slug-map entry. Explicit context fixes this.
      return {
        ...base,
        owner_scope: "workspace",
        owner_id: null,
        binding_scope: "owner",
        source_kind: "user-authored",
        vendor: null,
        package: null,
        agent_template_id: null,
      };
    case "organization":
      return {
        ...base,
        owner_scope: "workspace",
        owner_id: null,
        binding_scope: "owner",
        source_kind: "user-authored",
        vendor: null,
        package: null,
        agent_template_id: null,
      };
    case "workspace":
    case "system":
      return {
        ...base,
        owner_scope: "workspace",
        owner_id: null,
        binding_scope: "owner",
        source_kind: "installed",
        vendor: null,
        package: null,
        agent_template_id: null,
      };
    case "project":
      return {
        ...base,
        owner_scope: "workspace",
        owner_id: null,
        binding_scope: "owner",
        source_kind: "user-authored",
        vendor: null,
        package: null,
        agent_template_id: null,
      };
    case "agent": {
      // Try to split packageSlug at the first dash to derive vendor/package.
      // Callers should pass explicit context with agent_template_id to satisfy
      // the bidirectional CHECK constraint; the bridge fallback uses
      // binding_scope='owner' for safety.
      const dashIdx = packageSlug.indexOf("-");
      const vendor = dashIdx > 0 ? packageSlug.slice(0, dashIdx) : null;
      const pkg = dashIdx > 0 ? packageSlug.slice(dashIdx + 1) : packageSlug;
      return {
        ...base,
        owner_scope: "workspace",
        owner_id: null,
        binding_scope: "owner", // safe fallback; explicit callers use 'agent'
        source_kind: "user-authored",
        vendor,
        package: vendor ? pkg : null,
        agent_template_id: null,
      };
    }
  }
}
// ---------------------------------------------------------------------------

export type PersistedSkillPackage = {
  id: string;
  packageId: string;
  name: string;
  slug: string;
  description: string;
  sourceUrl?: string;
  repositoryUrl?: string;
  license?: string;
  authors?: string[];
  repositoryPath?: string;
  readmeContent?: string;
  licenseText?: string;
  isCustom?: boolean;
  level?: SkillLevel;
  originRepoUrl?: string;
  /**
   * Per-package access policy. Same shape as AgentAuthPolicy so
   * the same PermissionsForm widget binds against either. When null/undefined
   * the package inherits whatever default the consumer applies (typically
   * `owner` for newly-installed packages, derived from the install actor's
   * intent at /configuration/extensions/upload). Persisted inside the
   * skill_packages.payload JSON blob alongside the other PersistedSkillPackage
   * fields; co-owner rows live in the dedicated cinatra.skill_package_co_owners
   * table.
   */
  accessPolicy?: import("@cinatra-ai/agents/auth-policy").AgentAuthPolicy | null;
  /**
   * ID of the better-auth user who installed the package. Acts
   * as the primary owner for the access-policy gate. May be null on
   * older rows. Treat null as "any admin can manage".
   */
  installedByUserId?: string | null;
};

export type PersistedSkill = {
  id: string;
  name: string;
  slug: string;
  description: string;
  content: string;
  packageId: string;
  packageName: string;
  packageSlug: string;
  sourceUrl?: string;
  sourcePath?: string;
  /**
   * Content-source descriptor. When present, content readers
   * resolve through this rather than treating `sourcePath` as permanent truth;
   * `sourcePath` stays the legacy fallback. Persisted inside this row's payload
   * JSON — additive, no schema change.
   */
  source?: SkillSource | null;
  usedBy: string[];
  isCustom?: boolean;
  basedOnSkillId?: string;
  basedOnSkillIds?: string[];
  /** True for LLM-generated delta skills scoped to a user/agent. Storage key: isPersonal (kept for backward compat). */
  isCustomSkill?: boolean;
  ownerUserId?: string;
  agentId?: string;
  updatedAt?: string;
  level?: SkillLevel;
  scope?: string;
  originRepo?: string;
  /** LLM-generated short prompt that invokes this skill — surfaced as a chat suggestion badge. */
  prefillText?: string;
  /**
   * Per-skill access policy override. When set,
   * takes precedence over the parent skill_package's accessPolicy for this
   * skill row. Stored alongside the legacy (level, scope) projection so
   * existing matching / visibility readers keep working unchanged
   * (compatibility projection). When null/undefined the skill inherits
   * the parent package's policy.
   */
  accessPolicy?: import("@cinatra-ai/agents/auth-policy").AgentAuthPolicy | null;
  /**
   * Per-skill Anthropic-upload exclusion flag.
   *
   * ADMIN-SET, DB-ONLY. This is NEVER read from `SKILL.md` frontmatter or any
   * package-author-controlled source — a package must not be able to opt
   * ITSELF into having its body uploaded to Anthropic Custom Skills (which are
   * not ZDR-eligible and are retained by Anthropic).
   *
   * Fail-closed: only the literal primitive `true` permits upload. Unset /
   * `undefined` / `false` / any non-`true` value means the skill is EXCLUDED
   * from Anthropic upload, even when the global `anthropicSkillSyncEnabled`
   * opt-in is ON. The authoritative decision combines this flag AND the global
   * opt-in via the upload gate (`isAnthropicSkillUploadAllowed`); the sync
   * engine MUST consult that gate before any upload.
   */
  allowAnthropicUpload?: boolean;
};

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const SKILL_LEVELS: SkillLevel[] = ["personal", "team", "organization", "workspace", "project", "system", "agent"];

function isSkillLevel(value: unknown): value is SkillLevel {
  return typeof value === "string" && (SKILL_LEVELS as string[]).includes(value);
}

const SKILLS_STORAGE_CONFIG_KEY = "skills_storage";

/**
 * A canonical content-store root (`storePath`,
 * default `data/skill-store`) distinct from the legacy `data/skills` tree
 * (`dataPath`). New `upsertSkill` writes target the new store; the legacy
 * tree stays readable as a compat fallback (and is what the store migration migrates).
 * The config field is additive — existing callers that read only `dataPath`
 * keep working unchanged.
 */
export function readSkillsStorageConfig(): { dataPath: string; storePath: string } {
  const config = readConnectorConfigFromDatabase<{ dataPath?: string; storePath?: string }>(
    SKILLS_STORAGE_CONFIG_KEY,
    {},
  );
  return {
    dataPath: config.dataPath?.trim() || "data/skills",
    storePath: config.storePath?.trim() || "data/skill-store",
  };
}

export function writeSkillsStorageConfig(value: { dataPath?: string; storePath?: string }) {
  const current = readSkillsStorageConfig();
  writeConnectorConfigToDatabase(SKILLS_STORAGE_CONFIG_KEY, {
    dataPath: value.dataPath?.trim() || current.dataPath,
    storePath: value.storePath?.trim() || current.storePath,
  });
}

export function getSkillsDataRootPath(): string {
  const { dataPath } = readSkillsStorageConfig();
  return path.isAbsolute(dataPath) ? dataPath : path.join(process.cwd(), dataPath);
}

/**
 * The new canonical skill content store. All new `upsertSkill`
 * writes land here; legacy `data/skills` reads remain valid as a compat
 * fallback. The store migration migrates legacy → new-store, and gates against new
 * canonical writes to `data/skills`.
 */
export function getSkillStoreRootPath(): string {
  const { storePath } = readSkillsStorageConfig();
  return path.isAbsolute(storePath) ? storePath : path.join(process.cwd(), storePath);
}

function getInstalledPackagesDir() {
  return getSkillsDataRootPath();
}

/**
 * Compose an ownership-first disk path from the legacy
 * (type, packageSlug, skillSlug, ownerUserId?) tuple. This replaces the
 * legacy switch that returned `~personal/~agent/~team/~organization/~custom`
 * paths.
 *
 * Mapping:
 *   personal  → personal/<username-or-userId>/<skillSlug>
 *   agent     → workspace/~agents/<vendor>/<package>/<skillSlug>  where
 *               <vendor>/<package> = split(packageSlug, "/") — npm-scoped
 *               package names like "cinatra/email-test-delivery-agent"
 *               already encode the structure
 *   system    → workspace/<packageSlug>/<skillSlug>
 *   team      → workspace/<packageSlug>/<skillSlug>  [TEMP: full owner-aware
 *               routing requires explicit SkillWriteContext from caller;
 *               legacy callers fall back to workspace until that context is
 *               available everywhere.]
 *   organization → workspace/<packageSlug>/<skillSlug>  [TEMP, same as team]
 *   workspace → workspace/<packageSlug>/<skillSlug>
 *   project   → workspace/<packageSlug>/<skillSlug>  [TEMP, same as team]
 *   custom    → workspace/<packageSlug>/<skillSlug>
 *
 * For personal scope, the on-disk segment uses the SESSION USERNAME when
 * possible (sync-resolved via cinatra.* … but skills-store doesn't have
 * direct access to public.user; falls back to the raw ownerUserId).
 *
 * The bridge `deriveContextFromLegacy` provides the canonical mapping
 * elsewhere; this function exists as the single sync write-path resolver
 * for the legacy callsite at `upsertSkill`. Remove it once every caller
 * passes explicit SkillWriteContext.
 */
function getSkillDiskDir(
  type: SkillLevel,
  packageSlug: string,
  skillSlug: string,
  ownerUserId?: string,
): string {
  // New upsertSkill writes target the canonical content store
  // (`data/skill-store`) instead of the legacy `data/skills` tree. Path
  // suffix composition (`personal/<userId>/<slug>`, `workspace/<pkg>/<slug>`,
  // etc.) is unchanged — only the root prefix changes. Legacy rows whose
  // sourcePath still points inside `data/skills` keep reading via the
  // containment fallback (`assertSkillFilePathInsideRoot` accepts both
  // roots). The store migration migrates remaining legacy-only entries and
  // gates against new canonical writes to `data/skills`.
  const root = getSkillStoreRootPath();
  switch (type) {
    case "personal":
      // personal/<ownerUserId-or-LOCAL_USER_ID>/<skillSlug>
      // The on-disk segment uses ownerUserId verbatim (not username) —
      // this preserves stability across username renames. The slug-rename
      // worker handles username changes via path_relocations. Personal
      // skills uploaded via the dev bypass land at personal/local-user/
      // (the LOCAL_USER_ID sentinel).
      return path.join(root, "personal", ownerUserId ?? "local-user", skillSlug);
    case "agent": {
      // packageSlug may be npm-scoped ("cinatra/email-test-delivery-agent")
      // or flat ("cinatra-email-test-delivery-agent"). Prefer the npm-scoped
      // shape; for flat slugs, fall back to splitting at the
      // FIRST dash. Result: workspace/~agents/<vendor>/<package>/<skill>/
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
      return path.join(root, "workspace", "~agents", vendor, pkg, skillSlug);
    }
    case "system":
    case "workspace":
      return path.join(root, "workspace", packageSlug, skillSlug);
    case "team":
    case "organization":
    case "project":
      // LIMITATION: explicit owner_scope/owner_id routing requires the caller
      // to pass SkillWriteContext. Legacy callers fall back to workspace tier.
      // This means a team-scoped custom skill created via the legacy API
      // lands at workspace/<packageSlug>/<skillSlug> instead of
      // organization/<org-slug>/~teams/<team-slug>/<vendor>/... — semantically
      // wrong but path-safe (no ~-prefixed legacy bucket).
      return path.join(root, "workspace", packageSlug, skillSlug);
    default:
      // SkillLevel "custom" + any future enum value
      return path.join(root, "workspace", packageSlug, skillSlug);
  }
}

function parseFrontmatter(content: string) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) {
    return { attributes: {} as Record<string, string>, body: content };
  }

  const attributes: Record<string, string> = {};
  let lastKey: string | null = null;
  const listAccumulatorByKey: Record<string, string[]> = {};

  for (const rawLine of match[1].split("\n")) {
    // Detect YAML block-sequence continuation lines (`  - <value>`)
    // before trimming, so the leading whitespace signals list membership.
    const blockSequenceContinuation = /^[ \t]+-[ \t]+/.test(rawLine);
    if (blockSequenceContinuation && lastKey !== null) {
      const itemValue = rawLine.replace(/^[ \t]+-[ \t]+/, "").trim().replace(/^["']|["']$/g, "");
      if (!listAccumulatorByKey[lastKey]) {
        listAccumulatorByKey[lastKey] = [];
      }
      listAccumulatorByKey[lastKey].push(itemValue);
      continue;
    }

    const line = rawLine.trim();
    if (!line) continue;

    const separatorIndex = line.indexOf(":");
    if (separatorIndex < 0) {
      lastKey = line;
      attributes[line] = "";
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim().replace(/^["']|["']$/g, "");
    lastKey = key;
    attributes[key] = value;
  }

  // Serialize collected lists as JSON strings so the Record<string, string> type is preserved.
  for (const [key, items] of Object.entries(listAccumulatorByKey)) {
    attributes[key] = JSON.stringify(items);
  }

  return {
    attributes,
    body: content.slice(match[0].length),
  };
}

function readPluginManifestLevel(packageRootPath: string): SkillLevel | undefined {
  const pluginJsonPath = path.join(packageRootPath, "cinatra", "plugin.json");
  // Leaf confinement (file-symlink escape, #300): `packageRootPath` is a
  // confined package dir, but a `cinatra/plugin.json` that is a SYMLINK to an
  // outside file would be followed by the `readFileSync` below. Skip (treat as
  // no manifest) when the real file escapes the real package dir.
  if (!existsSync(pluginJsonPath) || !isFileLeafContainedInDir(packageRootPath, pluginJsonPath))
    return undefined;
  try {
    const manifest = JSON.parse(readFileSync(pluginJsonPath, "utf8")) as { skills?: { type?: string } };
    const type = manifest.skills?.type;
    if (isSkillLevel(type)) return type;
  } catch {
    // ignore malformed plugin.json
  }
  return undefined;
}

function getSkillUsage(_packageId: string, _skillSlug: string) {
  return [];
}

function getCatalogDocumentPath(installedPackage: { repositoryPath?: string; localShellSkillsPath?: string }) {
  return installedPackage.repositoryPath ?? installedPackage.localShellSkillsPath ?? "";
}

type DiscoveredSkillDirectory = {
  slug: string;
  relativeDirectoryPath: string;
  skillFilePath: string;
};

function collectSkillDirectories(searchRootPath: string, relativeDirectoryPath = ""): DiscoveredSkillDirectory[] {
  if (!searchRootPath) {
    return [];
  }

  // Fail-closed containment barrier (js/path-injection). Confine the
  // externally-supplied BASE directory to the allowed skill roots exactly once,
  // at the top-level call (`relativeDirectoryPath === ""`). Every current caller
  // already passes a base-confined root; this rejects a traversing base before
  // any fs read. Recursive descents (non-empty relative path) skip the guard:
  // their base is a previously-confined parent joined with a readdir'd child
  // name, which can never be `..`. Rebinding to the resolved value feeds the
  // barrier output into the existsSync/readdirSync sinks below.
  if (relativeDirectoryPath === "") {
    searchRootPath = assertSkillDirectoryInsideRoot(searchRootPath);
  }

  if (!existsSync(searchRootPath)) {
    return [];
  }

  const skillFilePath = path.join(searchRootPath, "SKILL.md");
  if (existsSync(skillFilePath)) {
    // Leaf confinement (file-symlink escape): `searchRootPath` is confined to
    // the skill roots, but if `SKILL.md` inside it is a SYMLINK to an outside
    // file the downstream `readFileSync(skillFilePath)` would follow it. When
    // the real file escapes the real directory, treat this dir as having no
    // skill (drop the discovery) so the escaping file is never read/ingested.
    if (!isFileLeafContainedInDir(searchRootPath, skillFilePath)) {
      return [];
    }
    return [
      {
        slug: path.basename(searchRootPath),
        relativeDirectoryPath,
        skillFilePath,
      },
    ];
  }

  const ignoredDirectoryNames = new Set([".git", ".github", ".claude-plugin", "node_modules", "src"]);
  const entries = readdirSync(searchRootPath, { withFileTypes: true });
  const results: DiscoveredSkillDirectory[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || ignoredDirectoryNames.has(entry.name)) {
      continue;
    }

    const childDirectoryPath = path.join(searchRootPath, entry.name);
    const childRelativeDirectoryPath = relativeDirectoryPath ? path.join(relativeDirectoryPath, entry.name) : entry.name;
    results.push(...collectSkillDirectories(childDirectoryPath, childRelativeDirectoryPath));
  }

  return results;
}

function scanInstalledPackageCatalog() {
  const skillPackages: PersistedSkillPackage[] = [];
  const skills: PersistedSkill[] = [];

  for (const installedPackage of installedSkillPackages) {
    const repositoryPath = installedPackage.repositoryPath;
    const catalogDocumentPath = getCatalogDocumentPath(installedPackage);
    const readmePath = catalogDocumentPath ? path.join(catalogDocumentPath, "README.md") : "";
    const licensePath = catalogDocumentPath ? path.join(catalogDocumentPath, "LICENSE") : "";

    const packageLevel = installedPackage.repositoryPath
      ? readPluginManifestLevel(installedPackage.repositoryPath)
      : undefined;

    const packageRecord: PersistedSkillPackage = {
      id: installedPackage.packageId,
      packageId: installedPackage.packageId,
      name: installedPackage.name,
      slug: installedPackage.slug,
      description: installedPackage.description,
      sourceUrl: installedPackage.sourceUrl,
      repositoryUrl: installedPackage.repositoryUrl,
      license: installedPackage.license,
      authors: installedPackage.authors,
      repositoryPath: installedPackage.repositoryPath,
      // Leaf confinement (file-symlink escape): README/LICENSE lexically live in
      // `catalogDocumentPath`, but a file-symlink to outside would be followed by
      // `readFileSync`. Skip the read when the real file escapes the real dir.
      readmeContent:
        existsSync(readmePath) && isFileLeafContainedInDir(catalogDocumentPath, readmePath)
          ? readFileSync(readmePath, "utf8")
          : undefined,
      licenseText:
        existsSync(licensePath) && isFileLeafContainedInDir(catalogDocumentPath, licensePath)
          ? readFileSync(licensePath, "utf8")
          : undefined,
      isCustom: false,
      level: packageLevel,
    };

    skillPackages.push(packageRecord);

    const discoveredSkills = collectSkillDirectories(repositoryPath ?? installedPackage.localShellSkillsPath ?? "");

    for (const discoveredSkill of discoveredSkills) {
      const content = readFileSync(discoveredSkill.skillFilePath, "utf8");
      const { attributes } = parseFrontmatter(content);
      const name = attributes.name
        ? String(attributes.name)
            .split("-")
            .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
            .join(" ")
        : discoveredSkill.slug
            .split("-")
            .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
            .join(" ");
      const description = attributes.description || `${name} skill from ${installedPackage.name}.`;

      skills.push({
        id: `${installedPackage.packageId}:${discoveredSkill.slug}`,
        name,
        slug: discoveredSkill.slug,
        description,
        content,
        packageId: installedPackage.packageId,
        packageName: installedPackage.name,
        packageSlug: installedPackage.slug,
        sourceUrl:
          installedPackage.repositoryUrl || installedPackage.sourceUrl
            ? `${installedPackage.repositoryUrl ?? installedPackage.sourceUrl}/tree/main/${discoveredSkill.relativeDirectoryPath}`
            : undefined,
        sourcePath: discoveredSkill.skillFilePath,
        usedBy: getSkillUsage(installedPackage.packageId, discoveredSkill.slug),
        isCustom: false,
        level: packageLevel,
      });
    }
  }

  // Also scan dynamically installed packages in data/skills/.
  // A directory may be a single package OR a "store" (container of packages, e.g. a
  // cloned GitHub repo). We detect stores by checking if sub-directories contain
  // cinatra/plugin.json or a skills/ folder — if so, each sub-directory is its own package.
  const installedDir = getInstalledPackagesDir();
  // Exclude user-managed directories (~ prefix) and legacy paths from package scanning.
  // "third-party" stays in the ignore set even though the SkillLevel value is
  // retired. Legacy deployments may still have a data/skills/third-party/*
  // bucket dir on disk from older installs; recursing into it would re-emit
  // every legacy package as a fresh "system"-level row. The catalog
  // already represents those packages via their canonical github:owner/repo
  // ids; ignoring the legacy bucket prevents duplicates.
  // Also include the ownership-first top-level names so the legacy scanner
  // doesn't re-index the new layout's content as fresh packages.
  // The new scanner (packages/skills/src/skill-scanner.ts:scanSkillsRoot) walks
  // these properly. Until scanInstalledPackageCatalog uses it, the existing
  // DB rows have correct sourcePath values so skills remain readable.
  // The `ignoredTopLevelDirs` name is intentional: tests verify this guard.
  // The legacy strings on the next line are intentional and benign — they
  // tell the legacy scanner to skip stale directories on disk.
  const ignoredTopLevelDirs = new Set(["~personal", "~team", "~organization", "~agent", "personal", "third-party", "workspace", "organization"]); // ignoredTopLevelDirs
  if (existsSync(installedDir)) {
    const topLevelEntries = readdirSync(installedDir, { withFileTypes: true }).filter(
      (e) => e.isDirectory() && !ignoredTopLevelDirs.has(e.name),
    );

    // Expand stores: if a directory contains sub-dirs with plugin.json or skills/, treat those as packages
    const packageDirs: Array<{ dir: string; slug: string }> = [];
    for (const entry of topLevelEntries) {
      const dirPath = path.join(installedDir, entry.name);
      const subEntries = readdirSync(dirPath, { withFileTypes: true }).filter((e) => e.isDirectory());
      const isStore = subEntries.some(
        (sub) =>
          existsSync(path.join(dirPath, sub.name, "cinatra", "plugin.json")) ||
          existsSync(path.join(dirPath, sub.name, "skills")),
      );

      if (isStore) {
        // Store directory — each sub-dir is its own package
        for (const sub of subEntries) {
          if (sub.name.startsWith(".")) continue;
          packageDirs.push({ dir: path.join(dirPath, sub.name), slug: sub.name });
        }
      } else {
        // Single package directory
        packageDirs.push({ dir: dirPath, slug: entry.name });
      }
    }

    for (const { dir: repoDir, slug: packageSlug } of packageDirs) {
      const pluginLevel = readPluginManifestLevel(repoDir);

      // When the GitHub install wrote a provenance marker, honor its packageId.
      // The marker also carries the canonical
      // repository slug so a subsequent sync doesn't downgrade the rich
      // upsert row (id: "github:owner/repo") into a minimal scanner row
      // (id: "installed:slug"), which is what made the package detail
      // page render with empty repository/license/authors fields.
      const markerPath = path.join(repoDir, ".cinatra-skill-source.json");
      let markerPackageId: string | null = null;
      // Leaf confinement (file-symlink escape, #300): `repoDir` is confined,
      // but a `.cinatra-skill-source.json` symlinked to an outside file would
      // be followed by `readFileSync`. Skip the read when the real file escapes
      // the real package dir (treated as no marker, the malformed-marker path).
      if (existsSync(markerPath) && isFileLeafContainedInDir(repoDir, markerPath)) {
        try {
          const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { packageId?: unknown };
          if (typeof marker.packageId === "string" && marker.packageId.length > 0) {
            markerPackageId = marker.packageId;
          }
        } catch {
          // malformed marker — fall back to legacy package.json / installed: derivation
        }
      }

      // Prefer the marker, then package.json `name`, then `installed:<slug>`.
      // Keeping IDs consistent with collectLocalPackageSkills() in
      // skills-registry.ts for the package.json branch.
      const pkgJsonPath = path.join(repoDir, "package.json");
      let packageId: string;
      if (markerPackageId) {
        packageId = markerPackageId;
      } else {
        try {
          // Leaf confinement (file-symlink escape, #300): a `package.json`
          // symlinked to an outside file would be followed by `readFileSync`.
          // On escape, fall through to the `installed:<slug>` derivation rather
          // than ingesting the outside file's `name`.
          packageId = isFileLeafContainedInDir(repoDir, pkgJsonPath)
            ? (JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { name?: string }).name?.trim() || `installed:${packageSlug}`
            : `installed:${packageSlug}`;
        } catch {
          packageId = `installed:${packageSlug}`;
        }
      }

      // If the github: row already exists in the merge buffer (from a
      // previous custom row that survived the sync filter), let it win
      // over the scanner row — the upsert path stores richer metadata
      // (description, repositoryUrl, license, authors) than the scanner
      // can synthesize.
      if (markerPackageId && skillPackages.some((p) => p.id === markerPackageId)) continue;
      // Skip if already registered from monorepo packages
      if (skillPackages.some((p) => p.id === packageId || p.slug === packageSlug)) continue;

      const readmePath = path.join(repoDir, "README.md");
      const licensePath = path.join(repoDir, "LICENSE");
      // Fall back to "system" when plugin.json doesn't declare a level, and
      // key isCustom on the absence of plugin.json rather than on the retired
      // "third-party" SkillLevel value.
      const resolvedLevel: SkillLevel = pluginLevel ?? "system";
      const packageRecord: PersistedSkillPackage = {
        id: packageId,
        packageId,
        name: packageSlug,
        slug: packageSlug,
        description: `Skills package from ${packageSlug}.`,
        repositoryPath: repoDir,
        // Leaf confinement (file-symlink escape, #300): README/LICENSE lexically
        // live in the confined `repoDir`, but a file-symlink to outside would be
        // followed by `readFileSync`. Skip the read when the real file escapes
        // the real dir (mirrors the scanInstalledPackageCatalog probe above).
        readmeContent:
          existsSync(readmePath) && isFileLeafContainedInDir(repoDir, readmePath)
            ? readFileSync(readmePath, "utf8")
            : undefined,
        licenseText:
          existsSync(licensePath) && isFileLeafContainedInDir(repoDir, licensePath)
            ? readFileSync(licensePath, "utf8")
            : undefined,
        isCustom: !pluginLevel,
        level: resolvedLevel,
      };

      skillPackages.push(packageRecord);

      const discoveredSkills = collectSkillDirectories(repoDir);
      for (const discoveredSkill of discoveredSkills) {
        const content = readFileSync(discoveredSkill.skillFilePath, "utf8");
        const { attributes } = parseFrontmatter(content);
        const name = attributes.name
          ? String(attributes.name)
              .split("-")
              .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
              .join(" ")
          : discoveredSkill.slug
              .split("-")
              .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
              .join(" ");
        const description = attributes.description || `${name} skill from ${packageSlug}.`;

        skills.push({
          id: `${packageId}:${discoveredSkill.slug}`,
          name,
          slug: discoveredSkill.slug,
          description,
          content,
          packageId,
          packageName: packageSlug,
          packageSlug,
          sourcePath: discoveredSkill.skillFilePath,
          usedBy: [],
          // isCustom is keyed on absence of plugin.json level rather than the
          // obsolete "third-party" SkillLevel.
          isCustom: !pluginLevel,
          level: resolvedLevel,
          scope: packageSlug,
        });
      }
    }
  }

  return { skillPackages, skills };
}

function normalizeStoredSkillPackage(record: Record<string, unknown>): PersistedSkillPackage | null {
  if (
    typeof record.id !== "string" ||
    typeof record.packageId !== "string" ||
    typeof record.slug !== "string" ||
    typeof record.name !== "string" ||
    typeof record.description !== "string"
  ) {
    return null;
  }

  return {
    id: record.id,
    packageId: record.packageId,
    slug: record.slug,
    name: record.name,
    description: record.description,
    sourceUrl: typeof record.sourceUrl === "string" ? record.sourceUrl : undefined,
    repositoryUrl: typeof record.repositoryUrl === "string" ? record.repositoryUrl : undefined,
    license: typeof record.license === "string" ? record.license : undefined,
    authors: Array.isArray(record.authors) ? record.authors.filter((entry): entry is string => typeof entry === "string") : undefined,
    repositoryPath: typeof record.repositoryPath === "string" ? record.repositoryPath : undefined,
    readmeContent: typeof record.readmeContent === "string" ? record.readmeContent : undefined,
    licenseText: typeof record.licenseText === "string" ? record.licenseText : undefined,
    isCustom: record.isCustom === true,
    level: isSkillLevel(record.level) ? record.level : undefined,
    originRepoUrl: typeof record.originRepoUrl === "string" ? record.originRepoUrl : undefined,
  };
}

function isPersistedSkillPackage(value: PersistedSkillPackage | null): value is PersistedSkillPackage {
  return value !== null;
}

function normalizeStoredSkill(record: Record<string, unknown>): PersistedSkill | null {
  if (
    typeof record.id !== "string" ||
    typeof record.slug !== "string" ||
    typeof record.name !== "string" ||
    typeof record.description !== "string" ||
    typeof record.content !== "string" ||
    typeof record.packageId !== "string" ||
    typeof record.packageName !== "string" ||
    typeof record.packageSlug !== "string"
  ) {
    return null;
  }

  const base: PersistedSkill = {
    id: record.id,
    slug: record.slug,
    name: record.name,
    description: record.description,
    content: record.content,
    packageId: record.packageId,
    packageName: record.packageName,
    packageSlug: record.packageSlug,
    sourceUrl: typeof record.sourceUrl === "string" ? record.sourceUrl : undefined,
    sourcePath: typeof record.sourcePath === "string" ? record.sourcePath : undefined,
    source: isSkillSource(record.source) ? record.source : undefined,
    usedBy: Array.isArray(record.usedBy) ? record.usedBy.filter((entry): entry is string => typeof entry === "string") : [],
    isCustom: record.isCustom === true,
    basedOnSkillId: typeof record.basedOnSkillId === "string" ? record.basedOnSkillId : undefined,
    basedOnSkillIds: Array.isArray(record.basedOnSkillIds)
      ? record.basedOnSkillIds.filter((e): e is string => typeof e === "string")
      : undefined,
    // Read from either storage key for backward compatibility with old records.
    isCustomSkill: record.isCustomSkill === true || record.isPersonal === true,
    ownerUserId: typeof record.ownerUserId === "string" ? record.ownerUserId : undefined,
    agentId: typeof record.agentId === "string" ? record.agentId : undefined,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : undefined,
    originRepo: typeof record.originRepo === "string" ? record.originRepo : undefined,
    prefillText:
      typeof record.prefillText === "string" && record.prefillText.trim().length > 0
        ? record.prefillText.trim()
        : undefined,
    // Strict primitive. Garbage / missing → undefined
    // (excluded). The whitelist would silently drop this field otherwise.
    allowAnthropicUpload:
      record.allowAnthropicUpload === true ? true : undefined,
  };

  // Derive level and scope if not explicitly stored
  const storedLevel = isSkillLevel(record.level) ? record.level : undefined;
  if (storedLevel) {
    base.level = storedLevel;
    const storedScope = typeof record.scope === "string" ? record.scope : undefined;
    // Personal rows were historically written with `level: "personal"` and
    // `ownerUserId` but no `scope`. The skill-resource authz keys owner
    // identity off `scope`, so fall back to `ownerUserId` for explicit
    // "personal" rows that are missing a stored scope. Other levels keep the
    // strict stored-scope behavior.
    base.scope =
      storedScope ?? (storedLevel === "personal" ? base.ownerUserId : undefined);
  } else if (base.isCustomSkill) {
    base.level = "personal";
    base.scope = base.ownerUserId;
  } else if (base.isCustom) {
    base.level = "organization";
    base.scope = "org";
  } else {
    // "third-party" is retired; fall through to "system" so existing readers
    // see a valid SkillLevel. Scope still points at the package slug.
    base.level = "system";
    base.scope = base.packageSlug;
  }

  return base;
}

function isPersistedSkill(value: PersistedSkill | null): value is PersistedSkill {
  return value !== null;
}

function sortCatalog<T extends { id: string }>(items: T[]) {
  return [...items].sort((left, right) => left.id.localeCompare(right.id));
}

function catalogSignature(input: { skillPackages: PersistedSkillPackage[]; skills: PersistedSkill[] }) {
  return JSON.stringify({
    skillPackages: sortCatalog(input.skillPackages),
    skills: sortCatalog(input.skills),
  });
}

export async function syncInstalledSkillsToDatabase() {
  if (!githubAutoSyncAttempted) {
    githubAutoSyncAttempted = true;
    await tryAutoSyncConfiguredRepository();
  }

  const scanned = scanInstalledPackageCatalog();
  const current = readSkillCatalogFromDatabase();
  // Keep DB-persisted custom packages/skills.
  //
  // Custom rows with `packageId.startsWith("github:")` are valid rich rows,
  // not stale scanner artifacts. Dropping them is harmful:
  // installSkillPackageFromGitHub stores
  // rich metadata under `github:owner/repo`, and dropping those rows
  // forced the skills surface to fall back to the minimal scanner row
  // (`installed:<slug>` with empty description/license/authors). Keep
  // them; the scanner is taught to honor the .cinatra-skill-source.json
  // marker so it doesn't synthesize a duplicate row.
  const customPackages = current.skillPackages
    .map(normalizeStoredSkillPackage)
    .filter(isPersistedSkillPackage)
    .filter((entry) => entry.isCustom);
  const customSkills = current.skills
    .map(normalizeStoredSkill)
    .filter(isPersistedSkill)
    .filter((entry) => entry.isCustom);

  // When a custom package and a scanner package share an id
  // (the install path wrote a rich row AND the disk-scanner found the
  // same directory via its `.cinatra-skill-source.json` marker), prefer
  // the custom (DB) row. The DB row carries the full repository name
  // ("owner/repo"), upstream description, repositoryUrl, license, and
  // authors — the scanner only has the on-disk slug + README. Outside
  // that overlap, scanner rows still seed system / un-marked packages.
  const customPackageIds = new Set(customPackages.map((entry) => entry.id));
  const mergedPackages = [
    ...scanned.skillPackages.filter((entry) => !customPackageIds.has(entry.id)),
    ...customPackages,
  ];

  // Build a lookup of existing prefillText values keyed by skill id so the
  // disk-scanned skills (which never contain prefillText) can carry the
  // LLM-generated text forward across syncs. Without this, every sync would
  // silently drop prefillText for every third-party/system skill.
  const existingPrefillTextBySkillId = new Map<string, string>();
  // The per-skill Anthropic-upload flag is an admin-set
  // DB-only value (NEVER from SKILL.md / disk). Disk-scanned skills never carry
  // it, so without this carry-forward every resync would silently clobber the
  // admin's choice back to "excluded" — exactly the failure mode prefillText
  // already guards against. Only the literal `true` is carried (fail-closed).
  const existingAllowAnthropicUploadBySkillId = new Set<string>();
  for (const record of current.skills) {
    const normalized = normalizeStoredSkill(record);
    if (normalized?.prefillText) {
      existingPrefillTextBySkillId.set(normalized.id, normalized.prefillText);
    }
    if (normalized?.allowAnthropicUpload === true) {
      existingAllowAnthropicUploadBySkillId.add(normalized.id);
    }
  }

  const mergedSkills = [
    ...scanned.skills.map((scannedSkill) => {
      const carriedPrefillText = existingPrefillTextBySkillId.get(scannedSkill.id);
      const carriedAllowAnthropicUpload = existingAllowAnthropicUploadBySkillId.has(
        scannedSkill.id,
      );
      let merged = scannedSkill;
      if (carriedPrefillText) {
        merged = { ...merged, prefillText: carriedPrefillText };
      }
      if (carriedAllowAnthropicUpload) {
        merged = { ...merged, allowAnthropicUpload: true };
      }
      return merged;
    }),
    ...customSkills.filter(
      (entry) => !scanned.skills.some((installedSkill) => installedSkill.id === entry.id),
    ),
  ];

  if (
    catalogSignature({ skillPackages: mergedPackages, skills: mergedSkills }) !==
    catalogSignature({
      skillPackages: current.skillPackages.map(normalizeStoredSkillPackage).filter(isPersistedSkillPackage),
      skills: current.skills.map(normalizeStoredSkill).filter(isPersistedSkill),
    })
  ) {
    replaceSkillCatalogInDatabase({
      skillPackages: mergedPackages,
      skills: mergedSkills,
    });
  }

  // Enqueue background prefill text generation for any merged skill that
  // still has no prefillText. Wrapped in try/catch because Redis may be
  // unavailable in local dev — prefill generation is non-critical and the
  // sync must succeed regardless. Dynamic import avoids a top-level dep
  // from @cinatra-ai/skills onto src/lib/background-jobs.ts.
  const skillsNeedingPrefill = mergedSkills.filter((entry) => {
    const prefillText = (entry as { prefillText?: unknown }).prefillText;
    return !(typeof prefillText === "string" && prefillText.trim().length > 0);
  });
  if (skillsNeedingPrefill.length > 0) {
    try {
      const { enqueueBackgroundJob, BACKGROUND_JOB_NAMES } = await import("@/lib/background-jobs");
      await enqueueBackgroundJob(
        BACKGROUND_JOB_NAMES.SKILL_PREFILL_GENERATION,
        { skillIds: skillsNeedingPrefill.map((entry) => entry.id) },
        { jobId: `skill-prefill-generation-${skillsNeedingPrefill.map((e) => e.id).sort().join(",").replace(/:/g, "_")}` },
      );
    } catch (enqueueError) {
      console.warn(
        "[skills-store] Failed to enqueue skill prefill generation (Redis unavailable?):",
        enqueueError instanceof Error ? enqueueError.message : enqueueError,
      );
    }
  }

  return { skillPackages: mergedPackages, skills: mergedSkills };
}

export async function readSkillsCatalog() {
  return syncInstalledSkillsToDatabase();
}

/**
 * Per-skill Anthropic-upload read API.
 *
 * The sync engine consults this with the global `anthropicSkillSyncEnabled`
 * opt-in before any upload. Fail-closed: returns `true` ONLY when the catalog
 * skill exists and its normalized `allowAnthropicUpload` is the literal
 * primitive `true`.
 * Unknown skill id, a read error, or any non-`true` flag value → `false`
 * (excluded). Does NOT trigger a sync; a pure read of the persisted catalog.
 */
export function getSkillAnthropicUploadFlag(skillId: string): boolean {
  if (typeof skillId !== "string" || skillId.length === 0) return false;
  try {
    const current = readSkillCatalogFromDatabase();
    const record = current.skills.find(
      (entry) => typeof entry?.id === "string" && entry.id === skillId,
    );
    if (!record) return false;
    const normalized = normalizeStoredSkill(record);
    return normalized?.allowAnthropicUpload === true;
  } catch {
    // Fail-closed: any read/normalization error → excluded.
    return false;
  }
}

/**
 * Upsert a skill of any level. Path composition, disk write, and catalog
 * persistence are all handled here — callers never construct file paths.
 *
 * Disk path by type (all relative to getSkillsDataRootPath()):
 *   personal     → ~personal/<userId>/<skillSlug>/SKILL.md
 *   system       → <packageSlug>/skills/<skillSlug>/SKILL.md
 *   team         → ~team/<packageSlug>/<skillSlug>/SKILL.md
 *   organization → ~organization/<packageSlug>/<skillSlug>/SKILL.md
 */
export async function upsertSkill(input: {
  type: SkillLevel;
  packageName: string;
  name: string;
  description?: string;
  content: string;
  basedOnSkillId?: string;
  basedOnSkillIds?: string[];
  /** Provide to update an existing skill; omit to always create. */
  skillId?: string;
  /** Required when type === "personal". */
  ownerUserId?: string;
  /** Required when type === "personal". */
  agentId?: string;
  /**
   * Pre-set the prefillText for this skill. Pass a non-empty string (e.g. "-")
   * to mark the skill as not needing badge generation — useful for agent
   * instruction files that are not user-facing chat skills.
   */
  prefillText?: string;
  /**
   * Optional storage-path override (the directory segment
   * under `data/skills/workspace/`). When set, on-disk layout uses this
   * directly instead of the slugify(packageName)-derived flat slug, so
   * storage mirrors the source package directory (e.g.
   * `cinatra-ai/assistant-skills`) independent of the skillId namespace.
   * Format: forward-slash-separated path segments, each filesystem-safe.
   * `getSkillDiskDir`'s workspace/system branches feed this verbatim into
   * `path.join`, so a slash naturally produces a nested directory.
   */
  storagePackagePath?: string;
}): Promise<PersistedSkill> {
  const existingCatalog = await readSkillsCatalog();
  const updatedAt = new Date().toISOString();

  const isPersonal = input.type === "personal";
  const packageSlug = isPersonal
    ? (slugify(DEFAULT_CUSTOM_SKILL_PACKAGE_NAME) || "custom-skills")
    : (slugify(input.packageName) || "custom-skills");
  const packageId = isPersonal ? DEFAULT_CUSTOM_SKILL_PACKAGE_ID : `custom:${packageSlug}`;

  // Derive a stable slug base for ID generation.
  const requestedSlugBase =
    slugify(input.name) ||
    (isPersonal
      ? slugify(`${input.ownerUserId ?? ""}-${input.agentId ?? ""}`) || "personal-skill"
      : "untitled-skill");

  // Start from the provided skillId or build from slug; deduplicate against others.
  let skillId = input.skillId?.trim() || `${packageId}:${requestedSlugBase}`;
  let suffix = 2;
  while (existingCatalog.skills.some((e) => e.id === skillId && e.id !== input.skillId)) {
    skillId = `${packageId}:${requestedSlugBase}-${suffix}`;
    suffix += 1;
  }

  // Derive slug by stripping the package prefix. Three cases:
  //   1. type:"agent" — skillId uses the agent's directory slug
  //      (e.g. "custom:email-recipients:email-recipients") while packageId
  //      uses the slugified npm name (e.g. "custom:cinatra-agents-email-recipients").
  //      The prefixes differ, so we MUST take the last colon-segment of skillId.
  //      Without this, skillSlug would become the full skillId string and the
  //      disk path would be data/skills/~agent/<pkg>/<full:skill:id>/SKILL.md
  //      instead of data/skills/~agent/<pkg>/<skillSlug>/SKILL.md.
  //   2. Normal case — packageId prefix matches: strip it.
  //   3. Legacy fallback — strip any "@scope/name:" prefix for non-"agent"
  //      levels.
  let skillSlug: string;
  if (input.type === "agent") {
    // Take the last colon-separated segment. For "custom:email-recipients:email-recipients"
    // this yields "email-recipients". For any future shape where skillId has more
    // segments, the trailing one is still the conventional slug location.
    const lastColon = skillId.lastIndexOf(":");
    skillSlug = lastColon >= 0 ? skillId.slice(lastColon + 1) : skillId;
  } else {
    const packagePrefix = `${packageId}:`;
    skillSlug = skillId.startsWith(packagePrefix)
      ? skillId.slice(packagePrefix.length)
      : skillId.replace(/^[^/]+\/[^:]+:/, "");
  }
  const existingSkill = existingCatalog.skills.find((e) => e.id === skillId);

  // Package record — reuse existing or create fresh.
  const existingPackage = existingCatalog.skillPackages.find((e) => e.packageId === packageId);
  const packageName = isPersonal
    ? DEFAULT_CUSTOM_SKILL_PACKAGE_NAME
    : (input.packageName.trim() || "Custom Skills");
  // Set `level` so the skills surface labels the package correctly
  // (mapSkillLevelToVisibility(pkg.level)), and make workspace/system infra
  // packages NOT user-removable (`isRemovable = pkg.isCustom === true`) — the
  // chat assistant-skills extension is infra, not a user-installed/removable
  // package.
  const isInfraLevel = input.type === "workspace" || input.type === "system";
  const packageRecord: PersistedSkillPackage = existingPackage ?? {
    id: packageId,
    packageId,
    name: packageName,
    slug: packageSlug,
    description: isPersonal
      ? "Custom skills generated from saved campaign guidance."
      : input.type === "system"
        ? `System skills managed by the ${packageName} package.`
        : isInfraLevel
          ? `Workspace skills provided by the ${packageName} package.`
          : "User-created skills package.",
    isCustom: !isInfraLevel,
    level: input.type,
  };

  // Compose disk path — fully internal, never exposed to callers.
  // Prefer the source-mirroring storagePackagePath when
  // provided (e.g. `cinatra-ai/assistant-skills`), else fall back to the
  // packageName-slugified flat slug. The DB packageId/packageRecord still
  // use the flat `packageSlug` so existing catalog keys stay stable.
  const skillDiskDir = getSkillDiskDir(
    input.type,
    input.storagePackagePath ?? packageSlug,
    skillSlug,
    input.ownerUserId,
  );
  const skillFilePath = path.join(skillDiskDir, "SKILL.md");

  // Strict write-side containment (js/path-injection). The disk segments are
  // slug-derived/actor-bound today, but assert BEFORE we mutate the catalog or
  // touch the filesystem so a future regression in slug derivation (or a stray
  // `..` reaching `skillSlug`/`storagePackagePath`) can never escape the store.
  //
  // Two layers:
  //   1. Reject any `.`/`..` traversal segment in the derived path components.
  //      The `storagePackagePath` agent branch legitimately uses `/` separators
  //      (vendor/pkg), so we forbid only the dot-segments, not separators.
  //   2. Resolve the final path and require it inside the *canonical* skill
  //      store root. Unlike the read-side `assertSkillFilePathInsideRoot`
  //      (which also tolerates the legacy `data/skills` root for compat), new
  //      writes must land in the canonical store — this prevents a crafted
  //      segment from resolving into the sibling legacy root for a cross-root
  //      clobber.
  for (const segment of [input.storagePackagePath ?? packageSlug, skillSlug, input.ownerUserId ?? ""]) {
    if (segment.split(/[/\\]/).some((part) => part === ".." || part === ".")) {
      throw new Error("Refusing to write a skill to a path containing a traversal segment.");
    }
  }
  const canonicalStoreRoot = path.resolve(getSkillStoreRootPath());
  const resolvedSkillDir = path.resolve(skillDiskDir);
  if (
    resolvedSkillDir !== canonicalStoreRoot &&
    !resolvedSkillDir.startsWith(canonicalStoreRoot + path.sep)
  ) {
    throw new Error("Skill write path is outside the canonical skill store root.");
  }
  // Layer 3 — realpath containment (#300). The lexical prefix check above is
  // satisfied by a path whose ANCESTOR (e.g. `workspace/<pkg>`) is a SYMLINK
  // pointing outside the store; the downstream `mkdir`/`writeFile` would then
  // materialize the SKILL.md OUTSIDE the canonical store. Canonicalize the
  // store root and the resolved skill DIR (nearest-existing-ancestor realpath
  // handles the not-yet-created leaf) and re-assert containment on the real
  // paths. Also confine the SKILL.md leaf itself: a pre-existing symlinked
  // leaf would have `writeFile` follow it out of the store. Behavior is
  // identical for legitimate non-symlink and not-yet-created paths (realpath
  // is a no-op on those).
  if (
    !isRealpathContained(resolvedSkillDir, canonicalStoreRoot) ||
    !isFileLeafContainedInDir(canonicalStoreRoot, skillFilePath)
  ) {
    throw new Error("Skill write path is outside the canonical skill store root.");
  }

  const defaultDescription = isPersonal
    ? `Custom skill for ${input.agentId ?? "this agent"}.`
    : "User-created skill.";

  const skillRecord: PersistedSkill = {
    id: skillId,
    name: input.name.trim() || (isPersonal ? "Custom Skill" : "Untitled Skill"),
    slug: skillSlug,
    description: input.description?.trim() || existingSkill?.description || defaultDescription,
    content: input.content,
    packageId,
    packageName: packageRecord.name,
    packageSlug: packageRecord.slug,
    sourcePath: skillFilePath,
    // Dual-write: populate the SkillSource descriptor on every
    // upsertSkill write. `revision` carries the sha256 of the current content
    // as the active-head pointer; extension snapshots replace this with
    // a digest revision. Readers don't consume `source` yet (pending cutover);
    // `sourcePath` stays canonical.
    source: buildSkillSourceForWrite({
      packageId,
      packageName: packageRecord.name,
      packageSlug: packageRecord.slug,
      sourcePath: skillFilePath,
      scope: isPersonal ? input.ownerUserId : undefined,
      isCustomSkill: isPersonal || undefined,
      content: input.content,
    }),
    usedBy: [],
    isCustom: true,
    isCustomSkill: isPersonal || undefined,
    ownerUserId: input.ownerUserId,
    agentId: input.agentId,
    level: input.type,
    // requireResourceAccess keys owner identity off `scope` for personal
    // skills; persist ownerUserId as the explicit scope so the read path no
    // longer has to rely on the legacy back-fill.
    scope: isPersonal ? input.ownerUserId : undefined,
    basedOnSkillId: input.basedOnSkillId ?? existingSkill?.basedOnSkillId,
    basedOnSkillIds: input.basedOnSkillIds ?? existingSkill?.basedOnSkillIds,
    prefillText: input.prefillText ?? existingSkill?.prefillText,
    // The per-skill Anthropic-upload flag is an admin-set
    // DB-only value. It is NEVER part of the upsert input (no caller / SKILL.md
    // may set it). Preserve an already admin-set `true` across this rewrite
    // (strict primitive; anything else → undefined = excluded, fail-closed).
    allowAnthropicUpload:
      (existingSkill as { allowAnthropicUpload?: unknown } | undefined)
        ?.allowAnthropicUpload === true
        ? true
        : undefined,
    updatedAt,
  };

  const nextCatalog = {
    skillPackages: sortCatalog([
      ...existingCatalog.skillPackages.filter((e) => e.id !== packageRecord.id),
      packageRecord,
    ]),
    skills: sortCatalog([
      ...existingCatalog.skills.filter((e) => e.id !== skillId),
      skillRecord,
    ]),
  };

  replaceSkillCatalogInDatabase({
    skillPackages: nextCatalog.skillPackages,
    skills: nextCatalog.skills,
  });

  // Write SKILL.md to disk so the local path is available to the LLM shell tool.
  await mkdir(skillDiskDir, { recursive: true });
  // Dangling-write-leaf confinement (#300): the realpath checks above use
  // existsSync (follows symlinks) so a pre-existing DANGLING symlink leaf would
  // slip through and `writeFile` would create the SKILL.md at the outside
  // target. lstat catches the dangling symlink; throw rather than write through.
  assertLeafNotSymlink(skillFilePath);
  await writeFile(skillFilePath, skillRecord.content, "utf8");
  commitSkillChange(`skill: save ${input.type} skill '${skillRecord.name}'`).catch(() => undefined);

  try { revalidatePath("/skills"); } catch { /* best-effort: non-RSC contexts (boot/instrumentation) lack the static-generation store */ }

  return skillRecord;
}

/** @deprecated Use upsertSkill({ type: "team", ... }) instead. */
export async function createSkillFromTemplate(input: {
  name: string;
  packageName: string;
  content: string;
  basedOnSkillId?: string;
}): Promise<PersistedSkill> {
  return upsertSkill({ type: "team", ...input });
}

const DEFAULT_CUSTOM_SKILL_PACKAGE_ID = "custom:personal-skills";
const DEFAULT_CUSTOM_SKILL_PACKAGE_NAME = "Custom Skills";

export async function upsertCustomSkill(input: {
  skillId?: string;
  ownerUserId?: string;
  agentId: string;
  name: string;
  description?: string;
  content: string;
  basedOnSkillId?: string;
  basedOnSkillIds?: string[];
  scope?: SkillLevel;
  /**
   * Ownership tier of the assignment row that backs
   * this skill. When provided alongside `ownerId`, an upsert is performed
   * against `custom_skill_assignments` keyed by (skill_id, agent_id).
   */
  ownerType?: "user" | "team" | "project" | "organization" | "workspace";
  ownerId?: string;
  createdBy?: string | null;
}): Promise<PersistedSkill> {
  // Drift guard: when the assignment is user-owned and the legacy
  // catalog `ownerUserId` is also set, both must agree. Catches accidental
  // drift between the two writes during refactors.
  if (
    input.ownerType === "user" &&
    input.ownerUserId !== undefined &&
    input.ownerId !== undefined &&
    input.ownerUserId !== input.ownerId
  ) {
    throw new Error(
      `custom-skill ownerUserId drift: payload=${input.ownerUserId} assignment=${input.ownerId}`,
    );
  }

  // For non-user ownership (team/org/project), the legacy catalog field
  // ownerUserId must NOT be set — clear it so we don't write a phantom
  // user-owner alongside the team/org assignment row.
  const catalogOwnerUserId =
    input.ownerType && input.ownerType !== "user" ? undefined : input.ownerUserId;

  // Ownership pre-check: when an update is requested (skillId supplied) and
  // the existing catalog row is a personal skill, refuse the write unless the
  // caller is the row's owner. Without this, a forged `skillId` from another
  // user could replace their personal skill body + reassign ownership to the
  // attacker via the catalog `ownerUserId` write path.
  //
  // Fail closed in three cases:
  //   1. ownerUserId set, doesn't match input.ownerUserId
  //   2. scope set, doesn't match input.ownerUserId (personal
  //      authz keys off scope; any present owner-identity field must match)
  //   3. NEITHER ownerUserId NOR scope set — the row has no owner identity
  //      we can verify against. Refuse the update rather than letting any
  //      authenticated user claim the row.
  if (input.skillId && input.ownerUserId) {
    const currentCatalog = await readSkillsCatalog();
    const existing = currentCatalog.skills.find((entry) => entry.id === input.skillId);
    if (existing && existing.level !== "personal") {
      // upsertCustomSkill is the personal-skill code path. A non-personal
      // row must NOT be reassigned through it — that would silently
      // downgrade the row's ownership level and let an authenticated user
      // claim a team/org/workspace/project skill via a forged form skillId.
      // The action layer should catch this before the call; the store gate
      // is defense-in-depth.
      throw new Error(
        `upsertCustomSkill: skill ${input.skillId} is level "${existing.level}", not personal — refusing update through personal-skill code path.`,
      );
    }
    if (existing && existing.level === "personal") {
      const ownerFields: Array<string | undefined | null> = [existing.ownerUserId, existing.scope];
      const presentOwners = ownerFields.filter(
        (v): v is string => typeof v === "string" && v.length > 0,
      );
      if (presentOwners.length === 0) {
        throw new Error(
          `upsertCustomSkill: personal skill ${input.skillId} has no owner identity — refusing to update.`,
        );
      }
      if (presentOwners.some((owner) => owner !== input.ownerUserId)) {
        throw new Error(
          `upsertCustomSkill: caller ${input.ownerUserId} is not the owner of personal skill ${input.skillId}.`,
        );
      }
    }
  }

  const skillRecord = await upsertSkill({
    type: input.scope ?? "personal",
    packageName: DEFAULT_CUSTOM_SKILL_PACKAGE_NAME,
    skillId: input.skillId,
    ownerUserId: catalogOwnerUserId,
    agentId: input.agentId,
    name: input.name,
    description: input.description,
    content: input.content,
    basedOnSkillId: input.basedOnSkillId,
    basedOnSkillIds: input.basedOnSkillIds,
  });

  // Write the ownership-scoped assignment row.
  if (input.ownerType && input.ownerId) {
    const { upsertCustomSkillAssignment } = await import("@/lib/database");
    upsertCustomSkillAssignment({
      skillId: skillRecord.id,
      agentId: input.agentId,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      createdBy: input.createdBy ?? input.ownerUserId ?? null,
    });
  }

  return skillRecord;
}

/** @deprecated Use upsertCustomSkill instead. */
export const upsertPersonalSkill = upsertCustomSkill;

/**
 * Read the raw content of a skill SKILL.md from disk.
 *
 * Catalog-only resolution. The path MUST resolve
 * inside the configured skills data directory. Callers register
 * the extension SKILL.md into the catalog first via `registerExtensionSkill`,
 * which mirrors the file into `data/skills/...` and returns a `sourcePath`
 * already inside the default root.
 *
 * Path traversal is rejected: `path.resolve` normalizes the input and the
 * prefix check uses `root + path.sep` so a `<root>foo` sibling cannot
 * satisfy the containment.
 */
/**
 * Realpath the nearest EXISTING ancestor of `target` (#300 symlink-containment
 * support). Realpath of a not-yet-created leaf throws (`ENOENT`), so we walk up
 * until a path that exists is found and canonicalize THAT — the missing
 * trailing segments cannot themselves be a symlink (they don't exist), so the
 * realpath'd ancestor is the correct containment anchor. Falls back to the
 * lexical resolve at the filesystem root (defensive; the root always exists).
 */
function realpathNearestExisting(target: string): string {
  let current = path.resolve(target);
  for (;;) {
    if (existsSync(current)) {
      return realpathSync.native(current);
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }
}

/**
 * Realpath-containment re-assertion (#300). After the lexical resolve+prefix
 * check confirms `resolved` is lexically inside one of the allowed roots, this
 * canonicalizes the root and the target (via the nearest existing ancestor for
 * not-yet-created leaves) and re-checks containment on the REAL paths. A
 * symlinked ancestor under a root passes the lexical check but resolves OUT of
 * it — this layer rejects that. Behavior is identical for legitimate
 * non-symlink and not-yet-created paths (realpath is a no-op on those).
 */
export function isRealpathContained(resolved: string, root: string): boolean {
  const realRoot = realpathNearestExisting(root);
  const realTarget = realpathNearestExisting(resolved);
  return realTarget === realRoot || realTarget.startsWith(realRoot + path.sep);
}

/**
 * File-LEAF realpath confinement (the next layer beyond #300's directory
 * containment). `assertSkillDirectoryInsideRoot` confines a scan/repository
 * BASE directory, but a confined directory can still hold a FILE that is a
 * symlink to outside — e.g. `<repositoryPath>/README.md -> /outside/secret`, or
 * a discovered `<skillDir>/SKILL.md` symlinked out — and a `readFileSync` would
 * follow it. Before reading any content file rooted on an already-confined base
 * dir, assert the file's REAL path stays inside the REAL base dir. A
 * non-existent file is already skipped by its own `existsSync` gate, so this
 * only confines existing leaves (and realpath is a no-op on non-symlink files,
 * keeping behavior identical for legitimate layouts). Returns `false` on a
 * symlink escape so the caller skips the read instead of exfiltrating an
 * arbitrary local file.
 */
function isFileLeafContainedInDir(baseDir: string, filePath: string): boolean {
  return isRealpathContained(path.resolve(filePath), path.resolve(baseDir));
}

/**
 * Dangling-write-leaf confinement (#300). The directory + leaf realpath checks
 * above use `existsSync`, which FOLLOWS symlinks: a leaf that is a DANGLING
 * symlink (the symlink file pre-exists but its target does NOT) makes
 * `existsSync` return false, so the realpath checks treat it as an absent /
 * not-yet-created leaf and pass — then `writeFile` follows the dangling symlink
 * and CREATES the file at the OUTSIDE target. `lstatSync` does NOT follow the
 * symlink, so it catches the dangling case. Call this immediately before any
 * write whose leaf was only confined via `existsSync`/nearest-ancestor realpath.
 * ENOENT (no leaf at all) → genuinely new file, proceed. A regular file →
 * proceed (the dir is already realpath-confined and overwriting a regular file
 * stays inside). A symlink (dangling or live) → throw, refusing to write
 * through it. Behavior is identical for legitimate new-file and regular-file
 * writes (lstat is a no-op decision on those).
 */
function assertLeafNotSymlink(leafPath: string): void {
  let stats;
  try {
    stats = lstatSync(leafPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return; // genuinely new file — safe to create
    }
    throw err;
  }
  if (stats.isSymbolicLink()) {
    throw new Error(
      `Skill write path leaf is a symlink; refusing to write through it: ${leafPath}`,
    );
  }
}

/**
 * Strict-containment guard for any direct read of a stored skill `sourcePath`.
 * Callers that read raw bytes (e.g. the Anthropic sync uploader needs a Buffer
 * via `fs.readFile(p)` — not a UTF-8 string) MUST run this first so a
 * payload-injected or stale stored `sourcePath` pointing outside the configured
 * skill roots cannot exfiltrate arbitrary local files. `readSkillFileContent`
 * and `readSkillContent` already use it internally.
 *
 * Accepts EITHER the new content-store root (`data/skill-store`,
 * canonical for new writes) OR the legacy `data/skills` root (compat fallback
 * — legacy rows' sourcePath stays valid until the store migration migrates
 * them). Out-of-both-roots → reject.
 */
export function assertSkillFilePathInsideRoot(filePath: string): void {
  const storeRoot = path.resolve(getSkillStoreRootPath());
  const legacyRoot = path.resolve(getSkillsDataRootPath());
  const resolved = path.resolve(filePath);
  // Layer 1 — lexical containment (KEEP; defense in depth).
  const insideStore =
    resolved === storeRoot || resolved.startsWith(storeRoot + path.sep);
  const insideLegacy =
    resolved === legacyRoot || resolved.startsWith(legacyRoot + path.sep);
  if (!insideStore && !insideLegacy) {
    throw new Error("Skill file path is outside the allowed skill roots.");
  }
  // Layer 2 — realpath containment (#300). A symlinked ANCESTOR under either
  // root passes the lexical prefix check but the real path escapes the root.
  // Re-assert against the canonicalized root(s) the target lexically matched.
  const realpathInsideStore = insideStore && isRealpathContained(resolved, storeRoot);
  const realpathInsideLegacy = insideLegacy && isRealpathContained(resolved, legacyRoot);
  if (!realpathInsideStore && !realpathInsideLegacy) {
    throw new Error("Skill file path is outside the allowed skill roots.");
  }
}

/**
 * Directory-path containment barrier (js/path-injection, code-scanning).
 *
 * Fail-closed confinement for a repository/scan BASE directory before any
 * filesystem read (`existsSync`/`readdirSync`/`readFileSync`) walks it. Two
 * layers, mirroring the #291 write-side guard in `upsertSkill`:
 *   1. Reject any `.`/`..` traversal segment in the supplied directory so a
 *      `..` baked into a leaf (e.g. the verdaccio installDir version segment,
 *      which is not slugified, or a slugify that preserves `.`) cannot escape.
 *   2. Resolve and require the directory inside EITHER the canonical skill
 *      store root OR the legacy `data/skills` root (the two roots every current
 *      caller already lands in), throwing otherwise.
 *
 * Returns the resolved, confined path so callers feed the sanitizer-normalized
 * value into the sink (CodeQL tracks the barrier output, breaking the flow).
 */
export function assertSkillDirectoryInsideRoot(directoryPath: string): string {
  if (directoryPath.split(/[/\\]/).some((part) => part === ".." || part === ".")) {
    throw new Error("Skill directory path contains a traversal segment.");
  }
  const storeRoot = path.resolve(getSkillStoreRootPath());
  const legacyRoot = path.resolve(getSkillsDataRootPath());
  const resolved = path.resolve(directoryPath);
  // Layer 2 — lexical containment (KEEP; defense in depth).
  const insideStore =
    resolved === storeRoot || resolved.startsWith(storeRoot + path.sep);
  const insideLegacy =
    resolved === legacyRoot || resolved.startsWith(legacyRoot + path.sep);
  if (!insideStore && !insideLegacy) {
    throw new Error("Skill directory path is outside the allowed skill roots.");
  }
  // Layer 3 — realpath containment (#300). A symlinked ANCESTOR under either
  // root passes the lexical prefix check but resolves OUT of the root via the
  // link target. Re-assert against the canonicalized root(s) the target
  // lexically matched (nearest-existing-ancestor realpath handles a not-yet-
  // created leaf without throwing).
  const realpathInsideStore = insideStore && isRealpathContained(resolved, storeRoot);
  const realpathInsideLegacy = insideLegacy && isRealpathContained(resolved, legacyRoot);
  if (!realpathInsideStore && !realpathInsideLegacy) {
    throw new Error("Skill directory path is outside the allowed skill roots.");
  }
  return resolved;
}

export async function readSkillFileContent(filePath: string): Promise<string> {
  const { readFile } = await import("fs/promises");
  assertSkillFilePathInsideRoot(filePath);
  return readFile(path.resolve(filePath), "utf8");
}

/**
 * SkillSource-aware content read. The caller passes a
 * skill row; the resolver determines the source descriptor (for observability +
 * future physical resolution) and the strict-containment file read happens
 * through `readSkillFileContent`. While `data/skills` remains the canonical
 * physical mirror, the physical anchor is the legacy `sourcePath`;
 * once content moves into the generalized store this entry-point will
 * resolve via `source.relativePath` against the store root.
 *
 * Critically: routes a direct `existsSync + readFileSync(skill.sourcePath)`
 * read path through the same containment check as `readSkillFileContent`,
 * closing a path-traversal hole in callers that read a skill row's stored
 * `sourcePath` without validation.
 *
 * Fails LOUD on rows that cannot physically resolve (no sourcePath AND no
 * legacy fallback) — content readers must never guess.
 */
export async function readSkillContent(skill: {
  sourcePath?: string;
  source?: SkillSource | null;
  packageId?: string;
  packageName?: string;
  packageSlug?: string;
  sourceUrl?: string;
  originRepo?: string;
  scope?: string;
  isCustom?: boolean;
  isCustomSkill?: boolean;
}): Promise<string> {
  // Consult SkillSource for observability / origin classification; the read
  // itself still anchors on sourcePath (legacy mirror is canonical).
  // A later cutover will switch this to resolve through the generalized store using
  // `source.relativePath` + the store root, with `sourcePath` as the fallback.
  const source = resolveSkillSource(skill);
  if (!skill.sourcePath) {
    const origin = source?.origin ?? "unknown";
    throw new Error(
      `Skill content cannot be read: no sourcePath and digest/relativePath-only resolution is not yet wired (origin=${origin}). ` +
        `This will become reachable when the generalized content store is primary.`,
    );
  }
  return readSkillFileContent(skill.sourcePath);
}

export async function listCustomSkills(ownerUserId?: string) {
  const catalog = await readSkillsCatalog();
  return catalog.skills.filter((skill) => skill.isCustomSkill === true && (!ownerUserId || skill.ownerUserId === ownerUserId));
}

/** @deprecated Use listCustomSkills instead. */
export const listPersonalSkills = listCustomSkills;

export async function getCustomSkillById(input: { ownerUserId: string; skillId: string }) {
  const catalog = await readSkillsCatalog();
  return (
    catalog.skills.find(
      (skill) => skill.isCustomSkill === true && skill.ownerUserId === input.ownerUserId && skill.id === input.skillId,
    ) ?? null
  );
}

/** @deprecated Use getCustomSkillById instead. */
export const getPersonalSkillById = getCustomSkillById;

export async function getCustomSkillForAgent(input: { ownerUserId: string; agentId: string }) {
  const catalog = await readSkillsCatalog();
  return (
    catalog.skills.find(
      (skill) => skill.isCustomSkill === true && skill.ownerUserId === input.ownerUserId && skill.agentId === input.agentId,
    ) ?? null
  );
}

/** @deprecated Use getCustomSkillForAgent instead. */
export const getPersonalSkillForAgent = getCustomSkillForAgent;

export async function listCustomSkillsForAgent(input: { ownerUserId: string; agentId: string }) {
  const catalog = await readSkillsCatalog();
  return catalog.skills.filter(
    (skill) => skill.isCustomSkill === true && skill.ownerUserId === input.ownerUserId && skill.agentId === input.agentId,
  );
}

/** @deprecated Use listCustomSkillsForAgent instead. */
export const listPersonalSkillsForAgent = listCustomSkillsForAgent;

export async function deleteCustomSkill(input: {
  ownerUserId: string;
  skillId: string;
  // Optional actor scope used to authorize deletion of
  // team/org/project-owned skills (catalog ownerUserId is null for those).
  actor?: {
    principalId: string;
    teamIds?: string[];
    projectIds?: string[];
    organizationId?: string;
  };
}) {
  const catalog = await readSkillsCatalog();
  let existingSkill = catalog.skills.find(
    (skill) => skill.isCustomSkill === true && skill.ownerUserId === input.ownerUserId && skill.id === input.skillId,
  );

  // When the catalog lookup misses, the skill may be a
  // non-user-owned (team/org/project) custom skill whose catalog row has
  // ownerUserId === undefined. Look up the assignment row by skill_id alone
  // and authorize the actor against (owner_type, owner_id). Without this
  // path, both the catalog row and the assignment row leak forever.
  if (!existingSkill) {
    const fallback = catalog.skills.find(
      (skill) => skill.isCustomSkill === true && skill.id === input.skillId,
    );
    if (!fallback) return false;

    const actor = input.actor;
    const teamIds = new Set(actor?.teamIds ?? []);
    const projectIds = new Set(actor?.projectIds ?? []);
    const orgId = actor?.organizationId ?? "";
    const principalId = actor?.principalId ?? input.ownerUserId;

    // Authorize via the assignment row when one exists for this skill+agent.
    if (fallback.agentId) {
      try {
        const { readCustomSkillAssignmentsForAgent } = await import("@/lib/database");
        const rows = readCustomSkillAssignmentsForAgent(fallback.agentId, {
          principalId,
          teamIds: actor?.teamIds ?? [],
          projectIds: actor?.projectIds ?? [],
          organizationId: orgId,
        });
        const match = rows.find((r) => r.skillId === input.skillId);
        if (!match) return false;
        // Defense-in-depth: confirm the actor really maps to the owner scope.
        const authorized =
          (match.ownerType === "user" && match.ownerId === principalId) ||
          (match.ownerType === "team" && teamIds.has(match.ownerId)) ||
          (match.ownerType === "project" && projectIds.has(match.ownerId)) ||
          (match.ownerType === "organization" && Boolean(orgId) && match.ownerId === orgId);
        if (!authorized) return false;
        existingSkill = fallback;
      } catch (err) {
        console.warn(
          `[skills-store] deleteCustomSkill assignment authz lookup failed (skill=${input.skillId}):`,
          err,
        );
        return false;
      }
    } else {
      return false;
    }
  }

  if (!existingSkill) {
    return false;
  }

  replaceSkillCatalogInDatabase({
    skillPackages: catalog.skillPackages,
    skills: catalog.skills.filter((skill) => skill.id !== input.skillId),
  });

  // Remove from disk — use stored sourcePath when available; fall back to
  // legacy path convention for skills written before sourcePath was recorded.
  const skillDiskDir = existingSkill.sourcePath
    ? path.dirname(existingSkill.sourcePath)
    : existingSkill.ownerUserId
      ? path.join(getSkillsDataRootPath(), "personal", existingSkill.ownerUserId, existingSkill.slug)
      : null;
  // Confine the derived directory (lexical + realpath, #300) before `rm`. The
  // `sourcePath` branch derives `dirname(<stored sourcePath>)`, so a
  // payload-injected/stale stored path — or one whose real path escapes via a
  // symlinked ancestor — must not have `rm` delete an arbitrary directory.
  // Custom skills write under the store root (`upsertSkill`); the legacy
  // fallback lands under the skills data root. Require the dir STRICTLY inside
  // EITHER root (root-equality excluded by `startsWith(root + sep)`, so the
  // root itself or its parent is never deleted) AND realpath-confined.
  if (skillDiskDir) {
    const resolvedSkillDiskDir = path.resolve(skillDiskDir);
    const storeRoot = path.resolve(getSkillStoreRootPath());
    const legacyRoot = path.resolve(getSkillsDataRootPath());
    const insideStore =
      resolvedSkillDiskDir.startsWith(storeRoot + path.sep) &&
      isRealpathContained(resolvedSkillDiskDir, storeRoot);
    const insideLegacy =
      resolvedSkillDiskDir.startsWith(legacyRoot + path.sep) &&
      isRealpathContained(resolvedSkillDiskDir, legacyRoot);
    if (insideStore || insideLegacy) {
      await rm(resolvedSkillDiskDir, { recursive: true, force: true });
    }
  }
  commitSkillChange(`skill: delete '${input.skillId}'`).catch(() => undefined);

  // Cascade delete the assignment row in the
  // same logical operation. There is no FK CASCADE; the application owns
  // the cascade. Idempotent: if the row is already gone, the helper is a
  // no-op. Errors are logged but do not throw — the catalog row is already
  // deleted at this point and a stale assignment row would be cleaned up by
  // the next backfill run.
  if (existingSkill.agentId) {
    try {
      const { deleteCustomSkillAssignment } = await import("@/lib/database");
      deleteCustomSkillAssignment(input.skillId, existingSkill.agentId);
    } catch (error) {
      console.warn(
        `[skills-store] deleteCustomSkillAssignment failed (skill=${input.skillId}, agent=${existingSkill.agentId}):`,
        error,
      );
    }
  }

  try { revalidatePath("/skills"); } catch { /* best-effort: non-RSC contexts (boot/instrumentation) lack the static-generation store */ }

  return true;
}

/** @deprecated Use deleteCustomSkill instead. */
export const deletePersonalSkill = deleteCustomSkill;

export async function upsertRepositoryBackedSkillPackage(input: {
  packageId: string;
  /**
   * Optional prefix for the
   * COMPOSED catalog skill ID (`<prefix>:<slug>`), separated from the
   * package row identity (`skill_packages.id = packageId`).
   *
   * - GitHub backend: omit → defaults to packageId (`github:owner/repo`),
   *   preserving the established `github:owner/repo:slug` consumer ref shape.
   * - Verdaccio backend: pass the bare `<scope>/<pkg>` (e.g.
   *   `@anthropics/skills`) so the catalog ID matches the consumer ref
   *   (e.g. author-agent's SKILL.md references `@anthropics/skills:skill-creator`)
   *   without leaking the internal `verdaccio:` row-id prefix.
   *
   * The `packageId` itself remains the row identifier in skill_packages so
   * lifecycle install/archive/restore/uninstall keep flipping the same row.
   */
  catalogSkillIdPrefix?: string;
  name: string;
  slug: string;
  description: string;
  repositoryUrl: string;
  repositoryPath: string;
  sourceUrl?: string;
  license?: string;
  authors?: string[];
}) {
  const existingCatalog = await readSkillsCatalog();

  // Fail-closed containment barrier (js/path-injection). Confine the
  // user/LLM-triggered `input.repositoryPath` (github targetDirectory or
  // verdaccio installDir) to the allowed skill roots BEFORE any fs read. The
  // github caller is already guarded by isSafeOwnerAndRepo (#291); the
  // verdaccio installDir leaf segments are weakly sanitized, and this function
  // had no self-contained guard — so assert here. Using the resolved value for
  // the README/LICENSE joins and the directory scan feeds the barrier output
  // into every existsSync/readFileSync sink (covers the README/LICENSE probes
  // and, via collectSkillDirectories, the per-skill SKILL.md reads).
  const repositoryPath = assertSkillDirectoryInsideRoot(input.repositoryPath);
  const readmePath = path.join(repositoryPath, "README.md");
  const licensePath = path.join(repositoryPath, "LICENSE");

  const packageRecord: PersistedSkillPackage = {
    id: input.packageId,
    packageId: input.packageId,
    name: input.name,
    slug: input.slug,
    description: input.description,
    sourceUrl: input.sourceUrl ?? input.repositoryUrl,
    repositoryUrl: input.repositoryUrl,
    repositoryPath: input.repositoryPath,
    // Leaf confinement (file-symlink escape): `repositoryPath` is confined to
    // the skill roots above, but README/LICENSE inside it could be a SYMLINK to
    // an outside file that `readFileSync` would follow. Skip the read when the
    // real file escapes the real repository directory.
    readmeContent:
      existsSync(readmePath) && isFileLeafContainedInDir(repositoryPath, readmePath)
        ? readFileSync(readmePath, "utf8")
        : undefined,
    license: input.license,
    licenseText:
      existsSync(licensePath) && isFileLeafContainedInDir(repositoryPath, licensePath)
        ? readFileSync(licensePath, "utf8")
        : undefined,
    authors: input.authors,
    isCustom: true,
  };

  // The per-skill Anthropic-upload flag is admin-set,
  // DB-only, and NEVER from the repo/SKILL.md. A package reinstall replaces all
  // of this package's skill rows with freshly scanned ones (which never carry
  // the flag), so without this preservation a reinstall would silently clobber
  // an admin's `allowAnthropicUpload=true` back to excluded. Carry only the
  // strict primitive `true` forward (fail-closed otherwise).
  const preservedAnthropicUploadSkillIds = new Set<string>();
  for (const entry of existingCatalog.skills) {
    if (
      entry.packageId === input.packageId &&
      (entry as { allowAnthropicUpload?: unknown }).allowAnthropicUpload === true &&
      typeof entry.id === "string"
    ) {
      preservedAnthropicUploadSkillIds.add(entry.id);
    }
  }

  // The catalog skill ID prefix defaults to packageId for backward-compat with
  // the GitHub backend (which
  // surfaces skills as `github:owner/repo:slug` — consumers reference WITH
  // the github: prefix). The Verdaccio backend passes the bare packageName
  // so the catalog ID matches the consumer ref shape (e.g.
  // `@anthropics/skills:skill-creator`) instead of `verdaccio:@anthropics/skills:skill-creator`.
  const catalogIdPrefix = input.catalogSkillIdPrefix ?? input.packageId;
  const discoveredSkills = collectSkillDirectories(repositoryPath);
  const scannedSkills: PersistedSkill[] = discoveredSkills.map((discoveredSkill) => {
    const content = readFileSync(discoveredSkill.skillFilePath, "utf8");
    const { attributes } = parseFrontmatter(content);
    const name = attributes.name
      ? String(attributes.name)
          .split("-")
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join(" ")
      : discoveredSkill.slug
          .split("-")
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join(" ");
    const description = attributes.description || `${name} skill from ${input.name}.`;

    return {
      id: `${catalogIdPrefix}:${discoveredSkill.slug}`,
      name,
      slug: discoveredSkill.slug,
      description,
      content,
      packageId: input.packageId,
      packageName: input.name,
      packageSlug: input.slug,
      sourceUrl: `${input.repositoryUrl}/tree/main/${discoveredSkill.relativeDirectoryPath}`,
      sourcePath: discoveredSkill.skillFilePath,
      usedBy: [],
      isCustom: true,
      // Preserve an already admin-set per-skill upload flag across reinstall.
      // Lookup uses the SAME catalogIdPrefix so the preservation finds the
      // existing row even after a backend swap.
      allowAnthropicUpload: preservedAnthropicUploadSkillIds.has(
        `${catalogIdPrefix}:${discoveredSkill.slug}`,
      )
        ? true
        : undefined,
    };
  });

  replaceSkillCatalogInDatabase({
    skillPackages: sortCatalog([
      ...existingCatalog.skillPackages.filter((entry) => entry.id !== input.packageId),
      packageRecord,
    ]),
    skills: sortCatalog([
      ...existingCatalog.skills.filter((entry) => entry.packageId !== input.packageId),
      ...scannedSkills,
    ]),
  });

  commitSkillChange(`skill: install package '${input.name}'`).catch(() => undefined);

  try { revalidatePath("/skills"); } catch { /* best-effort: non-RSC contexts (boot/instrumentation) lack the static-generation store */ }

  return {
    skillPackage: packageRecord,
    skills: scannedSkills,
  };
}

/**
 * Bulk-delete agent-level catalog rows whose
 * directory slug matches any of `slugs`. Removes each `level: "agent"`
 * row whose `id` starts with `custom:<slug>:` AND deletes the matching
 * on-disk directory under `data/skills/~agent/<slugifiedNpmName>/`
 * best-effort if it lives within the skills data root.
 *
 * Returns `{ deletedIds: string[] }`. Idempotent — calling with slugs
 * that produce no matching rows is a no-op.
 */
export async function deleteAgentSkillsForSlugs(
  slugs: string[],
): Promise<{ deletedIds: string[] }> {
  if (!Array.isArray(slugs) || slugs.length === 0) {
    return { deletedIds: [] };
  }

  // Validate slugs defensively — never trust caller-supplied paths.
  const safeSlugs = slugs.filter(
    (slug): slug is string =>
      typeof slug === "string" &&
      slug.length > 0 &&
      slug !== "." &&
      slug !== ".." &&
      !slug.includes("..") &&
      !slug.includes("/") &&
      !slug.includes("\\"),
  );

  if (safeSlugs.length === 0) {
    return { deletedIds: [] };
  }

  const slugify = (value: string) =>
    value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

  const slugifiedSet = new Set(safeSlugs.map((s) => slugify(s)));
  const idPrefixes = Array.from(slugifiedSet).map((s) => `custom:${s}:`);

  const catalog = await readSkillsCatalog();
  const deletedIds: string[] = [];

  const remainingSkills = catalog.skills.filter((skill) => {
    if (skill.level !== "agent") return true;
    const matchesPrefix = idPrefixes.some((prefix) => skill.id.startsWith(prefix));
    const matchesPackageSlug =
      typeof skill.packageSlug === "string" && slugifiedSet.has(skill.packageSlug);
    if (matchesPrefix || matchesPackageSlug) {
      deletedIds.push(skill.id);
      return false;
    }
    return true;
  });

  if (deletedIds.length > 0) {
    replaceSkillCatalogInDatabase({
      skillPackages: catalog.skillPackages,
      skills: remainingSkills,
    });
  }

  // Best-effort disk cleanup. Compute target directory as
  // <skillsDataRoot>/~agent/<slugifiedNpmName>/ and verify the resolved real
  // path stays within the skills data root before rm.
  const skillsRoot = path.resolve(getSkillsDataRootPath());
  for (const skill of catalog.skills) {
    if (skill.level !== "agent") continue;
    const matchesPrefix = idPrefixes.some((prefix) => skill.id.startsWith(prefix));
    const matchesPackageSlug =
      typeof skill.packageSlug === "string" && slugifiedSet.has(skill.packageSlug);
    if (!matchesPrefix && !matchesPackageSlug) continue;

    // skill.packageSlug holds the slugified npm name (e.g. "x-foo") that
    // upsertSkill writes for type:"agent" rows — the disk parent under
    // ~agent/. We delete the per-skill subdirectory here; the parent
    // ~agent/<slugifiedNpmName>/ is cleaned up below if it ends up empty.
    if (skill.sourcePath) {
      const resolvedSourcePath = path.resolve(skill.sourcePath);
      // Confine a STORED `sourcePath` before `rm` (#300). Two bugs the prior
      // lexical-only guard had:
      //   1. Root-equality: `resolvedSourcePath === skillsRoot` passed the
      //      guard, then `dirname(resolvedSourcePath)` is the root's PARENT —
      //      the `rm` would delete the directory ABOVE the skills root. Only a
      //      path STRICTLY inside the root may be deleted; the root itself (and
      //      thus its parent) is never a valid delete target.
      //   2. Symlinked ancestor: a `sourcePath` whose real path escapes the
      //      root via a symlinked ancestor passed `startsWith` but resolves
      //      OUT of the root. Re-assert realpath containment on the resolved
      //      sourcePath AND on the `skillDir` actually handed to `rm`.
      const strictlyInside =
        resolvedSourcePath !== skillsRoot &&
        resolvedSourcePath.startsWith(skillsRoot + path.sep) &&
        isRealpathContained(resolvedSourcePath, skillsRoot);
      if (strictlyInside) {
        const skillDir = path.dirname(resolvedSourcePath);
        // `dirname` of a strictly-inside path is at most the root itself; never
        // rm the root (would clobber the whole store). Require the dir to be
        // strictly inside and realpath-confined too.
        const skillDirStrictlyInside =
          skillDir !== skillsRoot &&
          skillDir.startsWith(skillsRoot + path.sep) &&
          isRealpathContained(skillDir, skillsRoot);
        if (skillDirStrictlyInside) {
          try {
            await rm(skillDir, { recursive: true, force: true });
          } catch {
            // best-effort
          }
        }
      }
    }
  }

  // After per-skill deletes, attempt to remove the now-empty
  // ~agent/<slugifiedNpmName>/ parents. Walk every catalog skill to find
  // unique parent dirs; this avoids hardcoding the slug shape.
  const seenParentDirs = new Set<string>();
  for (const skill of catalog.skills) {
    if (skill.level !== "agent") continue;
    if (!skill.sourcePath) continue;
    const matchesPrefix = idPrefixes.some((prefix) => skill.id.startsWith(prefix));
    const matchesPackageSlug =
      typeof skill.packageSlug === "string" && slugifiedSet.has(skill.packageSlug);
    if (!matchesPrefix && !matchesPackageSlug) continue;

    const resolvedSourcePath = path.resolve(skill.sourcePath);
    // Confine the STORED `sourcePath` (lexical + realpath, #300) before
    // deriving the parent dir to clean up. `startsWith(skillsRoot + sep)` also
    // excludes the root-equality case (the root itself never `startsWith`
    // root+sep), so the parent computed below can never be the root's parent.
    if (
      !resolvedSourcePath.startsWith(skillsRoot + path.sep) ||
      !isRealpathContained(resolvedSourcePath, skillsRoot)
    )
      continue;
    const parentDir = path.dirname(path.dirname(resolvedSourcePath));
    if (seenParentDirs.has(parentDir)) continue;
    seenParentDirs.add(parentDir);
    // `parentDir` (two levels up) must itself be STRICTLY inside the root and
    // realpath-confined before `readdirSync`/`rm` — a symlinked ancestor could
    // make the lexically-inside parent resolve OUT of the root. `startsWith`
    // (not `===`) keeps the root itself off the delete path.
    if (
      !parentDir.startsWith(skillsRoot + path.sep) ||
      !isRealpathContained(parentDir, skillsRoot)
    )
      continue;
    try {
      // Only remove if empty, to avoid clobbering siblings.
      const remaining = readdirSync(parentDir);
      if (remaining.length === 0) {
        await rm(parentDir, { recursive: true, force: true });
      }
    } catch {
      // best-effort
    }
  }

  if (deletedIds.length > 0) {
    try { revalidatePath("/skills"); } catch { /* best-effort: non-RSC contexts (boot/instrumentation) lack the static-generation store */ }
  }

  return { deletedIds };
}

export async function uninstallSkillPackage(packageId: string) {
  const existingCatalog = await readSkillsCatalog();
  const existingPackage = existingCatalog.skillPackages.find((p) => p.id === packageId);
  if (!existingPackage) return false;

  // Enumerate agent directory slugs under
  // <repositoryPath>/agents/ BEFORE removing the directory. Reading these
  // first preserves the slug list for the post-rm catalog cleanup.
  // Order matters: read slugs → rm dir → delete catalog rows → delete
  // agent-skill catalog rows by slug.
  let agentSlugsForCleanup: string[] = [];
  // Confine the STORED `repositoryPath` (lexical + realpath, #300) BEFORE the
  // readdir walks it. A payload-injected/stale stored path — or one whose real
  // path escapes the installed-packages root via a symlinked ancestor — must
  // not have `readdirSync` enumerate an arbitrary outside directory. The
  // installed-packages root is the same root the disk-removal `rm` confines to
  // below, so the read and the delete share one containment contract.
  const installedPackagesRoot = path.resolve(getInstalledPackagesDir());
  const resolvedRepositoryPath = existingPackage.repositoryPath
    ? path.resolve(existingPackage.repositoryPath)
    : null;
  const repositoryPathConfined =
    resolvedRepositoryPath !== null &&
    resolvedRepositoryPath.startsWith(installedPackagesRoot + path.sep) &&
    isRealpathContained(resolvedRepositoryPath, installedPackagesRoot);
  if (repositoryPathConfined && resolvedRepositoryPath) {
    const agentsDirPath = path.join(resolvedRepositoryPath, "agents");
    // Leaf confinement: `agents/` lexically lives in the confined repo dir, but
    // could itself be a symlink to an outside directory that `readdirSync`
    // would enumerate. Skip when the real `agents/` escapes the real repo dir.
    if (existsSync(agentsDirPath) && isFileLeafContainedInDir(resolvedRepositoryPath, agentsDirPath)) {
      try {
        agentSlugsForCleanup = readdirSync(agentsDirPath, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch {
        // best-effort
      }
    }
  }

  // Order DB work BEFORE disk removal.
  //
  // If disk removal runs before `replaceSkillCatalogInDatabase()` and the DB
  // work rolls back on a RESTRICT FK, the operator is left with the package
  // missing from disk but still present in the catalog (plus orphan co-owner
  // rows).
  //
  // Fix: (1) explicitly delete BOTH package-level and skill-level co-owners
  // (uninstall semantics — by user intent, all sharing for this package
  // goes away), (2) run the catalog rewrite which now succeeds, (3) THEN
  // remove the disk directory only after both DB ops committed.
  //
  // Also clear the per-skill co-owners. The
  // skill_co_owners.skill_id → skills(id) RESTRICT FK will otherwise block
  // the skill row deletes inside `replaceSkillCatalogInDatabase`.
  //
  // Also clear the polymorphic `extension_co_owners` +
  // `extension_access_policy` rows for this skill_package. The generic
  // permissions backend dual-writes to both the kind-specific tables AND the
  // polymorphic tables, so an uninstall must clean both sides — otherwise
  // orphan polymorphic rows remain and could re-apply if the same package_id
  // is later reinstalled.
  await removeAllSkillPackageCoOwners(packageId);
  await removeAllSkillCoOwnersForPackage(packageId);
  // Polymorphic cleanup for BOTH the skill_package row AND every child
  // skill row. With no FK on resource_id, any cleanup failure silently leaves
  // orphan rows that re-apply grants on later reinstall. Per-skill cleanup
  // runs BEFORE the catalog rewrite and package-level cleanup AFTER, paired
  // with the catalog row going away. Both are fatal — if they fail, the whole
  // uninstall must roll back rather than silently produce an inconsistent
  // permissions footprint.
  await removeAllPolymorphicSkillPermissionsForPackage(packageId);
  const { deleteExtensionPermissions } = await import("@cinatra-ai/extensions/permissions-store");
  await deleteExtensionPermissions("skill_package", packageId);

  replaceSkillCatalogInDatabase({
    skillPackages: existingCatalog.skillPackages.filter((p) => p.id !== packageId),
    skills: existingCatalog.skills.filter((s) => s.packageId !== packageId),
  });

  // Remove from disk if it lives in the skills data directory. Reuse the
  // single lexical+realpath containment computed for the agents read above
  // (#300): `repositoryPathConfined` already requires the stored path to be
  // STRICTLY inside the installed-packages root (root-equality excluded by
  // `startsWith(root + sep)`) AND realpath-confined, so a symlinked-ancestor
  // escape can never reach this `rm`.
  if (repositoryPathConfined && resolvedRepositoryPath) {
    await rm(resolvedRepositoryPath, { recursive: true, force: true });
  }

  // Now remove any level:"agent" rows that were registered for the agent
  // dirs we just deleted (the register-on-install path pairs with this).
  if (agentSlugsForCleanup.length > 0) {
    try {
      await deleteAgentSkillsForSlugs(agentSlugsForCleanup);
    } catch (err) {
      console.warn(
        `[skills-store] deleteAgentSkillsForSlugs failed for ${packageId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  commitSkillChange(`skill: uninstall package '${packageId}'`).catch(() => undefined);

  try { revalidatePath("/skills"); } catch { /* best-effort: non-RSC contexts (boot/instrumentation) lack the static-generation store */ }
  return true;
}

// ---------------------------------------------------------------------------
// updateSkillVisibility — write AgentAuthPolicyVisibility back to (level, scope)
// ---------------------------------------------------------------------------

/**
 * Maps an AgentAuthPolicyVisibility token to the (level, scope) columns used
 * by the persisted skill catalog. Lossless round-trip for the supported
 * variant set.
 */
function visibilityToLevelScope(
  visibility: string,
  ownerUserId: string | undefined,
): { level: SkillLevel; scope: string | undefined } {
  if (visibility === "owner") return { level: "personal", scope: ownerUserId };
  if (visibility === "org" || visibility.startsWith("org:")) {
    return { level: "organization", scope: "org" };
  }
  if (visibility.startsWith("team:")) {
    return { level: "team", scope: visibility.slice("team:".length) };
  }
  if (visibility.startsWith("project:")) {
    return { level: "project", scope: visibility.slice("project:".length) };
  }
  if (visibility === "workspace") return { level: "workspace", scope: undefined };
  if (visibility === "admin") return { level: "system", scope: undefined };
  // Fallback — keep personal
  return { level: "personal", scope: ownerUserId };
}

/**
 * Persist an access-policy change for an installed skill.
 * Only updates level + scope; all other fields are preserved.
 */
export async function updateSkillVisibility(
  skillId: string,
  visibility: string,
): Promise<void> {
  const existingCatalog = await readSkillsCatalog();
  const existing = existingCatalog.skills.find((s) => s.id === skillId);
  if (!existing) return;

  const { level, scope } = visibilityToLevelScope(visibility, existing.ownerUserId);
  const updated: PersistedSkill = { ...existing, level, scope };

  replaceSkillCatalogInDatabase({
    skillPackages: existingCatalog.skillPackages,
    skills: [
      ...existingCatalog.skills.filter((s) => s.id !== skillId),
      updated,
    ],
  });

  commitSkillChange(`skill: update visibility for '${existing.name}' → ${visibility}`).catch(
    () => undefined,
  );
  try { revalidatePath("/skills"); } catch { /* best-effort: non-RSC contexts (boot/instrumentation) lack the static-generation store */ }
}

// ---------------------------------------------------------------------------
// resolveCustomSkillOwner
// ---------------------------------------------------------------------------

// `'workspace'` is a LIVE tier ("Workspace: All" = every workspace user).
// `resolveCustomSkillOwner` never returns it today (workspace agents fall
// through to user); kept in the union so a future implementation does not
// require a TS-level type change in every consumer.
export type CustomSkillResolvedOwner =
  | { ownerType: "user"; ownerId: string }
  | { ownerType: "team"; ownerId: string }
  | { ownerType: "project"; ownerId: string }
  | { ownerType: "organization"; ownerId: string }
  | { ownerType: "workspace"; ownerId: string };

/**
 * Resolve the (ownerType, ownerId) pair to write for a custom_skill_assignments
 * row.
 *
 * Precedence (most-specific-to-the-run wins):
 *   1. project — `run.projectId` is set (project-scoped run). Most specific.
 *   2. team    — agent is team-owned (`agent.ownerTeamId`). Owner-scope of
 *                the agent itself.
 *   3. organization — agent is org-owned (`agent.ownerOrganizationId`).
 *   4. user    — fallback to the actor's `principalId`.
 *
 * The contextual rules are per-case, not strict precedence. When
 * multiple rules apply (e.g. team-owned agent invoked inside a project run),
 * we prefer the rule most specific to the *run*: project beats team beats
 * organization beats user. This matches the read-side filter in
 * `getAssignedSkillIdsForAgent` which unions all four scopes additively.
 *
 * Workspace branch is not returned today even when only
 * `ownerWorkspaceId` is set on the agent — falls through to user. The
 * `'workspace'` enum value exists in the Postgres enum but is never written.
 */
/**
 * Placeholder until team/org/workspace ownership is available on
 * `PersistedAgent`.
 *
 * Today, agent rows in `agent_templates` (and the in-memory `PersistedAgent`
 * shape in `src/lib/agents-store.ts`) do NOT carry `ownerTeamId`,
 * `ownerOrganizationId`, or `ownerWorkspaceId` columns/fields. As a result,
 * call sites that pass `agent` into `resolveCustomSkillOwner` always fall
 * through to user scope.
 *
 * This helper centralizes that placeholder so the call sites stop using
 * `as { ownerTeamId?: string; ... }` casts on a type that does not have
 * those fields. When team/org agent ownership is available, replace the empty
 * returns here with real reads from the agent record — every call site will
 * pick up the change automatically.
 */
export function getAgentOwnership(
  _agent: unknown,
): { ownerTeamId?: string; ownerOrganizationId?: string; ownerWorkspaceId?: string } {
  return {};
}

export function resolveCustomSkillOwner(args: {
  actor: {
    principalType?: string;
    principalId: string;
  };
  agent: {
    ownerTeamId?: string;
    ownerOrganizationId?: string;
    ownerWorkspaceId?: string;
  };
  run?: { projectId?: string } | undefined;
}): CustomSkillResolvedOwner {
  const { actor, agent, run } = args;
  if (run?.projectId) {
    return { ownerType: "project", ownerId: run.projectId };
  }
  if (agent.ownerTeamId) {
    return { ownerType: "team", ownerId: agent.ownerTeamId };
  }
  if (agent.ownerOrganizationId) {
    return { ownerType: "organization", ownerId: agent.ownerOrganizationId };
  }
  if (!actor.principalId) {
    throw new Error("resolveCustomSkillOwner: no resolvable owner (missing actor.principalId)");
  }
  return { ownerType: "user", ownerId: actor.principalId };
}

// ---------------------------------------------------------------------------
// Extension lifecycle helpers
// ---------------------------------------------------------------------------
//
// updateSkillPackageLifecycleStatus is removed. The
// skill_packages.extension_lifecycle_status column is not used; skill
// archive/restore is owned canonically by the dispatcher
// (syncCanonicalManifestTransition writes installed_extension). The skill
// extension-handler's archive is a no-op; restore re-runs agent matching.

// ---------------------------------------------------------------------------
// Skill-package access policy + co-owner store helpers.
//
// Storage shape:
//   - accessPolicy lives inside skill_packages.payload (PersistedSkillPackage
//     JSON blob), reusing the existing JSON storage pattern so no DB column
//     migration is needed for the policy itself.
//   - co-owner rows live in the dedicated cinatra.skill_package_co_owners
//     table (added in src/lib/drizzle-store.ts), mirroring the run_co_owners
//     table for agent runs. The table is the only persisted state for
//     ownership — the PersistedSkillPackage.installedByUserId column is just
//     a denormalized primary-owner pointer.
// ---------------------------------------------------------------------------

import type { AgentAuthPolicy as SkillPackageAuthPolicy } from "@cinatra-ai/agents/auth-policy";

export type SkillPackageCoOwnerRow = {
  packageId: string;
  userId: string;
  grantedBy: string;
  grantedAt: Date;
};

export async function readSkillPackageAccessPolicy(
  packageId: string,
): Promise<SkillPackageAuthPolicy | null> {
  const catalog = await readSkillsCatalog();
  const pkg = catalog.skillPackages.find((p) => p.packageId === packageId || p.id === packageId);
  return pkg?.accessPolicy ?? null;
}

export async function writeSkillPackageAccessPolicy(
  packageId: string,
  policy: SkillPackageAuthPolicy | null,
): Promise<{ ok: boolean }> {
  const catalog = await readSkillsCatalog();
  const idx = catalog.skillPackages.findIndex(
    (p) => p.packageId === packageId || p.id === packageId,
  );
  if (idx < 0) return { ok: false };
  const updated: PersistedSkillPackage = {
    ...catalog.skillPackages[idx]!,
    accessPolicy: policy,
  };
  const next = [...catalog.skillPackages];
  next[idx] = updated;
  replaceSkillCatalogInDatabase({
    skillPackages: next,
    skills: catalog.skills,
  });
  return { ok: true };
}

export async function readSkillPackageInstalledBy(
  packageId: string,
): Promise<string | null> {
  const catalog = await readSkillsCatalog();
  const pkg = catalog.skillPackages.find((p) => p.packageId === packageId || p.id === packageId);
  return pkg?.installedByUserId ?? null;
}

export async function readSkillPackageCoOwners(
  packageId: string,
): Promise<SkillPackageCoOwnerRow[]> {
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  const [result] = runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `SELECT package_id, user_id, granted_by, granted_at
               FROM "${schema.replaceAll('"', '""')}"."skill_package_co_owners"
               WHERE package_id = $1
               ORDER BY granted_at ASC`,
        values: [packageId],
      },
    ],
  });
  type Row = { package_id: string; user_id: string; granted_by: string; granted_at: string | Date };
  const rows = (result?.rows ?? []) as Row[];
  return rows.map((r) => ({
    packageId: r.package_id,
    userId: r.user_id,
    grantedBy: r.granted_by,
    grantedAt: r.granted_at instanceof Date ? r.granted_at : new Date(r.granted_at),
  }));
}

export async function addSkillPackageCoOwner(
  packageId: string,
  userId: string,
  grantedBy: string,
): Promise<{ ok: boolean }> {
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `INSERT INTO "${schema.replaceAll('"', '""')}"."skill_package_co_owners"
                 (package_id, user_id, granted_by)
               VALUES ($1, $2, $3)
               ON CONFLICT (package_id, user_id) DO NOTHING`,
        values: [packageId, userId, grantedBy],
      },
    ],
  });
  return { ok: true };
}

export async function removeSkillPackageCoOwner(
  packageId: string,
  userId: string,
): Promise<{ ok: boolean }> {
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `DELETE FROM "${schema.replaceAll('"', '""')}"."skill_package_co_owners"
               WHERE package_id = $1 AND user_id = $2`,
        values: [packageId, userId],
      },
    ],
  });
  return { ok: true };
}

/**
 * Remove ALL co-owner rows for a package.
 *
 * Used by `uninstallSkillPackage()` to explicitly clean up the sibling
 * `skill_package_co_owners` rows BEFORE the catalog's package row is
 * deleted by `replaceSkillCatalogInDatabase()`. The FK changed from
 * CASCADE to RESTRICT (so the catalog rewrite no longer silently wipes
 * co-owners), and explicit uninstall — by user intent — should also clear
 * the sharing entries.
 */
export async function removeAllSkillPackageCoOwners(packageId: string): Promise<void> {
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `DELETE FROM "${schema.replaceAll('"', '""')}"."skill_package_co_owners"
               WHERE package_id = $1`,
        values: [packageId],
      },
    ],
  });
}

/**
 * Remove ALL skill-level co-owner rows for every
 * skill belonging to the given package.
 *
 * `skill_co_owners.skill_id` is FK to `cinatra.skills(id)` with
 * ON DELETE RESTRICT. When a package is uninstalled, its skill rows are
 * dropped by the catalog rewrite. If any of those skills still have
 * skill-level co-owners, the FK rejects the rewrite and the transaction rolls
 * back. Call this first to clear the sibling rows by user intent.
 */
export async function removeAllSkillCoOwnersForPackage(packageId: string): Promise<void> {
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  // Delete by joining through the skills payload — co-owner rows whose
  // skill_id matches any skill whose payload.packageId is the uninstalled
  // package. payload is text holding JSON; cast to jsonb for `->>` lookup.
  runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `DELETE FROM "${schema.replaceAll('"', '""')}"."skill_co_owners"
               WHERE skill_id IN (
                 SELECT id FROM "${schema.replaceAll('"', '""')}"."skills"
                 WHERE (payload::jsonb)->>'packageId' = $1
               )`,
        values: [packageId],
      },
    ],
  });
}

/**
 * Remove ALL polymorphic
 * `extension_co_owners` + `extension_access_policy` rows for every skill
 * belonging to the given package.
 *
 * The polymorphic backend has no FK on `resource_id` (one FK
 * can't span multiple kind-specific resource tables), so an
 * uninstallSkillPackage must also clean polymorphic rows keyed by
 * `resource_kind='skill'` for each child skill — otherwise those rows
 * orphan and could re-apply grants if the same skill id is later reused.
 */
export async function removeAllPolymorphicSkillPermissionsForPackage(packageId: string): Promise<void> {
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `DELETE FROM "${schema.replaceAll('"', '""')}"."extension_co_owners"
               WHERE resource_kind = 'skill'
                 AND resource_id IN (
                   SELECT id FROM "${schema.replaceAll('"', '""')}"."skills"
                   WHERE (payload::jsonb)->>'packageId' = $1
                 )`,
        values: [packageId],
      },
      {
        text: `DELETE FROM "${schema.replaceAll('"', '""')}"."extension_access_policy"
               WHERE resource_kind = 'skill'
                 AND resource_id IN (
                   SELECT id FROM "${schema.replaceAll('"', '""')}"."skills"
                   WHERE (payload::jsonb)->>'packageId' = $1
                 )`,
        values: [packageId],
      },
    ],
  });
}

export async function setSkillPackageInstalledBy(
  packageId: string,
  userId: string | null,
): Promise<{ ok: boolean }> {
  const catalog = await readSkillsCatalog();
  const idx = catalog.skillPackages.findIndex(
    (p) => p.packageId === packageId || p.id === packageId,
  );
  if (idx < 0) return { ok: false };
  const updated: PersistedSkillPackage = {
    ...catalog.skillPackages[idx]!,
    installedByUserId: userId,
  };
  const next = [...catalog.skillPackages];
  next[idx] = updated;
  replaceSkillCatalogInDatabase({
    skillPackages: next,
    skills: catalog.skills,
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Per-skill access policy + co-owner store helpers.
//
// Storage:
//   - accessPolicy lives inside the skill row's payload JSON (PersistedSkill).
//   - co-owner rows live in cinatra.skill_co_owners (added in
//     src/lib/drizzle-store.ts).
//
// Compatibility projection: writeSkillAccessPolicy ALSO writes the legacy
// (level, scope) tuple via visibilityToLevelScope so existing matching /
// visibility readers (matching.ts, llm-matching/visibility.ts, agents-store
// filters) keep working unchanged until they migrate to consume accessPolicy
// directly.
// ---------------------------------------------------------------------------

import type { AgentAuthPolicy as SkillAuthPolicy } from "@cinatra-ai/agents/auth-policy";

export type SkillCoOwnerRow = {
  skillId: string;
  userId: string;
  grantedBy: string;
  grantedAt: Date;
};

export async function readSkillAccessPolicy(
  skillId: string,
): Promise<SkillAuthPolicy | null> {
  const catalog = await readSkillsCatalog();
  const skill = catalog.skills.find((s) => s.id === skillId);
  return skill?.accessPolicy ?? null;
}

/**
 * Compatibility projection — writes the canonical
 * accessPolicy AND projects to the legacy (level, scope) tuple so existing
 * readers see the policy via either path. The legacy projection is keyed on
 * runListVisibility (locksteps with the other two on save).
 */
export async function writeSkillAccessPolicy(
  skillId: string,
  policy: SkillAuthPolicy | null,
): Promise<{ ok: boolean }> {
  const catalog = await readSkillsCatalog();
  const idx = catalog.skills.findIndex((s) => s.id === skillId);
  if (idx < 0) return { ok: false };
  const existing = catalog.skills[idx]!;
  const updated: PersistedSkill = { ...existing, accessPolicy: policy };
  if (policy) {
    // Compatibility projection — write legacy (level, scope) so readers that
    // still consume those fields stay correct until they migrate to
    // accessPolicy. Locksteps with the access-form save path.
    const { level, scope } = visibilityToLevelScope(
      policy.runListVisibility,
      existing.ownerUserId,
    );
    updated.level = level;
    updated.scope = scope;
  }
  const next = [...catalog.skills];
  next[idx] = updated;
  replaceSkillCatalogInDatabase({
    skillPackages: catalog.skillPackages,
    skills: next,
  });
  return { ok: true };
}

export async function readSkillCoOwners(skillId: string): Promise<SkillCoOwnerRow[]> {
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  const [result] = runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `SELECT skill_id, user_id, granted_by, granted_at
               FROM "${schema.replaceAll('"', '""')}"."skill_co_owners"
               WHERE skill_id = $1
               ORDER BY granted_at ASC`,
        values: [skillId],
      },
    ],
  });
  type Row = { skill_id: string; user_id: string; granted_by: string; granted_at: string | Date };
  const rows = (result?.rows ?? []) as Row[];
  return rows.map((r) => ({
    skillId: r.skill_id,
    userId: r.user_id,
    grantedBy: r.granted_by,
    grantedAt: r.granted_at instanceof Date ? r.granted_at : new Date(r.granted_at),
  }));
}

export async function addSkillCoOwner(
  skillId: string,
  userId: string,
  grantedBy: string,
): Promise<{ ok: boolean }> {
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `INSERT INTO "${schema.replaceAll('"', '""')}"."skill_co_owners"
                 (skill_id, user_id, granted_by)
               VALUES ($1, $2, $3)
               ON CONFLICT (skill_id, user_id) DO NOTHING`,
        values: [skillId, userId, grantedBy],
      },
    ],
  });
  return { ok: true };
}

export async function removeSkillCoOwner(
  skillId: string,
  userId: string,
): Promise<{ ok: boolean }> {
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `DELETE FROM "${schema.replaceAll('"', '""')}"."skill_co_owners"
               WHERE skill_id = $1 AND user_id = $2`,
        values: [skillId, userId],
      },
    ],
  });
  return { ok: true };
}

/**
 * Resolve the parent package id of a skill. Used by the per-skill auth gate
 * so editing a skill's policy requires owner/co-owner/admin permission ON
 * THE PARENT PACKAGE (skills aren't user-created — they ship with the
 * package).
 */
export async function readSkillPackageIdFor(skillId: string): Promise<string | null> {
  const catalog = await readSkillsCatalog();
  const skill = catalog.skills.find((s) => s.id === skillId);
  return skill?.packageId ?? null;
}
