// The border words of core's two word-reading checks (cinatra#4848).
//
// THE RULE. The vendor gate (vendor-token-core-gate.mjs) and class 2 of the
// application border gate (application-border-gate.mjs) refuse a core path or
// import specifier that carries a word an extension owns. The words come from
// the extensions, never from the checks: each pinned extension declares its
// own in `cinatra.borderWords` (`vendor` and `domain` lists; the SDK contract
// is packages/sdk-extensions/src/border-words.ts). This module and the checks
// that call it name no word.
//
// THE BRIDGE. Until every pinned pack declares, the words the checks read
// before cinatra#4848 stay in ONE data file, scripts/audit/border-words-bridge.json
// ("words not yet declared by a pack"). The checks read the UNION of the
// declared words and the bridge. The bridge is temporary and only shrinks:
//   - a word both in the bridge and declared by a pinned pack FAILS (remove it
//     from the bridge in the pull request that advances that pack's pin);
//   - a bridge that grew against the base reference FAILS (bridgeGrowth);
//   - a word that left the bridge against the base reference FAILS unless a
//     pinned pack declares it in the SAME list (bridgeShrinkProblems): a word
//     leaves the bridge only into a declaration, never out of the vocabulary;
//   - a pinned pack without the declaration FAILS unless the bridge's
//     `packages` list names it (a WARNING then). That list holds the packs
//     pinned without a declaration when the bridge was introduced; it only
//     shrinks (growth against the base reference FAILS, bridgeGrowth), so a
//     newly pinned pack, a renamed pack (a new name is a new pin) and a pack
//     that drops its declaration must declare. A name in the list that also
//     declares, or that is no longer pinned, FAILS: remove it from the list.
//     The list is the base's grandfathered set because the base's pack
//     manifests are not in git (extensions/ is cloned): only a committed
//     list, read at the base by `git show`, can say which packs were allowed
//     to be silent there. A re-pin to a new commit keeps the name, so it
//     stays listed.
// cinatra#4848 tracks the bridge to empty.
//
// WHEN A PIN ADVANCES, THE PACK DECLARES (cinatra#4896, pinAdvanceProblems).
// The bridge empties by ordinary pack changes, not by a rollout: a pack
// declares in the pull request that next changes it, and core enforces it
// where the fact is read, at the pin. For every pack whose `resolvedSha` in
// either lock (LOCKS) differs between the base reference and the head (a pack
// new to a lock counts as advanced; a pack removed from a lock is not judged):
//   1. the manifest at the newly pinned commit (the cloned extension tree is
//      checked out at the head's pins) must carry a valid `cinatra.borderWords`
//      (the same validation as above), else it FAILS naming the pack and both
//      commits;
//   2. the pack must no longer stand in the bridge's `packages` list at the
//      head, else it FAILS ("its row stays in the bridge").
// A pack whose pin does not move is not judged and keeps its bridge row. So
// from cinatra#4896 on, a pull request that advances the pin of a pack that
// does not declare yet FAILS until the pack declares (a connector pin advance
// like the one of cinatra#4966 would have failed): that is intended.
//   3. Words leave the bridge by hand, in the same pull request, when their
//      last owner declares; the shrink-only rules above keep them from coming
//      back. Ownership is not guessed: a bridge word stays allowed while at
//      least one pack remains in `packages`; with an empty `packages` list,
//      a non-empty word list FAILS.
// The locks are read at the base with `git show` (the same base reference the
// bridge's shrink check uses: VENDOR_TOKEN_BASE / APPLICATION_BORDER_BASE) and
// at the head from the worktree. A base that is set but does not resolve, or a
// lock that cannot be parsed at the head or the base, is a scanner error
// (BorderWordsError). An absent lock holds no pin. Without a base reference
// (a local run) the rule does not run, as the shrink check does not.
//
// FAIL CLOSED. An absent extension tree, a pinned package not found under
// extensions/ by its manifest name, two directories naming one pinned package,
// an unreadable pack manifest, an unreadable or malformed bridge, or SDK constants that
// cannot be read throw a BorderWordsError, which each check maps to exit 2
// (scanner error, never a pass).
//
// The word rules are those of the SDK's `borderWordsIssues`; their DATA (the
// word pattern, the reserved kind words, the host port names) is read from the
// SDK source TEXT here (the conformance-rules idiom: bare `node`, no TS
// toolchain), never re-listed, and a test runs both validators over the same
// cases.

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { discoverExtensionDirs } from "../extension-produces-deps-gate.mjs";
import {
  extractStringArrayConst,
  extractStringConst,
} from "../../extensions/lib/conformance-rules.mjs";

export const BRIDGE_REL = "scripts/audit/border-words-bridge.json";
export const BORDER_WORD_LISTS = Object.freeze(["vendor", "domain"]);
const SDK_BORDER_WORDS_REL = "packages/sdk-extensions/src/border-words.ts";
const SDK_HOST_CONTEXT_REL = "packages/sdk-extensions/src/host-context.ts";
const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const LOCKS = ["cinatra-required-extensions.lock.json", "cinatra-dev-extensions.lock.json"];
const SYNC_HINT =
  "clone the extension tree back first (scripts/ci/sync-dev-extensions.mjs --pinned; CI: the clone-extensions action)";

export class BorderWordsError extends Error {
  constructor(message) {
    super(message);
    this.name = "BorderWordsError";
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** The word rules, read from the SDK source text under `repoRoot`. */
export function loadBorderWordRules(repoRoot) {
  let words;
  let ports;
  try {
    words = readFileSync(join(repoRoot, SDK_BORDER_WORDS_REL), "utf8");
    ports = readFileSync(join(repoRoot, SDK_HOST_CONTEXT_REL), "utf8");
  } catch {
    throw new BorderWordsError(`cannot read ${SDK_BORDER_WORDS_REL} or ${SDK_HOST_CONTEXT_REL}`);
  }
  const pattern = extractStringConst(words, "BORDER_WORD_PATTERN");
  const reserved = extractStringArrayConst(words, "BORDER_WORD_RESERVED_WORDS");
  const hostPorts = extractStringArrayConst(ports, "HOST_PORT_NAMES");
  if (!pattern || !reserved?.length || !hostPorts?.length) {
    throw new BorderWordsError(
      `cannot derive BORDER_WORD_PATTERN, BORDER_WORD_RESERVED_WORDS or HOST_PORT_NAMES from the SDK source`,
    );
  }
  return {
    pattern: new RegExp(pattern),
    patternText: pattern,
    reserved: new Set(reserved),
    hostPorts: new Set(hostPorts.map((p) => p.toLowerCase())),
  };
}

/** The problems of one `cinatra.borderWords` value (mirror of the SDK's borderWordsIssues). */
export function borderWordsIssues(raw, rules) {
  if (raw === undefined) return ["cinatra.borderWords is absent"];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return ["cinatra.borderWords must be an object { vendor: string[], domain: string[], reason?: string }"];
  }
  const issues = [];
  for (const key of Object.keys(raw)) {
    if (![...BORDER_WORD_LISTS, "reason"].includes(key)) issues.push(`cinatra.borderWords has an unknown key "${key}"`);
  }
  const seen = new Map();
  let total = 0;
  for (const list of BORDER_WORD_LISTS) {
    const words = raw[list];
    if (!Array.isArray(words)) {
      issues.push(`cinatra.borderWords.${list} must be an array of words`);
      continue;
    }
    for (const word of words) {
      total += 1;
      if (typeof word !== "string" || !rules.pattern.test(word)) {
        issues.push(`cinatra.borderWords.${list}: ${JSON.stringify(word)} is not one lower-case token (${rules.patternText})`);
        continue;
      }
      if (rules.reserved.has(word)) issues.push(`cinatra.borderWords.${list}: "${word}" is a kind word every extension shares`);
      if (rules.hostPorts.has(word)) issues.push(`cinatra.borderWords.${list}: "${word}" is a host port name`);
      const before = seen.get(word);
      if (before === list) issues.push(`cinatra.borderWords.${list}: "${word}" is repeated`);
      else if (before) issues.push(`cinatra.borderWords: "${word}" is in both vendor and domain`);
      seen.set(word, list);
    }
  }
  const reason = raw.reason;
  if (reason !== undefined && (typeof reason !== "string" || reason.trim() === "")) {
    issues.push("cinatra.borderWords.reason must be a non-empty string");
  } else if (total === 0 && reason === undefined && Array.isArray(raw.vendor) && Array.isArray(raw.domain)) {
    issues.push("cinatra.borderWords declares no word: say why in cinatra.borderWords.reason");
  } else if (total > 0 && reason !== undefined) {
    issues.push("cinatra.borderWords.reason is only for a pack that declares no word");
  }
  return issues;
}

/**
 * The bridge's two word lists and its `packages` list (the pinned packs still
 * allowed to declare nothing) from its text; throws on a malformed bridge.
 */
export function parseBridge(text, rules, where = BRIDGE_REL) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new BorderWordsError(`${where} is not JSON`);
  }
  const out = {};
  const seen = new Set();
  for (const list of BORDER_WORD_LISTS) {
    const words = doc?.[list];
    if (!Array.isArray(words)) throw new BorderWordsError(`${where}: "${list}" must be an array of words`);
    for (const word of words) {
      if (typeof word !== "string" || !rules.pattern.test(word)) {
        throw new BorderWordsError(`${where}: ${JSON.stringify(word)} is not one lower-case token`);
      }
      if (seen.has(word)) throw new BorderWordsError(`${where}: "${word}" appears twice`);
      seen.add(word);
    }
    out[list] = [...words];
  }
  const packages = doc?.packages;
  if (!Array.isArray(packages)) throw new BorderWordsError(`${where}: "packages" must be an array of package names`);
  const names = new Set();
  for (const name of packages) {
    if (typeof name !== "string" || !PACKAGE_NAME.test(name)) {
      throw new BorderWordsError(`${where}: ${JSON.stringify(name)} in "packages" is not a package name`);
    }
    if (names.has(name)) throw new BorderWordsError(`${where}: "${name}" appears twice in "packages"`);
    names.add(name);
  }
  out.packages = [...packages];
  return out;
}

/** The package names the two locks and `cinatra.devExtensions` pin. */
export function pinnedPackageNames(repoRoot) {
  const names = new Set(Object.keys(readJson(join(repoRoot, "package.json"))?.cinatra?.devExtensions ?? {}));
  for (const lock of LOCKS) {
    for (const p of readJson(join(repoRoot, lock))?.packages ?? []) {
      if (typeof p?.packageName === "string") names.add(p.packageName);
    }
  }
  return names;
}

/**
 * Read the border words under `repoRoot`. Returns {
 *   words:      { vendor: string[], domain: string[] }  (declared ∪ bridge, sorted — what the checks match),
 *   declared:   { vendor: Map<word, owners[]>, domain: Map<word, owners[]> },
 *   declarations: Map<package name, issues[]> of every pinned pack ([] = a valid declaration),
 *   bridge:     { vendor: string[], domain: string[], packages: string[] },
 *   undeclared: package names of pinned packs without the declaration (sorted),
 *   problems:   failures (invalid declarations, a word declared in both lists by
 *               different packs, a bridge word also declared, an undeclared pack
 *               the bridge's `packages` list does not name, and a listed pack
 *               that declares or is no longer pinned),
 *   warnings:   one line naming the undeclared packs the bridge still lists,
 *   packCount,
 * }. Throws BorderWordsError on an absent tree, a pinned package not found
 * (or found twice) by its manifest name, an unreadable manifest, or an unreadable or malformed bridge.
 */
export function loadBorderWords(repoRoot) {
  const rules = loadBorderWordRules(repoRoot);
  const bridgePath = join(repoRoot, BRIDGE_REL);
  if (!existsSync(bridgePath)) throw new BorderWordsError(`${BRIDGE_REL} is missing (it holds the words no pack declares yet; empty lists when none)`);
  const bridge = parseBridge(readFileSync(bridgePath, "utf8"), rules);

  // COMPLETENESS BY IDENTITY. Every package the locks and cinatra.devExtensions
  // pin must be found under extensions/ by its manifest `name` (the folder name
  // does not matter). A directory the locks do not pin is ignored for words and
  // never stands in for a missing pinned one; two directories naming the same
  // pinned package are ambiguous. A symlinked pack directory is not followed
  // (discoverExtensionDirs), so its package counts as missing.
  const pinned = pinnedPackageNames(repoRoot);
  const dirs = discoverExtensionDirs(join(repoRoot, "extensions"));
  if (pinned.size === 0 || dirs.length === 0) {
    throw new BorderWordsError(
      `found ${dirs.length} extension package(s) under extensions/ and ${pinned.size} pinned package(s) — ` +
        `${SYNC_HINT}; refusing to read a partial set of border words.`,
    );
  }
  const pinnedDirs = new Map();
  for (const dir of dirs) {
    const pkg = readJson(join(dir, "package.json"));
    if (!pkg || typeof pkg.name !== "string" || !pkg.name) {
      throw new BorderWordsError(`the manifest of the extension package at ${dir} is unreadable or names no package — ${SYNC_HINT}.`);
    }
    if (!pinned.has(pkg.name)) continue;
    if (pinnedDirs.has(pkg.name)) {
      throw new BorderWordsError(`two extension directories name the pinned package ${pkg.name}: ${pinnedDirs.get(pkg.name).dir} and ${dir}.`);
    }
    pinnedDirs.set(pkg.name, { dir, pkg });
  }
  const missing = [...pinned].filter((name) => !pinnedDirs.has(name)).sort();
  if (missing.length) {
    throw new BorderWordsError(
      `${missing.length} pinned package(s) not found under extensions/: ${missing.join(", ")} — ` +
        `${SYNC_HINT}; refusing to read a partial set of border words.`,
    );
  }

  const declared = { vendor: new Map(), domain: new Map() };
  const declarations = new Map();
  const undeclared = [];
  const problems = [];
  let packCount = 0;
  for (const { pkg } of pinnedDirs.values()) {
    packCount += 1;
    const raw = pkg.cinatra?.borderWords;
    const issues = borderWordsIssues(raw, rules);
    declarations.set(pkg.name, issues);
    if (raw === undefined) {
      undeclared.push(pkg.name);
      continue;
    }
    if (issues.length) {
      for (const issue of issues) problems.push(`${pkg.name}: ${issue}`);
      continue;
    }
    for (const list of BORDER_WORD_LISTS) {
      for (const word of raw[list]) {
        const owners = declared[list].get(word) ?? [];
        owners.push(pkg.name);
        declared[list].set(word, owners);
      }
    }
  }
  for (const [word, owners] of declared.vendor) {
    if (declared.domain.has(word)) {
      problems.push(`"${word}" is declared a vendor word by ${owners.join(", ")} and a domain word by ${declared.domain.get(word).join(", ")} — one word, one list`);
    }
  }
  for (const list of BORDER_WORD_LISTS) {
    for (const word of bridge[list]) {
      const owners = [...(declared.vendor.get(word) ?? []), ...(declared.domain.get(word) ?? [])];
      if (owners.length) {
        problems.push(`"${word}" is in the bridge (${BRIDGE_REL}, ${list}) and declared by ${owners.join(", ")} — remove it from the bridge`);
      }
    }
  }
  undeclared.sort();
  // GRANDFATHERING BY NAME. Only a pack the bridge's shrink-only `packages`
  // list names may be pinned without the declaration.
  const listed = new Set(bridge.packages);
  const silent = new Set(undeclared);
  for (const name of undeclared) {
    if (!listed.has(name)) {
      problems.push(
        `${name}: the pinned pack declares no cinatra.borderWords and is not in the bridge's "packages" list ` +
          `(a newly pinned or renamed pack, or one that dropped its declaration, must declare)`,
      );
    }
  }
  for (const name of bridge.packages) {
    if (!pinned.has(name)) {
      problems.push(`${name}: in the bridge's "packages" list (${BRIDGE_REL}) but not pinned — remove it from the list`);
    } else if (!silent.has(name)) {
      problems.push(`${name}: declares cinatra.borderWords but is still in the bridge's "packages" list (${BRIDGE_REL}) — remove it from the list`);
    }
  }
  const grandfathered = undeclared.filter((name) => listed.has(name));
  const warnings = [];
  if (grandfathered.length) {
    warnings.push(
      `${grandfathered.length} pinned pack(s) declare no cinatra.borderWords yet (named in the shrink-only "packages" list ` +
        `of ${BRIDGE_REL} — cinatra#4848): ${grandfathered.join(", ")}`,
    );
  }
  const words = {};
  for (const list of BORDER_WORD_LISTS) words[list] = [...new Set([...declared[list].keys(), ...bridge[list]])].sort();
  return { words, declared, declarations, bridge, undeclared, problems: problems.sort(), warnings, packCount };
}

/**
 * Bridge entries present now but absent at the base (the bridge only shrinks):
 * `vendor: <word>`, `domain: <word>` and `packages: <name>`.
 */
export function bridgeGrowth(baseBridge, bridge) {
  const grown = [];
  for (const list of [...BORDER_WORD_LISTS, "packages"]) {
    const base = new Set(baseBridge?.[list] ?? []);
    for (const word of bridge[list] ?? []) if (!base.has(word)) grown.push(`${list}: ${word}`);
  }
  return grown.sort();
}

/**
 * Bridge words present at the base but gone now that no pinned pack declares
 * in the SAME list (`loaded` is loadBorderWords' result). A word leaves the
 * bridge only into a declaration of its own list: removing it, moving it to the
 * other list, or unpinning the pack that would declare it in the same change
 * would drop it from the words the gate reads. Emptying the bridge is the same
 * rule for every word.
 */
export function bridgeShrinkProblems(baseBridge, loaded) {
  const problems = [];
  for (const list of BORDER_WORD_LISTS) {
    const now = new Set(loaded.bridge[list]);
    for (const word of baseBridge?.[list] ?? []) {
      if (now.has(word) || loaded.declared[list].has(word)) continue;
      problems.push(`${list}: ${word}`);
    }
  }
  return problems.sort();
}

/** The bridge at `ref` (null when the reference holds none: the introducing change). */
export function bridgeAtRef(repoRoot, ref, rules = loadBorderWordRules(repoRoot)) {
  let text;
  try {
    text = execFileSync("git", ["show", `${ref}:${BRIDGE_REL}`], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
  return parseBridge(text, rules, `${BRIDGE_REL} at ${ref}`);
}

/** Is `rel` byte-identical in the worktree and at `ref`? */
export function fileUnchangedAtRef(repoRoot, ref, rel) {
  let atRef;
  try {
    atRef = execFileSync("git", ["show", `${ref}:${rel}`], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return false;
  }
  const path = join(repoRoot, rel);
  if (!existsSync(path)) return false;
  return Buffer.compare(atRef, readFileSync(path)) === 0;
}

/** The pins of one lock text: Map<packageName, resolvedSha>; throws on a lock that cannot be parsed. */
export function parseLockPins(text, where) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new BorderWordsError(`${where} cannot be parsed (not JSON)`);
  }
  if (!Array.isArray(doc?.packages)) throw new BorderWordsError(`${where} cannot be parsed ("packages" is not an array)`);
  const pins = new Map();
  for (const p of doc.packages) {
    if (typeof p?.packageName !== "string" || !p.packageName || typeof p?.resolvedSha !== "string" || !p.resolvedSha) {
      throw new BorderWordsError(`${where} cannot be parsed (an entry lacks packageName or resolvedSha)`);
    }
    if (pins.has(p.packageName)) throw new BorderWordsError(`${where} cannot be parsed ("${p.packageName}" appears twice)`);
    pins.set(p.packageName, p.resolvedSha);
  }
  return pins;
}

function lockPinsAtRef(repoRoot, ref, rel) {
  let listed;
  try {
    listed = execFileSync("git", ["ls-tree", "--name-only", ref, "--", rel], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    throw new BorderWordsError(`cannot read ${rel} at ${ref}`);
  }
  if (listed.trim() === "") return new Map();
  let text;
  try {
    text = execFileSync("git", ["show", `${ref}:${rel}`], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    throw new BorderWordsError(`cannot read ${rel} at ${ref}`);
  }
  return parseLockPins(text, `${rel} at ${ref}`);
}

function lockPinsAtHead(repoRoot, rel) {
  const path = join(repoRoot, rel);
  if (!existsSync(path)) return new Map();
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new BorderWordsError(`${rel} cannot be parsed (unreadable)`);
  }
  return parseLockPins(text, rel);
}

/**
 * The packs whose pin advanced between `baseRef` and the head:
 * Map<packageName, ["<lock>: <base sha | not pinned> -> <head sha>", ...]>.
 */
export function advancedPins(repoRoot, baseRef) {
  if (typeof baseRef !== "string" || baseRef.startsWith("-")) throw new BorderWordsError(`the base reference ${JSON.stringify(baseRef)} is not usable`);
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`], {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    throw new BorderWordsError(`the base reference "${baseRef}" does not resolve — cannot read the locks at the base`);
  }
  const advanced = new Map();
  for (const rel of LOCKS) {
    const base = lockPinsAtRef(repoRoot, baseRef, rel);
    for (const [name, sha] of lockPinsAtHead(repoRoot, rel)) {
      const before = base.get(name);
      if (before === sha) continue;
      const moves = advanced.get(name) ?? [];
      moves.push(`${rel}: ${before ?? "not pinned"} -> ${sha}`);
      advanced.set(name, moves);
    }
  }
  return advanced;
}

/**
 * WHEN A PIN ADVANCES, THE PACK DECLARES (see the header). `loaded` is
 * loadBorderWords' result at the head. Returns { ran, problems }: ran is false
 * (no problem) without a base reference; throws BorderWordsError on a base that
 * does not resolve or a lock that cannot be parsed.
 */
export function pinAdvanceProblems(repoRoot, baseRef, loaded) {
  if (!baseRef) return { ran: false, problems: [] };
  const problems = [];
  const listed = new Set(loaded.bridge.packages);
  for (const [name, moves] of advancedPins(repoRoot, baseRef)) {
    const where = moves.join("; ");
    const issues = loaded.declarations.get(name) ?? ["the pack is not found in the extension tree"];
    if (issues.length) {
      problems.push(
        `${name}: its pin advanced (${where}) and the newly pinned manifest carries no valid cinatra.borderWords ` +
          `(${issues.join("; ")}) — a pack declares when its pin advances`,
      );
    }
    if (listed.has(name)) {
      problems.push(
        `${name}: its pin advanced (${where}) but its row stays in the bridge's "packages" list (${BRIDGE_REL}) — ` +
          `remove it in the same pull request`,
      );
    }
  }
  if (loaded.bridge.packages.length === 0) {
    const left = BORDER_WORD_LISTS.flatMap((list) => loaded.bridge[list].map((word) => `${list}: ${word}`));
    if (left.length) {
      problems.push(
        `the bridge's "packages" list is empty but its word lists still hold ${left.length} word(s) (${left.join(", ")}) — ` +
          `remove them from ${BRIDGE_REL}: no pack is left that could own them`,
      );
    }
  }
  return { ran: true, problems: problems.sort() };
}
