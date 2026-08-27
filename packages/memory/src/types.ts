/**
 * Shared types for the memory bundle library.
 *
 * A memory bundle is an Open Knowledge Format (OKF 0.1) directory tree —
 * Markdown concept files with YAML frontmatter — plus a `bundle.yaml` config
 * file at the bundle root carrying the bundle's stable identity.
 *
 * All exported symbols use Memory naming; "OKF" appears only where the file
 * format itself is being named.
 */

/** Severity of a structured diagnostic emitted while reading a bundle. */
export type MemoryDiagnosticSeverity = "error" | "warning";

/** Machine-readable diagnostic codes. */
export type MemoryDiagnosticCode =
  /** Non-reserved .md file with no YAML frontmatter block. */
  | "frontmatter-missing"
  /** Frontmatter block present but the YAML does not parse (or is not a mapping). */
  | "frontmatter-unparseable"
  /** Frontmatter parses but has no non-empty string `type` field. */
  | "type-missing"
  /** Concept file exceeds the per-file byte cap; skipped unread. */
  | "concept-file-oversize"
  /** A file or directory could not be read (permissions, vanished mid-walk). */
  | "file-unreadable"
  /** Bundle holds more concept files than the per-bundle cap; the excess is skipped. */
  | "concept-cap-exceeded"
  /** Symlink encountered during the walk; never followed. */
  | "symlink-skipped"
  /** index.md frontmatter outside the root index, or with keys beyond okf_version. */
  | "index-frontmatter-invalid"
  /** A bundle-internal markdown link whose target file does not exist. */
  | "broken-link";

/**
 * A structured diagnostic. Hard-nonconformant files are skipped with an
 * `error` diagnostic and the rest of the bundle loads — the format spec marks
 * such files nonconformant without prescribing recovery; skip-with-diagnostics
 * is this implementation's policy.
 */
export interface MemoryDiagnostic {
  severity: MemoryDiagnosticSeverity;
  code: MemoryDiagnosticCode;
  /** Bundle-relative POSIX path of the offending file. */
  path: string;
  message: string;
}

/** Resource caps applied when reading and writing bundles. */
export interface MemoryCaps {
  /** Maximum size of a single concept file, in bytes. */
  maxConceptFileBytes: number;
  /** Maximum number of concept files in one bundle. */
  maxConceptsPerBundle: number;
}

/** Default caps: 64 KiB per concept file, 2,000 concepts per bundle. */
export const DEFAULT_MEMORY_CAPS: MemoryCaps = {
  maxConceptFileBytes: 64 * 1024,
  maxConceptsPerBundle: 2000,
};

/** Contents of the bundle config file (`bundle.yaml`) at the bundle root. */
export interface MemoryBundleConfig {
  /**
   * Stable bundle identity (a generated UUID). Immutable after `init`; the
   * identity basis for sync.
   */
  bundleId: string;
  /** Optional human-readable display name. */
  name?: string;
  /** Effective caps (config values merged over the defaults). */
  caps: MemoryCaps;
  /**
   * Sync-time binding + scope DEFAULTS (cinatra#1378), absent when the bundle
   * declares no `sync:` block. Defaults only: never a grant, and never a
   * reason to write anything on its own.
   */
  sync?: MemorySyncBinding;
}

/** One concept document: a Markdown file with YAML frontmatter. */
export interface MemoryConcept {
  /** Concept ID: the bundle-relative file path with the `.md` suffix removed. */
  id: string;
  /** Bundle-relative file path (POSIX separators). */
  path: string;
  /** The required frontmatter `type` field (non-empty). */
  type: string;
  /** Optional display name from frontmatter. */
  title?: string;
  /** Optional one-line summary from frontmatter. */
  description?: string;
  /** Frontmatter tags (string entries only). */
  tags: string[];
  /**
   * The full parsed frontmatter mapping in document order, including unknown
   * producer-defined keys.
   */
  frontmatter: Record<string, unknown>;
  /**
   * The exact header bytes as read from disk (opening delimiter line through
   * closing delimiter line). Serialization re-emits this verbatim —
   * byte-perfect round-trip, including comments, key order, newline style,
   * and any exotic YAML the parsed mapping cannot represent. A caller that
   * modifies `frontmatter` must drop this field so the mapping is
   * re-serialized instead.
   */
  headerSource?: string;
  /** The Markdown body: the exact bytes after the closing frontmatter delimiter line. */
  body: string;
}

/** Result of walking a bundle directory tree (no config required). */
export interface MemoryTree {
  /** Conformant concepts, sorted lexicographically by bundle-relative path. */
  concepts: MemoryConcept[];
  /** Diagnostics for everything skipped or suspicious. */
  diagnostics: MemoryDiagnostic[];
  /** `okf_version` declared in the root index.md frontmatter, if any. */
  okfVersion?: string;
  /** Every .md file seen in the tree (including reserved and skipped files). */
  files: Set<string>;
  /**
   * Exact raw bytes each concept was parsed from, keyed by path. Present only
   * when the walk ran with `captureSources` (the manifest hashes these bytes,
   * never a re-read of the file).
   */
  sources?: Map<string, Buffer>;
}

/** A fully loaded bundle: config + tree. */
export interface MemoryBundle extends MemoryTree {
  /** Absolute path of the bundle root directory. */
  root: string;
  config: MemoryBundleConfig;
}

/** A markdown link extracted from a concept body. */
export interface MemoryLink {
  /** Link text. */
  text: string;
  /** Raw link target as written. */
  target: string;
  /**
   * Link classification: `absolute` = bundle-root form (`/...`), `relative` =
   * standard relative path, `external` = URL with a scheme (never resolved).
   */
  kind: "absolute" | "relative" | "external";
  /**
   * Bundle-relative resolved target path for internal links. Undefined for
   * external links and for relative links that escape the bundle root.
   */
  resolvedPath?: string;
}

/** Content-hash manifest for a bundle — the basis for the sync ledger. */
export interface MemoryManifest {
  manifestFormat: 1;
  bundleId: string;
  /** Concept file path → content hash of the raw file bytes. */
  concepts: Record<string, { sha256: string; bytes: number }>;
}

/** Base error class for the memory library. */
export class MemoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryError";
  }
}

/** A write escaped (or would escape) the bundle root, or crossed a symlink. */
export class MemoryContainmentError extends MemoryError {
  constructor(message: string) {
    super(message);
    this.name = "MemoryContainmentError";
  }
}

/** A configured resource cap was exceeded. */
export class MemoryCapError extends MemoryError {
  constructor(message: string) {
    super(message);
    this.name = "MemoryCapError";
  }
}

// ---------------------------------------------------------------------------
// Sync (cinatra#1378, epic #1373) — one-way, local bundle → objects rows.
// ---------------------------------------------------------------------------

/** Ownership level a bundle/concept may REQUEST for a newly created row. */
export type MemoryScopeOwnerLevel = "user" | "team" | "organization" | "workspace";

/** Visibility a bundle/concept may REQUEST for a newly created row. */
export type MemoryScopeVisibility = "private" | "team" | "organization" | "public";

/**
 * A scope REQUEST — never a grant.
 *
 * Both fields are evaluated under the caller's normal authorization at save
 * time. The server's memory ownership-authority gate resolves the LEVEL against
 * the authenticated actor and fills the owning principal in from that actor; a
 * level whose authority is not derivable there (`team`, `workspace`) and a
 * `public` visibility are REFUSED, not silently downgraded. Widening an
 * EXISTING row is promotion, not a save.
 *
 * `orgId` and `ownerId` are deliberately absent from this type and from every
 * surface that builds it (cinatra#1378 review item 4). Both name a PRINCIPAL,
 * and a principal is derived from the authenticated caller on the server — no
 * objects primitive reads one from a memory bundle. A bundle file or a concept
 * that names either is refused loudly (see `parseMemorySyncBinding` and
 * `memoryConceptScopeRefusals`), because dropping it silently would let the
 * author believe the sync landed somewhere it did not.
 */
export interface MemoryScopeRequest {
  ownerLevel?: MemoryScopeOwnerLevel;
  visibility?: MemoryScopeVisibility;
}

/**
 * The `sync:` block of `bundle.yaml`: the bundle's sync-time DEFAULTS.
 *
 * A bundle is a distribution unit and a sync-time default only (epic #1373).
 * Per-concept frontmatter may request a different scope; the precedence is
 * `bundle default < per-concept frontmatter`, and the result is still only a
 * request.
 */
export interface MemorySyncBinding {
  /**
   * Target project binding for rows this bundle syncs.
   * - `undefined` — no binding is sent; the server applies its ordinary
   *   (ambient) rule, which for an external CLI caller resolves to no project.
   * - `string` — sent as `objects_save.projectId`; the server authorizes it
   *   against the caller's own project grants and refuses what it cannot.
   */
  projectId?: string;
  /** Default scope requested for rows this bundle CREATES. */
  defaultScope: MemoryScopeRequest;
}

/** How a sync run classified one local concept. */
export type MemorySyncAction =
  /** No row found in the preflight: `objects_save` will insert. */
  | "create"
  /** A row exists and its stored envelope differs from the local file. */
  | "update"
  /** A row exists and already carries this exact content: no write at all. */
  | "skip"
  /** Refused locally, before any network write (e.g. a secret-scan hit). */
  | "blocked";

/** One classified concept in a sync plan. */
export interface MemorySyncItem {
  /** Bundle-relative POSIX path of the concept file. */
  path: string;
  /** Concept id (path minus the `.md` suffix) — the identity basis. */
  conceptId: string;
  /** `sha256(UTF-8(bundleId + NUL + conceptId))`, recomputed by the server. */
  externalId: string;
  action: MemorySyncAction;
  /** Human-readable reason, always present for `skip` and `blocked`. */
  reason: string;
  /** Object id of the existing row, when the preflight found one. */
  objectId?: string;
  /** Diagnostics attached to this concept (secret hits, scope notes). */
  diagnostics: MemorySyncDiagnostic[];
}

/** A concept that the ledger knows was synced but whose file is now gone. */
export interface MemorySyncOrphan {
  path: string;
  conceptId: string;
  objectId?: string;
}

/** Severity of a sync diagnostic. */
export type MemorySyncDiagnosticSeverity = "error" | "warning" | "info";

/** Machine-readable sync diagnostic codes. */
export type MemorySyncDiagnosticCode =
  /** A credential-shaped literal was found in the concept; never uploaded. */
  | "secret-detected"
  /** The local secret scanner could not complete; the concept is not sent. */
  | "secret-scan-failed"
  /** The remote row is wider than the bundle default; sync preserved it. */
  | "scope-preserved"
  /** The remote row is bound to a different project than the bundle asks for. */
  | "project-binding-conflict"
  /** A ledger entry has no local file: sync never deletes remote rows. */
  | "orphan-retained"
  /** The ledger says "already synced" but the stored row no longer matches. */
  | "ledger-stale"
  /** The server refused this concept; the refusal text is carried verbatim. */
  | "server-refused"
  /**
   * The concept's frontmatter carries a scope key a bundle may not supply
   * (`ownerId` — cinatra#1378 review item 4). Refused loudly rather than
   * dropped, so the author is never left believing the sync landed under an
   * owner it did not.
   */
  | "scope-key-refused";

/** A structured diagnostic emitted by a sync run. */
export interface MemorySyncDiagnostic {
  severity: MemorySyncDiagnosticSeverity;
  code: MemorySyncDiagnosticCode;
  /** Bundle-relative POSIX path of the concept the diagnostic is about. */
  path: string;
  message: string;
}

/** The full classification of a sync run, before any write. */
export interface MemorySyncPlan {
  bundleId: string;
  items: MemorySyncItem[];
  orphans: MemorySyncOrphan[];
  diagnostics: MemorySyncDiagnostic[];
}

/** Outcome of an executed (non-dry-run) sync. */
export interface MemorySyncResult {
  plan: MemorySyncPlan;
  created: number;
  updated: number;
  skipped: number;
  blocked: number;
  failed: number;
  /** Diagnostics produced while writing (server refusals). */
  diagnostics: MemorySyncDiagnostic[];
}

/** Per-bundle sync ledger: the local content-hash record of what was synced. */
export interface MemorySyncLedger {
  ledgerFormat: 1;
  bundleId: string;
  /** Concept file path → what the last successful sync pushed. */
  entries: Record<string, { sha256: string; objectId: string }>;
}

/** A sync run was refused before it started (bad binding, no transport, …). */
export class MemorySyncError extends MemoryError {
  constructor(message: string) {
    super(message);
    this.name = "MemorySyncError";
  }
}
