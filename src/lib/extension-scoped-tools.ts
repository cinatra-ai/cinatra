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
import type { StoredIdeasPorts } from "@/lib/blog/stored-ideas-gate-runner";

/** The names W7 adds to the passthrough allowlist, each scoped below. */
export const EXTENSION_SCOPED_TOOLS = new Set<string>([
  "extension_data",
  "artifacts_list",
  "artifacts_get",
  "artifact_content_read",
  // cinatra#3035 (epic #3023 W11) — the blog pipeline's stored-ideas gate. Three
  // steps of the pipeline's own flow, each one call, and every read and write it
  // makes is one of the four scoped tools above under the SAME scope: the
  // dependency-scoped listing and content read for the ideas, the extension-data
  // tool for the pipeline's own declared relation table. It is admitted by name
  // like the rest and widens nothing — a run whose extension declares neither
  // the blog-idea dependency nor the table is refused by those tools, not by a
  // check of its own.
  "blog_pipeline_ideas",
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
    if (input.tool === "blog_pipeline_ideas") {
      return { ok: true, result: await runStoredIdeasGate(context, input) };
    }
    return { ok: true, result: await runArtifactRead(context, input) };
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
// The gate's decisions live in `@/lib/blog/stored-ideas-gate`; its reads and
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
function requireIdeaType(raw: Record<string, unknown>): string {
  const ideaType = typeof raw.ideaType === "string" ? raw.ideaType.trim() : "";
  if (ideaType.length === 0) {
    throw new ExtensionDataRefusal(
      "invalid-request",
      "blog_pipeline_ideas: `ideaType` is required — the calling extension names the artifact type " +
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
  } = await import("@/lib/blog/stored-ideas-gate-runner");
  const { IDEA_RELATION_TABLE_DECLARED, resolveIdeaPick } = await import(
    "@/lib/blog/stored-ideas-gate"
  );

  const ideaType = requireIdeaType(input.input);
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
    const offered = Array.isArray(raw.offered)
      ? (raw.offered as Array<{
          artifactId: string;
          representationRevisionId: string;
          title: string;
          text: string;
        }>)
      : [];
    const picked = resolveIdeaPick({ pick: raw.pick, offered });
    if (!picked.ok) return { ok: false, reason: picked.reason };
    const taken = await reserveStoredIdea({
      ports,
      orgId: input.run.orgId,
      runId: input.run.id,
      idea: picked.idea,
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
    `blog_pipeline_ideas: \`op\` must be one of prepare, reserve, complete, release (got ${JSON.stringify(op)})`,
  );
}

/** Postgres' unique-violation SQLSTATE, however the driver wraps it. */
function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "23505") return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /duplicate key value|unique constraint/i.test(message);
}
