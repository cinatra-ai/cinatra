import "server-only";

// WordPress trusted-site native READ-INJECTION builder (cinatra#2019 S4): the
// host-side computation that decides, per opted-in instance and per toolbox
// rebuild, WHICH advertised site tools (if any) may be handed to the model
// provider for direct execution — i.e. when the instance's site credential
// leaves cinatra's governed path. The connector toolbox calls the published
// `buildNativeReadInjection` member and renders exactly what it returns; all
// descriptor/fingerprint/policy logic lives HERE, host-side.
//
// FAIL-CLOSED, STATELESS, SUBTRACTIVE:
//   - There is NO persisted "verified set". Eligibility is recomputed on every
//     build from (opt-in row, ambient actor authority, freshly-acquired
//     catalog snapshots, shipped descriptor set). Drift ejects at the first
//     rebuild whose ACQUIRED snapshot reflects it — bounded by exactly the
//     invoker's own catalog freshness policy (TTL + bounded
//     serve-stale-on-refresh-failure); this module deliberately adds NO second
//     freshness policy and NO force-refresh.
//   - Every step refuses toward `null` (nothing injected, M1 unaffected). The
//     empty outcome is always safe and is the shipped v1 posture on the pinned
//     community stack (empty descriptor set — design D1).
//   - CONSENT IS CONTENT-EXACT: a `trusted_site` row is honored only while its
//     HOST-STAMPED `{descriptor-set version, descriptor-set hash, disclosure
//     version}` are EXACTLY the currently shipped constants. Older, newer, or
//     same-version-different-content stamps all refuse as `consent_stale`
//     (covers rollbacks and unbumped content edits alike, fail closed).
//   - DUAL-LAYER SURFACE ENFORCEMENT: only `surface === "chat"` may emit. The
//     connector toolbox short-circuits non-chat surfaces on its side; this
//     member re-refuses them host-side so a single-layer bug cannot widen the
//     injection surface to agent-run/widget/session turns.
//
// AUTHORITY: identity NEVER rides the call input. The per-instance USE
// authority derives from the host's ambient trusted actor stores
// (`resolveTrustedWriteActor`) plus the same explicit-actor `requireUse` gate
// core the governed invoker runs — one audited pass here on the host side of
// the trust computation (defense in depth beside the toolbox's own loop gate).
//
// AUDITS (policyVersion `connector-instance-native-injection`):
//   - `native_injection_emitted`  (allowed): instance, serverId, toolCount,
//     sha256 of the sorted name list — never schemas, headers or credentials.
//   - `native_injection_empty`    (denied): mode is ON but nothing emitted —
//     the operator's signal, with a typed reason (`consent_stale`,
//     `surface_not_chat`, acquire failures, per-conjunct ejection counts, …).
//     NEVER fired while the mode is off (off is the normal quiet state).
//   Both are latched in-process per (instance, catalog revision, verdict) —
//   bounded LRU + TTL, BEST-EFFORT noise reduction only: the authorization
//   record is the store's `native_injection_mode_changed` event, and a
//   restart double-fire is harmless.
//
// The org-admin-gated `explainNativeReadInjection` member is the DRY-RUN twin
// for the settings card: same computation, NO ambient-actor requirement, NO
// emission/empty audits, no credential material in the result — usable while
// the mode is off (the "what would qualify today" preview).

import { createHash } from "node:crypto";
import { logAuditEvent } from "@/lib/authz/audit";
import { roleHasPermission } from "@/lib/authz/policies";
import type { AuthzOrgRole } from "@/lib/auth-session";
import {
  CATALOG_DEFAULT_SERVER_ID,
  type CatalogServerSnapshot,
} from "@/lib/connector-instance-catalog-cache";
import type { EnrolledServerRef } from "@/lib/connector-instance-invoker";
import { WordPressNativeInjectionConsentError } from "@/lib/connector-instance-native-injection-consent";
import {
  NATIVE_INJECTION_POLICY_VERSION,
  type NativeInjectionPolicyView,
} from "@/lib/connector-instance-native-injection-store";
import {
  TRUSTED_READ_DESCRIPTOR_SET,
  resolveShippedTrustedSiteConsent,
  type ShippedTrustedSiteConsent,
  type TrustedReadDescriptorSet,
} from "@/lib/connector-instance-trusted-read-descriptors";
import {
  verifyTrustedReadSet,
  type TrustedReadEjection,
} from "@/lib/connector-instance-trusted-read-verifier";
import type {
  InstanceUseAuthorityGateInput,
  ResolvedActor,
} from "@/lib/connector-instance-write-authority";

/** The host-bound connector key this surface is hard-pinned to. */
const WORDPRESS_CONNECTOR_KEY = "wordpress";

/** The primitive name the per-instance USE authority pass audits under. */
export const NATIVE_READ_INJECTION_PRIMITIVE = "wordpress_native_read_injection";

/** Best-effort audit latch bounds (in-process; see the module header). */
const AUDIT_LATCH_TTL_MS = 10 * 60_000;
const AUDIT_LATCH_MAX_ENTRIES = 256;

/** Why a build produced nothing (the `native_injection_empty` reason). */
export type NativeReadInjectionEmptyReason =
  | "surface_not_chat"
  | "instance_unresolved"
  | "policy_unreadable"
  | "consent_stale"
  | "no_trusted_actor"
  | "use_authority_denied"
  | "acquire_failed"
  | "default_snapshot_missing"
  | "no_verified_tools";

/** A non-empty verified injection for the default adapter server. An empty
 * allowlist is UNREPRESENTABLE by contract — empty verdicts return `null`. */
export type WordPressNativeReadInjection = {
  serverId: string;
  /** The exact, sorted, NON-EMPTY verified wire-tool names. */
  allowedTools: string[];
};

export type WordPressNativeReadInjectionExplanation = {
  mode: NativeInjectionPolicyView["mode"];
  /** TRUE when a `trusted_site` row's stamps are not exactly the shipped
   * constants (the re-acknowledge ceremony is required before anything can
   * ever emit). Always FALSE while off. */
  consentStale: boolean;
  /** What the verifier would allow on the CURRENT snapshots (independent of
   * mode/consent — the preview works while off). */
  verifiedNames: string[];
  ejected: TrustedReadEjection[];
  /** Present when the snapshot acquire could not complete — the card renders
   * "preview unavailable" instead of a fake empty verdict. */
  previewUnavailableReason?: "acquire_failed" | "default_snapshot_missing";
};

/** The structural members the `wordpress-mcp` publication is widened with
 * (host-local, additive — NO SDK contract edit; absent members on an older
 * host read as "no native injection", fail closed). */
export type WordPressNativeReadInjectionSurface = {
  /** Compute the injection for one instance on one surface. `null` = inject
   * nothing (every refusal path). Only `surface === "chat"` can emit. */
  buildNativeReadInjection(input: {
    instanceId: string;
    surface: string;
  }): Promise<WordPressNativeReadInjection | null>;
  /** Org-admin-gated dry-run preview (settings card). Never audits emission
   * state, never returns credential material, works while the mode is off. */
  explainNativeReadInjection(input: {
    instanceId: string;
  }): Promise<WordPressNativeReadInjectionExplanation>;
};

export type WordPressNativeReadInjectionDeps = {
  /** Resolve the org that OWNS an instance from the persisted row — host-side,
   * never caller input. `null` for unknown/unbound instances. */
  resolveInstanceOrgId: (instanceId: string) => string | null;
  /** The opt-in policy reader (owner-org-scoped, fail-closed normalization —
   * connector-instance-native-injection-store). */
  readPolicy: (
    connectorKey: string,
    instanceId: string,
    ownerOrgId: string,
  ) => Promise<NativeInjectionPolicyView>;
  /** Ambient trusted actor resolution (`resolveTrustedWriteActor`). */
  resolveTrustedActor: () => Promise<ResolvedActor | null>;
  /** The explicit-actor per-instance USE gate core (one audited pass). */
  requireUse: (resolved: ResolvedActor, input: InstanceUseAuthorityGateInput) => Promise<void>;
  /** Acquire the instance's enrolled-server refs + catalog snapshots through
   * the governed invoker's acquire path (verbatim TTL/max-stale/fail-closed
   * semantics; the binder wires this — this module never resolves endpoints
   * and never sees credentials). MUST throw on store/endpoint failure. */
  acquireEnrolledSnapshots: (
    connectorKey: string,
    instanceId: string,
  ) => Promise<{ enrolled: EnrolledServerRef[]; snapshots: CatalogServerSnapshot[] }>;
  /** The cinatra known-destructive name floor (S5), OR'd into the verifier. */
  isKnownDestructiveToolName: (name: string) => boolean;
  /** The cookie-session requirement for the explain gate (`requireAuthSession`). */
  requireSession: () => Promise<{ user: { id: string } }>;
  /** Membership-role lookup in the owning org (explain gate). */
  resolveOrgRole: (orgId: string, userId: string) => Promise<AuthzOrgRole | undefined>;
  /** TEST-ONLY overrides. The production binder never passes them. */
  audit?: (event: Parameters<typeof logAuditEvent>[0]) => Promise<void> | void;
  shippedConsent?: ShippedTrustedSiteConsent;
  descriptorSet?: TrustedReadDescriptorSet;
  now?: () => number;
};

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Composite revision over the acquired snapshots (order-independent) — the
 * latch key component that ties an audit to one catalog state. */
function compositeRevisionOf(snapshots: readonly CatalogServerSnapshot[]): string {
  return snapshots
    .map((snapshot) => `${snapshot.serverId}@${snapshot.catalogRevision}`)
    .sort()
    .join("|");
}

/**
 * Build the two publication members. The binder calls this once at publish
 * time with the live host deps; tests call it with fakes.
 */
export function createWordPressNativeReadInjectionMembers(
  deps: WordPressNativeReadInjectionDeps,
): WordPressNativeReadInjectionSurface {
  const shipped = deps.shippedConsent ?? resolveShippedTrustedSiteConsent();
  const descriptor = deps.descriptorSet ?? TRUSTED_READ_DESCRIPTOR_SET;
  const auditSink = deps.audit ?? ((event: Parameters<typeof logAuditEvent>[0]) => logAuditEvent(event));
  const now = deps.now ?? (() => Date.now());

  // ---- best-effort in-process audit latch (bounded LRU + TTL) --------------
  const latch = new Map<string, number>();
  function shouldAudit(key: string): boolean {
    const at = now();
    const expiry = latch.get(key);
    if (expiry !== undefined && expiry > at) return false;
    latch.delete(key); // refresh insertion order (Map = LRU order)
    latch.set(key, at + AUDIT_LATCH_TTL_MS);
    if (latch.size > AUDIT_LATCH_MAX_ENTRIES) {
      for (const oldest of latch.keys()) {
        if (latch.size <= AUDIT_LATCH_MAX_ENTRIES) break;
        latch.delete(oldest);
      }
    }
    return true;
  }

  /** Fire the `native_injection_empty` operator signal (latched, best-effort,
   * never throws). `revision` scopes the latch to one catalog state; pre-
   * acquire refusals latch per reason. NEVER called by the explain member. */
  async function auditEmpty(input: {
    instanceId: string;
    reason: NativeReadInjectionEmptyReason;
    revision?: string;
    actor?: ResolvedActor | null;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    if (!shouldAudit(`${input.instanceId}::empty::${input.reason}::${input.revision ?? "pre-acquire"}`)) {
      return;
    }
    try {
      await auditSink({
        resourceType: "connector_instance",
        resourceId: input.instanceId,
        ...(input.actor
          ? {
              actorPrincipalType: "human",
              actorPrincipalId: input.actor.userId,
              organizationId: input.actor.orgId,
            }
          : { actorPrincipalType: "system" }),
        authSource: "worker",
        operation: "native_injection_empty",
        decision: "denied",
        policyVersion: NATIVE_INJECTION_POLICY_VERSION,
        metadata: {
          connectorKey: WORDPRESS_CONNECTOR_KEY,
          reason: input.reason,
          ...(input.revision ? { catalogRevision: input.revision } : {}),
          ...(input.metadata ?? {}),
        },
      });
    } catch {
      // Best-effort: an audit outage must never break (or widen) the build.
    }
  }

  /** Consent stamps must be EXACTLY the shipped constants (D3). */
  function consentIsCurrent(policy: NativeInjectionPolicyView): boolean {
    return (
      policy.descriptorSetVersion === shipped.descriptorSetVersion &&
      policy.descriptorSetHash === shipped.descriptorSetHash &&
      policy.disclosureVersion === shipped.disclosureVersion
    );
  }

  /** Resolve the owning org, collapsing lookup errors to null (fail closed). */
  function resolveOwnerOrgId(instanceId: unknown): string | null {
    if (typeof instanceId !== "string" || !instanceId.trim()) return null;
    try {
      return deps.resolveInstanceOrgId(instanceId);
    } catch {
      return null;
    }
  }

  type ComputedVerdict =
    | {
        ok: true;
        allowedTools: string[];
        ejected: TrustedReadEjection[];
        revision: string;
      }
    | { ok: false; reason: "acquire_failed" | "default_snapshot_missing" };

  /** Acquire + verify (shared by build and explain). Pure recomputation —
   * nothing is persisted; every failure collapses to a typed refusal. */
  async function computeVerifiedSet(instanceId: string): Promise<ComputedVerdict> {
    let acquired: { enrolled: EnrolledServerRef[]; snapshots: CatalogServerSnapshot[] };
    try {
      acquired = await deps.acquireEnrolledSnapshots(WORDPRESS_CONNECTOR_KEY, instanceId);
    } catch {
      return { ok: false, reason: "acquire_failed" };
    }
    const defaultServerSnapshot = acquired.snapshots.find(
      (snapshot) => snapshot.serverId === CATALOG_DEFAULT_SERVER_ID,
    );
    if (!defaultServerSnapshot) return { ok: false, reason: "default_snapshot_missing" };
    // Complete ⟺ every currently-enrolled server yielded a snapshot (a server
    // omitted past its stale window makes the duplicate rule unprovable).
    const servedIds = new Set(acquired.snapshots.map((snapshot) => snapshot.serverId));
    const enrollmentComplete = acquired.enrolled.every((server) => servedIds.has(server.serverId));
    const verdict = verifyTrustedReadSet({
      descriptor,
      defaultServerSnapshot,
      otherServerSnapshots: acquired.snapshots.filter(
        (snapshot) => snapshot.serverId !== CATALOG_DEFAULT_SERVER_ID,
      ),
      enrollmentComplete,
      isKnownDestructiveToolName: deps.isKnownDestructiveToolName,
    });
    return {
      ok: true,
      allowedTools: verdict.allowedTools,
      ejected: verdict.ejected,
      revision: compositeRevisionOf(acquired.snapshots),
    };
  }

  /** Histogram of ejection reasons for the empty-audit metadata. */
  function reasonCountsOf(ejected: readonly TrustedReadEjection[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const ejection of ejected) {
      counts[ejection.reason] = (counts[ejection.reason] ?? 0) + 1;
    }
    return counts;
  }

  return {
    buildNativeReadInjection: async (input) => {
      const instanceId = typeof input?.instanceId === "string" ? input.instanceId : "";
      if (!instanceId.trim()) return null; // unroutable — nothing to audit against

      // Step 0 — surface matrix (D5): only chat may emit; every other or
      // absent value refuses host-side regardless of what the caller gated.
      if (input?.surface !== "chat") {
        await auditEmpty({
          instanceId,
          reason: "surface_not_chat",
          metadata: { surface: typeof input?.surface === "string" ? input.surface : "absent" },
        });
        return null;
      }

      // Step 1 — opt-in + content-exact consent. OFF is silent (the default
      // state of the world); a stale acknowledgement is the operator signal.
      const ownerOrgId = resolveOwnerOrgId(instanceId);
      if (!ownerOrgId) {
        await auditEmpty({ instanceId, reason: "instance_unresolved" });
        return null;
      }
      let policy: NativeInjectionPolicyView;
      try {
        policy = await deps.readPolicy(WORDPRESS_CONNECTOR_KEY, instanceId, ownerOrgId);
      } catch {
        await auditEmpty({ instanceId, reason: "policy_unreadable" });
        return null;
      }
      if (policy.mode !== "trusted_site") return null;
      if (!consentIsCurrent(policy)) {
        await auditEmpty({
          instanceId,
          reason: "consent_stale",
          metadata: {
            stampedDescriptorSetVersion: policy.descriptorSetVersion,
            shippedDescriptorSetVersion: shipped.descriptorSetVersion,
            stampedDisclosureVersion: policy.disclosureVersion,
            shippedDisclosureVersion: shipped.disclosureVersion,
            descriptorSetHashMatches: policy.descriptorSetHash === shipped.descriptorSetHash,
          },
        });
        return null;
      }

      // Step 2 — ambient trusted actor + the explicit per-instance USE pass.
      let actor: ResolvedActor | null = null;
      try {
        actor = await deps.resolveTrustedActor();
      } catch {
        actor = null;
      }
      if (!actor) {
        await auditEmpty({ instanceId, reason: "no_trusted_actor" });
        return null;
      }
      try {
        await deps.requireUse(actor, {
          instanceId,
          primitiveName: NATIVE_READ_INJECTION_PRIMITIVE,
          sourceType: "chat",
        });
      } catch {
        await auditEmpty({ instanceId, reason: "use_authority_denied", actor });
        return null;
      }

      // Step 3 — acquire through the invoker's freshness path (injected).
      const computed = await computeVerifiedSet(instanceId);
      if (!computed.ok) {
        await auditEmpty({ instanceId, reason: computed.reason, actor });
        return null;
      }

      // Step 4 — the verdict. Empty ⇒ null (never an empty-allowlist entry).
      if (computed.allowedTools.length === 0) {
        await auditEmpty({
          instanceId,
          reason: "no_verified_tools",
          revision: computed.revision,
          actor,
          metadata: {
            descriptorSetSize: descriptor.entries.length,
            descriptorSetEmpty: descriptor.entries.length === 0,
            ejectedReasonCounts: reasonCountsOf(computed.ejected),
          },
        });
        return null;
      }

      const namesSha256 = sha256Hex(computed.allowedTools.join("\n"));
      if (shouldAudit(`${instanceId}::emitted::${computed.revision}::${namesSha256}`)) {
        try {
          await auditSink({
            resourceType: "connector_instance",
            resourceId: instanceId,
            actorPrincipalType: "human",
            actorPrincipalId: actor.userId,
            organizationId: actor.orgId,
            authSource: "worker",
            operation: "native_injection_emitted",
            decision: "allowed",
            policyVersion: NATIVE_INJECTION_POLICY_VERSION,
            metadata: {
              connectorKey: WORDPRESS_CONNECTOR_KEY,
              serverId: CATALOG_DEFAULT_SERVER_ID,
              toolCount: computed.allowedTools.length,
              allowedNamesSha256: namesSha256,
              catalogRevision: computed.revision,
            },
          });
        } catch {
          // Best-effort (see the module header) — the mode-change audit is the
          // authorization record; emission telemetry must never block a build.
        }
      }
      return { serverId: CATALOG_DEFAULT_SERVER_ID, allowedTools: computed.allowedTools };
    },

    explainNativeReadInjection: async (input) => {
      // Org-admin gate — the α consent-member semantics verbatim: ONE opaque
      // refusal for unknown instance / unbound / non-member / non-admin alike
      // (no instance-existence oracle), no platform-admin synthesis.
      const instanceId = input?.instanceId;
      if (typeof instanceId !== "string" || !instanceId.trim()) {
        throw new WordPressNativeInjectionConsentError("invalid_input");
      }
      const session = await deps.requireSession();
      const userId = session?.user?.id;
      if (!userId) {
        throw new WordPressNativeInjectionConsentError("not_authorized_for_instance");
      }
      const ownerOrgId = resolveOwnerOrgId(instanceId);
      if (!ownerOrgId) {
        throw new WordPressNativeInjectionConsentError("not_authorized_for_instance");
      }
      const role = await deps.resolveOrgRole(ownerOrgId, userId).catch(() => undefined);
      if (!role || !roleHasPermission(role, "connector.update")) {
        throw new WordPressNativeInjectionConsentError("not_authorized_for_instance");
      }

      const policy = await deps.readPolicy(WORDPRESS_CONNECTOR_KEY, instanceId, ownerOrgId);
      const consentStale = policy.mode === "trusted_site" && !consentIsCurrent(policy);

      // DRY-RUN: the same recomputation the build performs — but NO ambient-
      // actor requirement (the org-admin session IS the authority here), NO
      // emission/empty audits, and no credential-bearing material in or out.
      const computed = await computeVerifiedSet(instanceId);
      if (!computed.ok) {
        return {
          mode: policy.mode,
          consentStale,
          verifiedNames: [],
          ejected: [],
          previewUnavailableReason: computed.reason,
        };
      }
      return {
        mode: policy.mode,
        consentStale,
        verifiedNames: computed.allowedTools,
        ejected: computed.ejected,
      };
    },
  };
}
