#!/usr/bin/env node
// CI gate: the `cinatra.dependencies` manifest consistency gate.
//
// Every in-tree extension MUST declare its cross-kind dependency edges in the
// canonical `cinatra.dependencies[]` shape, and that declaration must STAY in
// sync with the confident edges re-derived from live source. This is what lets
// the marketplace dependency-order extraction (a connector can't publish before
// its `@cinatra-ai/*` closure is in the registry) and lets the dependency
// closure install/activate/uninstall an extension safely.
//
// Source of truth: `buildInventory()` (scripts/extensions/inventory.mjs) re-derives the
// confident graph from source (workspace deps + cross-extension static imports +
// cinatra.agentDependencies + OAS child-agent refs) — the SAME derivation the
// backfill script consumes, so a backfilled tree passes by construction.
//
// STRICT (hard fail), NOT a ratchet:
//   1. every manifest declares `cinatra.dependencies` as an array;
//   2. every entry is a valid ExtensionDependency (right shape + kind matches the
//      target's actual kind);
//   3. every CONFIDENT structural edge from→to is declared in `from`'s manifest.
// The LLM-inferred OAS-mention candidate edges are ADVISORY (printed as warnings,
// never fail CI) — they need human review before they become declared edges.
//
// Usage:
//   node scripts/audit/extension-deps-gate.mjs            # check (exit 1 on drift)
//   node scripts/audit/extension-deps-gate.mjs --warnings # also print advisory candidates
//
// Exit codes: 0 = clean, 1 = drift/violation, 2 = internal error.

import { buildInventory, isValidExtensionDependency } from "../extensions/inventory.mjs";

const showWarnings = process.argv.includes("--warnings");

async function main() {
  const inv = await buildInventory();
  const nameToKind = new Map(
    inv.extensions.map((x) => [x.name, x.kind]).filter(([, k]) => k),
  );

  // VALID declared deps per extension, keyed packageName → the full dep object
  // (so the structural check can compare edgeType/requirement, not just presence).
  const declaredByName = new Map();
  const errors = [];

  for (const x of inv.extensions) {
    const decl = x.cinatraDependencies;
    if (decl === null || decl === undefined) {
      errors.push(`${x.name}: missing \`cinatra.dependencies\` (must be declared, use [] when none).`);
      declaredByName.set(x.name, new Map());
      continue;
    }
    if (!Array.isArray(decl)) {
      errors.push(`${x.name}: \`cinatra.dependencies\` must be an array (got ${typeof decl}).`);
      declaredByName.set(x.name, new Map());
      continue;
    }
    const valid = new Map();
    for (const dep of decl) {
      if (!isValidExtensionDependency(dep, nameToKind)) {
        errors.push(`${x.name}: malformed dependency entry ${JSON.stringify(dep)} (need {packageName, edgeType, versionConstraint, requirement[, kind]}, kind must match the target's actual kind).`);
        continue;
      }
      valid.set(dep.packageName, dep);
    }
    declaredByName.set(x.name, valid);
  }

  // STRICT: every confident structural edge must be declared in the source
  // manifest WITH MATCHING SEMANTICS. A required/runtime structural edge declared
  // as optional/peer would silently weaken the dependency closure (the resolver
  // treats any non-"required" requirement as optional), so edgeType + requirement
  // must match the derived edge — packageName presence alone is not enough.
  for (const edge of inv.dependencyGraph) {
    const declared = declaredByName.get(edge.from)?.get(edge.to);
    if (!declared) {
      errors.push(
        `${edge.from}: undeclared structural dependency on ${edge.to} ` +
          `(detected via ${edge.sources.join("+")}). Add it to cinatra.dependencies ` +
          `(or decouple).`,
      );
      continue;
    }
    if (declared.edgeType !== edge.edgeType || declared.requirement !== edge.requirement) {
      errors.push(
        `${edge.from}: structural dependency on ${edge.to} is declared as ` +
          `${declared.edgeType}/${declared.requirement} but the source edge is ` +
          `${edge.edgeType}/${edge.requirement} (detected via ${edge.sources.join("+")}). ` +
          `A confident structural edge must be declared with the same edgeType + requirement.`,
      );
    }
  }

  // ADVISORY: LLM-inferred OAS-mention candidate edges that are not declared.
  const advisory = [];
  for (const c of inv.candidateEdges) {
    const declared = declaredByName.get(c.from);
    if (!declared || !declared.has(c.to)) {
      advisory.push(`${c.from} → ${c.to} (candidate via ${c.source}${c.tokens ? `: ${c.tokens.join(",")}` : ""})`);
    }
  }

  console.log(`extension-deps-gate: ${inv.extensions.length} manifests, ${inv.dependencyGraph.length} confident edges, ${advisory.length} advisory candidate(s).`);

  if (advisory.length > 0 && showWarnings) {
    console.log("\nAdvisory (human-review candidate edges — NOT gated):");
    for (const a of advisory) console.log(`  ~ ${a}`);
  }

  if (errors.length > 0) {
    console.error(`\n✖ ${errors.length} dependency-manifest drift error(s):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  console.log("✓ All extension dependency manifests are consistent with the source dependency graph.");
}

main().catch((err) => {
  console.error("extension-deps-gate internal error:", err);
  process.exit(2);
});
