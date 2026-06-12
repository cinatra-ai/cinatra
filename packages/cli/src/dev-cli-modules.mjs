// Dev-CLI module discovery (cinatra#151 Stage 5c).
//
// Extensions contribute modules to the dev CLI by DECLARING them in their
// manifest: `cinatra.devCliModules: { "<key>": "./relative/module.mjs" }`.
// The CLI discovers a key by scanning `extensions/<scope>/<name>/package.json`
// — it never names a concrete extension package or path. The tailscale
// provisioning handlers consume the "tailscale-api" / "tailscale-hostname"
// keys declared by the tailscale connector's manifest.
//
// Absence posture (UNCHANGED from the retired literal lazy imports): the
// extensions tree is a gitignored clone-back target, ABSENT on a fresh
// checkout until `cinatra setup dev` populates it. When no present extension
// declares the requested key, the loader throws an Error with
// `.code = "ERR_MODULE_NOT_FOUND"` — the exact failure class the inline
// `import()` of a missing path produced — so every caller's existing
// graceful-degradation guard keeps working.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// packages/cli/src -> repo root
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

/**
 * Find the module file declared under `cinatra.devCliModules[key]` by any
 * extension present on disk. Returns an absolute path or null.
 *
 * Deterministic: scopes and package dirs are scanned in sorted order; the
 * first declarer wins (in practice each key has exactly one declarer — a
 * duplicate would indicate two extensions claiming the same CLI surface, and
 * the first sorted one is used).
 */
export function discoverDevCliModulePath(key, repoRoot = REPO_ROOT) {
  const extRoot = path.join(repoRoot, "extensions");
  let scopes;
  try {
    scopes = readdirSync(extRoot).sort();
  } catch {
    return null;
  }
  for (const scope of scopes) {
    let dirs;
    try {
      dirs = readdirSync(path.join(extRoot, scope)).sort();
    } catch {
      continue;
    }
    for (const dir of dirs) {
      let pkg;
      try {
        pkg = JSON.parse(
          readFileSync(path.join(extRoot, scope, dir, "package.json"), "utf8"),
        );
      } catch {
        continue; // not a package dir
      }
      const declared = pkg?.cinatra?.devCliModules;
      if (!declared || typeof declared !== "object") continue;
      const rel = declared[key];
      if (typeof rel !== "string" || rel.length === 0) continue;
      // Confine the declared path inside the declaring extension dir
      // (a manifest is repo-external data; never let it traverse out).
      const base = path.join(extRoot, scope, dir);
      const resolved = path.resolve(base, rel);
      if (resolved !== base && !resolved.startsWith(base + path.sep)) continue;
      return resolved;
    }
  }
  return null;
}

/**
 * Dynamic-import the module declared under `cinatra.devCliModules[key]`.
 * Throws ERR_MODULE_NOT_FOUND (as `.code`) when no present extension
 * declares the key — same failure class as the retired literal import of a
 * missing extension path, preserving every caller's degradation guard.
 */
export async function loadDevCliModule(key, repoRoot = REPO_ROOT) {
  const modulePath = discoverDevCliModulePath(key, repoRoot);
  if (!modulePath) {
    const err = new Error(
      `Cannot find module for dev-CLI key "${key}" — no extension present under extensions/ ` +
        `declares cinatra.devCliModules["${key}"] (the extensions tree is populated by \`cinatra setup dev\`).`,
    );
    err.code = "ERR_MODULE_NOT_FOUND";
    throw err;
  }
  return import(pathToFileURL(modulePath).href);
}
