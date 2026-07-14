/**
 * Deterministic root `index.md` regeneration.
 *
 * Sections are grouped by directory (bundle-root concepts first under
 * "Concepts", then one section per directory in lexicographic order); entries
 * are sorted lexicographically by path; the entry description is taken from
 * the concept's frontmatter. Pure string generation — no timestamps, no LLM.
 * `log.md` is never generated.
 */
import { stringify as stringifyYaml } from "yaml";

import type { MemoryConcept } from "./types.ts";

/** Options accepted by {@link generateMemoryIndexMarkdown}. */
export interface GenerateMemoryIndexOptions {
  /**
   * OKF version to declare in the root index frontmatter (the only place
   * index frontmatter is permitted). Omit to emit no frontmatter.
   */
  okfVersion?: string;
}

/**
 * Flatten frontmatter text for safe single-line interpolation into the index:
 * newlines/control characters collapse to spaces (no heading or entry
 * injection) and square brackets are escaped so the link syntax stays intact.
 */
function inlineText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/([[\]])/g, "\\$1")
    .trim();
}

/**
 * Percent-encode the characters that break a Markdown link target. `#` must
 * be encoded (a raw `#` reads as a URL-fragment delimiter and truncates the
 * target at resolution time) and `%` must be encoded so the encoding stays
 * injective — link resolution percent-decodes, so a literal `%` in a path
 * would otherwise be indistinguishable from an escape sequence.
 */
function linkTarget(path: string): string {
  return path.replace(
    /[ ()<>#%\u0000-\u001f\u007f]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
}

function displayTitle(concept: MemoryConcept): string {
  if (concept.title !== undefined && concept.title.trim() !== "") {
    return inlineText(concept.title);
  }
  const basename = concept.path.split("/").pop() ?? concept.path;
  return inlineText(basename.endsWith(".md") ? basename.slice(0, -3) : basename);
}

function entryLine(concept: MemoryConcept): string {
  const title = displayTitle(concept);
  const suffix =
    concept.description !== undefined && concept.description.trim() !== ""
      ? ` - ${inlineText(concept.description)}`
      : "";
  return `* [${title}](/${linkTarget(concept.path)})${suffix}`;
}

/**
 * Generate the deterministic root index.md source for a set of concepts.
 * Calling this twice over the same concepts yields identical bytes.
 */
export function generateMemoryIndexMarkdown(
  concepts: readonly MemoryConcept[],
  options: GenerateMemoryIndexOptions = {},
): string {
  const byDirectory = new Map<string, MemoryConcept[]>();
  for (const concept of concepts) {
    const slash = concept.path.lastIndexOf("/");
    const dir = slash === -1 ? "" : concept.path.slice(0, slash);
    const group = byDirectory.get(dir);
    if (group) group.push(concept);
    else byDirectory.set(dir, [concept]);
  }
  const directories = [...byDirectory.keys()].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  // Root concepts lead, then subdirectories lexicographically.
  if (directories.includes("")) {
    directories.splice(directories.indexOf(""), 1);
    directories.unshift("");
  }

  const parts: string[] = [];
  if (options.okfVersion !== undefined) {
    parts.push(
      `---\n${stringifyYaml({ okf_version: options.okfVersion }, { lineWidth: 0 })}---\n`,
    );
  }
  if (directories.length === 0) {
    parts.push("# Concepts\n");
  }
  for (const dir of directories) {
    // Directory names come from the walked filesystem (untrusted persisted
    // input) — flatten them like every other interpolated string.
    const heading = dir === "" ? "Concepts" : inlineText(dir);
    const entries = (byDirectory.get(dir) ?? [])
      .slice()
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map(entryLine);
    parts.push(`# ${heading}\n\n${entries.join("\n")}\n`);
  }
  return parts.join("\n");
}
