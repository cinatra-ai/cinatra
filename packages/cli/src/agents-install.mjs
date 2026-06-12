// packages/cli/src/agents-install.mjs
//
// `cinatra agents install` — resolve an agent dependency graph against Verdaccio,
// write `cinatra-agents.lock`, and perform per-package install side-effects.
//
// Fully self-contained plain-Node.js implementation.
// Uses pacote for registry resolution (semver handled internally by pacote/npm-pick-manifest).
// Uses pg directly for DB writes — no Drizzle/server-only chain required.
//
// Exit codes:
//   0 success | 1 usage error | 2 resolver error | 3 integrity error | 4 config missing

import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";

import { CONNECTOR_DESCRIPTORS } from "@cinatra-ai/connectors-catalog/descriptors.mjs";

const USAGE = `Usage: cinatra agents install [<name>[@<range>]] [options]
Options:
  --manifest <path>       Read root name+range from a manifest file (package.json shape)
  --lockfile <path>       Lockfile path (default: ./cinatra-agents.lock)
  --lockfile-only         Write lockfile but skip install side-effects
  --dry-run               Print resolved tree and exit; write nothing
  --registry-url <url>    Verdaccio registry URL (default: env CINATRA_AGENT_REGISTRY_URL)
  --registry-token <tok>  Verdaccio token (default: env CINATRA_AGENT_REGISTRY_TOKEN)

Exit codes:
  0 success | 1 usage error | 2 resolver error | 3 integrity error | 4 config missing
`;

// Lockfile v2 adds `resolvedConnectors` per node (concrete versions for
// `cinatra.connectorDependencies` ranges) and a top-level
// `connectorPackageIds` aggregate. v1 lockfiles are NOT
// schema-compatible: any cache hit on a v1 lockfile forces a full
// re-resolution so the v2 fields land.
const LOCKFILE_VERSION = 2;
// `connectorDependencies` entries are validated against the CLI-safe connector
// catalog (the same descriptors the host registry consumes) instead of a
// hand-maintained copy of the package-id list — the copy had already drifted
// from the catalog, and a literal list re-pins extension instance names in
// core (instance-coupling gate).
const KNOWN_CONNECTOR_PACKAGE_IDS = new Set(
  CONNECTOR_DESCRIPTORS.map((d) => d.packageId),
);
// Any well-formed scoped npm name is accepted in agentDependencies, matching
// Verdaccio's '@cinatra/*-agent' block.
const SCOPED_NAME_PATTERN = /^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/i;
const DEFAULT_REGISTRY_URL = "http://127.0.0.1:4873";

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function redactToken(str, token) {
  if (!token) return String(str);
  return String(str).split(token).join("***");
}

/**
 * Registry-scoped credential entry for pacote option objects.
 *
 * npm-registry-fetch (pacote's HTTP layer) resolves credentials ONLY from
 * nerf-dart-scoped '//<host>/<path>:_authToken' option keys (or forceAuth) —
 * a flat `token` option is silently ignored and produces requests with NO
 * Authorization header (#179). Plain-JS mirror of the canonical TS helper
 * `registryScopedAuthOptions` in @cinatra-ai/registries (this CLI script
 * cannot import the TS source). Returns {} when no token is configured.
 */
function registryScopedAuthOptions(registryUrl, token) {
  if (!token) return {};
  const parsed = new URL(registryUrl);
  const pathname = parsed.pathname.endsWith("/")
    ? parsed.pathname
    : `${parsed.pathname}/`;
  return { [`//${parsed.host}${pathname}:_authToken`]: token };
}

// ---------------------------------------------------------------------------
// Derive inputSchema from cinatra/oas.json when a tarball lacks the canonical
// compiled agent.json.
// ---------------------------------------------------------------------------

/** Safe JSON.parse — returns null on parse failure instead of throwing. */
function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Derive `inputSchema` from the top-level Flow's `StartNode` referenced
 * component in cinatra/oas.json. Returns null when the OAS shape doesn't
 * match expectations — caller falls back to {}.
 *
 * Expected OAS Flow shape:
 *   $referenced_components.<startKey> = {
 *     component_type: "StartNode",
 *     inputs: [{ title, type, format?, default? }, ...],
 *     metadata: { cinatra: { required: ["foo"], hidden: ["bar"] } }
 *   }
 *
 * Maps to JSON Schema:
 *   { type: "object", required: [...], properties: { foo: { type, format } } }
 */
function deriveInputSchemaFromOas(oas) {
  if (!oas || typeof oas !== "object") return null;
  if (oas.component_type !== "Flow") return null;

  // Locate the start node via $referenced_components[start_node.$component_ref].
  const startRef = oas.start_node?.["$component_ref"];
  const refs = oas["$referenced_components"];
  if (!startRef || !refs || typeof refs !== "object") return null;
  const startNode = refs[startRef];
  if (!startNode || startNode.component_type !== "StartNode") return null;

  const inputs = Array.isArray(startNode.inputs) ? startNode.inputs : [];
  const required = Array.isArray(startNode.metadata?.cinatra?.required)
    ? startNode.metadata.cinatra.required.filter((s) => typeof s === "string")
    : [];

  const properties = {};
  for (const input of inputs) {
    if (!input || typeof input.title !== "string") continue;
    const prop = { type: typeof input.type === "string" ? input.type : "string" };
    if (typeof input.format === "string") prop.format = input.format;
    if (typeof input.description === "string") prop.description = input.description;
    properties[input.title] = prop;
  }

  return { type: "object", required, properties };
}

/**
 * Pick the best inputSchema source:
 *   1. agent.template.inputSchema (canonical — `publishAgentPackageFromGitDir`
 *      compiles + writes it via `compileOasAgentJson`).
 *   2. Derived from cinatra/oas.json StartNode metadata (defense-in-depth for
 *      tarballs that lack agent.json.
 *   3. Empty {} as last resort.
 *
 * The "non-empty" detection treats `agent.template.inputSchema` as missing
 * when both `required` and `properties` are empty/absent — same effective
 * gap as having no schema at all.
 */
function pickInputSchema(agent, oas) {
  const compiled = agent?.template?.inputSchema;
  const compiledHasContent =
    compiled &&
    typeof compiled === "object" &&
    ((Array.isArray(compiled.required) && compiled.required.length > 0) ||
      (compiled.properties && Object.keys(compiled.properties).length > 0));
  if (compiledHasContent) return compiled;

  const derived = deriveInputSchemaFromOas(oas);
  if (derived) return derived;

  return compiled && typeof compiled === "object" ? compiled : {};
}

function parseArgv(argv) {
  const flags = { lockfileOnly: false, dryRun: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--lockfile-only") flags.lockfileOnly = true;
    else if (a === "--dry-run") flags.dryRun = true;
    else if (a === "--manifest") flags.manifest = argv[++i];
    else if (a === "--lockfile") flags.lockfile = argv[++i];
    else if (a === "--registry-url") flags.registryUrl = argv[++i];
    else if (a === "--registry-token") flags.registryToken = argv[++i];
    else if (a.startsWith("--")) {
      flags.__error = `Unknown flag: ${a}`;
      break;
    } else {
      rest.push(a);
    }
  }
  if (rest.length > 0) flags.rootSpec = rest[0];
  return flags;
}

function parseSpec(spec) {
  if (!spec || typeof spec !== "string") {
    throw new Error(`Invalid package spec: must be a non-empty string`);
  }
  const at = spec.lastIndexOf("@");
  if (at <= 0) return { name: spec, range: "*" };
  const name = spec.slice(0, at);
  const range = spec.slice(at + 1);
  if (!name) throw new Error(`Invalid package spec: empty name in "${spec}"`);
  if (!range) throw new Error(`Invalid package spec: empty version range after "@" in "${spec}"`);
  return { name, range };
}

// ---------------------------------------------------------------------------
// Verdaccio config (env-only, no DB — safe for plain Node.js)
// ---------------------------------------------------------------------------

function loadVerdaccioConfig(overrides = {}) {
  const registryUrl = (
    overrides.registryUrl ??
    process.env.CINATRA_AGENT_REGISTRY_URL ??
    process.env.VERDACCIO_REGISTRY_URL ??
    DEFAULT_REGISTRY_URL
  ).replace(/\/+$/, "");
  const token = (
    overrides.token ??
    process.env.CINATRA_AGENT_REGISTRY_TOKEN ??
    process.env.VERDACCIO_TOKEN ??
    null
  );
  return { registryUrl, token };
}

// ---------------------------------------------------------------------------
// Dependency resolver using pacote
// ---------------------------------------------------------------------------

/**
 * Resolve a full agent dependency tree using pacote.manifest for each node.
 * pacote handles semver range resolution internally via npm-pick-manifest.
 * Returns { root: ResolvedNode, all: Map<name, ResolvedNode> }.
 */
async function resolveAgentDependencyTree({ rootPackageName, rootRange, registryUrl, token }) {
  const pacoteOpts = {
    registry: registryUrl + "/",
    preferOnline: true,
    fullMetadata: true,
    // Scoped key, NEVER a flat `token` — npm-registry-fetch ignores that (#179).
    ...registryScopedAuthOptions(registryUrl, token),
  };

  const { default: pacote } = await import("pacote");

  const resolved = new Map();
  const queue = [{ name: rootPackageName, range: rootRange, path: [], depth: 0 }];
  const MAX_NODES = 500;
  const MAX_DEPTH = 20;

  while (queue.length > 0) {
    const entry = queue.shift();
    const { name, range, path, depth } = entry;

    if (!SCOPED_NAME_PATTERN.test(name)) {
      throw Object.assign(
        new Error(`agentDependencies entries must be valid scoped npm names; received: ${name}`),
        { code: "ESCOPE" }
      );
    }

    if (path.includes(name)) {
      throw Object.assign(
        new Error(`Dependency cycle detected: ${[...path, name].join(" -> ")}`),
        { code: "ECYCLE", cyclePath: [...path, name] }
      );
    }

    if (depth > MAX_DEPTH) {
      throw Object.assign(
        new Error(`Dependency resolver exceeded depth limit of ${MAX_DEPTH}`),
        { code: "ELIMIT" }
      );
    }

    if (resolved.has(name)) {
      // Already resolved — verify the already-pinned version satisfies the incoming range.
      const existing = resolved.get(name);
      const { default: semver } = await import("semver");
      if (!semver.satisfies(existing.resolvedVersion, range)) {
        throw Object.assign(
          new Error(
            `Incompatible versions required for ${name}: already pinned at ${existing.resolvedVersion}, range ${range} not satisfied`
          ),
          { code: "ECONFLICT", packageName: name }
        );
      }
      continue;
    }

    if (resolved.size >= MAX_NODES) {
      throw Object.assign(
        new Error(`Dependency resolver exceeded nodes limit of ${MAX_NODES}`),
        { code: "ELIMIT" }
      );
    }

    let m;
    try {
      m = await pacote.manifest(`${name}@${range}`, pacoteOpts);
    } catch (err) {
      const code = err?.code ?? "";
      if (code === "E404" || code === "ETARGET") {
        throw Object.assign(
          new Error(`No version satisfying ${name}@${range}`),
          { code: "ENORESOLUTION", packageName: name, range }
        );
      }
      throw err;
    }

    const childDeps = m.cinatra?.agentDependencies ?? {};
    // connectorDependencies are declarative-only: validated here against the
    // known connector catalog but NEVER enqueued for tree walking. Connectors
    // are workspace-compiled and never runtime-installed from npm. Unknown
    // package ids fail fast.
    const childConnectorDeps = m.cinatra?.connectorDependencies ?? {};
    for (const connectorId of Object.keys(childConnectorDeps)) {
      if (!KNOWN_CONNECTOR_PACKAGE_IDS.has(connectorId)) {
        throw Object.assign(
          new Error(
            `${name} declares connectorDependencies entry ${connectorId} which is not in the connector catalog`,
          ),
          { code: "EUNKNOWNCONNECTOR", packageName: name, connectorId },
        );
      }
    }

    resolved.set(name, {
      packageName: name,
      resolvedVersion: m.version,
      tarballUrl: m.dist?.tarball ?? "",
      integrity: m.dist?.integrity ?? "",
      requestedRange: range,
      dependencies: { ...childDeps },
      connectorDependencies: { ...childConnectorDeps },
    });

    const nextPath = [...path, name];
    for (const [depName, depRange] of Object.entries(childDeps)) {
      queue.push({ name: depName, range: depRange, path: nextPath, depth: depth + 1 });
    }
  }

  const root = resolved.get(rootPackageName);
  if (!root) {
    throw Object.assign(
      new Error(`Root package ${rootPackageName} was not resolved`),
      { code: "ENORESOLUTION" }
    );
  }

  return { root, all: resolved };
}

// ---------------------------------------------------------------------------
// Lockfile
// ---------------------------------------------------------------------------

function lockfileFromTree(tree) {
  const packages = {};
  const connectorPackageIds = new Set();
  for (const [name, node] of tree.all) {
    const entry = {
      version: node.resolvedVersion,
      resolved: node.tarballUrl,
      integrity: node.integrity,
    };
    if (node.dependencies && Object.keys(node.dependencies).length > 0) {
      entry.dependencies = { ...node.dependencies };
    }
    if (
      node.connectorDependencies &&
      Object.keys(node.connectorDependencies).length > 0
    ) {
      entry.connectorDependencies = { ...node.connectorDependencies };
      for (const id of Object.keys(node.connectorDependencies)) {
        connectorPackageIds.add(id);
      }
    }
    packages[name] = entry;
  }
  return {
    lockfileVersion: LOCKFILE_VERSION,
    root: { packageName: tree.root.packageName, version: tree.root.resolvedVersion },
    packages,
    // Set of all connector packageIds the resolved tree touches, deduplicated
    // for quick preflight readiness scans.
    connectorPackageIds: [...connectorPackageIds].sort(),
  };
}

function stableStringifyLockfile(lockfile) {
  // Stable JSON: sort keys in packages object for byte-deterministic output.
  const sortedPackages = {};
  for (const key of Object.keys(lockfile.packages).sort()) {
    sortedPackages[key] = lockfile.packages[key];
  }
  return JSON.stringify({ ...lockfile, packages: sortedPackages }, null, 2) + "\n";
}

async function readLockfile(lockfilePath) {
  try {
    const raw = await readFile(lockfilePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeLockfile(lockfilePath, lockfile) {
  await writeFile(lockfilePath, stableStringifyLockfile(lockfile), "utf8");
}

function lockfileToTree(lockfile) {
  const all = new Map();
  for (const [name, entry] of Object.entries(lockfile.packages)) {
    all.set(name, {
      packageName: name,
      resolvedVersion: entry.version,
      tarballUrl: entry.resolved,
      integrity: entry.integrity,
      requestedRange: entry.version,
      dependencies: entry.dependencies ?? {},
      connectorDependencies: entry.connectorDependencies ?? {},
    });
  }
  const root = all.get(lockfile.root.packageName);
  return { root, all };
}

// ---------------------------------------------------------------------------
// Install tree traversal (leaf-first BFS)
// ---------------------------------------------------------------------------

async function installResolvedTree({ tree, install }) {
  // Build a dependency-ordered list: leaves first, root last.
  const visited = new Set();
  const ordered = [];

  function visit(name) {
    if (visited.has(name)) return;
    visited.add(name);
    const node = tree.all.get(name);
    if (node) {
      for (const depName of Object.keys(node.dependencies)) {
        visit(depName);
      }
      ordered.push(node);
    }
  }

  visit(tree.root.packageName);
  for (const node of ordered) {
    await install(node);
  }
}

// ---------------------------------------------------------------------------
// Install single agent package — extract tarball + write to DB
// ---------------------------------------------------------------------------

/**
 * Extract a package from Verdaccio and upsert agent_template + agent_version rows.
 * Uses pg directly (no Drizzle) so it works in plain Node.js.
 */
async function installAgentFromPackage({ packageName, packageVersion, registryUrl, token }) {
  const { default: pacote } = await import("pacote");
  const { default: pg } = await import("pg");

  const dbUrl = process.env.SUPABASE_DB_URL;
  if (!dbUrl) {
    throw new Error(
      "SUPABASE_DB_URL is required for the full install step. " +
      "Use --dry-run or --lockfile-only to skip DB writes."
    );
  }

  const pacoteOpts = {
    registry: registryUrl + "/",
    preferOnline: true,
    // Scoped key, NEVER a flat `token` — npm-registry-fetch ignores that (#179).
    ...registryScopedAuthOptions(registryUrl, token),
  };

  const spec = packageVersion ? `${packageName}@${packageVersion}` : packageName;
  const tempDir = await mkdtemp(tmpdir() + "/cinatra-agent-install-");

  try {
    await pacote.extract(spec, tempDir, pacoteOpts);

    const [pkgRaw, agentRaw, oasRaw] = await Promise.all([
      readFile(tempDir + "/package.json", "utf8"),
      readFile(tempDir + "/agent.json", "utf8").catch(() => null),
      // Defense-in-depth. When agent.json is missing from the tarball, we fall
      // back to deriving inputSchema directly from cinatra/oas.json. Without
      // this, `inputSchema = {}` prevents the setup-loop fallback from
      // surfacing required inputs.
      readFile(tempDir + "/cinatra/oas.json", "utf8").catch(() => null),
    ]);

    const pkg = JSON.parse(pkgRaw);
    const agent = agentRaw ? JSON.parse(agentRaw) : null;
    const oas = oasRaw ? safeJsonParse(oasRaw) : null;

    const cinatraMeta = pkg.cinatra ?? {};
    const agentDeps = cinatraMeta.agentDependencies ?? {};
    const agentType = cinatraMeta.type ?? "leaf";
    const executionMode = agent?.template?.executionMode ?? cinatraMeta.executionMode ?? "agentic";
    const templateName = agent?.title?.trim() || agent?.template?.name || pkg.name;
    const description = agent?.description ?? agent?.template?.description ?? null;
    const sourceNl = agent?.template?.sourceNl ?? "";
    const compiledPlan = agent?.template?.compiledPlan ?? [];
    // When agent.json supplies a non-empty inputSchema, use it. Otherwise
    // derive from cinatra/oas.json's StartNode metadata so setup-loop fallback
    // knows which inputs are required.
    const inputSchema = pickInputSchema(agent, oas);
    const outputSchema = agent?.template?.outputSchema ?? null;
    const approvalPolicy = agent?.template?.approvalPolicy ?? { steps: [] };
    const taskSpec = agent?.template?.taskSpec ?? null;
    const lgGraphCode = agent?.template?.lgGraphCode ?? null;
    const lgGraphId = agent?.template?.lgGraphId ?? null;
    const executionProvider = agent?.template?.executionProvider ?? cinatraMeta.executionProvider ?? "default";
    const snapshot = agent?.version?.snapshot ?? {};
    const sourceVersionId = agent?.version?.sourceVersionId ?? cinatraMeta.sourceVersionId ?? null;
    const sourceVersionNumber = agent?.version?.sourceVersionNumber ?? cinatraMeta.sourceVersionNumber ?? 1;

    const schema = process.env.SUPABASE_SCHEMA ?? "cinatra";
    const client = new pg.Client({ connectionString: dbUrl });
    await client.connect();

    try {
      // Check for existing template by packageName
      const existingResult = await client.query(
        `SELECT id FROM ${schema}.agent_templates WHERE package_name = $1 LIMIT 1`,
        [packageName]
      );

      let templateId;
      const versionId = randomUUID();

      if (existingResult.rows.length > 0) {
        // Update existing template
        templateId = existingResult.rows[0].id;
        await client.query(
          `UPDATE ${schema}.agent_templates SET
            name = $2, description = $3, source_nl = $4, compiled_plan = $5,
            input_schema = $6, output_schema = $7, approval_policy = $8,
            type = $9, task_spec = $10,
            package_version = $11, agent_dependencies = $12,
            lg_graph_code = $13, lg_graph_id = $14, execution_provider = $15,
            updated_at = NOW()
          WHERE id = $1`,
          [
            templateId,
            templateName,
            description,
            sourceNl,
            JSON.stringify(compiledPlan),
            JSON.stringify(inputSchema),
            outputSchema ? JSON.stringify(outputSchema) : null,
            JSON.stringify(approvalPolicy),
            agentType,
            taskSpec,
            pkg.version,
            Object.keys(agentDeps).length > 0 ? JSON.stringify(agentDeps) : null,
            lgGraphCode,
            lgGraphId,
            executionProvider,
          ]
        );
      } else {
        // Insert new template
        templateId = randomUUID();
        await client.query(
          `INSERT INTO ${schema}.agent_templates (
            id, name, description, source_nl, compiled_plan, input_schema,
            output_schema, approval_policy, type, task_spec,
            package_name, package_version, agent_dependencies,
            lg_graph_code, lg_graph_id, execution_provider,
            hitl_required, status, created_at, updated_at
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
            false, 'draft', NOW(), NOW()
          )`,
          [
            templateId,
            templateName,
            description,
            sourceNl,
            JSON.stringify(compiledPlan),
            JSON.stringify(inputSchema),
            outputSchema ? JSON.stringify(outputSchema) : null,
            JSON.stringify(approvalPolicy),
            agentType,
            taskSpec,
            packageName,
            pkg.version,
            Object.keys(agentDeps).length > 0 ? JSON.stringify(agentDeps) : null,
            lgGraphCode,
            lgGraphId,
            executionProvider,
          ]
        );
      }

      // Insert version row
      const contentHash = createHash("sha256")
        .update(JSON.stringify(snapshot))
        .digest("hex");

      // Determine next version number
      const versionNumResult = await client.query(
        `SELECT COALESCE(MAX(version_number), 0) + 1 AS next_num
         FROM ${schema}.agent_versions WHERE template_id = $1`,
        [templateId]
      );
      const versionNumber = versionNumResult.rows[0].next_num;

      await client.query(
        `INSERT INTO ${schema}.agent_versions (
          id, template_id, version_number, content_hash, snapshot, created_at
        ) VALUES ($1, $2, $3, $4, $5, NOW())`,
        [versionId, templateId, versionNumber, contentHash, JSON.stringify(snapshot)]
      );

      return { templateId, versionId, packageName, packageVersion: pkg.version, agentDependencies: agentDeps };
    } finally {
      await client.end();
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------------

export async function runAgentsInstall(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const exit = io.exit ?? ((c) => process.exit(c));

  const flags = parseArgv(argv);
  if (flags.__error) {
    stderr.write(flags.__error + "\n" + USAGE);
    return exit(1);
  }
  if (!flags.rootSpec && !flags.manifest) {
    stderr.write(USAGE);
    return exit(1);
  }

  let rootName;
  let rootRange;
  try {
    if (flags.rootSpec) {
      ({ name: rootName, range: rootRange } = parseSpec(flags.rootSpec));
    } else {
      const manifestRaw = await readFile(resolvePath(flags.manifest), "utf8");
      const manifest = JSON.parse(manifestRaw);
      rootName = manifest.name;
      rootRange = manifest.version ?? "*";
    }
  } catch (err) {
    stderr.write(`Usage error: ${err.message}\n${USAGE}`);
    return exit(1);
  }

  // Verdaccio config precedence: flags → env → defaults
  const cfg = loadVerdaccioConfig({
    registryUrl: flags.registryUrl,
    token: flags.registryToken,
  });
  const effectiveRegistry = cfg.registryUrl;
  const effectiveToken = cfg.token;

  const lockfilePath = resolvePath(flags.lockfile ?? "./cinatra-agents.lock");

  // Lockfile fast-path: reuse only when lockfile pins the requested root at a version
  // that satisfies the requested range AND the lockfile version matches the current
  // LOCKFILE_VERSION. Otherwise re-resolve to pick up upgrades or v1→v2 schema fills.
  const existingLockfile = await readLockfile(lockfilePath);
  const { default: semver } = await import("semver");
  let tree;
  if (
    existingLockfile &&
    existingLockfile.lockfileVersion === LOCKFILE_VERSION &&
    existingLockfile.root.packageName === rootName &&
    semver.satisfies(existingLockfile.root.version, rootRange)
  ) {
    tree = lockfileToTree(existingLockfile);
  } else {
    try {
      tree = await resolveAgentDependencyTree({
        rootPackageName: rootName,
        rootRange: rootRange,
        registryUrl: effectiveRegistry,
        token: effectiveToken,
      });
    } catch (err) {
      const msg = redactToken(err?.message ?? String(err), effectiveToken);
      stderr.write(`Resolver error: ${msg}\n`);
      if (err?.cyclePath) stderr.write(`Cycle: ${err.cyclePath.join(" -> ")}\n`);
      return exit(2);
    }
  }

  if (flags.dryRun) {
    stdout.write(
      JSON.stringify({ root: tree.root, nodes: [...tree.all.keys()] }, null, 2) + "\n"
    );
    return exit(0);
  }

  // Write lockfile
  const lockfile = lockfileFromTree(tree);
  await writeLockfile(lockfilePath, lockfile);

  if (flags.lockfileOnly) return exit(0);

  // Install side-effects — upsert agent_templates + agent_versions rows in DB
  const install = async (node) => {
    await installAgentFromPackage({
      packageName: node.packageName,
      packageVersion: node.resolvedVersion,
      registryUrl: effectiveRegistry,
      token: effectiveToken,
    });
  };

  try {
    await installResolvedTree({ tree, install });
  } catch (err) {
    const msg = redactToken(err?.message ?? String(err), effectiveToken);
    stderr.write(`Install error: ${msg}\n`);
    if (err?.code === "EINTEGRITY") {
      stderr.write(`Integrity mismatch: tarball sha512 does not match lockfile\n`);
      return exit(3);
    }
    return exit(1);
  }

  stdout.write(`Installed ${tree.all.size} agents from ${rootName}@${rootRange}\n`);
  return exit(0);
}

export const __test = {
  parseArgv,
  parseSpec,
  redactToken,
  // Exported so the #179 regression (flat pacote `token` option, ignored by
  // npm-registry-fetch) stays pinned at the CLI layer too.
  registryScopedAuthOptions,
  lockfileToTree,
  lockfileFromTree,
  stableStringifyLockfile,
  // Exported for unit test coverage of the inputSchema derivation fallback.
  deriveInputSchemaFromOas,
  pickInputSchema,
  safeJsonParse,
};
