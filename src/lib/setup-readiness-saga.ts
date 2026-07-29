import "server-only";

/**
 * THE SETUP READINESS SAGA (cinatra#2093, epic #2086 S6).
 *
 * "Wizard completeness = receipt validity, not a cached boolean."
 *
 * THE PROBLEM THIS EXISTS TO FIX. Before S6 the wizard's AI step was "ready"
 * when a cached connection check said the key looked fine. On the Anthropic
 * path that is close to meaningless: the connector's `mcpMode` DEFAULTS to
 * `"function-tools"`, which reports ready on key presence, passes every
 * declaration check (`native_mcp.status` is `"native"` — a claim about the
 * connector, not about this instance's stored connection), and then rejects
 * EVERY `container.skills` request at run time. Setup would complete
 * "successfully" and skills would silently never reach the model. The only way
 * to tell the two apart is to ASK THE REAL API with a REAL uploaded skill id —
 * so readiness becomes a probe RESULT that is recorded, and that expires when
 * anything readiness-relevant changes underneath it.
 *
 * THE FIVE STEPS (the issue's saga, in order):
 *   1. credential-validation — key saved + a plain request validating it.
 *      BOTH paths.
 *   2. bulk-consent          — ANTHROPIC ONLY. The explicit act that makes the
 *                              already-installed injectable packages eligible
 *                              (S5's consent ledger; without it the derived
 *                              `allowAnthropicUpload` projection stays false for
 *                              everything installed before the opt-in and
 *                              nothing would ever upload).
 *   3. initial-sync + probe  — ANTHROPIC ONLY. A STRICT whole-catalog sync (S5's
 *                              `syncCatalogSkillsToAnthropicStrict`, which
 *                              THROWS rather than letting an all-skipped run
 *                              masquerade as success), then `probeNativeSkills`
 *                              against an ACTUALLY-UPLOADED revision. When the
 *                              expected set is legitimately empty, a DISPOSABLE
 *                              probe skill is created → probed → deleted.
 *   4. commit                — write `llm_default_provider` through the audited
 *                              chokepoint + persist the readiness receipt.
 *   5. compensation          — on failure: opt-in rollback, or setup-incomplete
 *                              with actionable errors. Never a half-committed
 *                              state that reads as ready.
 *
 * THE OPENAI PATH does steps 1 and 4 only: key validation + surface readiness,
 * NO upload, NO probe, and — the property that matters — NO ANTHROPIC EGRESS.
 * Tool-mount delivery is proven in the subsequent assistant run (S7's E2E), not
 * inside this saga.
 *
 * PORTS, NOT STUBS. Every side effect goes through {@link SetupReadinessPorts}.
 * That exists so the saga's ORDERING, SKIPPING, FAILURE and COMPENSATION logic
 * is testable without a live Anthropic key — NOT so the internal contract
 * surfaces can be faked. The real port implementation
 * ({@link createSetupReadinessPorts}) binds the genuine S5 machinery; tests
 * that prove the walk drive the real ports against a real Postgres and stub
 * only at the HTTP boundary.
 */

import { createHash } from "node:crypto";

import type { LlmProvider } from "@cinatra-ai/agents/llm-provider-policy";
import type { LlmNativeSkillsProbeResult } from "@cinatra-ai/sdk-extensions";

import {
  readConnectorConfigFromDatabase,
  writeConnectorConfigToDatabase,
  readDefaultLlmProviderFromDatabase,
  writeDefaultLlmProviderToDatabase,
  isGlobalDefaultLlmProviderEligible,
  readSkillCatalogFromDatabase,
} from "@/lib/database";
import { describeMatcherProviderConstraint } from "@/lib/llm-purpose-policy";
// ONE derivation for the credential fingerprint, shared with the sync service:
// two different derivations would let a key rotation invalidate the sync
// namespace and NOT the readiness receipt (or vice versa), which is exactly the
// drift this fingerprint exists to prevent.
import { deriveApiKeyFingerprint } from "@/lib/anthropic-skill-sync-service";

// ===========================================================================
// Receipt
// ===========================================================================

export const SETUP_READINESS_RECEIPT_CONFIG_KEY = "setup_readiness_receipt";

/** The saga's steps, in execution order. */
export const SETUP_READINESS_STEPS = [
  "credential-validation",
  "bulk-consent",
  "initial-sync",
  "native-skills-probe",
  "commit",
] as const;
export type SetupReadinessStepId = (typeof SETUP_READINESS_STEPS)[number];

/**
 * A `container.skills` reference is {skill_id, version} — BOTH halves. Carrying
 * only an id would let the probe resolve some OTHER revision than the one the
 * sync just uploaded, so it would not prove what it claims to prove (codex
 * round-1 finding #6).
 */
export type ProbeSkillTarget = { skillId: string; version: string };

export type DisposableProbeSkillRef = ProbeSkillTarget & {
  dispose: () => Promise<void>;
};

export type SetupReadinessProbeRecord = {
  accepted: boolean;
  mode?: "container-skills" | "function-tools" | "unknown";
  /** The skill the probe referenced. */
  skillId: string;
  /** The exact revision the probe referenced. */
  version: string;
  /** True when the probe used a throwaway skill because the synced set was empty. */
  disposable: boolean;
};

/**
 * The RECEIPT — the durable evidence that setup actually reached a working
 * state, and the thing the wizard's completeness read consults instead of a
 * cached boolean.
 *
 * `fingerprint` is the whole point: it pins the readiness-relevant
 * configuration the receipt was earned under. A credential rotation, an MCP-mode
 * change, or a catalog change produces a different fingerprint, so the receipt
 * stops matching and the wizard honestly reads as not-ready again rather than
 * coasting on evidence that no longer applies.
 */
export type SetupReadinessReceipt = {
  receiptVersion: 1;
  provider: LlmProvider;
  /** ISO timestamp the receipt was earned. */
  completedAt: string;
  fingerprint: string;
  /** Present on the Anthropic path only. */
  probe?: SetupReadinessProbeRecord;
  /** Present on the Anthropic path only: skills uploaded by the initial sync. */
  syncedSkillCount?: number;
};

export type SetupReadinessFailure = {
  step: SetupReadinessStepId;
  /** Operator-facing, actionable. Never contains a credential. */
  message: string;
  /**
   * The FIX-FORWARD prompt when the failure has a known remedy — most
   * importantly the `function-tools` MCP mode, which the AC calls out by name.
   */
  fixForward?: string;
  /** What the saga did about the partial state. */
  compensation: "rolled-back" | "setup-incomplete";
};

export type SetupReadinessResult =
  | {
      ok: true;
      receipt: SetupReadinessReceipt;
      /** Non-null when skill auto-matching cannot run on the chosen provider. */
      matcherConstraint: string | null;
    }
  | { ok: false; failure: SetupReadinessFailure };

// ===========================================================================
// Readiness fingerprint
// ===========================================================================

/**
 * The readiness-relevant configuration fingerprint. Three inputs, each of which
 * the issue names as a receipt invalidator:
 *
 *   credential  — a rotated key may belong to a different workspace whose
 *                 skills were never uploaded, and whose MCP entitlement may
 *                 differ. Fingerprinted (HMAC/SHA of the key), NEVER the key.
 *   mcpMode     — the exact setting that decides whether `container.skills` is
 *                 accepted. A flip from `native` back to `function-tools` must
 *                 invalidate a probe that passed under `native`.
 *   catalog     — the skill set the strict initial sync uploaded. New/removed
 *                 skills mean the synced set the receipt attests to is no
 *                 longer the set that exists.
 *
 * Deliberately NOT time-based: a receipt does not expire because it is old, it
 * expires because the world it described changed.
 */
/**
 * Marker embedded in the fingerprint when a readiness input could not be read.
 *
 * A fingerprint containing this is NEVER valid evidence (codex round-1 finding
 * #9): a stable "unreadable" sentinel would otherwise be recordable into a
 * receipt and then MATCH on a later read, certifying a configuration nobody
 * could actually inspect.
 */
export const READINESS_INPUT_UNREADABLE = "unreadable";

/** Does this fingerprint stand on an input we could not read? */
export function fingerprintHasUnreadableInput(raw: string): boolean {
  return raw.includes(READINESS_INPUT_UNREADABLE);
}

export function computeReadinessFingerprint(provider: LlmProvider): string {
  // The credential component is kept OUT of the hashed section and carried
  // verbatim. Two reasons, and the second is the load-bearing one:
  //
  //  - it is ALREADY a non-reversible digest (`deriveApiKeyFingerprint` returns
  //    an HMAC/SHA-256 of the key, never the key), and S5 already persists that
  //    exact value verbatim as `anthropic_skill_sync.api_key_fingerprint` — so
  //    concatenating it here stores nothing new and nothing sensitive;
  //  - re-hashing it would create a literal `createHash(...).update(<value
  //    derived from a credential>)` dataflow. That is indistinguishable, to a
  //    static analyser AND to a reader, from hashing a secret with a fast
  //    unsalted digest, which is exactly the anti-pattern nobody should have to
  //    re-adjudicate every time this file is touched (CodeQL
  //    js/insufficient-password-hash flagged it, correctly, on the shape).
  //
  // Only the NON-credential inputs are hashed, purely to keep the value short.
  const nonCredentialParts: string[] = [`provider=${provider}`];
  let credentialComponent = "n/a";

  if (provider === "anthropic") {
    credentialComponent = readAnthropicCredentialFingerprint() ?? "none";
    nonCredentialParts.push(`mcpMode=${readAnthropicMcpMode()}`);
    nonCredentialParts.push(`catalog=${computeSkillCatalogSignature()}`);
    // The workspace upload opt-in is a readiness input too (codex round-1
    // finding #8): with it OFF nothing uploads, so a receipt earned while it
    // was ON must not survive it being turned OFF.
    nonCredentialParts.push(`uploadOptIn=${readAnthropicUploadOptIn()}`);
  } else {
    // Non-Anthropic paths perform no upload and no probe, so their readiness
    // depends only on the provider choice itself. Recorded explicitly so the
    // fingerprint is never accidentally constant across providers.
    nonCredentialParts.push("mcpMode=n/a", "catalog=n/a");
  }

  const preimage = nonCredentialParts.join("|");
  const digest = createHash("sha256").update(preimage).digest("hex").slice(0, 16);
  // Truncated to 16 hex chars: enough to distinguish two different credentials,
  // and it is a digest of a digest either way.
  const credentialTag = credentialComponent.slice(0, 16);
  const fingerprint = `${credentialTag}.${digest}`;
  // PREFIX when any input was unreadable, so the condition survives and can be
  // refused at both write and read time.
  return `${preimage}|${credentialComponent}`.includes(READINESS_INPUT_UNREADABLE)
    ? `${READINESS_INPUT_UNREADABLE}:${fingerprint}`
    : fingerprint;
}

/**
 * Non-reversible fingerprint of the stored Anthropic key.
 *
 * Fail-safe rather than fail-open: a throwing derivation (no key, unreadable
 * config) yields `null`, which is a DISTINCT fingerprint input from any real
 * key — so a receipt earned with a key never keeps matching once the key
 * becomes unreadable.
 */
function readAnthropicCredentialFingerprint(): string | null {
  try {
    return deriveApiKeyFingerprint();
  } catch {
    return null;
  }
}

/**
 * The connector's stored MCP mode. Read from the connector-config store rather
 * than through the connector module so a receipt can be validated on a host
 * where the connector is not currently active — the stored setting is the
 * authority either way. Mirrors the connector's own default
 * (`mcpMode ?? "function-tools"`) so an unset value is treated as the
 * fail-closed mode it actually behaves as, never as "probably fine".
 */
export function readAnthropicMcpMode(): "native" | "function-tools" {
  const settings = readConnectorConfigFromDatabase<{ mcpMode?: string }>("anthropic", {});
  return settings?.mcpMode === "native" ? "native" : "function-tools";
}

/**
 * Set the connector's stored MCP mode — the WRITE half of the reader directly
 * above, deliberately co-located with it so both sides of this one setting keep
 * a single authority and a single default.
 *
 * WHY THE HOST WRITES THIS ROW AT ALL. The saga's `native-skills-probe` failure
 * has exactly one remedy — flip this setting to `"native"` — and until now
 * nothing anywhere could perform it: the connector's `cinatra.configSchema`
 * declares no `mcpMode` field (so its settings surface cannot render one), and
 * the host's legacy `setAnthropicMcpModeAction` is a documented stub that
 * writes nothing. So the failure's fix-forward named a control that does not
 * exist, which is worse than the reported symptom (that admin routes redirect
 * back into the wizard during setup): exempting a settings route from that
 * redirect would land the operator on a page that still cannot perform the
 * switch. The honest minimum is to make the wizard itself able to do it.
 *
 * SCOPE OF THE BOUNDARY CROSSING, stated rather than glossed. `saveAPISettings`
 * (the CREDENTIAL) still goes through the connector's own gated writer and this
 * function must never grow to cover credentials or any other field: it is a
 * read-modify-write of ONE non-secret key on the same row the reader above
 * already treats as authoritative, mirroring the connector's own `saveMcpMode`
 * exactly.
 *
 * WHAT "PRESERVES THE OTHER SETTINGS" DOES AND DOES NOT MEAN (codex round-4
 * finding 4). It writes back every field it READ, so a sequential save of an
 * unrelated setting is not clobbered. It is NOT atomic: a connector settings
 * save landing between this read and this write would be lost. That is not a
 * regression the host introduces — the connector's own `saveMcpMode` and
 * `saveAnthropicPromptCachingEnabled` are the same unconditional
 * read-modify-write over the same row, so routing this through the connector
 * (or through an `llm-provider-surface` writer) would inherit the identical
 * window. Closing it needs a CAS/atomic connector-config write, which does not
 * exist yet. The exposure here is deliberately tiny: one admin, one click,
 * during setup, on an instance whose connector settings surface is not even
 * reachable yet. The durable fix — an `mcpMode` writer on the
 * `llm-provider-surface` ABI (or the field on the connector's configSchema),
 * over an atomic write — is connector-side, beyond this PR's repo, and is
 * recorded as follow-up on cinatra#2093.
 */
export function writeAnthropicMcpMode(mode: "native" | "function-tools"): void {
  const settings = readConnectorConfigFromDatabase<Record<string, unknown> | null>(
    "anthropic",
    {},
  );
  const preserved = settings && typeof settings === "object" ? settings : {};
  writeConnectorConfigToDatabase("anthropic", { ...preserved, mcpMode: mode });
}

/**
 * The workspace-wide Anthropic upload opt-in. Read defensively: an unreadable
 * value is its OWN state and never matches a recorded readable one.
 */
function readAnthropicUploadOptIn(): string {
  try {
    const config = readConnectorConfigFromDatabase<{ enabled?: boolean } | boolean | null>(
      "anthropic_skill_sync_enabled",
      null,
    );
    if (typeof config === "boolean") return String(config);
    if (config && typeof config === "object") return String(config.enabled === true);
    return "false";
  } catch {
    return READINESS_INPUT_UNREADABLE;
  }
}

/** Order-independent signature of the injectable skill catalog. */
function computeSkillCatalogSignature(): string {
  try {
    const catalog = readSkillCatalogFromDatabase();
    const ids = (catalog?.skills ?? [])
      .map((s: { id?: string }) => String(s?.id ?? ""))
      .filter(Boolean)
      .sort();
    return createHash("sha256").update(ids.join(",")).digest("hex").slice(0, 16);
  } catch {
    // Fail CLOSED: an unreadable catalog must not produce a stable signature
    // that keeps a stale receipt alive. A random-ish constant would be
    // dishonest; "unreadable" is its own state and never matches a recorded
    // signature computed from a readable catalog.
    return READINESS_INPUT_UNREADABLE;
  }
}

// ===========================================================================
// Receipt persistence + validity
// ===========================================================================

export function readSetupReadinessReceipt(): SetupReadinessReceipt | null {
  const raw = readConnectorConfigFromDatabase<SetupReadinessReceipt | null>(
    SETUP_READINESS_RECEIPT_CONFIG_KEY,
    null,
  );
  if (!raw || typeof raw !== "object") return null;
  if (raw.receiptVersion !== 1) return null; // unknown version ⇒ not valid evidence
  if (typeof raw.provider !== "string" || typeof raw.fingerprint !== "string") return null;
  return raw;
}

export function writeSetupReadinessReceipt(receipt: SetupReadinessReceipt): void {
  writeConnectorConfigToDatabase(SETUP_READINESS_RECEIPT_CONFIG_KEY, receipt);
}

export function clearSetupReadinessReceipt(): void {
  writeConnectorConfigToDatabase(SETUP_READINESS_RECEIPT_CONFIG_KEY, null);
}

/**
 * Is there VALID readiness evidence right now? This is what the wizard's AI
 * step consults.
 *
 * Fail-closed on every axis: no receipt, a receipt for a different provider
 * than the one currently stored, or a receipt whose fingerprint no longer
 * matches the live configuration all read as NOT ready.
 */
export function readSetupReadinessState(): {
  ready: boolean;
  receipt: SetupReadinessReceipt | null;
  reason?: "no-receipt" | "provider-changed" | "configuration-changed";
} {
  const receipt = readSetupReadinessReceipt();
  if (!receipt) return { ready: false, receipt: null, reason: "no-receipt" };

  const storedProvider = readDefaultLlmProviderFromDatabase();
  if (receipt.provider !== storedProvider) {
    return { ready: false, receipt, reason: "provider-changed" };
  }

  const current = computeReadinessFingerprint(receipt.provider);
  // Fail closed on an unreadable input on EITHER side — a receipt earned
  // against an unreadable configuration is not evidence, and neither is a
  // comparison against one.
  if (fingerprintHasUnreadableInput(current) || fingerprintHasUnreadableInput(receipt.fingerprint)) {
    return { ready: false, receipt, reason: "configuration-changed" };
  }
  if (current !== receipt.fingerprint) {
    return { ready: false, receipt, reason: "configuration-changed" };
  }

  return { ready: true, receipt };
}

// ===========================================================================
// Ports
// ===========================================================================

export type SetupReadinessPorts = {
  /** Step 1 — key saved + a plain request that validates it. */
  validateCredential(provider: LlmProvider): Promise<{ ok: boolean; message?: string }>;
  /** Step 1 — the provider's own surface-level readiness (no egress). */
  isSurfaceReady(provider: LlmProvider): Promise<boolean>;
  /** Step 2 — ANTHROPIC ONLY. S5's bulk consent grant. */
  grantBulkConsent(grantedBy: string | null): void;
  /**
   * Step 3 — ANTHROPIC ONLY. S5's STRICT whole-catalog sync.
   *
   * MUST THROW on any failure OR inert no-op. An implementation that returns a
   * clean empty result when the workspace opt-in is off, or when a lookup
   * failed, is indistinguishable from "there was genuinely nothing to upload" —
   * and would route the saga to the disposable-probe fallback and let setup
   * complete having reconciled nothing (codex round-1 findings #4 and #5).
   */
  runStrictInitialSync(): Promise<{ uploadedSkillIds: ProbeSkillTarget[] }>;
  /** Step 3 — ANTHROPIC ONLY. The ABI v2 surface probe. */
  probeNativeSkills(input: ProbeSkillTarget): Promise<LlmNativeSkillsProbeResult>;
  /**
   * Step 3 fallback — ANTHROPIC ONLY. Create a throwaway skill to probe with
   * when the synced set is legitimately empty. The returned `dispose` deletes
   * it; the saga ALWAYS calls it, including on the failure path.
   */
  createDisposableProbeSkill(): Promise<DisposableProbeSkillRef>;
  /**
   * Step 4 — the audited platform-admin write.
   *
   * ASYNC BY CONTRACT (codex round-1 finding #1). The production implementation
   * is the audited mutation, which awaits a strict audit insert BEFORE writing.
   * An earlier sync signature forced the caller to smuggle that promise out
   * through a side channel, which made the saga's post-commit verification read
   * the PRE-commit value and could leave a committed provider with no receipt.
   */
  commitDefaultProvider(provider: LlmProvider): Promise<void>;
  /** Step 5 — restore the prior stored default on rollback. Async for the same
   * reason as {@link SetupReadinessPorts.commitDefaultProvider}. */
  restoreDefaultProvider(provider: string): Promise<void>;
  readStoredDefaultProvider(): string;
  computeFingerprint(provider: LlmProvider): string;
  writeReceipt(receipt: SetupReadinessReceipt): void;
  clearReceipt(): void;
  now(): Date;
};

export type RunSetupReadinessSagaInput = {
  provider: LlmProvider;
  /** Actor id recorded on the bulk-consent grant. */
  actorUserId: string | null;
  /**
   * What to do with the partially-applied state on failure.
   *  - "rollback"        : restore the previously stored default provider.
   *  - "leave-incomplete": leave the choice unapplied and report actionable
   *                        errors (the wizard keeps prompting).
   * Consent is NEVER rolled back: it is a durable record of a real act the
   * operator performed, and the workspace opt-in is the outer gate that stops
   * egress anyway. Revoking it silently would make a retry mysteriously
   * upload nothing.
   */
  onFailure?: "rollback" | "leave-incomplete";
  ports: SetupReadinessPorts;
};

// ===========================================================================
// The saga
// ===========================================================================

export async function runSetupReadinessSaga(
  input: RunSetupReadinessSagaInput,
): Promise<SetupReadinessResult> {
  const { provider, ports } = input;
  const onFailure = input.onFailure ?? "leave-incomplete";
  const priorProvider = ports.readStoredDefaultProvider();

  const fail = async (
    step: SetupReadinessStepId,
    message: string,
    fixForward?: string,
    /**
     * Force a restore even under "leave-incomplete" — used when the provider
     * WAS already committed and the failure came after it (codex round-1
     * finding #2: a receipt-write failure must not leave a committed provider
     * with no evidence behind it).
     */
    forceRestore = false,
  ): Promise<SetupReadinessResult> => {
    // Whatever else happens, there must be no receipt left behind: a stale
    // receipt is the exact failure mode this saga exists to prevent. A failing
    // clear must NOT mask the original failure, so it is reported, not thrown.
    try {
      ports.clearReceipt();
    } catch (err) {
      console.error("[setup-readiness] could not clear the readiness receipt:", errText(err));
    }
    const shouldRestore =
      (onFailure === "rollback" || forceRestore) && priorProvider !== provider;
    if (shouldRestore) {
      try {
        await ports.restoreDefaultProvider(priorProvider);
      } catch (err) {
        console.error(
          "[setup-readiness] could not restore the previous default provider:",
          errText(err),
        );
      }
    }
    return {
      ok: false,
      failure: {
        step,
        message: sanitizeReadinessMessage(message),
        ...(fixForward ? { fixForward } : {}),
        compensation: shouldRestore ? "rolled-back" : "setup-incomplete",
      },
    };
  };

  // TOCTOU CAPTURE (codex round-1 finding #9). Sample the readiness-relevant
  // configuration BEFORE proving anything, and re-compare at commit. Sampling
  // only at the end would stamp a proof about configuration A onto
  // configuration B if anything changed mid-run.
  const fingerprintAtStart = ports.computeFingerprint(provider);

  // Guard BEFORE any side effect: a provider that cannot be the stored default
  // must never reach the consent/upload steps. The commit would refuse it at
  // the chokepoint anyway, but by then Anthropic egress would already have
  // happened for a choice that could never be committed.
  if (!isGlobalDefaultLlmProviderEligible(provider)) {
    return await fail(
      "credential-validation",
      `"${provider}" cannot be set as the default LLM provider on this instance.`,
    );
  }

  // ---- Step 1: credential validation + surface readiness (BOTH paths) -----
  let validation: { ok: boolean; message?: string };
  try {
    validation = await ports.validateCredential(provider);
  } catch (err) {
    return await fail("credential-validation", `Could not validate the ${provider} credentials: ${errText(err)}`);
  }
  if (!validation.ok) {
    return await fail(
      "credential-validation",
      validation.message ?? `The ${provider} credentials were rejected by the provider.`,
    );
  }

  let surfaceReady: boolean;
  try {
    surfaceReady = await ports.isSurfaceReady(provider);
  } catch (err) {
    return await fail("credential-validation", `Could not read the ${provider} connection state: ${errText(err)}`);
  }
  if (!surfaceReady) {
    return await fail(
      "credential-validation",
      `The ${provider} connector reports its connection is not ready. Save the connection settings and try again.`,
    );
  }

  // The OpenAI path stops here and commits. NO upload, NO probe, and — the
  // property that has to hold — no Anthropic egress whatsoever.
  let probeRecord: SetupReadinessProbeRecord | undefined;
  let syncedSkillCount: number | undefined;

  if (provider === "anthropic") {
    // ---- Step 2: bulk consent (ANTHROPIC ONLY) ---------------------------
    try {
      ports.grantBulkConsent(input.actorUserId);
    } catch (err) {
      return await fail(
        "bulk-consent",
        `Could not record upload consent for the installed skill packages: ${errText(err)}`,
      );
    }

    // ---- Step 3a: STRICT initial sync (ANTHROPIC ONLY) -------------------
    let uploadedSkillIds: ProbeSkillTarget[];
    try {
      ({ uploadedSkillIds } = await ports.runStrictInitialSync());
    } catch (err) {
      return await fail(
        "initial-sync",
        `The initial skill upload to Anthropic did not complete: ${errText(err)}`,
        "Check the skill catalog for oversized or malformed skill bundles, then run setup again. No partial state is left behind — the reconcile worker re-drives any skill that did upload.",
      );
    }
    syncedSkillCount = uploadedSkillIds.length;

    // ---- Step 3b: probeNativeSkills (ANTHROPIC ONLY) ---------------------
    // The probe MUST reference an ACTUALLY-UPLOADED revision — probing with a
    // fabricated id would exercise the API's 404 path, not the
    // `container.skills` acceptance path, and would "pass" in exactly the
    // broken configuration this step exists to catch.
    let disposable: DisposableProbeSkillRef | null = null;
    try {
      // A `container.skills` reference is {skill_id, version} — BOTH halves
      // (codex round-1 finding #6). Passing only an id would let the probe
      // resolve some other revision, so it would not prove the revision the
      // sync just uploaded.
      let probeTarget = uploadedSkillIds[0];
      if (!probeTarget) {
        // Legitimately empty expected set (a fresh install with no injectable
        // skills yet). Create a throwaway, probe it, delete it.
        disposable = await ports.createDisposableProbeSkill();
        probeTarget = { skillId: disposable.skillId, version: disposable.version };
      }

      const result = await ports.probeNativeSkills(probeTarget);
      probeRecord = {
        accepted: result.accepted === true,
        ...(result.mode ? { mode: result.mode } : {}),
        skillId: probeTarget.skillId,
        version: probeTarget.version,
        disposable: disposable !== null,
      };

      if (!probeRecord.accepted) {
        return await fail(
          "native-skills-probe",
          result.reason ??
            "Anthropic rejected a container.skills request, so uploaded skills would not reach the model.",
          // The fix-forward must name something the operator can DO from where
          // they are standing. It used to say "in its settings" — accurate
          // about the setting, unfollowable in practice: admin routes redirect
          // back into the wizard while setup is incomplete, and no settings
          // surface renders this field in the first place. It now names the
          // in-step control (see writeAnthropicMcpMode above). It is also
          // purely the REMEDY: the diagnosis is the `message` right above it,
          // and the two render adjacently.
          result.mode === "function-tools"
            ? "Use “Switch to native MCP delivery” below to set the Anthropic connector's MCP mode to 'native', then run this step again."
            : "Confirm the Anthropic workspace has custom skills enabled for this API key, then run this step again.",
        );
      }
    } catch (err) {
      // A THROWN probe is inconclusive, and inconclusive is treated as failed
      // (fail-closed) — committing on "we could not tell" is precisely the
      // cached-boolean behaviour S6 replaces.
      return await fail(
        "native-skills-probe",
        `Could not verify that Anthropic accepts custom skills on this connection: ${errText(err)}`,
      );
    } finally {
      // ALWAYS reclaim the throwaway, including on the failure path — a probe
      // skill left behind is remote litter under the operator's API key.
      //
      // HONEST FAILURE NOTE (codex round-1 finding #3): a disposable probe skill
      // has NO row in the anthropic_skill_sync map, so the stale-row GC sweep
      // CANNOT discover it. An earlier version of this comment claimed it
      // could — that was wrong, and quietly wrong in the direction of leaving
      // remote litter under the operator's key with nobody looking for it.
      // The reclaim is therefore best-effort AND loud: the probe's stable
      // display title (deriveAnthropicDisplayTitle over a fixed catalog id)
      // makes the create idempotent, so a later setup run reconciles onto the
      // SAME remote skill and re-attempts the delete. Durable journaling +
      // GC enrolment for probe skills is recorded as follow-up on the issue.
      if (disposable) {
        try {
          await disposable.dispose();
        } catch (err) {
          console.error(
            `[setup-readiness] the disposable probe skill ${disposable.skillId} could NOT be deleted and is NOT tracked by the stale-row GC. ` +
              "Delete it manually in the Anthropic console, or re-run setup (the create is idempotent by display title and retries the delete). Cause:",
            errText(err),
          );
        }
      }
    }
  }

  // ---- Step 4: commit ----------------------------------------------------
  //
  // RE-VERIFY THE READINESS INPUTS FIRST (codex round-1 finding #9). The
  // fingerprint was captured BEFORE the proof steps ran; if the credential,
  // the MCP mode, or the catalog changed WHILE we were proving them, the proof
  // is about a configuration that no longer exists and must not be stamped as
  // verified. Refuse rather than record a receipt for work we did not do.
  const fingerprintAtCommit = ports.computeFingerprint(provider);
  if (fingerprintAtCommit !== fingerprintAtStart) {
    return await fail(
      "commit",
      "The provider configuration changed while setup was verifying it, so the result no longer describes this instance. Run the step again.",
    );
  }

  try {
    await ports.commitDefaultProvider(provider);
  } catch (err) {
    return await fail("commit", `Could not save the default LLM provider: ${errText(err)}`);
  }

  // The commit chokepoint refuses a non-default-capable provider by PRESERVING
  // the prior value rather than throwing, so verify the write actually landed
  // instead of trusting that no exception means success.
  const committed = ports.readStoredDefaultProvider();
  if (committed !== provider) {
    return await fail(
      "commit",
      `The default LLM provider was not saved as "${provider}" (it is still "${committed}").`,
    );
  }

  const receipt: SetupReadinessReceipt = {
    receiptVersion: 1,
    provider,
    completedAt: ports.now().toISOString(),
    fingerprint: fingerprintAtCommit,
    ...(probeRecord ? { probe: probeRecord } : {}),
    ...(syncedSkillCount !== undefined ? { syncedSkillCount } : {}),
  };
  try {
    ports.writeReceipt(receipt);
  } catch (err) {
    // The provider IS committed at this point. Leaving it committed with no
    // receipt would read as "a provider was chosen but never verified" forever
    // (codex round-1 finding #2), so force the restore regardless of the
    // caller's compensation preference — the two writes are not in one
    // transaction, and this is the closest honest equivalent.
    return await fail(
      "commit",
      `Could not record the setup readiness receipt: ${errText(err)}`,
      undefined,
      true,
    );
  }

  return {
    ok: true,
    receipt,
    matcherConstraint: describeMatcherProviderConstraint(provider),
  };
}

/**
 * The SINGLE sanitizer every operator-facing / durable string in this saga
 * passes through (codex round-1 finding #10).
 *
 * Provider and connector error text reaches three durable places — the setup
 * UI, the persisted failure record, and the server log. A type-level "must not
 * contain a credential" comment is documentation, not enforcement, and the
 * strings originate from a REMOTE party that may echo the request back. So:
 * strip anything key-shaped, collapse whitespace, and bound the length.
 */
export function sanitizeReadinessMessage(text: string): string {
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-[redacted]")
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, "sk-[redacted]")
    .replace(/\b(?:AIza|ya29\.)[A-Za-z0-9_.-]+/g, "[redacted-key]")
    .replace(/(authorization|x-api-key|api[_-]?key|bearer)\s*[:=]\s*\S+/gi, "$1: [redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

function errText(err: unknown): string {
  return sanitizeReadinessMessage(err instanceof Error ? err.message : String(err));
}
