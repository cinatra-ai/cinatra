#!/usr/bin/env node
// THE FLOOR GATE — plan `PLAN: Agents Lifecycle (B)` §5, acceptance item 3
// (cinatra#2931 W4).
//
//   "The conformance gate counts artifact types whose review would land on the
//    fallback — not packages missing a display file. For the bundled fleet it
//    lands immediately as 'no new fallbacks' and finishes at none."
//
// WHAT IT COUNTS. Exactly the state the card's metadata floor is for: an artifact
// TYPE the instance can produce whose review resolves through NO renderer at all
// — no semantic renderer at the row's base identity, no BOUND representation
// provider for any form the type declares, and no first-party form arm either. It
// is deliberately NOT "packages missing a display file": a pack that ships no
// renderer but declares a text form renders through the form rung and is not
// counted, and a type covered by a system representation provider is not counted
// either.
//
// WHAT IT NEVER COUNTS. Defensive states keep their own honest readings and are
// not fallbacks (plan §5): a claimant DECLARED for the type but absent from this
// build is `requires-rebuild`; a deleted or unreadable target and a runtime
// failure are per-ROW protections with no type-level reading at all.
//
// HOW IT RESOLVES. The classifier mirrors, rung for rung, the resolution the
// review path actually runs — `bindArtifactReviewPorts.resolveMount` in
// src/app/artifacts/[id]/review-target-prepare.ts feeding the pure
// `pickArtifactRenderer` leaf:
//
//   1. semantic        — a semantic detail renderer resolves for (type, winner).
//   2. representation  — a BOUND representation provider covers a declared form.
//   3. form rung       — the first-party arm the review binder consumes before
//                        the fallback, for the declared text forms.
//   4. FALLBACK        — counted.
//
// EVERY REACHABLE WINNER, NOT JUST THE UNASSERTED ONE. `pickArtifactRenderer`
// takes the semantic arm only when the renderer's claimant IS the row's
// PRESENTATION identity winner, and `resolvePresentationIdentity` can move that
// winner onto any live claimant of the type (a classic assertion, a matcher
// draft at its threshold, or a binding). An assertion therefore does not only ADD
// a renderer — it can REMOVE one: a row whose owner ships a detail renderer, and
// which is asserted onto a live claimant that ships none, resolves no semantic
// renderer at all. So the classifier resolves each type against EVERY reachable
// winner — its base identity (the type id's namespace definer) plus every pack
// that claims it — and counts the type when ANY of them lands a declared form on
// the fallback. The registry is keyed (objectTypeId, packageName, slot), so a
// winner's renderer counts only for the types that winner actually CLAIMS.
//
// The winner set is a deliberate OVER-approximation: production additionally
// requires an assertion to exist and its extension to be live for the org, which
// is row and install state no static gate can see. So the gate can be red for a
// type production would always render — a false RED, which is loud and fixable,
// never a false green.
//
// THE BUILD MAP IS THE AUTHORITY FOR A BUNDLED PACK, NOT ITS MANIFEST. Reading
// `cinatra.artifact.ui.renderers.detail` out of a manifest would credit a
// renderer production may not have: the bridge parses `ui` TOLERANTLY, so a
// malformed or ABI-incompatible block is DROPPED while the pack's types stay
// registered (cinatra#1621) — the pack then resolves no semantic renderer at all.
// Every rung of that validation (the strict envelope, the closed slot enum, the
// contained entry path, the SDK ABI range) is the generator's job, and the
// generator emits `GENERATED_ARTIFACT_RENDERERS` from these same manifests under
// a fail-closed CI drift check. So for a BUNDLED pack the presence of
// `<pkg>::detail` in the build map IS the statement "this pack ships a renderer
// production will resolve", and this gate reads exactly that. (`requires-rebuild`
// — declared, valid, but absent from THIS build — is the state of a RUNTIME-
// installed marketplace claimant, which is not what this gate scans; for the
// bundled fleet the map and the manifests are generated together.)
//
// SYSTEM PROVIDERS ONLY. A representation provider counts only when the host
// binds it for EVERY org: `systemRepresentationProviderSpecs` projects the
// generated build map filtered to `resolution: "required"`, and expands each
// declared pattern to the EXACT safe-transport MIMEs it matches — never the raw
// wildcard, because a system base renders by pointing at the preview route, which
// 415s everything outside that set. A bundled `guardedOptional` provider is bound
// per ORG from its install rows, so it is not assumed here.
//
// A PARTIAL FLEET IS NOT A PASS. A tree missing one companion repo would simply
// not see that pack's types, so a floor type it declares would be reported by
// neither the count nor the baseline diff. The materialized set is checked
// against the pinned clone-back locks before anything is classified.
//
// NOTHING IS RE-LISTED HERE. Every rule the classifier needs is read from the
// CURRENT text of its single canonical source (the conformance-gate design
// principle, scripts/extensions/lib/conformance-rules.mjs), comments stripped and
// parsed FAIL-CLOSED — a source whose shape this gate cannot fully account for is
// exit 2, never a partial parse that passes.
//
// BASELINE. Shrink-only, exactly like the sibling artifact ratchets: the live
// floor set must EQUAL the committed baseline (a new floor type fails; a stale
// entry fails and must be deleted), and the committed baseline may only shrink
// against the base branch. So the gate "lands immediately as no new fallbacks"
// and can only ever "finish at none".
//
// Usage:
//   node scripts/audit/artifact-review-floor-gate.mjs [--json]
//        [--extensions-root <dir>] [--baseline <file>] [--repo-root <dir>]
//        [--allow-partial-fleet]   (fixture trees only — never in CI)
// Env:
//   ARTIFACT_REVIEW_FLOOR_BASE  base ref for the shrink-only check (optional).
//
// Exit codes: 0 = conform, 1 = finding(s), 2 = infra/usage error (an unreadable
// or unaccounted canonical source, an unmaterialized extension tree, or a base
// ref this gate cannot read — NEVER a silent pass).

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { stripComments } from "./lib/strip-comments.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(__dirname, "..", "..");

export const CANONICAL_SOURCES = Object.freeze({
  mimeAllowlist: "src/lib/artifacts/artifact-read.ts",
  handlerMap: "src/app/artifacts/[id]/pick-handler.ts",
  reviewBinder: "src/app/artifacts/[id]/review-target-prepare.ts",
  dashboardMime: "src/lib/dashboards/dashboard-artifact-twin-writer.ts",
  generatedRenderers: "src/lib/generated/artifact-renderers.ts",
});

export class InfraError extends Error {}

function readSource(repoRoot, relPath) {
  const full = join(repoRoot, relPath);
  if (!existsSync(full)) throw new InfraError(`canonical source missing: ${relPath}`);
  return readFileSync(full, "utf8");
}

// ---------------------------------------------------------------------------
// Rule derivation. Each reader strips comments first (so a quoted example in
// prose can never enter a rule set) and then ACCOUNTS FOR THE WHOLE construct:
// a literal the reader cannot attribute to a parsed rule is an InfraError, not
// a silently narrower rule set.
// ---------------------------------------------------------------------------

/** The host safe-transport MIME set `pickHandler` gates on. */
export function readMimeAllowlist(text) {
  const m = stripComments(text).match(
    /const PREVIEW_INLINE_MIME_ALLOWLIST: ReadonlySet<string> = new Set\(\[([\s\S]*?)\n\]\);/,
  );
  if (!m) throw new InfraError("could not read PREVIEW_INLINE_MIME_ALLOWLIST");
  const body = m[1];
  const mimes = [...body.matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  if (mimes.length === 0) throw new InfraError("PREVIEW_INLINE_MIME_ALLOWLIST parsed empty");
  // Nothing but comma-separated string literals may live in the set literal.
  const residue = body.replace(/"[^"]*"/g, "").replace(/[\s,]/g, "");
  if (residue.length > 0) {
    throw new InfraError(
      `PREVIEW_INLINE_MIME_ALLOWLIST carries unparsed syntax (${residue.slice(0, 40)}) — this gate cannot derive it`,
    );
  }
  return new Set(mimes);
}

/** The host MIME→handler arms `pickHandler` still owns (markdown / text today). */
export function readHandlerMap(text) {
  const fn = stripComments(text).match(
    /export function pickHandler\(mime: string\): HandlerKind \{([\s\S]*?)\n\}/,
  );
  if (!fn) throw new InfraError("could not read pickHandler");
  const body = fn[1];
  const map = new Map();
  // STRUCTURAL, FAIL-CLOSED. `pickHandler` is a flat ladder of
  // `if (<mime equality>) return "<handler>";` statements over one terminal
  // `return "<handler>";`. Every statement in the body must be one of those two
  // shapes: a set-membership test, a switch, a lookup table or a nested block
  // would make this reader silently derive a NARROWER map than the host's real
  // behaviour, and a silently narrower map classifies a live form as a fallback.
  const statements = body
    .split(";")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
  for (const stmt of statements) {
    // The alternation is anchored on an explicit `||` SEPARATOR rather than an
    // optional one: an optional separator makes the repetition ambiguous, and an
    // ambiguous repetition backtracks exponentially on a near-miss.
    const arm = stmt.match(
      /^if \(\s*(mime === "[^"]*"(?:\s*\|\|\s*mime === "[^"]*")*)\s*\) return "([a-z-]+)"$/,
    );
    if (arm) {
      const handler = arm[2];
      if (handler !== "fallback") {
        for (const q of arm[1].matchAll(/"([^"]+)"/g)) map.set(q[1], handler);
      }
      continue;
    }
    if (/^return "[a-z-]+"$/.test(stmt)) continue;
    // The allowlist guard the classifier mirrors in its own right: a MIME
    // outside the host safe-transport set never reaches an arm. Recognized
    // EXACTLY (by the allowlist constant's own name) rather than as "any guard
    // returning fallback", so a future guard on some other condition — which
    // the classifier would NOT model — still refuses to parse.
    if (/^if \(!PREVIEW_INLINE_MIME_ALLOWLIST_FOR_TESTS\.has\(mime\)\) return "fallback"$/.test(stmt)) continue;
    throw new InfraError(
      `pickHandler carries a statement this gate cannot parse (${stmt.replace(/\s+/g, " ").slice(0, 60)}) — it cannot derive the handler map`,
    );
  }
  if (map.size === 0) throw new InfraError("pickHandler parsed no non-fallback arm");
  return map;
}

/** The arms the review binder's form rung actually CONSUMES before the fallback. */
export function readConsumedFormArms(text) {
  const stripped = stripComments(text);
  // Anchor on the rung itself: the condition that guards the `form` mount.
  const rung = stripped.match(
    /if \(((?:\s*dispatch\.handler === "[a-z-]+"\s*(?:\|\||(?=\))))+)\) \{\s*return \{ kind: "form"/,
  );
  if (!rung) throw new InfraError("could not read the review binder's form rung");
  const arms = [...rung[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  if (arms.length === 0) throw new InfraError("the review binder's form rung parsed no arm");
  return new Set(arms);
}

/** The dashboard representation form's MIME (the form declares none in a manifest). */
export function readDashboardMime(text) {
  const m = stripComments(text).match(/const DASHBOARD_RESOURCE_MIME = "([^"]+)"/);
  if (!m) throw new InfraError("could not read DASHBOARD_RESOURCE_MIME");
  return m[1];
}

/** Every entry of the generated build map, with the fields the host's own
 * provider projection reads (`resolution`, `packageName`, `slot`,
 * `representations`). FAIL CLOSED when an entry does not parse. */
export function readGeneratedRendererEntries(text) {
  const table = stripComments(text).match(
    /export const GENERATED_ARTIFACT_RENDERERS: Record<string, GeneratedArtifactRendererEntry> = \{([\s\S]*?)\n\};/,
  );
  if (!table) throw new InfraError("could not read GENERATED_ARTIFACT_RENDERERS");
  const body = table[1];
  // FAIL CLOSED on table residue: every non-blank line of the map literal must
  // BE an entry. A spread, a computed key or a conditional would otherwise be
  // skipped silently, and the derived provider set would be narrower than the
  // build map the host actually resolves through.
  const lines = body.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  for (const line of lines) {
    if (!/^"[^"]+":\s*\{.*\},?$/.test(line)) {
      throw new InfraError(
        `GENERATED_ARTIFACT_RENDERERS carries a line this gate cannot parse (${line.slice(0, 60)}) — it cannot derive its providers`,
      );
    }
  }
  const entries = [];
  for (const line of lines) {
    const key = line.match(/^"([^"]+)":/)[1];
    const resolution = line.match(/resolution:\s*"([a-zA-Z]+)"/);
    const packageName = line.match(/"packageName":"([^"]+)"/);
    // The v1 slot enum is CAMEL-CASED (`listRow`, since S7/M2) — this reader
    // must admit every slot the generator can emit. A lowercase-only class
    // made the gate fail closed the moment ANY extension adopted the list-row
    // slot (Lifecycle D W7, cinatra#3095): the slot is a per-extension OPTION
    // and is never part of this gate's rule set, so it must PARSE here and
    // then be ignored by the classifier, which reads the `detail` slot alone.
    const slot = line.match(/"slot":"([A-Za-z]+)"/);
    const reps = line.match(/"representations":\[([^\]]*)\]/);
    if (!resolution || !packageName || !slot || !reps) {
      throw new InfraError(`generated renderer entry "${key}" does not parse — this gate cannot derive its providers`);
    }
    entries.push({
      key,
      resolution: resolution[1],
      packageName: packageName[1],
      slot: slot[1],
      representations: [...reps[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]),
    });
  }
  if (entries.length === 0) throw new InfraError("GENERATED_ARTIFACT_RENDERERS parsed empty");
  return entries;
}

// ---------------------------------------------------------------------------
// Resolution mirrors.
// ---------------------------------------------------------------------------

// BYTE-MIRROR of `representationMatchSpecificity` in
// packages/objects/src/artifact-renderer-registry.ts (a .mjs gate cannot import
// the TS leaf). The mirror is pinned by the gate's own test, which extracts the
// canonical function's body and fails on any drift.
export function representationMatchSpecificity(pattern, mime) {
  if (pattern === mime) return 3;
  if (pattern === "*/*") return 1;
  const star = pattern.indexOf("/*");
  if (star > 0 && star === pattern.length - 2) {
    const prefix = pattern.slice(0, star + 1);
    if (mime.startsWith(prefix)) return 2;
  }
  return -1;
}

/**
 * The representation providers bound for EVERY org at the review path's slot —
 * the mirror of `systemRepresentationProviderSpecs()` in
 * src/lib/artifacts/system-artifact-renderer-registrar.ts: the generated map
 * filtered to `resolution: "required"`, each declared pattern expanded to the
 * EXACT safe-transport MIMEs it matches, never the raw wildcard. A bundled
 * `guardedOptional` provider binds per ORG from its install rows and is not
 * assumed here.
 */
export function boundRepresentationProviders(entries, mimeAllowlist, slot = "detail") {
  const byMime = new Map();
  for (const entry of entries) {
    if (entry.resolution !== "required") continue;
    if (entry.slot !== slot) continue;
    for (const pattern of entry.representations) {
      for (const mime of mimeAllowlist) {
        if (representationMatchSpecificity(pattern, mime) < 0) continue;
        if (!byMime.has(mime)) byMime.set(mime, entry.packageName);
      }
    }
  }
  return byMime;
}

/** The type id's NAMESPACE — the BASE identity's winner for a row of this type
 * (`resolveEffectiveIdentity`: `@scope/pkg:slug` → `@scope/pkg`). */
export function typeNamespace(objectTypeId) {
  const idx = objectTypeId.indexOf(":");
  if (idx <= 0) return null;
  const pkg = objectTypeId.slice(0, idx);
  return /^@[\w-]+\/[\w-]+$/.test(pkg) ? pkg : null;
}

/** A pack's declared representation forms, as the MIMEs a written row can carry. */
export function declaredFormMimes(accepts, dashboardMime) {
  const mimes = [];
  for (const m of accepts?.file?.mimeTypes ?? []) mimes.push(m);
  for (const m of accepts?.connectorRef?.resolvedMimeTypes ?? []) mimes.push(m);
  if (accepts?.dashboard === true) mimes.push(dashboardMime);
  return [...new Set(mimes)];
}

// ---------------------------------------------------------------------------
// Discovery — the shipped registry the review path resolves through.
// ---------------------------------------------------------------------------

/** The bundled-scan layout `registerArtifactExtensions` walks: a pack dir named
 * `*-artifact` / `*-artifacts`, at the root or under a vendor dir. */
export function isArtifactExtensionDirName(name) {
  return name.endsWith("-artifact") || name.endsWith("-artifacts");
}

/** Every artifact-pack DIRECTORY the tree carries, by package name — including a
 * pack that declares no `objectTypes` (it mints no type, but it IS materialized).
 * This is what the completeness check compares the pinned locks against. */
export function discoverArtifactPackNames(root) {
  const names = new Set();
  for (const dir of artifactPackDirs(root)) {
    const manifestPath = join(dir, "package.json");
    if (!existsSync(manifestPath)) continue;
    try {
      const name = JSON.parse(readFileSync(manifestPath, "utf8"))?.name;
      if (typeof name === "string") names.add(name);
    } catch {
      throw new InfraError(`unreadable extension manifest: ${manifestPath}`);
    }
  }
  return names;
}

function artifactPackDirs(root) {
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
  scan(root);
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (e.isDirectory() && !isArtifactExtensionDirName(e.name)) scan(join(root, e.name));
  }
  return dirs;
}

export function discoverArtifactPacks(root) {
  const packs = [];
  for (const dir of artifactPackDirs(root)) {
    const manifestPath = join(dir, "package.json");
    if (!existsSync(manifestPath)) continue;
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      throw new InfraError(`unreadable extension manifest: ${manifestPath}`);
    }
    if (pkg?.cinatra?.kind !== "artifact") continue;
    const artifact = pkg.cinatra.artifact;
    // A manifest declaring no `objectTypes` mints NO type (the bridge's no-op
    // path) — it can put nothing under review, so it is not scanned.
    if (!artifact || !Array.isArray(artifact.objectTypes)) continue;
    packs.push({
      packageName: pkg.name,
      types: artifact.objectTypes.map((t) => t?.type).filter((t) => typeof t === "string"),
      accepts: artifact.accepts ?? {},
    });
  }
  return packs.sort((a, b) => (a.packageName < b.packageName ? -1 : 1));
}

/**
 * The live artifact TYPES the fleet can put under review, with the forms their
 * rows can carry. A pack registers only the types it OWNS (`registerDeclaredArtifactTypes`:
 * ownership is by NAMESPACE), but a well-formed CROSS-NAMESPACE claim still names a
 * live type this pack writes into — its owner registers it — so both are counted,
 * each carrying the declaring pack's forms. A non-namespaced claim is skipped
 * exactly as the bridge skips it.
 */
export function inventoryTypes(packs, dashboardMime) {
  const byType = new Map();
  for (const pack of packs) {
    const forms = declaredFormMimes(pack.accepts, dashboardMime);
    for (const type of pack.types) {
      if (typeNamespace(type) === null) continue; // malformed id: the bridge skips it
      const entry = byType.get(type) ?? { type, declaredBy: [], formMimes: [] };
      entry.declaredBy.push(pack.packageName);
      for (const m of forms) if (!entry.formMimes.includes(m)) entry.formMimes.push(m);
      byType.set(type, entry);
    }
  }
  return [...byType.values()].sort((a, b) => (a.type < b.type ? -1 : 1));
}

// ---------------------------------------------------------------------------
// The classifier — the review path's ladder, rung for rung.
// ---------------------------------------------------------------------------

/**
 * Every identity that can WIN a row of this type, and therefore every semantic
 * resolution a reader can actually reach.
 *
 * `pickArtifactRenderer` takes the semantic arm only when the renderer's claimant
 * IS the row's presentation-identity winner, and `resolvePresentationIdentity`
 * can move that winner onto ANY live claimant of the type (classic assertion,
 * matcher draft, or binding). So the reachable winners are the row's BASE
 * identity — the type id's namespace definer — plus every pack that claims the
 * type. A type is safe only when EVERY one of them resolves a renderer; if any
 * reachable winner resolves none, a reader can be looking at that row.
 */
export function reachableWinners(type, packs) {
  const names = new Set();
  const base = typeNamespace(type);
  if (base) names.add(base); // always reachable: the unasserted row
  for (const pack of packs) if (pack.types.includes(type)) names.add(pack.packageName);
  return [...names].sort();
}

export function classifyDeclaredTypes(input) {
  const { packs, mimeAllowlist, handlerMap, consumedFormArms, generatedEntries, dashboardMime } = input;

  const packsByName = new Map(packs.map((p) => [p.packageName, p]));
  const loadable = new Set(generatedEntries.map((e) => e.key));
  const providers = boundRepresentationProviders(generatedEntries, mimeAllowlist, "detail");

  /** The semantic rung for ONE (type, winner): the registry is keyed
   * (objectTypeId, packageName, slot), so the winner must CLAIM this exact type
   * AND ship a detail renderer THE BUILD CARRIES. `null` = this winner resolves
   * none, and the declared forms decide. */
  const semanticFor = (type, winnerName) => {
    const pack = packsByName.get(winnerName);
    if (!pack) return null;
    if (!pack.types.includes(type)) return null;
    return loadable.has(`${winnerName}::detail`) ? "semantic" : null;
  };

  const rows = [];
  for (const entry of inventoryTypes(packs, dashboardMime)) {
    const winners = reachableWinners(entry.type, packs);
    const bare = winners.filter((w) => semanticFor(entry.type, w) === null);

    if (bare.length === 0) {
      // Every reachable winner resolves a renderer for this type.
      rows.push({ type: entry.type, package: winners[0], mime: null, rung: "semantic", floor: false });
      continue;
    }

    // At least one reachable winner resolves NO semantic renderer — for a row
    // presenting as that identity the forms decide.
    const declaredBy = entry.declaredBy[0] ?? bare[0];
    if (entry.formMimes.length === 0) {
      rows.push({ type: entry.type, package: declaredBy, mime: null, rung: "fallback", winner: bare[0], floor: true });
      continue;
    }
    for (const mime of entry.formMimes) {
      const via = providers.get(mime);
      if (via) {
        rows.push({ type: entry.type, package: declaredBy, mime, rung: "representation", via, floor: false });
        continue;
      }
      const handler = mimeAllowlist.has(mime) ? (handlerMap.get(mime) ?? null) : null;
      if (handler && consumedFormArms.has(handler)) {
        rows.push({ type: entry.type, package: declaredBy, mime, rung: `form:${handler}`, floor: false });
        continue;
      }
      rows.push({ type: entry.type, package: declaredBy, mime, rung: "fallback", winner: bare[0], floor: true });
    }
  }

  const floorTypes = [];
  const seen = new Set();
  for (const r of rows) {
    if (!r.floor || seen.has(r.type)) continue;
    seen.add(r.type);
    floorTypes.push({ type: r.type, package: r.package, mime: r.mime });
  }
  floorTypes.sort((a, b) => (a.type < b.type ? -1 : 1));
  return { rows, floorTypes, typeCount: new Set(rows.map((r) => r.type)).size };
}

/**
 * The artifact packs the pinned companion set says MUST be on disk. A non-empty
 * scan is not enough: a tree missing one companion repo would simply not see
 * that pack's types, and a floor type it introduces would be reported by
 * neither `added` nor `stale`. The expected set is the union of the two
 * committed clone-back locks, narrowed to the artifact-pack naming convention
 * the bridge's own scan uses.
 */
export function expectedArtifactPackNames(repoRoot) {
  const names = new Set();
  let sawLock = false;
  for (const rel of ["cinatra-required-extensions.lock.json", "cinatra-dev-extensions.lock.json"]) {
    const full = join(repoRoot, rel);
    if (!existsSync(full)) continue;
    sawLock = true;
    let lock;
    try {
      lock = JSON.parse(readFileSync(full, "utf8"));
    } catch {
      throw new InfraError(`unreadable clone-back lock: ${rel}`);
    }
    for (const entry of lock?.packages ?? []) {
      const name = entry?.packageName;
      if (typeof name !== "string") continue;
      if (isArtifactExtensionDirName(name)) names.add(name);
    }
  }
  if (!sawLock) throw new InfraError("no clone-back lock found — cannot verify the fleet is fully materialized");
  return names;
}

/** The packs the locks name but the tree does not carry ON DISK. A materialized
 * pack that declares no `objectTypes` mints no type and is correctly absent from
 * the scanned set — it is NOT missing. */
export function missingArtifactPacks(expected, presentNames) {
  return [...expected].filter((n) => !presentNames.has(n)).sort();
}

// ---------------------------------------------------------------------------
// Baseline.
// ---------------------------------------------------------------------------

export function baselineTypeIds(baseline) {
  return new Set((baseline?.floorTypes ?? []).map((e) => e.type));
}

/** Live vs committed: a NEW floor type fails; a stale entry fails (shrink-only). */
export function diffAgainstBaseline(floorTypes, baseline) {
  const committed = baselineTypeIds(baseline);
  const live = new Set(floorTypes.map((e) => e.type));
  return {
    added: [...live].filter((t) => !committed.has(t)).sort(),
    stale: [...committed].filter((t) => !live.has(t)).sort(),
  };
}

/** The committed baseline may only SHRINK against the base branch's. */
export function baselineGrowth(committed, base) {
  const b = baselineTypeIds(base);
  return [...baselineTypeIds(committed)].filter((t) => !b.has(t)).sort();
}

/**
 * The base branch's baseline, or `null` when the path genuinely does not exist
 * there (this gate's own first landing). FAIL CLOSED otherwise: an unresolvable
 * ref, an unreadable blob or invalid JSON is an InfraError, never a silently
 * skipped monotonic guard.
 */
export function readBaseBaseline(repoRoot, baseRef, relPath) {
  const git = (args) =>
    execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    git(["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`]);
  } catch {
    throw new InfraError(`base ref '${baseRef}' does not resolve — cannot check the shrink-only guard`);
  }
  try {
    git(["cat-file", "-e", `${baseRef}:${relPath}`]);
  } catch {
    return null; // genuinely absent on the base branch: first landing.
  }
  let text;
  try {
    text = git(["show", `${baseRef}:${relPath}`]);
  } catch {
    throw new InfraError(`could not read ${relPath} at '${baseRef}'`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new InfraError(`the baseline at '${baseRef}' is not valid JSON`);
  }
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

export function main(argv = process.argv.slice(2)) {
  const repoRoot = resolve(argValue(argv, "--repo-root") ?? DEFAULT_REPO_ROOT);
  const extensionsRoot = resolve(argValue(argv, "--extensions-root") ?? join(repoRoot, "extensions"));
  const baselineRel = argValue(argv, "--baseline") ?? "scripts/audit/artifact-review-floor.baseline.json";
  const baselinePath = resolve(repoRoot, baselineRel);
  const asJson = argv.includes("--json");
  // With --json the report IS the JSON document: nothing else reaches stdout.
  const say = asJson ? () => {} : (line) => console.log(line);

  let result;
  let packs;
  let baseline;
  let grew = [];
  try {
    const mimeAllowlist = readMimeAllowlist(readSource(repoRoot, CANONICAL_SOURCES.mimeAllowlist));
    const handlerMap = readHandlerMap(readSource(repoRoot, CANONICAL_SOURCES.handlerMap));
    const consumedFormArms = readConsumedFormArms(readSource(repoRoot, CANONICAL_SOURCES.reviewBinder));
    const dashboardMime = readDashboardMime(readSource(repoRoot, CANONICAL_SOURCES.dashboardMime));
    const generatedEntries = readGeneratedRendererEntries(
      readSource(repoRoot, CANONICAL_SOURCES.generatedRenderers),
    );
    packs = discoverArtifactPacks(extensionsRoot);
    if (packs.length === 0) {
      throw new InfraError(
        `no artifact extension packs under ${extensionsRoot} — the companion extension tree is not materialized. ` +
          `Run the clone-extensions step (node scripts/ci/sync-dev-extensions.mjs --pinned) first; ` +
          `this gate never passes on an empty fleet.`,
      );
    }
    if (!argv.includes("--allow-partial-fleet")) {
      const missing = missingArtifactPacks(
        expectedArtifactPackNames(repoRoot),
        discoverArtifactPackNames(extensionsRoot),
      );
      if (missing.length > 0) {
        throw new InfraError(
          `the companion extension tree is PARTIALLY materialized — ${missing.length} pinned artifact pack(s) are absent ` +
            `(${missing.join(", ")}). A partial fleet hides the floor types those packs declare; ` +
            `run the clone-extensions step (node scripts/ci/sync-dev-extensions.mjs --pinned) first.`,
        );
      }
    }
    result = classifyDeclaredTypes({
      packs,
      mimeAllowlist,
      handlerMap,
      consumedFormArms,
      generatedEntries,
      dashboardMime,
    });

    if (!existsSync(baselinePath)) throw new InfraError(`baseline missing: ${baselineRel}`);
    try {
      baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
    } catch {
      throw new InfraError(`unreadable baseline: ${baselineRel}`);
    }

    const baseRef = process.env.ARTIFACT_REVIEW_FLOOR_BASE;
    if (baseRef) {
      const base = readBaseBaseline(repoRoot, baseRef, baselineRel);
      if (base) grew = baselineGrowth(baseline, base);
    }
  } catch (err) {
    if (err instanceof InfraError) {
      console.error(`[artifact-review-floor] INFRA — ${err.message}`);
      process.exit(2);
    }
    throw err;
  }

  const { added, stale } = diffAgainstBaseline(result.floorTypes, baseline);

  if (asJson) {
    console.log(
      JSON.stringify(
        { count: result.floorTypes.length, typeCount: result.typeCount, packCount: packs.length, floorTypes: result.floorTypes, added, stale, grew },
        null,
        2,
      ),
    );
  }

  // THE COUNT — reported on every run, pass or fail (acceptance item 3).
  say(
    `[artifact-review-floor] ${result.floorTypes.length} of ${result.typeCount} artifact type` +
      `${result.typeCount === 1 ? "" : "s"} would land on the metadata floor under review ` +
      `(${packs.length} packs scanned; defensive states excluded).`,
  );
  for (const e of result.floorTypes) {
    say(`    floor: ${e.type} [${e.package}]${e.mime ? ` form ${e.mime}` : " (no declared form)"}`);
  }

  if (added.length === 0 && stale.length === 0 && grew.length === 0) {
    say(
      `[artifact-review-floor] OK — no new fallbacks (${result.floorTypes.length} baselined; the baseline may only shrink).`,
    );
    process.exit(0);
  }

  if (added.length) {
    console.error(
      `[artifact-review-floor] FAIL — ${added.length} artifact type${added.length === 1 ? "" : "s"} would NEWLY land on the metadata floor:`,
    );
    for (const t of added) {
      const e = result.floorTypes.find((f) => f.type === t);
      console.error(`  + ${t} [${e.package}]${e.mime ? ` form ${e.mime}` : " (no declared form)"}`);
    }
    console.error(
      `\n  Fix: give the type a renderer its own package owns (\`cinatra.artifact.ui.renderers.detail\`),\n` +
        `  or declare a form the card already renders. A review must never be reviewable only as a floor.`,
    );
  }
  if (stale.length) {
    console.error(
      `[artifact-review-floor] FAIL — ${stale.length} baselined type${stale.length === 1 ? "" : "s"} no longer land${stale.length === 1 ? "s" : ""} on the floor (the baseline only shrinks — delete the entr${stale.length === 1 ? "y" : "ies"}):`,
    );
    for (const t of stale) console.error(`  - ${t}`);
  }
  if (grew.length) {
    console.error(
      `[artifact-review-floor] FAIL — committed baseline GREW vs the base branch (regenerate-to-pass bypass):`,
    );
    for (const t of grew) console.error(`  + ${t}`);
  }
  process.exit(1);
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("artifact-review-floor-gate.mjs");
if (invokedDirectly) main();
