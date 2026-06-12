"use server";

// Side-effect import publishes the per-concern host connector services in
// this server-action bundle (separate Turbopack graph from instrumentation
// boot). Without it the gmail connector's registered email-sender-identities
// impl throws "host service not registered" — here it's swallowed by the
// resolver's per-provider isolation so gmail aliases silently never load.
// Same pattern as src/app/api/chat/runner.ts.
import "@/lib/register-host-connector-services";

import { requireActorContext, requireAuthSession } from "@/lib/auth-session";
import { buildSkillResourceRef, requireResourceAccess } from "./auth-policy";
import { listEmailSenderIdentities } from "@/lib/email-sender-identities";
import { getAssignedSkillIdsForAgent } from "@/lib/agents-store";
import {
  listInstalledSkills,
  createOrUpdateCustomSkillForAgent,
  buildDefaultPersonalSkillName,
  listCustomSkillsForCurrentUserAndAgent,
} from "@cinatra-ai/skills";
import {
  readHitlPromptsForRun,
  updateHitlPromptExcluded,
  readAgentRunById,
  readAgentTemplateByPackageName,
} from "./store";
import type { FieldRendererBindingInput } from "./register-default-renderers";
import { GENERATED_FIELD_RENDERER_BINDINGS } from "@/lib/generated/agent-bindings";

// ---------------------------------------------------------------------------
// SkillForChip — serialisable subset of SkillManifest safe to cross the
// "use server" boundary into client components (no function/symbol fields).
// ---------------------------------------------------------------------------
export type SkillForChip = {
  id: string;
  name: string;
  description: string;
  content: string;
  level: string | undefined;
};

/**
 * Loads FieldRendererContext data (connected apps + Gmail aliases) for use
 * in AgenticRunPanel HITL renderers. Same shape as the chat-package
 * field-renderer-context loader. Kept in agent-builder to avoid a reverse
 * dependency from agent-builder to chat.
 *
 * Registration-driven (cinatra#151 Stage 4): sender identities resolve from
 * the `email-sender-identities` capability (registered by the gmail
 * connector's register(ctx)) instead of value-importing the connector
 * package. `connectedApps` derives from the providers' app slugs with
 * non-empty identities (today: ["gmail"] iff aliases are synced — behavior
 * preserved); `gmailAliases` keeps its gmail-specific field name because the
 * consuming HITL renderer is gmail-specific (renderer inversion is Stage 5).
 *
 * Degrades gracefully: returns empty arrays if unauthenticated, the
 * connector is absent (acquirable-on-demand, not required), or a provider
 * read fails (per-provider isolation in the resolver).
 */
export async function getFieldRendererContextForAgentBuilderAction(): Promise<{
  connectedApps: string[];
  gmailAliases: { sendAsEmail: string; displayName?: string }[];
}> {
  const session = await requireAuthSession().catch(() => null);
  if (!session?.user?.id) return { connectedApps: [], gmailAliases: [] };
  try {
    const contributions = await listEmailSenderIdentities(session.user.id);
    const connectedApps = contributions.map((c) => c.app);
    const gmailAliases = (
      contributions.find((c) => c.app === "gmail")?.identities ?? []
    ).map((a) => ({
      sendAsEmail: a.email,
      displayName: a.displayName,
    }));
    return { connectedApps, gmailAliases };
  } catch {
    return { connectedApps: [], gmailAliases: [] };
  }
}

// ---------------------------------------------------------------------------
// getRuntimeFieldRendererBindingsAction — SOURCE B of the two-source
// field-renderer binding registration (cinatra#151 Stage 5): bindings
// declared by agent packages INSTALLED AT RUNTIME (materialized after build,
// so absent from the generated build-time map). The HITL panel surfaces
// fetch these on mount and register them idempotently
// (useRuntimeFieldRendererBindings), giving runtime-installed agents their
// bespoke renderers on prod images where they are not bundled.
//
// Security: requires a valid session — unauthenticated callers receive [].
// Output is PUBLIC renderer metadata (validated, size-capped plain JSON ids/
// kinds/params — never secrets); enumeration-only, no writes.
// All errors → [] so renderer resolution degrades to the schema-field
// fallback rather than crashing the panel.
// ---------------------------------------------------------------------------
export async function getRuntimeFieldRendererBindingsAction(): Promise<
  FieldRendererBindingInput[]
> {
  const session = await requireAuthSession().catch(() => null);
  if (!session?.user?.id) return [];
  try {
    const { collectInstalledFieldRendererBindings } = await import(
      "./field-renderer-bindings.server"
    );
    const generatedIds = new Set(
      GENERATED_FIELD_RENDERER_BINDINGS.map((b) => b.id),
    );
    // Runtime-only ids: the generated (build-time) bindings are already
    // compiled into the client registry — re-sending them would only churn
    // registration order.
    return collectInstalledFieldRendererBindings()
      .filter((b) => !generatedIds.has(b.id))
      .map(({ id, kind, priority, midRunHitl, a2uiTranslator, params }) => ({
        id,
        kind,
        priority,
        ...(midRunHitl === true ? { midRunHitl: true } : {}),
        ...(a2uiTranslator !== undefined ? { a2uiTranslator } : {}),
        ...(params !== undefined ? { params } : {}),
      }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// getSkillsForAgentAction — returns SKILL.md entries assigned to the given
// agent package for display in the HITL skill-chip row.
//
// Security: requires a valid session — unauthenticated callers receive [].
// Cost gate: callers should only invoke when the run is pending_approval;
// the guard is in AgenticRunPanel (not here).
// All errors → [] so the chip row silently degrades rather than crashing.
// ---------------------------------------------------------------------------
export async function getSkillsForAgentAction(
  agentPackageName: string,
): Promise<SkillForChip[]> {
  // Auth gate: use .catch(() => null) pattern so Next.js NEXT_REDIRECT thrown
  // by requireAuthSession() is not swallowed by the outer catch block.
  // Mirrors the pattern used in getFieldRendererContextForAgentBuilderAction above.
  const session = await requireAuthSession().catch(() => null);
  if (!session?.user?.id) return [];

  try {
    // Defensive guard — no downstream calls on empty input.
    if (!agentPackageName) return [];

    // Security: this server action returns `skill.content` only after
    // actor-aware assignment resolution and per-skill authorization.
    // `level: "system"` skills may be admin-visibility-gated, so every
    // returned row must match what the actor is authorized to read:
    //   - resolve a real ActorContext (not just a session)
    //   - thread it into `getAssignedSkillIdsForAgent` so custom +
    //     workspace assignments resolve correctly
    //   - post-filter every returned skill row through
    //     `requireResourceAccess` so the rendered chips and content
    //     match what the actor is authorized to read
    // platform_admin is short-circuited inside `requireResourceAccess`
    // and continues to see everything.
    const actor = await requireActorContext();

    // Parallelize the two heavy DB reads so the HITL renderer doesn't wait
    // sequentially. `listInstalledSkills` issues 3 parallel queries internally
    // (catalog + agents + match state); doing it concurrently with
    // `getAssignedSkillIdsForAgent` cuts mount-fetch latency roughly in half.
    // The trade-off: when assignedIds is empty we still pay for the catalog
    // fetch (instead of short-circuiting), but the empty case is rare for
    // agents that wire a recommend gate.
    const [assignedIds, catalog] = await Promise.all([
      getAssignedSkillIdsForAgent(agentPackageName, actor),
      listInstalledSkills(),
    ]);
    if (!assignedIds || assignedIds.length === 0) return [];

    const assignedSet = new Set(assignedIds);
    return catalog
      .filter((skill) => assignedSet.has(skill.id))
      .filter((skill) => {
        try {
          // Security: see auth-policy.ts buildSkillResourceRef.
          requireResourceAccess(actor, buildSkillResourceRef({
            id: skill.id,
            level: skill.level,
            scope: skill.scope ?? null,
          }));
          return true;
        } catch {
          return false;
        }
      })
      .map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        content: skill.content,
        level: skill.level as string | undefined,
      }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Audit button server actions
//
// Five exported types + three exported async functions that power the Audit
// button + Skill preview drawer in AgenticRunPanel.
//
// All three actions follow the same auth-gate + degrade-to-safe-default
// contract used throughout this file: `requireAuthSession().catch(() => null)`
// so Next.js NEXT_REDIRECT is never swallowed by the outer try/catch.
// ---------------------------------------------------------------------------

export type AuditPromptDTO = {
  id: string;
  stepKey: string;
  message: string;
  capturedAt: string; // ISO string — Date is not serialisable across "use server" boundary
};

export type AuditSkillPreviewDTO = {
  id: string;
  name: string;
  description: string;
  content: string;
  basedOnSkillIds: string[] | undefined;
};

export type AuditDrawerData = {
  prompts: AuditPromptDTO[];
  preview: AuditSkillPreviewDTO | null;
  error: string | null;
};

export type DismissAuditResult =
  | { ok: true; dismissed: number }
  | { ok: false; error: string };

/**
 * Generates AND persists the personal skill via createOrUpdateCustomSkillForAgent (upsert).
 * The Accept button is a UI confirmation only — the persist already happened.
 * The Dismiss button does NOT delete the persisted skill (v1 quirk).
 *
 * Degrades to { prompts: [], preview: null, error: string } on auth failure or LLM error.
 */
export async function getAuditDrawerDataAction(
  runId: string,
  agentPackageName: string,
): Promise<AuditDrawerData> {
  const session = await requireAuthSession().catch(() => null);
  if (!session?.user?.id) return { prompts: [], preview: null, error: "Unauthorized" };

  if (!runId || !agentPackageName) return { prompts: [], preview: null, error: null };

  try {
    // Ownership guard: must run BEFORE any prompt read or LLM call.
    const run = await readAgentRunById(runId);
    if (!run || run.runBy == null || run.runBy !== session.user.id) {
      return { prompts: [], preview: null, error: "Unauthorized" };
    }

    const prompts = await readHitlPromptsForRun(runId, agentPackageName);

    // Short-circuit: no prompts → no LLM call (verified by Wave 0 "empty preview when no prompts")
    if (prompts.length === 0) return { prompts: [], preview: null, error: null };

    const promptEntries = prompts.map((p) => ({
      id: p.id,
      kind: "initial" as const,
      prompt: p.message,
      savedAt: p.capturedAt.toISOString(),
    }));

    const template = await readAgentTemplateByPackageName(agentPackageName);
    const skillName = buildDefaultPersonalSkillName({
      campaignName: run?.title ?? template?.name ?? agentPackageName,
      sourceLabel: "HITL audit",
    });

    // Thread session.user.id so each user owns their own personal skills.
    // Auth-attribution (data ownership) is separate from the run-ownership
    // guard above (action permission) — both apply.
    const existing = await listCustomSkillsForCurrentUserAndAgent(agentPackageName, session.user.id);
    const existingSkillId = existing[0]?.id;

    // Thread the caller's actor into the helper so the matched-skill catalog
    // read is gated by requireResourceAccess. Without this, admin-hidden
    // `system` skill content leaks into the LLM generation prompt and the
    // persisted `basedOnSkillIds`.
    const actor = await requireActorContext();

    // Persist-on-preview semantics: this upsert IS the persist call (Pitfall 1).
    const persisted = await createOrUpdateCustomSkillForAgent({
      agentId: agentPackageName,
      promptEntries,
      skillName,
      existingSkillId,
      userId: session.user.id,
      actor,
    });

    return {
      prompts: prompts.map((p) => ({
        id: p.id,
        stepKey: p.stepKey,
        message: p.message,
        capturedAt: p.capturedAt.toISOString(),
      })),
      preview: {
        id: persisted.id,
        name: persisted.name,
        description: persisted.description,
        content: persisted.content,
        basedOnSkillIds: persisted.basedOnSkillIds,
      },
      error: null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[getAuditDrawerDataAction] failed", msg);
    return { prompts: [], preview: null, error: msg };
  }
}

/**
 * Marks all non-excluded HITL prompts for a run as excluded=true.
 * Degrades to { ok: false, error: string } on auth failure or store error.
 */
export async function dismissAuditPromptsAction(
  runId: string,
  agentPackageName: string,
): Promise<DismissAuditResult> {
  const session = await requireAuthSession().catch(() => null);
  if (!session?.user?.id) return { ok: false, error: "Unauthorized" };

  if (!runId || !agentPackageName) return { ok: false, error: "Missing inputs" };

  try {
    // Ownership guard: prevents run-ownership tampering — must run BEFORE the prompt read.
    const run = await readAgentRunById(runId);
    if (!run || run.runBy == null || run.runBy !== session.user.id) {
      return { ok: false, error: "Unauthorized" };
    }

    const prompts = await readHitlPromptsForRun(runId, agentPackageName);
    await Promise.all(prompts.map((p) => updateHitlPromptExcluded(p.id, true)));

    return { ok: true, dismissed: prompts.length };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[dismissAuditPromptsAction] failed", msg);
    return { ok: false, error: msg };
  }
}
