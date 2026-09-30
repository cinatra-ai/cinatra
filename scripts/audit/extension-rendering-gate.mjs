#!/usr/bin/env node
// THE RENDERING GATE — warn mode (cinatra#3871, the slice of cinatra#3036's
// acceptance row 2; its flip to blocking is cinatra#3092).
//
//   "The rendering gate: every kind of work draws itself, the binary base
//    included, whose display is the download card."
//
// WHAT IT COUNTS. The unit is the EXTENSION. A CLAIMING extension is an
// artifact extension of the materialized tree (a directory named `*-artifact`
// or `*-artifacts` at the root of the tree or one vendor level below it, whose
// manifest says `cinatra.kind === "artifact"`) that declares AT LEAST ONE
// artifact-writable claim in `cinatra.artifact.objectTypes[]`: a claim whose
// type id is well formed AND that is either self-namespaced (the bridge
// registers it as an artifact type) or declares
// `dispositions.projection === "artifact-safe"` (a claim-backed host type). A
// claiming extension with no display of its own is a finding. Its OWN display
// is the build map's entry `<package>::detail` in GENERATED_ARTIFACT_RENDERERS,
// read with the floor gate's own fail-closed reader: the build map, never a
// manifest's `ui` block, is the authority (see the floor gate's header).
//
// OUTSIDE THE GATE BY CONSTRUCTION. An artifact extension that declares no
// writable claim (no `objectTypes`, or only claims that are malformed or of
// projection "none" on a foreign namespace) is reported on every run and never
// counted.
//
// NOTHING IS COUNTED TWICE. host-display-floor-gate.mjs counts the
// application's own displays and reads no extension tree; the floor gate
// (artifact-review-floor-gate.mjs) counts artifact TYPES whose review lands on
// the metadata floor. A type drawn by a host handler or by another extension's
// representation provider is off that floor and still in this gate's deficit,
// because it does not draw ITSELF. The units differ and are reported side by
// side.
//
// THE MODE IS WARN (GATE_MODE). A finding above the floor is printed as a
// warning and passes. A floor entry that no longer applies is printed as a
// warning and passes as well, so that an open pull request which gives an
// extension its display does not turn red when it meets the gate; the floor is
// shrunk by the gate's own writer (`--write-baseline`) afterwards. A floor that
// grew against the base, an unreadable base on a pull request, and a scanner
// error fail. The flip (cinatra#3092) is this one constant and an empty floor,
// with no exception list: in "blocking" mode every live finding and every stale
// entry fails, and the floor must be empty.
//
// THE FLOOR. `extension-rendering-gate.baseline.json` holds today's deficit and
// only shrinks: it is compared with the base branch through the shared floor
// base guard (growth = an extension the base floor does not hold). The change
// that introduces this gate has a base that holds neither the floor nor this
// script; that one case passes as the introducing change. A base that holds
// the script but not its floor fails closed.
//
// Usage:
//   node scripts/audit/extension-rendering-gate.mjs [--json] [--write-baseline]
//        [--extensions-root <dir>] [--baseline <file>] [--repo-root <dir>]
//        [--allow-partial-fleet]   (fixture trees only — never in CI)
// Env:
//   EXTENSION_RENDERING_GATE_BASE  base ref for the floor base guard (optional).
//
// Exit codes: 0 = clean or warn-only; 1 = a grown floor or an unreadable base
// on a pull request's run (and, in blocking mode only, a live finding or a
// stale entry); 2 = scanner error (no artifact extension, a partial fleet, an
// unreadable manifest, an unparseable build map, an absent or unreadable
// floor file).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CANONICAL_SOURCES,
  InfraError,
  discoverArtifactPackNames,
  expectedArtifactPackNames,
  isArtifactExtensionDirName,
  missingArtifactPacks,
  readGeneratedRendererEntries,
  typeNamespace,
} from "./artifact-review-floor-gate.mjs";
import { compareFloorWithBase, newKeys, readFileAtBase, reportFloorGuard } from "./lib/floor-base-guard.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(__dirname, "..", "..");

/** The gate's mode: "warn" today; "blocking" at its flip (cinatra#3092). */
export const GATE_MODE = "warn";

/** The committed floor, repo-relative. */
export const FLOOR_FILE = "scripts/audit/extension-rendering-gate.baseline.json";

/** This script, repo-relative (the introducing rule reads it at the base). */
export const GATE_FILE = "scripts/audit/extension-rendering-gate.mjs";

/** The gate's own base variable for the floor base guard. */
export const FLOOR_BASE_VAR = "EXTENSION_RENDERING_GATE_BASE";

const GATE = "extension-rendering-gate";

const FLOOR_NOTE =
  "extension-rendering-gate — the floor of the rendering gate (cinatra#3871): the claiming artifact " +
  "extensions that draw no display of their own. It only shrinks: a new entry fails against the base " +
  "branch. Remove an entry with `node scripts/audit/extension-rendering-gate.mjs --write-baseline` once " +
  "its extension ships its own detail display; the writer never adds one.";

const byPackage = (a, b) => (a.package < b.package ? -1 : a.package > b.package ? 1 : 0);

// ---------------------------------------------------------------------------
// Discovery.
// ---------------------------------------------------------------------------

function artifactExtensionDirs(root) {
  if (!existsSync(root)) return [];
  const dirs = [];
  const scan = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && isArtifactExtensionDirName(e.name)) dirs.push(join(dir, e.name));
    }
  };
  let top;
  try {
    top = readdirSync(root, { withFileTypes: true });
  } catch (err) {
    throw new InfraError(`unreadable extensions root: ${root} (${err?.code ?? err})`);
  }
  scan(root);
  for (const e of top) {
    if (e.isDirectory() && !isArtifactExtensionDirName(e.name)) scan(join(root, e.name));
  }
  return dirs;
}

/** A claim the host can write an artifact into: a well-formed type id that is
 * self-namespaced, or that declares an artifact-safe projection. */
function isWritableClaim(claim, packageName) {
  const type = claim?.type;
  if (typeof type !== "string") return false;
  const namespace = typeNamespace(type);
  if (namespace === null) return false;
  return namespace === packageName || claim?.dispositions?.projection === "artifact-safe";
}

/**
 * Every artifact extension of the tree, sorted by package:
 * `{ package, declaresObjectTypes, writableTypes }` (writable type ids sorted).
 * An unreadable manifest is a scanner error.
 */
export function readClaimingExtensions(extensionsRoot) {
  const out = [];
  for (const dir of artifactExtensionDirs(extensionsRoot)) {
    const manifestPath = join(dir, "package.json");
    if (!existsSync(manifestPath)) continue;
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      throw new InfraError(`unreadable extension manifest: ${manifestPath}`);
    }
    if (pkg?.cinatra?.kind !== "artifact" || typeof pkg.name !== "string") continue;
    const objectTypes = pkg.cinatra.artifact?.objectTypes;
    const declaresObjectTypes = Array.isArray(objectTypes);
    const writableTypes = declaresObjectTypes
      ? [...new Set(objectTypes.filter((c) => isWritableClaim(c, pkg.name)).map((c) => c.type))].sort()
      : [];
    out.push({ package: pkg.name, declaresObjectTypes, writableTypes });
  }
  return out.sort(byPackage);
}

// ---------------------------------------------------------------------------
// The classifier.
// ---------------------------------------------------------------------------

/**
 * `{ deficit: [{ package, types }], ownDisplay: [package], outside: [{ package, reason }] }`,
 * each sorted. A claiming extension with no `<package>::detail` entry in the
 * build map is a finding.
 */
export function classifyRendering({ extensions, generatedEntries }) {
  const keys = new Set(generatedEntries.map((e) => e.key));
  const deficit = [];
  const ownDisplay = [];
  const outside = [];
  for (const ext of extensions) {
    if (ext.writableTypes.length === 0) {
      outside.push({
        package: ext.package,
        reason: ext.declaresObjectTypes ? "declares no artifact-writable claim" : "declares no objectTypes",
      });
      continue;
    }
    if (keys.has(`${ext.package}::detail`)) ownDisplay.push(ext.package);
    else deficit.push({ package: ext.package, types: [...ext.writableTypes] });
  }
  return { deficit: deficit.sort(byPackage), ownDisplay: ownDisplay.sort(), outside: outside.sort(byPackage) };
}

// ---------------------------------------------------------------------------
// The floor.
// ---------------------------------------------------------------------------

/** The floor file's text -> its entries; throws when the text is not a floor. */
export function parseFloor(text) {
  const doc = JSON.parse(text);
  if (doc === null || typeof doc !== "object" || !Array.isArray(doc.deficit)) {
    throw new Error('the floor carries no "deficit" list');
  }
  for (const e of doc.deficit) {
    if (typeof e?.package !== "string") throw new Error("a floor entry names no package");
  }
  return doc.deficit;
}

const floorEntries = (floor) => (Array.isArray(floor) ? floor : (floor?.deficit ?? []));

/**
 * Live against committed. `above`: a live finding the floor does not hold;
 * `stale`: a floor entry that is no live finding. Both sorted by package.
 */
export function diffAgainstFloor(deficit, floor) {
  const held = floorEntries(floor);
  const heldNames = new Set(held.map((e) => e.package));
  const liveNames = new Set(deficit.map((e) => e.package));
  return {
    above: deficit.filter((e) => !heldNames.has(e.package)).sort(byPackage),
    stale: held.filter((e) => !liveNames.has(e.package)).sort(byPackage),
  };
}

/**
 * The floor verdict. In "warn" mode a finding above the floor and a stale
 * entry are one WARN line each and the exit is 0. In "blocking" mode every
 * live finding fails, every stale entry fails, and the floor must be empty.
 */
export function verdict({ mode, above, stale, deficit = above }) {
  const lines = [];
  if (mode === "warn") {
    for (const e of above) {
      lines.push(`[${GATE}] WARN — ${e.package} draws no display of its own and is not in the floor (warn mode: passes).`);
    }
    for (const e of stale) {
      lines.push(
        `[${GATE}] WARN — the floor entry ${e.package} no longer applies (warn mode: passes); ` +
          `the gate's writer \`node ${GATE_FILE} --write-baseline\` removes it.`,
      );
    }
    lines.push(`[${GATE}] OK — warn mode; the floor only shrinks.`);
    return { exitCode: 0, lines };
  }
  if (mode === "blocking") {
    for (const e of deficit) lines.push(`[${GATE}] FAIL — ${e.package} draws no display of its own.`);
    for (const e of stale) {
      lines.push(
        `[${GATE}] FAIL — the floor entry ${e.package} no longer applies; ` +
          `remove it with \`node ${GATE_FILE} --write-baseline\`.`,
      );
    }
    if (lines.length === 0) {
      lines.push(`[${GATE}] OK — every claiming extension draws a display of its own.`);
      return { exitCode: 0, lines };
    }
    return { exitCode: 1, lines };
  }
  throw new InfraError(`unknown gate mode "${mode}"`);
}

function refResolves(repoRoot, ref) {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * The floor base guard: growth is an extension the base floor does not hold.
 * One rule of this gate's own: when the base resolves and holds NEITHER the
 * floor NOR this script, the change introduces the gate and passes. A base
 * that holds the script but not the floor fails closed.
 */
export function checkFloorAgainstBase({ repoRoot = DEFAULT_REPO_ROOT, env = process.env, headFloor, floorPath = FLOOR_FILE } = {}) {
  const head = floorEntries(headFloor ?? parseFloor(readFileSync(join(repoRoot, floorPath), "utf8")));
  const result = compareFloorWithBase({
    gate: GATE,
    envVar: FLOOR_BASE_VAR,
    floorPath,
    headFloor: head.map((e) => e.package),
    parse: (text) => parseFloor(text).map((e) => e.package),
    grown: (base, current) => newKeys(base, current),
    repoRoot,
    env,
  });
  if (result.status !== "unreadable" || !result.ref || !refResolves(repoRoot, result.ref)) return result;
  const floorAtBase = readFileAtBase(repoRoot, result.ref, floorPath);
  const gateAtBase = readFileAtBase(repoRoot, result.ref, GATE_FILE);
  if (floorAtBase.ok || gateAtBase.ok) return result;
  return {
    status: "introducing",
    ok: true,
    ref: result.ref,
    lines: [
      `[${GATE}] floor base guard: the base "${result.ref}" holds neither ${floorPath} nor ${GATE_FILE} — ` +
        `this change introduces the gate, and its floor is the first one.`,
    ],
  };
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

function readFloorFile(floorPath, floorRel) {
  if (!existsSync(floorPath)) throw new InfraError(`floor missing: ${floorRel}`);
  try {
    return parseFloor(readFileSync(floorPath, "utf8"));
  } catch (err) {
    throw new InfraError(`unreadable floor: ${floorRel} (${err?.message ?? err})`);
  }
}

function scan({ repoRoot, extensionsRoot, allowPartialFleet }) {
  const mapPath = join(repoRoot, CANONICAL_SOURCES.generatedRenderers);
  if (!existsSync(mapPath)) throw new InfraError(`canonical source missing: ${CANONICAL_SOURCES.generatedRenderers}`);
  let mapText;
  try {
    mapText = readFileSync(mapPath, "utf8");
  } catch (err) {
    throw new InfraError(`unreadable canonical source: ${CANONICAL_SOURCES.generatedRenderers} (${err?.code ?? err})`);
  }
  const generatedEntries = readGeneratedRendererEntries(mapText);
  const extensions = readClaimingExtensions(extensionsRoot);
  if (extensions.length === 0) {
    throw new InfraError(
      `no artifact extension under ${extensionsRoot} — the companion extension tree is not materialized. ` +
        `Run node scripts/ci/sync-dev-extensions.mjs --pinned first; this gate never passes on an empty fleet.`,
    );
  }
  if (!allowPartialFleet) {
    const missing = missingArtifactPacks(expectedArtifactPackNames(repoRoot), discoverArtifactPackNames(extensionsRoot));
    if (missing.length > 0) {
      throw new InfraError(
        `the companion extension tree is PARTIALLY materialized — ${missing.length} pinned artifact pack(s) are absent ` +
          `(${missing.join(", ")}). Run node scripts/ci/sync-dev-extensions.mjs --pinned first.`,
      );
    }
  }
  return { extensions, result: classifyRendering({ extensions, generatedEntries }) };
}

function reportLines({ extensions, result }) {
  const claiming = result.deficit.length + result.ownDisplay.length;
  const lines = [
    `[${GATE}] ${result.deficit.length} of ${claiming} claiming extensions draw no display of their own ` +
      `(${GATE_MODE} mode; ${extensions.length} artifact extensions scanned)`,
  ];
  for (const e of result.deficit) lines.push(`    no own display: ${e.package} (${e.types.join(", ")})`);
  for (const e of result.outside) lines.push(`    outside the gate by construction: ${e.package} — ${e.reason}`);
  return lines;
}

/** Runs the gate; returns the exit code. */
export function main(argv = process.argv.slice(2), env = process.env) {
  const repoRoot = resolve(argValue(argv, "--repo-root") ?? DEFAULT_REPO_ROOT);
  const extensionsRoot = resolve(argValue(argv, "--extensions-root") ?? join(repoRoot, "extensions"));
  const floorRel = argValue(argv, "--baseline") ?? FLOOR_FILE;
  const floorPath = resolve(repoRoot, floorRel);
  const asJson = argv.includes("--json");
  const write = argv.includes("--write-baseline");
  const allowPartialFleet = argv.includes("--allow-partial-fleet");
  const say = asJson ? () => {} : (line) => console.log(line);
  const scannerError = (err) => {
    console.error(`[${GATE}] SCANNER ERROR — ${err.message}`);
    return 2;
  };

  if (write) {
    let scanned;
    let committed = null;
    try {
      if (existsSync(floorPath)) committed = readFloorFile(floorPath, floorRel);
      scanned = scan({ repoRoot, extensionsRoot, allowPartialFleet });
    } catch (err) {
      if (err instanceof InfraError) return scannerError(err);
      throw err;
    }
    for (const line of reportLines(scanned)) say(line);
    let next;
    if (committed === null) {
      next = scanned.result.deficit;
      say(`[${GATE}] floor written: ${next.length} entries (the introducing write) -> ${floorRel}`);
    } else {
      const { stale } = diffAgainstFloor(scanned.result.deficit, committed);
      const staleNames = new Set(stale.map((e) => e.package));
      next = committed.filter((e) => !staleNames.has(e.package)).sort(byPackage);
      for (const e of stale) say(`[${GATE}] floor entry removed: ${e.package}`);
      say(`[${GATE}] floor written: ${next.length} entries (the writer only removes) -> ${floorRel}`);
    }
    mkdirSync(dirname(floorPath), { recursive: true });
    writeFileSync(floorPath, JSON.stringify({ note: FLOOR_NOTE, deficit: next }, null, 2) + "\n");
    return 0;
  }

  let floor;
  try {
    floor = readFloorFile(floorPath, floorRel);
  } catch (err) {
    if (err instanceof InfraError) return scannerError(err);
    throw err;
  }
  const guard = checkFloorAgainstBase({ repoRoot, env, headFloor: floor, floorPath: floorRel });

  let scanned;
  try {
    scanned = scan({ repoRoot, extensionsRoot, allowPartialFleet });
  } catch (err) {
    if (!(err instanceof InfraError)) throw err;
    const code = scannerError(err);
    reportFloorGuard(guard);
    // A failing guard fails first, as in the sibling gates: it reads only the floor.
    return guard.ok ? code : 1;
  }

  const { above, stale } = diffAgainstFloor(scanned.result.deficit, floor);
  const floorVerdict = verdict({ mode: GATE_MODE, above, stale, deficit: scanned.result.deficit });
  const exitCode = Math.max(floorVerdict.exitCode, guard.ok ? 0 : 1);

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          mode: GATE_MODE,
          count: scanned.result.deficit.length,
          claiming: scanned.result.deficit.length + scanned.result.ownDisplay.length,
          scanned: scanned.extensions.length,
          deficit: scanned.result.deficit,
          ownDisplay: scanned.result.ownDisplay,
          outside: scanned.result.outside,
          above: above.map((e) => e.package),
          stale: stale.map((e) => e.package),
          guard: { status: guard.status, ok: guard.ok },
          exitCode,
        },
        null,
        2,
      ),
    );
  }
  for (const line of reportLines(scanned)) say(line);
  for (const line of floorVerdict.lines) (floorVerdict.exitCode === 0 ? say : console.error)(line);
  if (!asJson || !guard.ok) reportFloorGuard(guard);
  return exitCode;
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("extension-rendering-gate.mjs");
if (invokedDirectly) process.exitCode = main();
