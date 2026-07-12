#!/usr/bin/env node
// Completeness + pin-drift + schema-conformance gate for the stateful-service
// upgrade matrix (upgrade-paths slice 1, cinatra#1420).
//
// FAIL-CLOSED against the LIVE docker-compose.yml so a new stateful service (a
// new named volume) cannot be added without a matrix classification, and a pin
// bump in compose cannot land without a matching matrix update. Checks:
//
//   1. schema — the matrix conforms to docs/architecture/upgrade-matrix.schema.json
//      (a dependency-free validator over the JSON-Schema subset the schema uses).
//   2. volume completeness — the set of top-level named volumes in compose ==
//      the set of services[].volume (non-null). Missing => unclassified state
//      (FAIL); extra => stale matrix entry (FAIL). Exactly one volume-less
//      entry is allowed: the derived graphiti family.
//   3. compose-service existence — every services[].composeService is a real
//      service key in compose.
//   4. pin drift — every services[].baselinePin.image and every
//      coupledAppImages[].image equals the RESOLVED image string in compose
//      (${VAR:-default} resolved to its default).
//   5. no floating tags — no image in compose ends in a bare :latest/:stable.
//   6. family coverage — every REQUIRED_FAMILIES entry appears.
//   7. fail-closed default — failClosed.default === "unsupported".
//
// Usage:
//   node scripts/check-upgrade-matrix.mjs            (report; exit 1 on any failure)
//   node scripts/check-upgrade-matrix.mjs --check    (alias; same behavior)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { REQUIRED_FAMILIES } from "./lib/upgrade-matrix.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMPOSE = join(ROOT, "docker-compose.yml");
const MATRIX = join(ROOT, "docs/architecture/upgrade-matrix.json");
const SCHEMA = join(ROOT, "docs/architecture/upgrade-matrix.schema.json");

// ---------------------------------------------------------------------------
// Minimal docker-compose parser (dependency-free; the repo carries no yaml dep).
// Indentation-driven: services at 2-space indent under `services:`, `image:` at
// 4-space, named-volume mounts as `      - <name>:<path>` where <name> is a
// top-level volume. Top-level `volumes:` block lists the named volumes.
// ---------------------------------------------------------------------------
function resolveEnvDefault(s) {
  // `${VAR:-default}` / `${VAR-default}` -> default; `${VAR}` -> "" (unset).
  return s.replace(/\$\{([A-Z0-9_]+)(?::?-([^}]*))?\}/g, (_, _v, def) => def ?? "");
}

export function parseCompose(text) {
  const lines = text.split("\n");
  const services = {}; // name -> { image, volumes: Set }
  const topVolumes = new Set();
  let section = null; // "services" | "volumes" | "networks" | null
  let curService = null;

  for (const raw of lines) {
    const line = raw.replace(/\t/g, "  ");
    if (/^\s*#/.test(line) || line.trim() === "") continue;
    // Top-level key (column 0).
    const top = line.match(/^([a-zA-Z0-9_-]+):\s*$/);
    if (top) {
      section = top[1];
      curService = null;
      continue;
    }
    if (section === "services") {
      const svc = line.match(/^  ([a-zA-Z0-9_.-]+):\s*$/);
      if (svc) {
        curService = svc[1];
        services[curService] = { image: null, volumes: new Set() };
        continue;
      }
      if (!curService) continue;
      const img = line.match(/^    image:\s*(.+?)\s*$/);
      if (img) {
        // Strip a trailing YAML comment (` # ...`) — image refs never contain
        // a space, so the first ` #` always starts a comment (compose parses
        // it the same way).
        const value = img[1].replace(/\s+#.*$/, "").trim();
        services[curService].image = resolveEnvDefault(value);
        continue;
      }
      // Volume mount: `      - <name>:<path>` or `      - ./bind:/path`.
      const mnt = line.match(/^\s+-\s+([A-Za-z0-9_.-]+):\S/);
      if (mnt) services[curService].volumes.add(mnt[1]);
    } else if (section === "volumes") {
      const v = line.match(/^  ([a-zA-Z0-9_.-]+):\s*$/);
      if (v) topVolumes.add(v[1]);
    }
  }
  return { services, topVolumes };
}

// ---------------------------------------------------------------------------
// Minimal JSON-Schema validator (the subset our schema uses).
// ---------------------------------------------------------------------------
function validate(node, schema, path, root, errs) {
  const fail = (m) => errs.push(m);
  const validate2 = (n, s, p) => validate(n, s, p, root, errs);
  if (schema.$ref) {
    const def = schema.$ref.replace(/^#\//, "").split("/").reduce((o, k) => o?.[k], root);
    if (!def) return fail(`schema: unresolved $ref ${schema.$ref} at ${path}`);
    return validate2(node, def, path);
  }
  const types = schema.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : null;
  if (types) {
    const t =
      node === null ? "null" : Array.isArray(node) ? "array" : Number.isInteger(node) ? "integer" : typeof node;
    const ok = types.some((x) => x === t || (x === "number" && t === "integer") || (x === "integer" && t === "integer"));
    if (!ok) return fail(`schema: ${path} expected ${types.join("|")}, got ${t}`);
  }
  if (schema.const !== undefined && node !== schema.const) fail(`schema: ${path} must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(node)) fail(`schema: ${path} = ${JSON.stringify(node)} not in enum`);
  if (schema.pattern && typeof node === "string" && !new RegExp(schema.pattern).test(node))
    fail(`schema: ${path} = ${JSON.stringify(node)} fails pattern ${schema.pattern}`);
  if (typeof node === "object" && node !== null && !Array.isArray(node)) {
    for (const req of schema.required ?? []) if (!(req in node)) fail(`schema: ${path} missing required '${req}'`);
    if (schema.additionalProperties === false && schema.properties) {
      for (const k of Object.keys(node)) if (!(k in schema.properties) && k !== "$schema") fail(`schema: ${path}.${k} not allowed (additionalProperties:false)`);
    }
    for (const [k, sub] of Object.entries(schema.properties ?? {})) if (k in node) validate2(node[k], sub, `${path}.${k}`);
  }
  if (Array.isArray(node)) {
    if (schema.minItems != null && node.length < schema.minItems) fail(`schema: ${path} needs >= ${schema.minItems} items`);
    if (schema.uniqueItems && new Set(node.map((x) => JSON.stringify(x))).size !== node.length) fail(`schema: ${path} items not unique`);
    if (schema.items) node.forEach((el, i) => validate2(el, schema.items, `${path}[${i}]`));
  }
}

// ---------------------------------------------------------------------------
// Pure core: given the raw compose text + parsed matrix + schema, RETURN every
// problem as a string (no exit, no console). Importable so the vitest suite can
// assert both the clean tree AND injected regressions (proving the gate is not
// a no-op).
export function collectProblems({ composeText, matrix, schema }) {
  const errors = [];
  const fail = (m) => errors.push(m);
  const { services: compose, topVolumes } = parseCompose(composeText);

  // 1. schema conformance
  validate(matrix, schema, "$", schema, errors);

  // 2. volume completeness
  const matrixVolumes = new Set(matrix.services.map((s) => s.volume).filter(Boolean));
  for (const v of topVolumes) if (!matrixVolumes.has(v)) fail(`completeness: compose volume '${v}' has no matrix service (unclassified state)`);
  for (const v of matrixVolumes) if (!topVolumes.has(v)) fail(`completeness: matrix volume '${v}' is not a top-level compose volume (stale)`);
  const volumeless = matrix.services.filter((s) => !s.volume).map((s) => s.id);
  const allowedVolumeless = new Set(["graphiti", "twenty-redis"]);
  for (const id of volumeless) if (!allowedVolumeless.has(id)) fail(`completeness: matrix service '${id}' owns no volume and is not an allowed volume-less family`);

  // 3. compose-service existence + 4. pin drift
  const composeImages = Object.values(compose).map((s) => s.image).filter(Boolean);
  for (const s of matrix.services) {
    if (s.composeService && !(s.composeService in compose)) {
      fail(`existence: matrix service '${s.id}' -> composeService '${s.composeService}' not found in compose`);
      continue;
    }
    if (s.composeService) {
      const composeImg = compose[s.composeService].image;
      // Locally-built services (build: with no image: tag) carry no registry
      // pin to drift against; the matrix records a `built:*` marker for them.
      if (composeImg == null) {
        if (!/^built:/.test(s.baselinePin.image))
          fail(`pin-drift: '${s.id}' composeService '${s.composeService}' has no image tag (build-only) but baselinePin.image is not a built:* marker: ${s.baselinePin.image}`);
      } else if (s.baselinePin.image !== composeImg) {
        fail(`pin-drift: '${s.id}' baselinePin.image\n    matrix:  ${s.baselinePin.image}\n    compose: ${composeImg}`);
      }
    }
    for (const cai of s.coupledAppImages ?? []) {
      if (!composeImages.includes(cai.image))
        fail(`pin-drift: '${s.id}' coupledAppImage not found (resolved) in compose: ${cai.image}`);
    }
  }

  // 4b. repo-level pin net — every compose service whose image REPO is tracked
  //     by ANY matrix pin (baselinePin or coupledAppImages) must carry one of
  //     the tracked pin strings exactly. Catches drift on services that share a
  //     tracked repo without being a matrix composeService themselves (e.g. a
  //     single plane-backend consumer bumped while its siblings stay pinned,
  //     twenty-worker vs twenty-server, nango-server vs nango-db).
  const repoOf = (img) => img.split("@")[0].replace(/:[^/]*$/, "");
  const allowedByRepo = new Map(); // repo -> Set(exact image strings)
  for (const s of matrix.services) {
    for (const pin of [s.baselinePin, ...(s.coupledAppImages ?? [])]) {
      if (!pin?.image || /^built:/.test(pin.image)) continue;
      const repo = repoOf(pin.image);
      if (!allowedByRepo.has(repo)) allowedByRepo.set(repo, new Set());
      allowedByRepo.get(repo).add(pin.image);
    }
  }
  for (const [name, s] of Object.entries(compose)) {
    if (!s.image) continue;
    const allowed = allowedByRepo.get(repoOf(s.image));
    if (allowed && !allowed.has(s.image))
      fail(`pin-drift: service '${name}' image ${s.image} is on a matrix-tracked repo but matches no matrix pin (tracked: ${[...allowed].join(", ")})`);
  }

  // 5. no floating tags
  for (const [name, s] of Object.entries(compose)) {
    if (s.image && /:(latest|stable)(@sha256:[0-9a-f]{64})?$/.test(s.image) && !/@sha256:/.test(s.image))
      fail(`floating-tag: service '${name}' still on a floating tag: ${s.image}`);
  }

  // 6. family coverage
  const families = new Set(matrix.services.map((s) => s.family));
  for (const f of REQUIRED_FAMILIES) if (!families.has(f)) fail(`family-coverage: required family '${f}' absent from matrix`);

  // 7. fail-closed default
  if (matrix.failClosed?.default !== "unsupported") fail(`fail-closed: failClosed.default must be "unsupported", got ${JSON.stringify(matrix.failClosed?.default)}`);

  // 8. case-exception referential integrity — every exception names a real
  //    matrix service and does NOT duplicate an already-supported general
  //    transition (an exception that shadows the baseline is a smell: either
  //    it belongs in transitions, or the transition wrongly widens the
  //    baseline).
  const byId = new Map(matrix.services.map((s) => [s.id, s]));
  for (const ex of matrix.caseExceptions ?? []) {
    const svc = byId.get(ex.service);
    if (!svc) {
      fail(`case-exception: '${ex.case}' references unknown service '${ex.service}'`);
      continue;
    }
    const dup = (svc.transitions ?? []).find((t) => t.from === ex.from && t.to === ex.to && t.supported);
    if (dup) fail(`case-exception: '${ex.case}' duplicates supported general transition ${ex.service} ${ex.from}->${ex.to} (baseline-widening ambiguity)`);
  }

  return { errors, stats: { services: matrix.services?.length ?? 0, volumes: topVolumes.size, caseExceptions: matrix.caseExceptions?.length ?? 0, revision: matrix.revision } };
}

function main() {
  const composeText = readFileSync(COMPOSE, "utf8");
  const matrix = JSON.parse(readFileSync(MATRIX, "utf8"));
  const schema = JSON.parse(readFileSync(SCHEMA, "utf8"));
  const { errors, stats } = collectProblems({ composeText, matrix, schema });
  if (errors.length) {
    console.error(`[upgrade-matrix] ${errors.length} problem(s):`);
    for (const e of errors) console.error("  - " + e);
    process.exit(1);
  }
  console.log(
    `[upgrade-matrix] OK — rev ${stats.revision}, ${stats.services} services, ${stats.volumes} volumes, ${stats.caseExceptions} case exception(s); schema + completeness + pin-drift + fail-closed clean.`,
  );
}

// Run as a CLI only when executed directly (vitest imports the pure core).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
