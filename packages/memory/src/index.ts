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
export { runMemoryCli, runMemoryCliAsync, type MemoryCliIo } from "./cli.ts";
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
  collectMemoryScannableStrings,
  detectMemoryCredentialPattern,
  scanMemoryConceptForSecrets,
  MemorySecretScanError,
} from "./secret-scan.ts";
export {
  memoryConceptScopeRefusals,
  memoryVisibilityRank,
  parseMemorySyncBinding,
  resolveMemoryConceptScopeRequest,
} from "./sync-binding.ts";
export {
  buildMemoryConceptEnvelope,
  computeMemoryConceptExternalId,
  memoryConceptContentDigest,
  remoteMemoryConceptDigest,
  MEMORY_CONCEPT_TYPE_ID,
  type MemoryConceptEnvelope,
  type MemoryConceptEnvelopeLink,
} from "./sync-envelope.ts";
export {
  emptyMemorySyncLedger,
  loadMemorySyncLedger,
  serializeMemorySyncLedger,
  writeMemorySyncLedger,
  MEMORY_SYNC_LEDGER_FILENAME,
} from "./sync-ledger.ts";
export {
  assertMemorySyncEndpointUrl,
  createHttpMemorySyncTransport,
  redactMemorySyncUrl,
  type HttpMemorySyncTransportOptions,
  type MemorySyncTransport,
} from "./sync-transport.ts";
export {
  buildMemorySaveInput,
  planMemorySync,
  runMemorySync,
  scanMemoryBundleLocally,
  MEMORY_SYNC_PREFLIGHT_BATCH,
  MEMORY_SYNC_TOOL_ID,
  MEMORY_SYNC_TOOL_VERSION,
  type MemorySyncPlanInput,
  type RunMemorySyncOptions,
} from "./sync.ts";
export {
  buildMemoryAdapterBlock,
  buildMemoryAdapterDescription,
  buildMemorySeedBundle,
  extractMemoryBootstrapPointer,
  extractMemoryWalkthroughScript,
  memorySeedConceptPath,
  parseMemorySeedSections,
  MEMORY_CONVENTIONS_DOC_PATH,
  MEMORY_RULE_VOCABULARY,
  MEMORY_SEED_BUNDLE_ID,
  MEMORY_SEED_BUNDLE_NAME,
  MEMORY_SEED_BUNDLE_PATH,
  type MemorySeedFile,
  type MemorySeedSection,
} from "./seed.ts";
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
  type MemoryScopeOwnerLevel,
  type MemoryScopeRequest,
  type MemoryScopeVisibility,
  MemorySyncError,
  type MemorySyncAction,
  type MemorySyncBinding,
  type MemorySyncDiagnostic,
  type MemorySyncDiagnosticCode,
  type MemorySyncDiagnosticSeverity,
  type MemorySyncItem,
  type MemorySyncLedger,
  type MemorySyncOrphan,
  type MemorySyncPlan,
  type MemorySyncResult,
  type MemoryTree,
} from "./types.ts";
export {
  addMemoryConcept,
  memorySlug,
  regenerateMemoryIndex,
  type AddMemoryConceptInput,
  type AddMemoryConceptResult,
} from "./write.ts";
