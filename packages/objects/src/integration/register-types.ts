import "server-only";

import { createHash } from "node:crypto";
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
  CONNECTOR_REF_ARTIFACT_TYPE,
  CONNECTOR_REF_SNAPSHOT_ORIGIN_KIND,
  connectorRefPointerSchema,
} from "../connector-ref";
import {
  GenericObjectListRow,
  GenericObjectCard,
  GenericObjectDetail,
  MemoryConceptListRow,
  MemoryConceptCard,
  MemoryConceptDetail,
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
// Email transport + work-product object types.
//
// Provider-neutral object types backing the @cinatra-ai/email-connector facade
// (sender-identity, sent-email, received-reply, thread) plus the two work
// products the @cinatra-ai/email-artifacts pack claims (body, recipient —
// cinatra#1454). The transport records are platform-write (`sources: ["agent",
// "import"]`); the draftable `body` additionally admits `user` edits. Generic
// renderers are sufficient — the data is read by orchestration code and the
// notifications/inbox/library surfaces, not edited inline. The TYPE registrar
// for every `@cinatra-ai/email:*` type stays host-side HERE; the pack's manifest
// claims (packages/objects reads them via the artifact bridge) add only the
// per-type disposition / mutability class / arbitration — never a second
// registrar (epic #1448: exactly one runtime registrar per type).
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

  // 5. body — the reusable body of a sent/retained email message. The
  // @cinatra-ai/email-artifacts pack CLAIMS this type [draftable] and absorbs
  // the former single-type @cinatra-ai/email-body-artifact (cinatra#1454). The
  // TYPE registrar stays host-side here (the claim adds disposition/mutability/
  // arbitration, not a second registrar). `draftable` narrows a NON-empty
  // mutableBy baseline (draftable requires draft-state edits), so mutableBy is
  // ["agent","user"]. Run-scoped per-email bodies dedup on (runId, contactId);
  // uploaded/library bodies with no run frame keep their random-UUID identity
  // (identityKey → null), preserving existing artifact ids.
  objectTypeRegistry.register({
    type: "@cinatra-ai/email:body",
    category: "content",
    schema: z.object({
      subject: z.string().optional(),
      bodyMarkdown: z.string().optional(),
      connectorId: z.string().optional(),
      campaignId: z.string().optional(),
      contactId: z.string().optional(),
      runId: z.string().optional(),
    }),
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
      const runId = typeof d.runId === "string" && d.runId.length > 0 ? d.runId : null;
      if (!runId) return null;
      const contactId =
        typeof d.contactId === "string" && d.contactId.length > 0 ? d.contactId : null;
      return contactId ? `${runId}:${contactId}` : runId;
    },
  });

  // 6. recipient — a run-scoped delivery-target SNAPSHOT (cinatra#1454). NEVER a
  // person/contact: `contactKey`/`contactId` are connector-scoped soft
  // provenance only, no CRM writeback. The @cinatra-ai/email-artifacts pack
  // claims this type [record] with `projection: "none"` + `sensitivity:
  // "sensitive"` (addresses are kept out of the derived index by the claim; the
  // row still carries `email` for delivery + fallback identity). Mandatory
  // retry-safe identity (cinatra#1454): (runId + provider-scoped contactKey),
  // normalized-email fallback — a retry within the same run updates the snapshot
  // in place; no run frame yields no identity (HITL rather than a global merge).
  objectTypeRegistry.register({
    type: "@cinatra-ai/email:recipient",
    category: "report",
    schema: z.object({
      runId: z.string().min(1),
      connectorId: z.string().optional(),
      contactKey: z.string().optional(),
      // `.trim().min(1)` normalizes and rejects a whitespace-only address — the
      // normalized-email fallback identity below must never collapse to an empty
      // contact key.
      email: z.string().trim().min(1),
      campaignId: z.string().optional(),
      confirmed: z.boolean().optional(),
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
      const runId = typeof d.runId === "string" && d.runId.length > 0 ? d.runId : null;
      if (!runId) return null;
      const contactKey =
        typeof d.contactKey === "string" && d.contactKey.length > 0 ? d.contactKey : null;
      if (contactKey) return `${runId}:${contactKey}`;
      // Normalize FIRST, then require a non-empty result — a whitespace-only
      // email must yield no identity (HITL) rather than a bare `${runId}:`.
      const email = typeof d.email === "string" ? d.email.trim().toLowerCase() : "";
      return email.length > 0 ? `${runId}:${email}` : null;
    },
  });
}

// ---------------------------------------------------------------------------
// @cinatra-ai/memory:concept — envelope contract (cinatra#1376, epic #1373).
// ---------------------------------------------------------------------------
//
// Memory rows take the deterministic static-type path: `objects_save` with the
// exact `typeHint` resolves against the static registry (no classifier LLM
// call), and the registered Zod schema below is enforced on the write path
// (`packages/objects/src/mcp/handlers.ts`) before any commit. Memory files are
// untrusted input end-to-end, so every invariant here is validated
// server-side — the sync client's own checks are advisory only.
//
// Defined INLINE in this module (not a sibling file) on purpose: this module
// is reachable from the locked route-graph budgets (via the package barrel /
// createObjectsModule), so a new first-party sibling module would grow every
// locked route by one. Inline schemas are this file's existing idiom (see the
// email object types above). The barrel re-exports these symbols for the
// memory sync path (epic S5) and tests.

/** The static object type id for a memory concept row. */
export const MEMORY_CONCEPT_TYPE_ID = "@cinatra-ai/memory:concept" as const;

/** Hard cap on `bodyMarkdown`, measured in UTF-8 BYTES (not JS chars). */
export const MEMORY_CONCEPT_BODY_MAX_BYTES = 64 * 1024;

/**
 * Deterministic external identity of a concept row:
 * `sha256(UTF-8(bundleId + NUL + conceptId))`, lowercase hex. Inputs are
 * case-sensitive (path = identity under OKF; no normalization). The NUL
 * separator makes the concatenation injective — neither field may contain
 * NUL (the envelope schema rejects it in `conceptId`; a UUID never has one).
 */
export function computeMemoryConceptExternalId(
  bundleId: string,
  conceptId: string,
): string {
  return createHash("sha256")
    .update(`${bundleId}\u0000${conceptId}`, "utf8")
    .digest("hex");
}

/**
 * A concept id is a RELATIVE POSIX path (path = identity in OKF 0.1) with the
 * `.md` suffix already stripped by the sync layer:
 * - non-empty, `/`-separated segments, each segment non-empty (no `//`,
 *   no leading or trailing `/`),
 * - no `.` / `..` segments (no traversal), no backslashes, no NUL,
 * - must NOT end with `.md` (the suffix belongs to the file, not the
 *   identity; case-sensitive like the rest of the path).
 */
export function isValidMemoryConceptId(conceptId: string): boolean {
  if (conceptId.length === 0) return false;
  if (conceptId.includes("\u0000") || conceptId.includes("\\")) return false;
  if (conceptId.endsWith(".md")) return false;
  const segments = conceptId.split("/");
  return segments.every((s) => s.length > 0 && s !== "." && s !== "..");
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

const memoryConceptLinkSchema = z
  .object({
    /** Raw link target as written in the Markdown (untyped in OKF 0.1). */
    target: z.string().min(1),
    /** Present when the sync layer resolved the target to a concept id. */
    resolvedConceptId: z.string().min(1).optional(),
  })
  .strict();

/**
 * Envelope schema for `@cinatra-ai/memory:concept` rows.
 *
 * Validation-only on the write path: the handler safeParses the SAME enriched
 * shape that gets stored, so unknown TOP-LEVEL keys (e.g. the system-injected
 * `cinatraAgentRunId`) are tolerated, `frontmatter` preserves unknown keys
 * (tolerant OKF consumption), and `links` entries are strict (the fixed
 * `{ target, resolvedConceptId? }` contract).
 *
 * Cross-field invariants:
 * - `externalId` must equal `sha256(UTF-8(bundleId + NUL + conceptId))`
 *   (case-sensitive; the server recomputes and rejects mismatches),
 * - `okfType` must equal `frontmatter.type` (the sole required OKF field),
 * - `bodyMarkdown` is capped at 64 KiB of UTF-8 bytes.
 */
export const memoryConceptEnvelopeSchema = z
  .object({
    conceptId: z
      .string()
      .min(1)
      .refine(isValidMemoryConceptId, {
        message:
          "conceptId must be a relative POSIX path without `.`/`..` segments, backslashes, or a `.md` suffix",
      }),
    bundleId: z.uuid({ message: "bundleId must be a UUID" }),
    externalId: z
      .string()
      .regex(SHA256_HEX_RE, {
        message: "externalId must be 64 lowercase hex chars (sha256)",
      }),
    okfType: z.string().min(1),
    // Unknown frontmatter keys are PRESERVED (tolerant consumption); only
    // `type` is cross-checked against `okfType` below.
    frontmatter: z.record(z.string(), z.unknown()),
    bodyMarkdown: z.string().refine(
      (s) => new TextEncoder().encode(s).length <= MEMORY_CONCEPT_BODY_MAX_BYTES,
      {
        message: `bodyMarkdown exceeds the ${MEMORY_CONCEPT_BODY_MAX_BYTES}-byte (64 KiB) cap`,
      },
    ),
    links: z.array(memoryConceptLinkSchema),
    okfVersion: z.string().min(1).default("0.1"),
  })
  .superRefine((env, ctx) => {
    const computed = computeMemoryConceptExternalId(env.bundleId, env.conceptId);
    if (env.externalId !== computed) {
      ctx.addIssue({
        code: "custom",
        path: ["externalId"],
        message:
          "externalId does not match sha256(UTF-8(bundleId + NUL + conceptId)) recomputed by the server",
      });
    }
    const frontmatterType = env.frontmatter["type"];
    if (typeof frontmatterType !== "string" || frontmatterType !== env.okfType) {
      ctx.addIssue({
        code: "custom",
        path: ["okfType"],
        message: "okfType must equal frontmatter.type (a non-empty string)",
      });
    }
  });

export type MemoryConceptEnvelope = z.infer<typeof memoryConceptEnvelopeSchema>;

// ---------------------------------------------------------------------------
// @cinatra-ai/memory:concept (cinatra#1376, epic #1373) — the agent-memory
// static type. Memory rows take the deterministic static-type path (exact
// `typeHint` resolves in the registry — no classifier LLM call) and the
// registered envelope schema above is ENFORCED on the
// objects_save / objects_update write paths (memory-scoped in #1376;
// generalizing enforcement to other static types is follow-up work).
//
// Identity is the envelope's `externalId` (= sha256(bundleId + NUL +
// conceptId), server-recomputed): the layered resolver picks it up as the
// explicit external key, and the identityKey below states the same fact for
// registry consumers. Re-syncing the same concept file therefore updates the
// existing row instead of minting a duplicate.
//
// No crudPolicy on purpose: the automap dispatcher must never auto-write
// memory envelopes (types without a policy always escalate to HITL); the
// memory sync path (epic S5) writes explicitly via objects_save.
export function registerMemoryConceptType(): void {
  objectTypeRegistry.register({
    type: MEMORY_CONCEPT_TYPE_ID,
    category: "content",
    schema: memoryConceptEnvelopeSchema,
    lifecycle: {
      // Filesystem is authoritative for memory content in this iteration:
      // rows arrive from agent-driven sync (or an import), and only agents
      // may mutate them — there is no Cinatra-side user edit surface.
      sources: ["agent", "import"],
      mutableBy: ["agent"],
    },
    renderers: {
      listRow: MemoryConceptListRow,
      card: MemoryConceptCard,
      detail: MemoryConceptDetail,
    },
    identityKey: (data) => {
      const d = data as Record<string, unknown>;
      const externalId = d.externalId;
      return typeof externalId === "string" && externalId.length > 0
        ? externalId
        : null;
    },
  });
}

// ---------------------------------------------------------------------------
// WordPress external-pointer type (cinatra#1464, epic #1448). The host-side
// TYPE registrar for `@cinatra-ai/wordpress:post` — the ONE runtime registrar
// the `@cinatra-ai/wordpress-artifacts` pack's manifest claim binds its
// dispositions to (mutability `external`, pinnable:false; the pack adds
// disposition/arbitration, never a second registrar). Its row `data` is the
// connectorRef external-pointer artifact payload built by the pointer lifecycle
// substrate (cinatra#1451): a bare-identity pointer (url + connector/external
// ids + reference state + light title/excerpt), never the post body — the body
// is read on demand through the wordpress-mcp-connector facade. Reusing the
// substrate's `connectorRefPointerSchema` (strict) keeps the persisted pointer
// shape byte-aligned with `buildConnectorRefArtifactData` / the read + sync
// paths, so the write path can never persist a pointer the substrate rejects.
//
// Identity = `<connectorId>:<externalId>`, where the connector writes
// `externalId` as the SITE-scoped WordPress post identity (`<instanceId>:<postId>`,
// a WP post id is unique only within a site) — i.e. rows are keyed to
// instance + WordPress post id (cinatra#1464). Category `content` (a post is
// content). Baseline `mutableBy: ["agent"]` (the connector sync writes it on the
// agent channel); the pack's `external` claim NARROWS that to no post-create
// user/agent edit — the reference state moves ONLY via connector sync
// (linked→stale→dangling), a channel outside this vocabulary. No crudPolicy: the
// automap dispatcher must never auto-write external pointers (writes are the
// connector sync's explicit objects_save, HITL otherwise).
//
// NOT this type: cinatra-authored blog content stays `blog-post-artifact`
// (connector-independent) — two different types, no ambiguity; existing
// blog-pipeline publish state on domain rows is not migrated here.
const WORDPRESS_POST_TYPE_ID = "@cinatra-ai/wordpress:post";

const wordpressPostSchema = z.object({
  // The connectorRef artifact-data envelope (built by buildConnectorRefArtifactData).
  artifactType: z.literal(CONNECTOR_REF_ARTIFACT_TYPE),
  originKind: z.literal(CONNECTOR_REF_SNAPSHOT_ORIGIN_KIND),
  mime: z.string().min(1),
  // Light display metadata (safe to project; NEVER the post body).
  title: z.string().optional(),
  excerpt: z.string().optional(),
  // The strict lifecycle pointer — the SINGLE source of truth for the shape.
  connectorRef: connectorRefPointerSchema,
});

export function registerWordPressObjectTypes(): void {
  objectTypeRegistry.register({
    type: WORDPRESS_POST_TYPE_ID,
    category: "content",
    schema: wordpressPostSchema,
    lifecycle: {
      // Rows arrive from connector sync (agent channel) or an import. The pack's
      // `external` mutability claim narrows post-create mutation to none — the
      // reference state changes only via connector sync.
      sources: ["agent", "import"],
      mutableBy: ["agent"],
    },
    renderers: {
      listRow: GenericObjectListRow,
      card: GenericObjectCard,
      detail: GenericObjectDetail,
    },
    identityKey: (data) => {
      const d = data as { connectorRef?: { connectorId?: unknown; externalId?: unknown } };
      const connectorId =
        typeof d.connectorRef?.connectorId === "string" ? d.connectorRef.connectorId : null;
      // externalId is the site-scoped post identity `<instanceId>:<postId>`.
      const externalId =
        typeof d.connectorRef?.externalId === "string" ? d.connectorRef.externalId : null;
      return connectorId && externalId ? `${connectorId}:${externalId}` : null;
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
  registerMemoryConceptType();
  registerWordPressObjectTypes();
  // CRM types (account / contact / list) are registered by the crm-connector
  // extension via the host boot path (createCrmModule() +
  // src/lib/register-all-object-types.ts), not here — this package must not
  // import the extension.
  // Blog registrations are host-owned now
  // (see `src/lib/register-all-object-types.ts`).
}
