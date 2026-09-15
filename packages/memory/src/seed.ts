/**
 * The seed-bundle generator.
 *
 * The conventions a coding agent follows live in ONE authority: the canonical
 * conventions page in this repository. The same rules also have to be readable
 * as memory itself, so this module derives a seed bundle from that page: every
 * marked section becomes exactly one concept file, and the concept records the
 * digest of the section it came from. The package test regenerates the bundle
 * and compares bytes, so an edit to the page that never reaches the bundle
 * fails the suite instead of silently forking the rules.
 *
 * Pure string in, files out. No filesystem access, no network, no model call —
 * the caller reads the page and writes the result.
 */
import { createHash } from "node:crypto";

import { generateMemoryIndexMarkdown } from "./index-file.ts";
import { serializeMemoryConcept } from "./concept.ts";
import { MEMORY_FORMAT_OKF_VERSION } from "./bundle.ts";
import { MemoryError, type MemoryConcept } from "./types.ts";
import { memorySlug } from "./write.ts";

/** Repository-relative path of the canonical conventions page. */
export const MEMORY_CONVENTIONS_DOC_PATH =
  "docs/internals/workflows/memory-conventions.md";

/** Repository-relative path of the generated seed bundle root. */
export const MEMORY_SEED_BUNDLE_PATH = "packages/memory/seed/conventions";

/**
 * The seed bundle's `bundleId`. Generated once and committed: a seed bundle is
 * distributed, so its identity must be the same everywhere rather than a fresh
 * UUID per `memory init`.
 */
export const MEMORY_SEED_BUNDLE_ID = "078ffac4-b939-449b-8bac-7c723cc44939";

/** Display name recorded in the seed bundle's config file. */
export const MEMORY_SEED_BUNDLE_NAME = "Memory conventions";

const SEED_REGION_BEGIN = "<!-- memory-seed:begin -->";
const SEED_REGION_END = "<!-- memory-seed:end -->";
const ADAPTER_BEGIN = "<!-- memory-adapter:begin -->";
const ADAPTER_END = "<!-- memory-adapter:end -->";
const ADAPTER_DESCRIPTION_BEGIN = "<!-- memory-adapter-description:begin -->";
const ADAPTER_DESCRIPTION_END = "<!-- memory-adapter-description:end -->";

/**
 * The vocabulary the conventions OWN. An adapter may carry these words only
 * inside a generated region: anywhere else they mean the adapter has started
 * stating, or summarising, a rule — which is the drift this layer exists to
 * prevent, and which byte-comparing the generated region alone cannot catch.
 */
export const MEMORY_RULE_VOCABULARY: readonly string[] = [
  "recall",
  "duplicate",
  "secret",
  "credential",
  "frontmatter",
  "index.md",
  "insight",
  "qualifies",
  "untrusted",
];
const WALKTHROUGH_BEGIN = "<!-- memory-walkthrough:begin -->";
const WALKTHROUGH_END = "<!-- memory-walkthrough:end -->";
const TYPE_DIRECTIVE = /^<!--\s*memory-seed type:\s*(.+?)\s*-->$/;

/** One section of the canonical page, before it becomes a concept. */
export interface MemorySeedSection {
  /** The `##` heading text; becomes the concept title. */
  title: string;
  /** The kind declared by the section's `memory-seed type:` directive. */
  type: string;
  /** The section body: everything after the directive line, trimmed. */
  body: string;
  /** `sha256:<hex>` over the exact section source, heading line included. */
  digest: string;
}

/** One generated file of the seed bundle. */
export interface MemorySeedFile {
  /** Bundle-relative POSIX path. */
  path: string;
  /** Exact file contents. */
  source: string;
}

/**
 * Extract the text between two marker comments, markers excluded. Each marker
 * must appear EXACTLY once: a second `begin` would silently move the region
 * boundary, and a generator that quietly picks one of two candidate regions is
 * not the single authority this layer claims to be.
 */
function region(doc: string, begin: string, end: string, label: string): string {
  const opens = doc.split(begin).length - 1;
  const closes = doc.split(end).length - 1;
  if (opens !== 1 || closes !== 1) {
    throw new MemoryError(
      `the conventions page must carry exactly one ${label} region; found ${opens} \`${begin}\` and ${closes} \`${end}\``,
    );
  }
  const from = doc.indexOf(begin);
  const to = doc.indexOf(end);
  if (to < from) {
    throw new MemoryError(
      `the conventions page's ${label} region closes before it opens`,
    );
  }
  return doc.slice(from + begin.length, to);
}

/**
 * The adapter block: the exact text every host adapter embeds between its own
 * `memory-conventions` markers. Generated rather than authored per host, so an
 * adapter cannot restate a rule and then drift from it — the test rewrites and
 * byte-compares each adapter's region against this.
 */
export function buildMemoryAdapterBlock(doc: string): string {
  const block = region(doc, ADAPTER_BEGIN, ADAPTER_END, "adapter").trim();
  if (block === "") {
    throw new MemoryError("the conventions page's adapter region is empty");
  }
  if (/^#{1,6}\s/m.test(block)) {
    throw new MemoryError(
      "the adapter block must carry no Markdown heading; it is embedded at an unknown depth",
    );
  }
  return `${block}\n`;
}

/** YAML 1.2 c-indicator characters: none may open a plain scalar. */
const YAML_INDICATORS: ReadonlySet<string> = new Set(
  [..."-?:,[]{}#&*!|>'\"%@`"],
);

/**
 * The one-line routing description a host skill carries in its frontmatter.
 * Generated from the page for the same reason the block is: a hand-authored
 * description is a second place a rule can be stated and then go stale.
 */
export function buildMemoryAdapterDescription(doc: string): string {
  const text = region(
    doc,
    ADAPTER_DESCRIPTION_BEGIN,
    ADAPTER_DESCRIPTION_END,
    "adapter description",
  )
    .replace(/\s+/g, " ")
    .trim();
  if (text === "") {
    throw new MemoryError("the conventions page's adapter description is empty");
  }
  // A host embeds this as a PLAIN YAML scalar on one frontmatter line. `": "`
  // opens a nested mapping there and `" #"` opens a comment, so either would
  // ship frontmatter no YAML parser can read. The leading set is YAML 1.2's
  // full c-indicator list, so a description can never open a collection, an
  // anchor, a tag, a comment, or a block scalar either.
  if (text.includes(": ") || text.includes(" #") || YAML_INDICATORS.has(text[0] ?? "")) {
    throw new MemoryError(
      "the adapter description must embed as a plain YAML scalar: no `: `, no ` #`, and no leading YAML indicator character",
    );
  }
  return text;
}

/**
 * The bootstrap pointer: the short text a host hands a fresh agent. It is the
 * blockquote the adapter block opens with, returned as one flat line with the
 * quote markers stripped, so a test can compare the words wherever they land.
 */
export function extractMemoryBootstrapPointer(doc: string): string {
  const lines: string[] = [];
  for (const line of buildMemoryAdapterBlock(doc).split("\n")) {
    if (!line.startsWith(">")) break;
    const text = line.replace(/^>\s?/, "").trim();
    if (text !== "") lines.push(text);
  }
  if (lines.length === 0) {
    throw new MemoryError(
      "the adapter block must open with the bootstrap pointer as a blockquote",
    );
  }
  return lines.join(" ");
}

/**
 * The end-to-end walkthrough: the shell script a fresh agent runs to reach a
 * checked bundle. Returned as ONE script, not as reconstructed argv — the test
 * hands it to a real shell, so the proof covers the page's own quoting, line
 * continuations, and working-directory changes rather than a re-implementation
 * of them. Exactly one fenced block may live in the region: a second would
 * make "the page's script" ambiguous.
 */
export function extractMemoryWalkthroughScript(doc: string): string {
  const block = region(doc, WALKTHROUGH_BEGIN, WALKTHROUGH_END, "walkthrough");
  const fences = [...block.matchAll(/```(\w*)\n([\s\S]*?)```/g)];
  if (fences.length !== 1) {
    throw new MemoryError(
      `the conventions page's walkthrough region must hold exactly one fenced block; found ${fences.length}`,
    );
  }
  const [fence] = fences;
  if (fence?.[1] !== "sh") {
    throw new MemoryError(
      `the conventions page's walkthrough fence must be tagged \`sh\` (found ${JSON.stringify(fence?.[1] ?? "")})`,
    );
  }
  const script = fence[2] ?? "";
  if (script.trim() === "") {
    throw new MemoryError("the conventions page's walkthrough script is empty");
  }
  return script;
}

/**
 * Split on every `## ` heading that is NOT inside a fenced code block. A rule
 * section legitimately shows a shell or Markdown example, and a `## ` line
 * inside such an example is sample text, never a new concept.
 */
function splitTopLevelSections(body: string): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let fenced = false;
  for (const line of body.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (!fenced && line.startsWith("## ")) {
      chunks.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  chunks.push(current.join("\n"));
  return chunks;
}

/**
 * Split the canonical page's marked region into sections. Each `##` heading
 * starts a section, and the line after it must carry the type directive — a
 * section without one is an authoring mistake, not a silent skip.
 */
export function parseMemorySeedSections(doc: string): MemorySeedSection[] {
  const body = region(doc, SEED_REGION_BEGIN, SEED_REGION_END, "seed");
  const sections: MemorySeedSection[] = [];
  const chunks = splitTopLevelSections(body);
  for (const chunk of chunks) {
    const source = chunk.trim();
    if (source === "") continue;
    const lines = source.split("\n");
    const heading = /^##\s+(.+?)\s*$/.exec(lines[0] ?? "");
    if (heading === null) {
      throw new MemoryError(
        `the conventions page's seed region holds text outside a section: ${JSON.stringify(
          (lines[0] ?? "").slice(0, 60),
        )}`,
      );
    }
    const directive = TYPE_DIRECTIVE.exec((lines[1] ?? "").trim());
    if (directive === null) {
      throw new MemoryError(
        `section ${JSON.stringify(heading[1])} has no \`memory-seed type:\` directive on the line below its heading`,
      );
    }
    const sectionBody = lines.slice(2).join("\n").trim();
    if (sectionBody === "") {
      throw new MemoryError(
        `section ${JSON.stringify(heading[1])} has no body`,
      );
    }
    sections.push({
      title: heading[1] ?? "",
      type: (directive[1] ?? "").trim(),
      body: sectionBody,
      digest: `sha256:${createHash("sha256").update(source, "utf8").digest("hex")}`,
    });
  }
  if (sections.length === 0) {
    throw new MemoryError("the conventions page's seed region holds no sections");
  }
  return sections;
}

/** Words that end in a period without ending a sentence. */
const ABBREVIATIONS: ReadonlySet<string> = new Set([
  "al",
  "approx",
  "cf",
  "etc",
  "vs",
]);

/**
 * The one-sentence description carried into the index: the first sentence of
 * the section body. Derived rather than authored a second time, so the page
 * stays the only place the words live.
 */
function firstSentence(body: string): string {
  const paragraph = (body.split(/\n\s*\n/)[0] ?? "").replace(/\s+/g, " ").trim();
  // A period ends the sentence only when what follows STARTS a new one (an
  // upper-case letter, or the end of the paragraph) AND the period is not part
  // of an abbreviation — the dotted form ("e.g.", "i.e.") and the closed set
  // below. Without both rules a description silently truncates mid-clause.
  const candidate = /[.](?=\s+[A-Z]|\s*$)|[:](?=\s|$)/g;
  let stop: RegExpExecArray | null = null;
  for (let m = candidate.exec(paragraph); m !== null; m = candidate.exec(paragraph)) {
    if (m[0] === ".") {
      const before = paragraph.slice(0, m.index);
      if (/\.[A-Za-z]$/.test(before)) continue; // e.g. / i.e.
      if (ABBREVIATIONS.has((/([A-Za-z]+)$/.exec(before)?.[1] ?? "").toLowerCase())) continue;
    }
    stop = m;
    break;
  }
  const sentence = stop === null ? paragraph : paragraph.slice(0, stop.index + 1);
  // A lead-in sentence ends in a colon because a list or a code block follows
  // it on the page. In the index it stands alone, so it ends in a full stop.
  return sentence.endsWith(":") ? `${sentence.slice(0, -1)}.` : sentence;
}

/** The bundle-relative path a section's concept is written to. */
export function memorySeedConceptPath(section: MemorySeedSection): string {
  return `${memorySlug(section.type)}/${memorySlug(section.title)}.md`;
}

/**
 * Build every file of the seed bundle from the canonical page's source:
 * `bundle.yaml`, the generated `index.md`, and one concept per marked section.
 * Byte-deterministic — the same page always yields the same bytes, so the
 * comparison in the test is an equality check rather than a heuristic.
 */
export function buildMemorySeedBundle(doc: string): MemorySeedFile[] {
  const sections = parseMemorySeedSections(doc);
  const seen = new Map<string, string>();
  const concepts: MemoryConcept[] = [];
  const files: MemorySeedFile[] = [];

  for (const section of sections) {
    const conceptPath = memorySeedConceptPath(section);
    const collision = seen.get(conceptPath);
    if (collision !== undefined) {
      throw new MemoryError(
        `sections ${JSON.stringify(collision)} and ${JSON.stringify(section.title)} both map to ${conceptPath}`,
      );
    }
    seen.set(conceptPath, section.title);
    const description = firstSentence(section.body);
    const frontmatter: Record<string, unknown> = {
      type: section.type,
      title: section.title,
      description,
      source: MEMORY_CONVENTIONS_DOC_PATH,
      source_digest: section.digest,
    };
    const body = `${section.body}\n`;
    concepts.push({
      id: conceptPath.slice(0, -".md".length),
      path: conceptPath,
      type: section.type,
      title: section.title,
      description,
      tags: [],
      frontmatter,
      body,
    });
    files.push({
      path: conceptPath,
      source: serializeMemoryConcept({ frontmatter, body }),
    });
  }

  files.push({
    path: "bundle.yaml",
    source:
      `bundleId: ${MEMORY_SEED_BUNDLE_ID}\n` +
      `name: ${MEMORY_SEED_BUNDLE_NAME}\n`,
  });
  files.push({
    path: "index.md",
    source: generateMemoryIndexMarkdown(concepts, {
      okfVersion: MEMORY_FORMAT_OKF_VERSION,
    }),
  });
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}
