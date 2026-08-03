export * from "./skill-packages";
export * from "./skills-store";
export * from "./skill-source";
// The packages/* scanner pipeline has been removed.
// Agent-skills compile path moved to compile-agent-skills.
export * from "./compile-agent-skills";
// Package-bundled system-skill registration for the chat assistant.
export * from "./register-extension-skill";
// Generic, install/uninstall-aware skill registration shared across consumers
// (blog/chat/prefill).
export * from "./extension-skill-resolver";
export * from "./skills-registry";
export * from "./personal-skills";
export * from "./skill-markdown-editor";
export * from "./actions";
export * from "./github";
export * from "./frontmatter";
export * from "./matching";
export * from "./storage/git-commit";
export * from "./prefill-generation";
export * from "./local-skill-files";
export * from "./llm-matching";
// Ownership-first layout exports resolver, scanner, and relocation worker.
export * from "./skill-paths";
export * from "./skill-scanner";
export * from "./relocate-worker";
export * from "./recover-pending-moves";
// In-process deterministic skills client used to resolve per-agent methodology
// via the catalog.
export { createDeterministicSkillsClient } from "./mcp/client/deterministic-client";
export type { DeterministicSkillsClient } from "./mcp/client/deterministic-client";
// Pure skill↔installed_extension identity + parity substrate (no DB / fs). Used
// by the cutover-readiness diagnostic + the eventual manifest-driven skill reader.
export {
  resolveSkillOwnerPackageCandidates,
  isSkillManifestGoverned,
  computeSkillManifestParity,
  resolveCanonicalNpmName,
  planSkillManifestNpmMigration,
} from "./manifest-identity";
export type {
  SkillIdentityRow,
  SkillManifestParity,
  SkillManifestRow,
  SkillManifestNpmPlan,
} from "./manifest-identity";
