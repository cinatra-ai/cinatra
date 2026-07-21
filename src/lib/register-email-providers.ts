import "server-only";

// ---------------------------------------------------------------------------
// Host-side email ROUTING services.
//
// Transport-registration cutover: this module no longer imports any email provider package.
// Concrete providers (gmail, resend, future smtp/ses) register themselves
// behind the `email-send` capability from their own `serverEntry`
// (`register(ctx)` → `ctx.capabilities.registerProvider("email-send", …)`),
// and the email facade extension configures itself at activation by resolving
// the HOST-side routing impls this module publishes under the
// `@cinatra-ai/host:email-routing` capability:
//
//   1. the sender-identity objects lookup chain (host knows the objects layer
//      + actor model; the facade does not),
//   2. the dev-mode recipient override (host knows the connector-config KV),
//   3. the best-effort sent-email object writer.
//
// The final routing step — "fall back to the first registered provider" —
// lives in the facade itself (it owns the registry), so `resolveConnectorId`
// here returns null when no explicit/identity step resolves.
// ---------------------------------------------------------------------------

import { readConnectorConfigFromDatabase } from "@/lib/database";
import { createSessionObjectsClient } from "@cinatra-ai/objects";
import { POLICY_VERSION, type ActorContext } from "@/lib/authz/actor-context";
import { registerCapabilityProvider } from "@/lib/extension-capabilities-registry";
import { HOST_CONNECTOR_SERVICE_CAPABILITIES } from "@cinatra-ai/sdk-extensions/internal";
import type { EmailTransportCorrelation } from "@cinatra-ai/sdk-extensions";
import { deriveThreadId } from "@/lib/email-thread-key";

/**
 * Build the objects-read actor the routing resolver uses to surface the run
 * owner's sender-identity objects.
 *
 * D3 (#1625): a ROLE-LESS `System` actor is DENIED `object.read` by the
 * authz kernel — `System` principals carry NO synthetic role (enforce.ts:48-60),
 * `object.read` is granted only to platform_admin/org_admin/member
 * (policies.ts), so `filterByAuthz` silently drops EVERY sender-identity row and
 * the whole routing chain returns null (the facade then falls through to the
 * first-registered connector, i.e. gmail — "Google OAuth is not connected").
 *
 * This actor instead represents the RUN OWNER's own read authority, scoped to
 * their org. Two shapes:
 *
 *   - With a `userId` (the run owner): `principalType:"HumanUser"` +
 *     `principalId:userId`. The objects envelope carries `userId` ONLY for human
 *     principals (objects-actor-envelope.ts:63-65) — that is what surfaces the
 *     SQL user-owner axis (`owner_level='user' AND owner_id=userId`,
 *     derived-store-ownership.ts:95) and the `decideResourceAccess` owner
 *     short-circuit, so the owner's OWN (default-`private`) mailbox identity is
 *     readable. A `System`/`platform_admin` actor could NEVER reach it: their
 *     principalId is not the owner's userId, and platform_admin only widens the
 *     `public` SQL clause, not the user-owner axis. `orgRole:"member"` grants
 *     `object.read` for the ORG-owned identity (step 4) WITHOUT the
 *     platform_admin cross-org bypass.
 *
 *   - Without a `userId` (a pure org-scoped send): `System` + `orgRole:"member"`.
 *     Org-visible identities still resolve via the org clause; the (skipped) user
 *     step needs no owner axis. This is the accepted trusted policy "an internal
 *     org-scoped routing read may use the org-visible default mailbox"; it CANNOT
 *     read any user-private row (no owner-axis principal).
 *
 * MEMBERSHIP-STALENESS (accepted policy): `orgRole:"member"` is the least-
 * privilege floor a run owner holds in their run's org. We do NOT re-validate
 * live membership here — that MIRRORS the established run-derived-actor policy in
 * build-actor-context-from-run.ts:104-118 (#1131), which floors a run actor's
 * `orgRole` to `member` and documents that a run replays the owner's standing
 * for the run's lifetime ("ACCEPTED STALENESS"). A revoked-membership run owner
 * retaining read of the org-default mailbox for the duration of their own run is
 * the SAME retained-run-authority semantic, not a new grant.
 *
 * READ ONLY: this actor is consumed exclusively by `findSenderIdentityFor`
 * (objects_list) and `resolveSenderIdentityById` (objects_get). It never reaches
 * a write path — the object writers below use the separate ALS-scoped
 * `objectsClient` singleton, not this actor.
 */
function ownerReadActorForOrg(opts: {
  userId?: string;
  orgId: string | null;
}): ActorContext {
  const orgFields = opts.orgId ? { organizationId: opts.orgId } : {};
  if (opts.userId) {
    return {
      principalType: "HumanUser",
      principalId: opts.userId,
      ...orgFields,
      orgRole: "member",
      authSource: "worker",
      policyVersion: POLICY_VERSION,
    };
  }
  return {
    principalType: "System",
    principalId: "system",
    ...orgFields,
    orgRole: "member",
    authSource: "worker",
    policyVersion: POLICY_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Routing resolver
// ---------------------------------------------------------------------------

const SENDER_IDENTITY_TYPE = "@cinatra-ai/email:sender-identity";

type SenderIdentityData = {
  connectorId?: string;
  fromEmail?: string;
  ownerLevel?: "user" | "team" | "organization" | "workspace";
  ownerId?: string;
};

/**
 * List sender-identity objects scoped to a given owner. Uses the
 * deterministic objects client (read-only, no actor required for orgId-
 * scoped reads). Returns parsed-data identities; non-matching rows
 * filtered out client-side because `objects_list` only filters by type +
 * category, not by `data.<field>`. This is acceptable because
 * sender-identity record counts are expected to be small per org.
 */
// A user/org realistically has 1-3 sender-identity objects, but OTHER-owner
// sender-identity records share the same type and could push the target past a
// small page. Bump the page budget so the client-side owner filter doesn't miss
// a valid identity behind unrelated rows. (Server-side data.<field> filtering
// isn't exposed by objects_list; promoting to a structured filter is a
// future-scale TODO.)
const SENDER_IDENTITY_PAGE_BUDGET = 200;

async function findSenderIdentityFor(opts: {
  ownerLevel: "user" | "organization";
  ownerId: string;
  readActor: ActorContext;
}): Promise<SenderIdentityData | null> {
  try {
    const client = createSessionObjectsClient(opts.readActor);
    const { items } = await client.list({
      type: SENDER_IDENTITY_TYPE,
      limit: SENDER_IDENTITY_PAGE_BUDGET,
    });
    for (const item of items as Array<{ data?: Record<string, unknown> }>) {
      const data = item.data as SenderIdentityData | undefined;
      if (!data) continue;
      if (data.ownerLevel === opts.ownerLevel && data.ownerId === opts.ownerId) {
        if (typeof data.connectorId === "string" && data.connectorId.length > 0) {
          return data;
        }
      }
    }
    return null;
  } catch (err) {
    // This is an AUTO-resolve step (the caller did NOT explicitly pick this
    // identity) so a best-effort fall-through to the next chain step is
    // correct, but it must NOT be silent. A transient objects-layer failure
    // that routes to the org/first-registered connector is operationally
    // significant; surface it.
    console.warn(
      `[email-routing] sender-identity auto-resolve failed for ${opts.ownerLevel}:${opts.ownerId} ` +
        `(falling through to next routing step): ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * When the caller EXPLICITLY passes a senderIdentityId, a lookup ERROR must NOT
 * silently route to a different connector — that would send from the wrong
 * identity, a correctness bug.
 * Distinguish:
 *   - genuine not-found / no-connector → return null (chain falls through;
 *     the explicit id was stale, next step is acceptable)
 *   - real lookup error (permission / backend / schema) → THROW so the send
 *     fails loudly rather than mis-routing.
 */
async function resolveSenderIdentityById(
  senderIdentityId: string,
  readActor: ActorContext,
): Promise<SenderIdentityData | null> {
  let result: unknown;
  try {
    const client = createSessionObjectsClient(readActor);
    result = await client.get(senderIdentityId);
  } catch (err) {
    throw new Error(
      `Explicit senderIdentityId "${senderIdentityId}" could not be resolved ` +
        `(refusing to mis-route to a fallback connector): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // `objects_get` returns the `{ object }` envelope (handlers.ts:1206) — unwrap
  // it (reading `result.data` directly is always undefined). And VALIDATE the
  // type: without the `type` guard any readable object that happens to carry a
  // `data.connectorId` could masquerade as a sender-identity and mis-route the
  // send. A denied/not-found read returns `{ object: null }`.
  const object = (result as { object?: { type?: unknown; data?: unknown } | null } | null)
    ?.object;
  if (!object || object.type !== SENDER_IDENTITY_TYPE) return null; // not found / wrong type → chain may fall through
  const data = object.data as SenderIdentityData | undefined;
  if (!data) return null;
  return typeof data.connectorId === "string" && data.connectorId.length > 0
    ? data
    : null;
}

/**
 * Routing chain (the facade applies its own first-registered fallback after a
 * null return here):
 *   1. Explicit `connectorId` if caller passed one (no DB / object lookup)
 *   2. Explicit `senderIdentityId` → `objects_get` → identity's connectorId
 *   3. `userId` → first sender-identity object owned by user
 *   4. `orgId` → first sender-identity object owned by org
 *
 * Fall-through semantics:
 *   - Step 2 (EXPLICIT senderIdentityId): genuine not-found → fall through
 *     to step 3; a real lookup error → THROW (refuse to mis-route from an
 *     explicitly-chosen identity to a fallback connector).
 *   - Steps 3-4 (AUTO-resolve user/org): any failure → warn + fall through
 *     (the caller did not pick these; best-effort is correct here).
 */
async function resolveConnectorId(opts: {
  explicitConnectorId?: string;
  senderIdentityId?: string;
  userId?: string;
  orgId?: string;
}): Promise<string | null> {
  if (opts.explicitConnectorId) {
    return opts.explicitConnectorId;
  }

  // D3: build the owner-scoped read actor ONCE (the run owner's own read
  // authority within their org). Threaded into every objects read below so the
  // owner's (default-private) mailbox + the org-default identity are both
  // readable. A role-less System actor is authz-denied `object.read` and drops
  // every row (see `ownerReadActorForOrg`).
  const readActor = ownerReadActorForOrg({
    userId: opts.userId,
    orgId: opts.orgId ?? null,
  });

  if (opts.senderIdentityId) {
    const id = await resolveSenderIdentityById(opts.senderIdentityId, readActor);
    if (id?.connectorId) return id.connectorId;
  }

  if (opts.userId) {
    const userIdentity = await findSenderIdentityFor({
      ownerLevel: "user",
      ownerId: opts.userId,
      readActor,
    });
    if (userIdentity?.connectorId) return userIdentity.connectorId;
  }

  if (opts.orgId) {
    const orgIdentity = await findSenderIdentityFor({
      ownerLevel: "organization",
      ownerId: opts.orgId,
      readActor,
    });
    if (orgIdentity?.connectorId) return orgIdentity.connectorId;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Dev-mode recipient override
// ---------------------------------------------------------------------------

const DEV_OVERRIDE_KEY = "email-system-development";

type DevOverridableMessage = {
  to: string[];
  cc?: string[];
  bcc?: string[];
};

function applyDevModeOverride<M extends DevOverridableMessage>(msg: M): M {
  const settings = readConnectorConfigFromDatabase<{
    developmentModeEnabled?: boolean;
    overrideRecipientEmail?: string;
  }>(DEV_OVERRIDE_KEY, {});
  if (settings.developmentModeEnabled !== true) return msg;
  const override = String(settings.overrideRecipientEmail ?? "").trim();
  if (!override) {
    throw new Error(
      "Development mode is enabled, but no override recipient email is configured.",
    );
  }
  return { ...msg, to: [override], cc: [], bcc: [] };
}

// ---------------------------------------------------------------------------
// Sent-email object writer
// ---------------------------------------------------------------------------

type SentEmailReceiptLike = {
  providerId: string;
  providerMessageId: string;
  providerThreadId?: string;
  internetMessageId?: string;
  sentAt: string;
};

type SentEmailMessageLike = {
  fromEmail?: string;
  to: string[];
  subject: string;
};

/**
 * Narrow a correlation envelope to its NON-EMPTY string fields, so a blank or
 * whitespace-only id never lands on the record (an empty `campaignId` would
 * otherwise pollute a campaign view with a phantom "" bucket). Returns only the
 * keys actually present — the caller spreads the result so absent correlation
 * adds nothing to `rawData`.
 */
function correlationFields(
  correlation: EmailTransportCorrelation | undefined,
  keys: ReadonlyArray<keyof EmailTransportCorrelation>,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!correlation) return out;
  for (const key of keys) {
    const value = correlation[key];
    if (typeof value === "string" && value.trim() !== "") {
      out[key] = value.trim();
    }
  }
  return out;
}

/**
 * Best-effort write of the sent-email object after a successful
 * provider.send(). The facade calls this and swallows errors — the email
 * has already been delivered by this point, so failure here only loses
 * the semantic object record (the email_send_events audit row is still
 * written by the orchestration layer in trigger-email-send-use-cases.ts).
 *
 * Identity key on the sent-email object type is `idempotencyKey`,
 * synthesized as `email-send:<providerId>:<providerMessageId>` — a provider
 * message id is unique within a provider, so this is stable + collision-free
 * across recipients. The key does not include recipient and does not need to.
 *
 * cinatra#1456: when the send carried campaign / contact / run correlation
 * (the campaign send loop threads it through the facade), those ids are
 * persisted onto the record as SOFT provenance — plain id strings, never
 * artifact references — so the thread / campaign / contact views resolve from
 * an indexed field instead of a client-side scan. Absent correlation (platform
 * or test sends) simply omits the fields; it never fails the write.
 */
async function saveSentEmailObject(input: {
  msg: unknown;
  receipt: unknown;
  routing: {
    connectorId: string;
    senderIdentityId?: string;
    userId?: string;
    orgId?: string;
  };
  correlation?: EmailTransportCorrelation;
}): Promise<void> {
  // Defense-in-depth. The facade already wraps this callback in `.catch()`, but
  // a best-effort writer must be robust regardless of caller — never let an
  // objects-layer failure here surface as a thrown error to whatever invoked the
  // facade (the email was already delivered by the time this runs).
  try {
    const msg = input.msg as SentEmailMessageLike;
    const receipt = input.receipt as SentEmailReceiptLike;
    const { objectsClient } = await import("@cinatra-ai/objects");
    const idempotencyKey =
      `email-send:${receipt.providerId}:${receipt.providerMessageId}`;
    // Standardized thread correlation key (connectorId, providerThreadId) —
    // cinatra#1456. Derived on the sent-email record too (received-reply already
    // carries it) so a thread bucket is a single indexed `data->>'threadId'`
    // lookup across sends + replies. DERIVED correlation key, never an artifact
    // id. Omitted when the provider surfaced no thread id. Uses the SHARED
    // derivation (email-thread-key.ts) so writer + query seam never drift.
    const sentThreadId = deriveThreadId(input.routing.connectorId, receipt.providerThreadId);
    await objectsClient.save({
      typeHint: "@cinatra-ai/email:sent-email",
      rawData: {
        auditId: idempotencyKey, // synthetic — standalone email_send path has no real audit row
        idempotencyKey,
        connectorId: input.routing.connectorId,
        fromEmail: msg.fromEmail,
        toEmail: msg.to[0] ?? "",
        subject: msg.subject,
        providerMessageId: receipt.providerMessageId,
        providerThreadId: receipt.providerThreadId,
        internetMessageId: receipt.internetMessageId,
        sentAt: receipt.sentAt,
        ...(sentThreadId ? { threadId: sentThreadId } : {}),
        // Soft-provenance correlation (cinatra#1456). Spread AFTER the transport
        // fields; each key is present only when a non-empty id was carried.
        ...correlationFields(input.correlation, [
          "campaignId",
          "contactId",
          "runId",
          // #1625 — the run-scoped test-delivery send correlation. Both
          // persisted onto the sent-email record so the send primitive's
          // crash-reconciliation can query by submissionId and confirm per-draft
          // coverage. Soft provenance; omitted on ordinary sends.
          "submissionId",
          "draftId",
        ]),
      },
    });
  } catch (err) {
    console.warn(
      `[email-routing] sent-email object write failed (send already succeeded): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Received-reply object writer
// ---------------------------------------------------------------------------

type ReceivedReplyMatchLike = {
  providerId: string;
  providerMessageId: string;
  providerThreadId?: string;
  internetMessageId?: string;
  fromEmail: string;
  subject: string;
  snippet?: string;
  receivedAt: string;
};

/**
 * Best-effort write of a `@cinatra-ai/email:received-reply` object when a reply
 * lookup surfaces a match (cinatra#1456). Symmetric to the sent-email writer:
 * the reply watcher already delivered the observation, so a persistence failure
 * here only loses the semantic record and NEVER changes the lookup result the
 * caller receives.
 *
 * Identity key on the received-reply type is `internetMessageId` (globally
 * unique) with a `(connectorId, providerMessageId)` composite fallback, so a
 * re-observed reply updates its row instead of duplicating.
 *
 * `threadId` is written as the DERIVED correlation key
 * `<connectorId>:<providerThreadId>` — the SAME identity `@cinatra-ai/email:thread`
 * uses — so a reply and its originating sends resolve to one thread bucket. It
 * is a correlation key, never an artifact id (issue #1456: `threadId` redefined
 * as a derived key). Relate-back `campaignId` / `contactId` come from the sent
 * thread the watcher was polling (soft provenance, connector-scoped by
 * `connectorId`); a missing target never affects read / pin / delete / GC.
 */
async function saveReceivedReplyObject(input: {
  match: unknown;
  routing: {
    connectorId: string;
    userId?: string;
    orgId?: string;
  };
  correlation?: EmailTransportCorrelation;
}): Promise<void> {
  try {
    const match = input.match as ReceivedReplyMatchLike;
    const { objectsClient } = await import("@cinatra-ai/objects");
    const connectorId = input.routing.connectorId;
    // Derived thread correlation key: (connectorId, providerThreadId). The SHARED
    // derivation (email-thread-key.ts) — identical to the sent-email writer + the
    // query seam — so sends + replies share one bucket. Omitted when the provider
    // surfaced no thread id (a bare reply still persists, just uncorrelated).
    const providerThreadId =
      typeof match.providerThreadId === "string" && match.providerThreadId.trim() !== ""
        ? match.providerThreadId.trim()
        : undefined;
    const threadId = deriveThreadId(connectorId, match.providerThreadId);
    await objectsClient.save({
      typeHint: "@cinatra-ai/email:received-reply",
      rawData: {
        connectorId,
        providerMessageId: match.providerMessageId,
        providerThreadId,
        internetMessageId: match.internetMessageId,
        fromEmail: match.fromEmail,
        subject: match.subject,
        snippet: match.snippet,
        receivedAt: match.receivedAt,
        ...(threadId ? { threadId } : {}),
        // Relate-back correlation (campaign / contact) the caller already knows
        // from the sent thread. runId is a send-side frame with no meaning on a
        // reply, so it is deliberately excluded here.
        ...correlationFields(input.correlation, ["campaignId", "contactId"]),
      },
    });
  } catch (err) {
    console.warn(
      `[email-routing] received-reply object write failed (reply already observed): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

let _registered = false;

export function registerEmailProviders(): void {
  if (_registered) return;
  _registered = true;

  registerCapabilityProvider(HOST_CONNECTOR_SERVICE_CAPABILITIES.emailRouting, {
    packageName: "@cinatra-ai/host",
    impl: {
      resolveConnectorId,
      applyDevModeOverride,
      saveSentEmailObject,
      saveReceivedReplyObject,
    },
  });
}

// Auto-register on module load — boot paths import this module at startup
// (via instrumentation.node.ts or worker entrypoints). The email facade
// extension consumes the routing impls at its serverEntry activation.
registerEmailProviders();
