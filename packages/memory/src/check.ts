/**
 * Conformance check: the walk diagnostics (hard nonconformance) plus
 * broken-link warnings. Broken links are tolerated by the format — they may
 * be not-yet-written knowledge — so they surface as warnings, never errors.
 */
import { walkMemoryTree, type WalkMemoryTreeOptions } from "./bundle.ts";
import { extractMemoryLinks } from "./links.ts";
import type { MemoryDiagnostic, MemoryTree } from "./types.ts";

/** Result of {@link checkMemoryTree}. */
export interface MemoryCheckResult {
  tree: MemoryTree;
  /** Walk diagnostics + broken-link warnings, in walk order. */
  diagnostics: MemoryDiagnostic[];
  /** True when no error-severity diagnostics were found. */
  conformant: boolean;
}

/**
 * Check any OKF-format directory tree for conformance. Works without a
 * bundle config so it can vet third-party bundles before adoption.
 */
export function checkMemoryTree(
  root: string,
  options: WalkMemoryTreeOptions = {},
): MemoryCheckResult {
  const tree = walkMemoryTree(root, options);
  const diagnostics: MemoryDiagnostic[] = [...tree.diagnostics];
  for (const concept of tree.concepts) {
    for (const link of extractMemoryLinks(concept.path, concept.body)) {
      if (link.kind === "external") continue;
      const target = link.resolvedPath;
      // Only .md targets are checkable concept/document references;
      // directory links and asset links are out of scope for conformance.
      if (target === undefined) {
        diagnostics.push({
          severity: "warning",
          code: "broken-link",
          path: concept.path,
          message: `link ${JSON.stringify(link.target)} escapes the bundle root`,
        });
        continue;
      }
      if (target.endsWith(".md") && !tree.files.has(target)) {
        diagnostics.push({
          severity: "warning",
          code: "broken-link",
          path: concept.path,
          message: `link target ${JSON.stringify(link.target)} does not exist in the bundle (tolerated: may be not-yet-written knowledge)`,
        });
      }
    }
  }
  return {
    tree,
    diagnostics,
    conformant: !diagnostics.some((d) => d.severity === "error"),
  };
}
