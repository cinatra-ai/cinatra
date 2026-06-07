"use strict";
// Source-relocation cutover: the extracted extension repos are cloned back into
// extensions/<scope>/<name> with the STANDALONE manifest form — host-internal
// first-party deps (@cinatra-ai/sdk-extensions, @cinatra-ai/sdk-ui, ...) are
// declared as `"*"` optional peers (valid for a standalone repo). Inside THIS
// monorepo those are workspace packages; pnpm must LINK them, not fetch `*` from
// npmjs. Rewrite the spec to `workspace:*` IN-MEMORY (readPackage) so we never
// mutate the cloned repo's package.json on disk (preserves dev-contribute
// fidelity). Targets only first-party scopes + only when the spec is `*`.
//
// VENDOR-AGNOSTIC: the first-party scope set is DERIVED from the in-tree
// `extensions/<scope>/` directories (each immediate subdir is a scope) — no
// hard-coded vendor list. The `@cinatra-ai` host scope (the SDK lives in
// `packages/`) is always included since host-internal SDK peers are the whole
// point of this rewrite.
const fs = require("node:fs");
const path = require("node:path");
function firstPartyScopes() {
  const scopes = new Set(["@cinatra-ai"]);
  try {
    for (const entry of fs.readdirSync(path.join(__dirname, "extensions"), { withFileTypes: true })) {
      if (entry.isDirectory()) scopes.add("@" + entry.name);
    }
  } catch {
    // extensions/ unreadable: fall back to the host scope only. A first-party peer
    // declared `*` that we then fail to rewrite stays unresolvable → pnpm fails
    // LOUD at install (never a silent npmjs fetch of a non-existent `*`).
  }
  return scopes;
}
const FIRST_PARTY_SCOPES = firstPartyScopes();
function scopeOf(name) {
  const m = /^(@[^/]+)\//.exec(name);
  return m ? m[1] : null;
}
function rehydrate(pkg) {
  for (const bucket of ["dependencies", "peerDependencies"]) {
    const deps = pkg[bucket];
    if (!deps) continue;
    for (const name of Object.keys(deps)) {
      const scope = scopeOf(name);
      if (scope && FIRST_PARTY_SCOPES.has(scope) && deps[name] === "*") {
        // Promote to a real workspace dependency so pnpm links the workspace
        // package instead of resolving `*` from npmjs.
        pkg.dependencies = pkg.dependencies || {};
        pkg.dependencies[name] = "workspace:*";
        if (bucket === "peerDependencies") {
          delete pkg.peerDependencies[name];
          if (pkg.peerDependenciesMeta) delete pkg.peerDependenciesMeta[name];
        }
      }
    }
  }
  return pkg;
}
module.exports = { hooks: { readPackage: rehydrate } };
