import "server-only";

import * as path from "node:path";
import { existsSync, realpathSync, readdirSync } from "node:fs";
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
  buildLlmMcpServerTool,
  getLlmMcpCredentials,
  PreferredProviderUnavailableError,
  type LlmTool,
  type LlmResponse,
} from "@cinatra-ai/llm";
import { resolveAgentRuntimeMountDir } from "@cinatra-ai/agents/agent-runtime-mount";
import {
  getCustomSkillForCurrentUserAndAgent,
  registerExtensionSkill,
} from "@cinatra-ai/skills";
import { getAssignedSkillIdsForAgent } from "@/lib/agents-store";
import {
  readAgentRunByContextId,
  readAgentRunById,
  readAgentRunByTokenHash,
  readAgentRunTokenHashById,
  readAgentTemplateById,
  OasCinatraLlmSchema,
  type LlmProvider,
} from "@cinatra-ai/agents";
import {
  deriveOboCeilingChain,
  oboCeilingContains,
} from "@cinatra-ai/mcp-server/obo-ceiling";
import { resolveAgentRunCinatraMcpAllowedTools } from "@cinatra-ai/mcp-server/in-admin-cms-tool-policy";
// #1214 — WHICH agent packages are in-admin CMS content editors is resolved by
// the host from the generated `relayAgentPackage` bindings (no extension
// instance named in the mcp-server policy module — core→extension coupling ban).
import { isInAdminCmsContentEditorPackage } from "@/lib/widget-stream-agents.server";
// Bridge resolver ports support the WayFlow text-only user envelope.
// resolveEntryAttachments() in the orchestration layer consumes the
// ports; without the run.orgId we cannot scope cache/blob reads so
// attachments degrade to the Decision-A manifest (turn proceeds).
import { buildBridgeAttachmentResolverPorts } from "./attachment-resolver-ports";
import { parseUserEnvelope, UserEnvelopeParseError } from "./user-envelope";
import { isAuthorizedBridgeRequest } from "@/lib/wayflow-bridge-auth";
import { verifyLangGraphBridgeToken } from "@/lib/a2a-auth";
import { setRunContext, clearRunContext } from "@/lib/agent-run-context-registry";
import {
  writeDurableRunContextBinding,
  clearDurableRunContextBindings,
} from "@/lib/agent-run-context-durable";
import { issueAgentRunMcpActorToken } from "@/lib/agent-run-mcp-actor-token";
import { resolveAgentRunMcpActor } from "@/lib/agent-run-actor-resolve";
import { verifyAgentRunBinding } from "@/lib/agent-run-binding";
import { verifyRunToken, RUN_TOKEN_HEADER } from "@/lib/agent-run-token";
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
  // Dispatcher-signed run binding. The worker mints this
  // at dispatch over the run's authoritative {runId, orgId, runBy} keyed by
  // BETTER_AUTH_SECRET and threads it alongside `cinatra_run_id` so the OAS
  // author cannot forge a cross-tenant run selection. Verified BEFORE any
  // run is selected for MCP OBO minting. `agent_run_id` alone is NEVER
  // authoritative for run selection.
  cinatra_run_binding: z.string().optional(),
  agent_id: z.string().optional(),
  package_version: z.string().optional(),
  agent_spec_version: z.string().optional(),
  // Per-agent model override — validated against ALLOWED_MODEL_IDS below.
  model_id: z.string().optional(),
  // Compiled toolbox IDs — filters MCP injection to only declared toolboxes.
  toolbox_ids: z.array(z.string()).optional(),
  // Structured output schema — passed through to the orchestration layer.
  output_schema: z.record(z.string(), z.unknown()).optional(),
  // Explicit SKILL.md path on the host filesystem. Must be under an allowed skill root
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
// text-dispatch branch (allowed-skill-roots containment, realpathSync against
// symlinks, *.md/SKILL.md suffix gate). Returns "" on any failure so the
// caller can safely concatenate.
//
// Important: this helper does NOT replace the legacy `extraTools` SKILL
// shell-tool injection — the text-dispatch path continues to use that.
// This helper exists so the media branch (which goes direct to the Gemini
// adapter, NOT through runResolvedSkillAwareDeterministicLlmTask) can still
// inject SKILL.md instructions via `system`.
// ---------------------------------------------------------------------------
// Shared containment allowlist for bridge skill paths (cinatra#793): a
// resolved SKILL.md must live under EITHER the dev/authoring tree (cwd — the
// historical root; explicit skill_source_path inputs) OR the agent RUNTIME
// MOUNT (`<extension-data-root>/.agent-mount` — where installed agents'
// skills/ trees are projected, and where auto-discovery now resolves).
// path.relative(root, p) escapes a root when it starts with ".." or is
// absolute; empty rel ("" — candidate equals the root) counts as inside.
// Single filesystem-safe path segment (cinatra#1196). Mirrors the inline guard
// the sibling run-mount slice (13bb6b97) added to `read-llm-requirement-from-
// mount.ts` / `input-schema-resolver.ts`: rejects `.`/`..`/separators/backslash
// so a segment can never escape the mount before it is join()ed. Kept INLINE
// (no `@cinatra-ai/registries` barrel import) — this route module is in the
// run-start route graph and the no-new-rot dev-perf ratchet is exact.
function isSafeMountSegment(s: string): boolean {
  return (
    s !== "." &&
    s !== ".." &&
    /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9-])?$/.test(s)
  );
}

// Conventional SKILL.md auto-discovery for an agent id (cinatra#793).
//
// Scope-derived multi-vendor (cinatra#1196): the request carries only the BARE
// agent slug (never a `@vendor/slug` — the caller guard rejects any `/`), so the
// vendor cannot be split off the name the way the sibling run-mount slice does.
// Instead the vendor scope is DERIVED from the projection actually on disk: each
// root is probed for the first-party `<root>/cinatra-ai/<slug>/skills/<slug>/
// SKILL.md` FIRST (first-party precedence is byte-identical to the legacy
// single-vendor probe), and only on a first-party miss do we consider the OTHER
// vendor dirs projected under the mount (`<root>/<vendor>/<slug>/…`), each vendor
// segment validated filesystem-safe. Because a bare slug cannot disambiguate two
// vendors shipping the same slug, resolution FAILS CLOSED when 2+ vendor dirs
// project the slug (returns the non-existent first-party path — the downstream
// existsSync gate then rejects it, identical to a probe-miss). The legacy flat
// `<root>/<slug>/…` fallback is preserved when no vendor projects the slug.
// No registries import (the route-graph ratchet).
function discoverBridgeSkillPath(agentId: string): string {
  // Defense-in-depth: a `.`-only / otherwise-unsafe slug (which the caller's
  // `..`/`/`/`\\` guard lets through) must not collapse into a probe path.
  if (!isSafeMountSegment(agentId)) return "";

  const firstPartyCandidates: string[] = [];
  const vendorCandidates: string[] = [];
  const flatCandidates: string[] = [];
  for (const root of [resolveAgentRuntimeMountDir(), path.join(process.cwd(), "extensions")]) {
    firstPartyCandidates.push(
      path.join(root, "cinatra-ai", agentId, "skills", agentId, "SKILL.md"),
    );
    let vendors: string[] = [];
    try {
      vendors = readdirSync(root, { withFileTypes: true })
        .filter(
          (e) =>
            e.isDirectory() &&
            e.name !== "cinatra-ai" &&
            isSafeMountSegment(e.name),
        )
        .map((e) => e.name)
        .sort();
    } catch {
      // Root absent / unreadable — no additional vendors from this root.
    }
    for (const vendor of vendors) {
      vendorCandidates.push(
        path.join(root, vendor, agentId, "skills", agentId, "SKILL.md"),
      );
    }
    flatCandidates.push(
      path.join(root, agentId, "skills", agentId, "SKILL.md"),
    );
  }

  // First-party precedence — unchanged from the single-vendor probe.
  for (const candidate of firstPartyCandidates) {
    if (existsSync(candidate)) return candidate;
  }
  // Scope-derived multi-vendor: resolve ONLY when exactly one vendor projects
  // the slug. 2+ = ambiguous (no vendor in the bare-slug request to pick one) →
  // fail closed to the miss path below.
  const vendorHits = vendorCandidates.filter((c) => existsSync(c));
  if (vendorHits.length === 1) return vendorHits[0];
  if (vendorHits.length === 0) {
    for (const candidate of flatCandidates) {
      if (existsSync(candidate)) return candidate;
    }
  }
  // Miss (or ambiguous multi-vendor): the first-party canonical path — the
  // downstream existsSync gate rejects it (identical to the legacy fallback).
  return firstPartyCandidates[0];
}

// Derive the extension package name from a RESOLVED SKILL.md path (cinatra#1196).
// Scope-derived multi-vendor replacement for the old `resolvedPath.includes(
// "/cinatra-ai/")` substring test (which mislabelled EVERY dev-tree path because
// the repo itself lives under a `cinatra-ai/` folder). The vendor is the first
// segment under whichever skill root contains the file, in the exact projection
// shape `<root>/<vendor>/<slug-dir>/skills/<skill-dir>/SKILL.md`; the package
// slug stays `skillSlug` (the SKILL.md's own dir — the agent dir and skill dir
// legitimately differ, e.g. `email-delivery-agent`/`email-delivery`). `cwd` is
// deliberately NOT a root here (a bare `packages/<x>/skills/<x>/SKILL.md` would
// mislabel `packages` as a vendor). Anything not matching the canonical shape
// (legacy-flat, arbitrary explicit `skill_source_path`) has no vendor scope and
// resolves to the bare slug. Inline; no registries import (route-graph ratchet).
function deriveSkillPackageName(resolvedPath: string, skillSlug: string): string {
  if (isSafeMountSegment(skillSlug)) {
    for (const root of [
      resolveAgentRuntimeMountDir(),
      path.join(process.cwd(), "extensions"),
    ]) {
      const rel = path.relative(root, resolvedPath);
      if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) continue;
      const seg = rel.split(path.sep);
      if (
        seg.length === 5 &&
        seg[2] === "skills" &&
        seg[4] === "SKILL.md" &&
        isSafeMountSegment(seg[0])
      ) {
        return `@${seg[0]}/${skillSlug}`;
      }
    }
  }
  return skillSlug;
}

function isInsideBridgeSkillRoots(resolvedPath: string): boolean {
  const roots = [process.cwd(), resolveAgentRuntimeMountDir()];
  return roots.some((root) => {
    const rel = path.relative(root, resolvedPath);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  });
}

async function resolveBridgeSkillContent(body: {
  agent_id?: string;
  skill_source_path?: string;
}): Promise<string> {
  // Resolve a candidate path (explicit input OR conventional auto-discovery).
  const autoDiscoverSkillPath = discoverBridgeSkillPath;
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

  // Path-traversal guard: must resolve under an allowed skill root (the dev
  // tree OR the agent runtime mount) AND end with SKILL.md.
  let resolvedPath: string;
  try {
    resolvedPath = realpathSync(path.resolve(candidateSkillPath));
  } catch {
    resolvedPath = path.resolve(candidateSkillPath);
  }
  if (
    !candidateSkillPath.endsWith("SKILL.md") ||
    !isInsideBridgeSkillRoots(resolvedPath) ||
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
    // allowlist includes `youtube-nocookie.com`. The test suite covers this
    // helper directly.
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
  // Path traversal guard: must be under an allowed skill root and end with SKILL.md.
  // ---------------------------------------------------------------------------
  const extraTools: LlmTool[] = [];

  // Both branches (explicit skill_source_path and auto-discovery via agent_id)
  // feed into the same path.relative containment check below, so a malicious
  // agent_id like "../../etc" is also rejected.
  //
  // Auto-discovery probes the canonical layout first
  // (<installDir>/cinatra-ai/<slug>/skills/<slug>/SKILL.md), then the
  // fallback layout (<installDir>/<slug>/skills/<slug>/SKILL.md).
  const autoDiscoverSkillPath = discoverBridgeSkillPath;
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
    // Path traversal containment against the allowed skill roots (dev tree OR
    // the agent runtime mount — cinatra#793).
    // realpathSync resolves symlinks so a symlink inside a root pointing
    // outside it is caught by the path.relative check.
    // Falls back to lexical path.resolve when the path doesn't exist yet
    // (existsSync below will reject it anyway).
    let resolvedPath: string;
    try {
      resolvedPath = realpathSync(path.resolve(candidateSkillPath));
    } catch {
      resolvedPath = path.resolve(candidateSkillPath);
    }
    if (
      candidateSkillPath.endsWith("SKILL.md") &&
      isInsideBridgeSkillRoots(resolvedPath) &&
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
        // Scope-derived multi-vendor package name (cinatra#1196): the vendor is
        // read from the resolved path's projection shape, not a `/cinatra-ai/`
        // substring. First-party canonical paths still yield `@cinatra-ai/<slug>`
        // byte-identically; an operator/third-party `<mount>/<vendor>/<slug>/…`
        // now yields `@<vendor>/<slug>` instead of collapsing to a bare slug.
        const packageName = deriveSkillPackageName(resolvedPath, skillSlug);
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
  // the run ID from flowing into the DFE context.
  //
  // #1193 run-token spine (W3) — resolve the run TOKEN-FIRST off the ONE
  // dispatch-minted credential before the legacy context-id / dispatcher-signed
  // binding channels. The loader attaches X-Cinatra-Run-Token on the host-
  // anchored llm-bridge call (a per-task ContextVar the OAS author cannot
  // write); the verifier hashes it and resolves the run by the unique index
  // (never a body id). Semantics, mirroring the context route (W2) and the
  // durable-binding posture (#1195):
  //   - token ABSENT            ⇒ the legacy context-id + binding paths below
  //                               run UNCHANGED (additive + reversible against
  //                               the not-yet-rebuilt WayFlow image);
  //   - token PRESENT+resolved  ⇒ it selects the run; a co-present context-id
  //                               MUST name the same run or OBO is refused;
  //   - token PRESENT+unresolvable (or a probe/re-read divergence) ⇒ FAIL
  //                               CLOSED: suppress the weaker context-id +
  //                               binding channels and degrade to the anonymous
  //                               machine-token path — never downgrade a
  //                               tampered token to a forgeable selector.
  let runFromToken: Awaited<ReturnType<typeof readAgentRunById>> = null;
  let tokenResolvedRunId: string | undefined;
  let runTokenInvalid = false;
  // Only consult the verifier when the loader actually attached the credential
  // on this host-anchored call. A null/empty header is the "absent" case — the
  // legacy context-id + binding paths below then run entirely UNCHANGED
  // (additive + reversible against the not-yet-rebuilt WayFlow image).
  const rawRunToken = isBridgeAuthorized
    ? req.headers.get(RUN_TOKEN_HEADER)
    : null;
  if (rawRunToken) {
    const tokenResult = await verifyRunToken(rawRunToken, readAgentRunByTokenHash);
    if (tokenResult.ok) {
      try {
        // Re-read the FULL row by the SERVER-DERIVED id (the unique-index probe
        // returns {id,orgId,runBy} only; the resolver ports + the OBO mint need
        // the whole record). Deny on any divergence between the probe and the
        // fresh read (fail closed) — never a body id.
        const runById = await readAgentRunById(tokenResult.run.id);
        if (
          runById &&
          runById.id === tokenResult.run.id &&
          runById.orgId === tokenResult.run.orgId &&
          runById.runBy === tokenResult.run.runBy
        ) {
          runFromToken = runById;
          tokenResolvedRunId = runById.id;
        } else {
          runTokenInvalid = true;
        }
      } catch {
        runTokenInvalid = true;
      }
    } else if (tokenResult.reason === "unresolvable") {
      // Present-but-unresolvable ⇒ fail closed (a non-empty token that hashes to
      // no row is tampering / a bug, never a legacy dispatch).
      runTokenInvalid = true;
    }
  }

  // Legacy channel — the auth-injected X-Cinatra-A2A-Context-Id header
  // (agent_loader.py inserts it), mapping to a unique context_id per WayFlow
  // task. Read unconditionally so a resolved token can cross-check it, but it
  // only SELECTS a run when no token was presented. Artifact resolver ports
  // MUST be built only from a request-bound run; a caller-supplied
  // body.agent_run_id alone is forgeable and would let a bridge token select
  // another tenant's orgId as the resolver namespace. If BOTH context-id and
  // body.agent_run_id resolve, they MUST match.
  let runFromContextId: Awaited<ReturnType<typeof readAgentRunByContextId>> =
    null;
  try {
    const a2aContextId = req.headers.get("x-cinatra-a2a-context-id");
    if (a2aContextId) {
      runFromContextId = await readAgentRunByContextId(a2aContextId);
    }
  } catch {
    // non-fatal — fall through to the binding / body.agent_run_id paths below
  }

  // Selection precedence: run-token (W3) > context-id > dispatcher-signed
  // binding. A resolved token wins; a co-present context-id that names a
  // DIFFERENT run refuses OBO selection (the W2 divergence invariant carried to
  // the bridge). An invalid token suppresses the context-id channel entirely.
  let runFromContext: Awaited<ReturnType<typeof readAgentRunByContextId>> = null;
  let runTokenDivergent = false;
  if (runFromToken) {
    runFromContext = runFromToken;
    if (runFromContextId && runFromContextId.id !== runFromToken.id) {
      runTokenDivergent = true;
    }
  } else if (!runTokenInvalid) {
    runFromContext = runFromContextId;
  }
  // Fallback for the FIRST bridge call of a run. The context-id lookup
  // misses on the first call because `updateAgentRunA2AContextId` only runs
  // AFTER WayFlow returns its first task event — by then the LLM step is
  // already past the boundary check. To still mint a scoped MCP OBO token
  // for that step we must select the run from request data.
  //
  // SECURITY. `body.agent_run_id` is NEVER trusted as a
  // run-selection source: it is threaded from `cinatra_run_id` through the
  // OAS DataFlowEdge, which a malicious/compromised OAS author can rewrite
  // to another tenant's run id (confused-deputy → cross-tenant OBO mint).
  // The downstream live membership check validates the SELECTED run's
  // identity, not the caller's entitlement to select it, so it does not
  // stop this alone.
  //
  // Instead we require a DISPATCHER-SIGNED run binding (`cinatra_run_binding`)
  // minted by the worker at dispatch over the run's authoritative
  // {runId, orgId, runBy} keyed by BETTER_AUTH_SECRET (a key never exposed
  // to OAS). The binding is verified BEFORE any run is selected; the run is
  // then read by the VERIFIED runId and the freshly-read row must match the
  // binding's orgId/runBy. A malicious OAS can drop/corrupt the binding —
  // degrading to the anonymous machine-token MCP path (the same
  // `not_org_member` outcome as no run, never an elevation) — but cannot
  // forge a binding for a run it does not own.
  //
  // The fallback stays gated on `isBridgeAuthorized` (the WayFlow
  // shared-secret `X-Cinatra-Bridge-Token`) as the first gate: a JWT-authed
  // third-party A2A peer cannot reach it. The signed binding is the second,
  // forgery-proof gate that closes the confused-deputy path the bridge-token
  // gate alone left open.
  let bindingVerifiedRunId: string | undefined;
  if (
    !runFromContext &&
    !runTokenInvalid &&
    isBridgeAuthorized &&
    typeof body.cinatra_run_binding === "string" &&
    body.cinatra_run_binding.length > 0
  ) {
    const verified = verifyAgentRunBinding(body.cinatra_run_binding);
    if (verified.ok) {
      try {
        // Read the run by the SIGNED runId (never a raw body id) and confirm
        // the freshly-read row matches the binding's identity tuple. A
        // mismatch (e.g. the run's owner/org changed, or the binding was
        // crafted for a non-existent run) refuses selection.
        const runById = await readAgentRunById(verified.payload.runId);
        if (
          runById &&
          runById.id === verified.payload.runId &&
          runById.orgId === verified.payload.orgId &&
          runById.runBy === verified.payload.runBy
        ) {
          runFromContext = runById;
          bindingVerifiedRunId = runById.id;
        }
      } catch {
        // non-fatal — degrade to anonymous machine-token path
      }
    }
  }
  // `effectiveRunId` drives the best-effort run-context registry wiring used
  // for objects_save run tagging. It may use the caller-supplied
  // body.agent_run_id (no token minting depends on it) but prefers the
  // binding-verified / context-resolved run id when available.
  // An invalid/tampered token suppresses even the best-effort run-context
  // registry tagging (never let a bad token drive tagging off a body id).
  const effectiveRunId = runTokenInvalid
    ? undefined
    : bindingVerifiedRunId || runFromContext?.id || body.agent_run_id || undefined;
  // Run usable for building the artifact resolver ports AND for minting the
  // MCP OBO actor token — ONLY a run resolved via the auth-injected
  // context-id OR a verified dispatcher-signed binding. `body.agent_run_id`
  // can NEVER promote a run into `runForPorts`. If a context-id resolved a
  // run AND body.agent_run_id disagrees, refuse (defense in depth).
  let runForPorts: typeof runFromContext = runFromContext;
  if (
    body.agent_run_id &&
    runFromContext?.id &&
    body.agent_run_id !== runFromContext.id &&
    bindingVerifiedRunId !== runFromContext.id &&
    tokenResolvedRunId !== runFromContext.id
  ) {
    // A non-empty body.agent_run_id that disagrees with the selected run refuses
    // OBO — UNLESS the run was established by an authoritative credential (the
    // dispatcher-signed binding or, W3, the run token), which outranks a
    // forgeable body id.
    runForPorts = null;
  }
  if (runTokenDivergent) {
    // Token-selected run but a co-present context-id named a DIFFERENT run.
    runForPorts = null;
  }
  if (!runFromContext) {
    runForPorts = null;
  }

  // #1193 run-token spine (W3) — which-path-served metric for the legacy-
  // removal gate (a follow-up retires the context-id + binding precedence once
  // the run-token path dominates production). Ids and outcome flags only — the
  // raw token and its hash are NEVER logged.
  if (isBridgeAuthorized) {
    const runSelectServedBy: "run_token" | "binding" | "context_id" | "none" =
      tokenResolvedRunId
        ? "run_token"
        : bindingVerifiedRunId
          ? "binding"
          : runFromContext
            ? "context_id"
            : "none";
    console.info(
      `[llm-bridge-run-select] served-by=${runSelectServedBy} ` +
        `run=${runForPorts?.id ?? "-"} org=${runForPorts?.orgId ?? "-"} ` +
        `token-invalid=${runTokenInvalid} token-divergent=${runTokenDivergent}`,
    );
  }

  let registryClientId: string | undefined;
  // #1195 — redis keys of the durable run-context bindings THIS request wrote
  // (one per machine-token mint inside cinatraMcpToolOverride below). Keys are
  // per-invocation-unique, so the finally-clear can plain-DEL exactly these.
  const durableBindingKeys: string[] = [];
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
    // #1360 — the personal delta skill is USER-SCOPED content, so its owner is
    // derived SOLELY from the TRUSTED resolved run context, never from a
    // caller-supplied identifier. `runForPorts` is the exact run this route
    // already vetted to mint the user's MCP OBO actor token (run-token-first →
    // context-id → dispatcher-signed binding, minus the confused-deputy
    // disqualifications); its `runBy` is the verified run owner. Gating personal
    // delivery on that same handle keeps it FAIL CLOSED:
    //   - a verified run bound to a user ⇒ that user's delta is delivered;
    //   - an unattributable call (no verified run, or a run with no runBy), or a
    //     forged / mismatched / divergent run token (runForPorts is null) ⇒
    //     `personalSkillOwnerUserId` stays undefined, so
    //     getCustomSkillForCurrentUserAndAgent resolves to none — it throws for
    //     an absent owner outside dev-bypass and the .catch swallows that to
    //     null (no personal delta, no error noise), never a guess.
    // Org/shared skill delivery (getAssignedSkillIdsForAgent) is unchanged: it
    // is agent-scoped, not user-scoped, and never consulted the run owner.
    const personalSkillOwnerUserId =
      typeof runForPorts?.runBy === "string" && runForPorts.runBy.length > 0
        ? runForPorts.runBy
        : undefined;
    const [personalSkill, assignedSkillIds] = body.agent_id
      ? await Promise.all([
          getCustomSkillForCurrentUserAndAgent(
            body.agent_id,
            personalSkillOwnerUserId,
          ).catch(() => null),
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
      // the override falls back to the machine `client_credentials`
      // Bearer it now mints itself (same authz outcome as pre-fix, will
      // fail at `enforceMcpBoundary` with `not_org_member`, never an
      // elevation).
      //
      // The provider gate keys on the provider the task actually RUNS on
      // (#1195 codex round-1): a `cinatra_llm` dispatch overrides the
      // configured runtime, and the orchestration attaches MCP tools for
      // THAT provider. Gating on the configured provider would silently
      // skip the OBO + durable-binding path whenever dispatch diverges
      // (configured gemini, dispatched openai), leaving that run's machine
      // token unbound on the alias-prone process-local registry.
      const mcpEffectiveProvider =
        dispatch.kind === "dispatch"
          ? dispatch.effectiveProvider
          : resolvedRuntime.provider;
      const cinatraMcpToolOverride =
        runForPorts?.orgId &&
        runForPorts?.runBy &&
        runForPorts?.id &&
        (mcpEffectiveProvider === "openai" ||
          mcpEffectiveProvider === "anthropic")
          ? async () => {
              // #1195 durable run-context binding — the machine-token fallback,
              // minted HERE (byte-identical to the orchestration-layer fallback
              // in packages/llm/src/registry.ts resolveCinatraMcpTool) so the
              // bridge can read the exact per-mint access token back off the
              // tool and key the durable binding to it. Every token-endpoint
              // mint carries a random `jti`, so the key is unique per mint:
              // concurrent runs can never alias each other's binding, and the
              // finally-clear's plain DEL can never delete another request's.
              // The binding value is the run's dispatch-minted credential HASH
              // (never a raw run id): the MCP reader resolves it back through
              // readAgentRunByTokenHash, keeping the run ROW the source of
              // truth. Legacy runs without a credential hash write nothing and
              // stay on the in-process registry (the measured transition
              // fallback). Redis failure ⇒ no binding, same registry fallback:
              // availability is never worse than today.
              const buildMachineToolWithDurableBinding = async () => {
                // Byte-equivalence with the orchestration fallback this
                // replaces requires the EFFECTIVE provider (the gate above
                // already keys on it): registry.ts would have minted the
                // machine token for the OAuth client of the provider the
                // task actually runs on.
                const machineTool = await buildLlmMcpServerTool(
                  mcpEffectiveProvider,
                );
                if (!machineTool) return null;
                try {
                  const authorization = machineTool.headers?.Authorization;
                  const bearer =
                    typeof authorization === "string" &&
                    authorization.startsWith("Bearer ")
                      ? authorization.slice("Bearer ".length)
                      : undefined;
                  if (bearer) {
                    const runTokenHash = await readAgentRunTokenHashById(
                      runForPorts.id,
                    );
                    if (runTokenHash) {
                      const key = await writeDurableRunContextBinding(bearer, {
                        tokenHash: runTokenHash,
                        // Untrusted provenance for tagging only — mirrors the
                        // legacy registry payload; never an authz input.
                        agentId: body.agent_id,
                        packageVersion: body.package_version,
                        agentSpecVersion: body.agent_spec_version,
                      });
                      if (key) durableBindingKeys.push(key);
                    }
                  }
                } catch {
                  // best-effort — binding absent ⇒ registry fallback covers.
                }
                return machineTool;
              };
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
              if (!actor) return buildMachineToolWithDurableBinding();
              // Re-derive the OBO scope-ceiling from the run's LOCKED template
              // anchor + project launch and compare (containment) against the
              // persisted dispatch ceiling. A corrupt anchor, or a persisted
              // chain that does NOT contain every re-derived element (or is
              // missing entirely), FAILS CLOSED — return null so the caller
              // falls back to the machine token (denied at the boundary). This
              // is the existing demoted-user fallback and is strictly safer than
              // minting an un-ceilinged OBO token; never an elevation. On pass,
              // mint the PERSISTED chain (a superset carrying composed-child
              // parent elements the mint path cannot re-derive), not the
              // re-derived subset. Agent-run OBO tokens ONLY.
              const template = await readAgentTemplateById(runForPorts.templateId);
              const recomputed = deriveOboCeilingChain({
                ownerLevel: template?.ownerLevel ?? null,
                ownerId: template?.ownerId ?? null,
                orgId: runForPorts.orgId!,
                projectId: runForPorts.projectId,
              });
              if (
                !recomputed ||
                !oboCeilingContains(runForPorts.oboCeiling, recomputed)
              ) {
                return buildMachineToolWithDurableBinding();
              }
              // #1214 — pin the cinatra self-MCP tool allowlist for in-admin
              // CMS content-editor agent runs (wordpress-agent / drupal-agent)
              // to the MCP-backed CMS primitives, so a dispatched content
              // editor cannot reach the neighbouring WordPress primitives that
              // remain direct-REST-backed (status/list/delete/media/draft/meta).
              // Any other agent run resolves to `null` (unrestricted, unchanged).
              const cinatraMcpAllowedTools =
                resolveAgentRunCinatraMcpAllowedTools(
                  // RUN-LEVEL STICKY PIN first (widget-stream runtime trust,
                  // slice 2): a `public_site_widget` carrier run IS an
                  // in-admin CMS content-editor relay by construction, so it
                  // stays CMS-pinned for its whole lifetime — a runtime grant
                  // revoked/drifted AFTER run creation (or a transient
                  // runtime-arm lookup failure) can never widen a live
                  // widget-carrier run to unrestricted self-MCP access. The
                  // async package-membership check (the widget-stream UNION:
                  // build map ∪ approved runtime grants) covers the
                  // non-widget dispatch surfaces of the same relay agents.
                  runForPorts.sourceType === "public_site_widget" ||
                    // ...same construction argument for the headless/legacy
                    // content-editor carrier discriminator.
                    runForPorts.sourceType === "content_editor_dispatch" ||
                    (await isInAdminCmsContentEditorPackage(
                      template?.packageName,
                    )),
                );
              const oboTool = await buildLlmMcpServerToolForAgentRun(
                mcpEffectiveProvider as "openai" | "anthropic",
                { ...actor, oboCeiling: runForPorts.oboCeiling! },
                issueAgentRunMcpActorToken,
                cinatraMcpAllowedTools,
              );
              // The OBO token carries the run id itself (the reader's
              // delegated-actor path wins) — no durable binding needed.
              if (oboTool) return oboTool;
              return buildMachineToolWithDurableBinding();
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
    // #1195 — clear exactly the durable bindings this request wrote (keys are
    // per-invocation-unique; the 300s TTL is the crash backstop).
    if (durableBindingKeys.length > 0) {
      await clearDurableRunContextBindings(durableBindingKeys);
    }
  }
}
