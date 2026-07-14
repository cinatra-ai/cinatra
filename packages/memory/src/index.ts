/**
 * @cinatra-ai/memory — the filesystem side of the memory subsystem for
 * coding agents.
 *
 * A pure library + local CLI for OKF 0.1 bundles (Markdown + YAML
 * frontmatter): bundle identity, spec-strict parse/serialize/walk with
 * structured diagnostics, deterministic index regeneration, contained atomic
 * writes with caps, a content-hash manifest, and lexical recall. No
 * server-only imports; no LLM calls.
 */
export {
  findMemoryBundleRoot,
  initMemoryBundle,
  loadMemoryBundle,
  loadMemoryBundleConfig,
  MEMORY_BUNDLE_CONFIG_FILENAME,
  MEMORY_FORMAT_OKF_VERSION,
  MEMORY_RESERVED_FILENAMES,
  walkMemoryTree,
  type InitMemoryBundleOptions,
  type WalkMemoryTreeOptions,
} from "./bundle.ts";
export { checkMemoryTree, type MemoryCheckResult } from "./check.ts";
export { runMemoryCli, type MemoryCliIo } from "./cli.ts";
export {
  buildMemoryConcept,
  memoryConceptIdFromPath,
  parseMemoryConceptSource,
  serializeMemoryConcept,
  splitMemoryFrontmatter,
  type MemoryConceptParseFailure,
  type MemoryConceptParseResult,
  type ParsedMemoryConceptFile,
} from "./concept.ts";
export {
  assertMemoryWriteContained,
  atomicWriteMemoryFile,
  exclusiveWriteMemoryFile,
  normalizeMemoryRelPath,
} from "./fs-safe.ts";
export {
  generateMemoryIndexMarkdown,
  type GenerateMemoryIndexOptions,
} from "./index-file.ts";
export { extractMemoryLinks } from "./links.ts";
export {
  buildMemoryManifest,
  serializeMemoryManifest,
} from "./manifest.ts";
export {
  recallMemoryConcepts,
  type MemoryRecallMatch,
  type RecallMemoryOptions,
} from "./recall.ts";
export {
  DEFAULT_MEMORY_CAPS,
  MemoryCapError,
  MemoryContainmentError,
  MemoryError,
  type MemoryBundle,
  type MemoryBundleConfig,
  type MemoryCaps,
  type MemoryConcept,
  type MemoryDiagnostic,
  type MemoryDiagnosticCode,
  type MemoryDiagnosticSeverity,
  type MemoryLink,
  type MemoryManifest,
  type MemoryTree,
} from "./types.ts";
export {
  addMemoryConcept,
  memorySlug,
  regenerateMemoryIndex,
  type AddMemoryConceptInput,
  type AddMemoryConceptResult,
} from "./write.ts";
