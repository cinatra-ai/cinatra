// SkillSource — the content-source descriptor for a catalog skill.
//
// `cinatra.skills` stays the unified catalog. Historically a skill's content
// location was its absolute `sourcePath` (a path inside the `data/skills` tree),
// treated as permanent truth. The generalized content store makes
// that path one resolution outcome among several: extension skills resolve to an
// immutable digest snapshot; non-extension skills to a mutable active-head
// revision in the same store. `SkillSource` is the descriptor every content
// reader will resolve through; `sourcePath` remains a legacy fallback locator.
//
// This is a pure-function leaf module — no server-only imports — so it stays
// unit-testable in isolation (same contract the package-source dispatcher keeps).

import { createHash } from "node:crypto";

/** Where a skill's content originates. */
export type SkillSourceOrigin =
  | "extension" // bundled/installed extension package skill (immutable snapshot once recorded)
  | "github" // end-user GitHub-installed skill package
  | "vendored" // Verdaccio/registry-published package (e.g. @anthropics/skills)
  | "custom" // LLM-generated personal/agent delta skill
  | "local"; // a bare on-disk skill with no package identity

/**
 * Revision discriminator. Extension skills are immutable digest snapshots;
 * non-extension skills track a mutable active-head revision. A digest is only
 * present once a source has been explicitly recorded; a derived
 * descriptor (legacy rows with no stored source) is always active-head.
 */
export type SkillSourceRevision =
  | { kind: "digest"; value: string }
  | { kind: "activeHead"; value: string | null };

/**
 * The `{origin, scope, package-ref, digest-or-activeRevision, relativePath}`
 * descriptor. Persisted inside the skill row payload JSON (the `skills` table is
 * `{id, payload}` — no dedicated columns), so adding it is purely additive.
 */
export interface SkillSource {
  origin: SkillSourceOrigin;
  /** Ownership-scope projection (SkillLevel-compatible string), or null. */
  scope: string | null;
  /** Package id / ref for packaged origins; null for purely local/custom skills. */
  packageRef: string | null;
  /** Immutable digest (extension) or mutable active-head revision (non-extension). */
  revision: SkillSourceRevision;
  /** SKILL.md path relative to the package/checkout root, or null when unknown. */
  relativePath: string | null;
}

/**
 * Minimal projection `resolveSkillSource` derives a descriptor from. `PersistedSkill`
 * structurally satisfies this, so the resolver accepts a skill row directly without
 * coupling this leaf module to the server-only store types.
 */
export interface SkillSourceResolvable {
  packageId?: string;
  packageName?: string;
  packageSlug?: string;
  sourcePath?: string;
  sourceUrl?: string;
  originRepo?: string;
  scope?: string;
  isCustom?: boolean;
  isCustomSkill?: boolean;
  /** An explicitly-recorded source (set by later slices / migration); wins over derivation. */
  source?: SkillSource | null;
}

const SKILL_SOURCE_ORIGINS: readonly SkillSourceOrigin[] = [
  "extension",
  "github",
  "vendored",
  "custom",
  "local",
];

/** Runtime guard used when reading a stored payload back into a SkillSource. */
export function isSkillSource(value: unknown): value is SkillSource {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!SKILL_SOURCE_ORIGINS.includes(v.origin as SkillSourceOrigin)) return false;
  if (!(typeof v.scope === "string" || v.scope === null)) return false;
  if (!(typeof v.packageRef === "string" || v.packageRef === null)) return false;
  if (!(typeof v.relativePath === "string" || v.relativePath === null)) return false;
  const rev = v.revision as Record<string, unknown> | undefined;
  if (typeof rev !== "object" || rev === null) return false;
  if (rev.kind === "digest") return typeof rev.value === "string";
  if (rev.kind === "activeHead") return typeof rev.value === "string" || rev.value === null;
  return false;
}

function deriveOrigin(skill: SkillSourceResolvable): SkillSourceOrigin {
  if (skill.isCustomSkill) return "custom";
  const packageId = skill.packageId ?? "";
  if (packageId.startsWith("github:")) return "github";
  if (packageId.startsWith("verdaccio:")) return "vendored";
  // Non-personal user-authored custom skills
  // (team / organization / project scope via upsertCustomSkill or
  // createSkillFromTemplate) are written by `upsertSkill` with
  // packageId = `custom:${packageSlug}` but WITHOUT `isCustomSkill: true`
  // (that flag is reserved for the personal/agent LLM-delta path). Without
  // the "custom:" prefix check, they would be mapped to "extension", so the
  // extension → digest promotion would
  // have mis-tagged user-mutable scoped skills as immutable digest snapshots.
  if (packageId.startsWith("custom:")) return "custom";
  if (skill.originRepo || (skill.sourceUrl && /github\.com/i.test(skill.sourceUrl))) {
    return "github";
  }
  if (packageId || skill.packageName) return "extension";
  return "local";
}

/**
 * Resolve a skill row to its content-source descriptor.
 *
 * An explicitly-recorded `source` always wins. Otherwise a best-effort
 * descriptor is derived from the legacy fields: the origin is classified from
 * the package identity, and the revision is `activeHead` (a derived row carries
 * no immutable digest until one is recorded). `relativePath` is
 * left null for derived rows — content readers fall back to the legacy
 * `sourcePath` until the cutover computes precise relative paths.
 *
 * Returns null only for a row with no usable identity at all.
 */
export function resolveSkillSource(skill: SkillSourceResolvable): SkillSource | null {
  if (skill.source && isSkillSource(skill.source)) return skill.source;
  if (
    !skill.packageId &&
    !skill.packageName &&
    !skill.sourcePath &&
    !skill.isCustomSkill &&
    !skill.originRepo &&
    !skill.sourceUrl
  ) {
    return null;
  }
  return {
    origin: deriveOrigin(skill),
    scope: skill.scope ?? null,
    packageRef: skill.packageId ?? null,
    revision: { kind: "activeHead", value: null },
    relativePath: null,
  };
}

// ---------------------------------------------------------------------------
// Generalized content-store write-side helpers.
//
// `source` is populated on every catalog write via `upsertSkill` so the
// SkillSource descriptor is no longer a derive-on-read approximation — every
// new/updated row carries a real revision (the active-head pointer = sha256 of
// its current content) and (for non-extension skills) a stable relativePath.
// The on-disk write into `data/skills` is unchanged (the legacy mirror stays
// canonical for now); only the row metadata grows the source field.
//
// Extension skills (registerExtensionSkill → upsertSkill) inherit the same
// active-head default; they are later promoted to immutable digest
// revisions once the digest is recorded against the package snapshot.
// ---------------------------------------------------------------------------

/**
 * Compute the SkillSource active-head revision value for a row being written:
 * a full-content sha256 hex digest of `content`. Distinct from the
 * `llm-matching/hashes` `computeSkillContentDigest`, which truncates to 16 KiB
 * for matching-cache stability — that semantic is wrong for revision identity
 * (any byte change anywhere in `content` MUST flip the revision).
 *
 * An empty `content` still produces a deterministic digest (the empty-string
 * sha256), never `null` — `revision.value === null` means "no digest known
 * yet" (derived row from a legacy read), distinct from "content hashes empty".
 */
export function computeSkillSourceRevision(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Inputs the write-side `buildSkillSourceForWrite` derives a SkillSource from.
 * A superset of `SkillSourceResolvable` that ALSO carries the current content
 * (for the digest) and an optional `relativePath` (defaulting to `"SKILL.md"`,
 * the conventional layout where the markdown lives at the skill-dir root).
 */
export interface SkillSourceWriteInput extends SkillSourceResolvable {
  content: string;
  /** SKILL.md path relative to the package/checkout root. Defaults to "SKILL.md". */
  relativePath?: string;
}

/**
 * Build the SkillSource descriptor for a row being written. Reuses
 * `resolveSkillSource`'s origin/scope/packageRef classification, then refines:
 *
 * - `revision`: `origin === "extension"` ⇒ `digest` (immutable
 *   snapshot semantics for extension-bundled skills, including agent-bundled
 *   skills registered via `registerPackageAgentSkill`). Every other origin
 *   (custom, github, vendored, local) keeps the `activeHead` default. Either
 *   way, the value is the full-content sha256 from `computeSkillSourceRevision`.
 *   The TAG distinguishes "this revision is the canonical immutable snapshot"
 *   from "this is the currently-mutable head".
 * - `relativePath`: defaults to `"SKILL.md"` (the conventional skill-dir layout
 *   where every skill has its markdown at the dir root). Callers can override.
 *
 * Returns null only when the row has no usable identity at all — same contract
 * as the read-side resolver — so callers can fall back to legacy `sourcePath`.
 */
export function buildSkillSourceForWrite(input: SkillSourceWriteInput): SkillSource | null {
  const derived = resolveSkillSource(input);
  if (!derived) return null;
  const revisionKind: SkillSourceRevision["kind"] =
    derived.origin === "extension" ? "digest" : "activeHead";
  const revisionValue = computeSkillSourceRevision(input.content);
  return {
    ...derived,
    revision: { kind: revisionKind, value: revisionValue } as SkillSourceRevision,
    relativePath: input.relativePath ?? "SKILL.md",
  };
}
