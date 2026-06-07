#!/usr/bin/env node
// CI gate: every extension manifest must carry the policy-correct `license`
// field. Reuses the migration's pure policy helper so the gate and the one-shot
// migration can never disagree.
//
// Apache-2.0 for cinatra-ai extensions; GPL-2.0-or-later for any GPL-derived
// extension. Run by build-image.yml.

import { readFileSync } from "node:fs";
import { relative, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listExtensionManifests, targetLicenseFor, licenseOptsForManifest } from "../extensions/apply-license-cleanup.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const violations = [];
for (const manifestPath of listExtensionManifests()) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    violations.push(`${relative(REPO_ROOT, manifestPath)}: invalid JSON`);
    continue;
  }
  const want = targetLicenseFor(pkg.name, licenseOptsForManifest(pkg));
  if (want === null) {
    violations.push(
      `${relative(REPO_ROOT, manifestPath)}: no license policy for scope of "${pkg.name}" — add it to scripts/extensions/apply-license-cleanup.mjs (a vendored package must declare its upstream license)`,
    );
  } else if (pkg.license !== want) {
    violations.push(
      `${relative(REPO_ROOT, manifestPath)}: license=${JSON.stringify(pkg.license ?? null)}, want "${want}" — run \`node scripts/extensions/apply-license-cleanup.mjs\``,
    );
  }
}

if (violations.length) {
  console.error("[extension-license-gate] FAIL — extension license-field drift:");
  for (const v of violations) console.error("  - " + v);
  process.exit(1);
}
console.log("[extension-license-gate] OK — all extension manifests carry the policy license field.");
