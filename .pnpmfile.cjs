"use strict";
// The companion extension repos are cloned back into
// extensions/<scope>/<name> with the STANDALONE manifest form — host-internal
// first-party deps (@cinatra-ai/sdk-extensions, @cinatra-ai/sdk-ui, ...) are
// declared as optional peers (valid for a standalone repo). Inside THIS
// monorepo those are workspace packages; pnpm must LINK them, not fetch them
// from npmjs. Rewrite the spec to `workspace:*` IN-MEMORY (readPackage) so we
// never mutate the cloned repo's package.json on disk (preserves
// dev-contribute fidelity). Targets only first-party scopes.
//
// SPEC-FORM AGNOSTIC (cinatra#2367): the rewrite used to fire only on the
// exact spec `"*"`, so a companion repo that declared the same peer as a
// SEMVER RANGE (`"^0.1.1"` — equally valid standalone) fell through to a
// registry fetch and the whole install died with ERR_PNPM_FETCH_404. The spec
// FORM was never the point: what makes linking correct is that the package IS
// one of this monorepo's own workspace packages. So the rewrite now keys on
// that fact — the name resolves to a `packages/<x>` workspace package — and
// leaves any spec that already says `workspace:`/`link:`/`file:` alone. A
// first-party name that is NOT a workspace package here still resolves the
// normal way (it is a real published dependency, not a host-internal peer).
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
// The names of THIS monorepo's own workspace packages (packages/<x>). Read
// once at load. A first-party peer naming one of these is host-internal by
// construction and must be LINKED whatever spec form the standalone manifest
// used. Unreadable packages/ leaves the set empty — the `*` form below still
// rewrites, so behavior degrades to the previous rule rather than to a silent
// registry fetch.
function workspacePackageNames() {
  const names = new Set();
  try {
    for (const entry of fs.readdirSync(path.join(__dirname, "packages"), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const manifest = JSON.parse(
          fs.readFileSync(path.join(__dirname, "packages", entry.name, "package.json"), "utf8"),
        );
        if (typeof manifest.name === "string") names.add(manifest.name);
      } catch {
        // not a package dir (or unreadable manifest) — skip it
      }
    }
  } catch {
    // packages/ unreadable: fall back to the `*`-only rule below.
  }
  return names;
}
const WORKSPACE_PACKAGE_NAMES = workspacePackageNames();
const ALREADY_LOCAL = /^(workspace:|link:|file:)/;
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
      const spec = deps[name];
      const hostInternal =
        typeof spec === "string" &&
        !ALREADY_LOCAL.test(spec) &&
        (spec === "*" || WORKSPACE_PACKAGE_NAMES.has(name));
      if (scope && FIRST_PARTY_SCOPES.has(scope) && hostInternal) {
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
