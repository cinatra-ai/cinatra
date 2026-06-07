import "server-only";

import { z } from "zod";
// CRM object types (account / contact / list) are registered by the
// crm-connector extension (host boot path: createCrmModule() +
// src/lib/register-all-object-types.ts). This foundational package does not
// import the extension — doing so would invert the package→extension layer.
// Blog object types are registered host-side via
// `src/lib/register-all-object-types.ts`. That host path imports from
// `@/lib/blog-project-store`, so keeping blog registration out of this package
// avoids a `packages/objects` -> host `src/lib` layer inversion.
import { objectTypeRegistry } from "../registry";
import {
  GenericObjectListRow,
  GenericObjectCard,
  GenericObjectDetail,
} from "./generic-renderers";

/**
 * Generic default object type. Registered alongside the per-package static
 * types so any object saved during an agent run gains stable identity via the
 * shared `cinatraAgentRunId` dedup key (injected by the objects layer from
 * `actorExt.runId`). The classifier may choose this type for ambiguous shapes;
 * it is also the natural target for "everything I just saved" reads via
 * `objects_list { type: "@cinatra-ai/objects:object", runId: ... }`.
 *
 * Returning `null` from `identityKey` when `cinatraAgentRunId` is absent
 * preserves the existing random-UUID-per-save behavior. There is no risk of
 * over-deduping objects that genuinely have no run context.
 */
function registerGenericObjectType(): void {
  objectTypeRegistry.register({
    type: "@cinatra-ai/objects:object",
    category: "report", // broadest category; specialised types override
    schema: z.record(z.string(), z.unknown()),
    lifecycle: {
      sources: ["agent", "user", "import"],
      mutableBy: ["agent", "user"],
    },
    renderers: {
      listRow: GenericObjectListRow,
      card: GenericObjectCard,
      detail: GenericObjectDetail,
    },
    identityKey: (data) => {
      const d = data as Record<string, unknown>;
      const runId = d.cinatraAgentRunId;
      return typeof runId === "string" && runId.length > 0 ? runId : null;
    },
  });
}

/**
 * Consolidates every package's `register*ObjectTypes()` calls into a single
 * entry point so `createObjectsModule()` can register all types at startup.
 *
 * Agent-builder registration is intentionally excluded: agent templates live
 * in the Postgres `agent_templates` table, not Graphiti.
 *
 * Also registers the generic `@cinatra-ai/objects:object` type so any object
 * saved during an agent run picks up the shared `cinatraAgentRunId`-based
 * identityKey for retry dedup.
 *
 * NOTE: Each package's module factory (createAccountModule, createContactModule,
 * createBlogContentModule, createCampaignModule) still calls register*ObjectTypes()
 * locally. Those calls are left intact as a safety net because
 * objectTypeRegistry.register() is idempotent on re-registration of the same
 * type. They can be removed once no callers rely on package-local registration.
 */
// @cinatra-ai/campaigns:campaign is registered here to preserve the
// cinatra_agent_run_id-based dedup identityKey. Without it, retried objects_save
// calls in the same run create duplicate Graphiti episodes. Uses generic
// renderers; a dedicated renderer can be added when a replacement campaigns
// package exists.
//
// Run-scoped policy: agent retries within the same run update in-place via
// cinatra_agent_run_id; new runs create a new row. Users may rename a campaign;
// the agent must not overwrite that on a re-run, so `name` is preserved. HITL
// when no identity is resolvable (no run frame).
const RUN_SCOPED_CAMPAIGN_POLICY = {
  onMatch: "update" as const,
  onNoMatch: "create" as const,
  preserveOnUpdate: ["id", "createdAt", "cinatra_agent_run_id"] as const,
};

export function registerCampaignType(): void {
  objectTypeRegistry.register({
    type: "@cinatra-ai/campaigns:campaign",
    category: "project",
    schema: z.record(z.string(), z.unknown()),
    lifecycle: {
      sources: ["agent"],
      mutableBy: ["agent", "user"],
    },
    renderers: {
      listRow: GenericObjectListRow,
      card: GenericObjectCard,
      detail: GenericObjectDetail,
    },
    identityKey: (data) => {
      const d = data as Record<string, unknown>;
      const runId = d.cinatra_agent_run_id;
      return typeof runId === "string" && runId.length > 0 ? runId : null;
    },
    // User-owned campaign name is preserved on agent re-runs.
    crudPolicy: {
      ...RUN_SCOPED_CAMPAIGN_POLICY,
      preserveOnUpdate: [...RUN_SCOPED_CAMPAIGN_POLICY.preserveOnUpdate, "name"],
    },
  });
}

// @cinatra-ai/campaigns:context mirrors :campaign exactly except for the type
// field. Registration ensures the orchestrator's `objects_save` calls for
// `:context` hit a registered type with the cinatra_agent_run_id-based
// identityKey, so retried saves dedup correctly instead of falling through to
// the generic dynamic-fallback path (which would create duplicate Graphiti
// episodes per retry).
export function registerCampaignContextType(): void {
  objectTypeRegistry.register({
    type: "@cinatra-ai/campaigns:context",
    category: "project",
    schema: z.record(z.string(), z.unknown()),
    lifecycle: {
      sources: ["agent"],
      mutableBy: ["agent", "user"],
    },
    renderers: {
      listRow: GenericObjectListRow,
      card: GenericObjectCard,
      detail: GenericObjectDetail,
    },
    identityKey: (data) => {
      const d = data as Record<string, unknown>;
      const runId = d.cinatra_agent_run_id;
      return typeof runId === "string" && runId.length > 0 ? runId : null;
    },
    crudPolicy: RUN_SCOPED_CAMPAIGN_POLICY,
  });
}

// @cinatra-ai/campaigns:recipients stores the recipients list persisted by the
// recipients-generate ApiNode via objects_save and queried by
// fetchCampaignRecipients. Uses cinatra_agent_run_id-based identityKey so
// retried saves dedup correctly.
export function registerCampaignRecipientsType(): void {
  objectTypeRegistry.register({
    type: "@cinatra-ai/campaigns:recipients",
    category: "report",
    schema: z.record(z.string(), z.unknown()),
    lifecycle: {
      sources: ["agent"],
      mutableBy: ["agent"],
    },
    renderers: {
      listRow: GenericObjectListRow,
      card: GenericObjectCard,
      detail: GenericObjectDetail,
    },
    identityKey: (data) => {
      const d = data as Record<string, unknown>;
      const runId = d.cinatra_agent_run_id;
      return typeof runId === "string" && runId.length > 0 ? runId : null;
    },
    crudPolicy: RUN_SCOPED_CAMPAIGN_POLICY,
  });
}

// ---------------------------------------------------------------------------
// Email draft, followup, and send-attempt bundles use static domain-namespaced
// types instead of `@cinatra-ai/dynamic:*`. They are run-scoped transient
// product bundles (one per campaign run), so the identity key is the agent run
// id, mirroring `:recipients`. Generic renderers suffice because the data is
// read by the email-outreach stage actions and HITL renderers, not edited
// inline. Existing `@cinatra-ai/dynamic:*` ids remain accepted on READ for
// compatibility; writes use the static types.
// ---------------------------------------------------------------------------

function registerCampaignBundleTypes(): void {
  const runIdentity = (data: unknown): string | null => {
    const d = data as Record<string, unknown>;
    const runId = d.cinatra_agent_run_id;
    return typeof runId === "string" && runId.length > 0 ? runId : null;
  };
  for (const type of [
    "@cinatra-ai/campaigns:email-draft-bundle",
    "@cinatra-ai/campaigns:email-followup-bundle",
    "@cinatra-ai/campaigns:send-attempt",
  ] as const) {
    objectTypeRegistry.register({
      type,
      category: "report",
      schema: z.record(z.string(), z.unknown()),
      lifecycle: { sources: ["agent"], mutableBy: ["agent"] },
      renderers: {
        listRow: GenericObjectListRow,
        card: GenericObjectCard,
        detail: GenericObjectDetail,
      },
      identityKey: runIdentity,
      // Run-scoped transient product bundles: a retry within the same run
      // updates in-place via the run-id dedup; a new run creates a new row.
      // The `runIdentity` resolver here returns the cinatra_agent_run_id, so
      // the dispatcher's onMatch path fires for the expected retry case and
      // onNoMatch=create handles the first emission.
      crudPolicy: RUN_SCOPED_CAMPAIGN_POLICY,
    });
  }
}

// ---------------------------------------------------------------------------
// Email transport object types.
//
// Four provider-neutral object types backing the @cinatra-ai/email-connector
// facade. These are platform-write objects (`sources: ["agent", "import"]`,
// NOT mutable by users). Generic renderers are sufficient since the data is
// read by orchestration code and the notifications/inbox surface, not edited
// inline.
// ---------------------------------------------------------------------------

function registerEmailObjectTypes(): void {
  // 1. sender-identity — per-user or per-campaign choice of which connector
  // + which from-address to use. Routing chain in connector-email facade
  // resolves to this object first when a campaign or user has a default.
  // Identity key = "<connectorId>:<fromEmail>" — re-saving the same pair
  // updates the existing record (display-name change, status flip, etc.).
  objectTypeRegistry.register({
    type: "@cinatra-ai/email:sender-identity",
    category: "profile",
    schema: z.object({
      connectorId: z.string().min(1),
      fromEmail: z.string().min(1),
      displayName: z.string().optional(),
      ownerLevel: z.enum(["user", "team", "organization", "workspace"]).optional(),
      ownerId: z.string().optional(),
      // Open extension point for connector-specific config
      // (gmail send-as alias verification status, SES configuration-set, etc.).
      providerConfig: z.record(z.string(), z.unknown()).optional(),
    }),
    lifecycle: {
      sources: ["user", "agent", "import"],
      mutableBy: ["user", "agent"],
    },
    renderers: {
      listRow: GenericObjectListRow,
      card: GenericObjectCard,
      detail: GenericObjectDetail,
    },
    identityKey: (data) => {
      const d = data as Record<string, unknown>;
      const c = typeof d.connectorId === "string" ? d.connectorId : null;
      const f = typeof d.fromEmail === "string" ? d.fromEmail : null;
      return c && f ? `${c}:${f.toLowerCase()}` : null;
    },
  });

  // 2. sent-email — semantic record of a meaningful send. References the
  // email_send_events audit row by `audit_id`. Written by the facade after
  // a successful provider.send(). Identity = audit row idempotency_key.
  objectTypeRegistry.register({
    type: "@cinatra-ai/email:sent-email",
    category: "report",
    schema: z.object({
      auditId: z.string().min(1),
      idempotencyKey: z.string().min(1),
      connectorId: z.string().min(1),
      fromEmail: z.string().optional(),
      toEmail: z.string().min(1),
      subject: z.string().min(1),
      providerMessageId: z.string().min(1),
      providerThreadId: z.string().optional(),
      internetMessageId: z.string().optional(),
      sentAt: z.string().min(1),
      campaignId: z.string().optional(),
      contactId: z.string().optional(),
      runId: z.string().optional(),
    }),
    lifecycle: {
      sources: ["agent", "import"],
      mutableBy: ["agent"],
    },
    renderers: {
      listRow: GenericObjectListRow,
      card: GenericObjectCard,
      detail: GenericObjectDetail,
    },
    identityKey: (data) => {
      const d = data as Record<string, unknown>;
      const k = typeof d.idempotencyKey === "string" ? d.idempotencyKey : null;
      return k && k.length > 0 ? k : null;
    },
  });

  // 3. received-reply — inbound observation. Written by reply-watcher code
  // when EmailConnector.findReply surfaces a new match. Identity =
  // internetMessageId (unique per email globally).
  objectTypeRegistry.register({
    type: "@cinatra-ai/email:received-reply",
    category: "report",
    schema: z.object({
      connectorId: z.string().min(1),
      providerMessageId: z.string().min(1),
      providerThreadId: z.string().optional(),
      internetMessageId: z.string().optional(),
      fromEmail: z.string().min(1),
      subject: z.string().min(1),
      snippet: z.string().optional(),
      receivedAt: z.string().min(1),
      // Relate-back fields populated when the reply matches a known thread,
      // contact, or campaign in the objects layer.
      threadId: z.string().optional(),
      contactId: z.string().optional(),
      campaignId: z.string().optional(),
    }),
    lifecycle: {
      sources: ["agent", "import"],
      mutableBy: ["agent"],
    },
    renderers: {
      listRow: GenericObjectListRow,
      card: GenericObjectCard,
      detail: GenericObjectDetail,
    },
    identityKey: (data) => {
      const d = data as Record<string, unknown>;
      const m = typeof d.internetMessageId === "string" ? d.internetMessageId : null;
      if (m && m.length > 0) return m;
      // Fallback when the connector couldn't surface internetMessageId —
      // composite of (connectorId, providerMessageId) is still unique.
      const c = typeof d.connectorId === "string" ? d.connectorId : null;
      const p = typeof d.providerMessageId === "string" ? d.providerMessageId : null;
      return c && p ? `${c}:${p}` : null;
    },
  });

  // 4. thread — groups sends + replies by providerThreadId. Identity =
  // "<connectorId>:<providerThreadId>" so cross-provider threads with the
  // same provider thread id don't collide.
  objectTypeRegistry.register({
    type: "@cinatra-ai/email:thread",
    category: "report",
    schema: z.object({
      connectorId: z.string().min(1),
      providerThreadId: z.string().min(1),
      subject: z.string().optional(),
      lastActivityAt: z.string().optional(),
      participantEmails: z.array(z.string()).optional(),
      // Soft-relation to sent + reply objects via id arrays. Object-relations
      // model is declarative-only in v1; these strings are object IDs the
      // notifications layer can resolve to objects_get fetches.
      sentEmailObjectIds: z.array(z.string()).optional(),
      receivedReplyObjectIds: z.array(z.string()).optional(),
    }),
    lifecycle: {
      sources: ["agent", "import"],
      mutableBy: ["agent"],
    },
    renderers: {
      listRow: GenericObjectListRow,
      card: GenericObjectCard,
      detail: GenericObjectDetail,
    },
    identityKey: (data) => {
      const d = data as Record<string, unknown>;
      const c = typeof d.connectorId === "string" ? d.connectorId : null;
      const t = typeof d.providerThreadId === "string" ? d.providerThreadId : null;
      return c && t ? `${c}:${t}` : null;
    },
  });
}

export function registerAllObjectTypes(): void {
  registerGenericObjectType();
  registerCampaignType();
  registerCampaignContextType();
  registerCampaignRecipientsType();
  registerCampaignBundleTypes();
  registerEmailObjectTypes();
  // CRM types (account / contact / list) are registered by the crm-connector
  // extension via the host boot path (createCrmModule() +
  // src/lib/register-all-object-types.ts), not here — this package must not
  // import the extension.
  // Blog registrations are host-owned now
  // (see `src/lib/register-all-object-types.ts`).
}
