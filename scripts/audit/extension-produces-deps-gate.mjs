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
 * inside a workspace package and this gate is a plain `.mjs` that must run
 * under `node` before/without a build (same constraint as every sibling in
 * `scripts/audit/`; its one package import is the TypeScript parser, which the
 * job installs, for the tool-owner rule below). The mirrored rule is stated
 * once, here:
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
 * TOOL-OWNER RULE (cinatra#4874). A pack that uses a host tool (an MCP
 * primitive) registered by ANOTHER pack must declare that pack in its own
 * `cinatra.dependencies`. Decided from structure only; no pack and no tool is
 * named in this file:
 *   - USE: `cinatra.consumes[].primitive` (package.json and the OAS mirror,
 *     with its declared `requirement`), every flow ApiNode's `data.tool` and
 *     every flow node's `metadata.cinatra.tools` (both read as REQUIRED uses:
 *     the step calls the tool whenever it runs);
 *   - OWNER: the file the generated authz inventory
 *     (`src/lib/authz/__generated__/inventory.json`) names for the tool: a file
 *     under `extensions/<scope>/<pack>/` is that pack, any other file is core;
 *   - DEPENDENCY: the first entry of the consumer's `cinatra.dependencies`
 *     whose `packageName` is the owner, judged like the authoritative
 *     validator (`validateDependencyDeclarations` in
 *     packages/extensions/src/dependency-declaration-validator.ts): a REQUIRED
 *     use needs an install-blocking edge (required, not peer:
 *     `isInstallBlockingEdge`), an OPTIONAL use needs any edge.
 * Code is NOT read for tool names (a callee or an alias cannot be resolved
 * without data flow). Instead, a pack whose shipped code references the host's
 * primitive-call port at all (the port's method name as an identifier,
 * property name or string literal, read with the TypeScript parser) must
 * declare what it calls in `package.json#cinatra.consumes`; a pack that
 * references the port and declares no consumed primitive is a finding. A
 * same-named method of another object in a pack also counts (the rule errs
 * towards reporting); core files are not scanned. The rule relies on the
 * manifest for WHICH tools are called; the host does not check a call against
 * `cinatra.consumes` at call time.
 * Four classes, each a map `{ consumer: { key: reason } }` in the baseline:
 * `undeclaredToolOwnerDeps` (owner is another pack, not declared or declared
 * too weakly for a required use), `unownedTools` (no inventory entry, or an
 * entry in no pack of the tree, or two owners), `dynamicToolNames` (a flow
 * `data.tool` that is not a literal name), `undeclaredPortUses` (a code file
 * that references the port in a pack with no `cinatra.consumes` primitive).
 * Every map keyed by a name from data is a `Map` or a null-prototype object,
 * so a tool or pack named like an `Object.prototype` key is read like any
 * other. A NEW or STALE entry fails, an entry needs a reason, a
 * class is never removed, and the list may only shrink against the base
 * branch (the shared `lib/floor-base-guard.mjs`; a class absent from the base
 * copy is the introducing change's one-time seed). A shape the rule cannot
 * read (manifest, flow, step tool list, code file, inventory) fails.
 *
 * Exit codes: 0 = clean, 1 = findings / baseline growth, 2 = scanner error.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import { compareFloorWithBase, reportFloorGuard } from "./lib/floor-base-guard.mjs";

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
  "version-controlled record; NOT diffed by the gate. The tool-owner classes (cinatra#4874) map consumer -> key -> reason: " +
  "`undeclaredToolOwnerDeps` = a tool the consumer uses whose owner (per the authz inventory) is another pack " +
  "that is not in its cinatra.dependencies (or is declared optional/peer for a required use); `unownedTools` = a used " +
  "tool whose owner cannot be decided; `dynamicToolNames` = a flow tool selection that is not a literal name; " +
  "`undeclaredPortUses` = a code file that references the host's primitive-call port in a pack that declares no " +
  "consumed primitive in cinatra.consumes. They fail on NEW and on STALE entries and " +
  "only shrink against the base branch. These are CURRENT tolerated misses; the gate fails on " +
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
// Tool-owner dependency rule (cinatra#4874) — pure helpers
// ---------------------------------------------------------------------------
//
// A pack that uses a host tool (an MCP primitive) registered by ANOTHER pack
// must declare that pack in its own `cinatra.dependencies`. Everything is read
// from structure: the pack's manifest and flow (parsed JSON), its code (the
// TypeScript parser), and the authz inventory, which names the file that
// registers every primitive. No pack and no tool is named here.

/** The tool-owner finding classes, in report order. Each is a map
 *  `{ "<consumer>": { "<key>": "<reason>" } }` in the baseline: every
 *  tolerated entry carries its reason. */
export const TOOL_CLASSES = ["undeclaredToolOwnerDeps", "unownedTools", "dynamicToolNames", "undeclaredPortUses"];

/** The host port's method that calls another primitive (`ctx.mcp.<this>`). */
export const PRIMITIVE_PORT_METHOD = "callPrimitive";

/** Mirror of `isInstallBlockingEdge` (packages/extensions/src/dependency-closure.ts,
 *  restated in dependency-declaration-validator.ts): a required edge that is
 *  not a peer. A drift test reads both sources. */
export function isInstallBlockingEdge(dep) {
  return dep.requirement === "required" && dep.edgeType !== "peer";
}

/** The generated authz inventory: every registered primitive and its file. */
export const INVENTORY_REL = "src/lib/authz/__generated__/inventory.json";

/**
 * Read who owns each primitive from the parsed authz inventory.
 *
 *   - `inventory`: the parsed `inventory.json` (`{ primitives: [{ primitiveName, file }] }`).
 *   - `packDirToName`: Map from a pack directory, repo-relative with forward
 *     slashes (`extensions/<scope>/<pack>`), to the pack's package name.
 *
 * A file under `extensions/<scope>/<pack>/` is owned by that pack; any other
 * file is core. Returns `{ owners, problems }`: `owners` maps a primitive to
 * `{ kind: "core" | "pack" | "unknown", pack?, file?, reason? }`; `problems`
 * lists what the reader could not read (a hard failure, never skipped).
 */
export function readInventoryOwners({ inventory, packDirToName }) {
  const owners = new Map();
  const problems = [];
  const list = inventory?.primitives;
  if (!Array.isArray(list)) {
    problems.push(`${INVENTORY_REL}: \`primitives\` must be a list (got ${list === null ? "null" : typeof list})`);
    return { owners, problems };
  }
  list.forEach((entry, i) => {
    const name = entry?.primitiveName;
    const file = entry?.file;
    if (typeof name !== "string" || name === "" || typeof file !== "string" || file === "") {
      problems.push(`${INVENTORY_REL}: primitives[${i}] has no primitiveName or file (${JSON.stringify(entry)})`);
      return;
    }
    const parts = file.split("/");
    let owner;
    if (parts[0] !== "extensions") {
      owner = { kind: "core", file };
    } else {
      const packDir = parts.slice(0, 3).join("/");
      const pack = parts.length > 3 ? packDirToName.get(packDir) : undefined;
      owner = pack
        ? { kind: "pack", pack, file }
        : {
            kind: "unknown",
            file,
            reason: `the inventory names ${file}, which is in no pack of the synced extension tree`,
          };
    }
    const prior = owners.get(name);
    if (!prior) {
      owners.set(name, owner);
      return;
    }
    const same = prior.kind === owner.kind && (prior.kind !== "pack" || prior.pack === owner.pack);
    if (!same) {
      owners.set(name, {
        kind: "unknown",
        file: `${prior.file}, ${file}`,
        reason: `the inventory registers it in more than one owner (${prior.file} and ${file})`,
      });
    }
  });
  return { owners, problems };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The tools a pack names in its manifest and its flow. PURE.
 *
 *   - `cinatra.consumes[].primitive` in `package.json` and its mirror at
 *     `metadata.cinatra.consumes` in `cinatra/oas.json`;
 *   - every flow node with `component_type: "ApiNode"` and a `data.tool`
 *     (the tool a passthrough step calls; a `data` block written as a JSON
 *     string is parsed first);
 *   - every flow node's (an object with a `component_type`)
 *     `metadata.cinatra.tools` list (the tools a model step may call).
 *
 * The flow is walked through every object and list, so nested subflows and
 * `$referenced_components` count. Returns `{ uses, dynamic, malformed }`:
 * `uses` = `[{ primitive, requirement, source }]` (a consumes entry's
 * requirement, `optional` only when it says so; a flow use is `required`); `dynamic` = `[{ key, reason }]`, a tool
 * selection that is not a literal name; `malformed` = a shape the reader
 * cannot read (hard failure). A consumes entry's own shape is read by
 * `collectProducesEdges`, which already reports a malformed one.
 */
export function collectToolUses({ packageJson, oasJson }) {
  const uses = [];
  const dynamic = [];
  const malformed = [];
  const consumeSources = [
    { source: "package.json", block: packageJson?.cinatra },
    { source: "cinatra/oas.json", block: oasJson?.metadata?.cinatra },
  ];
  for (const { source, block } of consumeSources) {
    const raw = isPlainObject(block) ? block.consumes : undefined;
    if (!Array.isArray(raw)) continue;
    raw.forEach((entry, i) => {
      const primitive = isPlainObject(entry) ? entry.primitive : undefined;
      if (typeof primitive === "string" && primitive.trim() !== "") {
        const requirement = entry.requirement === "optional" ? "optional" : "required";
        uses.push({ primitive, requirement, source: `${source} cinatra.consumes[${i}]` });
      }
    });
  }

  if (oasJson === null || oasJson === undefined) return { uses, dynamic, malformed };
  const walk = (value, path) => {
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (!isPlainObject(value)) return;
    if (value.component_type === "ApiNode" && value.data !== undefined) {
      let data = value.data;
      if (typeof data === "string") {
        try {
          data = JSON.parse(data);
        } catch {
          data = undefined;
        }
        if (!isPlainObject(data)) {
          dynamic.push({
            key: `cinatra/oas.json ${path}.data`,
            reason: `the ApiNode at ${path} writes its data block as text that is not a JSON object, so the tool it calls cannot be read`,
          });
          data = undefined;
        }
      }
      if (isPlainObject(data) && Object.prototype.hasOwnProperty.call(data, "tool")) {
        if (typeof data.tool === "string" && data.tool !== "") {
          uses.push({ primitive: data.tool, requirement: "required", source: `cinatra/oas.json ${path}.data.tool` });
        } else {
          dynamic.push({
            key: `cinatra/oas.json ${path}.data.tool`,
            reason: `the ApiNode at ${path} selects its tool with ${JSON.stringify(data.tool)}, not a literal tool name`,
          });
        }
      }
    }
    const metadata = value.metadata;
    if (typeof value.component_type === "string" && isPlainObject(metadata) && isPlainObject(metadata.cinatra)) {
      if (Object.prototype.hasOwnProperty.call(metadata.cinatra, "tools")) {
        const tools = metadata.cinatra.tools;
        if (!Array.isArray(tools)) {
          malformed.push(`cinatra/oas.json: ${path}.metadata.cinatra.tools must be a list`);
        } else {
          tools.forEach((t, i) => {
            if (typeof t === "string" && t !== "") {
              uses.push({
                primitive: t,
                requirement: "required",
                source: `cinatra/oas.json ${path}.metadata.cinatra.tools[${i}]`,
              });
            } else {
              malformed.push(
                `cinatra/oas.json: ${path}.metadata.cinatra.tools[${i}] must be a tool name (got ${JSON.stringify(t)})`,
              );
            }
          });
        }
      }
    }
    for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`);
  };
  walk(oasJson, "$");
  return { uses, dynamic, malformed };
}

/** The ScriptKind the TypeScript parser reads a file name with. */
function scriptKindOf(fileName) {
  if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (fileName.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * Whether a code file references the host's primitive-call port, read with
 * the TypeScript parser. PURE (no file system). Any identifier or string
 * literal spelled like the port's method counts, wherever and however it is
 * used (a call, an alias, a destructuring, a bracket access); a comment does
 * not. Returns `{ references, line, malformed }`.
 */
export function referencesPrimitivePort({ fileName, text }) {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKindOf(fileName));
  const diagnostics = sf.parseDiagnostics ?? [];
  if (diagnostics.length > 0) {
    const message = ts.flattenDiagnosticMessageText(diagnostics[0].messageText, " ");
    return { references: false, line: null, malformed: [`${fileName}: the TypeScript parser cannot read the file (${message})`] };
  }
  let line = null;
  const visit = (node) => {
    if (line !== null) return;
    const spelled =
      ts.isIdentifier(node) || ts.isPrivateIdentifier(node)
        ? node.text
        : ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
          ? node.text
          : null;
    if (spelled === PRIMITIVE_PORT_METHOD) {
      line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { references: line !== null, line, malformed: [] };
}

/**
 * Classify ONE tool use of `consumer`. PURE. Returns `null` (own tool, a core
 * tool, or an owner declared as the validator accepts it) or
 * `{ cls, key, reason }`. `declared` maps a package name to its first
 * `cinatra.dependencies` entry.
 */
export function classifyToolUse({ consumer, use, owners, declared }) {
  const owner = owners.get(use.primitive);
  if (!owner) {
    return {
      cls: "unownedTools",
      key: use.primitive,
      reason:
        `${use.source} names the tool "${use.primitive}", which the authz inventory (${INVENTORY_REL}) does ` +
        `not hold, so its owner cannot be decided`,
    };
  }
  if (owner.kind === "unknown") {
    return {
      cls: "unownedTools",
      key: use.primitive,
      reason: `${use.source} names the tool "${use.primitive}", whose owner cannot be decided: ${owner.reason}`,
    };
  }
  if (owner.kind === "core" || owner.pack === consumer) return null;
  const edge = declared.get(owner.pack);
  if (edge) {
    // The validator's REQUIREMENT_MISMATCH: a required use needs an
    // install-blocking edge; an optional use is backed by any edge.
    if (use.requirement === "optional" || isInstallBlockingEdge(edge)) return null;
    return {
      cls: "undeclaredToolOwnerDeps",
      key: use.primitive,
      reason:
        `${use.source} names the REQUIRED tool "${use.primitive}", registered by ${owner.pack} (${owner.file}), ` +
        `and this pack declares ${owner.pack} as ${edge.edgeType}/${edge.requirement}, which is not install-blocking`,
    };
  }
  return {
    cls: "undeclaredToolOwnerDeps",
    key: use.primitive,
    reason:
      `${use.source} names the tool "${use.primitive}", registered by ${owner.pack} (${owner.file}), and ` +
      `${owner.pack} is not in this pack's cinatra.dependencies`,
  };
}

/** The (consumer, key) pairs of a tool-class map, as `consumer :: key`. */
function toolPairs(map) {
  const pairs = new Set();
  if (!isPlainObject(map)) return pairs;
  for (const [pkg, entries] of Object.entries(map)) {
    if (!isPlainObject(entries)) continue;
    for (const key of Object.keys(entries)) pairs.add(`${pkg} :: ${key}`);
  }
  return pairs;
}

/**
 * Check the committed tool-class baseline against the scan. PURE. Returns
 * failure lines: a class missing from the baseline (an empty class is
 * written `{}`; a class is never removed, so it cannot be seeded again), an
 * entry without a reason, a NEW finding, and a STALE entry (listed, no longer
 * found: remove it).
 */
export function checkToolBaseline(findings, baseline) {
  const lines = [];
  for (const cls of TOOL_CLASSES) {
    const map = baseline?.[cls];
    if (!isPlainObject(map)) {
      lines.push(`[${cls}] the baseline has no \`${cls}\` map (write {} when the class is clean; it is never removed)`);
      continue;
    }
    for (const [pkg, entries] of Object.entries(map)) {
      if (!isPlainObject(entries)) {
        lines.push(`[${cls}] ${pkg}: the entry must be a map of key -> reason`);
        continue;
      }
      for (const [key, reason] of Object.entries(entries)) {
        if (typeof reason !== "string" || reason.trim() === "") lines.push(`[${cls}] ${pkg} :: ${key} has no reason`);
      }
    }
    const listed = toolPairs(map);
    const found = toolPairs(findings[cls]);
    for (const [pkg, entries] of Object.entries(findings[cls] ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
      for (const [key, reason] of Object.entries(entries).sort(([a], [b]) => a.localeCompare(b))) {
        if (!listed.has(`${pkg} :: ${key}`)) lines.push(`[${cls}] NEW ${pkg} :: ${key} — ${reason}`);
      }
    }
    for (const pair of [...listed].sort()) {
      if (!found.has(pair)) lines.push(`[${cls}] STALE ${pair} — no longer found; remove it from the baseline`);
    }
  }
  return lines;
}

/**
 * The base guard's growth reading for the tool classes (passed to the shared
 * `compareFloorWithBase`). A pair listed in `head` and not in `base` is
 * growth. A class ABSENT from the base copy is the one-time seed of the
 * introducing change and is not growth; once on the base it can only shrink
 * (`checkToolBaseline` refuses removing the class, so it is never seeded twice).
 */
export function toolClassGrowth(base, head) {
  const lines = [];
  for (const cls of TOOL_CLASSES) {
    if (!isPlainObject(base) || !Object.hasOwn(base, cls)) continue;
    const known = toolPairs(base[cls]);
    for (const pair of [...toolPairs(head?.[cls])].sort()) if (!known.has(pair)) lines.push(`[${cls}] ${pair}`);
  }
  return lines;
}

/** The tool classes the base copy does not hold yet (the one-time seed). */
export function toolClassesSeeded(base) {
  return TOOL_CLASSES.filter((cls) => !isPlainObject(base) || !Object.hasOwn(base, cls));
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

const CODE_FILE_RE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const TEST_FILE_RE = /\.(?:test|spec)\.[^.]+$/;
const SKIPPED_CODE_DIRS = new Set(["node_modules", "dist", "build", "coverage", "__tests__", "__mocks__", "tests", "test", "e2e", "fixtures"]);

/**
 * The code files of one pack that run in the host: every JavaScript or
 * TypeScript file under the pack, except dependencies, build output, test
 * files and declaration files. A superset of the server entry's import graph
 * (and of the `cinatra.tools` modules), so a reference to the host's
 * primitive-call port anywhere in the pack's shipped code is read.
 */
export function discoverCodeFiles(packDir) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      throw new Error(`cannot list ${relative(REPO_ROOT, dir)}: ${err?.message ?? err}`);
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_CODE_DIRS.has(entry.name)) walk(full);
      } else if (
        entry.isFile() &&
        CODE_FILE_RE.test(entry.name) &&
        !TEST_FILE_RE.test(entry.name) &&
        !/\.d\.[cm]?ts$/.test(entry.name)
      ) {
        files.push(full);
      }
    }
  };
  walk(packDir);
  return files.sort();
}

/** A map keyed by names from data: no prototype, so no name is "already there". */
function nameMap() {
  return Object.create(null);
}

/** The tool findings of one pack: the manifest, the flow and the code. */
function scanPackTools({ dir, packageJson, oasJson, owners }) {
  const name = packageJson.name;
  const found = collectToolUses({ packageJson, oasJson });
  const uses = [...found.uses];
  const malformed = found.malformed.map((m) => `${name}: ${m}`);
  const findings = nameMap();
  for (const c of TOOL_CLASSES) findings[c] = nameMap();
  const add = (cls, key, reason) => {
    const entries = Object.hasOwn(findings[cls], name) ? findings[cls][name] : (findings[cls][name] = nameMap());
    if (!Object.hasOwn(entries, key)) entries[key] = reason;
  };
  for (const d of found.dynamic) add("dynamicToolNames", d.key, d.reason);

  // The port rule: code that references the primitive-call port needs the
  // pack's own declaration (package.json#cinatra.consumes) of what it calls.
  const declaresConsumes = uses.some((u) => u.source.startsWith("package.json "));
  for (const file of discoverCodeFiles(dir)) {
    const rel = relative(dir, file).split(sep).join("/");
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      malformed.push(`${name}: ${rel}: cannot be read (${err?.message ?? err})`);
      continue;
    }
    // Speed only: a file that does not contain the method name cannot
    // reference it. Every file that does is read by the parser, which decides.
    if (!text.includes(PRIMITIVE_PORT_METHOD)) continue;
    const ref = referencesPrimitivePort({ fileName: rel, text });
    for (const m of ref.malformed) malformed.push(`${name}: ${m}`);
    if (ref.references && !declaresConsumes) {
      add(
        "undeclaredPortUses",
        rel,
        `${rel}:${ref.line} references the host's primitive-call port (${PRIMITIVE_PORT_METHOD}), and the pack declares ` +
          `no consumed primitive in package.json cinatra.consumes, so what it calls is not declared`,
      );
    }
  }
  const declared = declaredDependencyMap(packageJson);
  for (const use of uses) {
    const verdict = classifyToolUse({ consumer: name, use, owners, declared });
    if (verdict) add(verdict.cls, verdict.key, verdict.reason);
  }
  return { findings, malformed, useCount: uses.length };
}

function sortToolMap(map) {
  const out = nameMap();
  for (const pkg of Object.keys(map).sort()) {
    out[pkg] = nameMap();
    for (const key of Object.keys(map[pkg]).sort()) out[pkg][key] = map[pkg][key];
  }
  return out;
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
  const unnamed = [];
  for (const dir of dirs) {
    const packageJson = readJsonIfPresent(join(dir, "package.json"));
    if (!packageJson || typeof packageJson.name !== "string") {
      unnamed.push(`${relative(REPO_ROOT, dir)}/package.json: no package name, so the pack cannot be read`);
      continue;
    }
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
  const malformed = [...unnamed];
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

  // Pass 3 — the tool-owner rule (cinatra#4874): every tool a pack uses whose
  // owner is another pack needs that pack in its cinatra.dependencies.
  const inventoryPath = join(REPO_ROOT, INVENTORY_REL);
  if (!existsSync(inventoryPath)) {
    throw new Error(`the authz inventory ${INVENTORY_REL} is missing, so no tool owner can be read`);
  }
  const inventory = readJsonIfPresent(inventoryPath);
  const packDirToName = new Map(
    manifests.map(({ dir, packageJson }) => [relative(REPO_ROOT, dir).split(sep).join("/"), packageJson.name]),
  );
  const { owners, problems } = readInventoryOwners({ inventory, packDirToName });
  malformed.push(...problems);
  const toolFindings = nameMap();
  for (const c of TOOL_CLASSES) toolFindings[c] = nameMap();
  let toolUseCount = 0;
  for (const { dir, packageJson, oasJson } of manifests) {
    const res = scanPackTools({ dir, packageJson, oasJson, owners });
    malformed.push(...res.malformed);
    toolUseCount += res.useCount;
    for (const cls of TOOL_CLASSES) Object.assign(toolFindings[cls], res.findings[cls]);
  }
  for (const cls of TOOL_CLASSES) toolFindings[cls] = sortToolMap(toolFindings[cls]);
  return { findings, reasons, malformed, extensionCount: manifests.length, edgeCount, toolFindings, toolUseCount };
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
  const { findings, reasons, malformed, extensionCount, edgeCount, toolFindings, toolUseCount } = result;
  const totals = Object.fromEntries(FINDING_CLASSES.map((c) => [c, countPairs(findings[c])]));
  const toolTotals = Object.fromEntries(TOOL_CLASSES.map((c) => [c, toolPairs(toolFindings[c]).size]));
  const toolSummary = TOOL_CLASSES.map((c) => `${toolTotals[c]} ${c}`).join(", ");

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
    // Tool classes: a listed entry keeps its written reason; a new one gets
    // the finding's own reason (the base guard refuses it on a pull request).
    const own = (obj, key) => (isPlainObject(obj) && Object.hasOwn(obj, key) ? obj[key] : undefined);
    for (const cls of TOOL_CLASSES) {
      const map = nameMap();
      for (const [pkg, entries] of Object.entries(toolFindings[cls])) {
        map[pkg] = nameMap();
        for (const [key, reason] of Object.entries(entries)) {
          const kept = own(own(own(existing, cls), pkg), key);
          map[pkg][key] = typeof kept === "string" && kept.trim() !== "" ? kept : reason;
        }
      }
      baseline[cls] = map;
    }
    baseline.notes = existing.notes ?? {};
    writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2) + "\n");
    console.log(
      `[extension-produces-deps] wrote baseline: ` +
        FINDING_CLASSES.map((c) => `${totals[c]} ${c}`).join(", ") +
        `, ${toolSummary}` +
        ` (scanned ${extensionCount} extensions / ${edgeCount} produces-consumes edges / ${toolUseCount} tool uses).`,
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
    console.log(`\n[extension-produces-deps] tool-owner rule: ${toolUseCount} tool uses; ${toolSummary}.`);
    for (const cls of TOOL_CLASSES) {
      const entries = Object.entries(toolFindings[cls]);
      if (entries.length === 0) continue;
      console.log(`\n${cls}:`);
      for (const [pkg, keyed] of entries) {
        console.log(`  ${pkg}`);
        for (const [key, reason] of Object.entries(keyed)) console.log(`    - ${key}\n      ${reason}`);
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
  let baselineAbsentOnBase = false;

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
      baselineAbsentOnBase = true;
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

  // The tool-owner rule (cinatra#4874): the listed entries must match the scan
  // exactly (new = fail, stale = fail), and the list may only shrink against
  // the base branch (the shared floor base guard). The one-time seed is a
  // class absent from the base copy; a base without the whole file is the
  // gate's own bootstrap, read above.
  const toolLines = checkToolBaseline(toolFindings, baseline);
  let toolGuardOk = true;
  if (!baselineAbsentOnBase) {
    const guard = compareFloorWithBase({
      gate: "extension-produces-deps",
      envVar: "EXTENSION_PRODUCES_DEPS_BASE",
      floorPath: BASELINE_REL,
      headFloor: baseline,
      parse: (text) => JSON.parse(text),
      grown: toolClassGrowth,
      repoRoot: REPO_ROOT,
    });
    toolGuardOk = reportFloorGuard(guard);
    if (guard.baseFloor !== undefined) {
      for (const cls of toolClassesSeeded(guard.baseFloor)) {
        console.log(
          `[extension-produces-deps] ${cls} seed: ${toolPairs(baseline[cls]).size} entries (the class is absent from ` +
            `the base; the introducing change seeds it once, and it only shrinks afterwards).`,
        );
      }
    }
  }
  if (toolLines.length > 0) {
    console.error(
      `[extension-produces-deps] FAIL — the tool-owner list ${BASELINE_REL} does not match the scan ` +
        `(a pack's use of another pack's tool needs that pack in its cinatra.dependencies):`,
    );
    for (const line of toolLines) console.error(`  - ${line}`);
    console.error(
      `\n  Fix a NEW entry in the consuming pack's repository: add the owning pack to \`cinatra.dependencies\`\n` +
        `  (or stop using its tool), then bump the pin. Remove a STALE entry from the list.`,
    );
  }
  const toolFail = toolLines.length > 0 || !toolGuardOk;

  let newCount = 0;
  const newByClass = {};
  for (const cls of FINDING_CLASSES) {
    const { newViolations } = diffAgainstBaseline(findings[cls], baseline, cls);
    newByClass[cls] = newViolations;
    newCount += countPairs(newViolations);
  }

  if (newCount === 0 && toolFail) process.exit(1);
  if (newCount === 0) {
    console.log(
      `[extension-produces-deps] OK — no new undeclared produced-artifact dependencies (scanned ` +
        `${extensionCount} extensions / ${edgeCount} edges; ` +
        FINDING_CLASSES.map((c) => `${totals[c]} ${c}`).join(", ") +
        ` baselined); tool-owner rule: ${toolUseCount} tool uses, ${toolSummary} listed.`,
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
