/**
 * Write paths: add a concept (one file per insight) and regenerate the root
 * index. All writes are atomic, containment-checked against the bundle root,
 * and capped (per-file bytes + per-bundle concept count).
 */
import { existsSync } from "node:fs";
import * as path from "node:path";

import {
  loadMemoryBundleConfig,
  MEMORY_RESERVED_FILENAMES,
  walkMemoryTree,
} from "./bundle.ts";
import { memoryConceptIdFromPath, serializeMemoryConcept } from "./concept.ts";
import {
  assertMemoryWriteContained,
  atomicWriteMemoryFile,
  exclusiveWriteMemoryFile,
  normalizeMemoryRelPath,
} from "./fs-safe.ts";
import { generateMemoryIndexMarkdown } from "./index-file.ts";
import { MemoryCapError, MemoryError } from "./types.ts";

/** Input for {@link addMemoryConcept}. One concept file per insight. */
export interface AddMemoryConceptInput {
  /**
   * The kind of insight, captured in frontmatter `type` — e.g. Convention,
   * Correction, Command, Debugging Insight. Required (the only required
   * frontmatter field).
   */
  type: string;
  /** Display title. Required unless an explicit `path` is given. */
  title?: string;
  /** One-line summary. */
  description?: string;
  /** Cross-cutting tags. */
  tags?: string[];
  /** Markdown body (may be empty; the frontmatter can carry the insight). */
  body?: string;
  /**
   * Bundle-relative target path ending in `.md`. Defaults to
   * `<slug(type)>/<slug(title)>.md`.
   */
  path?: string;
  /**
   * ISO 8601 `timestamp` frontmatter value. Defaults to now; pass null to
   * omit the field entirely (e.g. for byte-deterministic writes).
   */
  timestamp?: string | null;
  /** Additional producer-defined frontmatter keys (never overrides the core keys). */
  extraFrontmatter?: Record<string, unknown>;
}

/** Result of {@link addMemoryConcept}. */
export interface AddMemoryConceptResult {
  /** Concept ID (path without the .md suffix). */
  id: string;
  /** Bundle-relative path written. */
  path: string;
}

/** Slugify a display string into a filesystem-safe path segment. */
export function memorySlug(value: string): string {
  // Each non-alphanumeric RUN collapses to a single "-", so at most one
  // leading and one trailing dash remain — strip them without quantifiers
  // (linear-time; no backtracking on adversarial input).
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-/, "")
    .replace(/-$/, "");
  if (slug === "") {
    throw new MemoryError(
      `cannot derive a path segment from ${JSON.stringify(value)}`,
    );
  }
  return slug;
}

function resolveTargetPath(input: AddMemoryConceptInput): string {
  if (input.path !== undefined) {
    const normalized = normalizeMemoryRelPath(input.path);
    if (!normalized.endsWith(".md")) {
      throw new MemoryError(
        `concept path must end with .md (got ${JSON.stringify(input.path)})`,
      );
    }
    if (MEMORY_RESERVED_FILENAMES.has(path.posix.basename(normalized))) {
      throw new MemoryError(
        `${path.posix.basename(normalized)} is a reserved filename and cannot be a concept`,
      );
    }
    return normalized;
  }
  if (input.title === undefined || input.title.trim() === "") {
    throw new MemoryError("either a title or an explicit path is required");
  }
  return `${memorySlug(input.type)}/${memorySlug(input.title)}.md`;
}

/**
 * Add one concept to the bundle at `root`: validate + contain the target
 * path, enforce caps, write atomically, then regenerate the root index.
 * Refuses to overwrite an existing concept.
 */
export function addMemoryConcept(
  root: string,
  input: AddMemoryConceptInput,
): AddMemoryConceptResult {
  if (typeof input.type !== "string" || input.type.trim() === "") {
    throw new MemoryError("a non-empty `type` is required");
  }
  const config = loadMemoryBundleConfig(root);
  const relPath = resolveTargetPath(input);
  const absPath = assertMemoryWriteContained(root, relPath);
  if (existsSync(absPath)) {
    throw new MemoryError(
      `concept ${relPath} already exists; one concept file per insight — pick a new path`,
    );
  }

  const frontmatter: Record<string, unknown> = { type: input.type };
  if (input.title !== undefined) frontmatter["title"] = input.title;
  if (input.description !== undefined) {
    frontmatter["description"] = input.description;
  }
  if (input.tags !== undefined && input.tags.length > 0) {
    frontmatter["tags"] = input.tags;
  }
  if (input.timestamp !== null) {
    frontmatter["timestamp"] = input.timestamp ?? new Date().toISOString();
  }
  for (const [key, value] of Object.entries(input.extraFrontmatter ?? {})) {
    if (!(key in frontmatter)) frontmatter[key] = value;
  }

  const body = input.body ?? "";
  const source = serializeMemoryConcept({
    frontmatter,
    body: body === "" || body.endsWith("\n") ? body : `${body}\n`,
  });
  const bytes = Buffer.byteLength(source, "utf8");
  if (bytes > config.caps.maxConceptFileBytes) {
    throw new MemoryCapError(
      `concept would be ${bytes} bytes; cap is ${config.caps.maxConceptFileBytes} bytes per concept file`,
    );
  }
  const tree = walkMemoryTree(root, { caps: config.caps });
  if (tree.concepts.length + 1 > config.caps.maxConceptsPerBundle) {
    throw new MemoryCapError(
      `bundle already holds ${tree.concepts.length} concepts; cap is ${config.caps.maxConceptsPerBundle} per bundle`,
    );
  }

  // Exclusive create (O_EXCL): a concept file is never overwritten, even by
  // two adds racing for the same path.
  try {
    exclusiveWriteMemoryFile(absPath, source, root);
  } catch (error) {
    if (error instanceof MemoryError && error.message.includes("already exists")) {
      throw new MemoryError(
        `concept ${relPath} already exists; one concept file per insight — pick a new path`,
      );
    }
    throw error;
  }
  regenerateMemoryIndex(root);
  return { id: memoryConceptIdFromPath(relPath), path: relPath };
}

/**
 * Deterministically regenerate the bundle-root `index.md` from the current
 * tree, preserving the root index's existing `okf_version` declaration.
 * Returns the generated source.
 *
 * The index is a DERIVED artifact: under concurrent adds the last writer
 * wins, which can leave it momentarily stale — the next regeneration (or the
 * next add) reconverges it, and consumers tolerate a stale or missing index
 * by design (the format permits synthesizing one on the fly).
 */
export function regenerateMemoryIndex(root: string): string {
  const config = loadMemoryBundleConfig(root);
  const tree = walkMemoryTree(root, { caps: config.caps });
  const source = generateMemoryIndexMarkdown(tree.concepts, {
    ...(tree.okfVersion === undefined ? {} : { okfVersion: tree.okfVersion }),
  });
  atomicWriteMemoryFile(path.join(root, "index.md"), source, root);
  return source;
}
