// Filesystem scanner for the ownership-first skills layout.
//
// Walks `data/skills/` and yields one record per SKILL.md found. Inferred
// identity is populated from the path; fields that require a DB lookup
// (agent_template_id, vendor when path doesn't encode it) are left null
// and the caller resolves them.

import "server-only";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

import { RESERVED_SUBBUCKETS, RESERVED_TOP_LEVEL, type BindingScope, type OwnerScope } from "./skill-paths";

export interface ScannedSkill {
  abs_path: string;                   // absolute directory path containing SKILL.md
  skill_md_path: string;              // absolute path to SKILL.md
  inferred_identity: InferredIdentity;
  has_moving_marker: boolean;         // true if any ancestor up to the owner dir has .cinatra-moving.json
}

export interface InferredIdentity {
  owner_scope: OwnerScope;
  owner_segment_slugs: string[];      // raw slugs from the path, in order
  binding_scope: BindingScope;
  vendor: string | null;
  package: string | null;
  agent_package_name: string | null;  // agent-bound only — equals "vendor/package" combined
  skill_slug: string;
  project_slug: string | null;
}

export interface ScannerWarning {
  kind: "unknown_top_level" | "unknown_subbucket" | "vendor_with_tilde" | "missing_skill_md" | "marker_present";
  abs_path: string;
  detail: string;
}

const SKILL_MD_NAME = "SKILL.md";
const MOVING_MARKER = ".cinatra-moving.json";

/**
 * Walk the skills root and yield one entry per SKILL.md found. Emits warnings
 * via the (optional) callback for invalid top-level or sub-bucket names.
 *
 * @param root absolute path to `data/skills/` (or whatever
 *             `getSkillsDataRootPath()` returns)
 */
export async function* scanSkillsRoot(
  root: string,
  warn?: (w: ScannerWarning) => void,
): AsyncGenerator<ScannedSkill> {
  if (!existsSync(root)) return;
  const topEntries = await readdir(root, { withFileTypes: true });

  for (const entry of topEntries) {
    if (!entry.isDirectory()) continue;
    if (!RESERVED_TOP_LEVEL.has(entry.name)) {
      warn?.({
        kind: "unknown_top_level",
        abs_path: path.join(root, entry.name),
        detail: `top-level dir "${entry.name}" is not one of ${[...RESERVED_TOP_LEVEL].join("|")}`,
      });
      continue;
    }
    const topAbs = path.join(root, entry.name);
    yield* walkOwnerLevel(topAbs, entry.name as OwnerScope, [], false, warn);
  }
}

/**
 * Walk an owner-level directory (`personal/<user-slug>/`,
 * `organization/<org-slug>/`, `workspace/`, etc.).
 *
 * Within an owner-level dir, children are either:
 *   - reserved sub-bucket marker (~agents, ~teams, ~projects)
 *   - vendor namespace (no `~` prefix)
 */
async function* walkOwnerLevel(
  ownerLevelDir: string,
  scope: OwnerScope,
  ownerSlugs: string[],
  inheritedMarker: boolean,
  warn?: (w: ScannerWarning) => void,
): AsyncGenerator<ScannedSkill> {
  if (scope === "workspace") {
    // workspace is the leaf-level owner dir directly; no per-id segment
    yield* walkInsideOwner(ownerLevelDir, "workspace", [], inheritedMarker, warn);
    return;
  }

  // personal/<user>/ or organization/<org>/ — each child is an owner id
  if (!existsSync(ownerLevelDir)) return;
  const children = await readdir(ownerLevelDir, { withFileTypes: true });
  for (const child of children) {
    if (!child.isDirectory()) continue;
    if (child.name.startsWith("~")) {
      warn?.({
        kind: "unknown_subbucket",
        abs_path: path.join(ownerLevelDir, child.name),
        detail: `${scope} level expects per-id segment, found reserved-prefix "${child.name}"`,
      });
      continue;
    }
    const ownerAbs = path.join(ownerLevelDir, child.name);
    const slugs = [...ownerSlugs, child.name];
    const hasMarker = inheritedMarker || existsSync(path.join(ownerAbs, MOVING_MARKER));
    if (hasMarker && !inheritedMarker) {
      warn?.({ kind: "marker_present", abs_path: ownerAbs, detail: `${MOVING_MARKER} found — skipping subtree` });
      continue;
    }
    yield* walkInsideOwner(ownerAbs, scope, slugs, hasMarker, warn);
  }
}

/**
 * Walk children of an owner directory (the dir that already identifies an
 * owner, e.g. `personal/alice/` or `organization/acme/`). At this point,
 * children fall into 4 buckets:
 *   ~agents/<vendor>/<package>/<skill>/SKILL.md       (binding = agent)
 *   ~teams/<team-slug>/...                            (recurse, scope becomes team)
 *   ~projects/<project-slug>/...                      (recurse with project segment)
 *   <vendor>/<package>/<skill>/SKILL.md               (binding = owner)
 */
async function* walkInsideOwner(
  ownerAbs: string,
  scope: OwnerScope,
  ownerSlugs: string[],
  marker: boolean,
  warn?: (w: ScannerWarning) => void,
): AsyncGenerator<ScannedSkill> {
  if (!existsSync(ownerAbs)) return;
  const children = await readdir(ownerAbs, { withFileTypes: true });

  for (const child of children) {
    if (!child.isDirectory()) continue;
    if (child.name === MOVING_MARKER) continue; // shouldn't be a dir but guard

    const childAbs = path.join(ownerAbs, child.name);

    if (child.name.startsWith("~")) {
      if (!RESERVED_SUBBUCKETS.has(child.name)) {
        warn?.({
          kind: "unknown_subbucket",
          abs_path: childAbs,
          detail: `unknown reserved sub-bucket "${child.name}"`,
        });
        continue;
      }
      if (child.name === "~agents") {
        yield* walkAgentsBucket(childAbs, scope, ownerSlugs, null, marker, warn);
      } else if (child.name === "~teams") {
        if (scope !== "organization") {
          warn?.({
            kind: "unknown_subbucket",
            abs_path: childAbs,
            detail: `~teams is only valid inside organization (got scope=${scope})`,
          });
          continue;
        }
        yield* walkTeamsBucket(childAbs, ownerSlugs, marker, warn);
      } else if (child.name === "~projects") {
        yield* walkProjectsBucket(childAbs, scope, ownerSlugs, marker, warn);
      }
    } else {
      // Vendor namespace — walk vendor/package/skill_slug
      yield* walkVendorTree(childAbs, child.name, scope, ownerSlugs, null, "owner", marker, warn);
    }
  }
}

/** Walk ~agents/<vendor>/<package>/<skill>/SKILL.md inside an owner. */
async function* walkAgentsBucket(
  agentsAbs: string,
  scope: OwnerScope,
  ownerSlugs: string[],
  projectSlug: string | null,
  marker: boolean,
  warn?: (w: ScannerWarning) => void,
): AsyncGenerator<ScannedSkill> {
  if (!existsSync(agentsAbs)) return;
  const vendors = await readdir(agentsAbs, { withFileTypes: true });
  for (const vendor of vendors) {
    if (!vendor.isDirectory()) continue;
    if (vendor.name.startsWith("~")) {
      warn?.({
        kind: "vendor_with_tilde",
        abs_path: path.join(agentsAbs, vendor.name),
        detail: `vendor names must not start with '~' (got "${vendor.name}")`,
      });
      continue;
    }
    yield* walkVendorTree(
      path.join(agentsAbs, vendor.name),
      vendor.name,
      scope,
      ownerSlugs,
      projectSlug,
      "agent",
      marker,
      warn,
    );
  }
}

/** Walk ~teams/<team-slug>/... — recurses with scope='team'. */
async function* walkTeamsBucket(
  teamsAbs: string,
  ownerSlugs: string[],
  marker: boolean,
  warn?: (w: ScannerWarning) => void,
): AsyncGenerator<ScannedSkill> {
  if (!existsSync(teamsAbs)) return;
  const teams = await readdir(teamsAbs, { withFileTypes: true });
  for (const team of teams) {
    if (!team.isDirectory()) continue;
    if (team.name.startsWith("~")) {
      warn?.({ kind: "unknown_subbucket", abs_path: path.join(teamsAbs, team.name), detail: `team slug starts with '~'` });
      continue;
    }
    const teamAbs = path.join(teamsAbs, team.name);
    const hasMarker = marker || existsSync(path.join(teamAbs, MOVING_MARKER));
    if (hasMarker && !marker) {
      warn?.({ kind: "marker_present", abs_path: teamAbs, detail: `${MOVING_MARKER} found — skipping team` });
      continue;
    }
    yield* walkInsideOwner(teamAbs, "team", [...ownerSlugs, team.name], hasMarker, warn);
  }
}

/** Walk ~projects/<project-slug>/... — recurses with project_slug set. */
async function* walkProjectsBucket(
  projectsAbs: string,
  scope: OwnerScope,
  ownerSlugs: string[],
  marker: boolean,
  warn?: (w: ScannerWarning) => void,
): AsyncGenerator<ScannedSkill> {
  if (!existsSync(projectsAbs)) return;
  const projects = await readdir(projectsAbs, { withFileTypes: true });
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    if (project.name.startsWith("~")) {
      warn?.({ kind: "unknown_subbucket", abs_path: path.join(projectsAbs, project.name), detail: `project slug starts with '~'` });
      continue;
    }
    const projectAbs = path.join(projectsAbs, project.name);
    const hasMarker = marker || existsSync(path.join(projectAbs, MOVING_MARKER));
    if (hasMarker && !marker) {
      warn?.({ kind: "marker_present", abs_path: projectAbs, detail: `${MOVING_MARKER} found — skipping project` });
      continue;
    }
    // Inside a project: same children as inside an owner (vendor namespace,
    // ~agents, or further nested ~projects/~teams). We recurse via
    // walkInsideOwner but set scope='project' and accumulate the project slug.
    yield* walkInsideProject(projectAbs, scope, ownerSlugs, project.name, hasMarker, warn);
  }
}

/** Variant of walkInsideOwner that's "inside a project" — passes project_slug through. */
async function* walkInsideProject(
  projectAbs: string,
  parentScope: OwnerScope,
  ownerSlugs: string[],
  projectSlug: string,
  marker: boolean,
  warn?: (w: ScannerWarning) => void,
): AsyncGenerator<ScannedSkill> {
  if (!existsSync(projectAbs)) return;
  const children = await readdir(projectAbs, { withFileTypes: true });
  for (const child of children) {
    if (!child.isDirectory()) continue;
    const childAbs = path.join(projectAbs, child.name);
    if (child.name.startsWith("~")) {
      if (!RESERVED_SUBBUCKETS.has(child.name)) {
        warn?.({ kind: "unknown_subbucket", abs_path: childAbs, detail: `unknown reserved sub-bucket "${child.name}" inside project` });
        continue;
      }
      if (child.name === "~agents") {
        yield* walkAgentsBucket(childAbs, "project", ownerSlugs, projectSlug, marker, warn);
      } else {
        warn?.({ kind: "unknown_subbucket", abs_path: childAbs, detail: `${child.name} not supported inside ~projects` });
      }
    } else {
      yield* walkVendorTree(childAbs, child.name, "project", ownerSlugs, projectSlug, "owner", marker, warn);
    }
  }
}

/** Walk a vendor dir → package dir → skill dir → SKILL.md. */
async function* walkVendorTree(
  vendorAbs: string,
  vendor: string,
  scope: OwnerScope,
  ownerSlugs: string[],
  projectSlug: string | null,
  binding: BindingScope,
  marker: boolean,
  warn?: (w: ScannerWarning) => void,
): AsyncGenerator<ScannedSkill> {
  if (!existsSync(vendorAbs)) return;
  const packages = await readdir(vendorAbs, { withFileTypes: true });
  for (const pkg of packages) {
    if (!pkg.isDirectory()) continue;
    const pkgAbs = path.join(vendorAbs, pkg.name);
    const skills = await readdir(pkgAbs, { withFileTypes: true });
    for (const skillDir of skills) {
      if (!skillDir.isDirectory()) continue;
      const skillAbs = path.join(pkgAbs, skillDir.name);
      const skillMdPath = path.join(skillAbs, SKILL_MD_NAME);
      const hasInnerMarker = existsSync(path.join(skillAbs, MOVING_MARKER));
      if (hasInnerMarker && !marker) {
        warn?.({ kind: "marker_present", abs_path: skillAbs, detail: `${MOVING_MARKER} found — skipping skill` });
        continue;
      }
      if (!existsSync(skillMdPath)) {
        warn?.({ kind: "missing_skill_md", abs_path: skillAbs, detail: `no SKILL.md in ${skillAbs}` });
        continue;
      }
      yield {
        abs_path: skillAbs,
        skill_md_path: skillMdPath,
        inferred_identity: {
          owner_scope: scope,
          owner_segment_slugs: ownerSlugs,
          binding_scope: binding,
          vendor,
          package: pkg.name,
          agent_package_name: binding === "agent" ? `${vendor}/${pkg.name}` : null,
          skill_slug: skillDir.name,
          project_slug: projectSlug,
        },
        has_moving_marker: marker || hasInnerMarker,
      };
    }
  }
}
