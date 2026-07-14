/**
 * Bundle identity, config, and the directory walk.
 *
 * Identity: `memory init` writes a `bundle.yaml` config file at the bundle
 * root with a generated stable `bundleId` (UUID). The `bundleId` is immutable
 * thereafter — init refuses to touch an existing config — and is the identity
 * basis for sync.
 *
 * Walk: reads every non-reserved `.md` file as a concept. Hard-nonconformant
 * files (missing `type`, unparseable YAML, no frontmatter) are skipped with
 * structured diagnostics and the rest of the bundle loads. Reserved `log.md`
 * files are skipped when reading. Symlinks are never followed. Caps bound
 * per-file bytes and per-bundle concept count.
 */
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  buildMemoryConcept,
  parseMemoryConceptSource,
  splitMemoryFrontmatter,
} from "./concept.ts";
import { exclusiveWriteMemoryFile } from "./fs-safe.ts";
import { generateMemoryIndexMarkdown } from "./index-file.ts";
import {
  DEFAULT_MEMORY_CAPS,
  MemoryError,
  type MemoryBundle,
  type MemoryBundleConfig,
  type MemoryCaps,
  type MemoryConcept,
  type MemoryDiagnostic,
  type MemoryTree,
} from "./types.ts";

/** Config filename at the bundle root. */
export const MEMORY_BUNDLE_CONFIG_FILENAME = "bundle.yaml";

/** Reserved (non-concept) markdown filenames at any level of the hierarchy. */
export const MEMORY_RESERVED_FILENAMES: ReadonlySet<string> = new Set([
  "index.md",
  "log.md",
]);

/** The OKF version this library implements. */
export const MEMORY_FORMAT_OKF_VERSION = "0.1";

/** Options accepted by {@link initMemoryBundle}. */
export interface InitMemoryBundleOptions {
  /** Optional display name recorded in bundle.yaml. */
  name?: string;
}

/**
 * Initialize a new memory bundle at `root`: create the directory, write
 * `bundle.yaml` with a fresh `bundleId`, and write an initial root `index.md`
 * declaring the OKF version. Refuses to run on an already-initialized bundle.
 */
export function initMemoryBundle(
  root: string,
  options: InitMemoryBundleOptions = {},
): MemoryBundleConfig {
  const configPath = path.join(root, MEMORY_BUNDLE_CONFIG_FILENAME);
  const config: MemoryBundleConfig = {
    bundleId: randomUUID(),
    ...(options.name === undefined ? {} : { name: options.name }),
    caps: DEFAULT_MEMORY_CAPS,
  };
  const configDoc: Record<string, unknown> = { bundleId: config.bundleId };
  if (config.name !== undefined) configDoc["name"] = config.name;
  // Exclusive create (O_EXCL): two concurrent inits can never both succeed,
  // and an existing bundle's identity is never overwritten.
  try {
    exclusiveWriteMemoryFile(
      configPath,
      stringifyYaml(configDoc, { lineWidth: 0 }),
      root,
    );
  } catch (error) {
    if (error instanceof MemoryError && error.message.includes("already exists")) {
      throw new MemoryError(
        `bundle already initialized (${configPath} exists); the bundleId is immutable`,
      );
    }
    throw error;
  }
  // Seed the root index only when absent — init on a directory that already
  // holds markdown must not clobber user content.
  if (!existsSync(path.join(root, "index.md"))) {
    exclusiveWriteMemoryFile(
      path.join(root, "index.md"),
      generateMemoryIndexMarkdown([], { okfVersion: MEMORY_FORMAT_OKF_VERSION }),
      root,
    );
  }
  return config;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function readCap(
  doc: Record<string, unknown>,
  key: keyof MemoryCaps,
  fallback: number,
): number {
  const caps = doc["caps"];
  if (!isPlainRecord(caps)) return fallback;
  const value = caps[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    if (value !== undefined) {
      throw new MemoryError(
        `bundle.yaml caps.${key} must be a positive integer`,
      );
    }
    return fallback;
  }
  return value;
}

/** Load and validate the bundle config file at `root`. */
export function loadMemoryBundleConfig(root: string): MemoryBundleConfig {
  const configPath = path.join(root, MEMORY_BUNDLE_CONFIG_FILENAME);
  let source: string;
  try {
    // A committed/persisted symlink in place of bundle.yaml must never
    // redirect the read outside the bundle (untrusted bundle content).
    if (lstatSync(configPath).isSymbolicLink()) {
      throw new MemoryError(
        `${MEMORY_BUNDLE_CONFIG_FILENAME} at ${root} is a symlink; refusing to follow it`,
      );
    }
    source = readFileSync(configPath, "utf8");
  } catch (error) {
    if (error instanceof MemoryError) throw error;
    throw new MemoryError(
      `not a memory bundle: missing ${MEMORY_BUNDLE_CONFIG_FILENAME} at ${root} (run \`memory init\`)`,
    );
  }
  let doc: unknown;
  try {
    doc = parseYaml(source);
  } catch (error) {
    throw new MemoryError(
      `invalid ${MEMORY_BUNDLE_CONFIG_FILENAME}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isPlainRecord(doc)) {
    throw new MemoryError(
      `invalid ${MEMORY_BUNDLE_CONFIG_FILENAME}: expected a YAML mapping`,
    );
  }
  const bundleId = doc["bundleId"];
  if (typeof bundleId !== "string" || bundleId.trim() === "") {
    throw new MemoryError(
      `invalid ${MEMORY_BUNDLE_CONFIG_FILENAME}: bundleId must be a non-empty string`,
    );
  }
  const name = typeof doc["name"] === "string" ? doc["name"] : undefined;
  return {
    bundleId,
    ...(name === undefined ? {} : { name }),
    caps: {
      maxConceptFileBytes: readCap(
        doc,
        "maxConceptFileBytes",
        DEFAULT_MEMORY_CAPS.maxConceptFileBytes,
      ),
      maxConceptsPerBundle: readCap(
        doc,
        "maxConceptsPerBundle",
        DEFAULT_MEMORY_CAPS.maxConceptsPerBundle,
      ),
    },
  };
}

/** Options accepted by {@link walkMemoryTree}. */
export interface WalkMemoryTreeOptions {
  /** Caps to enforce; defaults to {@link DEFAULT_MEMORY_CAPS}. */
  caps?: MemoryCaps;
  /**
   * When true, the exact raw bytes each concept was parsed from are returned
   * in {@link MemoryTree.sources} — the manifest hashes THOSE bytes, so a
   * file changing between validation and hashing cannot poison the ledger.
   */
  captureSources?: boolean;
}

interface WalkedFile {
  relPath: string;
  absPath: string;
  bytes: number;
}

function unreadableDiagnostic(relPath: string, error: unknown): MemoryDiagnostic {
  return {
    severity: "error",
    code: "file-unreadable",
    path: relPath,
    message: `could not be read: ${error instanceof Error ? error.message : String(error)}`,
  };
}

function collectFiles(
  root: string,
  dirRel: string,
  diagnostics: MemoryDiagnostic[],
  out: WalkedFile[],
): void {
  const dirAbs = path.join(root, dirRel);
  const entries = readdirSync(dirAbs, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const relPath = dirRel === "" ? entry.name : `${dirRel}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      diagnostics.push({
        severity: "warning",
        code: "symlink-skipped",
        path: relPath,
        message: "symlinks are never followed when reading a bundle",
      });
      continue;
    }
    try {
      if (entry.isDirectory()) {
        collectFiles(root, relPath, diagnostics, out);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        out.push({
          relPath,
          absPath: path.join(dirAbs, entry.name),
          bytes: statSync(path.join(dirAbs, entry.name)).size,
        });
      }
    } catch (error) {
      // One unreadable or vanished entry must not abort the whole walk.
      diagnostics.push(unreadableDiagnostic(relPath, error));
    }
  }
}

function readIndexFrontmatter(
  file: WalkedFile,
  diagnostics: MemoryDiagnostic[],
): string | undefined {
  const source = readFileSync(file.absPath, "utf8");
  const split = splitMemoryFrontmatter(source);
  if (!split) return undefined;
  if (file.relPath !== "index.md") {
    diagnostics.push({
      severity: "warning",
      code: "index-frontmatter-invalid",
      path: file.relPath,
      message:
        "frontmatter is only permitted in the bundle-root index.md (okf_version declaration)",
    });
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(split.frontmatterText);
  } catch {
    diagnostics.push({
      severity: "warning",
      code: "index-frontmatter-invalid",
      path: file.relPath,
      message: "root index.md frontmatter YAML does not parse",
    });
    return undefined;
  }
  if (parsed === null || parsed === undefined) {
    diagnostics.push({
      severity: "warning",
      code: "index-frontmatter-invalid",
      path: file.relPath,
      message: "root index.md has an empty frontmatter block",
    });
    return undefined;
  }
  if (!isPlainRecord(parsed)) {
    diagnostics.push({
      severity: "warning",
      code: "index-frontmatter-invalid",
      path: file.relPath,
      message: "root index.md frontmatter must be a YAML mapping",
    });
    return undefined;
  }
  const keys = Object.keys(parsed);
  const extra = keys.filter((k) => k !== "okf_version");
  if (extra.length > 0) {
    diagnostics.push({
      severity: "warning",
      code: "index-frontmatter-invalid",
      path: file.relPath,
      message: `root index.md frontmatter may only declare okf_version (found: ${extra.join(", ")})`,
    });
  }
  const version = parsed["okf_version"];
  if (version === undefined) return undefined;
  if (typeof version !== "string" && typeof version !== "number") {
    diagnostics.push({
      severity: "warning",
      code: "index-frontmatter-invalid",
      path: file.relPath,
      message: "root index.md okf_version must be a string (e.g. \"0.1\")",
    });
    return undefined;
  }
  return String(version);
}

/**
 * Walk any OKF-format directory tree (no bundle config required) and return
 * its concepts, diagnostics, and declared format version. Concepts are sorted
 * lexicographically by bundle-relative path.
 */
export function walkMemoryTree(
  root: string,
  options: WalkMemoryTreeOptions = {},
): MemoryTree {
  const caps = options.caps ?? DEFAULT_MEMORY_CAPS;
  const diagnostics: MemoryDiagnostic[] = [];
  const walked: WalkedFile[] = [];
  collectFiles(root, "", diagnostics, walked);
  walked.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

  const files = new Set(walked.map((f) => f.relPath));
  const concepts: MemoryConcept[] = [];
  const sources = options.captureSources ? new Map<string, Buffer>() : undefined;
  let okfVersion: string | undefined;
  let capReported = false;

  for (const file of walked) {
    const basename = path.posix.basename(file.relPath);
    try {
      if (MEMORY_RESERVED_FILENAMES.has(basename)) {
        // Reserved files are never concepts. log.md is skipped entirely when
        // reading; index.md is only inspected for its (root-only) frontmatter.
        if (basename === "index.md") {
          const version = readIndexFrontmatter(file, diagnostics);
          if (version !== undefined) okfVersion = version;
        }
        continue;
      }
      if (file.bytes > caps.maxConceptFileBytes) {
        diagnostics.push({
          severity: "error",
          code: "concept-file-oversize",
          path: file.relPath,
          message: `concept file is ${file.bytes} bytes; cap is ${caps.maxConceptFileBytes} bytes — skipped unread`,
        });
        continue;
      }
      if (concepts.length >= caps.maxConceptsPerBundle) {
        if (!capReported) {
          diagnostics.push({
            severity: "error",
            code: "concept-cap-exceeded",
            path: file.relPath,
            message: `bundle exceeds the cap of ${caps.maxConceptsPerBundle} concepts; further concept files are skipped`,
          });
          capReported = true;
        }
        continue;
      }
      const bytes = readFileSync(file.absPath);
      // Re-verify the cap on the bytes actually read — the pre-read stat may
      // be stale if the file changed underneath the walk.
      if (bytes.byteLength > caps.maxConceptFileBytes) {
        diagnostics.push({
          severity: "error",
          code: "concept-file-oversize",
          path: file.relPath,
          message: `concept file is ${bytes.byteLength} bytes; cap is ${caps.maxConceptFileBytes} bytes`,
        });
        continue;
      }
      const parsed = parseMemoryConceptSource(bytes.toString("utf8"));
      if (!parsed.ok) {
        diagnostics.push({
          severity: "error",
          code: parsed.code,
          path: file.relPath,
          message: parsed.message,
        });
        continue;
      }
      concepts.push(buildMemoryConcept(file.relPath, parsed));
      sources?.set(file.relPath, bytes);
    } catch (error) {
      diagnostics.push(unreadableDiagnostic(file.relPath, error));
    }
  }

  return {
    concepts,
    diagnostics,
    ...(okfVersion === undefined ? {} : { okfVersion }),
    files,
    ...(sources === undefined ? {} : { sources }),
  };
}

/** Load a full bundle: config (required) plus the walked tree. */
export function loadMemoryBundle(root: string): MemoryBundle {
  const config = loadMemoryBundleConfig(root);
  const tree = walkMemoryTree(root, { caps: config.caps });
  return { root, config, ...tree };
}

/**
 * Locate the nearest memory bundle for a working directory: `dir` itself when
 * it holds a bundle.yaml, else the closest `.memory/bundle.yaml` walking up
 * the directory tree. Returns the bundle root, or undefined.
 */
export function findMemoryBundleRoot(startDir: string): string | undefined {
  let dir = path.resolve(startDir);
  if (existsSync(path.join(dir, MEMORY_BUNDLE_CONFIG_FILENAME))) return dir;
  for (;;) {
    const candidate = path.join(dir, ".memory", MEMORY_BUNDLE_CONFIG_FILENAME);
    let stat;
    try {
      stat = lstatSync(candidate);
    } catch {
      stat = undefined;
    }
    if (stat?.isFile()) return path.join(dir, ".memory");
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
