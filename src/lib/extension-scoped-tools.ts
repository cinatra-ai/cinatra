import "server-only";

// THE PASSTHROUGH'S EXTENSION-SCOPED TOOLS (cinatra#3031, epic #3023 W7; plan
// (C) enablers 0.25/0.26, technical note 8.4).
//
// "The passthrough allowlist grows by these names, each scoped: … the
// extension-data tool to the calling extension's declared tables; the artifact
// reads (list, get, content) to the calling extension's declared artifact
// dependencies."
//
// EACH SCOPE IS DERIVED FROM THE RUN, NEVER FROM THE REQUEST. The route has
// already bound the body's `agent_run_id` to the run actually executing the
// callback (`bindBridgeRunId`), so the run row is trustworthy; this module
// reads the run's template package and its PINNED version from there and
// resolves the manifest at that version. A request that names a package, a
// table outside the declaration, or a type outside the declared dependencies is
// refused with a stated reason — never widened.
//
// §8.7: "Every new admission on the passthrough is by name and by scope, never
// by wildcard, and audited with the calling extension." The audit is written by
// the tools themselves, so it cannot be skipped by a caller reaching them
// another way.

import type { ActorContext } from "@/lib/authz/actor-context";
import { getPooledDb } from "@/lib/db/pooled";
import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { resolveRunExtensionContext } from "@/lib/extension-run-package";
import {
  ExtensionDataRefusal,
  runExtensionDataOperation,
  type ExtensionDataRequest,
} from "@/lib/extension-data-tool";
import { parseDeclaredTables } from "@cinatra-ai/sdk-extensions/manifest";
import {
  ArtifactAdmissionRefusal,
  resolveArtifactDependencyAdmission,
} from "@/lib/artifacts/extension-artifact-admission";
import {
  ArtifactContentRefusal,
  extensionArtifactContentRead,
  extensionArtifactGet,
  extensionArtifactsList,
} from "@/lib/artifacts/extension-artifact-reads";
import { ArtifactCursorRefusal } from "@/lib/artifacts/artifact-service";
import type { StoredIdeasPorts } from "@/lib/stored-ideas-gate-runner";

/** The three dependency-scoped artifact reads, each scoped to the types the
 *  calling extension declares as artifact dependencies. */
const ARTIFACT_READ_TOOLS = new Set<string>([
  "artifacts_list",
  "artifacts_get",
  "artifact_content_read",
]);

/** The names W7 adds to the passthrough allowlist, each scoped below. These are
 *  the HOST's own names, and the list carries no pack's: a pack whose flow needs
 *  a passthrough call of its own is admitted by ITS OWN DECLARATION at the
 *  pinned version (the reader at the foot of this module), dispatched
 *  below, so no pack's tool name is written in core. */
export const EXTENSION_SCOPED_TOOLS = new Set<string>([
  "extension_data",
  ...ARTIFACT_READ_TOOLS,
]);

export type ExtensionScopedToolRun = {
  id: string;
  orgId: string;
  runBy: string | null;
  templateId: string;
  packageVersion: string | null;
};

export type ExtensionScopedToolOutcome =
  | { ok: true; result: unknown }
  | { ok: false; status: number; error: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Dispatch one extension-scoped tool under the run's own identity. Never
 * throws: every refusal is a stated status the calling node fails visibly on.
 */
export async function dispatchExtensionScopedTool(input: {
  tool: string;
  input: Record<string, unknown>;
  run: ExtensionScopedToolRun;
  actor?: ActorContext;
}): Promise<ExtensionScopedToolOutcome> {
  const context = await resolveRunExtensionContext({
    templateId: input.run.templateId,
    packageVersion: input.run.packageVersion,
  });
  if (!context) {
    return {
      ok: false,
      status: 403,
      error:
        `${input.tool}: the run resolves to no extension package at a pinned version, so there is ` +
        `no one declaration to admit this call under`,
    };
  }

  try {
    if (input.tool === "extension_data") {
      return { ok: true, result: await runDataTool(context, input) };
    }
    if (ARTIFACT_READ_TOOLS.has(input.tool)) {
      return { ok: true, result: await runArtifactRead(context, input) };
    }
    // NOT ONE OF THE HOST'S OWN NAMES — so the CALLING extension's own
    // declaration has to name it. The admission reads the pack the run is bound
    // to at the version it is pinned to, and admits the name only when a node of
    // that declaration calls this route with it; the SCOPE is unchanged, since
    // every read and write the call makes still goes through the scoped tools
    // above. An unresolved, unreadable or silent declaration admits nothing.
    // The reader lives at the foot of THIS module rather than beside it: the
    // routes that reach this dispatch are ratcheted on their reachable
    // first-party graph, and a module of its own would join every one of them.
    if (!(await declaresPassthroughTool(context.packageName, input.tool))) {
      return {
        ok: false,
        status: 403,
        error:
          `${input.tool}: the calling extension's own declaration at the version this run is ` +
          `pinned to names no node that calls this tool, so there is no admission for it`,
      };
    }
    return { ok: true, result: await runStoredIdeasGate(context, input) };
  } catch (e) {
    if (
      e instanceof ExtensionDataRefusal ||
      e instanceof ArtifactAdmissionRefusal ||
      e instanceof ArtifactCursorRefusal
    ) {
      return { ok: false, status: 403, error: e.message };
    }
    if (e instanceof ArtifactContentRefusal) {
      return { ok: false, status: e.reason === "not-found" ? 404 : 403, error: e.message };
    }
    return { ok: false, status: 500, error: e instanceof Error ? e.message : String(e) };
  }
}

async function runDataTool(
  context: Awaited<ReturnType<typeof resolveRunExtensionContext>> & object,
  input: { input: Record<string, unknown>; run: ExtensionScopedToolRun },
): Promise<unknown> {
  const tables = parseDeclaredTables(context.cinatra.declaredTables, context.packageName);
  if (tables.length === 0) {
    throw new ExtensionDataRefusal(
      "declares-no-tables",
      `extension_data: ${context.packageName} declares no tables — the tool operates only on the ` +
        `calling extension's declared tables`,
    );
  }
  const request = input.input as unknown as ExtensionDataRequest;
  if (!isPlainObject(input.input) || typeof request.table !== "string") {
    throw new ExtensionDataRefusal(
      "invalid-request",
      "extension_data: `table` and `operation` are required",
    );
  }
  const pool = getPooledDb({
    name: "extension-data-tool",
    connectionString: () => getPostgresConnectionString(),
  });
  const client = await pool.connect();
  try {
    return await runExtensionDataOperation({
      client: client as never,
      schemaName: postgresSchema,
      packageName: context.packageName,
      tables,
      orgId: input.run.orgId,
      runId: input.run.id,
      actorPrincipalId: input.run.runBy,
      request,
    });
  } finally {
    client.release();
  }
}

async function runArtifactRead(
  context: Awaited<ReturnType<typeof resolveRunExtensionContext>> & object,
  input: { tool: string; input: Record<string, unknown>; run: ExtensionScopedToolRun; actor?: ActorContext },
): Promise<unknown> {
  const admission = resolveArtifactDependencyAdmission({
    packageName: context.packageName,
    packageVersion: context.packageVersion,
    cinatra: context.cinatra,
  });
  const ctx = {
    admission,
    orgId: input.run.orgId,
    runId: input.run.id,
    ...(input.actor ? { actor: input.actor } : {}),
    actorPrincipalId: input.run.runBy,
  };
  const raw = input.input;
  if (input.tool === "artifacts_list") {
    return extensionArtifactsList(ctx, {
      ...(Array.isArray(raw.types) ? { types: raw.types as string[] } : {}),
      ...(typeof raw.cursor === "string" ? { cursor: raw.cursor } : {}),
      ...(typeof raw.limit === "number" ? { limit: raw.limit } : {}),
    });
  }
  const artifactId = typeof raw.artifactId === "string" ? raw.artifactId : "";
  if (!artifactId) {
    throw new ArtifactContentRefusal("invalid-request", `${input.tool}: \`artifactId\` is required`);
  }
  if (input.tool === "artifacts_get") {
    return { artifact: await extensionArtifactGet(ctx, { artifactId }) };
  }
  return extensionArtifactContentRead(ctx, {
    artifactId,
    ...(typeof raw.representationRevisionId === "string"
      ? { representationRevisionId: raw.representationRevisionId }
      : {}),
    ...(typeof raw.maxBytes === "number" ? { maxBytes: raw.maxBytes } : {}),
  });
}


// ---------------------------------------------------------------------------
// THE BLOG PIPELINE'S STORED-IDEAS GATE (cinatra#3035, epic #3023 W11).
//
// The gate's decisions live in `@/lib/stored-ideas-gate`; its reads and
// writes are ports. This binds those ports to the W7 tools above — the
// dependency-scoped listing and content read, and the extension-data tool on the
// pipeline's own declared table — so the gate widens NOTHING: every call it makes
// is admitted by the same declaration, refused by the same refusals, and audited
// with the same calling extension.
// ---------------------------------------------------------------------------

/**
 * THE CALLING EXTENSION NAMES THE TYPE, NEVER THIS FILE. Core code may not
 * hard-code an extension instance (the core-to-extension instance-coupling ban),
 * and it does not need to: the type an idea is filed under is the caller's own
 * declared dependency, so the flow node passes it and the admission above refuses
 * anything the extension has not declared. A call that names no type is refused
 * rather than widened to every type the extension may read — the offer would then
 * be a list of posts and pictures.
 */
function requireIdeaType(tool: string, raw: Record<string, unknown>): string {
  const ideaType = typeof raw.ideaType === "string" ? raw.ideaType.trim() : "";
  if (ideaType.length === 0) {
    throw new ExtensionDataRefusal(
      "invalid-request",
      `${tool}: \`ideaType\` is required — the calling extension names the artifact type ` +
        "its ideas are filed under, and it must be one of its own declared dependencies",
    );
  }
  return ideaType;
}

async function runStoredIdeasGate(
  context: Awaited<ReturnType<typeof resolveRunExtensionContext>> & object,
  input: { tool: string; input: Record<string, unknown>; run: ExtensionScopedToolRun; actor?: ActorContext },
): Promise<unknown> {
  const {
    completeIdeaRelation,
    prepareStoredIdeas,
    releaseIdeaReservation,
    reserveStoredIdea,
  } = await import("@/lib/stored-ideas-gate-runner");
  const { IDEA_RELATION_TABLE_DECLARED, ideaRelationTableFor, parseOfferedIdeas, resolveIdeaPick } =
    await import("@/lib/stored-ideas-gate");
  // THE TABLE IS THE CALLER'S OWN, NAMED THROUGH ITS DECLARATION. The operation
  // below takes the declaration-local name — `runDataTool` refuses it unless the
  // calling extension declares it — and the physical name a refusal mentions is
  // derived from that same declaring package, never spelled in core.
  const relationTable = ideaRelationTableFor(context.packageName);

  const ideaType = requireIdeaType(input.tool, input.input);
  const listPage = (cursor?: string) =>
    runArtifactRead(context, {
      ...input,
      tool: "artifacts_list",
      input: {
        types: [ideaType],
        limit: 100,
        ...(cursor ? { cursor } : {}),
      },
    }) as Promise<{ artifacts: Array<{ artifactId: string; latestRepresentationRevisionId: string | null }>; nextCursor: string | null }>;

  const data = (request: Record<string, unknown>) =>
    runDataTool(context, {
      ...input,
      input: { ...request, table: IDEA_RELATION_TABLE_DECLARED },
    });

  const ports: StoredIdeasPorts = {
    async listIdeaArtifacts() {
      const references: Array<{ artifactId: string; representationRevisionId: string }> = [];
      let cursor: string | undefined;
      // Paged rather than one page: "one listing page per hundred ideas" (plan
      // (C) §8.9). The walk stops at the runner's own cap on offered ideas.
      for (let page = 0; page < 10; page += 1) {
        const result = await listPage(cursor);
        for (const artifact of result.artifacts ?? []) {
          if (typeof artifact.latestRepresentationRevisionId !== "string") continue;
          references.push({
            artifactId: artifact.artifactId,
            representationRevisionId: artifact.latestRepresentationRevisionId,
          });
        }
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }
      return references;
    },
    async readIdeaText(artifactId) {
      const read = (await runArtifactRead(context, {
        ...input,
        tool: "artifact_content_read",
        input: { artifactId },
      })) as { text?: unknown };
      return typeof read.text === "string" ? read.text : null;
    },
    async listRelationRows() {
      const rows = (await data({ operation: "select" })) as
        | { rows?: Array<Record<string, unknown>> }
        | Array<Record<string, unknown>>;
      if (Array.isArray(rows)) return rows;
      return rows?.rows ?? [];
    },
    async insertRelationRow(row) {
      try {
        await data({ operation: "insert", values: row });
        return { ok: true };
      } catch (e) {
        // The table's one-live-row-per-idea index is the race's only arbiter, so
        // a unique violation is the LOSING PICK and nothing else: it is reported
        // as a conflict, and every other failure as a plain write failure.
        return { ok: false, conflict: isUniqueViolation(e) };
      }
    },
    async updateRelationRow(keys, patch) {
      try {
        await data({ operation: "update", where: { ...keys }, values: patch });
        return { ok: true };
      } catch {
        return { ok: false, conflict: false };
      }
    },
  };

  const raw = input.input;
  const op = typeof raw.op === "string" ? raw.op : "";
  if (op === "prepare") {
    const offer = await prepareStoredIdeas({
      ports,
      orgId: input.run.orgId,
      runId: input.run.id,
    });
    // The gate renderer reads `ideas`; a refusal carries the sentence the run
    // ends with, and no ideas at all, so nothing can be picked from it.
    return offer.ok
      ? { ok: true, ideas: offer.ideas }
      : { ok: false, ideas: [], reason: offer.reason };
  }
  if (op === "reserve") {
    // The flow sends the offer as `{{ ideas | tojson }}` — JSON TEXT, exactly like
    // the pick beside it — so both halves of the reservation are read back by the
    // gate's own parsers rather than an array test that an encoded list fails.
    const offered = parseOfferedIdeas(raw.offered);
    const picked = resolveIdeaPick({ pick: raw.pick, offered });
    if (!picked.ok) return { ok: false, reason: picked.reason };
    const taken = await reserveStoredIdea({
      ports,
      orgId: input.run.orgId,
      runId: input.run.id,
      idea: picked.idea,
      relationTable,
    });
    return taken.ok
      ? {
          ok: true,
          ideaArtifactId: picked.idea.artifactId,
          ideaRevisionId: picked.idea.representationRevisionId,
          ideaTitle: picked.idea.title,
          idea: picked.idea.text,
        }
      : { ok: false, reason: taken.reason };
  }
  if (op === "complete") {
    return completeIdeaRelation({
      ports,
      orgId: input.run.orgId,
      runId: input.run.id,
      ideaArtifactId: String(raw.ideaArtifactId ?? ""),
      draftArtifactId: String(raw.draftArtifactId ?? ""),
      relationTable,
    });
  }
  if (op === "release") {
    return releaseIdeaReservation({
      ports,
      runId: input.run.id,
      ideaArtifactId: String(raw.ideaArtifactId ?? ""),
    });
  }
  throw new ExtensionDataRefusal(
    "invalid-request",
    `${input.tool}: \`op\` must be one of prepare, reserve, complete, release (got ${JSON.stringify(op)})`,
  );
}

/** Postgres' unique-violation SQLSTATE, however the driver wraps it. */
function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "23505") return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /duplicate key value|unique constraint/i.test(message);
}

// ---------------------------------------------------------------------------
// THE PASSTHROUGH ADMISSION A PACK'S OWN DECLARATION GIVES (cinatra#3035, epic
// #3023 W11; plan (C) 0.25/0.26, §8.7).
//
// The scoped tools above are the HOST'S own names. A pack whose flow needs a
// passthrough call of its own does NOT get its name written into core: the
// admission reads the CALLING pack's own declaration — the pinned
// `cinatra/oas.json` the runtime mount holds for it — and admits a tool name
// only when a node of that declaration calls this route with it.
//
// WHY THE DECLARATION AND NOT A LIST. A literal in core makes the host know one
// pack (the core/extension border: a pack's table, type id, name or flow does not
// live in the host). The declaration is the pack's own statement of what it calls,
// it is already the thing the install pinned, and it is the very declaration the
// agent runtime executes the flow from: the mount is package-keyed
// (`<mount>/<vendor>/<slug>/cinatra/oas.json`), so this reads the INSTALLED
// declaration, not a per-version copy of it. That is what makes the admission
// bounded rather than version-bound: a republish that replaces the installed
// tree changes the flow the runtime runs and what this admits TOGETHER, so the
// admission can never name more than the flow actually being executed. The
// version the run is PINNED to still bounds every scope such a call reaches —
// `resolveRunExtensionContext` resolves the manifest at that version, and the
// declared tables and artifact dependencies the scoped tools admit come from
// there, not from the mount.
//
// WHY IT IS STILL NOT A WIDENING. The name is admitted; the SCOPE is unchanged.
// Every read and write such a call makes goes through the same scoped tools —
// the dependency-scoped artifact reads and the extension-data tool on the
// caller's own declared tables — so a pack that names a call it has no
// declaration for is refused by those tools exactly as before. And the caller is
// derived from the RUN, never from the request (`resolveRunExtensionContext`),
// so a bridge-token holder cannot name someone else's pack to borrow its
// declaration.
//
// WHY IT SITS IN THIS FILE. The routes that reach the dispatch above are
// ratcheted on their reachable first-party graph and that graph may only shrink;
// a reader in a module of its own joins every one of those graphs, so the reader
// is a plain function here instead.
//
// FAIL-CLOSED throughout: no installed declaration, an unreadable or malformed
// one, or a declaration that names no such call, all admit nothing.
// ---------------------------------------------------------------------------

/** The host route a declared node must call for its tool to be admitted. A node
 *  that calls somewhere else declares nothing about this route. */
export const PASSTHROUGH_ROUTE_PATH = "/api/agents/passthrough";

export type DeclaredPassthroughDeps = {
  /** Where the CALLING pack's pinned declaration is on disk, or null when the
   *  package has none installed. Injected only by tests; the road is the shared
   *  multi-vendor resolver for the runtime mount. */
  readonly oasPathFor?: (packageName: string) => string | null;
  /** Reads one declaration file. Injected only by tests. */
  readonly readOasFile?: (oasPath: string) => Promise<string>;
};

async function resolveOasPath(
  packageName: string,
  deps: DeclaredPassthroughDeps,
): Promise<string | null> {
  if (deps.oasPathFor) return deps.oasPathFor(packageName);
  const { probeInstalledOasPathForRead } = await import(
    "@cinatra-ai/agents/installed-oas-path"
  );
  return probeInstalledOasPathForRead(packageName).path;
}

async function readOas(
  oasPath: string,
  deps: DeclaredPassthroughDeps,
): Promise<unknown | null> {
  try {
    const text = deps.readOasFile
      ? await deps.readOasFile(oasPath)
      : await (await import("node:fs/promises")).readFile(oasPath, "utf8");
    return JSON.parse(text) as unknown;
  } catch {
    // An absent or malformed declaration declares nothing.
    return null;
  }
}

/** The path on THIS host a declared url calls, or null when it calls none.
 *  A declaration reaches its own host either relatively (`/api/...`) or behind
 *  the base-url template the runtime substitutes (`{{BASE}}/api/...`); anything
 *  else — an absolute url on somebody else's origin — names no path here. The
 *  query and the fragment are dropped, so a url that merely MENTIONS a host
 *  path in a query parameter resolves to the path it actually calls, and a
 *  longer path resolves to that longer path: both then fail the exact
 *  comparison below (convergence round — a substring test admitted
 *  `.../passthrough-extra` and `?next=/api/agents/passthrough`). */
function declaredHostPathOf(url: string): string | null {
  const match = /^(\{\{[^{}]*\}\})?(\/[^?#]*)/.exec(url.trim());
  if (!match) return null;
  const path = match[2];
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/** The tool one node calls on the passthrough, or null when it calls no
 *  passthrough tool: an ApiNode whose url is EXACTLY this host's passthrough
 *  path and whose request body names a tool. */
function passthroughToolOf(node: Record<string, unknown>): string | null {
  if (node.component_type !== "ApiNode") return null;
  const url = node.url;
  if (typeof url !== "string") return null;
  if (declaredHostPathOf(url) !== PASSTHROUGH_ROUTE_PATH) return null;
  const data = node.data;
  if (!isPlainObject(data)) return null;
  const tool = data.tool;
  return typeof tool === "string" && tool.trim() !== "" ? tool.trim() : null;
}

/** The keys a declaration carries its NODES under: a flow's own node map and
 *  the components a flow or a component references (the installed declarations
 *  carry every one of their api nodes under the latter, nested to any depth).
 *  Traversal follows ONLY these, never a node's request data, its metadata or a
 *  schema example — so an ApiNode-SHAPED object sitting in a payload declares
 *  nothing, and only a node the declaration actually runs can admit a name
 *  (convergence round: a walk over every object value admitted a `data.example`
 *  that carried the three matching fields). */
const DECLARATION_NODE_CONTAINERS = ["nodes", "$referenced_components"] as const;

/** Every passthrough tool the declaration's own nodes call — the flow's nodes,
 *  its referenced components and any nesting either of them brings, because a
 *  flow may declare its calls at any depth and the admission is about the
 *  declaration as a whole. */
function toolsInDeclaration(doc: unknown): Set<string> {
  const tools = new Set<string>();
  const seen = new Set<unknown>();
  /** One node container (a map of nodes, or a list of such maps/nodes): every
   *  node it holds, and the containers those nodes bring in turn. */
  const walkContainer = (container: unknown, depth: number): void => {
    if (depth > 40 || container === null || typeof container !== "object") return;
    if (seen.has(container)) return;
    seen.add(container);
    const entries = Array.isArray(container)
      ? container
      : Object.values(container as Record<string, unknown>);
    for (const entry of entries) {
      if (Array.isArray(entry)) {
        walkContainer(entry, depth + 1);
        continue;
      }
      if (!isPlainObject(entry) || seen.has(entry)) continue;
      seen.add(entry);
      const tool = passthroughToolOf(entry);
      if (tool !== null) tools.add(tool);
      for (const key of DECLARATION_NODE_CONTAINERS) {
        walkContainer(entry[key], depth + 1);
      }
    }
  };
  if (isPlainObject(doc)) {
    for (const key of DECLARATION_NODE_CONTAINERS) {
      walkContainer(doc[key], 0);
    }
  }
  return tools;
}

/**
 * The passthrough tools the named package's own pinned declaration calls. Empty
 * for a package with no installed declaration, an unreadable one, or one that
 * calls the passthrough nowhere.
 */
export async function declaredPassthroughTools(
  packageName: string,
  deps: DeclaredPassthroughDeps = {},
): Promise<ReadonlySet<string>> {
  if (typeof packageName !== "string" || packageName.trim() === "") return new Set<string>();
  const oasPath = await resolveOasPath(packageName, deps);
  if (!oasPath) return new Set<string>();
  const doc = await readOas(oasPath, deps);
  if (doc === null) return new Set<string>();
  return toolsInDeclaration(doc);
}

/** Whether the named package's own declaration calls this tool on the
 *  passthrough — the admission itself. Fail-closed: anything unreadable or
 *  unnamed is `false`. */
export async function declaresPassthroughTool(
  packageName: string,
  tool: string,
  deps: DeclaredPassthroughDeps = {},
): Promise<boolean> {
  if (typeof tool !== "string" || tool.trim() === "") return false;
  const declared = await declaredPassthroughTools(packageName, deps);
  return declared.has(tool.trim());
}
