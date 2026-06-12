// Presence-conditional seeding helper (cinatra#151 Stage 6).
//
// THE one shared helper every host-owned seed surface uses before writing a
// row that names an OPTIONAL extension: resolve the package against the
// MATERIALIZED EXTENSION UNIVERSE and skip-with-notice when absent — never
// seed a dangling agent ref, never assert presence (guardedOptional agents
// are absent from the required-only universe as a NORMAL state).
//
// Presence source: the on-disk extensions/<scope>/<dir>/package.json tree —
// the same universe the generated manifest maps and the boot-time
// registrars derive from. This is a SEED-BOOTSTRAP proxy for presence, not
// the general runtime registry (that is the installed_extension canonical
// store): the demo seed itself wipes/writes installed_extension fixture
// rows, so the DB cannot be its own presence authority here, while the
// disk universe is deterministic for both the full dev tree and the
// required-only universe.
//
// Pure module: no DB, no side effects; fs access only in
// readPresentExtensionPackages (the filter itself is I/O-free and
// deterministic — pinned by scripts/__tests__/seed-workflow-presence.test.mjs).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** Package names present in the materialized extension universe under
 * `extensionsRoot` (scans `<root>/<scope>/<dir>/package.json`). */
export function readPresentExtensionPackages(extensionsRoot) {
  const present = new Set();
  if (!existsSync(extensionsRoot)) return present;
  for (const scope of readdirSync(extensionsRoot, { withFileTypes: true })) {
    if (!scope.isDirectory()) continue;
    const scopeDir = path.join(extensionsRoot, scope.name);
    let entries;
    try {
      entries = readdirSync(scopeDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dir of entries) {
      if (!dir.isDirectory()) continue;
      try {
        const pkg = JSON.parse(
          readFileSync(path.join(scopeDir, dir.name, "package.json"), "utf8"),
        );
        if (typeof pkg.name === "string" && pkg.name.length > 0) present.add(pkg.name);
      } catch {
        /* not a package dir */
      }
    }
  }
  return present;
}

/** Recursively collect every agent package a seed fixture node references —
 * BOTH the structured `agentRef.package` ref and the denormalized
 * `agentPackage` column carried by instance task rows (either alone would
 * leave a dangling ref in the other). Recursive so nested task shapes
 * (e.g. foreach templates) are covered, not just flat task arrays. */
export function collectAgentRefPackages(node, out = new Set()) {
  if (Array.isArray(node)) {
    for (const item of node) collectAgentRefPackages(item, out);
    return out;
  }
  if (node === null || typeof node !== "object") return out;
  if (typeof node.agentPackage === "string" && node.agentPackage.length > 0) {
    out.add(node.agentPackage);
  }
  const ref = node.agentRef;
  if (ref && typeof ref === "object" && typeof ref.package === "string" && ref.package.length > 0) {
    out.add(ref.package);
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === "object") collectAgentRefPackages(value, out);
  }
  return out;
}

/**
 * Presence-filter the workflow seed fixtures. Deterministic and pure:
 *   - a TEMPLATE is skipped iff it references an agent package absent from
 *     `presentPackages`;
 *   - an INSTANCE is skipped iff its `sourceTemplateId` belongs to a skipped
 *     template (a kept instance must never dangle on an unseeded template)
 *     OR its own task rows reference an absent agent package.
 * Returns the kept arrays (original order) plus skip records carrying the
 * missing package names for the caller's logged notices.
 */
export function filterWorkflowSeedByPresence({ templates, instances }, presentPackages) {
  const skippedTemplates = [];
  const keptTemplates = [];
  const skippedTemplateIds = new Set();
  for (const t of templates) {
    const missing = [...collectAgentRefPackages(t)].filter((p) => !presentPackages.has(p)).sort();
    if (missing.length > 0) {
      skippedTemplates.push({ id: t.id, missing });
      skippedTemplateIds.add(t.id);
    } else {
      keptTemplates.push(t);
    }
  }
  const skippedInstances = [];
  const keptInstances = [];
  for (const wf of instances) {
    if (wf.sourceTemplateId && skippedTemplateIds.has(wf.sourceTemplateId)) {
      skippedInstances.push({ id: wf.id, missing: [], reason: `template ${wf.sourceTemplateId} skipped` });
      continue;
    }
    const missing = [...collectAgentRefPackages(wf)].filter((p) => !presentPackages.has(p)).sort();
    if (missing.length > 0) {
      skippedInstances.push({ id: wf.id, missing, reason: "absent agent extension(s)" });
    } else {
      keptInstances.push(wf);
    }
  }
  return { templates: keptTemplates, instances: keptInstances, skippedTemplates, skippedInstances };
}
