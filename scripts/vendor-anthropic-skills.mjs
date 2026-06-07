#!/usr/bin/env node
// Vendored upstream skill-bundle fetcher.
//
// Reads `cinatra.vendoredSkillBundles[]` from the app-root `package.json`
// and, for each entry, ensures the bundle's content tree is present on disk
// at `<destination>`, populated from the upstream tarball pinned by `sha`,
// filtered through `include[]`, with `skills.<slug>.patches[]` applied
// against vendored SKILL.md files (a declarative patch manifest;
// fail-closed on missing anchors so upstream rewording cannot silently
// regress an adaptation).
//
// DEV-ONLY GATE: the fetcher refuses to run unless
// `CINATRA_RUNTIME_MODE === "development"`. Prod consumes the same bundle
// via `extensions_install("@<scope>/<pkg>@<semver>")` against Cinatra's
// Verdaccio — never re-fetched from GitHub. The CI postinstall path (no
// env vars) must exit 0 with no side effects.
//
// Sentinel-bounded `.gitignore` section: the fetcher writes an idempotent
// managed section listing each bundle's destination path. The block is
// bounded by:
//
//   # BEGIN cinatra-vendored-bundles (managed by scripts/vendor-anthropic-skills.mjs — do not edit by hand)
//   # END cinatra-vendored-bundles
//
// Modes:
//   (default)  fetch + extract + patch + write package.json + update .gitignore
//   --check    read-only; reports state, exits 0 always; harmless in any env
//   --quiet    suppress info logs; still respects dev-only gate; used by postinstall

import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import * as tar from "tar";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const PKG_JSON_PATH = path.join(REPO_ROOT, "package.json");
const GITIGNORE_PATH = path.join(REPO_ROOT, ".gitignore");
const SENTINEL_BEGIN = "# BEGIN cinatra-vendored-bundles (managed by scripts/vendor-anthropic-skills.mjs — do not edit by hand)";
const SENTINEL_END = "# END cinatra-vendored-bundles";

const args = new Set(process.argv.slice(2));
const isCheck = args.has("--check");
const isQuiet = args.has("--quiet");
const isDev = process.env.CINATRA_RUNTIME_MODE === "development";

function log(...m) { if (!isQuiet) console.log("[vendor-anthropic-skills]", ...m); }
function warn(...m) { console.warn("[vendor-anthropic-skills]", ...m); }
function fail(msg) { console.error("[vendor-anthropic-skills] ERROR:", msg); process.exit(1); }

function readBundles() {
  if (!existsSync(PKG_JSON_PATH)) return [];
  const pkg = JSON.parse(readFileSync(PKG_JSON_PATH, "utf8"));
  return Array.isArray(pkg?.cinatra?.vendoredSkillBundles) ? pkg.cinatra.vendoredSkillBundles : [];
}

function readSentinelBlock(content) {
  const beginIdx = content.indexOf(SENTINEL_BEGIN);
  const endIdx = content.indexOf(SENTINEL_END, beginIdx);
  if (beginIdx === -1 || endIdx === -1) return null;
  return { beginIdx, endIdx: endIdx + SENTINEL_END.length };
}

function buildSentinelBlock(bundles) {
  const lines = [SENTINEL_BEGIN, ...bundles.map((b) => `${b.destination.replace(/^\/+/, "")}/`), SENTINEL_END];
  return lines.join("\n");
}

function syncGitignore(bundles) {
  if (!isDev) return; // dev-mode-only concern (see header)
  const current = existsSync(GITIGNORE_PATH) ? readFileSync(GITIGNORE_PATH, "utf8") : "";
  const block = buildSentinelBlock(bundles);
  const range = readSentinelBlock(current);
  let next;
  if (range) {
    next = current.slice(0, range.beginIdx) + block + current.slice(range.endIdx);
  } else {
    next = (current.endsWith("\n") || current === "" ? current : current + "\n") + "\n" + block + "\n";
  }
  if (next !== current) {
    writeFileSync(GITIGNORE_PATH, next);
    log("updated .gitignore sentinel block");
  }
}

function readShaMarker(destAbs) {
  const markerPath = path.join(destAbs, ".cinatra-vendored-sha");
  if (!existsSync(markerPath)) return null;
  return readFileSync(markerPath, "utf8").trim();
}

function writeShaMarker(destAbs, sha) {
  writeFileSync(path.join(destAbs, ".cinatra-vendored-sha"), sha);
}

async function fetchTarball(owner, repo, sha) {
  const url = `https://codeload.github.com/${owner}/${repo}/tar.gz/${sha}`;
  log(`fetching ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`fetch ${url} failed: ${res.status} ${res.statusText}`);
  }
  return Readable.fromWeb(res.body);
}

async function extractTarball(stream, includeList, destAbs) {
  // Match upstream entries that begin with `<root>/<include-path>`. The tar
  // archive's root prefix is the repo name + sha (e.g. `skills-690f15c.../`)
  // — we strip exactly one leading dir.
  if (!existsSync(destAbs)) mkdirSync(destAbs, { recursive: true });
  const filterSet = new Set(includeList);
  await pipeline(
    stream,
    createGunzip(),
    tar.x({
      cwd: destAbs,
      strip: 1,
      filter: (entryPath) => {
        // node-tar invokes filter with the FULL archive path (e.g.
        // `skills-<sha>/skills/skill-creator/SKILL.md`), BEFORE the strip
        // prefix is removed. Drop the first dir to compare against the
        // include list which uses repo-root-relative paths.
        const segments = entryPath.replace(/^\.\//, "").split("/");
        if (segments.length <= 1) return false;
        const stripped = segments.slice(1).join("/");
        if (stripped === "") return false;
        if (filterSet.has(stripped)) return true;
        for (const inc of filterSet) {
          if (stripped.startsWith(inc + "/")) return true;
        }
        return false;
      },
    }),
  );
}

function applyPatches(destAbs, skills, bundle) {
  for (const [slug, meta] of Object.entries(skills ?? {})) {
    const patches = Array.isArray(meta?.patches) ? meta.patches : [];
    if (patches.length === 0) continue;
    const skillMdPath = path.join(destAbs, "skills", slug, "SKILL.md");
    if (!existsSync(skillMdPath)) {
      fail(`patch target missing: ${skillMdPath} (fail-closed semantics)`);
    }
    let content = readFileSync(skillMdPath, "utf8");
    for (const patchIdx in patches) {
      const patch = patches[patchIdx];
      const { findAnchor, replaceWith } = patch;
      if (typeof findAnchor !== "string" || typeof replaceWith !== "string") {
        fail(`malformed patch entry for ${slug}: must have findAnchor + replaceWith strings`);
      }
      const occurrences = content.split(findAnchor).length - 1;
      if (occurrences !== 1) {
        // Rich diagnostic so a maintainer bumping the pinned SHA can quickly
        // identify what upstream rewording broke the patch.
        const anchorFirstLine = findAnchor.split("\n")[0].slice(0, 120);
        const targetFirstLine = content.split("\n")[0].slice(0, 120);
        fail(
          [
            `patch anchor for ${slug} (patch index ${patchIdx}) found ${occurrences} times in ${skillMdPath} (expected exactly 1).`,
            `Bundle:    ${bundle?.packageName ?? "<unknown>"}`,
            `Source:    ${bundle?.source?.url ?? "<unknown>"} @ ${bundle?.source?.sha ?? "<unknown>"}`,
            `Anchor 1st line: ${JSON.stringify(anchorFirstLine)}`,
            `Target 1st line: ${JSON.stringify(targetFirstLine)}`,
            `Likely cause:    upstream reworded the anchor at this SHA. Either revert the SHA bump,`,
            `                 regenerate the patch manifest against the current upstream content,`,
            `                 or fetch the upstream SKILL.md and diff it against the patch manifest.`,
          ].join("\n  "),
        );
      }
      content = content.replace(findAnchor, replaceWith);
    }
    writeFileSync(skillMdPath, content);
  }
}

function writeSidecarMatchers(destAbs, skills) {
  for (const [slug, meta] of Object.entries(skills ?? {})) {
    const matchWhen = meta?.matchWhen;
    if (!matchWhen) continue;
    const skillDir = path.join(destAbs, "skills", slug);
    if (!existsSync(skillDir)) continue;
    const sidecarPath = path.join(skillDir, "cinatra-matchers.json");
    writeFileSync(
      sidecarPath,
      JSON.stringify({ matchWhen, level: meta.level ?? "workspace" }, null, 2),
    );
  }
}

function writeSynthesizedPackageJson(destAbs, bundle) {
  const synthesized = {
    name: bundle.packageName,
    version: "0.0.0",
    private: false,
    license: bundle.license ?? "Apache-2.0",
    description: bundle.description ?? `Vendored from ${bundle.source.url} @ ${bundle.source.sha}`,
    cinatra: {
      apiVersion: "cinatra.ai/v1",
      kind: "skill",
      vendoredFrom: {
        owner: bundle.source.owner,
        repo: bundle.source.repo,
        sha: bundle.source.sha,
        url: bundle.source.url,
      },
    },
  };
  writeFileSync(
    path.join(destAbs, "package.json"),
    JSON.stringify(synthesized, null, 2) + "\n",
  );
}

async function processBundle(bundle) {
  const destAbs = path.resolve(REPO_ROOT, bundle.destination);
  const existingSha = readShaMarker(destAbs);
  if (existingSha === bundle.source.sha) {
    log(`${bundle.packageName} already at ${bundle.source.sha} — cache hit, skipping`);
    return;
  }

  log(`${bundle.packageName}: ${existingSha ?? "<not present>"} -> ${bundle.source.sha}`);

  // Wipe + re-extract from scratch so removed includes don't linger.
  if (existsSync(destAbs)) rmSync(destAbs, { recursive: true, force: true });

  const stream = await fetchTarball(bundle.source.owner, bundle.source.repo, bundle.source.sha);
  await extractTarball(stream, bundle.include ?? [], destAbs);
  applyPatches(destAbs, bundle.skills, bundle);
  writeSidecarMatchers(destAbs, bundle.skills);
  writeSynthesizedPackageJson(destAbs, bundle);
  writeShaMarker(destAbs, bundle.source.sha);

  log(`${bundle.packageName} populated at ${path.relative(REPO_ROOT, destAbs)}/`);
}

async function main() {
  const bundles = readBundles();

  if (isCheck) {
    // Read-only state report. Safe to run in any environment.
    log(`vendoredSkillBundles: ${bundles.length}`);
    for (const b of bundles) {
      const destAbs = path.resolve(REPO_ROOT, b.destination);
      const sha = readShaMarker(destAbs);
      const status = sha === b.source.sha ? "in-sync" : sha ? `stale (${sha})` : "missing";
      log(`  ${b.packageName} ${b.source.sha} -> ${b.destination} [${status}]`);
    }
    return;
  }

  // CI postinstall safety: when CINATRA_RUNTIME_MODE is not "development",
  // the fetcher is a no-op. The check-mode above ran unconditionally; we
  // only gate the actual fetch + write.
  if (!isDev) {
    log(`skipping (CINATRA_RUNTIME_MODE=${process.env.CINATRA_RUNTIME_MODE ?? "<unset>"} — fetcher is dev-only)`);
    process.exit(0);
  }

  if (bundles.length === 0) {
    log("no vendoredSkillBundles declared — nothing to do");
    syncGitignore([]);
    return;
  }

  for (const bundle of bundles) {
    try {
      await processBundle(bundle);
    } catch (err) {
      fail(`processing ${bundle.packageName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  syncGitignore(bundles);
  log("done");
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
