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
 *
 * `heading` names the section an adapter OWNS inside a larger host file. A
 * dedicated adapter file owns all of itself and declares none. `AGENTS.md` is
 * the repository's own instruction file, where `secret`, `credential` and
 * `duplicate` are ordinary words about something else entirely, so the
 * no-rule properties below read only its Memory conventions section.
 */
const ADAPTER_BEGIN = "<!-- memory-conventions:begin -->";
const ADAPTER_END = "<!-- memory-conventions:end -->";
interface Adapter {
  label: string;
  file: string;
  heading?: string;
}
/** The dedicated adapter file: the only one that carries YAML frontmatter. */
const SKILL_ADAPTER: Adapter = {
  label: "Claude Code skill",
  file: path.join(PKG_ROOT, "skills", "memory-conventions", "SKILL.md"),
};
const ADAPTERS: readonly Adapter[] = [
  SKILL_ADAPTER,
  {
    label: "AGENTS.md",
    file: path.join(REPO_ROOT, "AGENTS.md"),
    heading: "## Memory conventions",
  },
];

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

/**
 * Every `## ` line of a host file that is really a heading. Fenced text is
 * excluded: a `## ` line inside an example is sample text, and read as a
 * heading it would end the owned scope early, letting every line after it
 * escape the properties below. Trailing whitespace is normalised away, so a
 * heading cannot both miss the name check and still close the scope.
 *
 * The fence state tracks WHICH delimiter opened the block, because a boolean
 * toggle is escapable: a `~~~` line inside a ``` example would close the
 * state and hand the rest of the file back as headings. A fence closes only
 * on its own character, at least as long as the opener, and carrying no info
 * string — CommonMark's rule. An unclosed fence widens the scope to the end
 * of the file, which reads more prose than it owns and can only fail louder.
 */
const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*(.*?)\s*$/;
function headingLines(lines: readonly string[]): Map<number, string> {
  const headings = new Map<number, string>();
  let open: { mark: string; length: number } | null = null;
  for (const [i, line] of lines.entries()) {
    const fence = FENCE.exec(line);
    if (fence !== null) {
      const run = fence[1] ?? "";
      const mark = run[0] ?? "";
      if (open === null) open = { mark, length: run.length };
      else if (mark === open.mark && run.length >= open.length && fence[2] === "") {
        open = null;
      }
      continue;
    }
    if (open === null && line.startsWith("## ")) headings.set(i, line.trimEnd());
  }
  return headings;
}

/**
 * The part of a host file an adapter owns: the whole file when it is a
 * dedicated adapter, otherwise its own section, from its heading to the next
 * heading of the same level. Two guards keep the narrower scope from becoming
 * an escape route. The heading must be a heading line carrying exactly that
 * name, and it must appear EXACTLY once — the same discipline the generated
 * regions get, because a second section of the same name would hold authored
 * prose that nothing reads. And the generated region must land inside the
 * scope, so a heading rename that moved the block elsewhere fails instead of
 * silencing every property below.
 */
function adapterScope(source: string, adapter: Adapter): string {
  if (adapter.heading === undefined) return source;
  const lines = source.split("\n");
  const headings = headingLines(lines);
  const starts = [...headings].filter(([, text]) => text === adapter.heading);
  const start = starts[0]?.[0];
  if (starts.length !== 1 || start === undefined) {
    throw new Error(
      `${adapter.label} must carry exactly one ${JSON.stringify(adapter.heading)} heading; found ${starts.length}`,
    );
  }
  const next = [...headings.keys()].filter((i) => i > start);
  const scope = lines.slice(start, next[0] ?? lines.length).join("\n");
  if (!scope.includes(ADAPTER_BEGIN) || !scope.includes(ADAPTER_END)) {
    throw new Error(
      `${adapter.label}'s ${adapter.heading} section no longer holds the generated region`,
    );
  }
  return scope;
}

/**
 * Everything an adapter authored itself, inside the scope it owns: no
 * frontmatter, no generated region.
 */
function authoredProse(source: string, adapter: Adapter): string {
  const front = frontmatter(source);
  const scope = adapterScope(source, adapter);
  return (front === "" ? scope : scope.replace(front, " ")).replace(
    adapterRegion(source, adapter.label),
    " ",
  );
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
    const parsed = parseYaml(frontmatter(readFileSync(SKILL_ADAPTER.file, "utf8"))) as {
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
    const parsed = parseYaml(frontmatter(readFileSync(SKILL_ADAPTER.file, "utf8")));
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
        adapter,
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
        adapter,
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
    const doubled = `${readFileSync(SKILL_ADAPTER.file, "utf8")}\n${ADAPTER_BEGIN}\nanything\n${ADAPTER_END}\n`;
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
