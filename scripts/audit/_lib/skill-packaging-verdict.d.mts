// Types for the shared, dependency-free skill-packaging verdict
// (cinatra#2089, epic #2086 S2).
//
// The implementation is plain `.mjs` ON PURPOSE — it is vendored verbatim into
// public extension repos whose CI has no TypeScript and no package resolution.
// This declaration lets the host's store-install seam
// (`src/lib/skill-packaging-install-gate.ts`) consume the very same module with
// full type safety instead of duplicating the rules in TypeScript.

export declare const VERDICT_CONTRACT_VERSION: number;
export declare const ALLOWED_FRONTMATTER_KEYS: readonly string[];
export declare const SKILL_ROUTER_FILENAME: string;
export declare const SKILL_ROUTER_MAX_LINES: number;
export declare const SKILL_BUNDLE_MAX_BYTES: number;
export declare const SKILL_PACKAGE_NAME_RE: RegExp;
export declare const SKILL_ROLES: readonly string[];
export declare const VIOLATION_CODES: readonly string[];

export type SkillPackagingViolation = {
  code: string;
  message: string;
  path?: string;
};

export type BundleFileRef = { path: string; byteLength: number };

export declare function readSkillFrontmatterStrict(
  content: string,
): { ok: true; topLevel: Map<string, string | null> } | { ok: false; reason: string };

export declare function validateSkillFrontmatter(content: string): string | null;
export declare function readSkillFrontmatterName(content: string): string | null;

export declare function normalizeBundledRelPath(relPath: string): string;
export declare function lintRouterOneHopReferences(
  skillMd: string,
  bundlePaths: string[],
): { ok: boolean; missing: string[] };

export declare function matchesGlob(relPath: string, pattern: string): boolean;
export declare function matchesAllowlist(relPath: string, patterns: string[]): boolean;
export declare function resolveFixtureAllowlist(policy: unknown, repoKey: string): string[];

export declare function validateSkillBundle(input: {
  dirName: string;
  routerText: string;
  files: BundleFileRef[];
  label?: string;
}): SkillPackagingViolation[];

export declare function validateSkillExtensionPackage(input: {
  packageName: string;
  manifest: Record<string, unknown>;
  bundles: { dirName: string; relDir: string; routerText: string; files: BundleFileRef[] }[];
  straySkillMdPaths?: string[];
}): SkillPackagingViolation[];

export declare function validateNonSkillExtensionPackage(input: {
  packageName: string;
  kind: string;
  skillMdPaths: string[];
  allowlist: string[];
}): SkillPackagingViolation[];

export declare function applyLegacyExceptions(
  violations: SkillPackagingViolation[],
  input: { packageName: string; ledger: unknown },
): { blocking: SkillPackagingViolation[]; waived: SkillPackagingViolation[] };

export declare function formatViolations(
  violations: SkillPackagingViolation[],
  subject: string,
): string;
