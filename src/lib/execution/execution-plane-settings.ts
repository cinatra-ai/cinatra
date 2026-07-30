import "server-only";

// Execution-plane instance settings (exec-plane S1b activation, cinatra#2138
// deliverable 5; epic #1705).
//
// The persisted MODE VOCABULARY is the full `remote | local-dev | disabled`
// set — S4 (cinatra-cli) consumes the same vocabulary — and since exec-plane L4
// ALL THREE are operable. `remote` was previously rendered-but-unselectable for
// one honest reason: the remote placement's service boundary (HTTP/mTLS to an
// out-of-process broker) did not exist, so offering the choice would have been
// a lie in the admin surface. That boundary is now merged — the versioned wire
// protocol, the mutual-TLS identities, the thin broker/worker services and the
// clients (`@cinatra-ai/execution-plane`'s `service/*`) — and the boot phase
// constructs a real client against it, so the choice is now true.
//
// WHAT "OPERABLE" DOES AND DOES NOT MEAN. It means the mode can be PERSISTED
// and the boot phase knows how to honor it. It does NOT promise the placement
// will come up: a `remote` instance whose broker is unreachable, unconfigured
// or unhealthy registers NOTHING and reports `unavailable` with the verbatim
// reason, exactly as a `local-dev` instance without docker does. Selecting a
// mode is a statement of intent; the boot handshake is what makes it real.
//
// UNCHANGED BY DESIGN: `DEFAULT_EXECUTION_PLANE_MODE` is still `disabled`, and
// every write still passes the default-off `CINATRA_EXECUTION_PLANE_ROLLOUT`
// gate. Making a mode operable is not the same decision as turning the plane on
// for users, and this slice does not make the second one.
//
// Storage: the EXISTING platform key-value metadata store
// (`connector_config:execution_plane`, the same schema-config seam
// `audit_retention` uses). NO migration — the issue's stores already exist.

import { isExecutionPlaneRolloutEnabled } from "@cinatra-ai/llm/execution-plane";

import {
  readConnectorConfigFromDatabase,
  writeConnectorConfigToDatabase,
} from "@/lib/database";

/** The persisted placement vocabulary (S4 shares it). */
export type ExecutionPlaneMode = "remote" | "local-dev" | "disabled";

/** Full vocabulary, in render order. */
export const EXECUTION_PLANE_MODES: readonly ExecutionPlaneMode[] = [
  "remote",
  "local-dev",
  "disabled",
] as const;

/**
 * The subset the boot phase can actually honor. Since exec-plane L4 that is the
 * WHOLE vocabulary — the constant is kept (rather than deleted as a tautology)
 * because it is the seam a future mode is added through, and because the write
 * path's fail-closed refusal reads from it rather than from a hard-coded list.
 */
export const OPERABLE_EXECUTION_PLANE_MODES: readonly ExecutionPlaneMode[] = [
  "remote",
  "local-dev",
  "disabled",
] as const;

export const DEFAULT_EXECUTION_PLANE_MODE: ExecutionPlaneMode = "disabled";

/** Egress tier vocabulary — mirrors the merged gateway's `EgressMode`. */
export type ExecutionEgressMode = "default_internet" | "allowlist" | "none";

export const EXECUTION_EGRESS_MODES: readonly ExecutionEgressMode[] = [
  "default_internet",
  "allowlist",
  "none",
] as const;

export type ExecutionPlaneSettings = {
  mode: ExecutionPlaneMode;
  /**
   * The effective egress tier every sandbox job resolves to. `default_internet`
   * and `allowlist` BOTH transit the attributing gateway (epic D3 — the gateway
   * is the only dual-homed path out); `none` is a kernel-level `--network none`.
   */
  egressMode: ExecutionEgressMode;
  /** Host allowlist (exact or dot-suffix), meaningful only for `allowlist`. */
  egressAllowlist: string[];
};

export const DEFAULT_EXECUTION_PLANE_SETTINGS: ExecutionPlaneSettings = {
  mode: DEFAULT_EXECUTION_PLANE_MODE,
  egressMode: "default_internet",
  egressAllowlist: [],
};

/** Metadata key in the platform key-value store. */
export const EXECUTION_PLANE_SETTINGS_KEY = "execution_plane";

function coerceMode(raw: unknown): ExecutionPlaneMode {
  return EXECUTION_PLANE_MODES.includes(raw as ExecutionPlaneMode)
    ? (raw as ExecutionPlaneMode)
    : DEFAULT_EXECUTION_PLANE_MODE;
}

function coerceEgressMode(raw: unknown): ExecutionEgressMode {
  return EXECUTION_EGRESS_MODES.includes(raw as ExecutionEgressMode)
    ? (raw as ExecutionEgressMode)
    : DEFAULT_EXECUTION_PLANE_SETTINGS.egressMode;
}

/** Normalize a raw allowlist into trimmed, de-duplicated, lowercased hosts. */
export function normalizeEgressAllowlist(raw: unknown): string[] {
  const source = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(/[\s,]+/)
      : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of source) {
    if (typeof entry !== "string") continue;
    const host = entry.trim().toLowerCase().replace(/\.$/, "");
    if (host.length === 0 || seen.has(host)) continue;
    seen.add(host);
    out.push(host);
  }
  return out;
}

/**
 * Read the instance's execution-plane settings. Never throws: an unavailable
 * metadata store (unit env, pre-migration boot) resolves the DISABLED default,
 * which is the fail-closed posture.
 */
export function readExecutionPlaneSettings(): ExecutionPlaneSettings {
  try {
    const raw = readConnectorConfigFromDatabase<Partial<ExecutionPlaneSettings> | null>(
      EXECUTION_PLANE_SETTINGS_KEY,
      null,
    );
    if (!raw || typeof raw !== "object") return { ...DEFAULT_EXECUTION_PLANE_SETTINGS };
    return {
      mode: coerceMode(raw.mode),
      egressMode: coerceEgressMode(raw.egressMode),
      egressAllowlist: normalizeEgressAllowlist(raw.egressAllowlist),
    };
  } catch {
    return { ...DEFAULT_EXECUTION_PLANE_SETTINGS };
  }
}

/**
 * Whether the instance has the epic's default-off ROLLOUT flag on. The admin
 * surface reads this to render honestly (an instance with the flag off can look
 * at the settings but cannot change them — nothing would honor the change), and
 * the write path uses it as a hard gate so a hand-crafted POST cannot mutate the
 * stored posture of an inert instance (Codex convergence finding 6).
 */
export function isExecutionPlaneRolloutOn(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isExecutionPlaneRolloutEnabled(env.CINATRA_EXECUTION_PLANE_ROLLOUT);
}

/** Raised when the instance's ROLLOUT flag is off — nothing may be persisted. */
export class ExecutionPlaneRolloutDisabledError extends Error {
  constructor() {
    super(
      "The execution plane is not enabled on this instance, so its settings " +
        "cannot be changed. Enabling it for users is a separate, explicit " +
        "decision made outside this screen.",
    );
    this.name = "ExecutionPlaneRolloutDisabledError";
  }
}

/**
 * Raised when an admin attempts to persist a mode the boot phase cannot honor.
 *
 * Since exec-plane L4 every mode in the vocabulary is operable, so nothing
 * reaches this today — and the guard STAYS, unreachable-but-armed, because it
 * is the fail-closed edge of the vocabulary: the next mode added to
 * `EXECUTION_PLANE_MODES` before its boot branch exists must be refused by the
 * write path, not stored and silently ignored. Deleting the guard would make
 * that failure mode reappear silently.
 */
export class ExecutionPlaneModeNotOperableError extends Error {
  readonly mode: ExecutionPlaneMode;
  constructor(mode: ExecutionPlaneMode) {
    super(
      `Execution-plane mode "${mode}" is part of the persisted vocabulary but this ` +
        `instance cannot honor it; choose one of ` +
        `${OPERABLE_EXECUTION_PLANE_MODES.join(" / ")}.`,
    );
    this.name = "ExecutionPlaneModeNotOperableError";
    this.mode = mode;
  }
}

/**
 * Persist the settings. Fail-closed on a non-operable mode: the server action
 * refuses rather than storing a placement the boot phase would have to ignore.
 */
export function writeExecutionPlaneSettings(input: {
  mode: ExecutionPlaneMode;
  egressMode: ExecutionEgressMode;
  egressAllowlist: string[] | string;
}): ExecutionPlaneSettings {
  if (!isExecutionPlaneRolloutOn()) {
    throw new ExecutionPlaneRolloutDisabledError();
  }
  const mode = coerceMode(input.mode);
  if (!OPERABLE_EXECUTION_PLANE_MODES.includes(mode)) {
    throw new ExecutionPlaneModeNotOperableError(mode);
  }
  const next: ExecutionPlaneSettings = {
    mode,
    egressMode: coerceEgressMode(input.egressMode),
    egressAllowlist: normalizeEgressAllowlist(input.egressAllowlist),
  };
  writeConnectorConfigToDatabase(EXECUTION_PLANE_SETTINGS_KEY, next);
  return next;
}
