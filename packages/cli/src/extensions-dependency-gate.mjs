// Dependency-ordering gate for marketplace submission.
//
// Before an extension tarball is submitted to the Cinatra Marketplace, every
// `@cinatra-ai/*` EXTENSION EDGE it declares in its canonical `cinatra.dependencies`
// MUST already be published on `registry.cinatra.ai` — those extension packages live
// ONLY there, never on npmjs. Host-internal SDK/app peers (sdk-extensions, sdk-ui,
// mcp-client, …) are NOT extension edges: under model-B they are host-provided
// optional peers, intentionally never on the registry, so the gate SKIPS them
// (probing would 404/401). Submitting a package whose sibling-extension closure is
// not yet on the registry would produce a public extension repo that cannot
// `pnpm install` a sibling it needs. This gate fails BEFORE submit if a real edge
// is missing.
//
// Strict failure semantics:
//   - 404 / no published versions / no version satisfying the range  → MISSING
//     (a real ordering violation — publish the closure first).
//   - 401 / 403                                                       → UNREADABLE
//     (registry.cinatra.ai requires authentication by design — no read-scope
//     token is set in this shell). This is NOT "missing" — we simply cannot
//     verify, so the gate fails closed with a DISTINCT message rather than
//     green-lighting blindly.
//   - network / non-JSON / other non-2xx                              → ERROR.
//
// Queries ONLY the configured registry (no npmjs fallback — a silent fallback
// would mask an ordering violation or a registry outage).

import semver from "semver";

export const CINATRA_SCOPE = "@cinatra-ai/";
export const DEFAULT_REGISTRY_URL = "https://registry.cinatra.ai";

/**
 * Extract every `@cinatra-ai/*` dependency (name + range + source field) from a
 * package manifest's `dependencies` and `peerDependencies`.
 * @param {{dependencies?:Record<string,string>, peerDependencies?:Record<string,string>}} manifest
 * @returns {Array<{name:string, range:string, field:string}>}
 */
export function extractCinatraDeps(manifest) {
  const out = [];
  const seen = new Set();
  for (const field of ["dependencies", "peerDependencies"]) {
    const deps = manifest?.[field];
    if (!deps || typeof deps !== "object") continue;
    for (const [name, range] of Object.entries(deps)) {
      if (!name.startsWith(CINATRA_SCOPE)) continue;
      const key = `${name}@${range}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name, range: String(range ?? ""), field });
    }
  }
  return out;
}

/**
 * Canonical cross-extension edge names from the manifest's `cinatra.dependencies`
 * (array of `{packageName}`, array of strings, or a name→spec object).
 * Only these @cinatra-ai/* deps are real marketplace dependencies that
 * must be on the registry first; host-internal SDK/app packages (sdk-extensions,
 * sdk-ui, mcp-client, …) are NEVER declared here — under model-B they are
 * host-provided OPTIONAL peers, intentionally not on any registry, and the gate
 * must SKIP them (probing would 404/401).
 * @param {{cinatra?:{dependencies?:unknown}}} manifest
 * @returns {string[]}
 */
export function extractCinatraManifestDepNames(manifest) {
  const c = manifest?.cinatra?.dependencies;
  const out = new Set();
  if (Array.isArray(c)) {
    for (const e of c) {
      if (e && typeof e === "object" && typeof e.packageName === "string") out.add(e.packageName);
      else if (typeof e === "string") out.add(e.startsWith("@") ? e : `${CINATRA_SCOPE}${e}`);
    }
  } else if (c && typeof c === "object") {
    for (const k of Object.keys(c)) out.add(k);
  }
  return [...out];
}

/**
 * Select which @cinatra-ai/* deps the ordering gate must verify on the registry:
 * ONLY the canonical extension edges declared in `cinatra.dependencies`. An npm
 * dep/peer that is NOT a declared edge is host-internal (a host-provided peer) and
 * is SKIPPED. An edge declared ONLY in `cinatra.dependencies` (no npm dep entry —
 * e.g. linkedin→social-media, resend→email) is still probed with range "*".
 * @param {object} manifest
 * @returns {{toProbe:Array<{name:string,range:string,field:string}>, skippedNonManifestCinatraDeps:string[]}}
 */
export function selectExtensionDepsToProbe(manifest) {
  const edgeNames = new Set(extractCinatraManifestDepNames(manifest));
  const npmDeps = extractCinatraDeps(manifest);
  const toProbe = [];
  const seen = new Set();
  for (const d of npmDeps) {
    if (edgeNames.has(d.name) && !seen.has(d.name)) {
      toProbe.push(d);
      seen.add(d.name);
    }
  }
  for (const name of edgeNames) {
    if (!seen.has(name)) {
      toProbe.push({ name, range: "*", field: "cinatra.dependencies" });
      seen.add(name);
    }
  }
  const skippedNonManifestCinatraDeps = npmDeps.filter((d) => !edgeNames.has(d.name)).map((d) => d.name);
  return { toProbe, skippedNonManifestCinatraDeps };
}

/** Build the npm-registry packument URL for a scoped package name. */
function packumentUrl(registryUrl, name) {
  // Scoped names are URL-encoded with every slash escaped: @scope%2Fname.
  return `${String(registryUrl).replace(/\/+$/, "")}/${name.replace(/\//g, "%2F")}`;
}

function authHeader(token) {
  if (!token) return {};
  const value = /^(Bearer|Basic)\s/i.test(token) ? token : `Bearer ${token}`;
  return { authorization: value };
}

/** True when at least one published version satisfies the declared range. */
export function isRangeSatisfied(range, versions, distTags = {}) {
  const r = String(range ?? "").trim();
  // The companion repos convert workspace deps to peerDependencies "*"; any
  // published version satisfies. Empty / "x" / "latest" behave the same.
  if (r === "" || r === "*" || r === "x" || r === "latest") return versions.length > 0;
  // A dist-tag reference (e.g. "next") is satisfied if that tag exists.
  if (Object.prototype.hasOwnProperty.call(distTags, r)) return true;
  try {
    return versions.some((v) => semver.satisfies(v, r, { includePrerelease: false }));
  } catch {
    // Unparseable range (git/url/file spec) — existence is the best we can do;
    // treat a published package as satisfying and let marketplace-side checks
    // own the deeper validation.
    return versions.length > 0;
  }
}

/**
 * Probe one `@cinatra-ai/*` dependency against the registry.
 * @returns {Promise<{name,range,field,state:'satisfied'|'unsatisfied'|'missing'|'unreadable'|'error', detail?:string, status?:number, versions?:string[]}>}
 */
export async function probeDep(dep, { registryUrl, token, fetchImpl }) {
  const url = packumentUrl(registryUrl, dep.name);
  let res;
  try {
    res = await fetchImpl(url, { headers: { accept: "application/json", ...authHeader(token) } });
  } catch (err) {
    return { ...dep, state: "error", detail: err instanceof Error ? err.message : String(err) };
  }
  if (res.status === 401 || res.status === 403) {
    return { ...dep, state: "unreadable", status: res.status };
  }
  if (res.status === 404) {
    return { ...dep, state: "missing", status: 404, detail: "not found on the registry" };
  }
  if (!res.ok) {
    return { ...dep, state: "error", status: res.status, detail: `unexpected HTTP ${res.status}` };
  }
  let body;
  try {
    body = await res.json();
  } catch {
    return { ...dep, state: "error", detail: "registry returned a non-JSON packument" };
  }
  const versions = Object.keys(body?.versions ?? {});
  const distTags = body?.["dist-tags"] ?? {};
  if (versions.length === 0) {
    return { ...dep, state: "missing", detail: "no published versions" };
  }
  return isRangeSatisfied(dep.range, versions, distTags)
    ? { ...dep, state: "satisfied" }
    : { ...dep, state: "unsatisfied", versions };
}

/**
 * Check that every `@cinatra-ai/*` dependency of `manifest` is published on the
 * registry. Resolves to a structured report; never throws on a gate violation
 * (the caller decides). Throws only on a programming error.
 */
export async function checkDependencyOrdering({
  manifest,
  registryUrl = DEFAULT_REGISTRY_URL,
  token,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("checkDependencyOrdering: no fetch implementation available");
  }
  // Probe ONLY canonical extension edges (cinatra.dependencies); host-internal
  // @cinatra-ai/* peers are host-provided under model-B and never on the registry.
  const { toProbe: deps, skippedNonManifestCinatraDeps } = selectExtensionDepsToProbe(manifest);
  const results = [];
  for (const dep of deps) {
    results.push(await probeDep(dep, { registryUrl, token, fetchImpl }));
  }
  const missing = results.filter((r) => r.state === "missing" || r.state === "unsatisfied");
  const unreadable = results.filter((r) => r.state === "unreadable");
  const errored = results.filter((r) => r.state === "error");
  const satisfied = results.filter((r) => r.state === "satisfied");
  return {
    ok: missing.length === 0 && unreadable.length === 0 && errored.length === 0,
    registryUrl,
    deps,
    skippedNonManifestCinatraDeps,
    results,
    missing,
    unreadable,
    errored,
    satisfied,
  };
}

/** Render a human-readable failure message for a non-ok report. */
export function formatGateFailure(report) {
  const lines = [];
  if (report.missing.length > 0) {
    lines.push(
      `Dependency-ordering gate FAILED — ${report.missing.length} @cinatra-ai/* dependency(ies) not on ${report.registryUrl}:`,
    );
    for (const m of report.missing) {
      lines.push(
        `  • ${m.name}@${m.range} [${m.field}] — ${m.state === "unsatisfied" ? `no published version satisfies (have: ${(m.versions || []).join(", ") || "none"})` : m.detail || "missing"}`,
      );
    }
    lines.push(
      "Publish the missing @cinatra-ai/* dependency extension(s) (in dependency order) THROUGH the marketplace storefront FIRST, then re-submit. (These are dependency extensions, not the host SDK.)",
    );
  }
  if (report.unreadable.length > 0) {
    lines.push(
      `Dependency-ordering gate could NOT verify — ${report.registryUrl} returned ${report.unreadable[0].status} (registry not readable):`,
    );
    for (const u of report.unreadable) lines.push(`  • ${u.name}@${u.range} [${u.field}]`);
    lines.push(
      "registry.cinatra.ai requires authentication by design — export a read-scope CINATRA_REGISTRY_TOKEN, then re-run. " +
        "(Use --skip-dependency-check only if you have independently confirmed the closure is published.)",
    );
  }
  if (report.errored.length > 0) {
    lines.push(`Dependency-ordering gate hit ${report.errored.length} registry error(s):`);
    for (const e of report.errored) lines.push(`  • ${e.name}@${e.range}: ${e.detail || `HTTP ${e.status}`}`);
  }
  return lines.join("\n");
}

/**
 * Assert the dependency-ordering gate passes. Throws with a formatted message
 * on any violation (missing / unreadable / error). Returns the report on pass.
 */
export async function assertDependencyOrdering(opts) {
  const report = await checkDependencyOrdering(opts);
  if (!report.ok) {
    throw new Error(formatGateFailure(report));
  }
  return report;
}
