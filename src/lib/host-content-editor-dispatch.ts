import "server-only";

import { randomUUID } from "node:crypto";
import { buildA2aBearerToken } from "@cinatra-ai/llm";
import { createExternalA2AClient, type Task } from "@cinatra-ai/a2a";
import {
  createAgentRun,
  readAgentTemplateByPackageName,
  readLatestAgentVersionIdForTemplate,
  transitionRunStatus,
} from "@cinatra-ai/agents";
import { resolveContentEditorIdentityForInstance } from "@/lib/content-editor-run-identity";

// Host-side A2A blocking-dispatch helper shared by the Drupal + WordPress
// content-editor connectors. The non-SDK runtime edges — `@cinatra-ai/llm`
// (buildA2aBearerToken) + `@cinatra-ai/a2a` (createExternalA2AClient / Task) —
// live HERE and are delivered to each connector via its `deps.dispatchContentEditor`
// binding (the `@cinatra-ai/host:content-editor-dispatch` service published
// by register-host-connector-services.ts). The connector keeps only the
// `stripCodeFences` + `JSON.parse` of the returned text.
//
// Behavior: mint the A2A bearer for the "openai" provider, open the external A2A
// client, send a single text-mode task carrying `payload`, then walk
// `task.history` (NOT `task.artifacts` — WayFlow's A2AAgentWorker raises
// NotImplementedError on artifact reads) for the last agent/assistant message and
// return its concatenated text.
//
// PRODUCTION-IDENTITY OBO (cinatra#246): unlike a normal agent run dispatched by
// the worker (packages/agents/src/execution.ts), this host-initiated dispatch has
// NO session. To authorize the downstream `/api/mcp` CMS write through the REAL
// agent-run OBO path (NOT the dev-admin bypass), we pre-create a real `agent_run`
// row bound to a concrete {orgId, runBy} (resolved PER-INSTALL from the
// connector config's persisted install→org binding, origin-authoritative —
// cinatra#274 — falling back to single-tenant; see content-editor-run-identity.ts)
// and inject `cinatra_run_id: run.id` into the
// A2A message text. The agent_loader.py alias (cinatra_run_id → agent_run_id)
// plus each agent's OAS DataFlowEdge forward that id into the `/api/llm-bridge`
// ApiNode body as `agent_run_id`; the bridge resolves the run and mints the OBO
// actor token via resolveAgentRunMcpActor → buildLlmMcpServerToolForAgentRun.
// This synthetic run is NEVER enqueued for worker execution — it exists solely
// to carry the OBO identity — so we drive its lifecycle inline
// (queued→running before dispatch, →completed/→failed after) to keep it off the
// "stuck queued run" surfaces. If identity/template can't be resolved, we FALL
// BACK to the pre-fix anonymous dispatch (no run, no id) — the write then fails
// closed at the MCP boundary exactly as before, never elevated.

export type ContentEditorDispatchInput = {
  /** Resolved A2A endpoint for the content-editor agent. */
  agentUrl: string;
  /**
   * Input envelope forwarded as the A2A message text. Accepted as `unknown`
   * because the two consumers differ: the drupal connector pre-serializes
   * (`JSON.stringify(input)` → string), the wordpress connector passes the raw
   * object. A non-string payload is JSON-serialized here so the A2A `text` part
   * is never `[object Object]`.
   */
  payload: unknown;
  /** Blocking budget in ms (connectors pass 300_000 to align with /chat). */
  timeoutMs: number;
  /**
   * npm package name of the content-editor agent being dispatched
   * (`@cinatra-ai/wordpress-agent` | `@cinatra-ai/drupal-agent`). Used to
   * resolve the agent_templates row whose id satisfies the agent_runs
   * NOT-NULL template FK when pre-creating the OBO-carrier run. The two
   * connectors pass their own package name.
   *
   * OPTIONAL for backward compatibility: a connector release that predates
   * cinatra#246 omits it. When absent we cannot resolve the right template,
   * so we skip the OBO run and fall back to anonymous dispatch (the CMS write
   * then fails closed at the MCP boundary, exactly as before this fix). The
   * production OBO path requires the up-to-date connectors that pass it.
   */
  packageName?: string;
  /**
   * Multi-tenant install→org resolution anchors (cinatra#274). Supplied by the
   * widget-stream route so the OBO identity binds to THIS install's persisted
   * {orgId, runBy} rather than the single-tenant default:
   *   • instancesConfigKey — `connector_config` key holding the install rows
   *     ("wordpress" | "drupal"), from the widget-stream agent's `auth`.
   *   • origin — the token-bound, SERVER-VERIFIED site origin (authoritative).
   *   • instanceId — the client-supplied (sanitized) instance id; used ONLY to
   *     disambiguate among origin-matched rows, never to outrank the origin.
   * All OPTIONAL: the connector-side `deps.dispatchContentEditor` path carries
   * no install context, so it omits these and keeps single-tenant behavior.
   */
  instancesConfigKey?: string;
  origin?: string | null;
  instanceId?: string | null;
  /**
   * cinatra#408 — EXPLICIT per-user OBO identity override (the interactive
   * widget path). When present, the install/single-tenant identity resolver is
   * SKIPPED ENTIRELY and the carrier `agent_run` is created with exactly this
   * `{runBy, orgId, sourceType}`. The stream route builds this from a validated
   * `cwu_` user token AFTER all fail-closed checks (token consume, origin/org/
   * instance agreement, live membership), so `runBy` is the authenticated END
   * USER, never the install's configured service identity.
   *
   * There is NO anonymous fallback when an override is present: a bad override
   * is a server bug, not a license to downgrade to site identity. (The route
   * guarantees a present override is fully validated; an unresolvable template
   * still throws rather than silently dropping to anonymous.)
   *
   * `sourceType` is pinned to `"public_site_widget"` so the downstream bridge
   * resolver suppresses the platform-admin bypass for ONLY this path.
   */
  actorOverride?: {
    runBy: string;
    orgId: string;
    instanceId: string;
    sourceType: "public_site_widget";
  };
};

/**
 * Resolve the A2A message text. When we can establish a production OBO
 * identity + template, this also creates the carrier `agent_run` and injects
 * `cinatra_run_id` into the (object) payload. Returns the text plus the
 * created run id (null when no OBO run was created — anonymous fallback).
 */
async function prepareDispatch(
  input: ContentEditorDispatchInput,
): Promise<{ text: string; runId: string | null }> {
  // Normalize payload to an object so we can splice in cinatra_run_id. The
  // drupal connector pre-serializes to a JSON string; parse it back. If the
  // payload is a non-string non-object, or parses to a non-object, we cannot
  // safely add a top-level key, so we skip OBO injection (codex#246 note 4):
  // the loader filters undeclared keys and would drop a wrapped `payload`.
  let payloadObject: Record<string, unknown> | null = null;
  if (typeof input.payload === "string") {
    try {
      const parsed = JSON.parse(input.payload);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        payloadObject = parsed as Record<string, unknown>;
      }
    } catch {
      payloadObject = null;
    }
  } else if (
    input.payload &&
    typeof input.payload === "object" &&
    !Array.isArray(input.payload)
  ) {
    payloadObject = input.payload as Record<string, unknown>;
  }

  // Anonymous-fallback text (pre-#246 behavior): never `[object Object]`.
  const anonymousText =
    typeof input.payload === "string"
      ? input.payload
      : JSON.stringify(input.payload);

  if (!payloadObject) {
    // cinatra#408 — when a validated per-user override is present we must NOT
    // dispatch anonymously (that would silently downgrade the authenticated
    // user to a no-identity write the boundary then denies, masking a server
    // bug). A non-object payload here is a programming error on the override
    // path; surface it loudly instead of a silent anonymous fallback.
    if (input.actorOverride) {
      throw new Error(
        "[content-editor-dispatch] actorOverride present but payload is not an injectable object; " +
          "refusing anonymous fallback for a per-user widget dispatch.",
      );
    }
    return { text: anonymousText, runId: null };
  }

  // cinatra#408 — EXPLICIT per-user identity override (interactive widget path).
  // The stream route has already fail-closed-validated the `cwu_` user token,
  // the two-token origin/org/instance agreement, and live org membership BEFORE
  // calling here, so we trust this `{runBy, orgId}` and create the carrier run
  // directly — SKIPPING `resolveContentEditorIdentityForInstance` (and its
  // single-tenant / install-admin fallback) entirely. No anonymous fallback.
  if (input.actorOverride) {
    if (!input.packageName) {
      // The widget path always supplies packageName (the relay's package); its
      // absence is a wiring bug, not a back-compat case — fail loudly.
      throw new Error(
        "[content-editor-dispatch] actorOverride present without packageName; " +
          "cannot resolve the agent template for a per-user widget dispatch.",
      );
    }
    const template = await readAgentTemplateByPackageName(input.packageName);
    if (!template) {
      throw new Error(
        `[content-editor-dispatch] actorOverride present but no agent template installed for ${input.packageName}; ` +
          "refusing anonymous fallback for a per-user widget dispatch.",
      );
    }
    const latestVersionId =
      (await readLatestAgentVersionIdForTemplate(template.id)) ?? undefined;
    const overrideRunId = `run_${randomUUID()}`;
    const overrideRun = await createAgentRun({
      id: overrideRunId,
      templateId: template.id,
      versionId: latestVersionId,
      inputParams: payloadObject,
      runBy: input.actorOverride.runBy,
      orgId: input.actorOverride.orgId,
      // The discriminator the bridge resolver keys on to suppress the
      // platform-admin bypass for ONLY this per-user widget path (cinatra#408).
      sourceType: input.actorOverride.sourceType,
    });
    const overrideText = JSON.stringify({
      ...payloadObject,
      cinatra_run_id: overrideRun.id,
    });
    return { text: overrideText, runId: overrideRun.id };
  }

  // A connector release predating cinatra#246 omits packageName. Without it we
  // cannot resolve the right agent template, so fall back to anonymous (the
  // production OBO path needs the up-to-date connectors that pass it).
  if (!input.packageName) {
    console.warn(
      "[content-editor-dispatch] no packageName supplied (pre-#246 connector); " +
        "dispatching anonymously (CMS write will fail closed at the MCP boundary).",
    );
    return { text: anonymousText, runId: null };
  }

  // Resolve the OBO identity: PREFER this install's persisted {orgId, runBy}
  // (cinatra#274), origin-authoritative; FALL BACK to single-tenant when the
  // install has no binding (pre-#274 rows) or no match. The single-tenant
  // fallback lives inside the per-instance resolver, so this one call covers
  // both. A null result (neither available) → anonymous dispatch.
  const identity = await resolveContentEditorIdentityForInstance({
    instancesConfigKey: input.instancesConfigKey ?? "",
    origin: input.origin,
    instanceId: input.instanceId,
  });
  if (!identity) {
    console.warn(
      `[content-editor-dispatch] no content-editor identity resolved for ${input.packageName}; ` +
        `dispatching anonymously (CMS write will fail closed at the MCP boundary).`,
    );
    return { text: anonymousText, runId: null };
  }

  const template = await readAgentTemplateByPackageName(input.packageName);
  if (!template) {
    console.warn(
      `[content-editor-dispatch] agent template not installed for ${input.packageName}; ` +
        `dispatching anonymously (CMS write will fail closed at the MCP boundary).`,
    );
    return { text: anonymousText, runId: null };
  }

  // Pin the run to the latest published version snapshot (mirrors the
  // agent_run MCP handler + workflow-agent-executor).
  const latestVersionId =
    (await readLatestAgentVersionIdForTemplate(template.id)) ?? undefined;

  const runId = `run_${randomUUID()}`;
  const run = await createAgentRun({
    id: runId,
    templateId: template.id,
    versionId: latestVersionId,
    inputParams: payloadObject,
    runBy: identity.runBy,
    orgId: identity.orgId,
    // Distinct discriminator: this run carries OBO identity for a host-side
    // blocking A2A dispatch; it is NOT a worker-executed agent_builder run and
    // is never enqueued.
    sourceType: "content_editor_dispatch",
  });

  // Inject cinatra_run_id into the message text (mirrors execution.ts:1332).
  const text = JSON.stringify({ ...payloadObject, cinatra_run_id: run.id });
  return { text, runId: run.id };
}

export async function dispatchContentEditorViaA2A(
  input: ContentEditorDispatchInput,
): Promise<string> {
  // Create + track the OBO-carrier agent_run (and inject cinatra_run_id) BEFORE
  // opening the external A2A client. createExternalA2AClient eagerly fetches the
  // agent card and can throw; doing prepareDispatch first guarantees the carrier
  // run exists and is recorded even when that card fetch fails (cinatra#246). The
  // try/catch below then transitions that recorded run queued→failed so the
  // failure can never leave it orphaned in `queued`.
  const { text, runId } = await prepareDispatch(input);

  // Token-build + client-creation happen AFTER the carrier run is created (in
  // prepareDispatch), and either can throw — buildA2aBearerToken on a mint
  // failure, createExternalA2AClient on its eager agent-card fetch. If we let
  // such a throw propagate here the run would be orphaned in `queued` forever
  // (the sendTask catch below only handles the running→failed edge). Transition
  // the still-`queued` carrier run →failed before rethrowing so it never strands
  // on a "stuck queued run" surface (cinatra#246). Transition errors stay
  // non-fatal: the run row is auxiliary to the actual dispatch.
  let client: Awaited<ReturnType<typeof createExternalA2AClient>>;
  try {
    const a2aBearer = await buildA2aBearerToken("openai");
    client = await createExternalA2AClient({
      agentUrl: input.agentUrl,
      credentials: a2aBearer ? { token: a2aBearer } : undefined,
      timeoutMs: input.timeoutMs,
    });
  } catch (err) {
    if (runId) {
      try {
        await transitionRunStatus(runId, "queued", "failed", {
          error: err instanceof Error ? err.message : String(err),
          completedAt: new Date(),
        });
      } catch (txErr) {
        console.warn(`[content-editor-dispatch] run ${runId} queued→failed failed:`, txErr);
      }
    }
    throw err;
  }

  // Drive the OBO-carrier run's lifecycle inline. queued→running before the
  // blocking dispatch; →completed on success, →failed on dispatch error. This
  // keeps the synthetic run off "stuck queued run" surfaces. Transition errors
  // are non-fatal — the run row is auxiliary to the actual dispatch.
  if (runId) {
    try {
      await transitionRunStatus(runId, "queued", "running", { startedAt: new Date() });
    } catch (err) {
      console.warn(`[content-editor-dispatch] run ${runId} queued→running failed:`, err);
    }
  }

  let task: Task;
  try {
    task = await client.sendTask({
      message: {
        role: "user",
        kind: "message",
        messageId: randomUUID(),
        parts: [{ kind: "text", text }],
      },
      configuration: { acceptedOutputModes: ["text"] },
    });
  } catch (err) {
    if (runId) {
      try {
        await transitionRunStatus(runId, "running", "failed", {
          error: err instanceof Error ? err.message : String(err),
          completedAt: new Date(),
        });
      } catch (txErr) {
        console.warn(`[content-editor-dispatch] run ${runId} running→failed failed:`, txErr);
      }
    }
    throw err;
  }

  if (runId) {
    try {
      await transitionRunStatus(runId, "running", "completed", { completedAt: new Date() });
    } catch (err) {
      console.warn(`[content-editor-dispatch] run ${runId} running→completed failed:`, err);
    }
  }

  // A2A spec roles are "user" | "agent"; historical Cinatra runs may carry
  // "assistant" — accept both on the READ side only (producers MUST emit "agent").
  const history: ReadonlyArray<{
    role?: string;
    parts?: Array<{ kind?: string; text?: string }>;
  }> = task.history ?? [];
  const lastAgent = history
    .slice()
    .reverse()
    .find((m) => m?.role === "agent" || m?.role === "assistant");

  return (
    lastAgent?.parts
      ?.filter(
        (p): p is { kind: "text"; text: string } =>
          p.kind === "text" && typeof p.text === "string",
      )
      .map((p) => p.text)
      .join("") ?? ""
  );
}
