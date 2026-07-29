import "server-only";

import * as path from "node:path";
import { existsSync, realpathSync, readdirSync, statSync } from "node:fs";
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
  isRuntimeDeliverableLifecycleState,
  readSkillsCatalog,
  registerExtensionSkill,
  resolveDeclaredSkillEdgeForExtensionDir,
} from "@cinatra-ai/skills";
import { getAssignedSkillIdsForAgent } from "@/lib/agents-store";
import { readSkillLifecycleStates } from "@/lib/database";
import {
  recordSkillExposure,
  recordSkillInjectionDrops,
  incrementSkillInvocation,
  type SkillKind,
} from "@/lib/agent-run-skills-used";
import { readRunSelectedSkillRevisions } from "@/lib/run-selected-skill-revisions";
import {
  resolveInjectedSkillSet,
  injectedPersonalDelta,
  extractOneHopReferences,
  planInlineExpansion,
  resolveInlineSkillBudgetBytes,
  type InjectedSkillDrop,
  type InjectionAuthorization,
  type InjectionPersonalDelta,
  type InjectionResolverPorts,
  type InjectionSkillRef,
} from "@cinatra-ai/skills/injection";
import { resolveSurfaceExecutionBinding } from "@/lib/execution/surface-execution-session";
import {
  readAgentRunByContextId,
  readAgentRunById,
  readAgentRunByTokenHash,
  readAgentRunTokenHashById,
  readAgentTemplateById,
  OasCinatraLlmSchema,
  type LlmProvider,
} from "@cinatra-ai/agents";
// llm-providers S1 (#1712, AC4): the native-MCP OBO/durable-binding gate keys on
// the DECLARED capability matrix (single source of truth) rather than a
// hardcoded provider-id union — a provider carries native MCP iff its
// declaration satisfies `native_mcp`. Behavior-identical under the build-known
// catalog (openai|anthropic ⇔ native_mcp). The host app sits above both
// `@cinatra-ai/agents` and `@cinatra-ai/llm`, so importing the agents policy
// here does not invert the package layering.
import { canProviderSatisfyCapability } from "@cinatra-ai/agents/llm-provider-policy";
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
import {
  resolveAgentRunMcpActor,
  resolveAssignedSkillsActorForRun,
} from "@/lib/agent-run-actor-resolve";
import { verifyAgentRunBinding } from "@/lib/agent-run-binding";
import { verifyRunToken, RUN_TOKEN_HEADER } from "@/lib/agent-run-token";
// exec-plane S3 A2 (cinatra#1708): the run-seam fail-closed decision matrix that
// resolves a run's DECLARED L1 environment into a mountable layer + broker
// executor (or refuses a declared env that cannot be honored — never a silent L0
// downgrade). Reaches the execution service through a lightweight DI slot.
import { resolveRunExecutionBinding } from "@/lib/execution/resolve-run-execution-binding";
// …fed from ALL THREE declared-environment sources the epic names (packaged
// manifest / pinned version snapshot / live template config). Supplying fewer
// is a fail-open: an unsupplied source reads as "declared nothing" and the run
// executes on L0.
import { resolveRunEnvironmentSources } from "@/lib/execution/resolve-run-environment-sources";
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

// ---------------------------------------------------------------------------
// Lifecycle runtime-delivery gates (A3, cinatra#1363)
// ---------------------------------------------------------------------------

/**
 * FAIL-CLOSED lifecycle gate for a single already-resolved skill id (the
 * personal-delta path). True only when the lifecycle read succeeds AND the
 * state is runtime-deliverable (active/deprecated, or a derived NULL). A read
 * error, a missing row, or a draft/archived/unknown state → false (withheld).
 */
function isBridgeSkillRuntimeDeliverable(skillId: string): boolean {
  const r = readSkillLifecycleStates([skillId]);
  return (
    r.ok &&
    isRuntimeDeliverableLifecycleState(r.states.has(skillId) ? r.states.get(skillId) : undefined)
  );
}

/**
 * FAIL-CLOSED lifecycle gate for a bridge skill delivered by FILESYSTEM PATH.
 * Only an EXPLICIT `skill_source_path` can resolve to a custom/personal skill's
 * on-disk SKILL.md (auto-discovery probes only the extension/agent mount, whose
 * skills are derived); callers apply this ONLY for the explicit-path case. When
 * `resolvedPath` is the sourcePath of a custom/personal skill, its
 * lifecycle_state governs delivery — an archived/draft skill's bytes are never
 * delivered as direct content or a shell-injected skill. A path that is not a
 * catalog custom skill (extension mount / dev tree) is derived → deliverable.
 * A catalog-read failure fails closed (the path could be a custom skill).
 */
async function isBridgeSkillPathRuntimeDeliverable(resolvedPath: string): Promise<boolean> {
  let skillId: string | undefined;
  try {
    const catalog = await readSkillsCatalog();
    // Match the path to ANY catalog skill (personal OR team/org/project custom —
    // whose `isCustomSkill` flag is often unset while their state is non-null —
    // AND extension/derived skills). The lifecycle_state of whatever skill owns
    // the path is the authority: a non-null draft/archived state (custom of any
    // tier) is withheld; a NULL state (derived/extension) delivers. Classifying
    // "is it custom?" is unnecessary — the state column already encodes it.
    for (const s of catalog.skills as Array<{ id: string; sourcePath?: string }>) {
      if (typeof s.sourcePath !== "string" || s.sourcePath.length === 0) continue;
      let sp: string;
      try {
        sp = realpathSync(path.resolve(s.sourcePath));
      } catch {
        sp = path.resolve(s.sourcePath);
      }
      if (sp === resolvedPath) {
        skillId = s.id;
        break;
      }
    }
  } catch {
    // Catalog unreadable ⇒ cannot rule out a non-deliverable skill ⇒ fail closed.
    return false;
  }
  // The path is not a catalog skill at all (raw dev-tree file) ⇒ deliverable.
  if (!skillId) return true;
  // Otherwise gate on the owning skill's lifecycle_state (NULL/derived and
  // active/deprecated deliver; draft/archived/unknown are withheld, fail-closed).
  return isBridgeSkillRuntimeDeliverable(skillId);
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
  let candidateSkillPath = body.skill_source_path
    ? body.skill_source_path
    : body.agent_id && !agentIdLooksLikePath
      ? autoDiscoverSkillPath(body.agent_id)
      : "";
  // Declared-edge projection (cinatra#2090 S3): an extension that no longer
  // EMBEDS its bundle names the skill extension it depends on. Consulted only
  // when the co-located probe missed, so an agent that still ships its own
  // bundle resolves byte-identically to before.
  if (
    !body.skill_source_path &&
    body.agent_id &&
    !agentIdLooksLikePath &&
    !existsSync(candidateSkillPath)
  ) {
    const edge = await resolveDeclaredSkillEdgeForExtensionDir(body.agent_id);
    if (edge) candidateSkillPath = edge.sourcePath;
  }
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

  // A3 (cinatra#1363): an EXPLICIT skill_source_path can resolve to a custom/
  // personal skill's SKILL.md — withhold it when its lifecycle_state is not
  // runtime-deliverable (archived/draft/unknown). Auto-discovered paths resolve
  // only the extension/agent mount (derived) and skip the catalog lookup.
  if (body.skill_source_path && !(await isBridgeSkillPathRuntimeDeliverable(resolvedPath))) {
    return "";
  }

  // Read the router + its ONE-HOP references. cinatra#2091 S4: the media branch
  // is the ONE place a skill reaches an INLINE-mechanism provider (Gemini) as
  // literal system text, and until now it inlined the SKILL.md body ALONE — a
  // router that says "read references/guide.md" pointed at a file the model
  // could never reach on that provider. The expansion runs through the SAME
  // core planner the entry points use (whole-file granularity, per-request byte
  // budget, whole-skill drop on overflow), so the two inline paths cannot drift.
  let routerBody: string;
  try {
    routerBody = await readFile(resolvedPath, "utf8");
  } catch {
    return "";
  }
  const skillDir = path.dirname(resolvedPath);
  const budgetBytes = resolveInlineSkillBudgetBytes(process.env);
  const references: Array<{ path: string; content: string }> = [];
  let oversized = false;
  for (const relativePath of extractOneHopReferences(routerBody)) {
    // Containment on the FULLY RESOLVED path: a symlink anywhere in the chain
    // (including a symlinked `references/` directory) is caught.
    try {
      const containedIn = realpathSync(skillDir);
      const absolute = realpathSync(path.resolve(containedIn, relativePath));
      const relative = path.relative(containedIn, absolute);
      if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
        continue;
      }
      const stat = statSync(absolute);
      if (!stat.isFile()) continue;
      // SIZE-CHECK BEFORE READ: a reference bigger than the whole request
      // budget can never be inlined, so it is never pulled into memory just to
      // be discarded — it marks the skill oversized and the planner drops it.
      if (stat.size > budgetBytes) {
        oversized = true;
        continue;
      }
      references.push({ path: relativePath, content: await readFile(absolute, "utf8") });
    } catch {
      // Named-but-absent / unreadable: the router still ships without it.
      continue;
    }
  }
  const plan = planInlineExpansion({
    units: [
      {
        skillId: path.basename(skillDir),
        rank: "declared_dependency",
        body: routerBody,
        references,
        oversized,
      },
    ],
    budgetBytes,
  });
  if (plan.dropped.length > 0) {
    console.warn(
      `[llm-bridge] media-branch inline expansion dropped the skill at ` +
        `${resolvedPath}: ${plan.dropped.map((d) => d.reason).join(", ")}`,
    );
  }
  return plan.systemContext;
}

// ---------------------------------------------------------------------------
// Injection ports for this surface (cinatra#2091, epic #2086 S4).
//
// `resolveInjectedSkillSet` owns the POLICY and no I/O; this is where THIS
// surface supplies the facts. Co-located with its only caller on purpose: the
// factory closes over `runForPorts` — the run this request already PROVED it
// owns — and the returned authorization port compares the INTENT against that
// handle, so a caller cannot widen its own authority by editing the intent.
// ---------------------------------------------------------------------------

/** The minimal shape of a server-vetted run row the ports need. */
export type VettedRunHandle = {
  id: string;
  runBy?: string | null;
  orgId?: string | null;
} | null;

/**
 * The DECLARED runtime skill dependency of a consumer extension — the S3
 * dependency-to-injection projection at top rank. Fail-soft by contract: the
 * projection returns null (never throws) on this surface, and a null means
 * "this extension declares no runtime skill edge", not an error.
 */
async function declaredDependencySkills(
  consumerRef: string,
): Promise<InjectionSkillRef[]> {
  if (!consumerRef) return [];
  try {
    const edge = await resolveDeclaredSkillEdgeForExtensionDir(consumerRef);
    return edge ? [{ skillId: edge.skillId }] : [];
  } catch {
    return [];
  }
}

/**
 * The run's authoritative selected-revision set when one exists, else today's
 * computed assignment. This is the SAME set-vs-computed seam the execution
 * snapshot uses; the selected set additionally carries the PINNED revision id,
 * which now rides all the way into the injected member.
 */
function runSelectedSkills(input: {
  runId?: string;
}): Promise<InjectionSkillRef[]> {
  return (async () => {
    if (input.runId) {
      let selected: ReturnType<typeof readRunSelectedSkillRevisions> = [];
      try {
        selected = readRunSelectedSkillRevisions(input.runId);
      } catch (err) {
        // Best-effort, exactly as the pre-contract bridge read was: a
        // selection-read failure falls back to the computed assignment rather
        // than failing the request.
        console.warn(
          `[skill-injection] selected-skill-revision read failed for run ${input.runId}:`,
          err instanceof Error ? err.message : String(err),
        );
        selected = [];
      }
      if (selected.length > 0) {
        const seen = new Set<string>();
        const refs: InjectionSkillRef[] = [];
        for (const row of selected) {
          if (seen.has(row.skillId)) continue;
          seen.add(row.skillId);
          refs.push({ skillId: row.skillId, revisionId: row.skillRevisionId });
        }
        return refs;
      }
    }
    return [];
  })();
}

export type AgentRunInjectionPortsInput = {
  /** The run this request already PROVED it owns. Null ⇒ unattributable call. */
  run: VettedRunHandle;
  /** The agent the dispatch names. */
  agentId: string;
  /**
   * The consumer's DECLARED runtime skill dependencies, when the surface
   * ALREADY resolved the S3 projection for its own purposes. Supplying them
   * keeps the filesystem scan to ONE per request and — critically — lets the
   * surface exclude a bundle it is mounting through another channel, so the
   * same bytes are never delivered twice and never consume two cap slots.
   * Absent ⇒ these ports resolve the projection themselves.
   */
  declaredDependencySkillIds?: readonly string[];
  /**
   * Catalog skill ids the SURFACE already delivers through another channel
   * (the bridge's own path-mounted SKILL.md shell tool). Excluded from EVERY
   * rank, not just declared dependencies: an assignment or a recommendation can
   * name the same catalog id, and delivering it twice would put the same bytes
   * in front of the model through two channels and count it twice.
   */
  alreadyDeliveredSkillIds?: ReadonlySet<string>;
  /**
   * Resolve the computed assignment for an actor (or actor-less when null) —
   * supplied by the surface because the scope-aware actor build is surface
   * logic, not injection policy.
   */
  resolveAssignedSkillIds: (
    actorUserId: string | null,
  ) => Promise<readonly string[]>;
  /**
   * Filter a resolved personal delta down to the runtime-deliverable ones
   * (lifecycle gate). Absent ⇒ no filtering.
   */
  isPersonalDeltaDeliverable?: (skillId: string) => boolean;
};

export function buildAgentRunInjectionPorts(
  input: AgentRunInjectionPortsInput,
): InjectionResolverPorts {
  const vettedRunId = input.run?.id ?? null;
  const vettedOwnerUserId =
    typeof input.run?.runBy === "string" && input.run.runBy.length > 0
      ? input.run.runBy
      : null;

  const excluded = input.alreadyDeliveredSkillIds ?? new Set<string>();
  const withoutExcluded = (refs: readonly InjectionSkillRef[]): InjectionSkillRef[] =>
    refs.filter((r) => !excluded.has(r.skillId));

  return {
    async authorizeAgentRun(intent): Promise<InjectionAuthorization> {
      // The AGENT axis is the caller's declaration on this surface — the bridge
      // has always resolved assignments by the dispatched `agent_id`, and a run
      // row carries no agent identity to bind it against. This comparison is
      // therefore a DRIFT guard (the intent must name what the surface passed),
      // not an authorization of the agent. The axis that IS authorized is the
      // OWNER: `runOwnerUserId` below comes only from the server-verified run,
      // and it alone gates the personal delta and the scope-aware actor.
      if (intent.agentId !== input.agentId) {
        return {
          ok: false,
          reason: `intent names agent "${intent.agentId}" but the surface passed "${input.agentId}"`,
        };
      }
      // A CLAIMED run must be the run this request proved it owns. Claiming a
      // different run id is a confused-deputy attempt and is refused.
      if (intent.runId) {
        if (!vettedRunId || intent.runId !== vettedRunId) {
          return {
            ok: false,
            reason:
              "the intent claims a run this request did not prove ownership of",
          };
        }
        return { ok: true, runOwnerUserId: vettedOwnerUserId };
      }
      // No run claimed ⇒ an unattributable dispatch. Allowed, but with NO
      // verified owner, so the personal delta is withheld and the assignment
      // resolves actor-less. Strictly less than the run-bound path.
      return { ok: true, runOwnerUserId: null };
    },

    async resolveDeclaredDependencySkills({ consumerRef }) {
      if (input.declaredDependencySkillIds) {
        return withoutExcluded(
          input.declaredDependencySkillIds.map((skillId) => ({ skillId })),
        );
      }
      return withoutExcluded(await declaredDependencySkills(consumerRef));
    },

    async resolveRunRecommendedSkills({ runId, actorUserId }) {
      const selected = await runSelectedSkills({ runId });
      if (selected.length > 0) return withoutExcluded(selected);
      const assigned = await input.resolveAssignedSkillIds(
        actorUserId ?? null,
      );
      return withoutExcluded(assigned.map((skillId) => ({ skillId })));
    },

    async resolvePersonalDelta({ agentId, userId }) {
      if (!agentId) return null;
      try {
        const skill = await getCustomSkillForCurrentUserAndAgent(
          agentId,
          userId,
        );
        return toPersonalDelta(skill, input.isPersonalDeltaDeliverable);
      } catch {
        return null;
      }
    },
  };
}

function toPersonalDelta(
  skill: unknown,
  isDeliverable?: (skillId: string) => boolean,
): InjectionPersonalDelta | null {
  if (!skill || typeof skill !== "object") return null;
  const record = skill as { id?: unknown; content?: unknown; revisionId?: unknown };
  const skillId = typeof record.id === "string" ? record.id : "";
  const content = typeof record.content === "string" ? record.content : "";
  if (skillId === "" || content.trim() === "") return null;
  if (isDeliverable && !isDeliverable(skillId)) return null;
  return {
    skillId,
    content,
    revisionId: typeof record.revisionId === "string" ? record.revisionId : null,
  };
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
  // cinatra#2091 S4: catalog skill ids this route mounts through its OWN shell
  // channel below. The injection contract must not ALSO deliver them — the same
  // bytes would reach the model twice and consume two of the eight cap slots.
  const bridgeMountedSkillIds = new Set<string>();

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
  let candidateSkillPath = body.skill_source_path
    ? body.skill_source_path
    : body.agent_id && !agentIdLooksLikePath
      ? autoDiscoverSkillPath(body.agent_id)
      : "";
  // Declared-edge projection (cinatra#2090 S3, epic #2086). The separation rule
  // moves a genuine knowledge bundle OUT of the producing extension into its own
  // `kind:"skill"` package, reached by a declared `cinatra.dependencies` edge.
  // The co-located probe above cannot see that bundle (it lives under the
  // PROVIDER's dir, not the agent's), so the edge is resolved here and its
  // provider identity is carried to the mount below — the skillId must be the
  // one the catalog knows the provider's bundle by, never a name derived from
  // the consumer's path. Consulted ONLY on a co-located miss, so an extension
  // that still ships its own bundle keeps resolving byte-identically.
  let declaredSkillEdge: Awaited<
    ReturnType<typeof resolveDeclaredSkillEdgeForExtensionDir>
  > = null;
  if (
    !body.skill_source_path &&
    body.agent_id &&
    !agentIdLooksLikePath &&
    !existsSync(candidateSkillPath)
  ) {
    declaredSkillEdge = await resolveDeclaredSkillEdgeForExtensionDir(body.agent_id);
    if (declaredSkillEdge) candidateSkillPath = declaredSkillEdge.sourcePath;
  }

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
    // A3 (cinatra#1363): gate an EXPLICIT skill_source_path pointing at a
    // custom/personal skill's SKILL.md — an archived/draft skill's bytes are
    // never shell-injected. Auto-discovered mount paths are derived; the `||`
    // short-circuits so the common path adds no catalog read.
    const bridgeShellPathAllowed =
      !body.skill_source_path || (await isBridgeSkillPathRuntimeDeliverable(resolvedPath));
    if (
      bridgeShellPathAllowed &&
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
        // A declared-edge mount already KNOWS its provider package and the
        // catalog id that package's bundle registers under
        // (`deriveSkillRegistration`), so it never goes through the
        // path-shape derivation — that derivation reads the vendor from the
        // path and the slug from the BUNDLE dir, which for a provider package
        // (`@cinatra-ai/web-research-skill` shipping `skills/web-research/`)
        // would invent `@cinatra-ai/web-research` and register a second,
        // divergent catalog row for the same bytes.
        const packageName =
          declaredSkillEdge?.packageName ?? deriveSkillPackageName(resolvedPath, skillSlug);
        const skillId = declaredSkillEdge?.skillId ?? `${packageName}:${skillSlug}`;
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
        bridgeMountedSkillIds.add(skillId);
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
    // Typed injection contract (cinatra#2091, epic #2086 S4). The bridge no
    // longer NAMES the skills it wants: it declares the `agent-run` INTENT and
    // `resolveInjectedSkillSet` derives the members itself — declared runtime
    // skill dependencies (the S3 projection) -> the run's authoritative
    // selected-revision set (else today's computed assignment) -> the personal
    // delta — then ranks them and applies the hard cap of 8 TOTAL, delta
    // included. Every prior authorization property is preserved and now lives in
    // ONE place: the ports close over `runForPorts` (the run this request
    // already proved it owns via run-token-first -> context-id ->
    // dispatcher-signed binding), so the personal delta and the scope-aware
    // assignment actor derive SOLELY from that vetted handle and an intent that
    // claims any other run is refused outright.
    const injectionPorts = buildAgentRunInjectionPorts({
      run: runForPorts
        ? {
            id: runForPorts.id,
            runBy: runForPorts.runBy ?? null,
            orgId: runForPorts.orgId ?? null,
          }
        : null,
      agentId: body.agent_id ?? "",
      // The S3 declared-edge projection was ALREADY resolved above for the mount
      // probe, so it is handed over rather than re-scanned. A bundle this route
      // mounts itself is EXCLUDED: it already reaches the model through the
      // shell channel, and injecting it again would double-deliver the bytes and
      // burn a second cap slot. When the mount degraded (shell-incompatible
      // model, registration failure) the edge is still delivered — through the
      // contract, at declared-dependency rank.
      declaredDependencySkillIds: declaredSkillEdge
        ? [declaredSkillEdge.skillId]
        : [],
      // Excluded from EVERY rank (an assignment can name the same id), so the
      // shell-mounted bundle is delivered exactly once and counted once.
      alreadyDeliveredSkillIds: bridgeMountedSkillIds,
      // #1401 — a TRUSTWORTHY actor derived from the SAME vetted run handle, so
      // ownership-scoped (team/project/org/workspace) assignments reach the run.
      // Fail-closed: an unverifiable identity yields `undefined` and the resolver
      // falls back to EXACTLY today's actor-less delivery, never more.
      resolveAssignedSkillIds: async (actorUserId) => {
        if (!body.agent_id) return [];
        const assignedSkillsActor = actorUserId
          ? await resolveAssignedSkillsActorForRun(runForPorts)
          : undefined;
        return assignedSkillsActor
          ? getAssignedSkillIdsForAgent(body.agent_id, assignedSkillsActor)
          : getAssignedSkillIdsForAgent(body.agent_id);
      },
      // A3 (cinatra#1363): a personal delta whose lifecycle_state is not
      // runtime-deliverable (archived/draft/unknown) is withheld, fail-closed.
      isPersonalDeltaDeliverable: (skillId) =>
        isBridgeSkillRuntimeDeliverable(skillId),
    });
    const injectedSkills = await resolveInjectedSkillSet(
      {
        kind: "agent-run",
        agentId: body.agent_id ?? "",
        ...(runForPorts?.id ? { runId: runForPorts.id } : {}),
        ...(typeof runForPorts?.runBy === "string" && runForPorts.runBy.length > 0
          ? { userId: runForPorts.runBy }
          : {}),
      },
      injectionPorts,
    );
    // Structured drops (cap truncation + inline-budget overflow) land here and
    // are written to the exposure/efficacy ledger below.
    let injectionDrops: readonly InjectedSkillDrop[] = [];

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
        // llm-providers S1 (#1712, AC4): native MCP OBO applies iff the
        // effective provider's DECLARED capability matrix satisfies native_mcp
        // (was: `=== "openai" || === "anthropic"`). Behavior-identical under the
        // build-known catalog; a later catalog change flows through with no edit.
        canProviderSatisfyCapability(mcpEffectiveProvider, "native_mcp")
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
                {
                  ...actor,
                  oboCeiling: runForPorts.oboCeiling!,
                  // `att` claim (cinatra#1939 S3): the run row's CURRENT
                  // attempt id, minted into the OBO token so the org-write
                  // run authority can match claimed-vs-current and refuse a
                  // stale attempt's calls. Absent pre-dispatch → no claim →
                  // that frame just never gets a run authority (fail-closed).
                  ...(runForPorts.executionAttemptId
                    ? { executionAttemptId: runForPorts.executionAttemptId }
                    : {}),
                },
                issueAgentRunMcpActorToken,
                cinatraMcpAllowedTools,
              );
              // The OBO token carries the run id itself (the reader's
              // delegated-actor path wins) — no durable binding needed.
              if (oboTool) return oboTool;
              return buildMachineToolWithDurableBinding();
            }
          : undefined;

      // exec-plane S3 A2 (cinatra#1708 §1.1): resolve the run's DECLARED L1
      // environment into a mountable layer + broker executor, or REFUSE a
      // declared env that cannot be honored (never a silent L0 downgrade). Only
      // a vetted run (a resolved templateId) carries a declared-env source here;
      // absent ⇒ L0 (byte-identical). Today's instances resolve the service
      // `disabled` and no current agent declares an environment, so this stays a
      // no-op L0 until the service is `ready` + a declared env lands.
      let runEnvBinding: Awaited<ReturnType<typeof resolveRunExecutionBinding>> | undefined;
      if (runForPorts?.templateId) {
        const envTemplate = await readAgentTemplateById(runForPorts.templateId);
        runEnvBinding = await resolveRunExecutionBinding({
          liveTemplateEnvironment: envTemplate?.executionEnvironment,
          // cinatra#1708 slice B: the per-agent execution posture authored on
          // the agent-config surface. `null`/absent inherits (today's rows) →
          // byte-identical behaviour.
          executionEnabled: envTemplate?.executionEnabled ?? null,
          orgId: runForPorts.orgId!,
          holder: {
            templateId: runForPorts.templateId,
            ...(envTemplate?.packageName ? { packageName: envTemplate.packageName } : {}),
            ...(body.agent_spec_version ? { versionId: body.agent_spec_version } : {}),
          },
          // epic #1705: the live template row is only ONE of the three sources a
          // run's environment can be declared in. Supplying it alone let a
          // PACKAGED agent's manifest declaration — and a pinned run's snapshot
          // recipe — resolve ABSENT, so the run silently executed on L0 against
          // the "a declared environment resolves or the run refuses" contract,
          // and version pinning was bypassed on this seam. The reader resolves
          // all three (and reports a source it could not READ, which refuses).
          ...(await resolveRunEnvironmentSources({
            templateId: runForPorts.templateId,
            versionId: runForPorts.versionId,
            packageVersion: runForPorts.packageVersion,
            packageName: envTemplate?.packageName,
            liveTemplateEnvironment: envTemplate?.executionEnvironment,
          })),
        });
        if (runEnvBinding.kind === "refuse") {
          return NextResponse.json(
            {
              error: "environment_refused",
              code: "ENVIRONMENT_REFUSED",
              reason: runEnvBinding.auditReason,
              detail: runEnvBinding.detail,
            },
            { status: 409 },
          );
        }
      }
      // exec-plane S1b (cinatra#2138 deliverable 2): the agent-run surface is a
      // TRUSTED execution-session issuer. `runForPorts` is the run this request
      // already proved it owns — resolved from the verified #1192 run token (or
      // the dispatcher-signed binding / auth-injected context id), never from a
      // caller-supplied body id. Binding the session to THAT run id reuses the
      // existing per-run binding rather than inventing a second one: the merged
      // broker's per-command liveness probe re-reads the SAME run row, so a
      // hard-removed run fails the next sandbox command closed.
      const runExecutionBinding = resolveSurfaceExecutionBinding({
        surface: "agent_run",
        orgId: runForPorts?.orgId,
        userId: runForPorts?.runBy,
        runId: runForPorts?.id,
      });
      result = await runResolvedSkillAwareDeterministicLlmTask({
        runtime: resolvedRuntime,
        model: body.model_id,
        declaredToolboxIds: mcpToolboxIds,
        // The AUTHORITATIVE injected set (cinatra#2091 S4) — already ranked and
        // capped at 8 TOTAL including the personal delta. There is no
        // `skillIds` / `customSkillContent` channel any more.
        injectedSkills,
        // Structured drops back to this route so they reach the efficacy ledger
        // (no new payload field crosses the provider-adapter v1 ABI).
        onInjectionDrops: (drops) => {
          injectionDrops = drops;
        },
        // Forwarded to the provider's delivery adapter, whose own cap is now a
        // defence-in-depth invariant: the authoritative cap already ran.
        skillSelectionMode: "general",
        // llm-providers S1 (#1712): thread the agent's pinned capability down to
        // the adapter so it can fail closed at runtime (Anthropic native_mcp —
        // no silent function-tool degrade). Absent ⇒ no capability gate.
        capabilityRequired: body.cinatra_llm?.capabilityRequired,
        system: body.system ?? "",
        user: envelope.text,
        maxSteps,
        outputSchema: body.output_schema,
        extraTools: extraTools.length > 0 ? extraTools : undefined,
        skipExternalMcpRegistry: true,
        // cinatra#2019 S4: the bridge is an agent-plane surface — surface-
        // gating toolboxes (trusted-site native read-injection) refuse
        // non-"chat" builds fail-closed, so declaring the surface here keeps
        // agent runs on the governed M1 path. `connectorInstancePin` rides
        // this context ONLY when the resolved run row itself carries an
        // instance binding (host-derived, the same pin data the agent-run
        // MCP actor token would carry — NEVER request-payload input);
        // today's agent_run rows carry no instance binding, so the context
        // stays surface-only until one exists.
        toolboxBuildContext: { surface: "agent_run" },
        logLabel: body.agent_id ?? "wayflow",
        actorContext: bridgeActorContext,
        telemetryRequestedProvider: dispatch.requestedProvider,
        telemetryEffectiveProvider,
        ...(cinatraMcpToolOverride ? { cinatraMcpToolOverride } : {}),
        ...(envelope.attachments
          ? { attachments: envelope.attachments }
          : {}),
        ...(attachmentResolverPorts ? { attachmentResolverPorts } : {}),
        // exec-plane S1b (cinatra#2138): the run-bound execution session + the
        // boot-wired broker executor. Rollout flag off ⇒ an empty spread ⇒
        // byte-identical dispatch.
        ...runExecutionBinding,
        // exec-plane S3 A2 (cinatra#1708): supply the broker executor + opaque
        // mount ONLY when a declared environment resolved to a signed layer; the
        // broker re-verifies the signed provenance fail-closed before every
        // mount (AC4). Absent ⇒ byte-identical L0 dispatch. Spread AFTER the S1b
        // binding so a resolved L1 mount's executor wins for that run.
        ...(runEnvBinding?.kind === "mount"
          ? {
              executionExecutor: runEnvBinding.executor,
              executionEnvironment: runEnvBinding.environment,
            }
          : {}),
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

    // S10 efficacy loop (cinatra#1368). Record this step's skill exposure +
    // attributable invocations against the vetted run. ONLY a server-resolved
    // run (`runForPorts`) — the same handle that scopes personal-delta delivery
    // and OBO minting — keys the ledger; an unattributable call records nothing.
    // Personal deltas (skill id === the resolved delta's id) are kind 'custom';
    // every other delivered skill is an installed catalog skill. Best-effort:
    // ledger writes must never fail a bridge run.
    if (runForPorts?.id) {
      const runId = runForPorts.id;
      // The delta's identity now comes from the injected SET, not from a
      // separately-resolved row: it is a first-class member of the contract.
      const personalDeltaId =
        injectedPersonalDelta(injectedSkills)?.skillId ?? null;
      try {
        const exposures = (result.skillExposure ?? []).map((e) => ({
          skillId: e.skillId,
          skillKind: (e.skillId === personalDeltaId ? "custom" : "installed") as SkillKind,
          deliveryMode: e.deliveryMode,
          invocationAttributable: e.invocationAttributable,
        }));
        if (exposures.length > 0) {
          recordSkillExposure({ runId, exposures });
        }
        // invokedSkillIds are attributable OpenAI shell reads — installed
        // catalog skills, always openai_shell.
        for (const skillId of result.invokedSkillIds ?? []) {
          incrementSkillInvocation({
            runId,
            skillId,
            skillKind: "installed",
            deliveryMode: "openai_shell",
          });
        }
        // cinatra#2091 S4: a skill the contract RESOLVED but did not deliver
        // (cap truncation, inline-budget overflow) is recorded with its reason
        // so the efficacy surface can tell "never delivered" apart from
        // "delivered and ignored".
        if (injectionDrops.length > 0) {
          recordSkillInjectionDrops({
            runId,
            drops: injectionDrops.map((d) => ({
              skillId: d.skillId,
              skillKind: (d.skillId === personalDeltaId
                ? "custom"
                : "installed") as SkillKind,
              reason: d.reason,
            })),
          });
        }
      } catch (err) {
        console.warn(
          `[llm-bridge] skill-efficacy ledger write failed for run ${runId}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

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
