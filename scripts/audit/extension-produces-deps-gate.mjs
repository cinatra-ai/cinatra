#!/usr/bin/env node
/**
 * Produced-artifact dependency gate (cinatra#2537) — no-new-rot ratchet.
 *
 * A producing agent declares the artifact extension it emits as
 * `cinatra.produces: [{ extension, objectTypeId? }]` (in `package.json#cinatra`
 * and/or in `cinatra/oas.json` at `metadata.cinatra.produces`). That
 * declaration is NOT itself an install edge: unless the SAME manifest also
 * declares the target in `cinatra.dependencies` as a REQUIRED artifact-kind
 * dependency, installing the agent never installs the artifact — no
 * `installed_extension` row, no `artifact_type_claims` row — and every run
 * fails materialization with the misleading "declares no artifact-safe object
 * type" error. Five shipped agents were in exactly that state (cinatra#2537's
 * org-wide audit; #2536 is the instance-level symptom).
 *
 * This gate is the CATALOG-WIDE STATIC MIRROR of the runtime typed-production
 * closure contract (`evaluateTypedProducesContract` in
 * `packages/agents/src/verdaccio/package-contract.ts`, cinatra#1788 Layer 3),
 * which enforces the same rule FAIL-CLOSED at the publish and install seams.
 * The runtime contract only fires when a package is published or installed, so
 * it cannot see an already-published offender sitting in a source repo; this
 * gate reads every synced extension manifest on every host CI run and fails on
 * a NEW one. Deliberately a MIRROR, not an import: the contract is TypeScript
 * inside a workspace package and this gate is a zero-dependency `.mjs` that
 * must run under plain `node` before/without a build (same constraint as every
 * sibling in `scripts/audit/`). The mirrored rule is stated once, here:
 *
 *   every `produces` entry must name an extension that the producing manifest
 *   declares in `cinatra.dependencies` as an INSTALL-CLOSURE-GUARANTEED edge —
 *   `kind: "artifact"` AND `requirement: "required"` AND `edgeType !== "peer"`,
 *   byte-for-byte the runtime's `requiredArtifactDependencies` predicate — that
 *   resolves to a real `kind: "artifact"` extension, and — when the entry
 *   carries an `objectTypeId` — whose manifest declares that exact
 *   `cinatra.artifact.objectTypes[].type` claim. `kind` is REQUIRED, not
 *   optional: the runtime predicate tests `raw.kind === "artifact"`, so an edge
 *   that omits `kind` is NOT a closure member and would BLOCK at publish/install
 *   even though it looks declared.
 *
 * Two finding classes, both scanned in one pass and both ratcheted:
 *
 *  1. `undeclaredProducesDeps` — the produced extension is not a REQUIRED
 *     dependency of the producer: absent from `cinatra.dependencies`, or
 *     present with `requirement !== "required"` (the install resolver treats
 *     any non-required edge as optional, so the artifact may simply not be
 *     installed — the same failure with a false sense of safety), or present
 *     with an explicit `kind` that is not `"artifact"`. This is the class the
 *     five #2537 offenders are in.
 *
 *  2. `unresolvedProducesTargets` — the produced extension is not a RESOLVABLE
 *     artifact: it is absent from the synced extension catalog (the universe
 *     host CI materializes from cinatra-{dev,required}-extensions.lock.json —
 *     which is also the installable universe), it resolves to a non-artifact
 *     kind, or the entry's `objectTypeId` is not claimed by the target's
 *     `cinatra.artifact.objectTypes`. Adding a `dependencies` entry pointing at
 *     a RETIRED extension would satisfy class 1 while shipping something more
 *     broken, so class 1 alone is not enough — `@cinatra-ai/media-transcript-agent`
 *     produces the retired, archived `@cinatra-ai/default-artifact` (epic
 *     cinatra#1785 wave A5 + migration core__0059), and only this class sees it.
 *
 * `consumes` is scanned too, but note the shape: the canonical
 * `cinatra.consumes` is a CONSUMED-PRIMITIVE declaration
 * (`{primitive, requirement}`), not an extension reference — the connector
 * behind a primitive is covered by the publish-time connector-dependency
 * validation and by `extension-deps-gate.mjs`, not here. No extension-shaped
 * `consumes` entry exists in the catalog today; the scanner accepts one
 * (`{extension, objectTypeId?}`) so that a future consumed-extension edge is
 * gated from the moment it appears rather than silently unguarded.
 *
 * ACCEPTED DIVERGENCES from the runtime contract — named, not hidden (codex
 * review of this PR). Each is a consequence of being an OFFLINE static scan of
 * a pinned source tree rather than a registry-resolving runtime seam:
 *
 *   a. VERSION SELECTION. The runtime resolves each required artifact dep at
 *      the version its `versionConstraint` selects (`artifactDepVersionQuery`)
 *      and reads THAT manifest's claims. This gate reads the claims of the
 *      version SYNCED into the host tree (the sha pinned in the extension
 *      lock). Those can differ, so an `objectTypeId` verdict here is evidence
 *      about the pinned tree, not a registry-resolution proof — the
 *      publish/install seam stays authoritative for the exact version. In
 *      exchange this runs on every host PR with no registry access.
 *   b. CATALOG SUPERSET (`unresolvedProducesTargets`, absent-target case). For
 *      a COARSE `{extension}` entry the runtime requires only that the target
 *      be a required artifact-kind edge — an unresolvable manifest contributes
 *      an empty claim set and a coarse entry still passes. This gate
 *      additionally requires the target to EXIST in the synced catalog, which
 *      is deliberately STRICTER: it is the only check that catches a produces
 *      edge pointing at a RETIRED extension (the #2537 media-transcript case),
 *      where satisfying class 1 alone would ship a dependency on something that
 *      can never install. A target that is legitimately published but outside
 *      both extension locks is therefore a finding here: resolve it by adding
 *      the target to the lock (so host CI validates it) or by baselining the
 *      pair with a `notes` entry saying why.
 *   c. SHAPE STRICTNESS. The runtime `agentProducesSchema` is `.strict()` and
 *      refuses unknown keys; this gate does not re-litigate unknown keys (that
 *      check already exists at publish and in each repo's vendored
 *      extension-kind-gate, and duplicating it here would drift). It DOES fail
 *      closed on a shape it cannot READ (see `collectProducesEdges`), including
 *      in the OAS mirror — the OAS block is "consistency, not the source of
 *      truth", but an unreadable mirror hides an edge from this scan, and a
 *      companion repo shipping one is a manifest bug the host should see when
 *      its pin moves, not a silent false negative.
 *
 * SCOPE / known limitation (honest): the scan sees the SYNCED extension tree
 * (`extensions/<vendor>/<name>`), i.e. exactly the packages pinned in
 * cinatra-{dev,required}-extensions.lock.json. Extension repos that exist in
 * the org but are not in either lock — e.g. the assistant agent repos
 * (`cinatra-assistant`, `claude-assistant`, `openai-assistant`,
 * `gemini-assistant`, `drupal-assistant`, `wordpress-assistant`), which the
 * #2537 thread confirms are file-based and currently CLEAN (no produces edge
 * at all) — are not materialized here and are therefore not scanned. They are
 * covered the moment they enter a lock; until then their own repo CI plus the
 * publish/install seam contract remain their enforcement. This gate does not
 * pretend otherwise, and it fails closed rather than passing vacuously when the
 * tree is missing (see `scan`).
 *
 * Modes:
 *   node scripts/audit/extension-produces-deps-gate.mjs                  # check (exit 1 on a NEW finding)
 *   node scripts/audit/extension-produces-deps-gate.mjs --report         # reproducible audit: list every offender, exit 0
 *   node scripts/audit/extension-produces-deps-gate.mjs --write-baseline # regenerate the baseline data
 *
 * The baseline records the CURRENT tolerated debt (the five #2537 offenders,
 * grandfathered at the pinned shas host CI validates); they are fixed by PRs on
 * the offending extension repos and drop out of the baseline when the pins are
 * bumped through the normal pin flow. `EXTENSION_PRODUCES_DEPS_BASE` (wired from
 * the CI base ref) additionally blocks the regenerate-to-pass bypass: the
 * committed baseline may only ever SHRINK relative to the base branch.
 *
 * Exit codes: 0 = clean, 1 = findings / baseline growth, 2 = scanner error.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative } from "node:path";

const REPO_ROOT = process.cwd();
const EXTENSIONS_ROOT = join(REPO_ROOT, "extensions");
const BASELINE_REL = "scripts/audit/extension-produces-deps-gate.baseline.json";
const BASELINE_FILE = join(REPO_ROOT, BASELINE_REL);

const BASELINE_NOTE =
  "Produced-artifact dependency baseline (no-new-rot ratchet, cinatra#2537). " +
  "`undeclaredProducesDeps` = a `cinatra.produces`/`consumes` entry whose target extension is NOT declared " +
  "in the SAME manifest's `cinatra.dependencies` as a required artifact-kind edge — installing the producer " +
  "therefore never installs the produced artifact and every run fails materialization. " +
  "`unresolvedProducesTargets` = a produced target that does not resolve to a real artifact extension in the " +
  "synced catalog (absent / wrong kind / unclaimed objectTypeId) — so declaring it as a dependency would not " +
  "fix anything. `notes` carries the REASON each grandfathered (package, target) pair is tolerated — a manual, " +
  "version-controlled record; NOT diffed by the gate. These are CURRENT tolerated misses; the gate fails on " +
  "NEW/GROWN entries. Regenerate the data with " +
  "`node scripts/audit/extension-produces-deps-gate.mjs --write-baseline` — every data entry should only ever " +
  "be REMOVED (fix the producing repo, then bump its pin), never added; carry `notes` forward by hand for " +
  "anything re-baselined this way.";

// The finding classes, in report order. Adding a class means adding it here AND
// deciding explicitly whether it is bootstrap-eligible (BOOTSTRAPPABLE_CLASSES).
export const FINDING_CLASSES = ["undeclaredProducesDeps", "unresolvedProducesTargets"];

// The ONLY baseline classes whose one-time introduction is exempt from the
// base-ref growth guard (see `classGrowth`). EMPTY, deliberately: BOTH classes
// of this gate are born with the baseline FILE, and an absent base-branch file
// is already handled upstream as the gate's own bootstrap (see `main`). So an
// absent CLASS in a PRESENT base baseline is never a legitimate bootstrap here
// — it is a corrupted baseline or a delete-and-re-add laundering attempt, and
// both must fail closed. The mechanism is kept (mirroring
// workspace-phantom-deps.mjs, cinatra#2521) as the explicit extension point: a
// future NEW class added to an already-shipped baseline is added to this line
// in the same PR that introduces it — one explicit, reviewable token.
const BOOTSTRAPPABLE_CLASSES = new Set([]);

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in __tests__/extension-produces-deps-gate.test.mjs)
// ---------------------------------------------------------------------------

/** Byte-mirror of the `objectTypeId` / claim-id regex shared by
 *  `agentProducesSchema` (package-contract.ts), the `agent-produces-reader`
 *  leaf and `CLAIMED_OBJECT_TYPE_ID_RE` (@cinatra-ai/objects claims). */
const OBJECT_TYPE_ID_RE = /^@[\w-]+\/[\w-]+:[\w-]+$/;

/**
 * Read the produced/consumed EXTENSION edges declared by one extension.
 *
 * Sources, both scanned (an agent may declare the edge in either or both, and
 * the #2537 audit found agents that declare it in only one):
 *   - `package.json#cinatra.produces` / `.consumes`  — THE AUTHORITY: publish,
 *     install and the run-completion materializer read this block and no other.
 *   - `cinatra/oas.json` at `metadata.cinatra.produces` / `.consumes` — an
 *     OPTIONAL mirror for readers of the service description. Since cinatra#3095
 *     the OAS compiler refuses a compile whose mirror is not entry-for-entry
 *     equal to the manifest's block, so the two sources can no longer state
 *     different things; the union below is a convenience, never a reconciliation.
 *
 * Returns `{ edges, malformed }`. An edge is `{ field, source, extension,
 * objectTypeId? }`. `malformed` lists human-readable shape problems: a
 * non-array `produces`/`consumes`, or an entry that is not an object. Those are
 * FAIL-CLOSED (a shape the gate cannot read is a shape it cannot verify) rather
 * than silently dropped — the runtime reader's "quietly empty on bad input"
 * posture is right for a hot path and wrong for a gate.
 *
 * A `consumes` entry carrying a non-empty string `primitive` is the canonical
 * consumed-PRIMITIVE shape (not an extension reference): skipped, not
 * malformed — and the `primitive` test runs FIRST, so a valid primitive entry
 * carrying an incidental extra `extension` key (the SDK consumes parser
 * TOLERATES extra keys) is still read as a primitive consume rather than
 * silently gated as a produced-artifact edge. In `produces` there is no
 * primitive shape at all: an entry with no `extension` there is malformed.
 * See the file header.
 */
export function collectProducesEdges({ packageJson, oasJson }) {
  const edges = [];
  const malformed = [];
  const sources = [
    { source: "package.json", block: packageJson?.cinatra },
    { source: "cinatra/oas.json", block: oasJson?.metadata?.cinatra },
  ];
  for (const { source, block } of sources) {
    if (!block || typeof block !== "object") continue;
    for (const field of ["produces", "consumes"]) {
      const raw = block[field];
      // ABSENT (undefined) is fine — most extensions declare neither. An
      // EXPLICIT null is not "none", it is malformed: "none" is spelled `[]`
      // (the same rule the vendored extension-kind-gate applies to
      // `cinatra.dependencies`, and the publish schema — `z.array().optional()`
      // — refuses null too). Treating it as absent would let a null-ed produces
      // block hide every edge it used to carry.
      if (raw === undefined) continue;
      if (!Array.isArray(raw)) {
        malformed.push(
          `${source}: cinatra.${field} must be an array — spell "none" as [] (got ${raw === null ? "null" : typeof raw})`,
        );
        continue;
      }
      raw.forEach((entry, i) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          malformed.push(`${source}: cinatra.${field}[${i}] must be an object (got ${JSON.stringify(entry)})`);
          return;
        }
        // Consumed-PRIMITIVE shape first (see the doc comment): a `consumes`
        // entry naming a primitive is never an extension edge, even when it
        // also carries an `extension` key the SDK parser would ignore.
        if (field === "consumes" && typeof entry.primitive === "string" && entry.primitive.trim().length > 0) return;
        const ext = entry.extension;
        if (ext === undefined) {
          malformed.push(
            `${source}: cinatra.${field}[${i}] declares no \`extension\`` +
              `${field === "consumes" ? " and no consumed `primitive`" : ""} (${JSON.stringify(entry)})`,
          );
          return;
        }
        if (typeof ext !== "string" || ext.length === 0) {
          malformed.push(`${source}: cinatra.${field}[${i}].extension must be a non-empty string (got ${JSON.stringify(ext)})`);
          return;
        }
        const objectTypeId = entry.objectTypeId;
        if (objectTypeId !== undefined && (typeof objectTypeId !== "string" || !OBJECT_TYPE_ID_RE.test(objectTypeId))) {
          malformed.push(
            `${source}: cinatra.${field}[${i}].objectTypeId must be a namespaced object type id (@scope/package:local-id), got ${JSON.stringify(objectTypeId)}`,
          );
          return;
        }
        edges.push({ field, source, extension: ext, ...(objectTypeId !== undefined ? { objectTypeId } : {}) });
      });
    }
  }
  return { edges, malformed };
}

/** The `cinatra.dependencies` entries of a manifest, keyed by packageName.
 *  A malformed (non-array / non-object-entry) declaration yields no entries —
 *  which surfaces as an "undeclared" finding, never as a silent pass.
 *  Duplicate packageNames: the FIRST entry wins (install rejects duplicates;
 *  the vendored extension-kind-gate flags them — this gate does not
 *  re-litigate the shape, it only resolves the edge). */
export function declaredDependencyMap(packageJson) {
  const map = new Map();
  const decl = packageJson?.cinatra?.dependencies;
  if (!Array.isArray(decl)) return map;
  for (const dep of decl) {
    if (!dep || typeof dep !== "object" || typeof dep.packageName !== "string") continue;
    if (!map.has(dep.packageName)) map.set(dep.packageName, dep);
  }
  return map;
}

/** The well-formed object-type claim ids an artifact manifest declares
 *  (`cinatra.artifact.objectTypes[].type`). Mirrors
 *  `readArtifactManifestClaimIds` (package-contract.ts): only well-formed
 *  namespaced ids count, and a hostile/malformed block yields an EMPTY set
 *  (fail-closed — an objectTypeId entry then reads as unclaimed). */
export function readArtifactClaimIds(packageJson) {
  const ids = new Set();
  const objectTypes = packageJson?.cinatra?.artifact?.objectTypes;
  if (!Array.isArray(objectTypes)) return ids;
  for (const claim of objectTypes) {
    const type = claim?.type;
    if (typeof type === "string" && OBJECT_TYPE_ID_RE.test(type)) ids.add(type);
  }
  return ids;
}

/**
 * Classify ONE produced/consumed extension edge against the producer's declared
 * dependencies and the extension catalog. PURE.
 *
 *   - `edge`: from `collectProducesEdges`.
 *   - `declared`: Map packageName → dependency entry (`declaredDependencyMap`).
 *   - `catalog`: Map packageName → `{ kind, claimIds }` for every scanned
 *     extension.
 *
 * Returns `{ undeclared, unresolved }` — each either `null` or
 * `{ key, reason }`, where `key` is the stable baseline key for that class
 * (the target extension name; `ext#objectTypeId` for an unclaimed type, so an
 * unclaimed type and an absent target are distinct baseline entries) and
 * `reason` is the human-readable failure. The two classes are INDEPENDENT: an
 * edge can be both (the #2537 media-transcript case is), and each is ratcheted
 * in its own baseline section.
 */
export function classifyEdge({ edge, declared, catalog }) {
  const target = edge.extension;
  const dep = declared.get(target);
  const where = `cinatra.${edge.field} (${edge.source}) names "${target}"`;
  // Byte-mirror of the runtime `requiredArtifactDependencies` predicate
  // (package-contract.ts): kind === "artifact" && requirement === "required" &&
  // edgeType !== "peer". Anything else is NOT guaranteed to be in the
  // transitive install closure, so the produced type is not guaranteed to exist
  // at install time. Each branch names the ONE failing condition.
  let undeclared = null;
  if (!dep) {
    undeclared = {
      key: target,
      reason:
        `${where} but it is not declared in cinatra.dependencies — installing this extension never ` +
        `installs "${target}", so its object type is never claimed and every run fails materialization`,
    };
  } else if (dep.requirement !== "required") {
    undeclared = {
      key: target,
      reason:
        `${where} but its cinatra.dependencies edge is requirement:${JSON.stringify(dep.requirement ?? null)} — ` +
        `only a required edge is guaranteed to be in the install closure, so the produced artifact may ` +
        `not be installed`,
    };
  } else if (dep.edgeType === "peer") {
    undeclared = {
      key: target,
      reason:
        `${where} but its cinatra.dependencies edge is edgeType:"peer" — a peer edge is NOT auto-installed ` +
        `(the closure predicate excludes it), so the produced artifact may not be installed`,
    };
  } else if (dep.kind !== "artifact") {
    undeclared = {
      key: target,
      reason:
        `${where} but its cinatra.dependencies edge declares kind:${JSON.stringify(dep.kind ?? null)} — a produced ` +
        `target must be declared kind:"artifact" (the closure predicate tests kind exactly, so an OMITTED kind ` +
        `is not a closure member either)`,
    };
  }

  let unresolved = null;
  const entry = catalog.get(target);
  if (!entry) {
    unresolved = {
      key: target,
      reason:
        `cinatra.${edge.field} (${edge.source}) names "${target}", which is not in the synced extension ` +
        `catalog — it is retired, renamed, or absent from cinatra-{dev,required}-extensions.lock.json, so it ` +
        `is not installable and declaring it as a dependency would not make it so`,
    };
  } else if (entry.kind !== "artifact") {
    unresolved = {
      key: target,
      reason:
        `cinatra.${edge.field} (${edge.source}) names "${target}", which is a ` +
        `kind:${JSON.stringify(entry.kind ?? null)} extension — only an artifact extension can claim the ` +
        `produced object type`,
    };
  } else if (edge.objectTypeId !== undefined && !entry.claimIds.has(edge.objectTypeId)) {
    const declaredClaims = [...entry.claimIds].sort();
    unresolved = {
      key: `${target}#${edge.objectTypeId}`,
      reason:
        `cinatra.${edge.field} (${edge.source}) names type "${edge.objectTypeId}" from "${target}", but that ` +
        `extension's manifest declares no such cinatra.artifact.objectTypes claim (declares: ` +
        `${declaredClaims.length > 0 ? declaredClaims.join(", ") : "none"})`,
    };
  }

  return { undeclared, unresolved };
}

function diffFindingsAgainstMap(findings, knownMap) {
  const newViolations = {};
  for (const [pkg, targets] of Object.entries(findings)) {
    const known = new Set(knownMap?.[pkg] ?? []);
    const fresh = targets.filter((t) => !known.has(t));
    if (fresh.length) newViolations[pkg] = fresh.sort();
  }
  return { newViolations };
}

/** Compare one class's findings against the committed baseline. A (pkg, target)
 *  pair is a NEW violation iff it is absent from that baseline section. */
export function diffAgainstBaseline(findings, baseline, key) {
  return diffFindingsAgainstMap(findings, baseline?.[key] ?? {});
}

function growthOfMaps(baseMap, committedMap) {
  const basePairs = new Set();
  for (const [pkg, targets] of Object.entries(baseMap ?? {})) for (const t of targets) basePairs.add(`${pkg} :: ${t}`);
  const grew = [];
  for (const [pkg, targets] of Object.entries(committedMap ?? {})) for (const t of targets) {
    const pair = `${pkg} :: ${t}`;
    if (!basePairs.has(pair)) grew.push(pair);
  }
  return grew.sort();
}

function countPairs(map) {
  return Object.values(map ?? {}).reduce((n, a) => n + (Array.isArray(a) ? a.length : 0), 0);
}

/** True iff `key` names a bootstrap-ELIGIBLE class (BOOTSTRAPPABLE_CLASSES —
 *  empty today, see its declaration) that is ENTIRELY ABSENT from the
 *  base-branch baseline. An EMPTY-but-PRESENT section is NOT absent. A missing /
 *  non-object base baseline is NOT a bootstrap either (fail-closed). */
export function isClassBootstrap(baseBaseline, key) {
  if (!BOOTSTRAPPABLE_CLASSES.has(key)) return false;
  if (!baseBaseline || typeof baseBaseline !== "object" || Array.isArray(baseBaseline)) return false;
  return !(key in baseBaseline);
}

/** Base-ref ratchet for ONE class. Returns `{ grew, bootstrap }`. `grew` =
 *  (pkg, target) pairs present in the COMMITTED baseline and absent from the
 *  BASE-branch baseline — i.e. tolerated debt ADDED in this PR
 *  (regenerate-to-pass). `bootstrap` is non-null only for a bootstrap-eligible,
 *  base-absent class (see `isClassBootstrap`). */
export function classGrowth(baseBaseline, committedBaseline, key) {
  const committedMap = committedBaseline?.[key];
  if (isClassBootstrap(baseBaseline, key)) {
    return { grew: [], bootstrap: committedMap ? countPairs(committedMap) : null };
  }
  return { grew: growthOfMaps(baseBaseline?.[key], committedMap), bootstrap: null };
}

// ---------------------------------------------------------------------------
// Filesystem scan
// ---------------------------------------------------------------------------

function readJsonIfPresent(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`unreadable JSON at ${relative(REPO_ROOT, path)}: ${err?.message ?? err}`);
  }
}

/** Every synced extension directory: `extensions/<vendor>/<name>` carrying a
 *  package.json. Fixed two-segment shape — the one the clone-back
 *  (scripts/ci/sync-dev-extensions.mjs) materializes and the one every
 *  `extensions/*` pnpm-workspace glob matches. */
export function discoverExtensionDirs(extensionsRoot) {
  const dirs = [];
  let vendors;
  try {
    vendors = readdirSync(extensionsRoot, { withFileTypes: true });
  } catch {
    return dirs;
  }
  for (const vendor of vendors) {
    if (!vendor.isDirectory() || vendor.name === "node_modules" || vendor.name.startsWith(".")) continue;
    const vendorDir = join(extensionsRoot, vendor.name);
    let names;
    try {
      names = readdirSync(vendorDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.isDirectory() || name.name === "node_modules" || name.name.startsWith(".")) continue;
      const dir = join(vendorDir, name.name);
      if (existsSync(join(dir, "package.json")) && statSync(dir).isDirectory()) dirs.push(dir);
    }
  }
  return dirs.sort();
}

function scan() {
  const dirs = discoverExtensionDirs(EXTENSIONS_ROOT);
  if (dirs.length === 0) {
    // FAIL CLOSED. An absent/empty extensions/ tree is not "nothing to check" —
    // it is the gate scanning nothing and passing vacuously, the exact silent
    // protection regression the clone-back script itself refuses to allow.
    throw new Error(
      `no extension manifests under ${relative(REPO_ROOT, EXTENSIONS_ROOT) || "extensions"}/ — the companion ` +
        `repos are not cloned back. Run \`node scripts/ci/sync-dev-extensions.mjs --pinned\` first (CI does this ` +
        `via .github/actions/clone-extensions); refusing to pass vacuously.`,
    );
  }

  // Pass 1 — the catalog (every scanned extension's kind + declared claims).
  const catalog = new Map();
  const manifests = [];
  for (const dir of dirs) {
    const packageJson = readJsonIfPresent(join(dir, "package.json"));
    if (!packageJson || typeof packageJson.name !== "string") continue;
    const oasJson = readJsonIfPresent(join(dir, "cinatra", "oas.json"));
    manifests.push({ dir, packageJson, oasJson });
    catalog.set(packageJson.name, {
      kind: packageJson?.cinatra?.kind,
      claimIds: readArtifactClaimIds(packageJson),
    });
  }

  // Pass 2 — classify every produced/consumed extension edge.
  const findings = Object.fromEntries(FINDING_CLASSES.map((c) => [c, {}]));
  const reasons = [];
  const malformed = [];
  let edgeCount = 0;
  for (const { packageJson, oasJson } of manifests) {
    const name = packageJson.name;
    const { edges, malformed: shapeProblems } = collectProducesEdges({ packageJson, oasJson });
    for (const problem of shapeProblems) malformed.push(`${name}: ${problem}`);
    if (edges.length === 0) continue;
    const declared = declaredDependencyMap(packageJson);
    // De-duplicate per (class, key): the same edge is commonly declared in BOTH
    // package.json and the OAS, and one baseline entry must cover both.
    const seen = new Set();
    for (const edge of edges) {
      edgeCount += 1;
      const verdict = classifyEdge({ edge, declared, catalog });
      for (const cls of FINDING_CLASSES) {
        const finding = cls === "undeclaredProducesDeps" ? verdict.undeclared : verdict.unresolved;
        if (!finding) continue;
        const dedupeKey = `${cls}::${name}::${finding.key}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        (findings[cls][name] ??= []).push(finding.key);
        reasons.push({ cls, pkg: name, key: finding.key, reason: finding.reason });
      }
    }
  }
  for (const cls of FINDING_CLASSES) {
    for (const pkg of Object.keys(findings[cls])) findings[cls][pkg].sort();
  }
  return { findings, reasons, malformed, extensionCount: manifests.length, edgeCount };
}

function reasonFor(reasons, cls, pkg, key) {
  return reasons.find((r) => r.cls === cls && r.pkg === pkg && r.key === key)?.reason ?? key;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const write = args.includes("--write-baseline");
  const report = args.includes("--report");

  let result;
  try {
    result = scan();
  } catch (err) {
    console.error(`[extension-produces-deps] scanner error: ${err?.stack ?? err}`);
    process.exit(2);
  }
  const { findings, reasons, malformed, extensionCount, edgeCount } = result;
  const totals = Object.fromEntries(FINDING_CLASSES.map((c) => [c, countPairs(findings[c])]));

  if (write) {
    // Refuse to write a baseline over a shape the scan could not READ: the
    // written data would silently under-report, and the very next check run
    // fails on the malformed declaration anyway.
    if (malformed.length > 0) {
      console.error(
        `[extension-produces-deps] REFUSING --write-baseline — ${malformed.length} malformed produces/consumes ` +
          `declaration(s); a baseline written over an unreadable shape under-reports. Fix these first:`,
      );
      for (const m of malformed) console.error(`  - ${m}`);
      process.exit(1);
    }
    const existing = existsSync(BASELINE_FILE) ? JSON.parse(readFileSync(BASELINE_FILE, "utf8")) : {};
    const baseline = { note: BASELINE_NOTE };
    for (const cls of FINDING_CLASSES) baseline[cls] = findings[cls];
    baseline.notes = existing.notes ?? {};
    writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2) + "\n");
    console.log(
      `[extension-produces-deps] wrote baseline: ` +
        FINDING_CLASSES.map((c) => `${totals[c]} ${c}`).join(", ") +
        ` (scanned ${extensionCount} extensions / ${edgeCount} produces-consumes edges).`,
    );
    return;
  }

  if (report) {
    // Reproducible audit mode — the org-wide offender table of cinatra#2537.
    console.log(
      `[extension-produces-deps] ${extensionCount} extensions scanned, ${edgeCount} produces/consumes ` +
        `extension edges; ` +
        FINDING_CLASSES.map((c) => `${totals[c]} ${c}`).join(", ") +
        `${malformed.length ? `, ${malformed.length} malformed declaration(s)` : ""}.`,
    );
    for (const cls of FINDING_CLASSES) {
      const entries = Object.entries(findings[cls]).sort(([a], [b]) => a.localeCompare(b));
      if (entries.length === 0) continue;
      console.log(`\n${cls}:`);
      for (const [pkg, keys] of entries) {
        console.log(`  ${pkg}`);
        for (const key of keys) console.log(`    - ${key}\n      ${reasonFor(reasons, cls, pkg, key)}`);
      }
    }
    for (const m of malformed) console.log(`  ! ${m}`);
    return;
  }

  // A malformed declaration is a HARD fail, never baselined: a produces block
  // the gate cannot parse is a produces block it cannot verify, and the
  // publish-time schema refuses it anyway (agentProducesSchema is strict).
  if (malformed.length > 0) {
    console.error(`[extension-produces-deps] FAIL — ${malformed.length} malformed produces/consumes declaration(s):`);
    for (const m of malformed) console.error(`  - ${m}`);
    process.exit(1);
  }

  const baseline = existsSync(BASELINE_FILE) ? JSON.parse(readFileSync(BASELINE_FILE, "utf8")) : {};

  // Base-ref ratchet: block the regenerate-to-pass bypass (add an undeclared
  // produces edge + `--write-baseline` in the same PR). Mirrors the sibling
  // no-new-rot gates; fail-closed if the ref cannot be resolved.
  const baseRef = process.env.EXTENSION_PRODUCES_DEPS_BASE;
  if (baseRef) {
    if (baseRef.startsWith("-")) {
      console.error(`[extension-produces-deps] FAIL — EXTENSION_PRODUCES_DEPS_BASE="${baseRef}" is flag-like.`);
      process.exit(1);
    }
    let refResolves = false;
    try {
      execFileSync("git", ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`], {
        cwd: REPO_ROOT,
        stdio: ["ignore", "ignore", "ignore"],
      });
      refResolves = true;
    } catch {
      refResolves = false;
    }
    if (!refResolves) {
      console.error(
        `[extension-produces-deps] FAIL — EXTENSION_PRODUCES_DEPS_BASE="${baseRef}" did not resolve (shallow ` +
          `checkout / misconfig?). Failing closed — ensure the base ref is fetched (fetch-depth: 0).`,
      );
      process.exit(1);
    }
    let baseText = null;
    try {
      baseText = execFileSync("git", ["show", `${baseRef}:${BASELINE_REL}`], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      baseText = null; // ref resolves but the file is absent → this PR introduces the gate
    }
    if (baseText === null) {
      console.log(
        `[extension-produces-deps] gate bootstrap: ${FINDING_CLASSES.reduce((n, c) => n + countPairs(baseline[c]), 0)} ` +
          `grandfathered entries (no baseline at ${baseRef} — the introducing PR's one-time write is exempt from ` +
          `the growth guard; every later addition fails).`,
      );
    } else {
      const baseJson = JSON.parse(baseText);
      const grew = [];
      for (const cls of FINDING_CLASSES) {
        const res = classGrowth(baseJson, baseline, cls);
        if (res.bootstrap !== null) {
          console.log(
            `[extension-produces-deps] ${cls} class bootstrap: ${res.bootstrap} grandfathered entries (class absent ` +
              `from ${baseRef}; the one-time introducing write is exempt from the growth guard).`,
          );
        }
        for (const pair of res.grew) grew.push(`[${cls}] ${pair}`);
      }
      if (grew.length) {
        console.error(`[extension-produces-deps] FAIL — committed baseline GREW vs ${baseRef} (regenerate-to-pass bypass):`);
        for (const g of grew) console.error(`  + ${g}`);
        process.exit(1);
      }
    }
  }

  let newCount = 0;
  const newByClass = {};
  for (const cls of FINDING_CLASSES) {
    const { newViolations } = diffAgainstBaseline(findings[cls], baseline, cls);
    newByClass[cls] = newViolations;
    newCount += countPairs(newViolations);
  }

  if (newCount === 0) {
    console.log(
      `[extension-produces-deps] OK — no new undeclared produced-artifact dependencies (scanned ` +
        `${extensionCount} extensions / ${edgeCount} edges; ` +
        FINDING_CLASSES.map((c) => `${totals[c]} ${c}`).join(", ") +
        ` baselined).`,
    );
    process.exit(0);
  }

  console.error(
    `[extension-produces-deps] FAIL — ${newCount} NEW produced-artifact dependency violation${newCount === 1 ? "" : "s"}:`,
  );
  for (const cls of FINDING_CLASSES) {
    for (const [pkg, keys] of Object.entries(newByClass[cls])) {
      console.error(`  ${pkg} [${cls}]:`);
      for (const key of keys) console.error(`    - ${reasonFor(reasons, cls, pkg, key)}`);
    }
  }
  console.error(
    `\n  Fix: in the producing extension's package.json, add the produced extension to \`cinatra.dependencies\` as\n` +
      `    { "packageName": "<produced-extension>", "edgeType": "runtime",\n` +
      `      "versionConstraint": { "kind": "semver-range", "range": "^0.1.0" },\n` +
      `      "requirement": "required", "kind": "artifact" }\n` +
      `  so installing the producer installs the artifact and its object-type claim. This mirrors the publish/install\n` +
      `  contract (ARTIFACT-CONTRACT-PRODUCES-UNCLAIMED) — a manifest failing here also fails to publish or install.`,
  );
  process.exit(1);
}

// Importable for unit tests without executing the CLI.
const invokedDirectly = process.argv[1] && process.argv[1].endsWith("extension-produces-deps-gate.mjs");
if (invokedDirectly) main();
