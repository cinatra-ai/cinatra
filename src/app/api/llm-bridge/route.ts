import "server-only";

import * as path from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { NextResponse } from "next/server";
import {
  runResolvedSkillAwareDeterministicLlmTask,
  resolveConfiguredLlmRuntime,
  resolveProviderAdapter,
  createLocalSkillShellTool,
  openAiModelSupportsShell,
  buildLlmMcpServerToolForAgentRun,
  getLlmMcpCredentials,
  PreferredProviderUnavailableError,
  type LlmTool,
  type LlmResponse,
} from "@cinatra-ai/llm";
import { resolveAgentInstallDir } from "@cinatra-ai/agents/agent-install-path";
import {
  getCustomSkillForCurrentUserAndAgent,
  registerExtensionSkill,
} from "@cinatra-ai/skills";
import { getAssignedSkillIdsForAgent } from "@/lib/agents-store";
import {
  readAgentRunByContextId,
  readAgentRunById,
  OasCinatraLlmSchema,
  type LlmProvider,
} from "@cinatra-ai/agents";
// Bridge resolver ports support the WayFlow text-only user envelope.
// resolveEntryAttachments() in the orchestration layer consumes the
// ports; without the run.orgId we cannot scope cache/blob reads so
// attachments degrade to the Decision-A manifest (turn proceeds).
import { buildBridgeAttachmentResolverPorts } from "./attachment-resolver-ports";
import { parseUserEnvelope, UserEnvelopeParseError } from "./user-envelope";
import { isAuthorizedBridgeRequest } from "@/lib/wayflow-bridge-auth";
import { verifyLangGraphBridgeToken } from "@/lib/a2a-auth";
import { setRunContext, clearRunContext } from "@/lib/agent-run-context-registry";
import { issueAgentRunMcpActorToken } from "@/lib/agent-run-mcp-actor-token";
import { resolveAgentRunMcpActor } from "@/lib/agent-run-actor-resolve";
import { POLICY_VERSION, type ActorContext } from "@/lib/authz/actor-context";
import { emitUsageEvent } from "@cinatra-ai/metric-usage-api";
import {
  resolveCinatraLlmDispatch,
  inferMimeTypeFromUrlOrHeader,
  GEMINI_MEDIA_MIME_ALLOWLIST,
  MEDIA_MAX_BYTES,
  streamFetchWithSizeCap,
} from "./_llm-dispatch";
import {
  BridgeUrlError,
  isYouTubeUrlStrict,
  validateExternalUrl,
} from "./_url-validation";
import { safeFetch } from "./_safe-fetch";

// Built-in provider tool names travel in the same `toolbox_ids` list as
// MCP toolbox IDs. The bridge route partitions on this set: members route
// to `extraTools` as provider-native tools; non-members route to
// `declaredToolboxIds` (resolved by resolveMcpToolsForDeclaredIds against
// "cinatra-mcp" + external registry).
const BUILT_IN_BRIDGE_TOOLS: ReadonlySet<string> = new Set(["web_search"]);

// ---------------------------------------------------------------------------
// Unified LLM Bridge
//
// Single endpoint for all WayFlow LLM execution: both the TypeScript ApiNode
// path and the Python container path.
//
// Design principles:
//   - Cinatra owns the LLM runtime — no API keys accepted from callers
//   - Auth: bridge-token (X-Cinatra-Bridge-Token) OR Bearer JWT (A2A token)
//   - Skill IDs resolved from DB via agent_id; callers never pass raw skill lists
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Cost-DoS defense: model_id must be in this allow-list. Adding a new model
// requires a code change, which adds intentional friction against forged
// payloads. The local name avoids collision with `ALLOWED_MODEL_IDS` from
// @cinatra-ai/agents (per-provider policy map).
const MODEL_ID_ALLOWLIST = new Set<string>([
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-4o",
  "gpt-4o-mini",
]);

const RequestSchema = z.object({
  user: z.string(),
  // Explicit opt-in for the WayFlow text-only `{text, attachments}` JSON
  // envelope embedded in `user`. With this flag undefined or false,
  // body.user is passed VERBATIM to orchestration (byte-identical for
  // callers that do not opt in, even when the user literally sends
  // `{"text":"hi"}` as their question). With true, a strict-parse failure
  // is a 400 (no silent fallback to plain text).
  user_envelope: z.boolean().optional(),
  system: z.string().optional(),
  max_steps: z.number().int().positive().optional(),
  agent_run_id: z.string().optional(),
  agent_id: z.string().optional(),
  package_version: z.string().optional(),
  agent_spec_version: z.string().optional(),
  // Per-agent model override — validated against ALLOWED_MODEL_IDS below.
  model_id: z.string().optional(),
  // Compiled toolbox IDs — filters MCP injection to only declared toolboxes.
  toolbox_ids: z.array(z.string()).optional(),
  // Structured output schema — passed through to the orchestration layer.
  output_schema: z.record(z.string(), z.unknown()).optional(),
  // Explicit SKILL.md path on the host filesystem. Must be under process.cwd()
  // and end with SKILL.md (path traversal guard). When absent, the route
  // auto-discovers from agents/<agent_id>/skills/<agent_id>/SKILL.md.
  skill_source_path: z.string().optional(),
  // The provider field is intentionally absent. The runtime is resolved via
  // resolveConfiguredLlmRuntime(), not from request input. When multi-provider
  // support accepts caller input here, re-add the field as a Zod enum and
  // thread it into getLlmMcpCredentials.
  // cinatra_llm block: provider/model/capability hint injected by the OAS
  // compiler into every bridge-bound ApiNode body. Schema imported from
  // @cinatra-ai/agents/llm-provider-policy (single source of truth). When
  // undefined, dispatch remains backward-compatible.
  cinatra_llm: OasCinatraLlmSchema,
  // Optional media payload for the Gemini media-input branch. `kind` uses
  // z.preprocess to normalize "" and null to undefined because the OAS
  // ApiNode renders `kind: '{{ kind }}'`, which evaluates to '' when the
  // caller omits the field; the enum would otherwise 400 reject. Activated
  // by the media branch in POST() only when:
  //   dispatch.kind === "dispatch" &&
  //   dispatch.effectiveProvider === "gemini" &&
  //   body.cinatra_llm?.capabilityRequired === "media_input"
  // Otherwise the field is silently ignored for backward compatibility.
  media: z
    .object({
      url: z.string().url(),
      kind: z.preprocess(
        (v) => (v === "" || v === null ? undefined : v),
        z.enum(["audio", "video", "youtube"]).optional(),
      ),
    })
    .strict()
    .optional(),
  // Optional artifact attachments for the prompt turn. `media` (external-URL
  // Gemini path) is left untouched. The text-only WayFlow resume path can
  // instead embed `{ text, attachments }` as a JSON string in `user`
  // (parsed downstream).
  attachments: z
    .array(
      z
        .object({
          artifactId: z.string().min(1),
          representationRevisionId: z.string().min(1),
          digest: z.string().min(1),
          mime: z.string().min(1),
          originKind: z.enum([
            "upload",
            "email_attachment",
            "agent_generated",
            "external_link",
            "live_generator",
          ]),
          title: z.string().optional(),
          filename: z.string().optional(),
          size: z.number().int().nonnegative().optional(),
        })
        .strict(),
    )
    .max(20)
    .optional(),
});

// ---------------------------------------------------------------------------
// resolveBridgeSkillContent
//
// Reads SKILL.md content as a plain string for the Gemini media branch's
// `system` prompt. Mirrors the path-traversal guard logic used by the legacy
// text-dispatch branch (process.cwd() containment, realpathSync against
// symlinks, *.md/SKILL.md suffix gate). Returns "" on any failure so the
// caller can safely concatenate.
//
// Important: this helper does NOT replace the legacy `extraTools` SKILL
// shell-tool injection — the text-dispatch path continues to use that.
// This helper exists so the media branch (which goes direct to the Gemini
// adapter, NOT through runResolvedSkillAwareDeterministicLlmTask) can still
// inject SKILL.md instructions via `system`.
// ---------------------------------------------------------------------------
async function resolveBridgeSkillContent(body: {
  agent_id?: string;
  skill_source_path?: string;
}): Promise<string> {
  // Resolve a candidate path (explicit input OR conventional auto-discovery).
  function autoDiscoverSkillPath(agentId: string): string {
    const installDir = resolveAgentInstallDir();
    const newCanonical = path.join(installDir, "cinatra-ai", agentId, "skills", agentId, "SKILL.md");
    if (existsSync(newCanonical)) return newCanonical;
    return path.join(installDir, agentId, "skills", agentId, "SKILL.md");
  }
  const agentIdLooksLikePath =
    typeof body.agent_id === "string" &&
    (body.agent_id.includes("..") ||
      body.agent_id.includes("/") ||
      body.agent_id.includes("\\"));
  const candidateSkillPath = body.skill_source_path
    ? body.skill_source_path
    : body.agent_id && !agentIdLooksLikePath
      ? autoDiscoverSkillPath(body.agent_id)
      : "";
  if (!candidateSkillPath) return "";

  // Path-traversal guard: must resolve under cwd AND end with SKILL.md.
  const cwd = process.cwd();
  let resolvedPath: string;
  try {
    resolvedPath = realpathSync(path.resolve(candidateSkillPath));
  } catch {
    resolvedPath = path.resolve(candidateSkillPath);
  }
  const rel = path.relative(cwd, resolvedPath);
  const insideCwd = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  if (
    !candidateSkillPath.endsWith("SKILL.md") ||
    !insideCwd ||
    !existsSync(resolvedPath)
  ) {
    return "";
  }

  // Read + return content. Any IO error → "".
  try {
    return await readFile(resolvedPath, "utf8");
  } catch {
    return "";
  }
}

export async function POST(req: Request): Promise<Response> {
  // Dual auth: bridge token (WayFlow TS) OR Bearer JWT (Python containers).
  let bridgeActorContext: ActorContext | undefined;
  const isBridgeAuthorized = isAuthorizedBridgeRequest(req);
  if (!isBridgeAuthorized) {
    const jwtAuthed = await verifyLangGraphBridgeToken(req);
    if (!jwtAuthed.ok) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    bridgeActorContext = jwtAuthed.actorContext;
  }
  // Bridge-token path: WayFlow calls us as an external A2A agent. Build a
  // minimal actor frame so the fail-closed authz gate passes.
  if (!bridgeActorContext) {
    bridgeActorContext = {
      principalType: "ExternalA2AAgent",
      principalId: "wayflow-bridge",
      authSource: "a2a",
      policyVersion: POLICY_VERSION,
    };
  }

  const rawBody = await req.json().catch(() => null);
  const parsed = RequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request body", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const body = parsed.data;

  if (body.model_id !== undefined && !MODEL_ID_ALLOWLIST.has(body.model_id)) {
    return NextResponse.json(
      { error: "Unknown model_id", code: "UNKNOWN_MODEL_ID", model_id: body.model_id },
      { status: 400 },
    );
  }

  // ---------------------------------------------------------------------------
  // Provider-aware dispatch resolution.
  //
  // When body.cinatra_llm is undefined → kind: "passthrough" → legacy dispatch
  // path runs unchanged for backward compatibility.
  //
  // Otherwise → effectiveProvider resolution + capability gate + model gate
  // run in the helper. The helper returns:
  //   - "passthrough" (soft fallback OR no override at all)
  //   - "dispatch"    (call orchestration with explicit preferredProvider)
  //   - "error"       (400 model_provider_mismatch OR 503 capability_unsatisfiable)
  // ---------------------------------------------------------------------------
  const isAdapterAvailable = async (provider: LlmProvider): Promise<boolean> => {
    const adapter = await resolveProviderAdapter(provider).catch(() => null);
    return adapter !== null;
  };
  const dispatch = await resolveCinatraLlmDispatch(body.cinatra_llm, isAdapterAvailable);
  if (dispatch.kind === "error") {
    return NextResponse.json(dispatch.body, { status: dispatch.status });
  }
  // Soft fallback log: single machine-parseable warn line.
  if (dispatch.kind === "passthrough" && dispatch.requestedProvider !== null) {
    console.warn(
      "[llm-bridge] preferredProvider %s unavailable, falling back to configured default",
      dispatch.requestedProvider,
    );
  }

  // ---------------------------------------------------------------------------
  // Media-input dispatch (Gemini-only, skill-aware,
  // telemetry-emitting). Activates ONLY when all four gates are true:
  //   - dispatch.kind === "dispatch"  (caller declared cinatra_llm)
  //   - dispatch.effectiveProvider === "gemini"
  //   - body.cinatra_llm?.capabilityRequired === "media_input"
  //   - body.media !== undefined
  // When any gate fails, body.media is silently ignored — the legacy text
  // dispatch handles the request via body.user.
  // ---------------------------------------------------------------------------
  const wantsMediaInput =
    dispatch.kind === "dispatch" &&
    dispatch.effectiveProvider === "gemini" &&
    body.cinatra_llm?.capabilityRequired === "media_input" &&
    body.media !== undefined;

  if (wantsMediaInput && dispatch.kind === "dispatch" && body.media) {
    // SSRF defense-in-depth. Validate upfront before any LLM/fetch work
    // runs. Errors propagate to the outer try/catch below, which logs and
    // clears run context.
    let safeUrl: URL;
    try {
      safeUrl = validateExternalUrl(body.media.url);
    } catch (err) {
      if (err instanceof BridgeUrlError) {
        return NextResponse.json(
          { error: err.message, code: err.code, url: body.media.url },
          { status: 400 },
        );
      }
      throw err;
    }
    try {
    // SKILL.md content reaches Gemini via `system`. SKILL goes first
    // (it carries the agent's instructions); any caller-supplied body.system
    // is appended for supplementary context.
    const skillContent = await resolveBridgeSkillContent(body);
    const combinedSystem = [skillContent, body.system ?? ""]
      .filter((s) => s && s.length > 0)
      .join("\n\n");

    // Emit usage event helper: uses the verified LlmUsageEvent shape from
    // packages/metric-usage-api/src/types.ts.
    // NO agentRunId/agentId/tokensIn/tokensOut/kind fields.
    const dispatchPreferredModel = dispatch.preferredModel;
    const dispatchRequestedProvider = dispatch.requestedProvider;
    const emitMediaUsage = (result: LlmResponse): void => {
      try {
        emitUsageEvent({
          source: "llm",
          provider: "gemini",
          model: dispatchPreferredModel ?? "gemini-2.5-flash",
          operation: "generate",
          agentLabel: body.agent_id ?? null,
          skillLabel: null,
          inputTokens: result.usage?.inputTokens ?? 0,
          outputTokens: result.usage?.outputTokens ?? 0,
          cachedInputTokens: 0,
          reasoningOutputTokens: 0,
          idempotencyKey: randomUUID(),
          occurredAt: new Date().toISOString(),
          requestedProvider: dispatchRequestedProvider ?? "gemini",
          effectiveProvider: "gemini",
        });
      } catch (err) {
        console.warn("[llm-bridge] emitUsageEvent failed (media branch)", err);
      }
    };

    // Host-allowlist only: do not trust `kind === "youtube"` by itself.
    // Uses `isYouTubeUrlStrict` from `_url-validation.ts`, whose explicit
    // allowlist mirrors `_llm-dispatch.YOUTUBE_HOSTNAMES`, including
    // `youtube-nocookie.com`. The test suite covers this helper directly.
    const isYouTube = isYouTubeUrlStrict(body.media.url);

    if (isYouTube) {
      // YouTube branch — Gemini handles native ingestion of YouTube URLs
      // via the text adapter.generate path.
      const adapter = await resolveProviderAdapter("gemini");
      if (!adapter) {
        return NextResponse.json(
          {
            error: "preferred_provider_unavailable",
            code: "PREFERRED-PROVIDER-UNAVAILABLE",
            requestedProvider: "gemini",
          },
          { status: 503 },
        );
      }
      const result = await adapter.generate({
        system: combinedSystem,
        prompt: body.media.url,
        model: dispatchPreferredModel,
        maxSteps: 1,
      });
      emitMediaUsage(result);
      return NextResponse.json({ text: result.text ?? "" });
    }

    // Non-YouTube file branch — fetch + stream-count + upload + transcribe.
    // Use safeFetch (undici dispatcher with validated DNS lookup callback).
    // The lookup that validates IS the lookup the socket uses, closing the
    // validate-then-fetch TOCTOU window.
    let fetched: Response;
    try {
      fetched = await safeFetch(safeUrl, { method: "GET" });
    } catch (err) {
      if (err instanceof BridgeUrlError) {
        return NextResponse.json(
          { error: err.message, code: err.code, url: body.media.url },
          { status: 400 },
        );
      }
      return NextResponse.json(
        {
          error: "media_fetch_failed",
          code: "MEDIA-FETCH-FAILED",
          url: body.media.url,
          detail: err instanceof Error ? err.message : String(err),
        },
        { status: 400 },
      );
    }
    if (!fetched.ok) {
      return NextResponse.json(
        {
          error: "media_fetch_failed",
          code: "MEDIA-FETCH-FAILED",
          status: fetched.status,
          url: body.media.url,
        },
        { status: 400 },
      );
    }

    // Fast path: trust Content-Length when it's present and finite.
    const contentLengthHeader = fetched.headers.get("content-length");
    const advertisedLength = Number(contentLengthHeader ?? "");
    if (
      contentLengthHeader !== null &&
      Number.isFinite(advertisedLength) &&
      advertisedLength > MEDIA_MAX_BYTES
    ) {
      return NextResponse.json(
        {
          error: "media_too_large",
          code: "MEDIA-SIZE-EXCEEDED",
          contentLength: advertisedLength,
          max: MEDIA_MAX_BYTES,
        },
        { status: 413 },
      );
    }

    // Stream path: handles missing/untrusted Content-Length.
    const streamResult = await streamFetchWithSizeCap(fetched, MEDIA_MAX_BYTES);
    if (!streamResult.ok) {
      return NextResponse.json(
        {
          error: "media_too_large",
          code: "MEDIA-SIZE-EXCEEDED",
          bytesSeen: streamResult.bytesSeen,
          max: MEDIA_MAX_BYTES,
        },
        { status: 413 },
      );
    }

    // Derive the MIME and require it appear in the Gemini allowlist.
    const mimeType = inferMimeTypeFromUrlOrHeader(
      body.media.url,
      fetched.headers.get("content-type"),
    );
    if (!mimeType || !GEMINI_MEDIA_MIME_ALLOWLIST.has(mimeType)) {
      return NextResponse.json(
        {
          error: "unsupported_media_type",
          code: "MEDIA-MIME-UNSUPPORTED",
          contentType: fetched.headers.get("content-type"),
          inferredMimeType: mimeType ?? null,
          allowlist: Array.from(GEMINI_MEDIA_MIME_ALLOWLIST),
        },
        { status: 400 },
      );
    }

    // Upload → generate → emit telemetry → best-effort delete.
    const adapter = await resolveProviderAdapter("gemini");
    if (!adapter || !adapter.uploadFile || !adapter.generateFromMediaFile) {
      return NextResponse.json(
        {
          error: "preferred_provider_unavailable",
          code: "PREFERRED-PROVIDER-UNAVAILABLE",
          requestedProvider: "gemini",
        },
        { status: 503 },
      );
    }
    const filename =
      body.media.url.split("/").pop()?.split("?")[0] || "media-input";
    const fileRef = await adapter.uploadFile({
      content: streamResult.bytes,
      filename,
      mimeType,
    });

    try {
      // uploadResult.id is the Gemini File resource path "files/abc";
      // the Gemini SDK accepts this resource-path form as a fileUri.
      const result = await adapter.generateFromMediaFile({
        system: combinedSystem,
        mediaFileUri: fileRef.id,
        mimeType,
        model: dispatchPreferredModel,
        logLabel: body.agent_id ?? "media-transcript-agent",
      });
      emitMediaUsage(result);
      return NextResponse.json({ text: result.text ?? "" });
    } finally {
      if (adapter.deleteFile) {
        adapter
          .deleteFile(fileRef)
          .catch((err) =>
            console.warn("[llm-bridge] adapter.deleteFile failed", err),
          );
      }
    }
    } catch (err) {
      // Catch-all for the media branch so uploadFile / generateFromMediaFile /
      // safeFetch failures are logged and the response carries a structured
      // code. The run context isn't set until later in the route, so no
      // cleanup is needed here.
      console.error("[llm-bridge] media branch failed:", err);
      if (err instanceof BridgeUrlError) {
        return NextResponse.json(
          { error: err.message, code: err.code, url: body.media?.url ?? null },
          { status: 400 },
        );
      }
      return NextResponse.json(
        {
          error: "media_branch_failed",
          code: "MEDIA-BRANCH-FAILED",
          detail: err instanceof Error ? err.message : String(err),
        },
        { status: 500 },
      );
    }
  }

  const resolvedRuntime = await resolveConfiguredLlmRuntime().catch((e: unknown) => {
    console.error("[llm-bridge] resolveConfiguredLlmRuntime threw:", e);
    return null;
  });
  if (!resolvedRuntime) {
    return NextResponse.json(
      { error: "No LLM provider configured", code: "NO_LLM_PROVIDER" },
      { status: 503 },
    );
  }

  const maxSteps = Math.min(body.max_steps ?? 6, 20);

  // ---------------------------------------------------------------------------
  // Extra tools: explicit skill_source_path takes precedence; falls back to
  // the conventional agents/<agent_id>/skills/<agent_id>/SKILL.md discovery.
  // Path traversal guard: must be under process.cwd() and end with SKILL.md.
  // ---------------------------------------------------------------------------
  const extraTools: LlmTool[] = [];

  // Both branches (explicit skill_source_path and auto-discovery via agent_id)
  // feed into the same path.relative containment check below, so a malicious
  // agent_id like "../../etc" is also rejected.
  //
  // Auto-discovery probes the canonical layout first
  // (<installDir>/cinatra-ai/<slug>/skills/<slug>/SKILL.md), then the
  // fallback layout (<installDir>/<slug>/skills/<slug>/SKILL.md).
  function autoDiscoverSkillPath(agentId: string): string {
    const installDir = resolveAgentInstallDir();
    const newCanonical = path.join(installDir, "cinatra-ai", agentId, "skills", agentId, "SKILL.md");
    if (existsSync(newCanonical)) return newCanonical;
    return path.join(installDir, agentId, "skills", agentId, "SKILL.md");
  }
  // Slug guard for body.agent_id (defense-in-depth on top
  // of the path.relative containment check below). Matches the pattern in
  // packages/agents/src/mcp/handlers.ts so all agent-id-shaped inputs share
  // the same guard. Non-string inputs are filtered by the Zod schema; empty
  // strings ("") pass schema validation but are filtered by the truthiness
  // check at `body.agent_id && !agentIdLooksLikePath` below.
  const agentIdLooksLikePath =
    typeof body.agent_id === "string" &&
    (body.agent_id.includes("..") ||
      body.agent_id.includes("/") ||
      body.agent_id.includes("\\"));
  const candidateSkillPath = body.skill_source_path
    ? body.skill_source_path
    : body.agent_id && !agentIdLooksLikePath
      ? autoDiscoverSkillPath(body.agent_id)
      : "";

  if (candidateSkillPath) {
    const cwd = process.cwd();
    // Path traversal containment.
    // realpathSync resolves symlinks so a symlink inside cwd pointing outside
    // cwd is caught by the path.relative check.
    // Falls back to lexical path.resolve when the path doesn't exist yet
    // (existsSync below will reject it anyway).
    let resolvedPath: string;
    try {
      resolvedPath = realpathSync(path.resolve(candidateSkillPath));
    } catch {
      resolvedPath = path.resolve(candidateSkillPath);
    }
    // path.relative returns ".." or absolute when the candidate escapes cwd.
    // Empty rel ("" — candidate equals cwd exactly) is treated as inside.
    const rel = path.relative(cwd, resolvedPath);
    const insideCwd = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    if (
      candidateSkillPath.endsWith("SKILL.md") &&
      insideCwd &&
      existsSync(resolvedPath)
    ) {
      const skillDirPath = path.dirname(resolvedPath);
      const skillSlug = path.basename(skillDirPath);
      // Model-aware skill-tool injection.
      // OpenAI's Responses API rejects the `shell` tool for several
      // models (gpt-5 returns "400 Tool 'shell' is not supported with
      // gpt-5"). Surfaced by tracing the web-scrape-agent failure to
      // a docker/wayflow `_patched_run_task EXCEPTION` line:
      // packages/llm/src/providers/openai.ts translates
      // `type:"shell"` to the Responses API tool, which the model rejects.
      // The no-shell model set lives in the shared capability leaf
      // (@cinatra-ai/llm/openai-model-capabilities) so this route and the
      // chat runner gate (src/app/api/chat/shell-skill-gate.ts) cannot
      // drift apart. When the agent's preferredModel is shell-incompatible,
      // skill delivery degrades (see the else branch below) — the legacy
      // `read_skill` function-tool fallback is retired.
      const dispatchModel =
        dispatch.kind === "dispatch"
          ? (dispatch.preferredModel ?? "")
          : "";
      const modelSupportsShell = openAiModelSupportsShell(dispatchModel);
      if (modelSupportsShell) {
        // Bridge-side preflight: register the auto-discovered SKILL.md into
        // the catalog so its on-disk copy lives under the default
        // `data/skills` root — matching the chat path's
        // `ensureChatSkillRegistered`. This closes the bridge↔chat asymmetry
        // and eliminates the prior need to widen `readSkillFileContent`'s
        // containment with `allowedRoots`.
        const isCanonicalLayout = resolvedPath.includes(
          `${path.sep}cinatra-ai${path.sep}`,
        );
        const packageName = isCanonicalLayout
          ? `@cinatra-ai/${skillSlug}`
          : skillSlug;
        const skillId = `${packageName}:${skillSlug}`;
        let mountedSourcePath = resolvedPath;
        let mountedDirectoryPath = skillDirPath;
        try {
          const registered = await registerExtensionSkill({
            skillId,
            packageName,
            skillMdPath: resolvedPath,
          });
          mountedSourcePath = registered.sourcePath;
          mountedDirectoryPath = path.dirname(registered.sourcePath);
        } catch (err) {
          console.warn(
            `[bridge] registerExtensionSkill failed for ${skillId}; falling back to direct extension path:`,
            (err as Error).message,
          );
        }
        extraTools.push(
          createLocalSkillShellTool({
            mountedSkills: [
              {
                id: skillSlug,
                name: skillSlug,
                slug: skillSlug,
                description: "Agent skill instructions",
                sourcePath: mountedSourcePath,
                directoryPath: mountedDirectoryPath,
              },
            ],
          }),
        );
      } else {
        // Shell-incompatible model (gpt-5 / gpt-5-mini). The legacy
        // `read_skill` function-tool fallback has been retired to close
        // the catalog-bypass surface; no in-repo agent currently selects
        // these models. If a future agent does, skill delivery degrades to
        // no inline skill tool — the model still runs but without the
        // SKILL.md instructions via this surface.
        console.warn(
          `[bridge] shell-incompatible model "${dispatchModel}" — skill tool delivery degrades for agent slug "${skillSlug}"`,
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Run-context registry — stamps every objects_save call during this LLM step
  // with the Cinatra run id and agent provenance metadata.
  //
  // Client ID resolution: try to decode the Bearer JWT's sub/clientId claim
  // first (Python containers send A2A Bearer tokens); fall back to the
  // OAuth client ID from getLlmMcpCredentials (TS callers using bridge token
  // where no Authorization header is present).
  // ---------------------------------------------------------------------------
  // Resolve effective run ID — WayFlow Python containers always send
  // agent_run_id="" (empty string) because the StartNode binding bug prevents
  // the run ID from flowing into the DFE context. Fall back to the
  // X-Cinatra-A2A-Context-Id header (injected by the ContextVar patch in
  // agent_loader.py) which maps to a unique context_id per WayFlow task.
  // Artifact resolver ports MUST be built only from a request-bound run
  // resolved via the auth-injected x-cinatra-a2a-context-id header
  // (agent_loader.py inserts it). A caller-supplied body.agent_run_id alone
  // is forgeable and would let a bridge token select another tenant's orgId
  // as the resolver namespace. If BOTH context-id and body.agent_run_id
  // resolve, they MUST match.
  let runFromContext: Awaited<ReturnType<typeof readAgentRunByContextId>> = null;
  try {
    const a2aContextId = req.headers.get("x-cinatra-a2a-context-id");
    if (a2aContextId) {
      runFromContext = await readAgentRunByContextId(a2aContextId);
    }
  } catch {
    // non-fatal — fall through to body.agent_run_id fallback below
  }
  // Fallback: when context-id lookup misses (this happens on the FIRST
  // bridge call of a run because `updateAgentRunA2AContextId` only runs
  // AFTER WayFlow returns its first task event — by then the LLM step is
  // already past the boundary check), look up by the body's agent_run_id.
  //
  // TRUST MODEL — gated on `isBridgeAuthorized` (the WayFlow shared-secret
  // header `X-Cinatra-Bridge-Token`). The bridge-token gate proves the
  // request originated from the WayFlow runtime; only the worker-dispatched
  // run's `cinatra_run_id` gets propagated through the OAS DataFlowEdge into
  // `body.agent_run_id` for that runtime. A JWT-authed (non-bridge-token)
  // request CANNOT use this fallback because the JWT path is for
  // third-party A2A peers that don't have the worker-injected
  // `cinatra_run_id` provenance.
  //
  // A malicious OAS could rewrite `cinatra_run_id` through DataFlowEdge
  // into another tenant's run id, which would let the bridge mint an OBO
  // token for that tenant's `{runBy, orgId}`. The mitigations layered
  // against this:
  //   1. The bridge-token gate restricts the fallback to internal WayFlow
  //      traffic only (no external A2A peer can hit this branch).
  //   2. `resolveAgentRunMcpActor` does a LIVE membership check at mint
  //      time — a stale or cross-org `runBy` would fail there.
  //   3. The dispatcher always injects `cinatra_run_id: run.id` into the
  //      A2A initial message at `execution.ts:1271`, so well-formed
  //      agents propagate the correct run id end-to-end.
  // TODO(hardening): for production with un-vetted extension agents,
  // replace this fallback with a signed `X-Cinatra-Run-Binding` header
  // minted by the worker at dispatch (binding `{runId, orgId, runBy}` to
  // BETTER_AUTH_SECRET) so the OAS author can't rewrite the run id.
  //
  // Without this fallback, every first LLM step of every agent run gets
  // the anonymous machine-token MCP path, so `apollo_administration_get`
  // (and every other MCP call) fails at `enforceMcpBoundary` with
  // `not_org_member` — the regression that surfaced as Apollo agents
  // looping "not_connected" forever.
  if (
    !runFromContext &&
    isBridgeAuthorized &&
    typeof rawBody === "object" &&
    rawBody !== null &&
    "agent_run_id" in rawBody &&
    typeof (rawBody as { agent_run_id?: unknown }).agent_run_id === "string"
  ) {
    const bodyRunId = (rawBody as { agent_run_id: string }).agent_run_id;
    if (bodyRunId) {
      try {
        const runById = await readAgentRunById(bodyRunId);
        if (runById) {
          runFromContext = runById;
        }
      } catch {
        // non-fatal
      }
    }
  }
  let effectiveRunId = body.agent_run_id || undefined;
  if (!effectiveRunId && runFromContext?.id) {
    effectiveRunId = runFromContext.id;
  }
  // Run usable for building the artifact resolver ports — ONLY when bound
  // by the auth-injected context-id, and if body.agent_run_id is also
  // supplied it must match (otherwise refuse).
  let runForPorts: typeof runFromContext = runFromContext;
  if (
    body.agent_run_id &&
    runFromContext?.id &&
    body.agent_run_id !== runFromContext.id
  ) {
    runForPorts = null;
  }
  if (!runFromContext) {
    runForPorts = null;
  }

  let registryClientId: string | undefined;
  if (effectiveRunId) {
    try {
      let registryKey: string | undefined;
      const authorizationHeader = req.headers.get("authorization") ?? "";
      if (authorizationHeader) {
        const token = authorizationHeader.startsWith("Bearer ")
          ? authorizationHeader.slice("Bearer ".length).trim()
          : authorizationHeader.trim();
        const parts = token.split(".");
        if (parts.length === 3) {
          const jwtPayload = JSON.parse(
            Buffer.from(parts[1], "base64url").toString("utf8"),
          ) as Record<string, unknown>;
          registryKey =
            typeof jwtPayload.clientId === "string"
              ? jwtPayload.clientId
              : typeof jwtPayload.sub === "string"
                ? jwtPayload.sub
                : undefined;
        } else if (token) {
          registryKey = token;
        }
      }
      if (!registryKey) {
        const mcpCreds = getLlmMcpCredentials("openai");
        if (mcpCreds?.clientId) registryKey = mcpCreds.clientId;
      }
      if (registryKey) {
        registryClientId = registryKey;
        setRunContext(registryKey, {
          runId: effectiveRunId,
          agentId: body.agent_id,
          packageVersion: body.package_version,
          agentSpecVersion: body.agent_spec_version,
        });
      }
    } catch {
      // non-fatal — context propagation best-effort
    }
  }

  try {
    // Resolve custom skill delta + assigned base skill IDs for this agent.
    // Both lookups are INSIDE the try block so clearRunContext always runs
    // in finally even if a DB lookup throws.
    // Bridge callers (WayFlow ApiNodes, Python containers) have no user session,
    // so getCustomSkillForCurrentUserAndAgent throws when ownerUserId is
    // absent. Catch gracefully — no personal skill applies to sessionless callers.
    const [personalSkill, assignedSkillIds] = body.agent_id
      ? await Promise.all([
          getCustomSkillForCurrentUserAndAgent(body.agent_id).catch(() => null),
          getAssignedSkillIdsForAgent(body.agent_id),
        ])
      : [null, [] as string[]];

    // Provider dispatch overrides.
    // When kind === "dispatch", the helper picked an explicit
    // preferredProvider. When kind === "passthrough", we pass NO
    // preferredProvider / preferredModel so the orchestration helper takes
    // the backward-compatible path.
    const dispatchOverrides =
      dispatch.kind === "dispatch"
        ? {
            preferredProvider: dispatch.effectiveProvider,
            preferredModel: dispatch.preferredModel,
          }
        : {};

    // Telemetry only. requested_provider captures what
    // metadata.cinatra.llm.preferredProvider asked for (NULL when no
    // preference); effective_provider captures the provider that actually
    // dispatched. Both flow into the LlmUsageEvent emitted by the
    // orchestration layer and are persisted on usage_events by the
    // metric-cost subscriber. Honor-rate analytics: SELECT count(*)
    // FILTER (WHERE requested_provider = effective_provider) / count(*).
    const telemetryEffectiveProvider =
      dispatch.kind === "dispatch" ? dispatch.effectiveProvider : resolvedRuntime.provider;
    let result;
    try {
      // Partition the caller's `toolbox_ids` into MCP IDs vs built-in
      // provider tool names.
      // `resolveMcpToolsForDeclaredIds` (registry.ts) only handles
      // `"cinatra-mcp"` + external MCP server ids, so a built-in like
      // `"web_search"` would silently fall through. Built-in names are
      // mapped to provider tools and routed via `extraTools` instead.
      const allDeclaredToolboxIds = body.toolbox_ids ?? ["cinatra-mcp"];
      const builtInToolNames = allDeclaredToolboxIds.filter((id) =>
        BUILT_IN_BRIDGE_TOOLS.has(id),
      );
      const mcpToolboxIds = allDeclaredToolboxIds.filter(
        (id) => !BUILT_IN_BRIDGE_TOOLS.has(id),
      );
      for (const name of builtInToolNames) {
        if (name === "web_search") {
          // Provider-native web_search tool; OpenAI emits { type: "web_search" }.
          extraTools.push({ type: "web_search" });
        }
        // No-op for unknown built-ins — defensive guard for future additions.
      }
      // Parse the WayFlow text-only user envelope (`{text, attachments}`)
      // and merge with top-level body.attachments; build the resolver ports
      // scoped to run.orgId (NEVER the bridge-token actor's org, because
      // bridge tokens have no org). Without an orgId the ports stay undefined
      // and attachments degrade to the not-readable manifest (Decision A):
      // never silently dropped, never cross-tenant.
      let envelope: { text: string; attachments?: typeof body.attachments };
      try {
        envelope = parseUserEnvelope(
          body.user,
          body.user_envelope === true,
          body.attachments,
        );
      } catch (e) {
        // user_envelope=true + strict-parse failure is a 400, NEVER a
        // silent plain-text fallback.
        if (e instanceof UserEnvelopeParseError) {
          return NextResponse.json(
            { error: "invalid_user_envelope", code: "INVALID_USER_ENVELOPE", reason: e.message },
            { status: 400 },
          );
        }
        throw e;
      }
      // Ports are built ONLY from the request-bound runForPorts
      // (auth-injected x-cinatra-a2a-context-id); body.agent_run_id alone is
      // caller-controlled and cannot select the resolver namespace. When
      // runForPorts is null, ports stay undefined and the orchestration-layer
      // entry-resolver degrades attachments to the not-readable manifest:
      // never silently dropped, never cross-tenant ingested.
      let attachmentResolverPorts;
      if (
        envelope.attachments &&
        envelope.attachments.length > 0 &&
        runForPorts?.orgId
      ) {
        attachmentResolverPorts = buildBridgeAttachmentResolverPorts({
          orgId: runForPorts.orgId,
        });
      }
      // Build the cinatra-mcp delegated-token override ONLY when the
      // bridge has resolved a real agent_run row with both an `orgId`
      // and a `runBy`. The resolver does a LIVE platform-role +
      // membership check at mint time — a demoted user gets `null` and
      // the orchestration layer falls back to the legacy machine
      // `client_credentials` Bearer (same behavior as pre-fix, will
      // fail at `enforceMcpBoundary` with `not_org_member`, never an
      // elevation).
      const cinatraMcpToolOverride =
        runForPorts?.orgId &&
        runForPorts?.runBy &&
        runForPorts?.id &&
        (resolvedRuntime.provider === "openai" ||
          resolvedRuntime.provider === "anthropic")
          ? async () => {
              const actor = await resolveAgentRunMcpActor({
                runId: runForPorts.id,
                runBy: runForPorts.runBy!,
                orgId: runForPorts.orgId!,
                // cinatra#408 — LOAD-BEARING: the carrier run's source_type
                // drives the resolver's platform-admin suppression. For a
                // `public_site_widget` run this makes the actor resolve to
                // `member` (or null), NEVER `platform_admin`, so the MCP
                // boundary's platform-admin immediate-allow is never reached
                // and the end-user's rights gate the write (with #409).
                sourceType: runForPorts.sourceType,
              });
              if (!actor) return null;
              return buildLlmMcpServerToolForAgentRun(
                resolvedRuntime.provider as "openai" | "anthropic",
                actor,
                issueAgentRunMcpActorToken,
              );
            }
          : undefined;
      result = await runResolvedSkillAwareDeterministicLlmTask({
        runtime: resolvedRuntime,
        model: body.model_id,
        declaredToolboxIds: mcpToolboxIds,
        skillIds: assignedSkillIds,
        // This is the general selectable path (WayFlow
        // ApiNodes / Python containers; any admin-selected provider incl.
        // Anthropic). The recommendation agent may resolve >8 skills here, so
        // engage the deterministic rank-and-truncate-to-8 policy (vs the
        // creation path's fixed-allowlist hard cap). Drops surface via
        // `result.skillSelection` (returned in the JSON response below).
        skillSelectionMode: "general",
        customSkillContent: personalSkill?.content,
        system: body.system ?? "",
        user: envelope.text,
        maxSteps,
        outputSchema: body.output_schema,
        extraTools: extraTools.length > 0 ? extraTools : undefined,
        skipExternalMcpRegistry: true,
        logLabel: body.agent_id ?? "wayflow",
        actorContext: bridgeActorContext,
        telemetryRequestedProvider: dispatch.requestedProvider,
        telemetryEffectiveProvider,
        ...(cinatraMcpToolOverride ? { cinatraMcpToolOverride } : {}),
        ...(envelope.attachments
          ? { attachments: envelope.attachments }
          : {}),
        ...(attachmentResolverPorts ? { attachmentResolverPorts } : {}),
        ...dispatchOverrides,
      });
    } catch (err) {
      // Preferred-provider unavailability surfaces as a 503 when a
      // capability gate is set; the helper has already returned an error
      // outcome in that case so reaching here means the adapter was
      // available at resolve-time but disappeared by call-time.
      if (err instanceof PreferredProviderUnavailableError) {
        return NextResponse.json(
          {
            error: "preferred_provider_unavailable",
            code: "PREFERRED_PROVIDER_UNAVAILABLE",
            requestedProvider: err.requestedProvider,
            reason: err.reason,
          },
          { status: 503 },
        );
      }
      throw err;
    }

    const text = result.text ?? "";

    // Visible, non-silent surfacing of the general-path rank-and-truncate
    // decision. Set ONLY when the Anthropic delivery actually dropped
    // over-cap skills (absent for creation/≤8/OpenAI/Gemini). Returned on
    // the bridge response (machine-readable) AND logged.
    const skillSelection = result.skillSelection;
    if (skillSelection) {
      console.warn(
        `[llm-bridge] general-path Anthropic skill rank-and-truncate ` +
          `(agent=${body.agent_id ?? "wayflow"}): ` +
          `dropped=[${skillSelection.droppedSkillIds.join(",")}] — ` +
          `${skillSelection.selectionReason}`,
      );
    }

    try {
      const parsed = JSON.parse(text);
      return NextResponse.json(
        skillSelection && parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? { ...parsed, skillSelection }
          : skillSelection
            ? { output: parsed, skillSelection }
            : parsed,
      );
    } catch {
      return NextResponse.json(
        skillSelection ? { output: text, skillSelection } : { output: text },
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    const stack = err instanceof Error ? err.stack : undefined;
    console.error("[llm-bridge] LLM task failed:", message, stack);
    return NextResponse.json({ error: "Internal server error", detail: message }, { status: 500 });
  } finally {
    if (registryClientId) clearRunContext(registryClientId);
  }
}
