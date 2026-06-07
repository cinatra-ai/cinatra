/**
 * Sibling-file credential scanning for agent packages.
 *
 * The deterministic OAS lint scans `oas.json` body only. Sibling files
 * inside a package directory (`SKILL.md`, `package.json`, `*.ts`, scripts,
 * etc.) are NOT scanned by `validateOasAgentJson`. A leaked credential in
 * any of those files would still ship to Verdaccio.
 *
 * This module is the file-system half: it walks a package root, picks
 * "publishable text files", and reuses `detectCredentialPattern` from
 * validate-agent-json.ts to flag literal credentials. It is intentionally
 * separate from the validator so the validator stays pure / sync.
 *
 * Policy:
 * - Scan every UTF-8 text file under the package root, skipping known
 *   generated dirs + known binary extensions + symlinks (anti-escape).
 * - Lockfile-aware: skip generic entropy noise on `package-lock.json` /
 *   `pnpm-lock.yaml` / `yarn.lock` / `npm-shrinkwrap.json` (integrity hashes
 *   false-positive); still flag credential prefixes + JWTs on those files.
 * - Block non-example `.env*` files outright — even an empty `.env` is a
 *   smell. `.env.example` is allowed and scanned.
 * - Cap per-file scan size at 1 MB — emit a `warning`, never silently skip.
 * - The canonical OAS file (`cinatra/oas.json` / `cinatra/agent.json` at the
 *   package root) is skipped here — covered by the OAS scanner. Nested
 *   copies at any other path (e.g. `examples/agent.json`) ARE scanned;
 *   see CANONICAL_OAS_RELPATHS below.
 * - Locations are deterministic: alphabetical traversal order, POSIX
 *   separators, `<relPath>:<lineNum>` format.
 * - Findings NEVER echo the matched secret — only the pattern label and
 *   the file:line location.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { detectCredentialPattern, type ReviewFinding } from "./validate-agent-json";

// ---------------------------------------------------------------------------
// Policy constants
// ---------------------------------------------------------------------------

/** Directories never walked — generated artifacts + VCS + lockfile noise. */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  ".cache",
  ".pnpm",
  "coverage",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".venv",
  "venv",
]);

/** Binary file extensions (case-insensitive). Skipped from scanning. */
export const BINARY_EXTS: ReadonlySet<string> = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".bmp",
  ".tiff",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".tgz",
  ".bz2",
  ".rar",
  ".7z",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".mp4",
  ".mov",
  ".webm",
  ".mkv",
  ".mp3",
  ".wav",
  ".ogg",
  ".flac",
  ".bin",
  ".dat",
  ".db",
  ".sqlite",
  ".so",
  ".dylib",
  ".dll",
  ".class",
  ".jar",
  ".wasm",
]);

/** Lockfile basenames — generic entropy scan is disabled on these files. */
export const LOCKFILE_BASENAMES: ReadonlySet<string> = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "npm-shrinkwrap.json",
  "composer.lock",
  "Gemfile.lock",
  "Cargo.lock",
  "poetry.lock",
  "uv.lock",
]);

/**
 * Canonical relative paths of the agent's structured OAS file inside the
 * package root — handled by the OAS scanner, so we don't double-scan them.
 *
 * These MUST be path-exact, not basename-only. Basename-only matching would
 * skip any file named `oas.json` / `agent.json` anywhere under the package,
 * leaving `examples/agent.json`, `tests/fixtures/oas.json`, etc. unscanned.
 * Only the canonical `cinatra/oas.json` and `cinatra/agent.json` are exempt.
 */
const CANONICAL_OAS_RELPATHS: ReadonlySet<string> = new Set([
  "cinatra/oas.json",
  "cinatra/agent.json",
]);

/** Cap per-file scan size (bytes). Larger files get a `warning` finding. */
export const MAX_SCAN_BYTES = 1_048_576;

// ---------------------------------------------------------------------------
// .env file policy
// ---------------------------------------------------------------------------

/**
 * Non-example `.env*` files are blocked outright in published packages.
 * `.env.example`, `.env.sample`, `.env.template`, or any `*.example` are
 * allowed and scanned. An empty or placeholder-filled `.env` is still
 * blocked — even "clean" .env files should not ship.
 */
export function isBlockedEnvFile(basename: string): boolean {
  if (!basename.startsWith(".env")) return false;
  const lower = basename.toLowerCase();
  if (lower === ".env.example" || lower.endsWith(".example") || lower.endsWith(".sample") || lower.endsWith(".template")) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// File entry + walker
// ---------------------------------------------------------------------------

export interface PackageFileEntry {
  /** Absolute path on disk. */
  absPath: string;
  /** Relative POSIX path from the package root (no leading "./"). */
  relPath: string;
  /** File size in bytes. */
  size: number;
  /** True if extension matches a known binary type. */
  isBinary: boolean;
  /** True if basename matches a lockfile (skip generic entropy). */
  isLockfile: boolean;
  /** True if basename is a forbidden `.env*` file. */
  isEnvBlocked: boolean;
  /**
   * True if this file's relative path matches the canonical OAS location
   * (`cinatra/oas.json` or `cinatra/agent.json`). Basename matching is too
   * broad — nested copies (examples/, fixtures/, docs/) MUST still be scanned.
   */
  isCanonicalOasFile: boolean;
}

/**
 * Recursively list every regular file under `rootAbs` that is a candidate
 * for publishing/scanning. Skips known generated dirs, symlinks (anti-escape),
 * and known binary extensions are TAGGED but still returned (callers decide
 * whether to scan / publish them). Returns in deterministic alphabetical
 * order for reproducible test output.
 */
export async function walkPackageFiles(rootAbs: string): Promise<PackageFileEntry[]> {
  const out: PackageFileEntry[] = [];

  async function walk(dirAbs: string, relDir: string): Promise<void> {
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean; isSymbolicLink: () => boolean }>;
    try {
      entries = (await fs.readdir(dirAbs, { withFileTypes: true })) as unknown as typeof entries;
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const childAbs = path.join(dirAbs, entry.name);
      const childRel = relDir.length === 0 ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(childAbs, childRel);
        continue;
      }
      if (!entry.isFile()) continue;
      let size: number;
      try {
        const stat = await fs.stat(childAbs);
        size = stat.size;
      } catch {
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      out.push({
        absPath: childAbs,
        relPath: childRel,
        size,
        isBinary: BINARY_EXTS.has(ext),
        isLockfile: LOCKFILE_BASENAMES.has(entry.name),
        isEnvBlocked: isBlockedEnvFile(entry.name),
        isCanonicalOasFile: CANONICAL_OAS_RELPATHS.has(childRel),
      });
    }
  }

  await walk(rootAbs, "");
  return out;
}

// ---------------------------------------------------------------------------
// Sibling-file credential scan
// ---------------------------------------------------------------------------

/** Patterns that mark a line as lockfile-integrity noise — skipped on lockfiles. */
const LOCKFILE_NOISE_LINE_PATTERNS: RegExp[] = [
  /^\s*"(integrity|resolved|shasum|_resolved|_integrity|hash|hashSum)"\s*:/i,
  /sha\d+-[A-Za-z0-9+/=]+/,
  /tarball-[A-Za-z0-9]+\.tgz/,
];

/**
 * Scan sibling text files under `packageRootAbs` for literal credentials.
 *
 * Reuses `detectCredentialPattern` from validate-agent-json.ts — the same
 * pattern set + placeholder skip-list that the OAS scan uses, so the policy
 * is consistent across the OAS body and the rest of the package.
 *
 * Returns ReviewFinding[]:
 * - `code: "literal_credential_in_sibling_file"`, severity `"blocker"` for
 *   matches in regular text files.
 * - `code: "package_env_file_forbidden"`, severity `"blocker"` for any
 *   non-example `.env*` file (regardless of content).
 * - `code: "package_file_too_large_to_scan"`, severity `"warning"` for files
 *   above the 1 MB scan cap.
 *
 * Findings NEVER echo the matched secret string — only the pattern label
 * and `<relPath>:<lineNum>` location.
 */
export async function scanPackageSiblingFilesForLiteralSecrets(
  packageRootAbs: string,
): Promise<ReviewFinding[]> {
  const findings: ReviewFinding[] = [];
  const files = await walkPackageFiles(packageRootAbs);

  for (const file of files) {
    if (file.isEnvBlocked) {
      findings.push({
        code: "package_env_file_forbidden",
        severity: "blocker",
        message: `Non-example .env file is forbidden in published packages: ${file.relPath}. Move credentials to /settings/connections (Nango).`,
        location: file.relPath,
        source: "deterministic",
      });
      continue;
    }
    if (file.isCanonicalOasFile) continue;
    if (file.isBinary) continue;
    if (file.size > MAX_SCAN_BYTES) {
      findings.push({
        code: "package_file_too_large_to_scan",
        severity: "warning",
        message: `File ${file.relPath} is ${file.size} bytes — larger than the ${MAX_SCAN_BYTES}-byte scan cap. Manual review recommended.`,
        location: file.relPath,
        source: "deterministic",
      });
      continue;
    }

    let content: string;
    try {
      content = await fs.readFile(file.absPath, "utf8");
    } catch {
      continue;
    }

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line || line.length === 0) continue;
      if (file.isLockfile) {
        // Lockfile-aware filtering: skip integrity/checksum/registry noise that
        // would false-positive entropy scoring, but STILL run detection on
        // remaining lines so credential prefixes + JWTs are caught.
        let skip = false;
        for (const re of LOCKFILE_NOISE_LINE_PATTERNS) {
          if (re.test(line)) {
            skip = true;
            break;
          }
        }
        if (skip) continue;
      }
      const pattern = detectCredentialPattern(line);
      if (pattern) {
        findings.push({
          code: "literal_credential_in_sibling_file",
          severity: "blocker",
          message: `literal credential detected in ${file.relPath}:${i + 1}: pattern=${pattern}`,
          location: `${file.relPath}:${i + 1}`,
          source: "deterministic",
        });
      }
    }
  }

  return findings;
}
