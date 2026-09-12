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

/** The names W7 adds to the passthrough allowlist, each scoped below. */
export const EXTENSION_SCOPED_TOOLS = new Set<string>([
  "extension_data",
  "artifacts_list",
  "artifacts_get",
  "artifact_content_read",
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
