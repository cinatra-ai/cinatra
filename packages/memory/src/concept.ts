/**
 * Parse / serialize one OKF 0.1 concept document (Markdown + YAML frontmatter).
 *
 * Conformance profile is spec-strict: `type` is the only required frontmatter
 * field (deliberately not the stricter profile used by the format's reference
 * implementation). Unknown frontmatter keys are preserved round-trip; the body
 * is preserved byte-for-byte.
 */
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import type { MemoryConcept, MemoryDiagnosticCode } from "./types.ts";

/** Successful parse of a concept source file. */
export interface ParsedMemoryConceptFile {
  ok: true;
  /** Full frontmatter mapping in document order (unknown keys preserved). */
  frontmatter: Record<string, unknown>;
  /**
   * Verbatim header bytes: the opening delimiter line through the closing
   * delimiter line exactly as read (round-trip basis, any newline style).
   */
  headerSource: string;
  /** Exact bytes after the closing frontmatter delimiter line. */
  body: string;
}

/** Failed parse: the file is hard-nonconformant and should be skipped. */
export interface MemoryConceptParseFailure {
  ok: false;
  code: Extract<
    MemoryDiagnosticCode,
    "frontmatter-missing" | "frontmatter-unparseable" | "type-missing"
  >;
  message: string;
}

export type MemoryConceptParseResult =
  | ParsedMemoryConceptFile
  | MemoryConceptParseFailure;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/**
 * Split a source file into its frontmatter text, verbatim header (opening
 * delimiter line through closing delimiter line, exact bytes), and body.
 * Returns undefined when there is no frontmatter block (missing opener or
 * unterminated).
 */
export function splitMemoryFrontmatter(
  source: string,
): { frontmatterText: string; headerSource: string; body: string } | undefined {
  if (!/^---\r?\n/.test(source)) return undefined;
  const afterOpen = source.indexOf("\n") + 1;
  let offset = afterOpen;
  while (offset <= source.length) {
    const nl = source.indexOf("\n", offset);
    const line = nl === -1 ? source.slice(offset) : source.slice(offset, nl);
    const bare = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (bare === "---") {
      const bodyStart = nl === -1 ? source.length : nl + 1;
      return {
        frontmatterText: source.slice(afterOpen, offset),
        headerSource: source.slice(0, bodyStart),
        body: source.slice(bodyStart),
      };
    }
    if (nl === -1) break;
    offset = nl + 1;
  }
  return undefined;
}

/** Parse a concept document from its UTF-8 source text. */
export function parseMemoryConceptSource(
  source: string,
): MemoryConceptParseResult {
  const split = splitMemoryFrontmatter(source);
  if (!split) {
    return {
      ok: false,
      code: "frontmatter-missing",
      message:
        "no YAML frontmatter block (expected an opening and closing `---` line)",
    };
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(split.frontmatterText);
  } catch (error) {
    return {
      ok: false,
      code: "frontmatter-unparseable",
      message: `frontmatter YAML does not parse: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (parsed === null || parsed === undefined) parsed = {};
  if (!isPlainRecord(parsed)) {
    return {
      ok: false,
      code: "frontmatter-unparseable",
      message: "frontmatter is valid YAML but not a mapping",
    };
  }
  const type = parsed["type"];
  if (typeof type !== "string" || type.trim() === "") {
    return {
      ok: false,
      code: "type-missing",
      message: "frontmatter has no non-empty string `type` field",
    };
  }
  return {
    ok: true,
    frontmatter: parsed,
    headerSource: split.headerSource,
    body: split.body,
  };
}

/** Derive the concept ID from a bundle-relative path (strip the .md suffix). */
export function memoryConceptIdFromPath(path: string): string {
  return path.endsWith(".md") ? path.slice(0, -3) : path;
}

/** Build a {@link MemoryConcept} from a successful parse. */
export function buildMemoryConcept(
  path: string,
  parsed: ParsedMemoryConceptFile,
): MemoryConcept {
  const fm = parsed.frontmatter;
  const title = typeof fm["title"] === "string" ? fm["title"] : undefined;
  const description =
    typeof fm["description"] === "string" ? fm["description"] : undefined;
  const tags = Array.isArray(fm["tags"])
    ? fm["tags"].filter((t): t is string => typeof t === "string")
    : [];
  return {
    id: memoryConceptIdFromPath(path),
    path,
    type: fm["type"] as string,
    title,
    description,
    tags,
    frontmatter: fm,
    headerSource: parsed.headerSource,
    body: parsed.body,
  };
}

/**
 * Serialize a concept back to file source. The body is emitted byte-for-byte.
 * When `headerSource` is present (a concept parsed from disk whose
 * frontmatter was not modified) it is re-emitted verbatim, so
 * serialize(parse(x)) === x byte-for-byte — comments, key order, exotic YAML
 * constructs, and CRLF/EOF delimiter styles included. Without it, the
 * frontmatter mapping is emitted as YAML in insertion order, preserving
 * unknown keys. Idempotent either way.
 */
export function serializeMemoryConcept(
  concept: Pick<MemoryConcept, "frontmatter" | "body"> &
    Partial<Pick<MemoryConcept, "headerSource">>,
): string {
  const header =
    concept.headerSource ??
    `---\n${stringifyYaml(concept.frontmatter, { lineWidth: 0 })}---\n`;
  return `${header}${concept.body}`;
}
