import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";

// ---------------------------------------------------------------------------
// SUPPLIED-PACKAGE PROVENANCE (cinatra#3204 D2) — the content digest, its
// canonical-tree encoding, and the explicit source discriminant that replaces
// the name-shape heuristics.
//
// It lives IN this leaf barrel rather than in a sibling module on purpose: the
// route-graph ratchet counts every first-party module reachable from the locked
// routes, and this barrel is already on all of them. A sibling file would have
// added a module to four locked route graphs to hold ~200 lines of
// dependency-free constants — the leaf package is exactly the right home for
// them, and this keeps the graph pressure at zero.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SUPPLIED-PACKAGE PROVENANCE + THE CONTENT DIGEST (cinatra#3204 D2).
//
// A package the operator SUPPLIES — an archive they hold, or a repository they
// point at — carries no registry attestation. Its two non-registry source types
// (`local`, `github`) could not carry a digest over the delivered bytes at all:
// `github` recorded a `resolvedSha` and `local` a `resolvedCommitOrTreeHash`,
// and both of those are REVISION identifiers. A revision identifier answers
// "which commit was this taken from"; it does NOT answer "are these the bytes
// that were read, previewed and approved". Those are different questions, and
// only the second one is a trust input.
//
// So this module defines ONE digest, common to both supplied source types:
// `contentDigest`. It is deliberately NOT a Git object id (see
// CONTENT_DIGEST_DISTINCTNESS below), and it is deliberately NOT the store's
// `<digest>` path segment (that is a sha512 over the tarball FRAMING; this is a
// hash over the delivered TREE, so it survives a repack).
//
// This file is the dependency-inversion leaf on purpose: the archive reader
// (packages/agents), the dispatcher (packages/extensions) and the skill router
// (packages/skills) all depend on `@cinatra-ai/extension-types` already, and all
// three must agree on one grammar. It uses WebCrypto only — no node: imports —
// so the browser-side upload reader can compute the SAME digest the server
// verifies.
// ---------------------------------------------------------------------------

/** The digest algorithm. Hex-encoded sha256 over the canonical tree encoding. */
export const CONTENT_DIGEST_ALGORITHM = "sha256" as const;

/**
 * The canonical-tree ENCODING id, written into the hashed byte stream as a
 * domain-separation prefix. Bump it (never mutate the encoding in place) if the
 * framing below ever changes, so a digest computed under one encoding can never
 * be mistaken for a digest computed under another.
 */
export const CONTENT_DIGEST_ENCODING_ID = "cinatra-extension-tree-v1" as const;

/**
 * WHY THIS IS NOT A GIT COMMIT SHA (the issue's explicit requirement):
 *
 *   - a Git commit id hashes a commit OBJECT — tree id, parents, author,
 *     committer, timestamps and message — so two identical trees under two
 *     different commits give two different ids, and a force-pushed tag can move
 *     one commit id onto entirely different content;
 *   - a Git TREE id hashes Git's own tree encoding (mode + name + raw object
 *     ids) and only exists for content that is in a Git object database;
 *   - THIS digest hashes exactly the file paths and file bytes that were
 *     delivered, and nothing else. It is computable from an archive that was
 *     never in Git, it is stable across repacking and re-zipping, and it is
 *     comparable between what a preview read and what an install materialized.
 *
 * That is the property the upload roads need: preview and install must be able
 * to prove they saw the same bytes.
 */
export const CONTENT_DIGEST_DISTINCTNESS =
  "sha256 over the canonical delivered-tree encoding — not a Git commit or tree object id" as const;

/** Hex sha256 output. */
export const CONTENT_DIGEST_RE = /^[0-9a-f]{64}$/;

/** True for a well-formed content digest (hex sha256). */
export function isContentDigest(value: unknown): value is string {
  return typeof value === "string" && CONTENT_DIGEST_RE.test(value);
}

/** One delivered file: its POSIX-relative path and its exact bytes. */
export type ContentDigestEntry = { path: string; bytes: Uint8Array };

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function u64be(n: number): Uint8Array {
  const out = new Uint8Array(8);
  let value = n;
  for (let i = 7; i >= 0; i--) {
    out[i] = value & 0xff;
    value = Math.floor(value / 256);
  }
  return out;
}

/**
 * THE CANONICAL TREE ENCODING (`cinatra-extension-tree-v1`).
 *
 * Byte stream, in this exact order:
 *
 *   1. the encoding id, UTF-8, followed by one 0x0a;
 *   2. the entry COUNT as an 8-byte big-endian unsigned integer;
 *   3. for each entry, in ascending order of the UTF-8 bytes of its path:
 *        a. the path's byte length as 8-byte big-endian,
 *        b. the path's UTF-8 bytes,
 *        c. the content's byte length as 8-byte big-endian,
 *        d. the content bytes, verbatim.
 *
 * Every field is LENGTH-PREFIXED, so no path or content can be crafted to
 * impersonate a different tree by embedding a separator: the encoding has no
 * separators to embed. Paths sort by their UTF-8 bytes (not by a locale
 * collation), so the ordering is the same in every runtime. Duplicate paths are
 * a refusal, not a merge — a tree that names the same path twice has no single
 * meaning, and silently keeping one of the two is exactly how a preview and an
 * install end up disagreeing.
 */
export function encodeCanonicalTree(entries: readonly ContentDigestEntry[]): Uint8Array {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.path)) {
      throw new Error(
        `[content-digest] the tree names "${entry.path}" more than once — a duplicate path has no single canonical encoding; refusing to digest it.`,
      );
    }
    seen.add(entry.path);
  }

  const sorted = [...entries].sort((a, b) => {
    const ab = utf8(a.path);
    const bb = utf8(b.path);
    const n = Math.min(ab.length, bb.length);
    for (let i = 0; i < n; i++) {
      if (ab[i] !== bb[i]) return ab[i] - bb[i];
    }
    return ab.length - bb.length;
  });

  const chunks: Uint8Array[] = [utf8(`${CONTENT_DIGEST_ENCODING_ID}\n`), u64be(sorted.length)];
  for (const entry of sorted) {
    const pathBytes = utf8(entry.path);
    chunks.push(u64be(pathBytes.length), pathBytes, u64be(entry.bytes.length), entry.bytes);
  }

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}

/** Hex-encode bytes (lower case). */
function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * Compute the content digest over a delivered tree: hex sha256 of
 * `encodeCanonicalTree(entries)`.
 *
 * WebCrypto only, so the same function runs in the upload form's browser bundle
 * and in the host — one implementation, therefore one answer. A host that has no
 * WebCrypto is a refusal, not a fallback to a weaker hash.
 */
export async function computeContentDigest(
  entries: readonly ContentDigestEntry[],
): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      "[content-digest] WebCrypto (crypto.subtle) is unavailable — refusing to compute a supplied package's content digest without it.",
    );
  }
  const encoded = encodeCanonicalTree(entries);
  const digest = await subtle.digest("SHA-256", encoded as unknown as ArrayBuffer);
  return toHex(new Uint8Array(digest));
}

// ---------------------------------------------------------------------------
// EXPLICIT PROVENANCE — the replacement for the name-shape heuristics
// ---------------------------------------------------------------------------

/**
 * A package the operator supplied, with the digest over what was delivered.
 *
 * `local`  — an archive supplied by file. `path` names where the immutable
 *            snapshot was staged; it is NOT an identity (two uploads of the
 *            same bytes stage at two paths and share one `contentDigest`).
 * `github` — a repository, pinned to `resolvedSha`. The SHA says which commit
 *            was fetched; `contentDigest` says which bytes arrived.
 *
 * `contentDigest` is REQUIRED on both. A supplied source without one cannot be
 * driven through the install pipeline (see the host's supplied entry) — which is
 * the whole point: honest provenance means provenance you can check.
 */
export type SuppliedPackageProvenance =
  | {
      type: "local";
      path: string;
      contentDigest: string;
      /** Carried through when the snapshot came from a working tree that had one. */
      resolvedCommitOrTreeHash?: string;
    }
  | {
      type: "github";
      repo: string;
      ref: string;
      resolvedSha: string;
      contentDigest: string;
      path?: string;
    };

/** Provenance a `PackageRef` may DECLARE — registry, or one of the supplied kinds. */
export type PackageRefProvenance = { type: "verdaccio" } | SuppliedPackageProvenance;

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Structural check for supplied provenance, digest grammar included. */
export function isSuppliedPackageProvenance(value: unknown): value is SuppliedPackageProvenance {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (!isContentDigest(v.contentDigest)) return false;
  if (v.type === "local") return nonEmpty(v.path);
  if (v.type === "github") return nonEmpty(v.repo) && nonEmpty(v.ref) && nonEmpty(v.resolvedSha);
  return false;
}

/** Structural check for any declared ref provenance. */
export function isPackageRefProvenance(value: unknown): value is PackageRefProvenance {
  if (!value || typeof value !== "object") return false;
  if ((value as Record<string, unknown>).type === "verdaccio") return true;
  return isSuppliedPackageProvenance(value);
}

/**
 * The one-line human description of where a package came from. Never says
 * "registry" for a supplied package — provenance is reported as it is, not as
 * the shape the row happens to be stored in.
 */
export function describeSuppliedProvenance(provenance: SuppliedPackageProvenance): string {
  return provenance.type === "local"
    ? `supplied file (content digest ${provenance.contentDigest})`
    : `${provenance.repo} at ${provenance.resolvedSha} (content digest ${provenance.contentDigest})`;
}

// ---------------------------------------------------------------------------
// Public types shared by extension packages for dependency inversion.
// ---------------------------------------------------------------------------

export type PackageRef = {
  registryUrl: string;
  packageName: string;
  version?: string;
  /**
   * EXPLICIT provenance (cinatra#3204 D2). When a caller knows where the
   * package came from it SAYS SO here, and every router downstream switches on
   * this discriminant instead of guessing from the package NAME.
   *
   * The guess it replaces classified a ref as registry-backed when the name was
   * scoped OR a version was present, so a scoped local package — or any local
   * ref carrying a version — was misread as registry-backed. A name is not a
   * source; this field is.
   *
   * Absent means "the caller did not say", and the legacy name-shape fallback
   * still applies for those refs, unchanged. It is a compatibility path, not a
   * discriminator.
   */
  provenance?: PackageRefProvenance;
};

export type ValidationResult = {
  valid: boolean;
  errors?: string[];
};

export type Actor = PrimitiveActorContext;

/**
 * Minimal projection of an `installed_extension` manifest row — the UNIFORM
 * active-gate identity the runtime-discovery dispatcher hands to a kind's
 * reader facet. The full canonical row lives in `@cinatra-ai/extensions`; this
 * leaf type stays dependency-free for the dep-inversion boundary.
 *
 * `status` is the effective lifecycle status; the dispatcher only ever passes
 * rows in the DISCOVERABLE set (`active` | `locked`).
 */
export type ActiveExtensionManifest = {
  id: string;
  packageName: string;
  /** One of the five canonical kinds: agent | connector | artifact | skill | workflow. */
  kind: string;
  ownerLevel: string;
  ownerId: string | null;
  organizationId: string | null;
  status: string;
};

/**
 * The RESOLVED visibility scope a reader facet uses to choose which native rows
 * the actor may see. It is deliberately NOT derived from `Actor`
 * (`PrimitiveActorContext` is an audit/actor envelope, not a membership
 * envelope): the host resolves this from the session + Better Auth + vendor
 * config and passes it into discovery. A missing/empty scope must FAIL CLOSED to
 * public/platform-only visibility — never "all active".
 *
 * The `installed_extension` active gate is only a coarse *lifecycle* candidate
 * set ("is this package/kind live?"); per-kind native readers are the authority
 * for "may this actor see this row?" and apply this scope.
 */
export type ExtensionDiscoveryScope = {
  userId: string | null;
  organizationId: string | null;
  teamIds: string[];
  projectIds?: string[];
  /** npm vendor scope whose private rows the actor may see (e.g. "@acme-private"). */
  vendorScope?: string | null;
  platformRole?: "platform_admin" | "member";
  /**
   * The actor's Better Auth role in their active org. Threaded through so the
   * manifest gate admits an org_owner/org_admin to EVERY row anchored to their
   * org (organization / team / user owner levels) — the catalog/list-side mirror
   * of the P1 evaluator's `hasAdminStandingOverExtension`. Absent ⇒ treated as a
   * plain member (fail closed: no admin standing).
   */
  orgRole?: "org_owner" | "org_admin" | "member";
};

export interface ExtensionTypeHandler {
  typeId: string;
  /** options.destination selects the publish registry ("private" | "public").
   *  The parameter is optional for backward compatibility; implementations
   *  that do not need destination routing can omit it. */
  install(
    ref: PackageRef,
    actor: Actor,
    options?: { destination?: "private" | "public" },
  ): Promise<void>;
  update(ref: PackageRef, actor: Actor): Promise<void>;
  uninstall(ref: PackageRef, actor: Actor): Promise<void>;
  archive(ref: PackageRef, actor: Actor): Promise<void>;
  restore(ref: PackageRef, actor: Actor): Promise<void>;
  validate?(spec: unknown): Promise<ValidationResult>;

  // -------------------------------------------------------------------------
  // Reader facet (true-IoC re-scope).
  //
  // Runtime discovery of "what capabilities are active" flows EXCLUSIVELY
  // through the active-manifest dispatcher → these methods. A kind's native
  // store (agent_templates / skills catalog / object registry / workflow_template)
  // remains the capability authority, but it is read ONLY for the manifests the
  // uniform `installed_extension` gate reports active — never discovered
  // independently (the split-brain guard). `TActive` is the kind's NATIVE
  // descriptor shape (agent template / skill descriptor / object-artifact
  // descriptor / workflow+dashboard descriptor / connector capability set).
  //
  // Optional during the per-kind cutover: a handler that has not yet adopted the
  // facet simply contributes no dynamically-discovered capabilities (its surface
  // stays on the legacy static path until migrated). When every kind implements
  // it and the static lists are deleted, the system is extensible by construction.
  // -------------------------------------------------------------------------

  /**
   * Return this kind's native descriptors that are BOTH visible to `scope` AND
   * lifecycle-live per `manifests` (the coarse status-candidate set). The reader
   * is the VISIBILITY AUTHORITY: it must choose visible rows via the actor's
   * resolved `scope` (e.g. the kind's own vendor/owner-level reader), then keep
   * only those whose package is in the lifecycle-live `manifests` set. It must
   * NOT trust `manifests` for visibility (the manifest gate cannot answer "may
   * this actor see this row").
   */
  listActive?(input: {
    actor: Actor;
    scope: ExtensionDiscoveryScope;
    manifests: ActiveExtensionManifest[];
  }): Promise<unknown[]>;

  /**
   * Archived twin of `listActive` (cinatra#948 — the Installed-extensions
   * management surface lists archived rows for every kind, not just agents).
   * Return this kind's descriptors that are BOTH visible to `scope` AND
   * lifecycle-ARCHIVED per `manifests` (the coarse archived-candidate set,
   * already excluding identities that are still live elsewhere — "live wins").
   * The same visibility-authority contract as `listActive` applies: the reader
   * owns "may this actor see this row"; it must never trust `manifests` for
   * visibility. A kind whose native store retains no archived rows (e.g. the
   * in-memory artifact registry, which deregisters on archive) may fall back to
   * package-level descriptors derived from the scope-visible manifests — that
   * preserves exactly the visibility its `listActive` applies (the shared
   * owner-scope gate), so archived rows are never MORE visible than active ones.
   */
  listArchived?(input: {
    actor: Actor;
    scope: ExtensionDiscoveryScope;
    manifests: ActiveExtensionManifest[];
  }): Promise<unknown[]>;

  /** Return the native descriptor for a single lifecycle-live manifest if it is
   *  visible to `scope`, else null. */
  readActive?(input: {
    actor: Actor;
    scope: ExtensionDiscoveryScope;
    manifest: ActiveExtensionManifest;
  }): Promise<unknown | null>;
}

// ---------------------------------------------------------------------------
// Shared visibility gate for reader facets.
//
// Every kind's reader facet must answer "is this manifest's owner-scope visible
// to the actor?" identically — the manifest gate is a coarse lifecycle-live
// candidate set, and a facet must NOT surface another owner's row just because
// the package name happens to be live somewhere. This leaf-level helper is the
// single source of truth for that rule so connector / artifact / skill / workflow
// readers (whose native catalogs carry no per-owner visibility of their own) all
// gate identically. It FAILS CLOSED: an unknown owner level is never visible.
// ---------------------------------------------------------------------------

/**
 * Does `scope` hold ADMIN STANDING over a manifest owned by `manifestOrgId`?
 * The catalog-side mirror of the P1 evaluator's `hasAdminStandingOverExtension`
 * (`@cinatra-ai/extensions`), expressed purely over the leaf
 * `ExtensionDiscoveryScope` so this package imports no server code:
 *   - a `platform_admin` holds standing over every manifest; and
 *   - an `org_owner`/`org_admin` holds standing over every manifest anchored to
 *     THEIR active org.
 * Keyed on the MANIFEST's own org (not merely the actor's), so it is cross-org
 * safe: an admin of org A never gains standing over an org-B manifest. A manifest
 * with no org (platform/workspace) yields standing only for a platform admin —
 * there is no org to be an admin of (fail closed).
 */
export function scopeHasAdminStandingOverManifest(
  scope: ExtensionDiscoveryScope,
  manifestOrgId: string | null,
): boolean {
  if (scope.platformRole === "platform_admin") return true;
  return (
    manifestOrgId != null &&
    scope.organizationId != null &&
    manifestOrgId === scope.organizationId &&
    (scope.orgRole === "org_owner" || scope.orgRole === "org_admin")
  );
}

/**
 * True iff `manifest`'s owner scope is visible to `scope`.
 *
 * - ADMIN STANDING (checked first): a platform admin, or an org_owner/org_admin
 *   of the manifest's owning org, sees EVERY row of that org regardless of owner
 *   level — so two admins of the same org see the identical catalog. Independent
 *   of the installer pointer / owner level, role-derived (a newly-promoted admin
 *   needs no per-row grant; a demotion reverts it).
 * - `platform` / `workspace`: deployment-wide rows (e.g. bundled, locked
 *   extensions, or the implicit Workspace tier) — visible to every actor.
 * - `organization`: visible only when the actor's active org matches.
 * - `team`: visible only when the actor's active org matches AND the actor
 *   belongs to the owning team.
 * - `user`: visible only to the owning user.
 * - anything else: fail closed (not visible).
 */
export function manifestVisibleToScope(
  manifest: ActiveExtensionManifest,
  scope: ExtensionDiscoveryScope,
): boolean {
  // platform_admin sees every row (mirrors the P1 evaluator's isPlatformAdmin
  // short-circuit, which admits platform admins ahead of every tier check).
  if (scope.platformRole === "platform_admin") return true;

  // org_owner/org_admin standing over the manifest's OWN org. Applied ONLY
  // inside the org-anchored owner levels below (team / user) — an unknown or
  // corrupt owner level stays fail-closed even for an admin (the default case).
  // For `organization` rows the standing is redundant (every same-org member
  // already sees them), so the org-match branch carries it.
  const orgAdminStanding = scopeHasAdminStandingOverManifest(
    scope,
    manifest.organizationId,
  );

  switch (manifest.ownerLevel) {
    case "platform":
    case "workspace":
      // Deployment-wide. The Workspace tier is the implicit platform-instance
      // level (no per-row owner); platform rows are the bundled/locked set.
      return true;
    case "organization":
      return (
        manifest.organizationId != null &&
        scope.organizationId != null &&
        manifest.organizationId === scope.organizationId
      );
    case "team":
      return (
        orgAdminStanding ||
        (manifest.organizationId != null &&
          scope.organizationId != null &&
          manifest.organizationId === scope.organizationId &&
          manifest.ownerId != null &&
          scope.teamIds.includes(manifest.ownerId))
      );
    case "user":
      return (
        orgAdminStanding ||
        (manifest.ownerId != null &&
          scope.userId != null &&
          manifest.ownerId === scope.userId)
      );
    default:
      return false;
  }
}

/**
 * The set of package names from `manifests` that are visible to `scope`. Reader
 * facets intersect their native catalog against this set so a row is surfaced
 * only when it is BOTH lifecycle-live (in `manifests`) AND owner-visible.
 */
export function visibleManifestPackageNames(
  manifests: ActiveExtensionManifest[],
  scope: ExtensionDiscoveryScope,
): Set<string> {
  const names = new Set<string>();
  for (const manifest of manifests) {
    if (manifestVisibleToScope(manifest, scope)) {
      names.add(manifest.packageName);
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// Skill ROLE — the manifest-carried cinatra semantics (cinatra#2089, epic
// #2086 S2).
//
// An Anthropic-clean `SKILL.md` carries only Anthropic-valid frontmatter, so
// every cinatra semantic that used to live there moves to the extension
// manifest. The role is the first of them and the one the injection contract
// (S4, cinatra#2091) binds to:
//
//   - `injectable` — a knowledge/behaviour skill. Counts toward the hard
//     injection cap and is eligible for upload to a provider.
//   - `matcher`    — consumed by artifact/agent MATCHING, never injected as
//     prose into a run.
//   - `internal`   — pipeline-consumed (e.g. the HITL prompt drive core reads
//     by path). NEVER injected, NEVER uploaded.
//
// Declared as `cinatra.skillRole` on a `kind:"skill"` package. The shared
// packaging verdict rejects any other value at CI, store install and publish.
// ---------------------------------------------------------------------------

/** The three roles a skill extension may declare. */
export const SKILL_EXTENSION_ROLES = ["injectable", "matcher", "internal"] as const;

export type SkillExtensionRole = (typeof SKILL_EXTENSION_ROLES)[number];

/**
 * Resolve a skill extension's role from its `cinatra` manifest block.
 *
 * DEFAULT is `injectable`: a skill extension exists to be used by a run, and
 * defaulting to the most restricted role would silently stop today's skills
 * from being delivered. The two restricted roles are opt-in and explicit.
 *
 * TRANSITIONAL: the pre-S2 convention was a boolean `internal: true` on the
 * manifest. That flag is honoured as `internal` so a package that has not yet
 * migrated keeps its meaning; an explicit `skillRole` always wins. (The
 * `chat-hitl-prompt-drive` bundle that motivated the flag now ships in
 * `@cinatra-ai/hitl-prompt-drive-skill` with an explicit
 * `skillRole:"internal"` and is consumed by capability, not by path —
 * cinatra#2090 S3.)
 *
 * An UNKNOWN `skillRole` value resolves to `null` — the caller decides, and the
 * packaging verdict has already refused such a package at every install and
 * publish point, so a null here means a manifest that bypassed the gate.
 */
export function resolveSkillExtensionRole(
  cinatra: Record<string, unknown> | null | undefined,
): SkillExtensionRole | null {
  if (!cinatra || typeof cinatra !== "object") return "injectable";
  const declared = (cinatra as { skillRole?: unknown }).skillRole;
  if (typeof declared === "string") {
    return (SKILL_EXTENSION_ROLES as readonly string[]).includes(declared)
      ? (declared as SkillExtensionRole)
      : null;
  }
  if (declared !== undefined) return null;
  if ((cinatra as { internal?: unknown }).internal === true) return "internal";
  return "injectable";
}
