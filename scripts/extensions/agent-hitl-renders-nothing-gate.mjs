#!/usr/bin/env node
// Agent HITL renders-nothing gate (cinatra-ai/cinatra#3470, epic #3248).
//
// THE THREE-KIND RULE: "Connectors render the setup page themselves.
// Artifacts render the artifact view themselves. Agents do NOT render the
// HITL view themselves." (maintainer ruling of 2026-09-13). An agent package
// DECLARES each HITL screen in its manifest, and the product draws it with its
// own components. The connector and artifact clauses are held by
// scripts/extensions/self-rendering-extensions-border-gate.mjs; this gate
// holds the agent clause.
//
// NO BASELINE. The owner ruled on the earlier ratchet draft (pull request
// 3472): "what about legacy implementations? They are not allowed to stay."
// So this gate refuses every finding outright, and it lands only after the
// agent packages have dropped their own screens and the host pins moved.
//
// For every package of kind agent in the synced extension tree it refuses:
//   (1) COMPONENT: a `cinatra.fieldRenderers[]` entry that declares a
//       `component` (the shared validator in agent-binding-kinds.mjs refuses
//       the same at generation; this gate names it beside the others);
//   (2) COPY: any file under `src/components/ui/` (a vendored copy of a
//       design-registry primitive);
//   (3) DIRECT REACH: a source file that imports the product's
//       `@/components/ui/*`, `@/lib/utils` or `src/components/ui`;
//   (4) VENDORING: an entry for the package in the vendoring manifest
//       (scripts/extensions/vendor-extension-primitives.mjs VENDOR_MANIFEST).
//
// NOTHING UNREAD. The census is the border gate's (scanBorder): every package
// the root package.json declares (cinatra.devExtensions) is read or refused by
// name, and a `cinatra.fieldRenderers` value of an agent package that is not a
// list is refused. A refusal fails the gate, as a finding does.
//
// Usage:
//   node scripts/extensions/agent-hitl-renders-nothing-gate.mjs
// Test injection (a synthetic tree, the shape the border gate takes):
//   AGENT_HITL_GATE_EXT_ROOT=<dir holding cinatra-ai/<package>/>
// The declared set is read from the package.json BESIDE the extension tree.
//
// Exit codes: 0 = clean, 1 = a finding or a refusal.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scanBorder } from "./self-rendering-extensions-border-gate.mjs";
import { VENDOR_MANIFEST } from "./vendor-extension-primitives.mjs";
import { AGENT_HITL_RULE_ISSUE } from "./agent-binding-kinds.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

const EXT_ROOT = process.env.AGENT_HITL_GATE_EXT_ROOT || join(REPO_ROOT, "extensions");

/** The prefix of every refusal line this gate adds to the census's own. */
export const REFUSED = "[agent-hitl-renders-nothing] REFUSED:";

/** The kinds this gate reads: the agent clause only. */
export const AGENT_KINDS = new Set(["agent"]);

/** The repo-relative directory prefix the vendoring manifest uses. */
const SCOPE_PREFIX = "extensions/cinatra-ai";

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * The census of the agent packages: the border census with the agent kinds,
 * plus each agent's declared component bindings.
 * Returns `{ packages, copies, coupling, components, refusals }`.
 */
export function scanAgentBorder({ extRoot = EXT_ROOT, declaredRoot } = {}) {
  const census = scanBorder({
    extRoot,
    ...(declaredRoot !== undefined ? { declaredRoot } : {}),
    kinds: AGENT_KINDS,
  });
  const refusals = [...census.refusals];
  const components = [];
  for (const pkg of census.packages) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(pkg.dir, "package.json"), "utf8"));
    } catch (err) {
      refusals.push(`${REFUSED} ${pkg.name}: package.json cannot be read (${err?.code ?? err?.message ?? err})`);
      continue;
    }
    const declared = isPlainObject(manifest?.cinatra) ? manifest.cinatra.fieldRenderers : undefined;
    if (declared === undefined) continue;
    if (!Array.isArray(declared)) {
      refusals.push(`${REFUSED} ${pkg.name}: cinatra.fieldRenderers is present but is not a list`);
      continue;
    }
    declared.forEach((entry, i) => {
      if (isPlainObject(entry) && Object.prototype.hasOwnProperty.call(entry, "component")) {
        const id = typeof entry.id === "string" ? entry.id : `cinatra.fieldRenderers[${i}]`;
        components.push({ package: pkg.name, binding: id });
      }
    });
  }
  return { ...census, components, refusals: [...new Set(refusals)] };
}

/** The repo-relative directories the vendoring manifest claims. */
export function vendoringManifestDirs(manifest = VENDOR_MANIFEST) {
  return new Set(manifest.map((e) => e.extensionDir));
}

/** Every finding of a census, sorted: [{ kind, package, detail }]. */
export function evaluateAgentBorder(census, vendorDirs = vendoringManifestDirs()) {
  const findings = [];
  for (const c of census.components ?? []) {
    findings.push({ kind: "component", package: c.package, detail: c.binding });
  }
  for (const [pkg, files] of Object.entries(census.copies ?? {})) {
    for (const file of files) findings.push({ kind: "primitive-copy", package: pkg, detail: file });
  }
  for (const c of census.coupling ?? []) {
    findings.push({ kind: "direct-reach", package: c.package, detail: `${c.file} imports ${c.specifier}` });
  }
  for (const pkg of census.packages ?? []) {
    const dir = `${SCOPE_PREFIX}/${pkg.name}`;
    if (vendorDirs.has(dir)) findings.push({ kind: "vendoring-manifest-entry", package: pkg.name, detail: dir });
  }
  const key = (f) => `${f.kind}\u0000${f.package}\u0000${f.detail}`;
  return findings.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

const LABEL = {
  component: "declares a field-renderer component on binding",
  "primitive-copy": "carries a copy of a design-registry primitive:",
  "direct-reach": "reaches into the product's primitives:",
  "vendoring-manifest-entry": "is listed in the vendoring manifest:",
};

function main() {
  const census = scanAgentBorder();
  const findings = evaluateAgentBorder(census);
  if (census.refusals.length > 0 || findings.length > 0) {
    console.error(
      `[agent-hitl-renders-nothing] FAIL (${AGENT_HITL_RULE_ISSUE}): agents do NOT render the HITL view themselves. ` +
        "An agent package declares its screens; the product draws them. No baseline: every finding below must go.",
    );
    census.refusals.forEach((line) => console.error(line));
    findings.forEach((f) => console.error(`  ${f.package} ${LABEL[f.kind]} ${f.detail}`));
    process.exit(1);
  }
  const n = census.packages.length;
  console.log(
    `[agent-hitl-renders-nothing] OK: ${n} agent package${n === 1 ? "" : "s"} read; ` +
      "no component, no primitive copy, no direct reach, no vendoring entry, nothing unread.",
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
