#!/usr/bin/env node
// Extension README gate — enforces docs/developer/extension-readme.md against
// every in-scope extension under extensions/cinatra-ai/<slug>/.
//
// The contract is OpenAI-workspace-agent-template-style: a small marketplace
// description, an optional Works with list, and a Capabilities list. Nothing
// else.
//
// See docs/developer/extension-readme.md for the full contract. This file is
// the executable enforcement. Wired in CI by
// .github/workflows/extension-readme-gate.yml.
//
// Exit codes:
//   0 — pass
//   1 — gate failures present
//   2 — unexpected internal error

import { readFile, readdir, stat } from "node:fs/promises";
import { execFileSync, execSync } from "node:child_process";
import { resolve, join, dirname } from "node:path";
import { assertExtensionsPresent } from "./lib/assert-extensions-cloned.mjs";

// ---------------------------------------------------------------------------
// Contract — keep aligned with docs/developer/extension-readme.md

export const VALID_KINDS = ["agent", "connector", "artifact", "skill", "workflow"];

// Only these H2 headings are allowed; nothing else. Case-insensitive, trimmed.
export const ALLOWED_H2 = ["Works with", "Capabilities"];
export const REQUIRED_H2 = ["Capabilities"];
export const OPTIONAL_H2 = ["Works with"];

export const README_MIN_BYTES = 250;
export const README_MAX_BYTES = 2500;

export const WORKS_WITH_MIN_BULLETS = 1;
export const CAPABILITIES_MIN_BULLETS = 2;

const EXTENSIONS_ROOT = "extensions";
const CINATRA_AI_DIR = "extensions/cinatra-ai";
const MARKER_NAME = ".readme-pending";
const GATE_SCRIPT_REL = "scripts/audit/extension-readme-gate.mjs";

// ---------------------------------------------------------------------------
// Fence-aware Markdown parser primitives

// Strip fenced code blocks (``` or ~~~) and inline code spans (`…`) so we can
// scan structure without being confused by code examples.
export function stripCodeFences(text) {
  const lines = text.split("\n");
  const out = [];
  let fence = null;
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (fence === null) {
      const m = trimmed.match(/^(```+|~~~+)/);
      if (m) {
        fence = m[1][0].repeat(m[1].length);
        continue;
      }
      out.push(line.replace(/`[^`\n]*`/g, ""));
    } else {
      const m = trimmed.match(/^(```+|~~~+)\s*$/);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) {
        fence = null;
      }
    }
  }
  return out.join("\n");
}

export function hasFrontmatter(rawText) {
  return /^---\s*\r?\n/.test(rawText) || /^\+\+\+\s*\r?\n/.test(rawText);
}

export function findRawHtml(strippedText) {
  const re = /<[a-zA-Z][a-zA-Z0-9-]*(\s[^>]*)?\/?>/g;
  const matches = [];
  let m;
  while ((m = re.exec(strippedText)) !== null) matches.push(m[0]);
  return matches;
}

// Parse the document into an ordered list of blocks:
//   { type: 'heading', level: 1|2|3..6, text, lineIndex }
//   { type: 'bullet',  text, lineIndex }
//   { type: 'para',    text, lineIndex }
//   { type: 'blank',   lineIndex }
// All against fenced-stripped content. Whitespace-only / fence-marker lines
// don't appear. This is intentionally minimal — just what we need for the
// grammar gate.
export function parseBlocks(strippedText) {
  const lines = strippedText.split("\n");
  const blocks = [];
  let para = null;
  const flushPara = () => {
    if (para) {
      blocks.push({ type: "para", text: para.text.trim(), lineIndex: para.start });
      para = null;
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (line.length === 0) {
      flushPara();
      blocks.push({ type: "blank", lineIndex: i });
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flushPara();
      blocks.push({
        type: "heading",
        level: heading[1].length,
        text: heading[2].trim(),
        lineIndex: i,
      });
      continue;
    }
    const bullet = line.match(/^([-*+])\s+(.+)$/);
    if (bullet) {
      flushPara();
      blocks.push({ type: "bullet", text: bullet[2].trim(), lineIndex: i });
      continue;
    }
    // Anything else is paragraph content; aggregate consecutive lines.
    if (para) {
      para.text += " " + line;
    } else {
      para = { text: line, start: i };
    }
  }
  flushPara();
  return blocks;
}

// Detect an italic-only "tagline" block: a paragraph that is wholly emphasized
// (entire content is `*…*` or `_…_`). Block paragraphs of real prose with
// inline emphasis are OK; an emphasis-only one-liner under the H1 is not.
export function isEmphasisOnlyParagraph(text) {
  const t = text.trim();
  if (!t) return false;
  // Match `*…*` or `_…_` covering the whole paragraph.
  return /^\*[^*]+\*$/.test(t) || /^_[^_]+_$/.test(t);
}

// ---------------------------------------------------------------------------
// validateReadmeContent — pure, no I/O

export function validateReadmeContent({ kind, text, sizeBytes }) {
  const errors = [];

  if (!VALID_KINDS.includes(kind)) {
    errors.push(`unknown kind "${kind}" — expected one of ${VALID_KINDS.join(", ")}`);
    return errors;
  }
  if (sizeBytes < README_MIN_BYTES) {
    errors.push(`size ${sizeBytes}B is under minimum ${README_MIN_BYTES}B`);
  }
  if (sizeBytes > README_MAX_BYTES) {
    errors.push(`size ${sizeBytes}B is over maximum ${README_MAX_BYTES}B`);
  }
  if (hasFrontmatter(text)) {
    errors.push("frontmatter present — README must not have YAML/TOML frontmatter");
  }

  const stripped = stripCodeFences(text);

  const html = findRawHtml(stripped);
  if (html.length) {
    errors.push(`raw HTML found outside code fences: ${html.slice(0, 3).join(", ")}`);
  }

  const blocks = parseBlocks(stripped);

  // Headings: exactly one H1, no H3+, only allowed H2s.
  const headings = blocks.filter((b) => b.type === "heading");
  const h1s = headings.filter((h) => h.level === 1);
  const h2s = headings.filter((h) => h.level === 2);
  const deepHeadings = headings.filter((h) => h.level >= 3);

  if (h1s.length !== 1) {
    errors.push(`H1 count is ${h1s.length} (expected exactly 1)`);
  }
  if (deepHeadings.length) {
    errors.push(
      `H3+ headings are not allowed (found ${deepHeadings.length}, e.g. "${deepHeadings[0].text}")`,
    );
  }

  const allowedH2Lower = new Set(ALLOWED_H2.map((h) => h.toLowerCase()));
  for (const h of h2s) {
    if (!allowedH2Lower.has(h.text.trim().toLowerCase())) {
      errors.push(
        `disallowed H2 "## ${h.text}" — only ${ALLOWED_H2.map((h) => `"## ${h}"`).join(" and ")} are permitted`,
      );
    }
  }

  // Capabilities required.
  const h2Lower = new Set(h2s.map((h) => h.text.trim().toLowerCase()));
  for (const req of REQUIRED_H2) {
    if (!h2Lower.has(req.toLowerCase())) {
      errors.push(`missing required section: "## ${req}"`);
    }
  }

  // If both Works with and Capabilities are present, Works with must come first.
  const worksIdx = h2s.findIndex((h) => h.text.trim().toLowerCase() === "works with");
  const capsIdx = h2s.findIndex((h) => h.text.trim().toLowerCase() === "capabilities");
  if (worksIdx >= 0 && capsIdx >= 0 && worksIdx > capsIdx) {
    errors.push(`"## Works with" must come BEFORE "## Capabilities"`);
  }

  // Body: at least one non-empty paragraph between the H1 and the first H2.
  if (h1s.length === 1) {
    const h1Block = h1s[0];
    const firstH2Block = h2s[0];
    const bodyStartIdx = blocks.indexOf(h1Block) + 1;
    const bodyEndIdx = firstH2Block ? blocks.indexOf(firstH2Block) : blocks.length;
    const between = blocks.slice(bodyStartIdx, bodyEndIdx);
    const paragraphs = between.filter((b) => b.type === "para");
    const bullets = between.filter((b) => b.type === "bullet");

    if (paragraphs.length === 0) {
      errors.push("missing description paragraph between H1 and first H2");
    }
    if (bullets.length > 0) {
      errors.push("description area between H1 and first H2 must not contain bullets");
    }
    // Italic-only tagline under H1: the first paragraph must not be emphasis-only.
    if (paragraphs.length > 0 && isEmphasisOnlyParagraph(paragraphs[0].text)) {
      errors.push(
        "italic-only tagline under H1 is not allowed — the description paragraph IS the lede",
      );
    }
  }

  // Section-body rule: between each H2 and the next H2 (or EOF), only bullets
  // are allowed. No prose paragraphs inside a section; no nested headings (we
  // already checked H3+ globally); no bold pseudo-sections either (any `**X:**`
  // paragraph reads as a hidden section header).
  for (let i = 0; i < h2s.length; i++) {
    const start = blocks.indexOf(h2s[i]);
    const end = i + 1 < h2s.length ? blocks.indexOf(h2s[i + 1]) : blocks.length;
    const section = blocks.slice(start + 1, end);
    const paragraphs = section.filter((b) => b.type === "para");
    const bullets = section.filter((b) => b.type === "bullet");

    if (paragraphs.length > 0) {
      errors.push(
        `section "## ${h2s[i].text}" must contain bullets only — found ${paragraphs.length} paragraph(s)`,
      );
    }

    const sectionName = h2s[i].text.trim().toLowerCase();
    if (sectionName === "capabilities" && bullets.length < CAPABILITIES_MIN_BULLETS) {
      errors.push(
        `"## Capabilities" must have at least ${CAPABILITIES_MIN_BULLETS} bullets (found ${bullets.length})`,
      );
    }
    if (sectionName === "works with" && bullets.length < WORKS_WITH_MIN_BULLETS) {
      errors.push(
        `"## Works with" must have at least ${WORKS_WITH_MIN_BULLETS} bullet (found ${bullets.length})`,
      );
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Scanner — pure I/O against a passed-in repo root

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readKind(packagePath) {
  try {
    const raw = await readFile(packagePath, "utf8");
    const pkg = JSON.parse(raw);
    return pkg?.cinatra?.kind ?? null;
  } catch {
    return null;
  }
}

async function findAllMarkers(repoRoot) {
  const root = resolve(repoRoot, EXTENSIONS_ROOT);
  const found = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name === "node_modules" || ent.name === ".git") continue;
      const p = join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(p);
      } else if (ent.isFile() && ent.name === MARKER_NAME) {
        found.push(p);
      }
    }
  }
  if (await exists(root)) await walk(root);
  return found;
}

export async function scanExtensions(repoRoot) {
  const errors = [];
  const summary = { inScope: 0, withReadme: 0, withMarker: 0, unknownKindDirs: 0 };

  const cinatraAiRoot = resolve(repoRoot, CINATRA_AI_DIR);
  let slugs = [];
  try {
    slugs = (await readdir(cinatraAiRoot, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch {
    slugs = [];
  }

  for (const slug of slugs.sort()) {
    const slugDir = join(cinatraAiRoot, slug);
    const pkgPath = join(slugDir, "package.json");
    if (!(await exists(pkgPath))) continue;
    const kind = await readKind(pkgPath);
    if (kind === null) continue;
    if (!VALID_KINDS.includes(kind)) {
      errors.push({
        path: `${CINATRA_AI_DIR}/${slug}`,
        message: `unknown cinatra.kind "${kind}" — expected one of ${VALID_KINDS.join(", ")}`,
      });
      summary.unknownKindDirs += 1;
      continue;
    }
    summary.inScope += 1;
    const readmePath = join(slugDir, "README.md");
    const markerPath = join(slugDir, MARKER_NAME);
    const hasReadme = await exists(readmePath);
    const hasMarker = await exists(markerPath);
    if (hasReadme) summary.withReadme += 1;
    if (hasMarker) summary.withMarker += 1;

    if (hasMarker) {
      const st = await stat(markerPath);
      if (st.size !== 0) {
        errors.push({
          path: `${CINATRA_AI_DIR}/${slug}/${MARKER_NAME}`,
          message: `marker must be 0 bytes (found ${st.size})`,
        });
      }
    }

    if (hasReadme && !hasMarker) {
      const text = await readFile(readmePath, "utf8");
      const sizeBytes = Buffer.byteLength(text, "utf8");
      const contentErrors = validateReadmeContent({ kind, text, sizeBytes });
      for (const e of contentErrors) {
        errors.push({ path: `${CINATRA_AI_DIR}/${slug}/README.md`, message: e });
      }
    } else if (!hasReadme && hasMarker) {
      // pass
    } else if (!hasReadme && !hasMarker) {
      errors.push({
        path: `${CINATRA_AI_DIR}/${slug}`,
        message: `untracked missing README — author README.md or add .readme-pending`,
      });
    } else if (hasReadme && hasMarker) {
      errors.push({
        path: `${CINATRA_AI_DIR}/${slug}`,
        message: `stale debt marker — remove .readme-pending now that README.md exists`,
      });
    }
  }

  const allMarkers = await findAllMarkers(repoRoot);
  for (const mp of allMarkers) {
    const rel = mp.slice(repoRoot.length + 1);
    const dir = dirname(rel);
    const parts = dir.split("/");
    const isValid =
      parts.length === 3 &&
      parts[0] === "extensions" &&
      parts[1] === "cinatra-ai" &&
      parts[2].length > 0 &&
      !parts[2].startsWith(".");
    if (!isValid) {
      errors.push({
        path: rel,
        message:
          "orphan marker — .readme-pending only allowed at extensions/cinatra-ai/<slug>/.readme-pending",
      });
      continue;
    }
    const slug = parts[2];
    const pkgPath = resolve(repoRoot, CINATRA_AI_DIR, slug, "package.json");
    if (!(await exists(pkgPath))) {
      errors.push({
        path: rel,
        message: "orphan marker — parent dir is not an extension (no package.json)",
      });
      continue;
    }
    const kind = await readKind(pkgPath);
    if (kind === null || !VALID_KINDS.includes(kind)) {
      errors.push({
        path: rel,
        message: `orphan marker — parent dir has no valid cinatra.kind (got "${kind}")`,
      });
    }
  }

  return { errors, summary };
}

// ---------------------------------------------------------------------------
// No-new-debt check (unchanged from prior gate; --no-renames is load-bearing).

export function checkNoNewDebt(repoRoot, baseRef) {
  if (!baseRef) return [];
  try {
    execFileSync("git", ["cat-file", "-e", `${baseRef}:${GATE_SCRIPT_REL}`], {
      cwd: repoRoot,
      stdio: "ignore",
    });
  } catch {
    return [
      {
        kind: "info",
        message: `[no-new-debt] bootstrap mode — gate script not in ${baseRef}; skipping new-marker check`,
      },
    ];
  }
  let diffOut;
  try {
    diffOut = execFileSync(
      "git",
      [
        "diff",
        "--no-renames",
        "--diff-filter=A",
        "--name-only",
        `${baseRef}...HEAD`,
        "--",
        "extensions/cinatra-ai/*/.readme-pending",
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );
  } catch (e) {
    return [
      { kind: "error", message: `[no-new-debt] git diff failed: ${e.message}` },
    ];
  }
  const newMarkers = diffOut.split("\n").filter(Boolean);
  return newMarkers.map((m) => ({
    kind: "error",
    message: `[no-new-debt] new debt marker added vs ${baseRef}: ${m}`,
  }));
}

// ---------------------------------------------------------------------------
// CLI entry

async function main() {
  const repoRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  // Fail-closed (source-relocation cutover): without the cloned-back tree this
  // gate finds 0 in-scope extensions and passes vacuously.
  assertExtensionsPresent(repoRoot, "extension-readme-gate");
  const baseRef = process.env.CINATRA_README_GATE_BASE_REF || "";

  const { errors, summary } = await scanExtensions(repoRoot);

  const debtFindings = checkNoNewDebt(repoRoot, baseRef);
  const debtInfos = debtFindings.filter((f) => f.kind === "info");
  const debtErrors = debtFindings.filter((f) => f.kind === "error");

  for (const info of debtInfos) console.log(info.message);

  if (errors.length === 0 && debtErrors.length === 0) {
    console.log(
      `[extension-readme-gate] PASS — ${summary.inScope} in-scope extensions, ` +
        `${summary.withReadme} with README, ${summary.withMarker} with debt marker.`,
    );
    process.exit(0);
  }

  console.error(
    `[extension-readme-gate] FAIL — ${errors.length} contract error(s)` +
      (debtErrors.length ? ` + ${debtErrors.length} no-new-debt error(s)` : "") +
      `:\n`,
  );
  for (const e of errors) console.error(`  ${e.path}: ${e.message}`);
  for (const e of debtErrors) console.error(`  ${e.message}`);
  console.error(
    `\nSee docs/developer/extension-readme.md for the contract.\n` +
      `Summary: ${summary.inScope} in-scope, ${summary.withReadme} README, ${summary.withMarker} marker.`,
  );
  process.exit(1);
}

const isDirectInvocation = import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  main().catch((e) => {
    console.error("[extension-readme-gate] fatal:", e);
    process.exit(2);
  });
}
