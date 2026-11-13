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
  ExtensionToolRefusal,
  dispatchExtensionTool,
  type ExtensionToolPorts,
} from "@/lib/extension-tool-dispatch";
import { ExtensionToolModuleRefusal } from "@/lib/extension-tool-module-loader";
import { ExtensionToolOriginRefusal, ORIGIN_CODES, resolveExtensionToolOrigin } from "@/lib/extension-tool-origin";
import { INSTALL_BINDING_CODES } from "@/lib/extension-tool-install-binding";
import { createExtensionObjectsPort } from "@/lib/extension-objects-port";
import { attributionFields, type ExtensionToolAttribution } from "@/lib/extension-tool-attribution";
import type { AuditEventInput } from "@/lib/authz/audit";
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
import {
  PASSTHROUGH_UNEXPECTED_ERROR,
  passthroughFixedFailureText,
} from "@/lib/passthrough-refusal";
import { logFixedLine } from "@/lib/failure-log";

/** The names W7 adds to the passthrough allowlist, each scoped below. */
export const EXTENSION_SCOPED_TOOLS = new Set<string>([
  "extension_data",
  // The second generic layer (cinatra#3525): ONE passthrough tool that runs a
  // module the CALLING extension declares in its own manifest. It names no
  // extension either — the caller comes from the run, the name is resolved
  // against that caller's own declaration, and the ports it is handed are the
  // scoped primitives beside it.
  "extension_tool",
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
  /** The run's template version pin (cinatra#4154); null when the run has none. */
  versionId?: string | null;
  /** The install the run executes as (cinatra#1392 Gap 2); null when the row has none. */
  dependentInstallId?: string | null;
  /** The calling step the route verified from the runtime's signed pair
   *  (cinatra#3745, #4154); null when the pair did not verify. The route
   *  refuses an `extension_tool` call without one before reaching here. */
  verifiedStepId?: string | null;
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
 *
 * cinatra#4471: NO THROW LEAVES THIS FUNCTION, AND NO THROWN TEXT IS THE ANSWER
 * UNLESS IT IS A STATED REFUSAL. The context resolution and the tool run are
 * both inside the one `try`. A stated refusal (the classes `statedRefusal`
 * reads) answers its own sentence. Every other throw (a module's own failure,
 * a host read inside a port, the context resolution) can name a path, a store
 * directory or an install id, so it answers the passthrough's fixed sentence
 * (#4223), and the server log records the stage, the tool, the run and a class
 * word, never its text. A throw that cannot even be classified (a proxy whose
 * trap throws, a refusal whose `message` or `reason` getter throws) answers
 * the same fixed sentence, with the class word `unreadable`. The catch reads
 * the tool and the run id for the log through `diagnosticFields`, which never
 * throws.
 */
export async function dispatchExtensionScopedTool(input: {
  tool: string;
  input: Record<string, unknown>;
  run: ExtensionScopedToolRun;
  actor?: ActorContext;
}): Promise<ExtensionScopedToolOutcome> {
  // ONE `extension_tool.dispatch` EVENT PER CALL (cinatra#4154), allowed and
  // refused alike. The dispatch reads `input.tool` and `input.run` exactly as
  // often and in the same order as it does without the event; the trail keeps
  // what those reads saw, and the event is built from that alone. The event is
  // handed to the audit sink before the answer returns; the answer never waits
  // for the write itself.
  const trail: DispatchTrail = {
    runPackage: null,
    codePackage: null,
    codeInstallId: null,
    verifiedStepId: null,
    tool: undefined,
    branched: false,
    run: undefined,
    stepRead: false,
  };
  const outcome = await dispatchScopedTool(input, trail);
  if (trail.tool === "extension_tool") await auditToolDispatch(trail, outcome);
  return outcome;
}

/**
 * What the dispatch event records: the four fields, and what the dispatch's own reads saw: the last `tool` value
 * before it chose its branch (or, on a throw before that, the value the
 * failure log read), the run object of its first `run` read, and whether the
 * step was already read.
 */
type DispatchTrail = ExtensionToolAttribution & {
  tool: unknown;
  branched: boolean;
  run: unknown;
  stepRead: boolean;
};

/** Keep a value the dispatch read of `input.tool`, and give it back. */
function seenTool(trail: DispatchTrail, value: unknown): unknown {
  trail.tool = value;
  return value;
}

/** Keep the first value the dispatch read of `input.run`, and give it back. */
function seenRun<T>(trail: DispatchTrail, value: T): T {
  if (trail.run === undefined) trail.run = value;
  return value;
}

/** One field of a run object, or undefined when it is not a string or its read throws. Never throws. */
function runField(run: unknown, key: "id" | "orgId" | "runBy" | "verifiedStepId"): string | undefined {
  try {
    if (typeof run !== "object" || run === null) return undefined;
    const value: unknown = (run as Record<string, unknown>)[key];
    return typeof value === "string" && value !== "" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The origin refusal's fixed sentence, as `ExtensionToolOriginRefusal` writes it. */
const ORIGIN_SENTENCE = /^extension_tool: the calling step reaches no tool of this origin \(([a-z-]+)\)$/;
/** Every fixed code that sentence may name: the resolver's and the install binding's. */
const FIXED_ORIGIN_CODES: ReadonlySet<string> = new Set<string>([...ORIGIN_CODES, ...INSTALL_BINDING_CODES]);

/**
 * The fixed origin code a 403 answer names, read from the answer the
 * dispatch's classifier already gave, never from the thrown value: undefined
 * unless the answer is exactly the origin sentence of a code in the fixed list.
 */
function originCodeOfAnswer(outcome: ExtensionScopedToolOutcome): string | undefined {
  if (outcome.ok || outcome.status !== 403) return undefined;
  const m = ORIGIN_SENTENCE.exec(outcome.error);
  return m !== null && FIXED_ORIGIN_CODES.has(m[1]!) ? m[1] : undefined;
}

/**
 * Hand the call's dispatch event to the audit sink. Never throws and never
 * rejects. It resolves once the sink has been called, never waiting for the
 * write itself, whose outcome is dropped. The run's fields are read here only
 * after the answer is fixed, each on its own: a field that cannot be read is
 * left out, and the event is still handed over. A refusal records a fixed word
 * for its status and, for an origin refusal, the fixed code its answer names,
 * never other text; it is recorded every time, never folded into the
 * denied-event cooldown, because each refused call is its own event.
 */
async function auditToolDispatch(trail: DispatchTrail, outcome: ExtensionScopedToolOutcome): Promise<void> {
  try {
    const run = trail.run;
    const orgId = runField(run, "orgId");
    const runBy = runField(run, "runBy");
    const runId = runField(run, "id");
    if (!trail.stepRead) trail.verifiedStepId = runField(run, "verifiedStepId") ?? null;
    const originCode = originCodeOfAnswer(outcome);
    const reason = outcome.ok
      ? null
      : outcome.status === 403
        ? "refused"
        : outcome.status === 404
          ? "not-found"
          : "failed";
    const event: AuditEventInput = {
      ...(orgId !== undefined ? { organizationId: orgId } : {}),
      ...(runBy !== undefined ? { actorPrincipalId: runBy } : {}),
      actorPrincipalType: "a2a" as const,
      authSource: "agent" as const,
      resourceType: "extension_tool",
      operation: "extension_tool.dispatch",
      ...(runId !== undefined ? { runId } : {}),
      ...(trail.codePackage ? { resourceId: trail.codePackage } : {}),
      decision: reason === null ? ("allowed" as const) : ("denied" as const),
      ...(reason === null ? {} : { deniedCooldown: "record_every" as const }),
      metadata: {
        ...attributionFields(trail),
        ...(reason === null ? {} : { reason }),
        ...(originCode !== undefined ? { originCode } : {}),
      },
    };
    const { logAuditEvent } = await import("@/lib/authz/audit");
    // Called now, before the answer returns; its promise is not awaited.
    void Promise.resolve(logAuditEvent(event)).catch(() => {});
  } catch {
    /* an audit write never changes the answer */
  }
}

async function dispatchScopedTool(
  input: {
    tool: string;
    input: Record<string, unknown>;
    run: ExtensionScopedToolRun;
    actor?: ActorContext;
  },
  trail: DispatchTrail,
): Promise<ExtensionScopedToolOutcome> {
  try {
    const context = await resolveRunExtensionContext({
      templateId: seenRun(trail, input.run).templateId,
      packageVersion: input.run.packageVersion,
    });
    if (!context) {
      return {
        ok: false,
        status: 403,
        error:
          `${seenTool(trail, input.tool)}: the run resolves to no extension package at a pinned version, so there is ` +
          `no one declaration to admit this call under`,
      };
    }
    if (seenTool(trail, input.tool) === "extension_data") {
      trail.branched = true;
      return { ok: true, result: await runDataTool(context, input) };
    }
    if (seenTool(trail, input.tool) === "extension_tool") {
      trail.branched = true;
      return { ok: true, result: await runExtensionTool(context, input, trail) };
    }
    trail.branched = true;
    return { ok: true, result: await runArtifactRead(context, input) };
  } catch (e) {
    const where = { ...diagnosticFields(input), stage: "extension-scoped tool call" };
    // A throw before the dispatch chose its branch: the failure log's own read decides the event.
    if (!trail.branched) trail.tool = where.tool;
    const stated = statedRefusal(e);
    if (stated === UNREADABLE) {
      logFixedLine(
        `[agents-passthrough] ${where.stage} failed; the error could not be read, ` +
          `and its text is not logged`,
        { tool: where.tool, runId: where.runId, errorClass: "unreadable" },
      );
      return { ok: false, status: 500, error: PASSTHROUGH_UNEXPECTED_ERROR };
    }
    if (stated !== null) return stated;
    return {
      ok: false,
      status: 500,
      error: passthroughFixedFailureText(e, where, PASSTHROUGH_UNEXPECTED_ERROR),
    };
  }
}

/**
 * The tool and the run id the failure log names, read so that no getter can
 * throw out of the catch: a value that is not a string, or a read that throws,
 * is the word "unreadable".
 */
function diagnosticFields(input: { tool: unknown; run: unknown }): { tool: string; runId: string } {
  let tool = "unreadable";
  let runId = "unreadable";
  try {
    const value: unknown = input.tool;
    if (typeof value === "string") tool = value;
  } catch {
    /* the word stays */
  }
  try {
    const value: unknown = (input.run as { id?: unknown }).id;
    if (typeof value === "string") runId = value;
  } catch {
    /* the word stays */
  }
  return { tool, runId };
}

/** A throw this module could not classify or read: answered as a failure. */
const UNREADABLE = Symbol("unreadable");

/**
 * The answer of a stated refusal: its own sentence with 403, or 404 for a
 * missing artifact. Null for any other throw. UNREADABLE when a class check or
 * a read of the refusal's `message` or `reason` throws, or the sentence is not
 * a string. Never a throw.
 */
function statedRefusal(e: unknown): ExtensionScopedToolOutcome | null | typeof UNREADABLE {
  try {
    if (
      e instanceof ExtensionDataRefusal ||
      e instanceof ExtensionToolRefusal ||
      e instanceof ExtensionToolModuleRefusal ||
      e instanceof ExtensionToolOriginRefusal ||
      e instanceof ArtifactAdmissionRefusal ||
      e instanceof ArtifactCursorRefusal
    ) {
      const message: unknown = e.message;
      if (typeof message !== "string") return UNREADABLE;
      return { ok: false, status: 403, error: message };
    }
    if (e instanceof ArtifactContentRefusal) {
      const reason: unknown = e.reason;
      const message: unknown = e.message;
      if (typeof message !== "string") return UNREADABLE;
      return { ok: false, status: reason === "not-found" ? 404 : 403, error: message };
    }
    return null;
  } catch {
    return UNREADABLE;
  }
}

async function runDataTool(
  context: Awaited<ReturnType<typeof resolveRunExtensionContext>> & object,
  input: { input: Record<string, unknown>; run: ExtensionScopedToolRun },
  attribution?: ExtensionToolAttribution,
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
      ...(attribution ? { attribution } : {}),
    });
  } finally {
    client.release();
  }
}

/**
 * THE CALLING EXTENSION'S OWN MODULE, run under the same declaration that
 * admits everything else here (cinatra#3525).
 *
 * The ports handed to it are the scoped primitives beside this function, bound
 * to THIS run: the caller's own table operations, the two artifact reads over
 * the types it declares as dependencies, the review-gate filing, and the clock.
 * The run's identity rides in the envelope and in those bindings, never into
 * the module's input — `dispatchExtensionTool` refuses a call that tries to.
 * The fifth port, `objects` (cinatra#3089), reads the objects of this run's own
 * lineage and saves records of the types the caller's declared artifact
 * dependencies own, through the host's own objects save, the run bound here.
 */
async function runExtensionTool(
  runContext: Awaited<ReturnType<typeof resolveRunExtensionContext>> & object,
  input: {
    tool: string;
    input: Record<string, unknown>;
    run: ExtensionScopedToolRun;
    actor?: ActorContext;
  },
  trail: DispatchTrail,
): Promise<unknown> {
  trail.runPackage = runContext.packageName;
  // WHOSE CODE RUNS (cinatra#4154): the run package's own, or, for a proven step
  // of an embedded child flow, the child's, from the exact child installation.
  // The ports below are then the child's declarations, bound to this same run.
  // `input.run` is read once here, as before; the resolver is the only other
  // reader of its step, so the step is read for the attribution after it. A
  // resolver throw is not touched here: it reaches the dispatch's classifier
  // as it is, and the event takes its origin code from that answer.
  const run = input.run;
  const origin = await resolveExtensionToolOrigin({
    run,
    context: runContext,
    request: isPlainObject(input.input) ? input.input : {},
  });
  trail.verifiedStepId = runField(run, "verifiedStepId") ?? null;
  trail.stepRead = true;
  const context = origin.kind === "child" ? origin.context : runContext;
  trail.codePackage = context.packageName;
  trail.codeInstallId = origin.kind === "child" ? origin.codeInstallId : null;
  // Every audit event the ports write names whose code made the call (2.7).
  const attribution = attributionFields(trail);
  const ports: Omit<ExtensionToolPorts, "review"> = {
    data: {
      select: (request) =>
        runDataTool(context, { ...input, input: { ...request, operation: "select" } }, attribution),
      insertIfAbsent: (request) =>
        runDataTool(context, { ...input, input: { ...request, operation: "insertIfAbsent" } }, attribution),
      updateWhere: (request) =>
        runDataTool(context, { ...input, input: { ...request, operation: "updateWhere" } }, attribution),
    },
    artifacts: {
      list: (request) =>
        runArtifactRead(context, { ...input, tool: "artifacts_list", input: request }, attribution),
      contentRead: (request) =>
        runArtifactRead(context, { ...input, tool: "artifact_content_read", input: request }, attribution),
    },
    clock: { now: () => new Date() },
    objects: createExtensionObjectsPort({
      packageName: context.packageName,
      packageVersion: context.packageVersion,
      cinatra: context.cinatra,
      run: input.run,
      actor: input.actor,
      attribution,
    }),
  };
  return dispatchExtensionTool({
    packageName: context.packageName,
    packageVersion: context.packageVersion,
    orgId: input.run.orgId,
    cinatra: context.cinatra,
    request: input.input,
    ports,
    ...(origin.kind === "child" ? { install: origin.install } : {}),
  });
}

async function runArtifactRead(
  context: Awaited<ReturnType<typeof resolveRunExtensionContext>> & object,
  input: { tool: string; input: Record<string, unknown>; run: ExtensionScopedToolRun; actor?: ActorContext },
  attribution?: ExtensionToolAttribution,
): Promise<unknown> {
  const admission = resolveArtifactDependencyAdmission({
    packageName: context.packageName,
    packageVersion: context.packageVersion,
    cinatra: context.cinatra,
    orgId: input.run.orgId,
  });
  const ctx = {
    admission,
    orgId: input.run.orgId,
    runId: input.run.id,
    ...(input.actor ? { actor: input.actor } : {}),
    actorPrincipalId: input.run.runBy,
    ...(attribution ? { attribution } : {}),
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
  // The type the caller expects (see extensionArtifactGet). A field this cannot
  // read is refused, never dropped: a dropped type would read any admitted type.
  if (
    raw.objectType !== undefined &&
    (typeof raw.objectType !== "string" || raw.objectType.trim() === "")
  ) {
    throw new ArtifactContentRefusal(
      "invalid-request",
      `${input.tool}: \`objectType\` must name an object type`,
    );
  }
  const objectType = typeof raw.objectType === "string" ? { objectType: raw.objectType } : {};
  if (input.tool === "artifacts_get") {
    return { artifact: await extensionArtifactGet(ctx, { artifactId, ...objectType }) };
  }
  return extensionArtifactContentRead(ctx, {
    artifactId,
    ...(typeof raw.representationRevisionId === "string"
      ? { representationRevisionId: raw.representationRevisionId }
      : {}),
    ...(typeof raw.maxBytes === "number" ? { maxBytes: raw.maxBytes } : {}),
    ...objectType,
  });
}
