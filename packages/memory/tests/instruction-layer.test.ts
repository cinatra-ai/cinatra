/**
 * The instruction layer: one canonical conventions page, two thin host
 * adapters generated from it, and a seed bundle generated from it.
 *
 * These tests hold the three properties the layer exists for:
 *   1. each adapter EMBEDS a generated block from the page and adds no rule of
 *      its own, so an adapter cannot drift from the authority;
 *   2. the seed bundle is generated from the page, passes `memory check`, and
 *      fails the moment page and bundle drift apart;
 *   3. a fresh agent that has only the bootstrap pointer and the page can
 *      author a valid concept with the CLI — proven by running the page's own
 *      shell script in a real shell, unmodified.
 *
 * Regenerate every derived artifact after an intentional edit to the page:
 *   MEMORY_SEED_WRITE=1 pnpm --filter @cinatra-ai/memory test
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import {
  buildMemoryAdapterBlock,
  buildMemoryAdapterDescription,
  buildMemorySeedBundle,
  extractMemoryBootstrapPointer,
  extractMemoryWalkthroughScript,
  parseMemorySeedSections,
  MEMORY_CONVENTIONS_DOC_PATH,
  MEMORY_RULE_VOCABULARY,
  MEMORY_SEED_BUNDLE_ID,
  MEMORY_SEED_BUNDLE_PATH,
} from "../src/seed.ts";

const PKG_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = path.resolve(PKG_ROOT, "..", "..");
const BIN = path.join(PKG_ROOT, "bin", "memory.mjs");

const DOC_PATH = path.join(REPO_ROOT, MEMORY_CONVENTIONS_DOC_PATH);
const SEED_ROOT = path.join(REPO_ROOT, MEMORY_SEED_BUNDLE_PATH);

const WRITE = process.env["MEMORY_SEED_WRITE"] === "1";

/**
 * The two host adapters. Each carries the generated block between the SAME
 * pair of marker comments; everything outside the markers is host-specific
 * routing (frontmatter, an install note, the surrounding repository map) and
 * must carry no rule.
 */
const ADAPTER_BEGIN = "<!-- memory-conventions:begin -->";
const ADAPTER_END = "<!-- memory-conventions:end -->";
const ADAPTERS = [
  {
    label: "Claude Code skill",
    file: path.join(PKG_ROOT, "skills", "memory-conventions", "SKILL.md"),
  },
  { label: "AGENTS.md", file: path.join(REPO_ROOT, "AGENTS.md") },
] as const;

function readDoc(): string {
  return readFileSync(DOC_PATH, "utf8");
}

/** Run the real CLI binary; returns stdout, throws with stderr on failure. */
function memory(args: string[]): string {
  return execFileSync(process.execPath, [BIN, ...args], { encoding: "utf8" });
}

/**
 * The marked region of an adapter file, markers excluded. Each marker must
 * appear EXACTLY once — the same rule the page's own regions get. A second
 * region would sit outside the byte-compared one and could hold anything.
 */
function adapterRegion(source: string, label: string): string {
  const opens = source.split(ADAPTER_BEGIN).length - 1;
  const closes = source.split(ADAPTER_END).length - 1;
  if (opens !== 1 || closes !== 1) {
    throw new Error(
      `${label} must carry exactly one generated region; found ${opens} begin and ${closes} end marker(s)`,
    );
  }
  const from = source.indexOf(ADAPTER_BEGIN);
  const to = source.indexOf(ADAPTER_END);
  if (to < from) throw new Error(`${label}'s region closes before it opens`);
  return source.slice(from + ADAPTER_BEGIN.length, to);
}

/** An adapter's YAML frontmatter block, or an empty string when it has none. */
function frontmatter(source: string): string {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(source);
  return match?.[1] ?? "";
}

/** Everything an adapter authored itself: no frontmatter, no generated region. */
function authoredProse(source: string, label: string): string {
  return source.replace(frontmatter(source), " ").replace(adapterRegion(source, label), " ");
}

/** Every file under `root`, as bundle-relative POSIX paths. */
function filesUnder(root: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...filesUnder(path.join(root, entry.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// The canonical page
// ---------------------------------------------------------------------------

describe("canonical conventions page", () => {
  it("exists at the path the generator names", () => {
    expect(existsSync(DOC_PATH), `${MEMORY_CONVENTIONS_DOC_PATH} is missing`).toBe(true);
  });

  it("covers every subject the instruction layer owes a fresh agent", () => {
    const doc = readDoc().toLowerCase();
    for (const subject of [
      "convention",
      "correction",
      "command",
      "debugging insight",
      "one concept per insight",
      "type",
      "index.md",
      "secret",
      "recall",
    ]) {
      expect(doc, `the page never mentions ${JSON.stringify(subject)}`).toContain(subject);
    }
  });

  it("declares a type for every rule section and no duplicate concept paths", () => {
    const sections = parseMemorySeedSections(readDoc());
    expect(sections.length).toBeGreaterThanOrEqual(8);
    for (const section of sections) {
      expect(section.type).not.toBe("");
      expect(section.body).not.toBe("");
    }
    const paths = buildMemorySeedBundle(readDoc()).map((f) => f.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("keeps a `## ` line inside a fenced example out of the section split", () => {
    // A rule section may legitimately show Markdown. Splitting on such a line
    // would mint a phantom concept from sample text.
    const doc = readDoc();
    const before = parseMemorySeedSections(doc).length;
    const injected = doc.replace(
      "<!-- memory-seed:end -->",
      "```md\n## Not a section, only an example\n```\n\n<!-- memory-seed:end -->",
    );
    expect(parseMemorySeedSections(injected).length).toBe(before);
  });

  it("refuses a page that carries a marker region twice", () => {
    const doubled = readDoc().replace(
      "<!-- memory-adapter:end -->",
      "<!-- memory-adapter:end -->\n<!-- memory-adapter:begin -->",
    );
    expect(() => buildMemoryAdapterBlock(doubled)).toThrow(/exactly one adapter region/);
  });
});

// ---------------------------------------------------------------------------
// The adapters: generated, not authored
// ---------------------------------------------------------------------------

describe("host adapters", () => {
  beforeAll(() => {
    if (!WRITE) return;
    const doc = readDoc();
    const block = buildMemoryAdapterBlock(doc);
    const description = buildMemoryAdapterDescription(doc);
    for (const adapter of ADAPTERS) {
      let source = readFileSync(adapter.file, "utf8");
      const from = source.indexOf(ADAPTER_BEGIN);
      const to = source.indexOf(ADAPTER_END);
      if (from === -1 || to === -1) continue;
      source = `${source.slice(0, from + ADAPTER_BEGIN.length)}\n${block}${source.slice(to)}`;
      if (frontmatter(source) !== "") {
        source = source.replace(/^description:.*$/m, `description: ${description}`);
      }
      writeFileSync(adapter.file, source, "utf8");
    }
  });

  it("both adapters exist", () => {
    for (const adapter of ADAPTERS) {
      expect(existsSync(adapter.file), `${adapter.file} is missing`).toBe(true);
    }
  });

  it("each adapter embeds the page's generated block byte for byte", () => {
    const block = buildMemoryAdapterBlock(readDoc());
    for (const adapter of ADAPTERS) {
      const region = adapterRegion(readFileSync(adapter.file, "utf8"), adapter.label);
      expect(
        region,
        `${adapter.label} has drifted from the page; regenerate with MEMORY_SEED_WRITE=1`,
      ).toBe(`\n${block}`);
    }
  });

  it("each adapter carries the bootstrap pointer through that block", () => {
    const pointer = extractMemoryBootstrapPointer(readDoc());
    for (const adapter of ADAPTERS) {
      const flattened = adapterRegion(readFileSync(adapter.file, "utf8"), adapter.label)
        .replace(/^>\s?/gm, "")
        .replace(/\s+/g, " ");
      expect(flattened, `${adapter.label} does not carry the bootstrap pointer`).toContain(
        pointer,
      );
    }
  });

  it("carries the page's generated routing description in the skill frontmatter", () => {
    // Parsed and compared for EQUALITY, not containment: a folded continuation
    // line would extend the YAML scalar past the generated text while a
    // substring check still passed, and frontmatter is stripped before the
    // vocabulary ban runs — so containment alone leaves an escape route.
    const description = buildMemoryAdapterDescription(readDoc());
    const parsed = parseYaml(frontmatter(readFileSync(ADAPTERS[0].file, "utf8"))) as {
      description?: unknown;
    };
    expect(
      parsed.description,
      "the skill's routing description has drifted from the page; regenerate with MEMORY_SEED_WRITE=1",
    ).toBe(description);
  });

  it("states no rule in any frontmatter value the page did not generate", () => {
    const description = buildMemoryAdapterDescription(readDoc());
    for (const adapter of ADAPTERS) {
      const block = frontmatter(readFileSync(adapter.file, "utf8"));
      if (block === "") continue;
      const parsed = parseYaml(block) as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed)) {
        const text = JSON.stringify(value).toLowerCase();
        if (value === description) continue; // generated, and compared above
        for (const word of MEMORY_RULE_VOCABULARY) {
          expect(
            text.includes(word),
            `${adapter.label} frontmatter key ${JSON.stringify(key)} uses the rule word ${JSON.stringify(word)}`,
          ).toBe(false);
        }
      }
    }
  });

  it("keeps the skill frontmatter parseable as YAML", () => {
    // The description is GENERATED, so a colon or a hash the page's author
    // never thought about would otherwise ship frontmatter no host can read.
    const parsed = parseYaml(frontmatter(readFileSync(ADAPTERS[0].file, "utf8")));
    expect(Object.keys(parsed as Record<string, unknown>)).toEqual(["name", "description"]);
    expect(typeof (parsed as { description: unknown }).description).toBe("string");
  });

  it("rejects a page whose routing description cannot be a plain YAML scalar", () => {
    const broken = readDoc().replace(
      "Use when a coding agent has a persistent Memory bundle",
      "Note: use when a coding agent has a persistent Memory bundle",
    );
    expect(() => buildMemoryAdapterDescription(broken)).toThrow(/plain YAML scalar/);
  });

  it("states no rule outside the generated regions", () => {
    // Byte-comparing the block stops drift INSIDE it. This stops an adapter
    // growing a rule BESIDE it — the escape route a byte comparison cannot
    // see. Outside the generated regions an adapter may only route, so the
    // vocabulary the conventions own must not appear there at all, in a quote
    // or in a paraphrase.
    for (const adapter of ADAPTERS) {
      const prose = authoredProse(
        readFileSync(adapter.file, "utf8"),
        adapter.label,
      ).toLowerCase();
      for (const word of MEMORY_RULE_VOCABULARY) {
        expect(
          prose.includes(word),
          `${adapter.label} uses the rule word ${JSON.stringify(word)} outside the generated regions; route to the page instead`,
        ).toBe(false);
      }
    }
  });

  it("no adapter restates a rule section's prose outside the generated block", () => {
    const sections = parseMemorySeedSections(readDoc());
    for (const adapter of ADAPTERS) {
      const outside = authoredProse(
        readFileSync(adapter.file, "utf8"),
        adapter.label,
      ).replace(/\s+/g, " ");
      for (const section of sections) {
        const first = (section.body.replace(/\s+/g, " ").split(". ")[0] ?? "").trim();
        expect(
          outside.includes(first),
          `${adapter.label} restates the section ${JSON.stringify(section.title)} outside the generated block`,
        ).toBe(false);
      }
    }
  });

  it("refuses an adapter that carries the generated markers twice", () => {
    const doubled = `${readFileSync(ADAPTERS[0].file, "utf8")}\n${ADAPTER_BEGIN}\nanything\n${ADAPTER_END}\n`;
    expect(() => adapterRegion(doubled, "doubled")).toThrow(/exactly one generated region/);
  });

  it("keeps the block embeddable at any heading depth", () => {
    expect(buildMemoryAdapterBlock(readDoc())).not.toMatch(/^#{1,6}\s/m);
  });
});

// ---------------------------------------------------------------------------
// The seed bundle: generated, checked, and digest-locked to the page
// ---------------------------------------------------------------------------

describe("seed bundle", () => {
  const generated = (): ReturnType<typeof buildMemorySeedBundle> =>
    buildMemorySeedBundle(readDoc());

  beforeAll(() => {
    if (!WRITE) return;
    rmSync(SEED_ROOT, { recursive: true, force: true });
    for (const file of generated()) {
      const target = path.join(SEED_ROOT, file.path);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, file.source, "utf8");
    }
  });

  it("is committed at the path the generator names", () => {
    expect(existsSync(SEED_ROOT), `${MEMORY_SEED_BUNDLE_PATH} is missing`).toBe(true);
  });

  it("holds exactly the files the page produces, byte for byte", () => {
    const expected = generated();
    // The whole tree, not only the files the generator names: an extra file
    // shipped in a distribution unit is content that no authority produced.
    expect(filesUnder(SEED_ROOT)).toEqual(expected.map((f) => f.path).sort());
    for (const file of expected) {
      expect(
        readFileSync(path.join(SEED_ROOT, file.path), "utf8"),
        `${file.path} differs from the canonical page; regenerate with MEMORY_SEED_WRITE=1`,
      ).toBe(file.source);
    }
  });

  it("exposes every generated concept, and only those, through the CLI", () => {
    const expected = new Set(
      generated()
        .map((f) => f.path)
        .filter((p) => p.endsWith(".md") && p !== "index.md"),
    );
    const listed = JSON.parse(memory(["list", "--dir", SEED_ROOT, "--json"])) as Array<{
      path: string;
    }>;
    expect(new Set(listed.map((c) => c.path))).toEqual(expected);
  });

  it("fails the drift check when a rule section changes and the bundle does not", () => {
    // The digest is what makes "one authority" enforceable rather than a
    // convention: edit a section, and the concept generated from it no longer
    // equals the committed file.
    const drifted = readDoc().replace(
      "## Recall before you act",
      "## Recall before you act now",
    );
    expect(JSON.stringify(buildMemorySeedBundle(drifted))).not.toBe(
      JSON.stringify(generated()),
    );
  });

  it("records the digest of its source section in every concept", () => {
    const sections = parseMemorySeedSections(readDoc());
    const concepts = generated().filter(
      (f) => f.path.endsWith(".md") && f.path !== "index.md",
    );
    expect(concepts.length).toBe(sections.length);
    for (const concept of concepts) {
      expect(concept.source).toMatch(/^source_digest: sha256:[0-9a-f]{64}$/m);
    }
  });

  it("passes `memory check` as a real command run", () => {
    const result = JSON.parse(memory(["check", "--dir", SEED_ROOT, "--json"])) as {
      bundleId: string;
      conformant: boolean;
      concepts: number;
      errors: number;
    };
    expect(result.bundleId).toBe(MEMORY_SEED_BUNDLE_ID);
    expect(result.errors).toBe(0);
    expect(result.conformant).toBe(true);
    expect(result.concepts).toBe(parseMemorySeedSections(readDoc()).length);
  });
});

// ---------------------------------------------------------------------------
// The scripted walkthrough: bootstrap pointer + page → a valid concept
// ---------------------------------------------------------------------------

describe("a fresh agent following only the pointer and the page", () => {
  let workdir: string;

  beforeAll(() => {
    workdir = mkdtempSync(path.join(tmpdir(), "memory-walkthrough-"));
    // The ONLY thing supplied beyond the page: an installed `memory` on PATH,
    // which is what the pointer assumes a host has already provided. The
    // script itself runs unmodified, in a real shell, from an empty directory.
    const bin = path.join(workdir, "bin");
    mkdirSync(bin, { recursive: true });
    const shim = path.join(bin, "memory");
    writeFileSync(shim, `#!/bin/sh\nexec ${process.execPath} ${BIN} "$@"\n`, "utf8");
    chmodSync(shim, 0o755);
  });
  afterAll(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it("reaches a checked bundle by running the page's script unmodified", () => {
    const script = extractMemoryWalkthroughScript(readDoc());
    const project = path.join(workdir, "project");
    mkdirSync(project, { recursive: true });

    execFileSync("/bin/sh", ["-s"], {
      input: script,
      cwd: project,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${path.join(workdir, "bin")}:${process.env["PATH"] ?? ""}`,
      },
    });

    // The script's own `mkdir`/`cd` decide where the bundle lands; the page
    // says `demo-project`, and this asserts the page told the truth.
    const bundle = path.join(project, "demo-project", ".memory");
    expect(existsSync(path.join(bundle, "bundle.yaml"))).toBe(true);

    const listed = JSON.parse(memory(["list", "--dir", bundle, "--json"])) as Array<{
      path: string;
      type: string;
      title: string | null;
      description: string | null;
    }>;
    expect(listed.length).toBe(1);
    expect(listed[0]?.type).toBe("Convention");
    expect(listed[0]?.title).not.toBeNull();
    expect(listed[0]?.description).not.toBeNull();
    expect(listed[0]?.path.endsWith(".md")).toBe(true);

    const check = JSON.parse(memory(["check", "--dir", bundle, "--json"])) as {
      conformant: boolean;
      errors: number;
      concepts: number;
    };
    expect(check.conformant).toBe(true);
    expect(check.errors).toBe(0);
    expect(check.concepts).toBe(1);
  });

  it("refuses a page whose walkthrough region holds more than one script", () => {
    const doubled = readDoc().replace(
      "<!-- memory-walkthrough:end -->",
      "```sh\nmemory check\n```\n<!-- memory-walkthrough:end -->",
    );
    expect(() => extractMemoryWalkthroughScript(doubled)).toThrow(/exactly one fenced block/);
  });
});
