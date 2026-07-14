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
