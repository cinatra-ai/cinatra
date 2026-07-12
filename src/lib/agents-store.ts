import { existsSync, readdirSync, readFileSync } from "fs";
import path from "path";
import {
  readAgentCatalogFromDatabase,
  readAgentSkillExclusionsFromDatabase,
  readAgentSkillMatchesFromDatabase,
  readConnectorConfigFromDatabase,
  readCustomSkillAssignmentsForAgent,
  readSkillLifecycleStates,
  readSystemGlobalSkillIdsForAgent,
  replaceAgentCatalogInDatabase,
  replaceAgentSkillExclusionsInDatabase,
  replaceAgentSkillMatchesInDatabase,
  writeConnectorConfigToDatabase,
} from "@/lib/database";

// Actor filter shape used by the read-path union below.
// Includes `platformRole` so the visibility predicate
// (`filterMatchRowsByVisibility`) can short-circuit for platform admins.
type AssignedSkillsActorContext = {
  principalId: string;
  principalType?: string;
  organizationId?: string;
  teamIds?: string[];
  projectIds?: string[];
  platformRole?: "platform_admin" | "member";
};
import {
  readSkillsCatalog,
  resolveEffectiveSkillAccessPolicy,
  skillMatchesStore,
  filterMatchRowsByVisibility,
  isRuntimeDeliverableLifecycleState,
  MANUAL_VERSION,
  type VisibilitySkillMeta,
  type SkillMatchRow,
} from "@cinatra-ai/skills";
// Installed-agent reads use `readInstalledAgentTemplates`, which filters
// status to active/published and excludes drafts.
import { readInstalledAgentTemplates } from "@cinatra-ai/agents/store";
// Provider-declared agents live under `<installDir>/cinatra/<slug>/`
// and are NOT in `agent_templates`. The matcher's "agents" axis must union the
// DB-installed templates with the filesystem-provided agents so users see
// agents like email-drafting-agent, web-scrape-agent, etc. Mirrors the
// `handleAgentBuilderGitList` resolution order in packages/agents/src/mcp/handlers.ts.
import { resolveAgentRuntimeMountDir } from "@cinatra-ai/agents/agent-runtime-mount";
// cinatra#538 (defect 2 — approved≠runnable): the picker must enumerate the
// operator's OWN vendor dir, not only the first-party "cinatra-ai" one. Post-#537,
// user agents are written under `<installRoot>/<operator-vendor>/...` (e.g.
// `marcushorndt-local`), so a picker that scans only `cinatra-ai` misses them.
// Mirrors `safeVendorSegmentsForRead()` in
// packages/agents/src/mcp/agent-source-paths.ts (operator vendor first, then
// first-party, deduped, filesystem-safe).
import { readInstanceIdentity } from "@/lib/instance-identity-store";
import { isSafePathSegment } from "@cinatra-ai/registries";

type FlatFrontmatterValue = string | string[];

export type PersistedAgent = {
  id: string;
  identifier: string;
  packageId: string;
  packageName: string;
  packageSlug: string;
  humanReadableName: string;
  description: string;
  frontmatter: Record<string, FlatFrontmatterValue>;
  frontmatterRaw?: string;
  content: string;
  sourcePath: string;
  keywords: string[];
};

export type AgentSkillMatch = {
  id: string;
  agentId: string;
  skillId: string;
  score: number;
  rationale: string;
};

export type AgentSkillExclusion = {
  id: string;
  agentId: string;
  skillId: string;
  reason: string;
};

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function titleize(value: string) {
  return value
    .split(/[-_\s]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function parseFrontmatter(content: string) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) {
    return {
      attributes: {} as Record<string, FlatFrontmatterValue>,
      raw: "",
      body: content,
    };
  }

  const attributes: Record<string, FlatFrontmatterValue> = {};

  for (const rawLine of match[1].split("\n")) {
    const line = rawLine.trim();
    if (!line || rawLine.startsWith("  ") || rawLine.startsWith("\t")) {
      continue;
    }

    const separatorIndex = line.indexOf(":");
    if (separatorIndex < 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim().replace(/^["']|["']$/g, "");
    if (!value) {
      attributes[key] = "";
      continue;
    }

    attributes[key] = value.includes(",")
      ? value.split(",").map((entry) => entry.trim()).filter(Boolean)
      : value;
  }

  return {
    attributes,
    raw: match[1],
    body: content.slice(match[0].length),
  };
}

function normalizeStringArray(value: FlatFrontmatterValue | undefined) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean);
  }

  if (typeof value === "string" && value.trim()) {
    return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  }

  return [];
}

type PackageSkillDocument = {
  relativePath: string;
  name: string;
  description: string;
  body: string;
};

function collectPackageSkillDocuments(searchRootPath: string, relativeDirectoryPath = ""): PackageSkillDocument[] {
  if (!existsSync(searchRootPath)) {
    return [];
  }

  const skillFilePath = path.join(searchRootPath, "SKILL.md");
  if (existsSync(skillFilePath)) {
    const content = readFileSync(skillFilePath, "utf8");
    const { attributes, body } = parseFrontmatter(content);

    return [
      {
        relativePath: relativeDirectoryPath || path.basename(searchRootPath),
        name:
          typeof attributes.name === "string" && attributes.name.trim()
            ? attributes.name.trim()
            : titleize(path.basename(searchRootPath)),
        description:
          typeof attributes.description === "string" && attributes.description.trim()
            ? attributes.description.trim()
            : `${titleize(path.basename(searchRootPath))} package skill.`,
        body: body.trim(),
      },
    ];
  }

  const ignoredDirectoryNames = new Set([".git", ".github", "node_modules", "src", "agents", "references", "assets", "scripts"]);
  const collected: PackageSkillDocument[] = [];

  for (const entry of readdirSync(searchRootPath, { withFileTypes: true })) {
    if (!entry.isDirectory() || ignoredDirectoryNames.has(entry.name)) {
      continue;
    }

    const childPath = path.join(searchRootPath, entry.name);
    const childRelativePath = relativeDirectoryPath ? path.join(relativeDirectoryPath, entry.name) : entry.name;
    collected.push(...collectPackageSkillDocuments(childPath, childRelativePath));
  }

  return collected;
}

function buildAgentContentFromPackageSkills(skillDocuments: PackageSkillDocument[]) {
  return skillDocuments
    .map((skillDocument) =>
      [
        `## ${skillDocument.name}`,
        `Path: skills/${skillDocument.relativePath}/SKILL.md`,
        `Description: ${skillDocument.description}`,
        "",
        skillDocument.body,
      ].join("\n"),
    )
    .join("\n\n");
}

function discoverInstalledAgents(): PersistedAgent[] {
  const packagesDirectoryPath = path.join(process.cwd(), "packages");
  if (!existsSync(packagesDirectoryPath)) {
    return [];
  }

  const discovered: PersistedAgent[] = [];

  for (const entry of readdirSync(packagesDirectoryPath, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const packageRootPath = path.join(packagesDirectoryPath, entry.name);
    const rootSkillPath = path.join(packageRootPath, "SKILL.md");
    const packageSkillsRootPath = path.join(packageRootPath, "skills");
    const packageJsonPath = path.join(packageRootPath, "package.json");

    if (!existsSync(packageJsonPath)) {
      continue;
    }

    const packageSkillDocuments = collectPackageSkillDocuments(packageSkillsRootPath);
    if (!existsSync(rootSkillPath) && packageSkillDocuments.length === 0) {
      continue;
    }

    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      name?: string;
    };
    const rootSkillContent = existsSync(rootSkillPath) ? readFileSync(rootSkillPath, "utf8") : "";
    const { attributes, raw, body } = parseFrontmatter(rootSkillContent);
    const packageId = String(packageJson.name ?? entry.name);
    const packageSlug = slugify(packageId.replace(/^@[^/]+\//, "") || entry.name);
    const identifier = typeof attributes.identifier === "string" && attributes.identifier.trim()
      ? attributes.identifier.trim()
      : packageSlug;
    const humanReadableName =
      typeof attributes.display_name === "string" && attributes.display_name.trim()
        ? attributes.display_name.trim()
        : typeof attributes.name === "string" && attributes.name.trim()
          ? titleize(attributes.name)
          : titleize(packageSlug);
    const description =
      typeof attributes.description === "string" && attributes.description.trim()
        ? attributes.description.trim()
        : packageSkillDocuments.length > 0
          ? packageSkillDocuments.map((skillDocument) => skillDocument.description).join(" ")
        : `${humanReadableName} agent package.`;
    const keywords = [
      identifier,
      humanReadableName,
      description,
      ...normalizeStringArray(attributes.keywords),
      ...packageSkillDocuments.flatMap((skillDocument) => [skillDocument.name, skillDocument.description, skillDocument.relativePath]),
    ]
      .flatMap((value) => String(value).split(","))
      .map((value) => value.trim())
      .filter(Boolean);

    discovered.push({
      id: identifier,
      identifier,
      packageId,
      packageName: humanReadableName,
      packageSlug,
      humanReadableName,
      description,
      frontmatter: attributes,
      frontmatterRaw: raw,
      content: packageSkillDocuments.length > 0 ? buildAgentContentFromPackageSkills(packageSkillDocuments) : body.trim(),
      sourcePath: packageSkillDocuments.length > 0 ? packageSkillsRootPath : rootSkillPath,
      keywords,
    });
  }

  return discovered.sort((left, right) => left.humanReadableName.localeCompare(right.humanReadableName));
}

function normalizeStoredAgent(record: Record<string, unknown>): PersistedAgent | null {
  if (
    typeof record.id !== "string" ||
    typeof record.identifier !== "string" ||
    typeof record.packageId !== "string" ||
    typeof record.packageName !== "string" ||
    typeof record.packageSlug !== "string" ||
    typeof record.humanReadableName !== "string" ||
    typeof record.description !== "string" ||
    typeof record.content !== "string" ||
    typeof record.sourcePath !== "string" ||
    typeof record.frontmatter !== "object" ||
    record.frontmatter === null
  ) {
    return null;
  }

  const frontmatterEntries: Array<[string, FlatFrontmatterValue]> = [];
  for (const [key, value] of Object.entries(record.frontmatter as Record<string, unknown>)) {
    if (typeof value === "string") {
      frontmatterEntries.push([key, value]);
      continue;
    }

    if (Array.isArray(value)) {
      frontmatterEntries.push([key, value.filter((entry): entry is string => typeof entry === "string")]);
    }
  }

  const frontmatter = Object.fromEntries(frontmatterEntries) as Record<string, FlatFrontmatterValue>;

  return {
    id: record.id,
    identifier: record.identifier,
    packageId: record.packageId,
    packageName: record.packageName,
    packageSlug: record.packageSlug,
    humanReadableName: record.humanReadableName,
    description: record.description,
    frontmatter,
    frontmatterRaw: typeof record.frontmatterRaw === "string" ? record.frontmatterRaw : undefined,
    content: record.content,
    sourcePath: record.sourcePath,
    keywords: Array.isArray(record.keywords) ? record.keywords.filter((entry): entry is string => typeof entry === "string") : [],
  };
}

function normalizeStoredMatch(record: Record<string, unknown>): AgentSkillMatch | null {
  if (
    typeof record.id !== "string" ||
    typeof record.agentId !== "string" ||
    typeof record.skillId !== "string" ||
    typeof record.score !== "number" ||
    typeof record.rationale !== "string"
  ) {
    return null;
  }

  return {
    id: record.id,
    agentId: record.agentId,
    skillId: record.skillId,
    score: record.score,
    rationale: record.rationale,
  };
}

function normalizeStoredExclusion(record: Record<string, unknown>): AgentSkillExclusion | null {
  if (
    typeof record.id !== "string" ||
    typeof record.agentId !== "string" ||
    typeof record.skillId !== "string" ||
    typeof record.reason !== "string"
  ) {
    return null;
  }

  return {
    id: record.id,
    agentId: record.agentId,
    skillId: record.skillId,
    reason: record.reason,
  };
}

function catalogSignature(agents: PersistedAgent[]) {
  return JSON.stringify(
    [...agents].sort((left, right) => left.id.localeCompare(right.id)).map((agent) => ({
      ...agent,
      keywords: [...agent.keywords].sort(),
    })),
  );
}


export async function syncInstalledAgentsToDatabase() {
  const scannedAgents = discoverInstalledAgents();
  const current = readAgentCatalogFromDatabase();
  const storedAgents = Array.isArray(current.agents)
    ? current.agents.map((entry) => normalizeStoredAgent(entry)).filter((entry): entry is PersistedAgent => entry !== null)
    : [];

  if (catalogSignature(scannedAgents) !== catalogSignature(storedAgents)) {
    replaceAgentCatalogInDatabase({ agents: scannedAgents });
  }

  return scannedAgents;
}

/**
 * Canonical "installed runnable agents" reader for the skill matcher.
 *
 * The retired `readAgentsCatalog()` (removed by the dead-code sweep once the
 * matcher switched here) returned a filesystem scan of `packages/*`: workspace
 * build packages, not user-installed runnable agents. The matcher axis must be
 * installed agents × skills.
 *
 * The CORRECT axis is `agent_templates WHERE packageName IS NOT NULL
 * AND status IN ('active', 'published')`. Drafts are excluded (they're not runnable);
 * workspace packages are excluded (they're not user-facing agents).
 *
 * Existing skill_matches rows keyed by workspace package IDs become orphans
 * after this switch — by design. Reader-side defensive filtering in
 * `matchAgentsToSkills()` already drops rows
 * whose agent_id is not in the live catalog, so no destructive migration
 * is needed.
 *
 * Mapped to the same `PersistedAgent` shape as the retired catalog reader so
 * downstream `adaptAgentForMatching()` and existing call sites work
 * unchanged.
 */
// Slugs whose on-disk directory name differs from the slug.
// Mirrors `LEGACY_SLUG_MAP` in packages/agents/src/mcp/handlers.ts.
const PROVIDER_AGENT_LEGACY_SLUG_MAP: Record<string, string> = {
  "drupal-agent": "drupal-content-editor",
  "wordpress-agent": "wordpress-content-editor",
};

// First-party on-disk vendor segment (the `@cinatra-ai` scope WITHOUT npm's
// leading "@"). Mirrors `DEFAULT_VENDOR_SEGMENT` in
// packages/agents/src/mcp/agent-source-paths.ts.
const PROVIDER_DEFAULT_VENDOR_SEGMENT = "cinatra-ai";

/**
 * The deduped, FILESYSTEM-SAFE vendor-segment candidates the picker probes:
 * the operator's OWN vendor segment FIRST (where agents authored on THIS
 * instance are written post-#537), then the first-party "cinatra-ai" segment
 * so bundled/installed first-party agents still resolve.
 *
 * cinatra#538: without the operator segment an approved/published user agent
 * (e.g. `@marcushorndt-local/...`, materialized under
 * `<installRoot>/marcushorndt-local/...`) never surfaced in `/agents`.
 *
 * Source of truth: the operator's instance identity (`instanceNamespace`,
 * which `readInstanceIdentity` already normalizes from the legacy `vendorName`
 * key). Unsafe identity-derived segments are DROPPED (not thrown): a malformed
 * identity must not crash a read, it just yields no probe under that segment.
 * The first-party default is always retained. Mirrors
 * `safeVendorSegmentsForRead()` in agent-source-paths.ts.
 */
function safeProviderVendorSegments(): string[] {
  const out: string[] = [];
  let instanceSegment = PROVIDER_DEFAULT_VENDOR_SEGMENT;
  try {
    const identity = readInstanceIdentity();
    if (identity?.instanceNamespace) instanceSegment = identity.instanceNamespace;
  } catch (err) {
    // A read failure must not crash the picker — fall back to first-party only.
    console.warn("[agents-store] readInstanceIdentity failed:", err);
  }
  for (const seg of [instanceSegment, PROVIDER_DEFAULT_VENDOR_SEGMENT]) {
    if (isSafePathSegment(seg) && !out.includes(seg)) out.push(seg);
  }
  return out;
}

// Agent-definition path resolution. Mirrors `resolveAgentJsonPathForRead` in
// packages/agents/src/mcp/handlers.ts so agents authored with supported on-disk
// layouts all surface in the matcher's "agents" axis.
//
// cinatra#538: resolution is VENDOR-SCOPED, not "first match across vendors".
// The new-layout rungs (1–2) resolve under ONE specific vendor segment so a
// same-slug agent under the operator vendor and under first-party "cinatra-ai"
// BOTH surface as distinct packageIds — instead of the operator dir shadowing
// the first-party one (the previous "operator-first, return on first hit"
// behavior hid a same-slug first-party agent from /agents).
function resolveProviderAgentJsonPathUnderVendor(
  installRoot: string,
  vendor: string,
  packageSlug: string,
): string | null {
  // Rung 1 — canonical layout
  const rung1 = path.join(installRoot, vendor, packageSlug, "cinatra", "oas.json");
  if (existsSync(rung1)) return rung1;
  // Rung 2 — same directory, alternate filename
  const rung2 = path.join(installRoot, vendor, packageSlug, "cinatra", "agent.json");
  if (existsSync(rung2)) return rung2;
  return null;
}

// Legacy/flat top-level layout (rungs 3–4): <installDir>/<legacySlug>/[cinatra/]agent.json.
// These dirs are NOT vendor-scoped; they predate the `<vendor>/<slug>/` layout.
function resolveLegacyProviderAgentJsonPath(
  installRoot: string,
  packageSlug: string,
): string | null {
  const legacySlug = PROVIDER_AGENT_LEGACY_SLUG_MAP[packageSlug] ?? packageSlug;
  // Rung 3 — alternate directory via explicit slug map
  const rung3 = path.join(installRoot, legacySlug, "cinatra", "agent.json");
  if (existsSync(rung3)) return rung3;
  // Rung 4 — flat package layout
  const rung4 = path.join(installRoot, legacySlug, "agent.json");
  if (existsSync(rung4)) return rung4;
  return null;
}

/**
 * Filesystem walker for provider-declared agents: agents
 * shipped on disk under `<installDir>/cinatra/<slug>/` and not yet installed
 * in `agent_templates`). Returns a `PersistedAgent[]` keyed by the npm
 * `packageName` from `metadata.cinatra.packageName`, top-level `packageName`,
 * or sibling `package.json#name` — falling back through the same precedence
 * as `handleAgentBuilderGitList`. Agents without a resolvable packageName
 * are dropped silently (they cannot be keyed in `cinatra.skill_matches`).
 *
 * Errors:
 *   - Per-agent parse / read errors are swallowed; the agent is skipped.
 *   - Root-directory enumeration errors propagate iff `throwOnError: true`,
 *     so the matcher caller can fail closed (mirrors `readInstalledAgentTemplates`).
 */
export function readProviderDeclaredAgents(
  options: { throwOnError?: boolean } = {},
): PersistedAgent[] {
  let installRoot: string;
  try {
    installRoot = resolveAgentRuntimeMountDir();
  } catch (err) {
    if (options.throwOnError) throw err;
    console.warn("[agents-store] resolveAgentRuntimeMountDir failed:", err);
    return [];
  }

  if (!existsSync(installRoot)) return [];

  // cinatra#538: collect one candidate per on-disk location where an agent
  // actually exists — the operator's OWN vendor dir AND the first-party
  // "cinatra-ai" dir for the new `<vendor>/<slug>/` layout, plus the legacy/flat
  // top-level layout. Resolution is PER-VENDOR (not "operator-first, first
  // hit"), so a same-slug agent under the operator vendor and under "cinatra-ai"
  // BOTH surface as distinct packageIds — the operator dir no longer shadows a
  // same-slug first-party agent. Without enumerating the operator vendor dir at
  // all, an approved user agent materialized under
  // `<installRoot>/<operator-vendor>/...` never surfaced in `/agents`.
  const candidates: Array<{ oasSourcePath: string; siblingPkgPaths: string[] }> = [];
  const vendorSegments = safeProviderVendorSegments();

  // New layout: <installDir>/<vendor>/<slug>/cinatra/{oas,agent}.json
  for (const vendor of vendorSegments) {
    const vendorDir = path.join(installRoot, vendor);
    if (!existsSync(vendorDir)) continue;
    try {
      for (const sub of readdirSync(vendorDir, { withFileTypes: true })) {
        if (!sub.isDirectory()) continue;
        const jsonPath = resolveProviderAgentJsonPathUnderVendor(installRoot, vendor, sub.name);
        if (jsonPath) {
          candidates.push({
            oasSourcePath: jsonPath,
            siblingPkgPaths: [path.join(installRoot, vendor, sub.name, "package.json")],
          });
        }
      }
    } catch (err) {
      if (options.throwOnError) throw err;
      console.warn("[agents-store] readdir vendor dir failed:", err);
    }
  }

  // Alternate/legacy layout: <installDir>/<slug>/ that is NOT a walked vendor dir.
  type DirEntry = { name: string; isDirectory: () => boolean };
  let topEntries: DirEntry[] = [];
  try {
    topEntries = readdirSync(installRoot, { withFileTypes: true }) as unknown as DirEntry[];
  } catch (err) {
    if (options.throwOnError) throw err;
    console.warn("[agents-store] readdir install root failed:", err);
  }
  const walkedVendorSegments = new Set(vendorSegments);
  for (const entry of topEntries) {
    if (!entry.isDirectory()) continue;
    if (walkedVendorSegments.has(entry.name)) continue; // already walked above
    const jsonPath = resolveLegacyProviderAgentJsonPath(installRoot, entry.name);
    if (jsonPath) {
      const legacySlug = PROVIDER_AGENT_LEGACY_SLUG_MAP[entry.name] ?? entry.name;
      candidates.push({
        oasSourcePath: jsonPath,
        siblingPkgPaths: [path.join(installRoot, legacySlug, "package.json")],
      });
    }
  }

  const persisted: PersistedAgent[] = [];
  const seenPackageIds = new Set<string>();
  for (const { oasSourcePath, siblingPkgPaths } of candidates) {
    let agentJson: Record<string, unknown>;
    try {
      agentJson = JSON.parse(readFileSync(oasSourcePath, "utf8")) as Record<string, unknown>;
    } catch (err) {
      // When `throwOnError: true` (matcher write path), per-agent JSON
      // parse failures must propagate. Silently
      // skipping would omit a provider agent and persist a misleading
      // Matches projection. Default callers (UI/inline-eval) keep the
      // permissive skip + warn behavior.
      if (options.throwOnError) {
        throw err instanceof Error
          ? new Error(`failed to parse OAS source at ${oasSourcePath}: ${err.message}`)
          : err;
      }
      console.warn(
        `[agents-store] failed to parse OAS source at ${oasSourcePath}:`,
        err,
      );
      continue;
    }

    const cinatraMeta = (agentJson.metadata as Record<string, unknown> | undefined)?.cinatra as
      | Record<string, unknown>
      | undefined;

    let packageName: string | null =
      (cinatraMeta?.packageName as string | null | undefined)
        ?? (agentJson.packageName as string | null | undefined)
        ?? null;
    let description: string | null = (agentJson.description as string | null | undefined) ?? null;
    const displayName = (agentJson.name as string | null | undefined) ?? null;

    if (!packageName || !description) {
      for (const pkgPath of siblingPkgPaths) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
            name?: unknown;
            description?: unknown;
          };
          if (!packageName && typeof pkg.name === "string" && pkg.name.trim()) {
            packageName = pkg.name;
          }
          if (!description && typeof pkg.description === "string" && pkg.description.trim()) {
            description = pkg.description;
          }
          if (packageName && description) break;
        } catch (err) {
          // When `throwOnError: true`, a malformed *existing* sibling
          // package.json must propagate
          // (otherwise an agent that legitimately needed the fallback for
          // packageName gets silently dropped). A missing file (ENOENT)
          // is fine — the next candidate is probed. Default callers keep
          // the permissive "try next candidate" behavior.
          if (options.throwOnError && (err as NodeJS.ErrnoException)?.code !== "ENOENT") {
            throw err instanceof Error
              ? new Error(
                  `failed to read sibling package.json at ${pkgPath} for agent ${oasSourcePath}: ${err.message}`,
                )
              : err;
          }
          /* try next candidate */
        }
      }
    }

    // Drop agents with no resolvable packageName — `cinatra.skill_matches`
    // is keyed by packageId and we cannot persist matches without one.
    if (!packageName) continue;
    // cinatra#538: dedupe by packageId. Distinct vendors yield distinct
    // packageIds (both kept); the same packageId resolved twice (e.g. a new- and
    // legacy-layout copy of one agent) collapses to a single entry.
    if (seenPackageIds.has(packageName)) continue;
    seenPackageIds.add(packageName);

    const derivedSlug = slugify(packageName.replace(/^@[^/]+\//, "") || packageName);
    const humanReadableName = displayName?.trim() || derivedSlug;

    persisted.push({
      id: derivedSlug,
      identifier: derivedSlug,
      packageId: packageName,
      packageName: humanReadableName,
      packageSlug: derivedSlug,
      humanReadableName,
      description: description?.trim() ?? "",
      frontmatter: {},
      content: "",
      sourcePath: "",
      keywords: [derivedSlug, humanReadableName].filter(Boolean),
    });
  }

  return persisted;
}

export async function readAgentsForSkillMatching(
  options: { throwOnError?: boolean } = {},
): Promise<PersistedAgent[]> {
  // The matcher write path must NOT silently overwrite
  // cinatra.skill_matches projection with [] on a transient
  // upstream failure. `throwOnError: true` propagates; default behavior
  // remains defensive for read-only UI / inline-eval / personal-skill
  // form callers where surfacing an empty list is the right UX.
  const templates = await (options.throwOnError
    ? readInstalledAgentTemplates()
    : readInstalledAgentTemplates().catch((err) => {
        console.warn("[agents-store] readInstalledAgentTemplates failed:", err);
        return [];
      }));

  const fromDb = templates.flatMap<PersistedAgent>((t) => {
    const packageId = t.packageName;
    if (!packageId) return [];
    const packageSlug = slugify(
      packageId.replace(/^@[^/]+\//, "") || packageId,
    );
    return [{
      id: packageSlug,
      identifier: packageSlug,
      packageId,
      packageName: t.name || packageSlug,
      packageSlug,
      humanReadableName: t.name || packageSlug,
      description: t.description || "",
      frontmatter: {},
      content: "",
      sourcePath: "",
      keywords: [packageSlug, t.name || packageSlug].filter(Boolean),
    }];
  });

  // Union the DB-installed templates with the provider-declared
  // agents on disk. DB row wins on packageId collision (a published template
  // typically carries richer metadata than the on-disk shell).
  const fromFilesystem = readProviderDeclaredAgents(options);
  const byPackageId = new Map<string, PersistedAgent>();
  for (const agent of fromDb) byPackageId.set(agent.packageId, agent);
  for (const agent of fromFilesystem) {
    if (!byPackageId.has(agent.packageId)) byPackageId.set(agent.packageId, agent);
  }
  return Array.from(byPackageId.values());
}

/**
 * Project canonical `skill_matches` rows into the legacy `AgentSkillMatch`
 * compatibility shape. Pure — no reads, no writes — so both
 * `matchAgentsToSkills()` (which mirror-writes the projection into the
 * `agent_skill_matches` connector-config key) and the observed-parity job
 * (#1366, read-only) derive the projection from EXACTLY the same logic:
 * the same defensive filter (drop rows whose agent or skill left the catalog),
 * the same packageId→slug remap, and the same 0.000-1.000 → 0-100 score scale.
 */
export function projectMatchedRowsToAgentSkillMatches(
  agents: ReadonlyArray<{ packageId: string; id: string }>,
  liveSkillIds: ReadonlySet<string>,
  matchedRows: ReadonlyArray<SkillMatchRow>,
): { matches: AgentSkillMatch[]; mostRecentEvaluatedAt: Date | null } {
  const agentIdByPackageId = new Map<string, string>();
  for (const agent of agents) {
    agentIdByPackageId.set(agent.packageId, agent.id);
  }

  const matches: AgentSkillMatch[] = [];
  let mostRecentEvaluatedAt: Date | null = null;
  for (const row of matchedRows) {
    const agentSlug = agentIdByPackageId.get(row.agentId);
    if (!agentSlug) continue; // agent no longer installed
    if (!liveSkillIds.has(row.skillId)) continue; // skill no longer installed
    const score = row.score ?? 0;
    matches.push({
      id: `${agentSlug}:${row.skillId}`,
      agentId: agentSlug,
      skillId: row.skillId,
      // Compatibility shape uses 0-100; skill_matches stores 0.000-1.000. Scale up.
      score: Math.round(score * 100),
      rationale: row.rationale ?? `${row.source} match`,
    });
    if (!mostRecentEvaluatedAt || row.evaluatedAt > mostRecentEvaluatedAt) {
      mostRecentEvaluatedAt = row.evaluatedAt;
    }
  }
  return { matches, mostRecentEvaluatedAt };
}

/**
 * `matchAgentsToSkills()` is a thin reader over the canonical
 * `skill_matches` table.
 *
 * level=agent self-match remains in-memory (no DB read, no LLM call): these
 * rows are never persisted to skill_matches because they are derivable from
 * the catalog at zero cost.
 *
 * Rows whose agentId or skillId is no longer present in the live catalogs are
 * filtered out so a missed cleanup hook does not leak ghost matches.
 */
export async function matchAgentsToSkills() {
  // "Agents" axis = installed runnable agents only.
  // Workspace-package scans and draft templates are
  // excluded via `readAgentsForSkillMatching()`. Orphan rows whose agent_id is
  // not in the live catalog are dropped by the defensive filter below.
  // The matcher write path must fail closed on any upstream read error.
  // Returning [] from either the
  // agents reader OR the skill_matches reader would cause
  // replaceAgentSkillMatchesInDatabase() at the end of this function to
  // clobber the compatibility projection (admin Matches tab + readAgentSkillMatches
  // consumers) with derived-self-only or empty data. The canonical
  // skill_matches table is unaffected, but the user-visible projection is
  // clobbered until the next successful refresh — which would be confusing.
  // Both reads now throw; the matcher caller (cron + admin-triggered job)
  // must surface the error rather than persist a misleading snapshot.
  const [agents, skillCatalog, matchedRows] = await Promise.all([
    readAgentsForSkillMatching({ throwOnError: true }),
    readSkillsCatalog(),
    skillMatchesStore.readAllMatched(),
  ]);

  const allAgents = agents;

  const liveSkillIds = new Set(skillCatalog.skills.map((s) => s.id));

  // The self-owned agent-skill projection is intentionally absent here.
  // The Matches tab is exclusively for cross-agent skills
  // (skills that originate elsewhere and are matched to an agent). An
  // agent's bundled `level=agent` skills are part of the agent itself and
  // are never "matched" to it. The runtime injection in
  // `getAssignedSkillIdsForAgent()` still resolves
  // self-owned skills directly from the catalog so execution-time
  // behavior is unchanged — only the user-facing projection is affected.

  // Project skill_matches rows into the compatibility AgentSkillMatch shape via
  // the shared pure projector (also used read-only by the #1366 parity job).
  const { matches, mostRecentEvaluatedAt } = projectMatchedRowsToAgentSkillMatches(
    allAgents,
    liveSkillIds,
    matchedRows,
  );

  const matchedAt = mostRecentEvaluatedAt
    ? mostRecentEvaluatedAt.toISOString()
    : new Date().toISOString();

  // Mirror into the compatibility in-memory store so callers that still read
  // through `readAgentSkillMatches()` see the canonical projection.
  replaceAgentSkillMatchesInDatabase({
    matches,
    matchedAt,
  });

  return { matches, matchedAt };
}

export async function readAgentSkillMatches() {
  const stored = readAgentSkillMatchesFromDatabase();
  return {
    matches: Array.isArray(stored.matches)
      ? stored.matches.map((entry) => normalizeStoredMatch(entry)).filter((entry): entry is AgentSkillMatch => entry !== null)
      : [],
    matchedAt: typeof stored.matchedAt === "string" ? stored.matchedAt : "",
  };
}

export async function saveAgentSkillMatches(matches: AgentSkillMatch[]) {
  replaceAgentSkillMatchesInDatabase({
    matches,
    matchedAt: new Date().toISOString(),
  });

  return {
    matches,
    matchedAt: new Date().toISOString(),
  };
}

export async function readAgentSkillExclusions() {
  const stored = readAgentSkillExclusionsFromDatabase();
  return {
    exclusions: Array.isArray(stored.exclusions)
      ? stored.exclusions.map((entry) => normalizeStoredExclusion(entry)).filter((entry): entry is AgentSkillExclusion => entry !== null)
      : [],
    updatedAt: typeof stored.updatedAt === "string" ? stored.updatedAt : "",
  };
}

export async function saveAgentSkillExclusions(exclusions: AgentSkillExclusion[]) {
  replaceAgentSkillExclusionsInDatabase({
    exclusions,
    updatedAt: new Date().toISOString(),
  });

  return {
    exclusions,
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Manual-row helpers.
//
// Manual rows have:
//   - source = "manual"
//   - matched = true (add) | false (remove / exclusion)
//   - score = NULL (numeric NULL — the CHECK constraint allows NULL only for
//     manual rows)
//   - evaluator_version = MANUAL_VERSION
//
// The `upsertMatchRow` short-circuit protects manual rows from being
// overwritten by rule/llm transports; these helpers simply call the
// unconditional `upsertSkillMatch` since the manual branch is the *initial*
// assertion of the manual row.
// ---------------------------------------------------------------------------

/**
 * Write a manual-add row.
 * source=manual, matched=true, score=NULL, rationale="manually added by {actor}".
 */
export async function writeManualSkillMatchAdd(args: {
  /** Canonical packageId (FK to agents). */
  agentId: string;
  skillId: string;
  actorId: string;
  agentInputHash: string;
  skillInputHash: string;
}): Promise<void> {
  const now = new Date();
  const row: SkillMatchRow = {
    agentId: args.agentId,
    skillId: args.skillId,
    source: "manual",
    matched: true,
    score: null,
    rationale: `manually added by ${args.actorId}`,
    evaluatorVersion: MANUAL_VERSION,
    agentInputHash: args.agentInputHash,
    skillInputHash: args.skillInputHash,
    status: "ok",
    errorCode: null,
    errorMessage: null,
    evaluatedAt: now,
    jobStartedAt: now,
  };
  await skillMatchesStore.upsertSkillMatch(row);
}

/**
 * Write a manual-exclusion row.
 * source=manual, matched=false. Blocks the (agent, skill) pair from
 * appearing in `getAssignedSkillIdsForAgent()` results because the reader
 * filters to `matched: true`.
 */
export async function writeManualSkillMatchRemove(args: {
  /** Canonical packageId (FK to agents). */
  agentId: string;
  skillId: string;
  actorId: string;
  agentInputHash: string;
  skillInputHash: string;
}): Promise<void> {
  const now = new Date();
  const row: SkillMatchRow = {
    agentId: args.agentId,
    skillId: args.skillId,
    source: "manual",
    matched: false,
    score: null,
    rationale: `manually excluded by ${args.actorId}`,
    evaluatorVersion: MANUAL_VERSION,
    agentInputHash: args.agentInputHash,
    skillInputHash: args.skillInputHash,
    status: "ok",
    errorCode: null,
    errorMessage: null,
    evaluatedAt: now,
    jobStartedAt: now,
  };
  await skillMatchesStore.upsertSkillMatch(row);
}

/**
 * Lifecycle runtime-delivery gate (A3, cinatra#1363) applied to a resolved set
 * of assigned skill ids — the SINGLE chokepoint that gates EVERY tier of
 * `getAssignedSkillIdsForAgent` (agent self-match, ranked skill_matches, system
 * skills, system globals, custom assignments) plus its downstream provider
 * delivery. FAIL-CLOSED: a lifecycle-read error drops EVERY id (an archived
 * skill must be provably absent from delivery even during a DB blip), and an id
 * with no lifecycle row, or a draft/archived/unknown state, is withheld. A
 * resolved NULL state is DERIVED (extension/legacy) and passes through — the
 * extension install-state authority governs it elsewhere, so this layer never
 * becomes a second authority. Order is preserved so the downstream Anthropic
 * rank-and-truncate-to-8 keep/drop set stays a pure function of the surviving
 * tiers.
 */
function filterToRuntimeDeliverableSkillIds(ids: string[]): string[] {
  if (ids.length === 0) return ids;
  const lifecycle = readSkillLifecycleStates(ids);
  if (!lifecycle.ok) {
    console.warn(
      `[agents-store] lifecycle read failed while gating ${ids.length} assigned skill id(s) — fail-closed (withholding all).`,
    );
    return [];
  }
  return ids.filter((id) =>
    isRuntimeDeliverableLifecycleState(
      lifecycle.states.has(id) ? lifecycle.states.get(id) : undefined,
    ),
  );
}

export async function getAssignedSkillIdsForAgent(
  agentId: string,
  actor?: AssignedSkillsActorContext,
) {
  // When an ActorContext is provided, union in custom_skill_assignments DB
  // rows filtered by principalId/teamIds/
  // projectIds/organizationId. Existing system-globals + agent self-match +
  // ranked match union remains additive.
  let customAssignmentIds: string[] = [];
  let systemGlobalIds: string[] = [];
  if (actor) {
    try {
      const customRows = await readCustomSkillAssignmentsForAgent(agentId, {
        principalId: actor.principalId,
        teamIds: actor.teamIds ?? [],
        projectIds: actor.projectIds ?? [],
        organizationId: actor.organizationId ?? "",
      });
      // Defense-in-depth filter (test parity): the real DB query already
      // applies the same predicate via parameterized SQL, but unit tests
      // mock readCustomSkillAssignmentsForAgent and return rows for all
      // owner_types — the JS-side filter ensures the union honors actor scope.
      const teamIds = new Set(actor.teamIds ?? []);
      const projectIds = new Set(actor.projectIds ?? []);
      const orgId = actor.organizationId ?? "";
      customAssignmentIds = customRows
        .filter((row) => {
          if (row.ownerType === "user") return row.ownerId === actor.principalId;
          if (row.ownerType === "team") return teamIds.has(row.ownerId);
          if (row.ownerType === "project") return projectIds.has(row.ownerId);
          if (row.ownerType === "organization") return Boolean(orgId) && row.ownerId === orgId;
          // Workspace assignments are usable by every workspace user, but
          // the actor must be a real workspace principal (resolved
          // orgId). Org-less / unauthenticated shapes must NOT pass.
          if (row.ownerType === "workspace") return Boolean(orgId);
          return false;
        })
        .map((row) => row.skillId);
    } catch (err) {
      // Log instead of swallowing silently. Operators
      // need this signal to diagnose partial outages where the assignment
      // table is unreadable but the catalog still resolves.
      console.warn(
        `[agents-store] readCustomSkillAssignmentsForAgent failed (agent=${agentId}):`,
        err,
      );
      customAssignmentIds = [];
    }
    try {
      systemGlobalIds = (await readSystemGlobalSkillIdsForAgent(agentId)) ?? [];
    } catch (err) {
      console.warn(
        `[agents-store] readSystemGlobalSkillIdsForAgent failed (agent=${agentId}):`,
        err,
      );
      systemGlobalIds = [];
    }
  }

  // Use a `skill_matches` table read plus per-actor visibility filter.
  // level=agent self-match and level=system global injection are direct catalog
  // passes (no DB read).
  let catalog: {
    skills: Array<{
      id: string;
      level?: string;
      agentId?: string;
      scope?: string;
      packageId?: string;
      accessPolicy?: import("@cinatra-ai/agents/auth-policy").AgentAuthPolicy | null;
    }>;
    skillPackages?: Array<{
      id?: string;
      packageId?: string;
      accessPolicy?: import("@cinatra-ai/agents/auth-policy").AgentAuthPolicy | null;
    }>;
  };
  let agents: PersistedAgent[];
  let matchRows: SkillMatchRow[];
  try {
    // Runtime read path resolves slug to packageId via the installed-agents
    // reader. Otherwise a
    // slug like `web-scrape-agent` cannot resolve to `@cinatra-ai/web-scrape-agent`
    // and skill_matches lookups miss rows keyed by packageId.
    [catalog, agents] = await Promise.all([
      readSkillsCatalog() as Promise<typeof catalog>,
      readAgentsForSkillMatching(),
    ]);
  } catch (err) {
    console.warn(
      `[agents-store] catalog read failed in getAssignedSkillIdsForAgent (agent=${agentId}):`,
      err,
    );
    // Even on the degraded (catalog-read-failure) path the lifecycle gate still
    // applies — it reads the lifecycle_state column independently of the failed
    // catalog read, so a draft/archived skill is never delivered here either.
    return filterToRuntimeDeliverableSkillIds(
      Array.from(new Set([...systemGlobalIds, ...customAssignmentIds])),
    );
  }

  // Resolve the input `agentId` (slug OR packageId) to the canonical
  // packageId used by skill_matches.
  const npmSuffix = agentId.includes("/")
    ? agentId.split("/").pop() ?? agentId
    : agentId;
  const agentRecord = agents.find(
    (a) => a.id === agentId || a.identifier === agentId || a.packageId === agentId,
  );
  const canonicalPackageId = agentRecord?.packageId ?? agentId;

  try {
    matchRows = await skillMatchesStore.readSkillMatchesByAgent(canonicalPackageId);
  } catch (err) {
    console.warn(
      `[agents-store] readSkillMatchesByAgent failed (agent=${canonicalPackageId}):`,
      err,
    );
    matchRows = [];
  }

  // Filter to only matched=true / status=ok rows. Manual exclusions
  // (source=manual, matched=false) are naturally dropped here, blocking
  // the (agent, skill) pair from appearing.
  const positiveRows = matchRows.filter((row) => row.matched && row.status === "ok");

  // Build the skill metadata map and apply visibility filter
  // over scoped-level rows. Defensive: the visibility predicate also drops
  // rows whose skillId is no longer in `skillsById`.
  const skillsById = new Map<string, VisibilitySkillMeta>();
  for (const skill of catalog.skills) {
    skillsById.set(skill.id, {
      // Skills without an explicit level use system visibility semantics.
      level: skill.level ?? "system",
      scope: skill.scope,
      agentId: skill.agentId,
      // Canonical effective policy (W4): skill override else parent package's.
      // When present the visibility filter enforces its union any-match.
      accessPolicy: resolveEffectiveSkillAccessPolicy(skill, catalog.skillPackages ?? []),
    });
  }

  const visibilityActor = actor
    ? {
        userId: actor.principalId,
        teamIds: actor.teamIds ?? [],
        projectIds: actor.projectIds ?? [],
        orgId: actor.organizationId,
        platformRole: actor.platformRole,
      }
    : {
        // No actor context — treat as the most restrictive non-admin caller
        // so scoped-level rows are filtered out (defense-in-depth).
        userId: undefined,
        teamIds: [],
        projectIds: [],
        orgId: undefined,
        platformRole: "member" as const,
      };

  const visibleRows = filterMatchRowsByVisibility(
    positiveRows,
    skillsById,
    visibilityActor,
  );
  const matchedSkillIds = visibleRows.map((row) => row.skillId);

  // Direct self-match for level: "agent" skills, derived from catalog, no DB read.
  // The catalog itself is NOT a
  // proven-ordered source (`buildSelectJsonRowsQuery` has no ORDER BY;
  // `syncInstalledSkillsToDatabase` + filesystem `readdirSync` are unsorted),
  // so a catalog-derived tier inherits arbitrary order. Sort each
  // catalog-derived tier by skill id ascending so the final resolved union —
  // and thus the general-selectable Anthropic rank-and-truncate-to-8 keep/drop
  // set — is a pure function of DB state across EVERY tier (the recommender +
  // custom-assignment tiers are already SQL-ORDER-BY deterministic).
  const directAgentMatches = catalog.skills
    .filter((skill) => {
      if (skill.level !== "agent") return false;
      if (!skill.agentId) return false;
      if (skill.agentId === agentId) return true;
      if (skill.agentId === canonicalPackageId) return true;
      const skillNpmSuffix = skill.agentId.includes("/")
        ? skill.agentId.split("/").pop() ?? skill.agentId
        : skill.agentId;
      return skillNpmSuffix === agentId || skillNpmSuffix === npmSuffix;
    })
    .map((s) => s.id)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  // level: "system" skills are
  // globally available to every agent — no LLM call, no DB read.
  const systemSkillIds = catalog.skills
    .filter((skill) => skill.level === "system")
    .map((skill) => skill.id)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  // systemGlobalIds derives from `readSystemGlobalSkillIdsForAgent`, which
  // uses the same unordered catalog read.
  // Sort it too so the tier is deterministic before the union.
  const sortedSystemGlobalIds = [...systemGlobalIds].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );

  // Deduplicated union — agent self-matches first (most specific), then
  // skill_matches results (recommender score DESC), then system globals, then
  // custom assignments. Every tier is now deterministically ordered
  // (catalog tiers by skill id; recommender by score DESC, skill_id ASC;
  // custom assignments by skill_id ASC). The seen-set preserves the earlier
  // position when a skill appears in multiple sources.
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of [
    ...directAgentMatches,
    ...matchedSkillIds,
    ...systemSkillIds,
    ...sortedSystemGlobalIds,
    ...customAssignmentIds,
  ]) {
    if (!seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  // Final lifecycle runtime-delivery gate across the whole deduped union — draft
  // /archived/unknown-state skills are withheld from EVERY tier (fail-closed);
  // derived (NULL) and active/deprecated skills pass.
  return filterToRuntimeDeliverableSkillIds(result);
}

// ===========================================================================
// Observed-parity instrumentation for the dual match store (cinatra #1366 / S8)
// — the OBSERVATION half only. Colocated here (rather than a new module) so it
// derives the canonical projection from the same projectMatchedRowsToAgentSkillMatches
// above and adds no new route-reachable module. It records a report + emits
// divergence telemetry; it NEVER retires, deletes, or removes a dual-write.
// ===========================================================================

const PARITY_REPORT_KEY = "agent_skill_match_parity_report";

/** Bound the persisted sample so the report blob stays small. */
const PARITY_SAMPLE_CAP = 50;

const PAIR_SEP = String.fromCharCode(0);
function pairKey(agentId: string, skillId: string): string {
  return `${agentId}${PAIR_SEP}${skillId}`;
}

export type ParityDiffKind = "missing_in_legacy" | "extra_in_legacy" | "score_mismatch";

export type ParityDiff = {
  agentId: string;
  skillId: string;
  kind: ParityDiffKind;
  canonicalScore: number | null;
  legacyScore: number | null;
};

export type ParityDiffSummary = {
  canonicalCount: number;
  legacyCount: number;
  /** Pairs present in canonical but absent from the legacy snapshot. */
  missingInLegacy: number;
  /** Pairs present in the legacy snapshot but absent from canonical. */
  extraInLegacy: number;
  /** Pairs present in both whose projected score differs. */
  scoreMismatch: number;
  totalDiffs: number;
  /** Capped sample of concrete diffs for the operator surface. */
  sampleDiffs: ParityDiff[];
};

export type ParityReport = ParityDiffSummary & {
  ranAt: string;
  /**
   * Distinct UTC calendar dates (YYYY-MM-DD) observed zero-diff since the last
   * non-zero run. Tracking DATES (not run counts) makes the close condition
   * "7 consecutive days" independent of how often the cron fires.
   */
  zeroDiffDates: string[];
  /** Longest consecutive-day run of zero-diff dates ending at the latest one. */
  consecutiveZeroDiffDays: number;
  /** ISO timestamp of the last run that observed any divergence, else null. */
  lastNonZeroAt: string | null;
};

/**
 * Pure diff. Structured (agentId, skillId) keying — a rename intentionally
 * surfaces as a missing+extra pair, which is a real divergence to observe.
 */
export function buildParityDiff(
  canonical: ReadonlyArray<AgentSkillMatch>,
  legacy: ReadonlyArray<AgentSkillMatch>,
): ParityDiffSummary {
  const canonicalByKey = new Map(canonical.map((m) => [pairKey(m.agentId, m.skillId), m]));
  const legacyByKey = new Map(legacy.map((m) => [pairKey(m.agentId, m.skillId), m]));

  let missingInLegacy = 0;
  let extraInLegacy = 0;
  let scoreMismatch = 0;
  const sampleDiffs: ParityDiff[] = [];
  const pushSample = (d: ParityDiff) => {
    if (sampleDiffs.length < PARITY_SAMPLE_CAP) sampleDiffs.push(d);
  };

  for (const [key, c] of canonicalByKey) {
    const l = legacyByKey.get(key);
    if (!l) {
      missingInLegacy += 1;
      pushSample({ agentId: c.agentId, skillId: c.skillId, kind: "missing_in_legacy", canonicalScore: c.score, legacyScore: null });
      continue;
    }
    if (c.score !== l.score) {
      scoreMismatch += 1;
      pushSample({ agentId: c.agentId, skillId: c.skillId, kind: "score_mismatch", canonicalScore: c.score, legacyScore: l.score });
    }
  }
  for (const [key, l] of legacyByKey) {
    if (!canonicalByKey.has(key)) {
      extraInLegacy += 1;
      pushSample({ agentId: l.agentId, skillId: l.skillId, kind: "extra_in_legacy", canonicalScore: null, legacyScore: l.score });
    }
  }

  const totalDiffs = missingInLegacy + extraInLegacy + scoreMismatch;
  return {
    canonicalCount: canonical.length,
    legacyCount: legacy.length,
    missingInLegacy,
    extraInLegacy,
    scoreMismatch,
    totalDiffs,
    sampleDiffs,
  };
}

function utcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Longest consecutive-day run ending at the latest date in a sorted set. */
function consecutiveDaysEndingAtLatest(sortedDates: string[]): number {
  if (sortedDates.length === 0) return 0;
  const DAY_MS = 86_400_000;
  let run = 1;
  for (let i = sortedDates.length - 1; i > 0; i -= 1) {
    const cur = Date.parse(`${sortedDates[i]}T00:00:00Z`);
    const prev = Date.parse(`${sortedDates[i - 1]}T00:00:00Z`);
    if (cur - prev === DAY_MS) run += 1;
    else break;
  }
  return run;
}

/**
 * Pure streak reducer. A zero-diff run adds today's UTC date to the set (dedup)
 * and recomputes the consecutive-day streak; any divergence clears the set and
 * stamps `lastNonZeroAt`.
 */
export function computeZeroDiffStreak(
  prior: { zeroDiffDates: string[]; lastNonZeroAt: string | null },
  totalDiffs: number,
  now: Date,
): { zeroDiffDates: string[]; consecutiveZeroDiffDays: number; lastNonZeroAt: string | null } {
  if (totalDiffs > 0) {
    return { zeroDiffDates: [], consecutiveZeroDiffDays: 0, lastNonZeroAt: now.toISOString() };
  }
  const set = new Set(prior.zeroDiffDates);
  set.add(utcDate(now));
  const zeroDiffDates = [...set].sort();
  return {
    zeroDiffDates,
    consecutiveZeroDiffDays: consecutiveDaysEndingAtLatest(zeroDiffDates),
    lastNonZeroAt: prior.lastNonZeroAt,
  };
}

// ---------------------------------------------------------------------------
// Persistence (connector_config KV — no migration)
// ---------------------------------------------------------------------------

export function readParityReport(): ParityReport | null {
  return readConnectorConfigFromDatabase<{ report: ParityReport | null }>(PARITY_REPORT_KEY, {
    report: null,
  }).report;
}

function writeParityReport(report: ParityReport): void {
  writeConnectorConfigToDatabase(PARITY_REPORT_KEY, { report });
}

// ---------------------------------------------------------------------------
// Job runner
// ---------------------------------------------------------------------------

export type ParityObservationDeps = {
  /** Fresh canonical projection (read-only; never mirror-written). */
  loadCanonical?: () => Promise<AgentSkillMatch[]>;
  /** The persisted legacy snapshot. */
  loadLegacy?: () => Promise<AgentSkillMatch[]>;
  readReport?: () => ParityReport | null;
  writeReport?: (report: ParityReport) => void;
  now?: () => Date;
};

/**
 * Compute the FRESH canonical projection from the same inputs
 * `matchAgentsToSkills()` uses — WITHOUT the mirror write. Fail closed: a
 * false-empty read would report the whole legacy store as divergent, so the
 * agents reader throws on error.
 */
async function defaultLoadCanonical(): Promise<AgentSkillMatch[]> {
  const [agents, skillCatalog, matchedRows] = await Promise.all([
    readAgentsForSkillMatching({ throwOnError: true }),
    readSkillsCatalog(),
    skillMatchesStore.readAllMatched(),
  ]);
  const liveSkillIds = new Set(skillCatalog.skills.map((s) => s.id));
  return projectMatchedRowsToAgentSkillMatches(agents, liveSkillIds, matchedRows).matches;
}

async function defaultLoadLegacy(): Promise<AgentSkillMatch[]> {
  return (await readAgentSkillMatches()).matches;
}

/**
 * Run one parity observation: compute the fresh canonical projection, read the
 * legacy snapshot, diff them, update the zero-diff-day streak, persist the
 * report, and emit divergence telemetry. Returns the report. Observation only —
 * never retires or deletes anything.
 */
export async function runAgentSkillMatchParityObservation(
  deps: ParityObservationDeps = {},
): Promise<ParityReport> {
  const now = deps.now ?? (() => new Date());
  const loadCanonical = deps.loadCanonical ?? defaultLoadCanonical;
  const loadLegacy = deps.loadLegacy ?? defaultLoadLegacy;
  const readReport = deps.readReport ?? readParityReport;
  const writeReport = deps.writeReport ?? writeParityReport;

  const [canonical, legacy] = await Promise.all([loadCanonical(), loadLegacy()]);
  const summary = buildParityDiff(canonical, legacy);
  const nowDate = now();
  const prior = readReport();
  const streak = computeZeroDiffStreak(
    { zeroDiffDates: prior?.zeroDiffDates ?? [], lastNonZeroAt: prior?.lastNonZeroAt ?? null },
    summary.totalDiffs,
    nowDate,
  );

  const report: ParityReport = { ...summary, ranAt: nowDate.toISOString(), ...streak };
  writeReport(report);

  // Divergence telemetry — mirrors the maintenance / drift structured log
  // events so parity rides the same log-scrape pipeline. warn on divergence,
  // info on a clean run (so progress toward the close condition is visible).
  const payload = JSON.stringify({
    event: "agent-skill-match-parity",
    ranAt: report.ranAt,
    canonicalCount: report.canonicalCount,
    legacyCount: report.legacyCount,
    missingInLegacy: report.missingInLegacy,
    extraInLegacy: report.extraInLegacy,
    scoreMismatch: report.scoreMismatch,
    totalDiffs: report.totalDiffs,
    consecutiveZeroDiffDays: report.consecutiveZeroDiffDays,
  });
  if (report.totalDiffs > 0) console.warn(payload);
  else console.info(payload);

  return report;
}
