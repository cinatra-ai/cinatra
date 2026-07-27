import "server-only";

// Execution-plane instance settings (exec-plane S1b activation, cinatra#2138
// deliverable 5; epic #1705).
//
// The persisted MODE VOCABULARY is the full `remote | local-dev | disabled`
// set — S4 (cinatra-cli) consumes the same vocabulary — but in THIS slice only
// `local-dev` and `disabled` are OPERABLE. `remote` renders on the settings
// screen and is deliberately not selectable: the remote placement's service
// boundary (HTTP/mTLS to an out-of-process broker) is not wired here, and a
// selectable-but-inert mode would be a lie in the admin surface.
//
// Storage: the EXISTING platform key-value metadata store
// (`connector_config:execution_plane`, the same schema-config seam
// `audit_retention` uses). NO migration — the issue's stores already exist.

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

/** The subset this slice can actually honor. `remote` is renders-only. */
export const OPERABLE_EXECUTION_PLANE_MODES: readonly ExecutionPlaneMode[] = [
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
 * Raised when an admin attempts to persist a mode this slice cannot honor.
 * `remote` is the only such value today (S4 makes it operable).
 */
export class ExecutionPlaneModeNotOperableError extends Error {
  readonly mode: ExecutionPlaneMode;
  constructor(mode: ExecutionPlaneMode) {
    super(
      `Execution-plane mode "${mode}" is part of the persisted vocabulary but is ` +
        `not operable on this instance yet; choose one of ` +
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
