import "server-only";

// The S5 destructive-confirmation HOOK IMPL (cinatra#2020 design §7 / D6 / D7,
// PR-3). This sibling module owns everything BEHIND the invoker's step-3 seam:
//
//   - the host-derived surface vocabulary (`ConfirmationSurface`) + the pure
//     derivation from the VERIFIED delegated-actor discriminant (D6) the binder
//     calls in `resolveConnectorInstanceInvokerContext`;
//   - the DEFAULT MATRIX (D7): require-confirmation ON for `chat` + `session`,
//     OFF for `agent_run` + `public_site_widget` (both carry their own HITL
//     planes — run `pending_approval`/review-tasks; widget cms-review
//     proposals). Evaluation order: surface default → per-instance org override
//     (`connector_instance_confirmation_policy`) → verdict;
//   - the PARK leg: `parkPendingCall` (dedup/cap/size + fingerprints live in the
//     store) and the §2.1 model-facing message contract;
//   - the §7.3 audits this impl alone writes: `pending_call_parked` and
//     `confirmation_bypass_org_disabled` (the ONE config-driven bypass class
//     that gets its own row). Surface-default bypasses are deliberately NOT
//     separately rowed — the existing step-5 execution audit already records
//     `derivedClass` per call and the absent park row is the derivable signal.
//
// The INVOKER (connector-instance-invoker.ts) owns control flow only: it fires
// this hook at step 3 and throws typed `pending_confirmation` on a `park`
// verdict. Dependency direction is preserved — the invoker imports NO store;
// the binder (register-host-connector-services.ts) BINDS this impl into the
// deps literal and stashes the frame's `{runId, clientId}` forensics.
//
// FAIL-CLOSED DOCTRINE (§2.3): any infrastructure failure inside `fire` on a
// confirmation-required path — policy read, park transaction, or an audit-sink
// write — throws `InvokerError("confirmation_unavailable")`: a destructive call
// in a confirmation-required context REFUSES rather than executing unconfirmed,
// and an org-disabled bypass never proceeds with its audit row unwritten. (A
// parked row surviving such a refusal is harmless: a retry collapses onto it
// via the store's DB-enforced dedup arbiter and the card stays actionable.)
//
// AUDIT HYGIENE (codex r2 pin): audit metadata carries ids/hashes/sizes only —
// NEVER the raw `args` or the `endpointUrl` verbatim.

import { logAuditEvent } from "@/lib/authz/audit";
import {
  InvokerError,
  PENDING_CONFIRMATION_MESSAGE_PREFIX,
} from "@/lib/connector-instance-mcp-transport";
import type { ConnectorInstanceInvokerDeps } from "@/lib/connector-instance-invoker";
import {
  ARGS_MAX_BYTES,
  CONFIRMATION_POLICY_VERSION,
  PENDING_CALL_EXPIRY_MS,
  computeArgsDigest,
  parkPendingCall,
  readConfirmationPolicy,
  type PendingCallStoreDeps,
} from "@/lib/connector-instance-pending-call-store";

/** The invoker's widened step-3 hook slot (single source: the invoker deps). */
export type ConnectorInstanceDestructiveHook = NonNullable<
  ConnectorInstanceInvokerDeps["destructiveHook"]
>;
type DestructiveHookFireInput = Parameters<ConnectorInstanceDestructiveHook["fire"]>[0];

/**
 * The host-derived confirmation surface (D6). Computed ONLY from the VERIFIED
 * `delegatedActor.delegation` discriminant (transport-boundary-written,
 * token-verified) — never connector/model input. `session` covers the
 * non-delegated frames (cookie-session / dev-bearer) and is the fail-safe row
 * for anything unrecognized.
 */
export type ConfirmationSurface = "chat" | "agent_run" | "public_site_widget" | "session";

/**
 * The DEFAULT MATRIX (D7; the defaults are code — deliberately no per-surface
 * override knob in v1). `chat` is the issue's ON row and S7's exposure switch;
 * `session` is the fail-safe for any future non-delegated reachability
 * (unreachable today: no pin ⇒ `connector_key_underivable`); `agent_run` and
 * `public_site_widget` are the issue's explicit OFF rows — the run-plane HITL
 * (`pending_approval` / review tasks) and the widget cms-review proposal plane
 * own those surfaces.
 */
export const CONFIRMATION_SURFACE_DEFAULTS: Readonly<
  Record<ConfirmationSurface, "require" | "off">
> = {
  chat: "require",
  session: "require",
  agent_run: "off",
  public_site_widget: "off",
};

/**
 * Derive the ConfirmationSurface from the VERIFIED delegation discriminant
 * (D6). `null`/`undefined` (cookie-session / dev-bearer frames) → `session`;
 * an unknown FUTURE delegation kind also → `session` — the fail-safe REQUIRE
 * row, so a new surface can never silently skip confirmation by being
 * unenumerated here.
 */
export function deriveConfirmationSurface(
  delegation: string | null | undefined,
): ConfirmationSurface {
  switch (delegation) {
    case "chat":
      return "chat";
    case "agent_run":
      return "agent_run";
    case "public_site_widget":
      return "public_site_widget";
    default:
      return "session";
  }
}

/**
 * Normalize the invoker-input `sourceType` back onto the surface vocabulary at
 * FIRE time. The guard sets `sourceType` from `deriveConfirmationSurface`, so
 * the four members pass through verbatim; an absent or foreign value (an
 * internal caller that never set it) lands on `session` — fail-safe REQUIRE,
 * mirroring the derivation's unknown-kind posture.
 */
export function normalizeConfirmationSurface(
  sourceType: string | undefined,
): ConfirmationSurface {
  return sourceType === "chat" ||
    sourceType === "agent_run" ||
    sourceType === "public_site_widget" ||
    sourceType === "session"
    ? sourceType
    : "session";
}

/**
 * The §2.1 model-facing message contract for a parked call — the thrown
 * `InvokerError("pending_confirmation")` message IS the rendered tool result
 * (`isError:true`) the model reads. Self-describing by design so the M1
 * wrapper needs no mapping layer: it says the call did NOT run, where the card
 * is, and not to retry. The STABLE `pending_confirmation:` prefix
 * (`PENDING_CONFIRMATION_MESSAGE_PREFIX`, exported beside the error code) is
 * the chat panel's poll trigger — never re-word it. Card-location truthfulness
 * (§2.1): the viewer list is `(org, user)`-scoped, so BOTH require-surfaces
 * (`chat`, `session`) genuinely see the card in the user's cinatra chat panel,
 * and the OFF surfaces never park at all.
 */
export function buildPendingConfirmationMessage(input: {
  toolName: string;
  serverId: string;
  pendingCallId: string;
}): string {
  const minutes = Math.round(PENDING_CALL_EXPIRY_MS / 60_000);
  return (
    `${PENDING_CONFIRMATION_MESSAGE_PREFIX} the destructive tool "${input.toolName}" on server ` +
    `"${input.serverId}" was NOT executed. It requires the user's explicit confirmation and has ` +
    `been parked as pending call ${input.pendingCallId} (expires in ${minutes} minutes). ` +
    `A confirmation card is shown to the user in their cinatra chat. Do NOT retry or re-issue ` +
    `this call — a retry returns this same pending call. Tell the user briefly what the call ` +
    `will do and that they can confirm or deny it on the card.`
  );
}

export type ConnectorInstanceDestructiveHookDeps = {
  /** Park impl (default: the real store's `parkPendingCall`). Unit tests inject
   * a double; the store-integration test instead injects `storeDeps.query` and
   * keeps the REAL park. */
  park?: typeof parkPendingCall;
  /** Per-instance org-override read (default: the real `readConfirmationPolicy`). */
  readPolicy?: typeof readConfirmationPolicy;
  /** Store deps threaded into the DEFAULT park/readPolicy (query / transaction /
   * schema / audit injection). Also passed to injected overrides, which may
   * ignore it. */
  storeDeps?: PendingCallStoreDeps;
  /** §7.3 audit sink for the two hook-owned rows (default `logAuditEvent`). */
  audit?: (event: Parameters<typeof logAuditEvent>[0]) => Promise<void> | void;
  /** The binder's frame-forensics stash — `{runId, clientId}` from the ambient
   * MCP request frame, persisted into the park row's `context` column
   * (correlation only, never a decision input). */
  getForensicsContext?: () => { runId?: string; clientId?: string } | undefined;
  /** Sync kill-switch override (tests). Binding the hook ARMS it: the built
   * hook reports enabled by default — the S7 entry criterion is "S5 stages
   * merged AND the hook bound + enabled" (§7.2), and dark-by-construction
   * today comes from the matrix (only OFF-default surfaces can reach the
   * invoker before S7), not from a disabled hook. */
  enabled?: () => boolean;
};

/**
 * Build the invoker's step-3 `destructiveHook` (the binder's ONE new deps-literal
 * key). All decisions and persistence happen here; the returned `fire` resolves
 * to a `park` verdict (the invoker then throws `pending_confirmation`) or a
 * `continue` verdict with the bypass reason.
 */
export function buildConnectorInstanceDestructiveHook(
  deps: ConnectorInstanceDestructiveHookDeps = {},
): ConnectorInstanceDestructiveHook {
  const park = deps.park ?? parkPendingCall;
  const readPolicy = deps.readPolicy ?? readConfirmationPolicy;
  const audit = deps.audit ?? logAuditEvent;

  return {
    enabled: deps.enabled ?? (() => true),
    fire: async (input: DestructiveHookFireInput) => {
      // Matrix leg 1 — surface default (D7). OFF surfaces continue WITHOUT a
      // policy read or an audit row (§7.3: the absent park row is the signal;
      // step-5's execution audit already records `derivedClass`).
      const surface = normalizeConfirmationSurface(input.sourceType);
      if (CONFIRMATION_SURFACE_DEFAULTS[surface] === "off") {
        return { action: "continue", reason: "surface_default_off" } as const;
      }

      try {
        // Matrix leg 2 — the per-instance org override (§7.2). Absent row =
        // defaults. `disabled` turns require → off for THIS instance and is the
        // one bypass class that writes its own audit row (§7.3) — awaited
        // un-guarded: the bypass may not proceed with the row unwritten.
        const policy = await readPolicy(input.connectorKey, input.instanceId, deps.storeDeps);
        if (policy?.mode === "disabled") {
          await audit({
            resourceType: "connector_instance",
            resourceId: input.instanceId,
            actorPrincipalType: "human",
            actorPrincipalId: input.actor.userId,
            organizationId: input.actor.orgId,
            authSource: "mcp",
            operation: "confirmation_bypass_org_disabled",
            decision: "allowed",
            policyVersion: CONFIRMATION_POLICY_VERSION,
            metadata: {
              connectorKey: input.connectorKey,
              serverId: input.serverId,
              toolName: input.toolName,
              surface,
              derivedClass: input.derivedClass,
              floorHit: input.floorHit,
              ...(input.causation ? { causation: input.causation } : {}),
            },
          });
          return { action: "continue", reason: "org_disabled" } as const;
        }

        // Park leg (D2). The store owns the advisory-locked transaction, the
        // DB-enforced dedup arbiter, the live-cap and the size cap, and the
        // park-time tool/target fingerprints (ONE shared helper family with the
        // PR-4 resume — store §-header contract).
        const forensics = deps.getForensicsContext?.();
        const context: Record<string, unknown> = {
          ...(forensics?.runId ? { runId: forensics.runId } : {}),
          ...(forensics?.clientId ? { clientId: forensics.clientId } : {}),
          ...(input.catalogRevision ? { catalogRevision: input.catalogRevision } : {}),
        };
        const parked = await park(
          {
            connectorKey: input.connectorKey,
            instanceId: input.instanceId,
            serverId: input.serverId,
            toolName: input.toolName,
            args: input.args,
            endpointUrl: input.endpointUrl,
            inputSchema: input.inputSchema,
            rawAnnotations: input.rawAnnotations,
            // The row's derived_class column (§3): 'destructive' = the
            // annotation verdict said so; 'floor' = the name floor alone
            // triggered (annotations read/write) — audit keeps both raw flags.
            derivedClass: input.derivedClass === "destructive" ? "destructive" : "floor",
            surface,
            userId: input.actor.userId,
            orgId: input.actor.orgId,
            primitiveName: input.primitiveName ?? null,
            intent: input.intent ?? null,
            causation: input.causation ?? null,
            context: Object.keys(context).length > 0 ? context : null,
          },
          deps.storeDeps,
        );

        if (parked.outcome === "args_too_large") {
          throw new InvokerError(
            "confirmation_args_too_large",
            `the destructive tool "${input.toolName}" was NOT executed: its arguments ` +
              `(${parked.argsBytes} bytes canonical JSON) exceed the ${ARGS_MAX_BYTES}-byte ` +
              `confirmation cap, and an uninspectable payload cannot be parked for one-click ` +
              `approval. Reduce the argument payload and try again.`,
          );
        }
        if (parked.outcome === "cap_exceeded") {
          throw new InvokerError(
            "confirmation_unavailable",
            `the destructive tool "${input.toolName}" was NOT executed: too many pending ` +
              `confirmations for this tool — ask the user to resolve or cancel the existing ` +
              `confirmation cards first.`,
          );
        }

        // §7.3 `pending_call_parked` — awaited un-guarded (fail-closed doctrine
        // above); `reused: true` marks a dedup collapse onto an existing card
        // (the message contract's "a retry returns this same pending call").
        const { hash: argsHash, bytes: argsBytes } = computeArgsDigest(input.args);
        await audit({
          resourceType: "connector_instance",
          resourceId: input.instanceId,
          actorPrincipalType: "human",
          actorPrincipalId: input.actor.userId,
          organizationId: input.actor.orgId,
          authSource: "mcp",
          operation: "pending_call_parked",
          decision: "denied",
          policyVersion: CONFIRMATION_POLICY_VERSION,
          metadata: {
            connectorKey: input.connectorKey,
            serverId: input.serverId,
            toolName: input.toolName,
            pendingCallId: parked.id,
            surface,
            derivedClass: input.derivedClass,
            floorHit: input.floorHit,
            argsHash,
            argsBytes,
            expiresAt: parked.expiresAt,
            reused: parked.reused,
            ...(input.primitiveName ? { primitiveName: input.primitiveName } : {}),
            ...(input.causation ? { causation: input.causation } : {}),
          },
        });

        return {
          action: "park",
          pendingCallId: parked.id,
          expiresAt: parked.expiresAt,
          message: buildPendingConfirmationMessage({
            toolName: input.toolName,
            serverId: input.serverId,
            pendingCallId: parked.id,
          }),
        } as const;
      } catch (err) {
        // Typed refusals pass through (the invoker + M1 path render them);
        // anything else is subsystem infrastructure → REFUSE fail-closed.
        if (err instanceof InvokerError) throw err;
        throw new InvokerError(
          "confirmation_unavailable",
          `the destructive tool "${input.toolName}" was NOT executed: the confirmation ` +
            `subsystem is unavailable (fail-closed). Do not retry immediately; tell the user ` +
            `the action needs their confirmation and could not be parked right now.`,
        );
      }
    },
  };
}
